/**
 * 人格状态机（原「大学生状态机」，已泛化）。
 *
 * 这个模块回答两个问题：
 * 1. 她现在处于什么状态（给模型注入一句话）；
 * 2. 她有多忙（0 闲 / 1 有点忙 / 2 正忙 / 3 睡了），节奏引擎据此调延迟。
 *
 * 【为什么泛化】原来的实现把「20 岁大三新闻传播」写死在 if 里 ——
 * 换成上班族、自由职业、小朋友，整套状态全是错的（早上七点「赶早八」、
 * 晚上「图书馆复习」）。现在身份是可配的（年龄 + 职业），日程来自模板或她自己的设定。
 *
 * 【三层结构】
 *   ① 身份：age + job（学生按年龄自动推年级）
 *   ② 忙碌段：busySlots（原来的 classSlots）+ 起息时间
 *   ③ 状态机：routine（固定日程 slots + 每日活动池 events）+ 临时计划 plans
 *
 * 【不可破坏的契约】`busy` 的四个档位被 pacing.js / assoc.js / proxy.js / proactive.js
 * 共同依赖，语义**不许改**。新增职业只是把不同场景映射到这四个档，不是新增档位。
 *
 * 【为什么要有随机活动】每天一模一样 = 另一个人形机器人。
 * 用「日期种子」从活动池里抽 1-2 个（今天打球、明天游泳），
 * 同一天内反复调用结果固定，所以不会前后矛盾。
 */

import fs from 'node:fs'
import path from 'node:path'
import { templateFor } from './campus-templates.js'

export const DEFAULT_CAMPUS = {
  enabled: true,
  // ---- 第一层：身份 ----
  age: 20,
  // student / office / freelancer / unemployed / kid / free
  job: 'student',
  // 学生才用得到；留空会按年龄自动推
  grade: '',
  major: '',
  // ---- 第二层：作息 + 忙碌段 ----
  riseAt: '07:00',
  lightsOut: '23:30',
  weekendWake: '10:30',
  // 忙碌时间段，逗号分隔（原 classSlots，保留旧字段兼容）
  // 默认给一份学生课表：老部署升级后行为不变，不能变成「学生一天没课」
  busySlots: '08:00-09:40,10:00-11:40,14:00-15:40',
  // 这些段叫什么。留空按职业推（学生=上课、上班族=上班）
  busyLabel: '',
  // ---- 第三层：状态机 ----
  // 留空则用对应职业的内置模板
  routine: null,
  // 每天抽几个活动：0 = 不抽（天天一样），1-3 = 固定几个，
  // 'auto' = 让她自己定（0-3 之间按天摇，见 resolveEventsPerDay）
  eventsPerDay: 1
}

/* ---------------- 小工具 ---------------- */

function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 'HH:MM-HH:MM' → [起, 止]（分钟） */
function parseSlots(text) {
  return String(text || '')
    .split(/[,，;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/.exec(x)
      if (!m) return null
      const a = toMin(m[1])
      const b = toMin(m[2])
      if (a === null || b === null) return null
      return [a, b]
    })
    .filter(Boolean)
}

function inRange(cur, from, to) {
  const a = toMin(from)
  const b = toMin(to)
  if (a === null || b === null) return false
  // 跨零点的段（比如 23:00-01:30）
  return b >= a ? cur >= a && cur < b : cur >= a || cur < b
}

/**
 * 是否在睡眠区间里。
 *
 * 【为什么需要单独一个函数】原实现是 `cur < wake` → 睡、`cur >= lightsOut` → 已熄灯，
 * 这套只有在 「lightsOut 晚于起床时间」（如 23:30 > 07:00）时才成立。
 * 一旦有人设成 `lightsOut: '00:30'`（凌晨睡），`cur >= 30` 从 00:30 起全天成立 ——
 * 上班族和自由职业会变成「整天都在说该睡了」。这个 bug 因为默认值是 23:30 一直没暴露。
 *
 * 所以按「入睡时刻 → 起床时刻」这个区间判断，跨不跨零点都对。
 */
function inSleep(cur, sleepStart, sleepEnd) {
  if (sleepStart === null || sleepEnd === null) return false
  return sleepStart > sleepEnd
    ? cur >= sleepStart || cur < sleepEnd // 跨零点：23:30 睡，07:00 起
    : cur >= sleepStart && cur < sleepEnd // 同一天：00:30 睡，07:00 起
}

