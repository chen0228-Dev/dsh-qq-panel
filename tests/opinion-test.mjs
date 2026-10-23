/**
 * 独立观点测试（`opinionLine` / `matchStances` / `isAskingOpinion`）。
 *
 * 这个机制的两条命门：
 * 1. **立场必须一致** —— 今天说讨厌香菜、明天说香菜好吃，比没有立场更假；
 * 2. **有些话题必须不表态** —— 政治、民族、宗教、领土，一条都不能碰。
 * 剩下才是「别说各有优劣」这种风格问题。
 */
import { opinionLine, matchStances, isAskingOpinion, opinionInfo, resetOpinions } from '../panel/lib/opinion.js'
import { saveConfig } from '../panel/lib/store.js'
import { createProxy } from '../panel/lib/proxy.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${extra ? ' — ' + extra : ''}`)
}

const cfgOf = (o = {}) => ({ reply: { opinion: { enabled: true, chance: 100, ...o } } })
const run = (text, o = {}) => opinionLine(cfgOf(o), { text }) || ''

/* ---------- O1 开关 ---------- */
resetOpinions()
pass('O1', '总开关关掉就不表态', run('你觉得香菜怎么样', { enabled: false }) === '')
pass('O1b', '概率 0 就不表态', run('你觉得香菜怎么样', { chance: 0 }) === '')

/* ---------- O2 提示文本 ---------- */
resetOpinions()
const t = run('你觉得香菜怎么样')
pass('O2', '被问看法时给出表态许可', t.length > 0)
pass('O2b', '至少给了态度或理由的方向', /态度|结论/.test(t), '')
pass('O2c', '明确禁掉和稀泥的词', /各有优劣/.test(t) && /取决于/.test(t) && /因人而异/.test(t))
pass('O2d', '允许不同意对方', /可以不同意他/.test(t))
pass('O2e', '标了「内部提示，别解释」', /内部提示/.test(t))
pass('O2f', '不许说教或人身攻击', /别说教/.test(t) && /讽刺/.test(t))

/* ---------- O3 命中固定立场 ---------- */
resetOpinions()
const c = run('香菜这东西你能接受吗，你觉得呢')
pass('O3', '说香菜会取到「香菜」这条立场', /香菜是灾难/.test(c), c.match(/\*\*.+\*\*/)?.[0] || '')
resetOpinions()
const g = run('你觉得小组作业怎么样')
pass('O3b', '说小组作业会取到「小组作业」这条', /小组作业就是骗局/.test(g))

/* ---------- O4 立场必须一致 ---------- */
resetOpinions()
const takes = new Set()
for (let i = 0; i < 8; i++) {
  const r = run('你觉得香菜怎么样')
  const m = /\*\*(.+?)\*\*/.exec(r)
  if (m) takes.add(m[1])
}
pass('O4', '同一件事 8 次表态，立场完全一致', takes.size === 1, `出现了 ${takes.size} 种：${[...takes].join(' / ')}`)

/* ---------- O5 边界话题：一条都不能碰 ---------- */
const blocked = [
  ['你怎么看两岸关系', '两岸'],
  ['你觉得宗教应该怎么管', '宗教'],
  ['你怎么看民族政策', '民族'],
  ['你觉得现在的体制怎么样', '体制'],
  ['你怎么看这场战争', '战争'],
  ['你觉得政府该不该这样做', '政府']
]
for (const [text, why] of blocked) {
  resetOpinions()
  pass('O5', `不表态：${why}`, run(text) === '', JSON.stringify(text))
}
pass('O5b', 'matchStances 对边界话题返回空', matchStances('你怎么看两岸关系').length === 0)

/* ---------- O6 不是在问看法、也没命中立场 → 不注入 ---------- */
resetOpinions()
pass('O6', '普通陈述不触发', run('今天下午三点开会') === '')
pass('O6b', '问事实不算问看法', isAskingOpinion('明天几点上课') === false)
pass('O6c', '「你觉得」算问看法', isAskingOpinion('你觉得这个怎么样') === true)

/* ---------- O7 命中立场但没被问 → 概率收敛 ---------- */
let hits = 0
for (let i = 0; i < 300; i++) {
  resetOpinions()
  if (run('香菜真的吃不下去', { chance: 100 })) hits++
}
const rate = (hits / 300) * 100
// chance=100 时「没被问」的系数是 0.45，期望约 45%
pass('O7', '没被问时也冒观点，但频率收敛', rate >= 30 && rate <= 60, `实测 ${rate.toFixed(0)}%`)

/* ---------- O8 记录 ---------- */
resetOpinions()
run('你觉得奶茶几分糖好')
const info = opinionInfo()
pass('O8', '记下最近一次表态', info.last && String(info.last.take || '').length > 0, JSON.stringify(info.last))
pass('O8b', '面板能拿到立场清单', Array.isArray(info.stances) && info.stances.length >= 10, `${info.stances?.length || 0} 条`)

/* ---------- O9 素材不能开地图炮 ---------- */
const allTakes = opinionInfo().stances.map((s) => s.take).join(' ')
const slur = /(女人|男人|河南|东北|上海人|外地人|农村人|胖子|丑|学历低)/
pass('O9', '立场里没有地域/性别/外貌的攻击', !slur.test(allTakes), (allTakes.match(slur) || [''])[0])

/* ---------- O10 接线：表态优先于联想，只注入一段 ---------- */
resetOpinions()
saveConfig({
  campus: { enabled: false },
  reply: {
    speed: 1,
    assoc: { enabled: true, chance: 100 },
    opinion: { enabled: true, chance: 100 }
  }
})
const proxy = createProxy(() => {})
const captured = []
proxy.upstream = { readyState: 1, send: (x) => captured.push(String(x)) }
// 「早八」两边都有：观点库里有「早八是反人类的安排」，联想池里也有「早八上完趴桌上睡」
const frame = {
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  self_id: 10000,
  message: [{ type: 'text', data: { text: '你觉得早八怎么样' } }],
  raw_message: '你觉得早八怎么样'
}
proxy.dispatch(JSON.stringify(frame), frame)
await new Promise((r) => setTimeout(r, 300))
const sent = captured.join('\n')
pass('O10', 'dispatch 里注入了表态提示', /这条要表态/.test(sent))
pass('O10b', '同时命中时不再叠加联想提示', !/这条可以不只接话/.test(sent))
pass('O10c', '原消息没丢', sent.includes('你觉得早八怎么样'))

/* ---------- O11 关掉之后不注入 ---------- */
resetOpinions()
saveConfig({ reply: { opinion: { enabled: false }, assoc: { enabled: false } } })
const p2 = createProxy(() => {})
const cap2 = []
p2.upstream = { readyState: 1, send: (x) => cap2.push(String(x)) }
p2.dispatch(JSON.stringify(frame), frame)
await new Promise((r) => setTimeout(r, 300))
pass('O11', '关掉后 dispatch 不注入任何提示', !/这条要表态/.test(cap2.join('\n')))

// 干净收尾：把共享配置恢复（其他测试还要用）
saveConfig({ campus: { enabled: true }, reply: { assoc: { enabled: true, chance: 30 }, opinion: { enabled: true, chance: 70 } } })

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
