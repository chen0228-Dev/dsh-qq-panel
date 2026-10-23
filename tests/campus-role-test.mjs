/**
 * 通用人格状态机（campus.js + campus-templates.js）
 *
 * 背景：原来的状态机把「20 岁大三新闻传播学生」写死在 if 里。换成上班族、
 * 小朋友、自由职业，整套状态全错（早上七点「赶早八」、晚上「图书馆复习」）。
 * 这次泛化成「年龄 + 职业 → 日程模板」，并加了两个新能力：
 *   ① 每日活动池：按日期种子抽 1-2 个（今天打球、明天游泳）
 *   ② 临时计划：她在对话里说「我去打球了」，状态立刻跟着变
 *
 * 不可破坏的契约：busy 的 0/1/2/3 四档语义被 pacing / assoc / proxy / proactive 依赖。
 */

import fs from 'node:fs'
import path from 'node:path'
import { campusState, campusTimeline, todaysEvents, DEFAULT_CAMPUS } from '../panel/lib/campus.js'
import { JOBS, gradeForAge, templateFor } from '../panel/lib/campus-templates.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const at = (d, h, m = 0) => {
  const x = new Date(2026, 9, d)
  x.setHours(h, m, 0, 0)
  return x
}
const student = { campus: { ...DEFAULT_CAMPUS } }

/* ---------- A1 六种职业都能算出合法状态 ---------- */
for (const job of Object.keys(JOBS)) {
  const cfg = { campus: { ...DEFAULT_CAMPUS, job, age: job === 'kid' ? 8 : 30 } }
  let bad = 0
  let seen = new Set()
  for (let h = 0; h < 24; h++) {
    const s = campusState(cfg, at(22, h, 30))
    if (typeof s.busy !== 'number' || s.busy < 0 || s.busy > 3) bad++
    if (!s.label || !s.line) bad++
    seen.add(s.key)
  }
  pass(`A1 ${job}`, '全天状态合法（busy 0-3、有 label/line）', bad === 0, `bad=${bad} 状态种类=${seen.size}`)
}

/* ---------- A2 学生按年龄推年级 ---------- */
pass('A2a', '18 岁 → 大一', gradeForAge(18) === '大一', gradeForAge(18))
pass('A2b', '20 岁 → 大三', gradeForAge(20) === '大三', gradeForAge(20))
pass('A2c', '21 岁 → 大四', gradeForAge(21) === '大四', gradeForAge(21))
pass('A2d', '15 岁 → 初三', gradeForAge(15) === '初三', gradeForAge(15))
pass('A2e', '23 岁 → 研究生', gradeForAge(23) === '研究生', gradeForAge(23))

/* ---------- A3 每日活动：同一天固定，不同天不同 ---------- */
const evA = todaysEvents(student, at(22, 10))
const evA2 = todaysEvents(student, at(22, 18))
const evB = todaysEvents(student, at(25, 10))
pass('A3a', '抽到了活动', evA.length >= 1, JSON.stringify(evA.map((x) => x.label)))
pass(
  'A3b',
  '同一天两次抽到的一样（不会前后矛盾）',
  JSON.stringify(evA) === JSON.stringify(evA2)
)
// 相邻几天里至少有一天不同（不是天天一样）
const days = [20, 21, 22, 23, 24, 25].map((d) => JSON.stringify(todaysEvents(student, at(d, 10))))
pass('A3c', '不同日期活动不完全相同', new Set(days).size > 1, `${new Set(days).size} 种组合`)

/* ---------- A4 活动优先于忙碌段（那天当她请了假 / 调了课） ---------- */
{
  // 把活动池塞一个和上课完全重叠的活动，看状态机认哪个
  const cfg = {
    campus: {
      ...DEFAULT_CAMPUS,
      routine: {
        version: 1,
        source: 'test',
        slots: [],
        events: [{ from: '08:00', to: '09:40', label: '打篮球', busy: 0, line: '在打球' }],
        eventsPerDay: 1
      }
    }
  }
  const s = campusState(cfg, at(22, 8, 20))
  // 原来断言的是「忙碌段优先」。用户后来说：大学生不是每天都有课，上班族也能请假/团建，
  // 所以改成活动优先 —— 抽到活动的那天就当她调了课，不然她天天全勤，比没状态更像机器人。
  pass('A4', '活动和忙碌段重叠时，活动优先', s.key === 'event' || s.key === 'sneak', `实际 ${s.key}`)
}