/** 当天日期做一个稳定的伪随机，用来决定「今天的剧情」 */
function daySeed(now) {
  const d = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  let h = 0
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) % 1000003
  return h
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 在一段「正忙」的时间里挖几个偷闲窗口。
 *
 * 原来只在「课」里挖，现在任何 busy>=2 的段都能挖 ——
 * 上班族开会开到一半看眼手机、自由职业赶稿赶累了刷两分钟，是同一种真实。
 *
 * 窗口必须**同一天同一段固定**（用种子推），不能每次调用都随机，
 * 否则同一个问题问两次会给出不同状态，前后自相矛盾。
 */
function sneakWindows(a, b, seedBase) {
  const dur = b - a
  if (dur < 30) return []
  const rnd = mulberry32(seedBase)
  const count = dur >= 80 ? 2 : 1
  const out = []
  for (let i = 0; i < count; i++) {
    const len = 2 + Math.floor(rnd() * 4) // 2-5 分钟
    const room = dur - len - 12
    if (room <= 5) break
    const start = a + 6 + Math.floor(rnd() * room)
    out.push({ start, end: start + len, id: `${a}-${i}` })
  }
  return out
}

/* ---------------- 临时计划（对话中说的「我去打球了」） ---------------- */

const PLAN_FILE = () => path.join(process.env.PANEL_DATA || './data', 'campus-plan.json')

let planCache = { at: 0, data: null }
let planMtime = 0

/**
 * 读「临时计划」。
 *
 * 为什么要这个：她在对话里说「我去打球了」，或者你让她去干嘛她答应了，
 * 那她的状态就该跟着变 —— 不然十分钟后她还说「在宿舍躺着」，逻辑就崩了。
 *
 * 独立文件而不是写进 config：config 是面板保存的对象，整体覆盖会把计划冲掉。
 * 按 mtime 缓存：另一个进程（qq-routine 工具）写完这边立刻能看到。
 */
export function loadPlans() {
  try {
    const f = PLAN_FILE()
    const st = fs.statSync(f)
    if (planCache.data && st.mtimeMs === planMtime) return planCache.data
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    planMtime = st.mtimeMs
    planCache = { at: Date.now(), data: d && Array.isArray(d.items) ? d : { date: d?.date, items: [] } }
    return planCache.data
  } catch {
    return { items: [] }
  }
}

/** 计划只在它标记的那一天有效，过期自动失效（免得昨天的「在打球」粘到今天） */
function activePlan(now, cur) {
  const p = loadPlans()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (p.date && p.date !== date) return null
  const hit = (p.items || []).find((it) => it && inRange(cur, it.from, it.to))
  return hit || null
}

/**
 * 往「今天的临时计划」里加一条（代码层兜底用）。
 *
 * 【为什么要代码来写，而不是让她自己调工具】
 * 人格里早就吩咐了「说了要去干嘛就 `qq-routine add` 记一笔」，
 * 但从上线到现在她一次都没调用过 —— `campus-plan.json` 从没被创建。
 * 提示管不住，就在出站这层替她记：她说「我这边慢慢磨」，状态就真的变成在忙。
 *
 * 宁可偶尔多记一条（代价是接下来一小时语气偏忙），
 * 也别让她嘴上说去写作业、状态还在闲逛 —— 那样十分钟后她就会自己岔题聊到橘猫。
 *
 * @returns {object|null} 写进去的条目；没写返回 null（不抛异常，记不上不影响发消息）
 */
export function addPlanItem(item, now = new Date()) {
  try {
    const p = item || {}
    if (!p.from || !p.to) return null
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const old = loadPlans()
    // 隔夜的不继承：昨天的「在打球」不能粘到今天
    const items = old.date && old.date !== date ? [] : old.items || []
    const entry = {
      from: String(p.from),
      to: String(p.to),
      label: String(p.label || '有点事'),
      busy: Math.max(0, Math.min(3, Number(p.busy) || 1)),
      line: String(p.line || '')
    }
    // 1) 完全相同的（同一件事同一时段）只留一条
    // 2) 时间重叠的旧条目也删掉 —— 她这会儿只可能在干一件事。
    //    先「我这边慢慢磨」（21:14-21:59）又说「我先去写作业了」（21:14-22:14），
    //    应该是后者覆盖前者（更具体、更晚说），不能两条并列让状态机随机挑到含糊的那条。
    const na = toMin(entry.from)
    const nb = toMin(entry.to)
    const next = items.filter((x) => {
      if (!x) return false
      if (x.from === entry.from && x.to === entry.to && x.label === entry.label) return false
      const a = toMin(x.from)
      const b = toMin(x.to)
      if (a === null || b === null || na === null || nb === null) return true
      return !(na < b && nb > a)
    })
    next.push(entry)
    next.sort((a, b) => (toMin(a.from) ?? 0) - (toMin(b.from) ?? 0))

    const file = PLAN_FILE()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 先写临时文件再改名：状态机按 mtime 读，这样它永远读不到半个文件
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ date, items: next }, null, 1), 'utf8')
    fs.renameSync(tmp, file)
    planCache = { at: 0, data: null }
    planMtime = 0
    return entry
  } catch {
    return null
  }
}

