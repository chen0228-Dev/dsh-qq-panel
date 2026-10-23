import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'

const p = createProxy(() => {})

const cases = [
  ['短句 4 字', { action: 'send_msg', params: { message: '在干嘛呢' } }],
  ['一般 11 字', { action: 'send_msg', params: { message: [{ type: 'text', data: { text: '今天天气不错，出去走走吧' } }] } }],
  ['长段 80 字', { action: 'send_private_msg', params: { message: [{ type: 'text', data: { text: '啊'.repeat(80) } }] } }],
  ['纯图片', { action: 'send_msg', params: { message: [{ type: 'image', data: { file: 'x.png' } }] } }],
  ['非发送类', { action: 'get_friend_list', params: {} }],
  ['撤回', { action: 'delete_msg', params: { message_id: 1 } }]
]

for (const [name, frame] of cases) {
  const ms = p.typingDelayFor(JSON.stringify(frame))
  console.log(`${name.padEnd(12)} → ${ms} ms`)
}

const cfg = JSON.parse(JSON.stringify((await import('/opt/qqbot/panel/lib/store.js')).loadConfig().typing))
console.log('\n当前配置:', JSON.stringify(cfg))