/* ---------- A5 临时计划：她说了要去干嘛，状态立刻变 ---------- */
{
  const planFile = path.join(process.env.PANEL_DATA || './data', 'campus-plan.json')
  fs.mkdirSync(path.dirname(planFile), { recursive: true })
  // 19:00 本来是「晚上/宿舍躺着」，写一条 19:00-20:30 打球
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      date: '2026-10-22',
      items: [{ from: '19:00', to: '20:30', label: '打篮球', busy: 1, line: '在球场打球，出了一身汗' }]
    })
  )
  const s = campusState(student, at(22, 19, 30))
  pass('A5a', '临时计划生效', s.key === 'plan' && s.label === '打篮球', `${s.key} / ${s.label}`)
  pass('A5b', '计划带的 busy 生效', s.busy === 1, `busy=${s.busy}`)

  // 不在计划时间段内 → 正常走日程
  const s2 = campusState(student, at(22, 15, 0))
  pass('A5c', '计划之外的时间不受影响', s2.key !== 'plan', `实际 ${s2.key}`)

  // 过期（不是今天）→ 不生效
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      date: '2026-10-20',
      items: [{ from: '19:00', to: '20:30', label: '打篮球', busy: 1, line: 'x' }]
    })
  )
  const s3 = campusState(student, at(22, 19, 30))
  pass('A5d', '隔天自动失效', s3.key !== 'plan', `实际 ${s3.key}`)

  // 脏数据不能崩
  fs.writeFileSync(planFile, '{ 这不是 json')
  let threw = false
  try {
    campusState(student, at(22, 19, 30))
  } catch {
    threw = true
  }
  pass('A5e', '计划文件坏掉不抛异常', threw === false)
  fs.unlinkSync(planFile)
}

/* ---------- A6 老配置兼容（只有 classSlots，没有新字段） ---------- */
{
  const legacy = { campus: { enabled: true, age: 20, classSlots: '10:00-11:40', riseAt: '07:00', lightsOut: '23:30' } }
  const s = campusState(legacy, at(22, 10, 30))
  pass('A6a', '只写 classSlots 也能识别忙时', s.key === 'busy' || s.key === 'sneak', `实际 ${s.key}`)
  pass('A6b', '老配置的 busy 档位没变', s.busy === 2 || s.busy === 0, `busy=${s.busy}`)
}

/* ---------- A7 睡眠跨零点（上班族 00:30 睡） ---------- */
{
  const office = { campus: { ...DEFAULT_CAMPUS, job: 'office', age: 28, riseAt: '07:00', lightsOut: '00:30' } }
  const s0100 = campusState(office, at(22, 1, 0))
  pass('A7a', '01:00 算睡着（跨零点）', s0100.key === 'sleep' && s0100.busy === 3, `${s0100.key} busy=${s0100.busy}`)
  const s2330 = campusState(office, at(22, 23, 30))
  pass('A7b', '23:30 还没睡', s2330.key !== 'sleep', `实际 ${s2330.key}`)
  const sMorning = campusState(office, at(22, 8, 0))
  pass('A7c', '08:00 已醒', sMorning.busy !== 3, `${sMorning.key} busy=${sMorning.busy}`)
}

/* ---------- A8 学生 23:40 是「该睡了」而不是「睡着」 ---------- */
{
  const s = campusState(student, at(22, 23, 40))
  pass('A8', '23:40 熄灯但没睡', s.key === 'lightsout' && s.busy === 0, `${s.key} busy=${s.busy}`)
}

/* ---------- A9 时间轴 ---------- */
{
  const tl = campusTimeline(student, at(22, 0), 24, 30)
  pass('A9a', '时间轴不是空的', tl.length >= 5, `${tl.length} 个变化点`)
  pass('A9b', '时间轴按时间递增', tl.every((x, i) => i === 0 || x.at >= tl[i - 1].at))
  pass('A9c', '时间轴含睡眠和清醒两种档位', tl.some((x) => x.busy === 3) && tl.some((x) => x.busy < 3))
}

/* ---------- A10 关掉开关 ---------- */
{
  const s = campusState({ campus: { ...DEFAULT_CAMPUS, enabled: false } }, at(22, 10))
  pass('A10', '关掉后返回 off', s.key === 'off' && s.busy === 0)
}

/* ---------- A11 每套模板结构完整 ---------- */
for (const job of Object.keys(JOBS)) {
  const t = templateFor(job)
  const ok =
    Array.isArray(t.slots) &&
    t.slots.length >= 4 &&
    Array.isArray(t.events) &&
    t.events.length >= 6 &&
    t.slots.every((x) => x.from && x.to && x.label && typeof x.busy === 'number' && x.line)
  pass(`A11 ${job}`, '模板有足够的日程和活动', ok, `${t.slots?.length} 段 / ${t.events?.length} 活动`)
}


/* ---------- A12 活动里也能偷闲（再忙也会摸一下手机） ---------- */
{
  const cfg = {
    campus: {
      ...DEFAULT_CAMPUS,
      busySlots: '08:00-09:40',
      routine: {
        version: 1,
        source: 'test',
        slots: [],
        events: [{ from: '14:00', to: '16:30', label: '补作业', busy: 2, line: '在补作业，堆了好几天' }],
        eventsPerDay: 1
      }
    }
  }
  let sneak = 0
  let ev = 0
  for (let m = 14 * 60; m < 16 * 60 + 30; m++) {
    const st = campusState(cfg, at(22, Math.floor(m / 60), m % 60))
    if (st.key === 'sneak') sneak++
    if (st.key === 'event') ev++
  }
  pass('A12a', '普通忙活动里会挖偷闲窗口', sneak > 0, `sneak ${sneak} 分 / event ${ev} 分`)
  pass('A12b', '偷闲时仍能说出她在干嘛', (() => {
    for (let m = 14 * 60; m < 16 * 60 + 30; m++) {
      const st = campusState(cfg, at(22, Math.floor(m / 60), m % 60))
      if (st.key === 'sneak') return st.event === '补作业' && st.busy === 0 && /^ev-/.test(st.windowId)
    }
    return false
  })())
}