/* ---------------- 她自己往活动池里加的活动（自我进化） ---------------- */

const EXTRA_FILE = () => path.join(process.env.PANEL_DATA || './data', 'campus-extra.json')
/** 上限。活动池无限长会让「抽到不重复」越来越难，也让面板没法看 */
const EXTRA_MAX = 30

let extraCache = { data: null }
let extraMtime = 0

/**
 * 读「她自己加进活动池的活动」。
 *
 * 【为什么独立成文件，不直接写进 config.campus.routine.events】
 * 1. `routine` 会被「套用模板」和「让她自己重排一天」整个覆盖，她的积累会被一次抹掉；
 * 2. 换职业时 routine 会被清掉（面版那个 bug），她的东西也跟着丢。
 * 放独立文件里，她换职业、重排十次日程，想去的地方都还在 —— 这才是「她自己的偏好」。
 *
 * 按 mtime 缓存：campusState 会被调用得很频繁（面板时间轴一次就 48 次），
 * 不能每次都 stat 文件。
 */
export function loadExtraEvents() {
  try {
    const f = EXTRA_FILE()
    const st = fs.statSync(f)
    if (extraCache.data && st.mtimeMs === extraMtime) return extraCache.data
    const d = JSON.parse(fs.readFileSync(f, 'utf8'))
    extraMtime = st.mtimeMs
    extraCache = { data: Array.isArray(d?.events) ? d.events.filter((x) => x && x.label && x.from && x.to) : [] }
    return extraCache.data
  } catch {
    return []
  }
}

/**
 * 往「她自己的活动池」里加一条。
 *
 * @param {{label:string, from:string, to:string, busy?:number, line?:string, focus?:boolean}} ev
 * @returns {object|null} 写进去的条目
 */
export function addExtraEvent(ev) {
  try {
    const e = ev || {}
    const label = String(e.label || '').trim()
    if (!label) return null
    if (toMin(e.from) === null || toMin(e.to) === null) return null
    const from = String(e.from)
    const to = String(e.to)
    if (toMin(to) <= toMin(from)) return null

    const items = loadExtraEvents().slice()
    const entry = {
      label,
      from,
      to,
      busy: Math.max(0, Math.min(3, Number(e.busy) || 1)),
      line: String(e.line || `在${label}，这事是你自己找的，做得挺投入`),
      focus: e.focus === true,
      addedAt: Date.now()
    }
    // 同名活动直接更新（她可能重复说「我想去游泳」），不堆两条
    const idx = items.findIndex((x) => x.label === entry.label)
    if (idx >= 0) items.splice(idx, 1)
    items.push(entry)
    // 超上限淘汰最旧的
    while (items.length > EXTRA_MAX) {
      items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
      items.shift()
    }

    const f = EXTRA_FILE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ events: items }, null, 1), 'utf8')
    fs.renameSync(tmp, f)
    extraCache = { data: null }
    extraMtime = 0
    return entry
  } catch {
    return null
  }
}

/** 删掉一条她加的活动（按 label） */
export function removeExtraEvent(label) {
  try {
    const want = String(label || '').trim()
    if (!want) return false
    const items = loadExtraEvents().filter((x) => x.label !== want)
    const f = EXTRA_FILE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ events: items }, null, 1), 'utf8')
    fs.renameSync(tmp, f)
    extraCache = { data: null }
    extraMtime = 0
    return true
  } catch {
    return false
  }
}

/** 清空她自己加的活动（面板上的「清空」按钮） */
export function clearExtraEvents() {
  return removeAllExtra()
}

function removeAllExtra() {
  try {
    const f = EXTRA_FILE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ events: [] }, null, 1), 'utf8')
    fs.renameSync(tmp, f)
    extraCache = { data: null }
    extraMtime = 0
    return true
  } catch {
    return false
  }
}

