/**
 * 跳题联想测试（`assocLine` / `needsFocus`）。
 *
 * 这个机制最容易翻车的两件事：
 * 1. 对方在说正事/难受的事，她岔开了 —— 没心没肺；
 * 2. 每句都岔 —— 变成她在讲自己的事，不听人说话。
 * 所以测试的重点不是「能不能岔」，而是「什么时候不许岔」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { assocLine, needsFocus, resetAssoc, assocInfo } from '../panel/lib/assoc.js'
import { saveConfig } from '../panel/lib/store.js'
import { createProxy } from '../panel/lib/proxy.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${extra ? ' — ' + extra : ''}`)
}

const setAssoc = (o) => saveConfig({ reply: { assoc: { enabled: true, chance: 100, maxStreak: 99, ...o } } })
const call = (text, extra = {}) => assocLine(null, { text, busy: 0, sneak: false, ...extra }) || ''
const cfgOf = (o) => ({ reply: { assoc: { enabled: true, chance: 100, maxStreak: 99, ...o } } })
const run = (text, o = {}, extra = {}) => assocLine(cfgOf(o), { text, busy: 0, sneak: false, ...extra })

/* ---------- A1 开关 ---------- */
resetAssoc()
pass('A1', '总开关关掉就不联想', run('今天好累啊', { enabled: false }) === '')
pass('A1b', '概率 0 就不联想', run('今天好累啊', { chance: 0 }) === '')

/* ---------- A2 会给许可时的文本 ---------- */
resetAssoc()
const t = run('今天好累啊 一点力气都没有', { chance: 100 })
pass('A2', '闲聊时会给出联想许可', t.length > 0)
pass('A2b', '明确要求先答复再岔', /先答他说的，再岔/.test(t), '')
pass('A2c', '给了素材', /·\s*\S+/.test(t))
pass('A2d', '说明可以不拉回来', /也可以不拉/.test(t))
pass('A2e', '标了「内部提示，别解释」', /内部提示/.test(t))
pass('A2f', '不许一次岔两件', /别一次岔两件/.test(t))

/* ---------- A3 由头匹配：说「累」要抽到累相关的素材 ---------- */
let tiredHit = 0
for (let i = 0; i < 12; i++) {
  resetAssoc()
  const s = run('今天累死了 一点力气都没有', { chance: 100 })
  if (/睡了一节|改稿|趴桌上|咖啡/.test(s)) tiredHit++
}
pass('A3', '说「累」时素材能对上（12 次里至少 9 次）', tiredHit >= 9, `命中 ${tiredHit}/12`)

/* ---------- A4 无由头也能岔 ---------- */
resetAssoc()
const randomish = run('哦哦 这样啊', { chance: 100 })
pass('A4', '没什么由头时也会给（允许无由头岔开）', randomish.length > 0)

/* ---------- A5 该闭嘴的时候必须闭嘴 ---------- */
const quiet = [
  ['我妈住院了 我有点慌', '倾诉难受的事'],
  ['这个报错怎么解决？', '问具体问题'],
  ['能帮我看看这段代码吗', '求助'],
  ['我跟他吵架了 很难受', '情绪事件'],
  ['救命 明天要面试', '紧急'],
  ['我分手了', '重大情绪']
]
for (const [text, why] of quiet) {
  resetAssoc()
  pass('A5', `不许岔：${why}`, run(text, { chance: 100 }) === '', JSON.stringify(text))
}
pass('A5b', 'needsFocus 认得出问句', needsFocus('这个怎么办？') === true)
pass('A5c', 'needsFocus 不误杀日常闲聊', needsFocus('今天好累啊') === false && needsFocus('在干嘛') === false)

/* ---------- A6 她自己在忙时不岔 ---------- */
resetAssoc()
pass('A6', '上课/自习（busy=2）不岔', run('今天好累啊', { chance: 100 }, { busy: 2 }) === '')
pass('A6b', '睡着（busy=3）不岔', run('今天好累啊', { chance: 100 }, { busy: 3 }) === '')

/* ---------- A7 偷闲窗口概率减半 ---------- */
resetAssoc()
const sneakChance = 30
let sneakHits = 0
for (let i = 0; i < 300; i++) {
  resetAssoc()
  if (run('今天食堂人好多', { chance: sneakChance }, { sneak: true })) sneakHits++
}
const sneakRate = (sneakHits / 300) * 100
pass('A7', '偷闲窗口里概率减半（30% → 约 15%）', sneakRate >= 6 && sneakRate <= 24, `实测 ${sneakRate.toFixed(0)}%`)

