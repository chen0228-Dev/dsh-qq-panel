/**
 * 「她自己往活动池里加东西」+「切职业活动池要跟着变」的测试。
 *
 * 两个 bug 背景：
 * 1. 面板切职业后活动池没变 —— 保存时把旧职业的模板 routine 原样写回去了；
 * 2. 活动池只有模板那十来条，她的日子翻来覆去就那几件，没有「自己在变」的感觉。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  campusState,
  todaysEvents,
  addExtraEvent,
  loadExtraEvents,
  removeExtraEvent,
  clearExtraEvents,
  pickFreeSlot,
  pickSlotForCampus,
  DEFAULT_CAMPUS
} from '../panel/lib/campus.js'
import { detectWish, detectGoAway } from '../panel/lib/goaway.js'

let fail = 0
let n = 0
const pass = (id, name, ok, extra = '') => {
  n++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${name}${extra ? ' | ' + extra : ''}`)
  if (!ok) fail++
}

const DATA = process.env.PANEL_DATA || './data'
fs.mkdirSync(DATA, { recursive: true })
const EXTRA = path.join(DATA, 'campus-extra.json')
const reset = () => {
  try {
    fs.unlinkSync(EXTRA)
  } catch {
    /* 本来就没有 */
  }
  clearExtraEvents()
}

const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number)
  return h * 60 + m
}
const overlap = (a, b) => toMin(a.from) < toMin(b.to) && toMin(a.to) > toMin(b.from)

/* ================= 一、切职业：活动池要跟着变 ================= */
{
  // 复刻面板保存时的判断（index.html 里那段）
  const decide = (prevCampus, newJob) => {
    const prevRoutine = prevCampus?.routine ?? null
    const prevJob = prevCampus?.job || 'student'
    const prevFromTemplate =
      typeof prevRoutine?.source === 'string' && prevRoutine.source.startsWith('template:')
    return newJob !== prevJob && prevFromTemplate ? null : prevRoutine
  }

  const studentRoutine = { version: 1, source: 'template:student', slots: [], events: [{ label: '打篮球' }] }
  pass(
    'C1a',
    '学生改上班族：旧模板被清掉（活动池跟着换）',
    decide({ job: 'student', routine: studentRoutine }, 'office') === null
  )
  pass(
    'C1b',
    '职业没变：routine 保留（保存别的字段不会丢）',
    decide({ job: 'student', routine: studentRoutine }, 'student') === studentRoutine
  )
  const custom = { source: 'custom', slots: [], events: [{ label: '我自己排的' }] }
  pass(
    'C1c',
    '她自己排过的日程，换职业也保留',
    decide({ job: 'student', routine: custom }, 'office') === custom
  )

  // 真跑一遍状态机：切到 office 后不该再出现学生活动
  const cfg = { campus: { ...DEFAULT_CAMPUS, job: 'office', routine: null } }
  const labels = new Set()
  for (let d = 1; d <= 20; d++) {
    for (let h = 8; h < 23; h++) {
      const s = campusState(cfg, new Date(2026, 9, d, h, 0, 0))
      if (s.event) labels.add(s.event)
    }
  }
  const studentOnly = ['打篮球', '泡图书馆', '陪室友逛街', '社团开会']
  const leaked = studentOnly.filter((x) => labels.has(x))
  pass('C1d', '上班族的活动池里没有学生的活动', leaked.length === 0, leaked.join('/') || `抽到 ${[...labels].join('、')}`)
}

/* ================= 二、她自己加的活动能进池子 ================= */
{
  reset()
  const saved = addExtraEvent({ label: '学吉他', from: '19:30', to: '21:00', busy: 1, line: '在练和弦' })
  pass('E1a', '加法返回写入的条目', saved && saved.label === '学吉他', saved ? saved.label : 'null')
  pass('E1b', '文件真的落盘了', fs.existsSync(EXTRA))
  pass('E1c', '读回来一致', loadExtraEvents().length === 1 && loadExtraEvents()[0].label === '学吉他')

  // 状态机能抽到她加的活动（扫 60 天，19:30 这个点）
  const cfg = { campus: { ...DEFAULT_CAMPUS, job: 'student' } }
  let hit = 0
  for (let d = 1; d <= 60; d++) {
    const s = campusState(cfg, new Date(2026, 9, d, 20, 0, 0))
    if (s.event === '学吉他') hit++
  }
  pass('E1d', '她自己加的活动真的会被抽到', hit > 0, `60 天里抽到 ${hit} 天`)
}

