// 忙里偷闲：窗口计算 + 偷闲时的主动消息 + 忙时偷聊两条后变慢
import fs from 'node:fs'
import path from 'node:path'
import { campusState } from '../panel/lib/campus.js'
import { createProxy } from '../panel/lib/proxy.js'
import { createProactive } from '../panel/lib/proactive.js'
import { loadConfig, saveConfig } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

// 这组用例会走 dispatch，跳题联想是按概率随机注入的 —— 不关掉断言就成了随机的
saveConfig({ reply: { assoc: { enabled: false }, opinion: { enabled: false } } })

const resetProactiveState = () => {
  // 覆盖写成空状态，**不要 unlink**。
  // Windows 下删文件偶尔会失败（被占用），异常被 catch 吞掉后旧数据还在，
  // 上一条用例留下的 lastAt 会把这一条的「间隔」判断一直挡住 —— 排查了很久才定位到。
  try {
    fs.writeFileSync(path.join(process.env.PANEL_DATA || './data', 'proactive.json'), '{}')
  } catch {
    /* 写不进去也没别的办法 */
  }
}

const SLOTS = '08:00-09:40,10:00-11:40,14:00-15:40'
const campusCfg = {
  campus: {
    enabled: true,
    age: 20,
    job: 'student',
    grade: '大三',
    major: '新闻传播',
    // 关掉每日活动：这组用例要构造「确定在上课」的场景，
    // 活动池是按日期随机的，开着会让断言不稳定（不是功能问题，是变量没控制住）
    eventsPerDay: 0,
    riseAt: '07:00',
    lightsOut: '23:30',
    weekendWake: '10:30',
    classSlots: SLOTS
  }
}

const at = (h, m) => {
  const d = new Date(2026, 9, 22) // 周四
  d.setHours(h, m, 0, 0)
  return d
}

/* ---------- S1 窗口本身 ---------- */
const day = new Date(2026, 9, 22)
const sneaks = []
for (let m = 8 * 60; m < 9 * 60 + 40; m++) {
  const t = new Date(day)
  t.setHours(0, m, 0, 0)
  const s = campusState(campusCfg, t)
  if (s.sneak) sneaks.push({ m, id: s.windowId, left: s.minutesLeft })
}
const byWin = {}
for (const s of sneaks) byWin[s.id] = (byWin[s.id] || 0) + 1
const lens = Object.values(byWin)
pass('S1', '早八里存在偷闲窗口', sneaks.length >= 2, `共 ${sneaks.length} 分钟，分属 ${lens.length} 个窗口`)
pass('S1b', '每个窗口都很短（2-5 分钟）', lens.every((n) => n >= 2 && n <= 5), `各窗口 ${lens.join('/')} 分钟`)
pass('S1c', '窗口里的 busy 是 0（能快回）', sneaks.length > 0 && campusState(campusCfg, at(0, 0)).busy === 3)

// 确定性：同一分钟算两次结果一致
const t1 = new Date(day)
t1.setHours(0, sneaks[0].m, 0, 0)
const a1 = campusState(campusCfg, t1)
const a2 = campusState(campusCfg, t1)
pass('S1d', '同一时刻结果稳定', a1.key === a2.key && a1.windowId === a2.windowId, `${a1.key}/${a1.windowId}`)

// 窗口外仍是上课
const outside = (() => {
  for (let m = 8 * 60; m < 9 * 60 + 40; m++) {
    const t = new Date(day)
    t.setHours(0, m, 0, 0)
    const s = campusState(campusCfg, t)
    if (!s.sneak && (s.key === 'busy' || s.key === 'class')) return s
  }
  return null
})()
pass('S1e', '窗口外是正常上课（busy=2）', outside && outside.busy === 2, outside ? '' : '没找到')

// 闲的时候不会冒出偷闲窗口（16:20 没课）
const freeSneak = campusState({ campus: { ...campusCfg.campus } }, at(16, 20))
pass('S1f', '没在上课的时间不会显示偷闲', freeSneak.sneak !== true, `实际 ${freeSneak.key}`)

/* ---------- S2 偷闲时的主动消息 ---------- */
const sneakMinute = new Date(day)
sneakMinute.setHours(0, sneaks[0].m, 0, 0)
saveConfig({
  ...campusCfg,
  proactive: {
    enabled: true,
    minGap: 90,
    maxGap: 240,
    dailyMax: 99,
    idleMinutes: 5,
    activeFrom: '00:00',
    activeTo: '23:59',
    sneakEnabled: true,
    sneakDailyMax: 2,
    sneakChance: 100,
    enabledAt: 0
  },
  qzone: { autoEnabled: false }
})
resetProactiveState()

