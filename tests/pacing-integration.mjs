// 节奏引擎与代理层的接线测试：不真发消息、不产生会话
import { createProxy } from '../panel/lib/proxy.js'
import { loadConfig, saveConfig } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const cfg = loadConfig()
const p = createProxy(() => {})
p.log = () => {}

const mkFrame = (uid, text) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: uid,
  self_id: 10000,
  message_id: Math.floor(Math.random() * 1e9),
  message: [{ type: 'text', data: { text } }],
  raw_message: text
})

/* ---- T1 攒批：延迟档会进 inbox 而不是立刻派发 ---- */
// 关掉跳题联想：它按概率注入，会让这里的断言变成随机的
saveConfig({ reply: { assoc: { enabled: false }, opinion: { enabled: false }, pace: { enabled: true, mode: 'life', skipLowValue: false } } })
let dispatched = 0
p.dispatch = () => {
  dispatched++
}
p.queueMessage(JSON.stringify(mkFrame(10001, '我今天面试砸了')), mkFrame(10001, '我今天面试砸了'))
const box = p.inbox.get('private:10001')
pass('T1', '走延迟档时进 inbox', Boolean(box) && box.paced === true, box ? `队列 ${box.items.length} 条` : '没进队列')
pass('T1b', '没有立刻交给模型', dispatched === 0)

/* ---- T2 攒批：不 debounce，第二条不重置定时器 ---- */
if (box) {
  const t1 = box.timer
  p.queueMessage(JSON.stringify(mkFrame(10001, '唉')), mkFrame(10001, '唉'))
  const box2 = p.inbox.get('private:10001')
  pass('T2', '同一个人再发一条并入同一批', box2.items.length === 2, `现在 ${box2.items.length} 条`)
  pass('T2b', '定时器没有被重置（不无限等）', box2.timer === t1)
}

/* ---- T3 合并提示：积压场景要说「挑值得回的」 ---- */
const items = [
  { text: 'a', frame: mkFrame(10002, '在吗'), at: Date.now() - 60000 },
  { text: 'b', frame: mkFrame(10002, '我今天不想说话'), at: Date.now() }
]
const merged = p.mergeFrames(items, true)
const mergedText = String(merged.frame.message[0].data.text)
pass('T3', '积压合并提示允许不回', /挑值得回的/.test(mergedText) && /可以不回/.test(mergedText))
pass('T3b', '提示里说明了隔了多久', /分钟|秒/.test(mergedText), mergedText.slice(0, 40))

const normal = String(p.mergeFrames(items, false).frame.message[0].data.text)
pass('T3c', '普通连发提示保持原样', /连着发了 2 条/.test(normal) && !/挑值得回的/.test(normal))

/* ---- T4 低价值消息：不派发、只计数 ---- */
saveConfig({ reply: { assoc: { enabled: false }, opinion: { enabled: false }, pace: { enabled: true, mode: 'life', skipLowValue: true } } })
p.pace.clear()
let dispatched2 = 0
p.dispatch = () => {
  dispatched2++
}
p.queueMessage(JSON.stringify(mkFrame(10003, '嗯')), mkFrame(10003, '嗯'))
const st = p.pace.get('private:10003')
pass('T4', '单字被跳过', dispatched2 === 0 && !p.inbox.has('private:10003'), `skipped=${st ? st.skipped : '?'}`)

/* ---- T5 「正在聊」要快 ---- */
p.pace.set('private:10004', { lastDispatchAt: Date.now() - 5000, skipped: 0 })
p.queueMessage(JSON.stringify(mkFrame(10004, '那你打算怎么办')), mkFrame(10004, '那你打算怎么办'))
const box4 = p.inbox.get('private:10004')
const delay4 = box4 && box4.timer ? box4.timer._idleTimeout : 0
pass('T5', '正在聊时延迟在 6 秒内', box4 && box4.timer && delay4 <= 6000, `定时器 ${delay4}ms`)

/* ---- T6 关掉节奏 = 老行为 ---- */
saveConfig({ reply: { assoc: { enabled: false }, opinion: { enabled: false }, pace: { enabled: false } } })
p.pace.clear()
p.inbox.clear()
let dispatched3 = 0
p.dispatch = () => {
  dispatched3++
}
saveConfig({ reply: { coalesceMs: 0 } })
p.queueMessage(JSON.stringify(mkFrame(10005, '关掉节奏测试')), mkFrame(10005, '关掉节奏测试'))
pass('T6', '关掉节奏且无合并 → 立刻交给模型', dispatched3 === 1)

// 收尾：清掉挂着的定时器，别让进程挂着
for (const [, b] of p.inbox) clearTimeout(b.timer)
p.inbox.clear()

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
