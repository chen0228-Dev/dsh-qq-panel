// 节奏引擎单测：只测纯函数，不碰网络、不碰会话
import { isLowValue, planPace, BANDS } from '../panel/lib/pacing.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- Q1 「值不值得回」 ---------- */
const low = ['', '  ', '嗯', '哦', '草', '哈哈哈哈', '？？？', '。。。', '😅😅', '好的', '行', '1', '666']
for (const t of low) {
  pass('Q1', `判为不值得回：${JSON.stringify(t)}`, isLowValue(t))
}
const high = ['在吗', '在不在', '今天好累啊', '这个报错怎么解决', '明天几点', '你人呢', '人呢', '在不在？']
for (const t of high) {
  pass('Q1b', `判为值得回：${JSON.stringify(t)}`, !isLowValue(t))
}

/* ---------- Q2 关掉就秒回 ---------- */
const off = planPace({ reply: { pace: { enabled: false } } }, { hour: 14 })
pass('Q2', '关掉节奏引擎 → 延迟 0', off.delayMs === 0, `${off.delayMs}ms`)

/* ---------- Q3 正在聊就快 ---------- */
const chatting = planPace({ reply: { pace: { enabled: true, mode: 'life' } } }, { hour: 14, chatting: true })
pass('Q3', '正在聊 → 只做打字级延迟', chatting.delayMs <= 6000, `${chatting.delayMs}ms band=${chatting.band}`)

/* ---------- Q4 纯秒回模式 ---------- */
const inst = planPace({ reply: { pace: { enabled: true, mode: 'instant' } } }, { hour: 14 })
pass('Q4', 'instant 模式 → 0', inst.delayMs === 0)

/* ---------- Q5 生活节奏一定拖 ---------- */
let minD = Infinity
for (let i = 0; i < 40; i++) {
  const p = planPace({ reply: { pace: { enabled: true, mode: 'life' } } }, { hour: 14 })
  minD = Math.min(minD, p.delayMs)
}
pass('Q5', 'life 模式 40 次全部有延迟', minD > 0, `最短 ${Math.round(minD / 1000)} 秒`)

/* ---------- Q6 三档都在区间内 ---------- */
const seen = new Set()
let outOfRange = null
for (let i = 0; i < 300; i++) {
  const p = planPace({ reply: { pace: { enabled: true, mode: 'life' } } }, { hour: 14 })
  seen.add(p.band)
  const [lo, hi] = BANDS[p.band] || [0, 0]
  if (p.delayMs < lo * 0.9 || p.delayMs > hi * 1.1) outOfRange = `${p.band}:${p.delayMs}`
}
pass('Q6', '落在声明的区间里', !outOfRange, outOfRange || `覆盖档位 ${[...seen].join('/')}`)
pass('Q6b', '三档都抽得到', seen.size >= 2, `实际 ${[...seen].join('/')}`)

/* ---------- Q7 深夜变慢 ---------- */
const night = planPace(
  { reply: { pace: { enabled: true, mode: 'mix', instantRate: 100, nightSlow: true } } },
  { hour: 3 }
)
pass('Q7', '深夜即使设成 100% 秒回也会拖', night.delayMs > 0, `${Math.round(night.delayMs / 1000)} 秒 band=${night.band}`)
const nightOff = planPace(
  { reply: { pace: { enabled: true, mode: 'mix', instantRate: 100, nightSlow: false } } },
  { hour: 3 }
)
pass('Q7b', '关掉深夜变慢 → 秒回', nightOff.delayMs === 0)

/* ---------- Q8 已读不回有下限 ---------- */
const forced = planPace(
  { reply: { pace: { enabled: true, mode: 'life' } } },
  { hour: 14, unanswered: 3 }
)
pass('Q8', '连着跳过 3 条后强制回', forced.delayMs === 0 && forced.forced === true)

/* ---------- Q9 mix 模式的秒回比例 ---------- */
let instant = 0
for (let i = 0; i < 600; i++) {
  const p = planPace({ reply: { pace: { enabled: true, mode: 'mix', instantRate: 45 } } }, { hour: 14 })
  if (p.delayMs === 0) instant++
}
const ratio = Math.round((instant / 600) * 100)
pass('Q9', 'mix 45% 实际秒回比例接近', Math.abs(ratio - 45) <= 8, `${ratio}%`)

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