/* ---------- A13 focus 活动（开会/面试/上课）全程不看手机 ---------- */
{
  const cfg = {
    campus: {
      ...DEFAULT_CAMPUS,
      busySlots: '',
      routine: {
        version: 1,
        source: 'test',
        slots: [],
        events: [{ from: '14:00', to: '16:30', label: '开长会', busy: 2, focus: true, line: '在开会' }],
        eventsPerDay: 1
      }
    }
  }
  let sneak = 0
  for (let m = 14 * 60; m < 16 * 60 + 30; m++) {
    if (campusState(cfg, at(22, Math.floor(m / 60), m % 60)).key === 'sneak') sneak++
  }
  pass('A13', 'focus 活动没有任何偷闲窗口', sneak === 0, `sneak ${sneak} 分`)
}

/* ---------- A14 模板里该标 focus 的活动都标了 ---------- */
{
  const shouldFocus = ['兼职值班', '上兴趣班', '开长会', '被临时安排', '见客户', '补觉', '面试', '睡回笼觉']
  const jobs = ['student', 'kid', 'office', 'freelancer', 'unemployed', 'free']
  const marked = new Set()
  for (const job of jobs) {
    for (const e of templateFor(job).events || []) if (e.focus) marked.add(e.label)
  }
  const missing = shouldFocus.filter((x) => !marked.has(x))
  pass('A14', '开会/面试/睡觉类活动都标了 focus', missing.length === 0, missing.join(' / '))
}

/* ---------- A15 slots 是空数组时，自定义活动仍然生效 ---------- */
{
  const cfg = {
    campus: {
      ...DEFAULT_CAMPUS,
      job: 'freelancer',
      busySlots: '',
      routine: {
        version: 1,
        slots: [],
        events: [{ from: '14:00', to: '16:00', label: '写稿', busy: 1 }],
        eventsPerDay: 1
      }
    }
  }
  const st = campusState(cfg, at(22, 14, 30))
  // 原来「只配活动池、不要固定日程」会被整份丢弃、退回模板
  pass('A15', 'slots 空数组时自定义活动不被丢弃', st.event === '写稿', `实际 ${st.label}`)
}


/* ---------- A16 同一天抽到的活动不会时间重叠（她不可能同时在两个地方） ---------- */
{
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number)
    return h * 60 + m
  }
  const jobs = ['student', 'kid', 'office', 'freelancer', 'unemployed', 'free']
  let bad = 0
  let days = 0
  for (const job of jobs) {
    for (let d = 1; d <= 45; d++) {
      const evs = todaysEvents({ campus: { ...DEFAULT_CAMPUS, job, eventsPerDay: 2 } }, new Date(2026, 9, d, 12))
      days++
      for (let i = 0; i < evs.length; i++) {
        for (let j = i + 1; j < evs.length; j++) {
          const a1 = toMin(evs[i].from)
          const b1 = toMin(evs[i].to)
          const a2 = toMin(evs[j].from)
          const b2 = toMin(evs[j].to)
          if (a1 < b2 && b1 > a2) bad++
        }
      }
    }
  }
  // 原来纯随机抽，抽到「泡图书馆 14:00-17:00」+「陪室友逛街 15:00-17:30」，
  // 状态会从前者直接瞬移到后者（只剩半小时），线上真出现过
  pass('A16', '同一天的活动不重叠', bad === 0, `${days} 天里 ${bad} 对重叠`)
}

/* ---------- A17 busy=2 的活动和忙碌段一样能偷闲，focus 的不能 ---------- */
{
  const base = (ev) => ({
    campus: {
      ...DEFAULT_CAMPUS,
      busySlots: '',
      routine: { version: 1, slots: [], events: [ev], eventsPerDay: 1 }
    }
  })
  const countSneak = (cfg) => {
    let n = 0
    for (let m = 14 * 60; m < 16 * 60; m++) {
      if (campusState(cfg, at(22, Math.floor(m / 60), m % 60)).key === 'sneak') n++
    }
    return n
  }
  const normal = countSneak(base({ from: '14:00', to: '16:00', label: '赶稿', busy: 2 }))
  const focused = countSneak(base({ from: '14:00', to: '16:00', label: '面试', busy: 2, focus: true }))
  pass('A17', '普通忙活动有偷闲、focus 活动没有', normal > 0 && focused === 0, `普通 ${normal} 分 / focus ${focused} 分`)
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