/**
 * 给「她想做的一件事」挑一个不和现有活动撞的时间段。
 *
 * 为什么不能随便给个时间：同一天的活动不能重叠（她不可能同时在两个地方）。
 * 新手活动全塞到 19:00-20:30 的话，抽签时只能选一个，等于白加。
 *
 * 【为什么不写死一张候选表】原来只有 7 个固定槽，模板活动一密集就全被占满，
 * 第 4 条之后只能退回第一个槽 —— 于是她自己加的活动互相重叠，等于白加。
 * 现在按 30 分钟粒度扫全天，能挑多少挑多少；真找不到就返回 null，让调用方别加。
 *
 * @returns {{from:string,to:string}|null}
 */
export function pickFreeSlot(baseEvents = [], extraEvents = [], prefer = '') {
  const used = [...(baseEvents || []), ...(extraEvents || [])]
    .map((x) => [toMin(x.from), toMin(x.to)])
    .filter(([a, b]) => a !== null && b !== null)
  const free = (a, b) => !used.some(([x, y]) => a < y && b > x)

  const LEN_LIST = [90, 60, 45, 30] // 先试长的，塞不下就压短
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

  // 她说「早上/下午/晚上」就先把那个区间排前面
  const anchor = /早|上午/.test(prefer) ? 9 * 60 : /下午/.test(prefer) ? 14 * 60 : 19 * 60
  const starts = []
  for (let m = anchor; m <= 21 * 60; m += 30) starts.push(m)
  for (let m = anchor - 30; m >= 8 * 60; m -= 30) starts.push(m)
  // 再兜一遍全天的（避开刚扫过的重复）
  for (let m = 8 * 60; m <= 21 * 60; m += 30) starts.push(m)

  const seen = new Set()
  const uniq = starts.filter((m) => (seen.has(m) ? false : seen.add(m)))
  // 先按「足够长的空档」找，找不到再压短 ——
  // 模板活动很密的时候（学生下午晚上全占满），只认 90 分钟会一条都加不进去
  for (const LEN of LEN_LIST) {
    for (const s of uniq) {
      if (s + LEN > 23 * 60) continue
      if (free(s, s + LEN)) return { from: fmt(s), to: fmt(s + LEN) }
    }
  }
  return null
}

/** pickFreeSlot 的 campus 版本：自动带上模板活动和她已加的活动 */
export function pickSlotForCampus(cfg, prefer = '') {
  const c = { ...DEFAULT_CAMPUS, ...((cfg && cfg.campus) || {}) }
  const routine = normalizeRoutine(c)
  // normalizeRoutine 已经把 extra 并进 events 了，所以第二参传空
  return pickFreeSlot(routine.events || [], [], prefer)
}

/* ---------------- 今日活动 ---------------- */

/**
 * 从活动池里按日期种子抽 1-2 个。
 * 同一天无论调用多少次，抽到的都是同一批 —— 这是「每天不一样但不自相矛盾」的关键。
 *
 * **抽的时候要排除时间重叠的**：她不可能同时在图书馆又在逛街。
 * 原来纯随机抽，抽到「泡图书馆 14:00-17:00」+「陪室友逛街 15:00-17:30」，
 * 状态机会在前一个结束后突然跳到后一个（只剩半小时），像被瞬移。
 * 现在就当「时间撞了的那条今天没去」，宁可少一个活动也不能自相矛盾。
 */
/**
 * 把 `eventsPerDay` 规范化成「'auto' 或 0-3 的整数」。
 *
 * 这个字段有三处入口会写它（面板保存、套用模板、她自己重排一天），
 * 三处都必须走这个函数 —— 否则 `Number('auto')` = NaN 会一路传下去，
 * 最后变成「一个活动都抽不出来」，而且从面板上完全看不出原因。
 */
export function normalizeEventsPerDay(v) {
  if (v === 'auto' || v === 'random') return 'auto'
  // 空串 / null / undefined 一律当「没填」，用默认 1。
  // 别落到 `Number('') = 0` 上 —— 那等于把她的活动悄悄全关掉，还查不出原因。
  if (v === null || v === undefined || String(v).trim() === '') return 1
  const n = Number(v)
  return Math.max(0, Math.min(3, Number.isFinite(n) ? n : 1))
}

/**
 * 今天抽几个活动。
 *
 * `eventsPerDay` 可以是 0/1/2/3（用户定死），也可以是 `'auto'` ——
 * 后者是「让她自己定」：按当天的种子在 0-3 之间摇一个。
 *
 * 【为什么用独立随机流】
 * `todayEvents()` 里洗牌用的是 `mulberry32(seed)`。如果这里先借同一个 rnd 摇一下，
 * 洗牌序列会整体错位 —— 等于把「固定 1-3 个」的既有行为也一起改了。
 * 所以拿 seed 异或一个常数单独开一条流，两条互不干扰。
 *
 * 【为什么权重不是均匀的四分之一】
 * 均匀的话有四分之一的日子一个活动都没有，看起来像坏了。
 * 真人也不是天天有事：多数日子一两件，偶尔闲一天，偶尔赶三件。
 * 现在是 0:15% / 1:40% / 2:33% / 3:12%，期望约 1.42 —— 跟原来默认 1 个的体感接近。
 *
 * 【必须同一天返回同一个数】
 * 状态机每 30 秒重算一次，摇出来的数一变她的状态就跳。
 * 用 `daySeed` 派生天然满足这一点（同一天同一个 seed）。
 */
