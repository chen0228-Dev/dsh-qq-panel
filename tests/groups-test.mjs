/**
 * 群聊机制的纯逻辑测试（不依赖 ws，本地可跑）。
 *
 * 盯四件事：
 * 1. 群聊总开关关掉时，插件层必须是 groupPolicy: disabled（群消息一条都进不来）；
 * 2. 开了之后只有白名单里的群放行，且群号要写进 groupAllowFrom；
 * 3. 群档案走自己的覆盖，**不套访客默认**（语义不同：访客是陌生人，群里是熟人）；
 * 4. 档案能关掉黑话，且关掉时要明说「别用梗」——只不注入词表是不够的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PANEL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'))
const S = await import('../panel/lib/store.js')

let pass = 0
let fail = 0
const ok = (n, c, e = '') => {
  if (c) {
    pass++
    console.log(`  ok  ${n}${e ? ' — ' + e : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

const base = JSON.parse(JSON.stringify(S.DEFAULT_CONFIG || S.loadConfig()))
base.qq = { ...(base.qq || {}), adminQQ: '10000', botQQ: '20000' }
base.profiles = {
  enabled: true,
  visitor: { persona: { name: '访客名' }, voice: { enabled: false } },
  users: [{ qq: '30001', name: '老王', enabled: true, overrides: { persona: { callUser: '王哥' } } }]
}

const withGroups = (g) => ({ ...base, groups: g, whitelist: { enabled: true, entries: [{ qq: '30001', name: '老王', enabled: true }] } })

console.log('\n[1] 群聊关掉时插件必须 disabled')
let cfg = withGroups({ enabled: false, requireMention: true, entries: [{ groupId: '555', name: '同学群', enabled: true }] })
let yml = S.renderPatch(cfg)
ok('groupPolicy: disabled', /groupPolicy: disabled/.test(yml))
ok('不写 groupAllowFrom（或空）', !/groupAllowFrom:\s*\n\s+-/.test(yml))

console.log('\n[2] 开了 + 白名单 → allowlist + 群号')
cfg = withGroups({ enabled: true, requireMention: true, entries: [{ groupId: '555', name: '同学群', enabled: true }, { groupId: '666', name: '家人群', enabled: false }] })
yml = S.renderPatch(cfg)
ok('groupPolicy: allowlist', /groupPolicy: allowlist/.test(yml))
ok('只写启用的群号', /groupAllowFrom:\s*\[?\s*(?:"555"|'555'|555)/.test(yml), yml.match(/groupAllowFrom:[^\n]*/)?.[0])
ok('停用的群不写进去', !/666/.test(yml.match(/groupAllowFrom:[^\n]*/)?.[0] || ''))
ok('requireMention 跟着配置', /requireMention: true/.test(yml))

console.log('\n[3] 白名单闸门')
ok('关掉时群消息被拒', S.whitelistVerdict(withGroups({ enabled: true, requireMention: true, entries: [] }), '30001', true, '555').pass === false)
const g1 = withGroups({ enabled: true, requireMention: true, entries: [{ groupId: '555', name: 'x', enabled: true }] })
ok('白名单群放行', S.whitelistVerdict(g1, '30001', true, '555').pass === true)
ok('非白名单群被拒', S.whitelistVerdict(g1, '30001', true, '999').pass === false)
ok('取不到群号时被拒', S.whitelistVerdict(g1, '30001', true, '').pass === false)
ok('群里的人不需要在私聊名单（白名单群内随便谁 @ 都行）', S.whitelistVerdict(g1, '77777', true, '555').pass === true)
ok('私聊仍然要查名单', S.whitelistVerdict(g1, '77777', false).pass === false)

console.log('\n[4] 群档案：走自己的覆盖，不套访客默认')
const g2 = withGroups({
  enabled: true,
  requireMention: true,
  entries: [{ groupId: '555', name: '同学群', enabled: true, overrides: { persona: { style: '群里说话短一点' } } }]
})
const pg = S.resolveProfile(g2, null, { groupId: '555' })
ok('isGroup 标记', pg.isGroup === true)
ok('用了群覆盖', pg.cfg.persona.style === '群里说话短一点', pg.cfg.persona.style)
ok('没套访客默认的名字', pg.cfg.persona.name !== '访客名', pg.cfg.persona.name || '(空)')
ok('没套访客默认的语音开关', pg.cfg.voice.enabled !== false)
const pg2 = S.resolveProfile(g2, null, { groupId: '999' })
ok('不在白名单的群 → 无覆盖', pg2.overrides === null)

console.log('\n[5] 私聊档案不受群逻辑影响')
const pu = S.resolveProfile(g2, '30001')
ok('仍走访客+个人合并', pu.cfg.persona.callUser === '王哥' && pu.overrides !== null)
const pa = S.resolveProfile(g2, '10000')
ok('主号仍然是 base（零注入）', pa.overrides === null && pa.isAdmin === true)

console.log('\n[6] 档案里的黑话开关')
const blk = S.profileBlock({ slang: { enabled: false } })
ok('关掉时明确要求别用梗', /别用网络用语和梗/.test(blk), blk.trim())
ok('开启时不出现该句', !/别用网络用语和梗/.test(S.profileBlock({ slang: { enabled: true } })))

console.log('\n[7] 注入上限与体量')
const long = S.profileBlock({
  persona: { name: '小柒', identity: '朋友', style: '很'.repeat(200), tone: '温'.repeat(200), catchphrases: '嗯'.repeat(50) }
})
ok('加了上限后能装更多字', long.length > 200, String(long.length))
ok('仍然有硬上限（不会无限涨）', long.length <= 430, String(long.length))
ok('超长时按行截断而不是切一半', long.endsWith('\n'))

console.log('\n[8] 群配置进 publicConfig（面板要读）')
const pub = S.publicConfig()
ok('对外暴露 groups', pub.groups && typeof pub.groups === 'object')
ok('默认关闭', pub.groups.enabled === false || pub.groups.enabled === undefined)

fs.rmSync(process.env.PANEL_DATA, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
