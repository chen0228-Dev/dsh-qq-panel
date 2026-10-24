/**
 * 连发合并的回归测试。需要在服务器上跑（依赖 /opt/qqbot/panel 的模块与配置）：
 *   scp tools/merge_test.mjs root@host:/tmp/ && ssh root@host 'cd /opt/qqbot/panel && node /tmp/merge_test.mjs'
 */
import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'

const p = createProxy((m) => console.log('[log]', m))

// 接管后续流程，只看最终交给 dsh 的内容
const delivered = []
p.dispatch = (text, frame) => delivered.push({ text, frame })

const mk = (text, id) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: id,
  user_id: 10001,
  self_id: 10000,
  raw_message: text,
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: 10001, nickname: '<你的抖音昵称>' },
  time: Math.floor(Date.now() / 1000)
})

console.log('--- 场景 A：连发 3 条，间隔 200ms（应合并成 1 条）---')
p.queueMessage(null, mk('在吗', 1))
setTimeout(() => p.queueMessage(null, mk('我今天去打球了', 2)), 200)
setTimeout(() => p.queueMessage(null, mk('累死了', 3)), 400)

setTimeout(() => {
  console.log('交给模型的消息条数:', delivered.length)
  if (delivered.length) {
    const f = delivered[0].frame
    console.log('段数:', f.message.length)
    console.log('内容预览:')
    console.log(f.message.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join(''))
    console.log('raw_message:', JSON.stringify(f.raw_message))
    console.log('message_id（应为最后一条）:', f.message_id)
  }

  delivered.length = 0
  console.log('\n--- 场景 B：两条间隔 2 秒（应各自独立）---')
  p.queueMessage(null, mk('第一条', 11))
  setTimeout(() => p.queueMessage(null, mk('第二条', 12)), 2000)
  setTimeout(() => {
    console.log('交给模型的消息条数（应为 2）:', delivered.length)
    delivered.forEach((d, i) => console.log(`  第 ${i + 1} 条:`, d.frame.raw_message))
    process.exit(0)
  }, 3600)
}, 1800)