export function resolveEventsPerDay(routine, seed) {
  const raw = normalizeEventsPerDay(routine?.eventsPerDay)
  if (raw === 'auto') {
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0)
    const roll = rnd()
    if (roll < 0.15) return 0
    if (roll < 0.55) return 1
    if (roll < 0.88) return 2
    return 3
  }
  return raw
}

function todayEvents(routine, seed) {
  const n = resolveEventsPerDay(routine, seed)
  const pool = Array.isArray(routine.events) ? routine.events : []
  if (!n || !pool.length) return []
  const rnd = mulberry32(seed)
  // 先洗牌，再按顺序挑不重叠的 —— 否则每次都从池子头部开始挑，永远只演前几条
  const shuffled = pool.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = t
  }
  const picked = []
  for (const ev of shuffled) {
    if (picked.length >= n) break
    const a = toMin(ev.from)
    const b = toMin(ev.to)
    if (a === null || b === null) continue
    const clash = picked.some((p) => {
      const pa = toMin(p.from)
      const pb = toMin(p.to)
      return pa !== null && pb !== null && a < pb && b > pa
    })
    if (!clash) picked.push(ev)
  }
  return picked
}

/* ---------------- 组装 routine（含旧配置兼容） ---------------- */

function normalizeRoutine(c) {
  // 「配过日程」的判据：slots 或 events **有一个是数组**就算了，哪怕是空数组。
  //
  // 原来要求 `slots.length` 非空，于是「只配活动池、不要固定日程」的配置会被
  // 整份丢弃、静默退回模板 —— 她照着自己的安排过了一天，状态机却还在念模板日程。
  // 空数组是「我明确不要固定日程」，不是「我没配」，这两件事得分开。
  const r = c.routine
  const hasRoutine = r && typeof r === 'object' && (Array.isArray(r.slots) || Array.isArray(r.events))
  let base
  if (hasRoutine) {
    base = {
      // 没写 source 的就是「自己改过的」，别让面板把它显示成模板名
      source: r.source || 'custom',
      ...r,
      slots: Array.isArray(r.slots) ? r.slots : [],
      events: Array.isArray(r.events) ? r.events : [],
      eventsPerDay: normalizeEventsPerDay(r.eventsPerDay ?? c.eventsPerDay ?? 1)
    }
  } else {
    // 没配 routine → 用职业模板（老部署升级后行为不变）
    const t = templateFor(c.job || 'student')
    base = {
      version: 1,
      source: `template:${c.job || 'student'}`,
      slots: t.slots || [],
      events: t.events || [],
      eventsPerDay: normalizeEventsPerDay(c.eventsPerDay ?? 1)
    }
  }

  // 把她自己加的活动并进来。
  // 同名的不重复（模板里已有「打篮球」，她再说「想去打篮球」就不加第二条），
  // 但她加的那条有自己写的 line，用她的说法更真实 —— 所以同名时以她的为准。
  const extra = loadExtraEvents()
  if (extra.length) {
    const byLabel = new Map()
    for (const e of base.events || []) byLabel.set(e.label, e)
    for (const e of extra) byLabel.set(e.label, { ...byLabel.get(e.label), ...e })
    base = { ...base, events: [...byLabel.values()], extraCount: extra.length }
  } else if (base.extraCount === undefined) {
    base = { ...base, extraCount: 0 }
  }
  return base
}

/** 忙碌段叫什么。学生=上课、上班族=上班、其它按职业给个说法 */
function busyLabelFor(c, job) {
  if (c.busyLabel) return c.busyLabel
  if (job === 'student' || job === 'kid') return '上课'
  if (job === 'office') return '上班'
  if (job === 'freelancer') return '干活'
  if (job === 'unemployed') return '有事在忙'
  return '忙一件事'
}