/* ---------- E2 同名覆盖，不堆两条 ---------- */
{
  reset()
  addExtraEvent({ label: '学吉他', from: '19:30', to: '21:00', busy: 1, line: '旧说法' })
  addExtraEvent({ label: '学吉他', from: '20:00', to: '21:30', busy: 1, line: '新说法' })
  const all = loadExtraEvents()
  pass('E2a', '同名只留一条', all.length === 1, `${all.length} 条`)
  pass('E2b', '用的是新时间和新说法', all[0].from === '20:00' && all[0].line === '新说法', `${all[0].from} ${all[0].line}`)
}

/* ---------- E3 上限 + 非法输入 ---------- */
{
  reset()
  for (let i = 1; i <= 35; i++) addExtraEvent({ label: `活动${i}`, from: '10:00', to: '11:00', busy: 1 })
  pass('E3a', '超过 30 条会淘汰最旧的', loadExtraEvents().length === 30, `${loadExtraEvents().length} 条`)
  const gone = !loadExtraEvents().some((x) => x.label === '活动1')
  pass('E3b', '被淘汰的是最早加的', gone)

  pass('E3c', '没有 label 拒绝写入', addExtraEvent({ from: '10:00', to: '11:00' }) === null)
  pass('E3d', '时间格式不对拒绝写入', addExtraEvent({ label: 'x', from: 'aa', to: '11:00' }) === null)
  pass('E3e', '结束早于开始拒绝写入', addExtraEvent({ label: 'x', from: '12:00', to: '11:00' }) === null)
  pass('E3f', 'busy 越界会被夹到 0-3', (() => {
    reset()
    const s = addExtraEvent({ label: '测试', from: '10:00', to: '11:00', busy: 9 })
    return s && s.busy === 3
  })())
}

/* ---------- E4 删除 / 清空 ---------- */
{
  reset()
  addExtraEvent({ label: '学吉他', from: '19:30', to: '21:00' })
  addExtraEvent({ label: '去爬山', from: '15:00', to: '16:30' })
  removeExtraEvent('学吉他')
  pass('E4a', '删掉指定的那条', loadExtraEvents().length === 1 && loadExtraEvents()[0].label === '去爬山')
  clearExtraEvents()
  pass('E4b', '清空', loadExtraEvents().length === 0)
}

/* ================= 三、和已有机制的冲突检查 ================= */

/* ---------- K1 她加的活动不会跟自己/模板撞时间 ---------- */
{
  reset()
  const cfg = { campus: { ...DEFAULT_CAMPUS, job: 'student' } }
  // 连续加 6 条，自动排时，看会不会互相重叠
  const added = []
  for (let i = 0; i < 6; i++) {
    const slot = pickSlotForCampus(cfg, '')
    // 挤不下时返回 null 是正确行为（一天塞不了无限多活动）
    if (!slot) continue
    added.push({ label: `新事${i}`, ...slot })
    addExtraEvent({ label: `新事${i}`, from: slot.from, to: slot.to, busy: 1 })
  }
  let clash = 0
  for (let i = 0; i < added.length; i++) {
    for (let j = i + 1; j < added.length; j++) if (overlap(added[i], added[j])) clash++
  }
  pass('K1a', '连加 6 条（能塞几条算几条），自己之间不重叠', clash === 0, `成功加 ${added.length} 条，${clash} 对重叠`)

  // 一天可以有两个活动（时间不同），但它们的时间段不能重叠
  let dayClash = 0
  for (let d = 1; d <= 40; d++) {
    const evs = todaysEvents(cfg, new Date(2026, 9, d, 12))
    for (let i = 0; i < evs.length; i++) {
      for (let j = i + 1; j < evs.length; j++) {
        if (overlap(evs[i], evs[j])) dayClash++
      }
    }
  }
  pass('K1b', '当天抽到的活动之间不重叠（含她自己加的）', dayClash === 0, `${dayClash} 对重叠`)
}