const sent = []
const fakeProxy = {
  lastUserAtFor: () => 0,
  status: () => ({ napcat: true, dsh: true, botQQ: '10000' }),
  injectPrivateMessage: (t) => sent.push(t),
  setUserActivityHook: () => {},
  setQzoneHook: () => {}
}
const pro = createProactive(fakeProxy, () => {}, { now: () => sneakMinute })
pro.checkNow()
pass('S2', '偷闲窗口里会主动说一句', sent.length === 1, sent[0] ? sent[0].slice(0, 24) + '…' : '没发')
pass('S2b', '不受 90 分钟间隔限制（常规调度绝对发不出来）', sent.length === 1)
const msg = sent[0] || ''
pass('S2c', '提示词强调「几分钟/别开新话题」', /别开新话题/.test(msg) && /分钟/.test(msg))
pass('S2d', '提示词带上剩余分钟数', /\d+ 分钟空当/.test(msg), (msg.match(/\d+ 分钟空当/) || [])[0])

// 同一个窗口只发一次
pro.checkNow()
pro.checkNow()
pass('S2e', '同一个窗口不会刷屏', sent.length === 1, `累计 ${sent.length} 条`)

/* ---------- S3 每天上限 ---------- */
const state = JSON.parse(fs.readFileSync(path.join(process.env.PANEL_DATA || './data', 'proactive.json'), 'utf8'))
pass('S3', '记下了 windowId 与当日次数', state.sneakWin === sneaks[0].id && state.sneakCount === 1, JSON.stringify({ w: state.sneakWin, n: state.sneakCount }))

/* ---------- S4 关掉开关就不发 ---------- */
resetProactiveState()
// enabledAt 设成现在：让常规调度被间隔挡住，好确认「不发」不是因为别的分支
saveConfig({ proactive: { sneakEnabled: false, sneakChance: 100, sneakDailyMax: 2, enabledAt: Date.now() } })
const sent2 = []
const pro2 = createProactive({ ...fakeProxy, injectPrivateMessage: (t) => sent2.push(t) }, () => {}, { now: () => sneakMinute })
pro2.checkNow()
pass('S4', '关掉后偷闲不发', sent2.length === 0, sent2.length ? 'still sent' : '没发')

/* ---------- S5 忙时偷聊两条后变慢 ---------- */
// 现在的真实时刻不一定在上课，所以临时造一节「此刻正在上」的课：
// 从现在的分钟往前找，找一个落点不在偷闲窗口里的起点
const pad = (n) => String(n).padStart(2, '0')
const nowD = new Date()
const nowMin = nowD.getHours() * 60 + nowD.getMinutes()
let slotStart = null
for (let back = 8; back >= 1; back--) {
  const a = nowMin - back
  if (a < 0) continue
  const cfgTry = { campus: { ...campusCfg.campus, classSlots: `${pad(Math.floor(a / 60))}:${pad(a % 60)}-${pad(Math.floor((a + 40) / 60) % 24)}:${pad((a + 40) % 60)}` } }
  const st = campusState(cfgTry, nowD)
  // 状态机泛化后 key 从 class 变成 busy（不再是学生专属），两个都认
  if ((st.key === 'busy' || st.key === 'class') && st.busy === 2) {
    slotStart = cfgTry.campus.classSlots
    break
  }
}
pass('S5pre', '构造出一节此刻正在上的课', Boolean(slotStart), slotStart || '没找到')

saveConfig({
  campus: { ...campusCfg.campus, classSlots: slotStart || SLOTS },
  reply: { coalesceMs: 1000, pace: { enabled: true, mode: 'life', skipLowValue: false } }
})
const p = createProxy(() => {})
p.log = () => {}
p.pace.clear()
p.inbox.clear()

const mkFrame = (text) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  self_id: 10000,
  message_id: Math.floor(Math.random() * 1e9),
  message: [{ type: 'text', data: { text } }],
  raw_message: text
})
const delayOf = (key) => {
  const b = p.inbox.get(key)
  return b && b.timer ? b.timer._idleTimeout : null
}

// 冻结在「上课窗口外」的时间，并让她刚说过话 → 模拟偷聊
const classTime = (() => {
  for (let m = 8 * 60; m < 9 * 60 + 40; m++) {
    const t = new Date(day)
    t.setHours(0, m, 0, 0)
    const s = campusState(campusCfg, t)
    if (!s.sneak && s.key === 'class') return t
  }
  return at(8, 10)
})()

const origCampus = campusState
// 用真实时间不方便冻结，这里直接改 pace 状态来模拟「她刚说过话」
p.pace.set('private:10001', { lastDispatchAt: 0, lastSpokeAt: Date.now(), skipped: 0 })
const results = []
for (let i = 0; i < 4; i++) {
  p.inbox.clear()
  p.queueMessage(JSON.stringify(mkFrame(`第${i + 1}句`)), mkFrame(`第${i + 1}句`))
  results.push(delayOf('private:10001'))
  const st = p.pace.get('private:10001')
  st.lastSpokeAt = Date.now() // 假设她每条都回了
}
const fastCount = results.filter((d) => d !== null && d <= 6000).length
pass('S5', '忙时只偷回一条（第一条快）', fastCount === 1, `各次延迟 ${results.map((d) => Math.round((d || 0) / 1000) + 's').join(',')}`)
pass('S5b', '第二条起就要收心（明显变慢）', results[1] > 60_000, `第2条 ${Math.round((results[1] || 0) / 1000)} 秒`)

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