/** 「正忙」时那句有画面的话。不同职业画面完全不同，不能共用一句 */
function busyLineFor(c, job, examWeek) {
  const label = busyLabelFor(c, job)
  if (job === 'student' || job === 'kid') {
    return examWeek
      ? `你在${label}，老师还在划考试重点，你只敢低头瞄一眼手机`
      : `你在${label}，坐在后面偷偷看手机，屏幕藏在桌子底下`
  }
  if (job === 'office') return '你在上班，电脑上开着一堆窗口，手机放在键盘旁边'
  if (job === 'freelancer') return '你在干活，交期摆在那儿，注意力很难抽出来'
  if (job === 'unemployed') return '你在忙一件事，不太方便一直看手机'
  return `你在${label}，手上占着，只能偶尔瞄一眼`
}

/**
 * 把模板里的中文 label 映射成稳定的英文 key。
 *
 * 为什么要这一步：状态机的返回值里 `key` 是给代码看的（测试断言、面板分支），
 * 直接拿中文 label 当 key 会逼着调用方去匹配中文字符串，改文案就全崩。
 * 模板不用手写 key —— 加一层映射，文案随便改。
 */
const LABEL_KEYS = {
  刚起: 'wake',
  起床: 'wake',
  周末刚起: 'wake',
  路上: 'commute',
  上学路上: 'commute',
  通勤: 'commute',
  下班路上: 'commute',
  午饭: 'lunch',
  中午: 'lunch',
  午休: 'nap',
  晚饭: 'dinner',
  晚上: 'evening',
  宿舍躺着: 'dorm',
  躺着: 'rest',
  深夜: 'night',
  夜里: 'night',
  写作业: 'homework',
  准备睡觉: 'bedtime',
  该睡了: 'bed'
}

function labelToKey(label) {
  const l = String(label || '').trim()
  if (LABEL_KEYS[l]) return LABEL_KEYS[l]
  // 「周末中午」这种带前缀的，去掉前两个字再试一次
  const trimmed = l.replace(/^(周末|平时)/, '')
  return LABEL_KEYS[trimmed] || 'slot'
}

/* ---------------- 主函数 ---------------- */

/**
 * 算出当前状态。
 * 返回 { key, label, line, busy, sneak?, windowId?, minutesLeft?, job?, age?, event? }
 * busy：0 闲 / 1 有点忙 / 2 正忙 / 3 睡了
 */