/* ---------- A8 频率大致符合配置 ---------- */
let hits = 0
for (let i = 0; i < 400; i++) {
  resetAssoc()
  if (run('今天上课好无聊', { chance: 30 })) hits++
}
const rate = (hits / 400) * 100
pass('A8', '概率 30% 时实际约 3 成', rate >= 20 && rate <= 41, `实测 ${rate.toFixed(0)}%（400 次）`)

/* ---------- A9 连着岔会强制停一轮 ---------- */
resetAssoc()
const seq = []
for (let i = 0; i < 5; i++) seq.push(run('随便聊聊吧', { chance: 100, maxStreak: 2 }) ? 1 : 0)
// maxStreak=2：前两条岔，第三条被强制断，第四条起重新可以岔
pass('A9', '岔满两条会自动停一轮', seq[0] === 1 && seq[1] === 1 && seq[2] === 0, `序列 ${seq.join('')}`)
pass('A9b', '停完一轮后能恢复', seq[3] === 1 || seq[4] === 1, `序列 ${seq.join('')}`)

/* ---------- A10 素材不重复 ---------- */
resetAssoc()
const used = new Set()
let dup = 0
let total = 0
for (let i = 0; i < 20; i++) {
  const s = run('今天好累啊', { chance: 100, maxStreak: 99 })
  const items = (s.match(/·\s*(.+)/g) || []).map((x) => x.replace(/·\s*/, '').trim())
  for (const it of items) {
    total++
    if (used.has(it)) dup++
    used.add(it)
  }
}
pass('A10', '20 轮里素材不重复', dup === 0, `共 ${total} 条，重复 ${dup} 条`)

/* ---------- A11 记录「从哪跳到哪」 ---------- */
resetAssoc()
run('今天好累啊', { chance: 100 })
const info = assocInfo()
pass('A11', '记下了由头', info.last && String(info.last.from || '').length > 0, JSON.stringify(info.last))
pass('A11b', '记下了跳到哪', info.last && String(info.last.to || '').length > 0)

/* ---------- A12 接入 dispatch：提示要进到交给模型的那一帧里 ---------- */
resetAssoc()
saveConfig({
  campus: { enabled: false },
  reply: { speed: 1, assoc: { enabled: true, chance: 100, maxStreak: 9 } }
})
const proxy = createProxy(() => {})
const captured = []
proxy.upstream = { readyState: 1, send: (x) => captured.push(String(x)) }
const frame = {
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  self_id: 10000,
  message: [{ type: 'text', data: { text: '今天好累啊 一点力气都没有' } }],
  raw_message: '今天好累啊 一点力气都没有'
}
proxy.dispatch(JSON.stringify(frame), frame)
await new Promise((r) => setTimeout(r, 300))
const sent = captured.join('\n')
pass('A12', '联想提示被注入到交给模型的帧里', /这条可以不只接话/.test(sent))
pass('A12b', '原消息没丢', sent.includes('今天好累啊'))
// message 里一份、raw_message 里还有一份（跟 moodLine 一样），所以要按段数
const firstFrame = captured.length ? JSON.parse(captured[0]) : { message: [] }
const hintSegs = (firstFrame.message || []).filter((x) => x && x.type === 'text' && /这条可以不只接话/.test(String(x.data?.text || '')))
pass('A12c', '只注入了一段，没重复', hintSegs.length === 1, `${hintSegs.length} 段`)

/* ---------- A13 关掉之后 dispatch 里就不该出现 ---------- */
resetAssoc()
saveConfig({ reply: { assoc: { enabled: false } } })
const p2 = createProxy(() => {})
const cap2 = []
p2.upstream = { readyState: 1, send: (x) => cap2.push(String(x)) }
p2.dispatch(JSON.stringify(frame), frame)
await new Promise((r) => setTimeout(r, 300))
pass('A13', '关掉后 dispatch 不再注入联想', !/这条可以不只接话/.test(cap2.join('\n')))

/**
 * 恢复共享配置。
 *
 * 前面为了绕开「上课不岔」把 campus 关掉了，又把 assoc 关掉做过 A13 ——
 * 这组测试和别的测试共用 data/config.json，不恢复的话后面的 pace-proactive 会挂在 W6
 * （它要验「上课时段不主动开口」，结果发现 campus 是关的）。
 */
saveConfig({ campus: { enabled: true }, reply: { assoc: { enabled: true, chance: 30 } } })

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
