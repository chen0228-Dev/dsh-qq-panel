// 主动消息专项测试（不产生真实会话、不占记忆）
// 跑法见 tests/test-plan.md：拷到隔离目录 + 假 ws + 临时 config 后 node 执行
import { createProactive, pickTopic } from '../panel/lib/proactive.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- P1 时段过滤：凌晨不该出现「热点/梗」 ---------- */
const night = pickTopic({ hot: 10 }, 2)
pass('P1', '凌晨 2 点不选热点类', night !== 'hot', `实际 ${night}`)

const noon = Array.from({ length: 60 }, () => pickTopic({ hot: 10 }, 12))
const hotRatio = noon.filter((x) => x === 'hot').length / 60
pass('P1b', '中午 12 点热点类占优', hotRatio > 0.8, `占比 ${(hotRatio * 100).toFixed(0)}%`)

/* ---------- P2 连续同类降权 ---------- */
// 样本要够大：160 次时 50% 的期望值抖动能到 60%，看着像没降权
const N = 400
const rep = Array.from({ length: N }, () => pickTopic({ complain: 10, daily: 2 }, 12, ['complain']))
const complainRatio = rep.filter((x) => x === 'complain').length / N
// 原始权重 10:2（约 83%），降权到 1/5 后应该接近 50%
pass('P2', '上一条已是同类时被降权', complainRatio < 0.6, `仍是发牢骚 ${(complainRatio * 100).toFixed(0)}%（未降权时约 83%）`)

/* ---------- P3 权重全 0 时兜底 ---------- */
pass('P3', '权重全 0 有兜底', typeof pickTopic({}, 12) === 'string', `实际 ${pickTopic({}, 12)}`)

/* ---------- 走 triggerNow 验证完整注入文本 ---------- */
const sent = []
const proxy = {
  lastUserAt: 0,
  status: () => ({ napcat: true, dsh: true, botQQ: '10000' }),
  injectPrivateMessage: (t) => sent.push(t),
  setUserActivityHook: (fn) => {
    proxy.hook = fn
  }
}
const p = createProactive(proxy, () => {})

const r1 = p.triggerNow('hot')
const t1 = sent[sent.length - 1] || ''
pass('P4', '热点类注入带联网提示', /qq-search/.test(t1), `topic=${r1.topic}`)
pass('P4b', '热点类注入有素材碎片', (t1.match(/^ {2}· /gm) || []).length >= 2, `素材 ${(t1.match(/^ {2}· /gm) || []).length} 条`)

const r2 = p.triggerNow('bored')
const t2 = sent[sent.length - 1] || ''
pass('P5', '闲得慌允许只发图', /只丢一张表情包/.test(t2), `topic=${r2.topic}`)

const r3 = p.triggerNow('complain')
const t3 = sent[sent.length - 1] || ''
pass('P6', '不给它指定具体句子', !/抱怨一下今天的小倒霉事/.test(t3))
pass('P6b', '仍然禁止列清单/提提示', /别列清单/.test(t3) && /不要提到这条提示/.test(t3))
pass('P6c', '要求它先自己想', /先自己想/.test(t3))

// 连续手动触发多次，确认素材不重复
const seen = new Set()
for (let i = 0; i < 6; i++) {
  p.triggerNow('daily')
  const t = sent[sent.length - 1]
  for (const m of t.match(/^ {2}· (.+)$/gm) || []) seen.add(m)
}
pass('P7', '多次触发素材有变化', seen.size >= 8, `6 次共出现 ${seen.size} 条不同素材`)

// 活跃时段钩子：start() 里注册，收到消息就记一笔到当前小时
p.start()
p.stop()
const hr = new Date().getHours()
const before = (p.info().state.hours || [])[hr] || 0
if (proxy.hook) proxy.hook()
const after = (p.info().state.hours || [])[hr] || 0
pass('P8', '收到消息会记录活跃时段', Boolean(proxy.hook) && after === before + 1, `hours[${hr}] ${before} → ${after}`)

// 手动试不消耗联网额度 / 不改「说过了」记录
const info = p.info()
pass('P9', '手动试不扣联网额度', (info.state.hotUsed || 0) === 0, `hotUsed=${info.state.hotUsed}`)
pass('P9b', 'info 暴露 10 类话题（含续聊）', Object.keys(info.topics || {}).length === 10, `实际 ${Object.keys(info.topics || {}).length} 类`)

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
