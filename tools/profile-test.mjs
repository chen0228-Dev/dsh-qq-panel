// 按人设置的单元测试：只验证解析与注入，不动线上配置
import { loadConfig, resolveProfile, profileBlock, sanitizeOverrides } from '/opt/qqbot/panel/lib/store.js'
import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'

const cfg = loadConfig()
const admin = String(cfg.qq.adminQQ)
const visitor = '999999999'

const fake = JSON.parse(JSON.stringify(cfg))
fake.profiles = {
  enabled: true,
  visitor: {
    persona: { name: '客服小助', identity: '客服', style: '公事公办', tone: '客气', maxChars: 40, human: 10, swear: 0 },
    reply: { probability: 0.5, split: { enabled: false } },
    stickers: { enabled: false }
  },
  users: [{ qq: visitor, name: '测试号', enabled: true, overrides: { persona: { name: '老张' } } }]
}

const a = resolveProfile(fake, admin)
const v = resolveProfile(fake, visitor)
const u = resolveProfile(fake, '123123123')

console.log('主号：isAdmin =', a.isAdmin, '| overrides =', a.overrides, '| 同一对象 =', a.cfg === fake)
console.log('访客默认：label =', u.label, '| 名字 =', u.cfg.persona.name, '| 概率 =', u.cfg.reply.probability, '| 分条 =', u.cfg.reply.split.enabled, '| 表情 =', u.cfg.stickers.enabled)
console.log('单独覆盖：label =', v.label, '| 名字 =', v.cfg.persona.name, '| 风格仍是访客的 =', v.cfg.persona.style)

console.log('\n--- 注入块（单独覆盖那位）---')
console.log(profileBlock(v.overrides))

console.log('--- 注入块（纯访客默认）---')
console.log(profileBlock(u.overrides))

// 越权字段必须被丢掉
const dirty = sanitizeOverrides({
  persona: { name: 'x', notAllowed: 1 },
  model: { model: 'evil' },
  dsh: { onebotPort: 1 },
  reply: { probability: 0.2, split: { enabled: true, maxChars: 999 } }
})
console.log('\n清洗结果：', JSON.stringify(dirty))

const proxy = createProxy(() => {})
console.log('proxy.cfgFor(admin).persona.name =', proxy.cfgFor(admin).persona.name)
console.log('proxy.cfgFor(visitor).persona.name =', proxy.cfgFor(visitor).persona.name)