/* ---------- K2 她加的活动带 focus 时也不挖偷闲 ---------- */
{
  reset()
  addExtraEvent({ label: '上陶艺课', from: '14:00', to: '16:00', busy: 2, focus: true })
  // eventsPerDay 必须是 1：0 的意思是「今天不抽活动」，那样她自己加的活动也不会出现
  const cfg = { campus: { ...DEFAULT_CAMPUS, job: 'freelancer', busySlots: '', routine: { slots: [], events: [], eventsPerDay: 1 } } }
  let sneak = 0
  let ev = 0
  for (let d = 1; d <= 90; d++) {
    for (let m = 14 * 60; m < 16 * 60; m++) {
      const s = campusState(cfg, new Date(2026, 9, d, Math.floor(m / 60), m % 60))
      if (s.event === '上陶艺课') ev++
      if (s.event === '上陶艺课' && s.key === 'sneak') sneak++
    }
  }
  pass('K2a', '自己加的 focus 活动会被抽到', ev > 0, `${ev} 分钟`)
  pass('K2b', 'focus 活动全程不挖偷闲窗口', sneak === 0, `${sneak} 分钟`)
}

/* ---------- K3 eventsPerDay=0 时，她自己加的活动也不出现 ---------- */
{
  reset()
  addExtraEvent({ label: '学吉他', from: '19:30', to: '21:00', busy: 1 })
  const cfg = { campus: { ...DEFAULT_CAMPUS, job: 'student', eventsPerDay: 0 } }
  let hit = 0
  for (let d = 1; d <= 20; d++) {
    if (campusState(cfg, new Date(2026, 9, d, 20, 0, 0)).event === '学吉他') hit++
  }
  pass('K3', '关掉活动（eventsPerDay=0）时它们也不出现', hit === 0, `${hit} 天`)
}

/* ---------- K4 切职业后，她自己加的还在（独立文件的好处） ---------- */
{
  reset()
  addExtraEvent({ label: '学吉他', from: '19:30', to: '21:00', busy: 1 })
  const asOffice = { campus: { ...DEFAULT_CAMPUS, job: 'office', routine: null } }
  const st = campusState(asOffice, new Date(2026, 9, 22, 20, 0, 0))
  const stillThere = loadExtraEvents().some((x) => x.label === '学吉他')
  pass('K4a', '换职业后她加的活动还在（配置里 routine 被清也不影响）', stillThere)
  pass('K4b', '换职业后仍可能抽到她加的活动', st.extraCount === 1, `extraCount=${st.extraCount}`)
}

/* ================= 四、认出「她想做某件事」 ================= */
{
  const yes = [
    ['我最近想学吉他', '学吉他'],
    ['我想去爬山', '去爬山'],
    ['改天想去海边', '去海边'],
    ['我打算试试陶艺', '试试陶艺']
  ]
  let ok = 0
  for (const [t, want] of yes) {
    const w = detectWish(t)
    if (w && w.label === want) ok++
    else console.log(`   ✗ ${t} → ${w ? w.label : 'null'}`)
  }
  pass('W1', '想学/想去/改天去 都能认出来', ok === yes.length, `${ok}/${yes.length}`)

  const no = [
    '我想你了',
    '我想洗澡了',
    '我去洗澡了',
    '我想知道他在干嘛',
    '你今天想吃什么',
    '[[引用 1]]我想去打球'
  ]
  const bad = no.filter((t) => detectWish(t))
  pass('W2', '日常琐事/无关/引用都不误加', bad.length === 0, bad.join(' / '))
}

/* ---------- W3 同一句里「现在去」和「以后想」能同时命中 ---------- */
{
  const t = '我去健身房了 最近想练练'
  const go = detectGoAway(t, new Date(2026, 9, 22, 19, 0, 0))
  const wish = detectWish(t)
  pass('W3a', '「我去健身房了」算现在去', go && go.label === '健身', go ? go.label : 'null')
  pass('W3b', '「想练练」算以后想做的事', wish !== null, wish ? wish.label : 'null')
}

console.log(fail ? `\n${fail} 项失败` : `\n全部通过（${n} 项）`)
process.exit(fail ? 1 : 0)
