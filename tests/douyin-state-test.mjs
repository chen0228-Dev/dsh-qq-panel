/**
 * 「她正在刷抖音」这个临时状态的测试（2026-10-24）。
 *
 * 这个功能最容易出的两种错，正是这个测试要拦的：
 *  1. 电脑关着她也在说「我在刷抖音」—— 那是编。
 *     所以状态**只能**由采集端上报驱动，测试里第 D4 组专门验这条。
 *  2. 半夜 2 点覆盖掉「睡着」—— 那更假。第 D3 组验优先级。
 */
import { campusState, setTransientState, DEFAULT_CAMPUS } from '../panel/lib/campus.js'
import { stateFactor } from '../panel/lib/assoc.js'

let fail = 0
let n = 0
const pass = (id, name, ok, extra = '') => {
  n++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) fail++
}

const CFG = { campus: { ...DEFAULT_CAMPUS, enabled: true, busySlots: '', routine: { slots: [], events: [], eventsPerDay: 0 } } }
const at = (h, m = 0) => new Date(2026, 9, 22, h, m, 0)

const DY = { key: 'douyin', label: '在刷抖音', busy: 1, line: '你在刷抖音，手机横着拿' }

/* ---------- D1 不注册钩子 = 完全没影响 ---------- */
setTransientState(null)
{
  const s = campusState(CFG, at(15))
  pass('D1', '没注册钩子时行为和以前一致', s.key !== 'douyin' && !s.transient, `实际 ${s.key}`)
}

/* ---------- D2 注册之后生效 ---------- */
setTransientState(() => DY)
{
  const s = campusState(CFG, at(15))
  pass('D2', '注册后返回「在刷抖音」', s.key === 'douyin' && s.label === '在刷抖音', `${s.key}/${s.label}`)
  pass('D2b', 'busy=1（能回消息，也能主动开话题）', s.busy === 1, `busy=${s.busy}`)
  pass('D2c', '标了 transient，面板能区分"临时状态"和日程', s.transient === true)
  pass('D2d', '**不带 sneak** —— 带了跳题概率会被压到 0.35', !s.sneak, JSON.stringify(s.sneak))
  pass('D2e', '不带 windowId / minutesLeft（偷闲专用字段）', !s.windowId && s.minutesLeft === undefined)
}

/* ---------- D3 优先级：睡着 > 刷抖音 > 日程 ---------- */
setTransientState(() => DY)
{
  const night = campusState(CFG, at(2))
  pass('D3', '半夜 2 点她还是「睡着」，不会说在刷抖音', night.key !== 'douyin', `实际 ${night.key}`)
  const eve = campusState(CFG, at(23, 40))
  pass('D3b', '23:40 熄灯段优先于刷抖音（躲在被子里看手机更准确）', eve.key !== 'douyin', `实际 ${eve.key}`)
  const noon = campusState(CFG, at(15))
  pass('D3c', '正常时段刷抖音盖过日程', noon.key === 'douyin')
}

/* ---------- D4 钩子返回 null = 没在刷 ---------- */
setTransientState(() => null)
{
  const s = campusState(CFG, at(15))
  pass('D4', '钩子返回 null 就回落到日程', s.key !== 'douyin')
}

/* ---------- D5 钩子抛异常不能把状态机带崩 ---------- */
setTransientState(() => {
  throw new Error('故意炸的')
})
{
  let s = null
  let threw = false
  try {
    s = campusState(CFG, at(15))
  } catch {
    threw = true
  }
  pass('D5', '钩子抛异常时状态机不跟着崩', !threw && s && s.key !== undefined, threw ? '抛异常了' : `key=${s.key}`)
}

/* ---------- D6 状态机关掉时不受影响 ---------- */
setTransientState(() => DY)
{
  const s = campusState({ campus: { ...CFG.campus, enabled: false } }, at(15))
  pass('D6', '状态机关掉就返回 off，不被临时状态顶上来', s.key === 'off', `实际 ${s.key}`)
}

/* ---------- D7 跳题倍率：douyin 给 0.8，不是 busy 兜底的 0.6 ---------- */
{
  const cfg = { reply: { assoc: { enabled: true, chance: 30 } } }
  const f = stateFactor(cfg, 'douyin', 1, false)
  pass('D7', 'douyin 的跳题倍率是 0.8', Math.abs(f - 0.8) < 1e-9, `实际 ${f}`)
  pass('D7b', '比「有点忙」的兜底值（0.6）高 —— 刷抖音本身就有素材可聊', f > 0.6)
  pass('D7c', '不高于闲着（1）', f <= 1)
}

/* ---------- D8 和偷闲不冲突 ---------- */
{
  const cfg = { reply: { assoc: { enabled: true, chance: 30 } } }
  // 偷闲优先于 key：就算 key 是 douyin，sneak=true 时也该走 0.35
  const f = stateFactor(cfg, 'douyin', 1, true)
  pass('D8', 'sneak=true 时偷闲优先（0.35），不会被 douyin 抢走', Math.abs(f - 0.35) < 1e-9, `实际 ${f}`)
}

setTransientState(null)
console.log(fail ? `\n${fail} 项失败（共 ${n} 项）` : `\n全部通过（${n} 项）`)
process.exit(fail ? 1 : 0)