export function campusState(cfg, now = new Date()) {
  const c = { ...DEFAULT_CAMPUS, ...((cfg && cfg.campus) || {}) }
  const hour = now.getHours() + now.getMinutes() / 60
  const cur = hour * 60
  const dow = now.getDay()
  const weekend = dow === 0 || dow === 6

  if (c.enabled === false) return { key: 'off', label: '未启用', line: '', busy: 0 }

  const job = c.job || 'student'
  const age = Number(c.age) || 20
  const routine = normalizeRoutine(c)
  const seed = daySeed(now)
  const rise = toMin(c.riseAt) ?? 7 * 60
  const lightsOut = toMin(c.lightsOut) ?? 23 * 60 + 30
  const weekendWakeMin = toMin(c.weekendWake) ?? 10 * 60 + 30
  const wake = weekend ? weekendWakeMin : rise
  // 一天级的「剧情」：赶工日 / 考试周。固定下来别每条消息都变
  const crunchDay = seed % 100 < 22
  const examWeek = seed % 100 >= 92
  // extraCount：她自己往活动池里加了几条（面板上显示「她攒了多少」）
  const base = { job, age, extraCount: routine.extraCount || 0 }

  // ---- 1. 熄灯了但还醒着（只在「入睡时刻晚于起床时刻」时存在这一段）----
  // 必须放在「睡着」之前：学生 23:30 熄灯，23:30~24:00 是「躲被子里看手机」，
  // 真睡着要过了零点才算。顺序反了会把她 23:35 就说成「已经睡了」。
  if (lightsOut > rise && cur >= lightsOut) {
    return {
      ...base,
      key: 'lightsout',
      label: '该睡了',
      busy: 0,
      line: job === 'kid'
        ? '已经很晚了，被催着睡觉，声音压得很低'
        : '灯关了，你躲在被子里看手机，屏幕调得很暗，打字慢、句子短'
    }
  }

  // ---- 2. 睡着（优先级次高，但高于一切日程）----
  // 用「入睡→起床」区间判断，跨零点也对（上班族 00:30 睡、早 7 点起）
  if (inSleep(cur, lightsOut, wake)) {
    const late = cur < 6 * 60
    return {
      ...base,
      key: 'sleep',
      label: '睡着',
      busy: 3,
      line: late
        ? '这个点你已经睡了。真被吵醒只会很不耐烦地回一两个字，然后接着睡'
        : '你还没起，被吵醒也迷迷糊糊的，回话很短'
    }
  }

  // ---- 3. 临时计划（她说「我去打球了」→ 立刻生效） ----
  const plan = activePlan(now, cur)
  if (plan) {
    return {
      ...base,
      key: 'plan',
      label: plan.label || '在做一件事',
      busy: Number(plan.busy) || 1,
      plan: true,
      line: plan.line || `你现在在${plan.label || '做一件事'}`
    }
  }

  // ---- 4. 今天的活动（每天抽，今天打球明天游泳） ----
  //
  // 【为什么排在「忙碌段」之前】现实里人不是被日程钉死的：
  // 大学生会翘课去打球，上班族会请假去团建、被派去出差。
  // 让课表永远压过活动，反而是「假的规律」—— 她每天都在上课，一天不落，
  // 比没有状态更像机器人。所以活动优先：抽到活动的那天，就当她调了课 / 请了假。
  //
  // 活动池是按日期抽 1-2 个，不是天天都撞课表；撞上只是「今天有别的安排」。
  const todays = todayEvents(routine, seed)
  const ev = todays.find((e) => inRange(cur, e.from, e.to))
  if (ev) {
    const evBusy = Number(ev.busy) || 0
    // 活动里也能偷闲 —— 再忙的人也会摸一下手机。
    // 例外是 `focus: true` 的活动（开会、面试、上课、睡觉），那种场合真看不了。
    if (evBusy >= 2 && !ev.focus) {
      const evFrom = toMin(ev.from)
      const evTo = toMin(ev.to)
      const win =
        evFrom === null || evTo === null
          ? null
          : sneakWindows(evFrom, evTo, seed + evFrom).find((w) => cur >= w.start && cur < w.end)
      if (win) {
        const baseLine = String(ev.line || `在${ev.label || '忙别的事'}`).replace(/[。！？]$/, '')
        return {
          ...base,
          key: 'sneak',
          label: '偷偷看手机',
          busy: 0,
          sneak: true,
          event: ev.label, // 面板/人格提示要知道她「在哪儿偷偷看」
          // 前缀 ev- 是为了和忙碌段的窗口 id 区分开，proactive 靠它判「这个窗口说过没有」
          windowId: `ev-${ev.from}-${String(win.id).split('-').pop()}`,
          minutesLeft: Math.max(1, Math.round(win.end - cur)),
          line: `${baseLine}，趁着这会儿没人管，低头看了两眼手机`
        }
      }
    }
    return {
      ...base,
      key: 'event',
      label: ev.label || '在外面',
      busy: evBusy,
      event: ev.label,
      focus: ev.focus === true,
      line: ev.line || `你现在在${ev.label || '做一件事'}`
    }
  }

  // ---- 5. 忙碌段（原「课表」，泛化为任何职业的固定忙时） ----
  //
  // 排在活动之后：抽到活动的那天活动优先（请假/调课），没活动的日子按课表走。
  // 忙碌段取值：**旧字段 classSlots 优先**，其次新字段 busySlots，最后默认。
  //
  // 这里看着反直觉（新字段反而不优先），但有不得不这样的理由：
  // cfg.campus 通常已经和 DEFAULT_CAMPUS 合并过，`busySlots` 一定带着默认值，
  // 只写了 `classSlots` 的老配置会被默认值整个盖掉 —— 老部署的课表会静默失效。
  // 新面板保存时两个字段写的是同一个值，所以谁优先都等价，优先旧的才不伤兼容。
  const rawCampus = (cfg && cfg.campus) || {}
  const busyText = rawCampus.classSlots || rawCampus.busySlots || c.classSlots || c.busySlots
  const busySlots = weekend ? [] : parseSlots(busyText)

  // 忙之前的赶路：第一段忙时开始前 40 分钟内
  if (busySlots.length) {
    const firstStart = Math.min(...busySlots.map(([a]) => a))
    if (cur >= firstStart - 40 && cur < firstStart) {
      return {
        ...base,
        key: 'rush',
        label: '赶时间',
        busy: 1,
        line: `马上要${busyLabelFor(c, job)}了，你一边收拾一边往那边赶，手忙脚乱`
      }
    }
  }

  for (const [a, b] of busySlots) {
    if (cur >= a && cur < b) {
      // 快结束了，人已经在收东西
      if (b - cur <= 10) {
        return {
          ...base,
          key: 'break',
          label: '快结束了',
          busy: 0,
          line: `${busyLabelFor(c, job)}快结束了，周围有人开始动，你也坐不住了`
        }
      }
      const win = sneakWindows(a, b, seed + a).find((w) => cur >= w.start && cur < w.end)
      if (win) {
        return {
          ...base,
          key: 'sneak',
          label: '偷偷看手机',
          busy: 0,
          sneak: true,
          // 「本来在干嘛」：主动消息的偷闲提示词要用它，别再写死「上课」
          busyLabel: busyLabelFor(c, job),
          windowId: win.id,
          minutesLeft: Math.max(1, Math.round(win.end - cur)),
          line:
            job === 'student' || job === 'kid'
              ? '正放着视频，老师在讲别的。你低头偷偷看手机，也就几分钟空当'
              : '手头这事暂时不需要你，你摸出手机看两眼，也就几分钟'
        }
      }
      return {
        ...base,
        key: 'busy',
        label: busyLabelFor(c, job),
        busy: 2,
        line: busyLineFor(c, job, examWeek)
      }
    }
    // 刚结束的十分钟
    if (cur >= b && cur < b + 10) {
      return {
        ...base,
        key: 'after-busy',
        label: '刚结束',
        busy: 0,
        line: `${busyLabelFor(c, job)}刚结束，你从里面出来，人挤人`
      }
    }
  }

  // ---- 6. 固定日程（模板给的段落） ----
  const slots = weekend ? routine.weekendSlots || routine.slots : routine.slots
  const hit = (slots || []).find((s) => inRange(cur, s.from, s.to))
  if (hit) {
    return {
      ...base,
      // 模板给了 key 就用；没给按 label 反查（文案改了也不会把 key 搞乱）
      key: hit.key || labelToKey(hit.label),
      label: hit.label || '日常',
      busy: Number(hit.busy) || 0,
      line: hit.line || `你现在在${hit.label || '做自己的事'}`
    }
  }

  // ---- 7. 赶工日（只在没别的安排时才生效） ----
  if (crunchDay && cur >= 15 * 60 && cur < 22 * 60) {
    return {
      ...base,
      key: 'crunch',
      label: '赶东西',
      busy: 1,
      line:
        job === 'student'
          ? '你手上有篇东西今天要交，正对着电脑改，脑子有点木'
          : '今天有件事必须弄完，你正对着屏幕，脑子有点木'
    }
  }

  // ---- 8. 兜底：闲 ----
  const idleLine =
    job === 'kid'
      ? '没什么事，正自己玩'
      : job === 'unemployed'
        ? '没什么事做，时间有点空'
        : '没什么安排，比较闲'
  return { ...base, key: 'idle', label: '闲着', busy: 0, line: idleLine }
}

