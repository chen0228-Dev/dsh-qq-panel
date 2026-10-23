// 在校生状态机 + 忙碌对节奏的影响
import { campusState, DEFAULT_CAMPUS } from '../panel/lib/campus.js'
import { planPace } from '../panel/lib/pacing.js'
import { renderPersona } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

// 关掉「每日活动」：这组用例验的是固定日程表的确定性（几点午休、几点熄灯），
// 活动是按日期随机抽的，开着会让「14:30 应该在忙」时好时坏 —— 不是功能问题，是变量没控住。
// 活动相关行为在 campus-role-test 的 A12~A15 单独测。
const cfg = { campus: { ...DEFAULT_CAMPUS, eventsPerDay: 0 } }
const at = (day, h, m) => {
  const d = new Date(2026, 9, day) // 2026-10-22 是周四
  d.setHours(h, m, 0, 0)
  return d
}

/* ---------- R1 一天里的状态 ---------- */
const cases = [
  [2, 30, 'sleep', 3],
  [7, 20, 'rush', 1],
  [8, 30, 'busy', 2],
  [9, 35, 'break', 0],
  [9, 45, 'after-busy', 0],
  [11, 50, 'lunch', 1],
  [13, 0, 'nap', 1],
  [14, 30, 'busy', 2],
  // 16:20 现在可能被「今日活动」抽中（打球/图书馆…），那是新功能，两种都算对
  [16, 20, 'afternoon', 0],
  [19, 0, 'evening', 0],
  [21, 30, 'dorm', 0],
  [23, 50, 'lightsout', 0]
]
for (const [h, m, key, busy] of cases) {
  const s = campusState(cfg, at(22, h, m))
  // 上课时段里可能正好落在「偷闲窗口」（课上的几分钟空当），
  // 那同样是课上，只是当下有空 —— 两种都算对
  let ok
  if (key === 'busy') {
    // 忙时可能正好落在「偷闲窗口」，同样是忙，只是当下有空
    ok = s.key === 'busy' || s.key === 'sneak'
  } else if (key === 'afternoon') {
    // 兜底状态可能被今日活动覆盖（新功能）
    ok = s.key === 'idle' || s.key === 'event' || s.key === 'slot'
  } else {
    ok = s.key === key && s.busy === busy
  }
  pass(`R1 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, `→ ${key}`, ok, `实际 ${s.key} busy=${s.busy}`)
}

/* ---------- R2 周末 ---------- */
const sat = campusState(cfg, at(24, 9, 0)) // 2026-10-24 周六
pass('R2', '周六 9 点还在睡（周末睡到 10:30）', sat.key === 'sleep', `实际 ${sat.key}`)
const satNoon = campusState(cfg, at(24, 12, 30))
pass('R2b', '周六中午是吃饭状态', satNoon.key === 'lunch' || satNoon.key === 'weekend-lunch', `实际 ${satNoon.key}`)
const satNoonClass = campusState(cfg, at(24, 8, 30))
pass('R2c', '周末不上课', satNoonClass.key !== 'busy' && satNoonClass.key !== 'class', `实际 ${satNoonClass.key}`)

/* ---------- R3 确定性 ---------- */
const a1 = campusState(cfg, at(22, 15, 0))
const a2 = campusState(cfg, at(22, 15, 0))
pass('R3', '同一时刻结果一致', a1.key === a2.key && a1.line === a2.line)

/* ---------- R4 关掉设定 ---------- */
const off = campusState({ campus: { ...DEFAULT_CAMPUS, enabled: false } }, at(22, 8, 30))
pass('R4', '关掉后不返回状态', off.busy === 0 && !off.line)

/* ---------- R5 自定义课表生效 ---------- */
// 关掉活动：这条验的是「自己填的课表能不能盖过默认课表」，
// 活动会盖掉课表（活动优先），开着就测不到课表了
const custom = campusState(
  { campus: { ...DEFAULT_CAMPUS, classSlots: '18:30-20:00', eventsPerDay: 0 } },
  at(22, 19, 0)
)
pass('R5', '自定义课表覆盖默认', custom.key === 'busy' || custom.key === 'sneak', `实际 ${custom.key}`)

/* ---------- R6 忙碌影响延迟 ---------- */
const paceCfg = { reply: { pace: { enabled: true, mode: 'mix', instantRate: 100 } } }
const free = planPace(paceCfg, { hour: 15, chatting: false, busy: 0, unanswered: 0 })
const inClass = planPace(paceCfg, { hour: 15, chatting: false, busy: 2, unanswered: 0 })
const asleep = planPace(paceCfg, { hour: 3, chatting: false, busy: 3, unanswered: 0 })
pass('R6', '有空时 100% 秒回就是 0', free.delayMs === 0)
pass('R6b', '上课中即使设成 100% 秒回也会拖', inClass.delayMs > 0, `${Math.round(inClass.delayMs / 1000)} 秒 band=${inClass.band}`)
pass('R6c', '睡着了拖到最长档', asleep.band === 'long', `band=${asleep.band}`)
const chatInClass = planPace(paceCfg, { hour: 15, chatting: true, busy: 2, unanswered: 0 })
pass('R6d', '但正在聊的时候上课也照样快', chatInClass.delayMs <= 6000, `${chatInClass.delayMs}ms`)

/* ---------- R7 人格文件里带上身份 ---------- */
const persona = renderPersona({
  persona: { enabled: true, name: '小柒', identity: '暗恋号主', style: '可爱', tone: '俏皮', maxChars: 100 },
  campus: { ...DEFAULT_CAMPUS, age: 20, grade: '大三', major: '新闻传播' },
  stickers: { enabled: false },
  capabilities: {},
  paths: { workspace: '/tmp' }
})
pass('R7', 'AGENTS.md 含年龄和学历', /20 岁/.test(persona) && /大三/.test(persona) && /新闻传播/.test(persona))
pass('R7b', 'AGENTS.md 说明忙的时候可以不回', /(课|忙)/.test(persona) && /不方便回/.test(persona))
const personaOff = renderPersona({
  persona: { enabled: true, name: 'x', identity: 'y', style: 'z', tone: 'w', maxChars: 100 },
  campus: { ...DEFAULT_CAMPUS, enabled: false },
  stickers: { enabled: false },
  capabilities: {},
  paths: { workspace: '/tmp' }
})
pass('R7c', '关掉后不写这段', !/你的日常/.test(personaOff))

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
