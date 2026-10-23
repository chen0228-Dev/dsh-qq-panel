// C 组：代理层单测（不产生会话、不占记忆）
import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'
import { loadConfig, resolveProfile, profileBlock, whitelistVerdict } from '/opt/qqbot/panel/lib/store.js'

const cfg = loadConfig()
const p = createProxy(() => {})
const mk = (t, uid = 10001) =>
  JSON.stringify({ action: 'send_private_msg', params: { user_id: uid, message: [{ type: 'text', data: { text: t } }] } })
const pass = (id, desc, ok, extra = '') => console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)

// C1 拆条
const samples = {
  '18字': '行 我知道了 你早点睡吧',
  '48字': '行 我知道了\n你早点睡吧 别熬了\n明天还要上课呢\n我这边也困了 眼睛都睁不开',
  '120字': '今天下午那个会开得我脑壳疼 讲了两小时啥也没定 领导在那绕来绕去 我在底下偷偷刷手机 结果被点名问意见 我说都挺好 其实心里想的是赶紧散会 散会之后又被拉去改方案 改到六点半才走 路上还下雨 伞也没带 到家鞋全湿了'
}
const maxN = cfg.reply.split.maxParts
for (const [label, text] of Object.entries(samples)) {
  const counts = []
  for (let i = 0; i < 6; i++) {
    const plan = p.splitPlan(mk(text))
    counts.push(plan ? plan.parts.length : 1)
  }
  const ok = counts.every((c) => c <= maxN)
  pass('C1', `拆条 ${label}`, ok, `条数样本 ${counts.join(',')} (max=${maxN})`)
}

// C2 序号剥离
const c2 = p.splitPlan(mk('1.欸 你现在上课了吧十点一刻那节\n2.我这边正琢磨那个蓝色小人\n3.该叫啥'))
const joined = (c2 ? c2.parts : []).join('')
pass('C2', '序号剥离', !/\b1\.|\b2\.|①/.test(joined), JSON.stringify(c2 ? c2.parts : []))

// C3 去重
const f = { params: { user_id: 10001 }, message_type: 'private' }
const t3 = '我这边正琢磨那个蓝色小人要是真有个名字'
const first = p.isDuplicate(f, t3, 600000)
const second = p.isDuplicate(f, t3, 600000)
pass('C3', '重复回复拦截', first === false && second === true, `first=${first} second=${second}`)

// C4 候选排序
const dir = cfg.paths.stickers
const cases = [
  ['我今天好累啊 一点力气都没有', '摆烂'],
  ['气死我了 你根本不理我', '生气'],
  ['嘿嘿 我考过了', '得意'],
  ['算了 随便吧 没辙', '无奈']
]
for (const [q, want] of cases) {
  /**
   * 只看第 1 名会 flaky：`stickerCandidates` 里有「2 小时内发过就 ×0.4 打折」的规则，
   * 同名情绪的几张图谁最近发过谁就被压下去。2026-10-22 就因为测试时刚用过
   * 「微笑_可爱」，2 小时内它被打折、用例通过；过了 2 小时不打折，它翻到第一，用例又挂。
   * 被测行为是「候选里应该有对味的图」，不是「必须精确排第一」，所以看前 3。
   */
  const top3 = p.stickerCandidates(dir, q, 3)
  const hit = top3.find((x) => String(x.n).includes(want))
  pass('C4', `候选「${q}」前 3 含 ${want}`, Boolean(hit),
    `实际 ${top3.map((x) => x.n + '(' + x.score.toFixed(2) + ')').join(' ') || 'none'}`)
}

// C5 语音催促节奏（autoRate=30 → 每 7 条）
const f2 = { user_id: 10001, message_type: 'private', message: [{ type: 'text', data: { text: '在吗' } }] }
const hits = []
for (let i = 1; i <= 10; i++) if (p.voiceNudge(cfg, f2)) hits.push(i)
const expectN = Math.max(2, Math.round(200 / (cfg.voice.autoRate || 1)))
pass('C5', '语音催促节奏', hits.length > 0 && hits[0] === expectN, `提醒于 ${hits.join(',')}（期望首条=${expectN}）`)

// C6 按人 profile
const prof = cfg.profiles || {}
const uid = (prof.users && prof.users[0] && prof.users[0].qq) || '123456'
const r = resolveProfile(cfg, uid)
const blk = profileBlock(r.overrides)
pass('C6', '按人注入块', !r.overrides || (blk.length > 0 && blk.length < 400), `${r.label} / ${blk.length} 字`)
const admin = resolveProfile(cfg, cfg.qq.adminQQ)
pass('C6b', '主号不注入', admin.overrides === null)

// C7 白名单
const v = whitelistVerdict(cfg, '100000001', false)
const v2 = whitelistVerdict(cfg, cfg.qq.adminQQ, false)
pass('C7', '白名单拦截', v.pass === false && v2.pass === true, `外部=${v.pass} 主号=${v2.pass}`)