/** 给人看的一句话，面板上用 */
export function campusLabel(cfg, now = new Date()) {
  const s = campusState(cfg, now)
  if (s.key === 'off') return '（未启用）'
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `${d} ${WEEK[now.getDay()]} ${s.label}`
}

/**
 * 面板用：把一整天（或接下来若干小时）的状态走一遍，给出时间轴。
 *
 * 为什么要这个：光显示「此刻：上课中」看不出她一天怎么过。
 * 让面板能直接看出「今天 16:00 有场球」，才判断得出配置对不对。
 */
export function campusTimeline(cfg, now = new Date(), hours = 18, stepMin = 30) {
  const out = []
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const endMin = Math.min(24 * 60, hours * 60 + stepMin)
  let last = null
  for (let m = 0; m < endMin; m += stepMin) {
    const t = new Date(start.getTime() + m * 60_000)
    const s = campusState(cfg, t)
    const hh = String(Math.floor(m / 60)).padStart(2, '0')
    const mm = String(m % 60).padStart(2, '0')
    if (!last || last.label !== s.label || last.busy !== s.busy || (last.event || '') !== (s.event || '')) {
      // event 一起带上：活动里的偷闲光看「偷偷看手机」不知道她在哪儿
      out.push({ at: `${hh}:${mm}`, label: s.label, busy: s.busy, key: s.key, event: s.event || '' })
      last = s
    }
  }
  return out
}

/** 面板用：今天抽到了哪些活动（让人知道「随机」到底抽了什么） */
export function todaysEvents(cfg, now = new Date()) {
  const c = { ...DEFAULT_CAMPUS, ...((cfg && cfg.campus) || {}) }
  if (c.enabled === false) return []
  const routine = normalizeRoutine(c)
  return todayEvents(routine, daySeed(now)).map((e) => ({
    label: e.label,
    from: e.from,
    to: e.to,
    busy: e.busy,
    // 开会/面试/上课/睡觉这类不能分心，面板上标出来，方便判断这条活动会不会给偷闲窗口
    focus: e.focus === true
  }))
}
