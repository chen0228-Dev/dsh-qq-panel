// 拆条条数 & 表情提醒 的离线验证
import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'
import { loadConfig } from '/opt/qqbot/panel/lib/store.js'

const cfg = loadConfig()
const sp = cfg.reply.split
console.log('线上拆条配置:', JSON.stringify(sp))

const p = createProxy(() => {})
const frameOf = (text) => JSON.stringify({ action: 'send_private_msg', params: { user_id: 10001, message: [{ type: 'text', data: { text } }] } })

const samples = {
  '短回复(18字)': '行 我知道了 你早点睡吧',
  '中等(48字)': '行 我知道了\n你早点睡吧 别熬了\n明天还要上课呢\n我这边也困了 眼睛都睁不开',
  '长(120字)': '今天下午那个会开得我脑壳疼 讲了两小时啥也没定 领导在那绕来绕去 我在底下偷偷刷手机 结果被点名问意见 我说都挺好 其实心里想的是赶紧散会 散会之后又被拉去改方案 改到六点半才走 路上还下雨 伞也没带 到家鞋全湿了 现在只想躺平'
}

for (const [label, text] of Object.entries(samples)) {
  const counts = []
  let example = null
  for (let i = 0; i < 8; i++) {
    const plan = p.splitPlan(frameOf(text))
    const parts = plan ? plan.parts : [text]
    counts.push(parts.length)
    if (!example) example = parts
  }
  console.log(`\n${label}: 条数样本 ${counts.join(',')}`)
  console.log('  示例:', JSON.stringify(example))
}

// 表情提醒：freq=70 → 大约每 N 条一次
const fake = JSON.parse(JSON.stringify(cfg))
fake.stickers.freq = 70
const frame = { user_id: 10001, message_type: 'private', message: [] }
const hits = []
for (let i = 1; i <= 10; i++) {
  const nudge = p.stickerNudge(fake, frame)
  if (nudge) hits.push(i)
}
console.log('\nfreq=70 时第几条开始提醒:', hits.join(','))
console.log('提醒文案:', (p.stickerNudge(fake, frame) || '(这次不提醒)').slice(0, 80))
