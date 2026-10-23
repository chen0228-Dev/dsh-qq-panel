/**
 * 引用回复测试（`parseQuoteMark` / `applyQuote` / 合并时的 id 记录 / 与分条的配合）。
 *
 * 这个机制最危险的地方是**和别人打架**：
 * - 带引用段会被 `splitPlan` 判成「不可分条」（原来只认 text/face）；
 * - 合并时只保留最后一条 frame，前面几条的 message_id 直接丢了，模型根本没法指定回哪条；
 * - 序号失效时如果连正文一起丢，用户就收不到回复了。
 * 下面每一组都是照这三件事来的。
 */
import { createProxy, parseQuoteMark, stripQuoteMarks } from '../panel/lib/proxy.js'
import { saveConfig } from '../panel/lib/store.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${extra ? ' — ' + extra : ''}`)
}

saveConfig({
  campus: { enabled: false },
  reply: { quote: { enabled: true, chance: 100 }, assoc: { enabled: false }, opinion: { enabled: false } }
})

const proxy = createProxy(() => {})
const mkItem = (id, text, at) => ({
  at,
  frame: {
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    self_id: 10000,
    message_id: id,
    message: [{ type: 'text', data: { text } }],
    raw_message: text
  }
})
const modelFrame = (text) => ({
  action: 'send_private_msg',
  params: { user_id: 10001, message: [{ type: 'text', data: { text } }] }
})

/* ---------- Q1 标记解析 ---------- */
pass('Q1', '认得出 [[引用 2]]', parseQuoteMark('[[引用 2]] 明天三点')?.n === 2)
pass('Q1b', '空格的写法也认', parseQuoteMark('[[ 引用 2 ]] 明天三点')?.n === 2)
pass('Q1c', '正文里的「引用」不算指令', parseQuoteMark('他引用了一句话说') === null)
pass('Q1d', '只有标记也能解析', parseQuoteMark('[[引用 1]]')?.rest === '')
pass('Q1e', '标记后面的正文保留完整', parseQuoteMark('[[引用 3]] 明天三点上课')?.rest === '明天三点上课')

/* ---------- Q2 合并：记录 id + 给序号 ---------- */
const items = [mkItem('111', '今天好累', 1000), mkItem('222', '明天几点上课', 5000), mkItem('333', '算了', 9000)]
const merged = proxy.mergeFrames(items)
const rec = proxy.quoteMap.get(proxy.outKey(items[2].frame))
pass('Q2', '合并后记下了每条 message_id', rec && rec.ids.join(',') === '111,222,333', JSON.stringify(rec?.ids))
pass('Q2b', '提示里用 [#1] [#2] 标了序号', /\[#1\]/.test(merged.text) && /\[#2\]/.test(merged.text) && /\[#3\]/.test(merged.text))
pass('Q2c', '给了「可以引用」的用法', /\[\[引用 2\]\]/.test(merged.text))
pass('Q2d', '要求先判断是不是同一件事', /是同一件事/.test(merged.text) && /不是同一件事/.test(merged.text))
pass('Q2e', '还是要求判断别写出来', /别写出来/.test(merged.text))

/* ---------- Q3 概率关了就不给引用许可 ---------- */
saveConfig({ reply: { quote: { enabled: true, chance: 0 } } })
const noQuote = proxy.mergeFrames(items)
pass('Q3', 'chance=0 时不提引用用法', !/\[\[引用/.test(noQuote.text))
pass('Q3b', '但仍然给了序号', /\[#1\]/.test(noQuote.text))
saveConfig({ reply: { quote: { enabled: true, chance: 100 } } })

/* ---------- Q4 applyQuote：正常引用 ---------- */
const q4 = proxy.applyQuote(modelFrame('[[引用 2]] 下午三点'))
pass('Q4', '插入了 reply 段', q4.quoted === true && q4.frame.params.message[0].type === 'reply')
pass('Q4b', 'reply 段的 id 是第 2 条', q4.frame.params.message[0].data.id === '222')
pass('Q4c', '正文里没有标记了', q4.frame.params.message[1].data.text === '下午三点')
pass('Q4d', '引用段排在最前面', q4.frame.params.message[0].type === 'reply')
pass('Q4e', '引用段不是文本段（否则会被当正文发出去）', q4.frame.params.message.filter((s) => s.type === 'text').length === 1)

/* ---------- Q5 序号失效：去掉标记也要把话发出去 ---------- */
const q5 = proxy.applyQuote(modelFrame('[[引用 9]] 你说啥'))
pass('Q5', '序号查不到时不引用', q5.quoted === false && q5.dropped === true)
pass('Q5b', '正文照样保留（不能把回复整条吞掉）', q5.frame.params.message[0].data.text === '你说啥')
pass('Q5c', '不会残留标记', !JSON.stringify(q5.frame).includes('[[引用'))

/* ---------- Q6 没有标记就一点都不动 ---------- */
const plainFrame = modelFrame('正常回一句')
const q6 = proxy.applyQuote(plainFrame)
pass('Q6', '没写标记时原样返回', q6.quoted === false && !q6.dropped && q6.frame === plainFrame)

/* ---------- Q7 引用 + 分条：必须能一起工作 ---------- */
const longText = '[[引用 2]] 行 我知道了\n你早点睡吧 别熬了\n明天还要上课呢\n我这边也困了 眼睛都睁不开'
const q7 = proxy.applyQuote(modelFrame(longText))
const plan = proxy.splitPlan(JSON.stringify(q7.frame))
pass('Q7', '带引用的回复仍然能分条', Boolean(plan) && plan.parts.length >= 2, plan ? `${plan.parts.length} 条` : '没能分条')
pass('Q7b', '分条结果里带着引用段', Boolean(plan?.quoteSegs?.length), JSON.stringify(plan?.quoteSegs))
pass('Q7c', '引用段只有一个（只在首条带上）', plan?.quoteSegs?.length === 1)
pass('Q7d', '首条正文里没有标记残留', !/\n?\[\[引用/.test(plan?.parts?.[0] || ''), plan?.parts?.[0] || '')

/* ---------- Q8 只有一条消息时不引用 ---------- */
proxy.quoteMap.clear()
const single = proxy.mergeFrames([mkItem('444', '在吗', 1000)])
const rec8 = proxy.quoteMap.get(proxy.outKey(mkItem('444', 'x', 1).frame))
pass('Q8', '单条合并时不记 id 也不提引用', !/\[\[引用/.test(single.text), rec8 ? `记录了 ${rec8.ids.length} 条` : '没记录')

/* ---------- Q9 过期不引用 ---------- */
proxy.mergeFrames(items)
const key = proxy.outKey(items[2].frame)
const rec9 = proxy.quoteMap.get(key)
rec9.at = Date.now() - 11 * 60_000
const q9 = proxy.applyQuote(modelFrame('[[引用 1]] 过期了'))
pass('Q9', '超过 10 分钟的引用序号作废', q9.quoted === false && q9.dropped === true)
pass('Q9b', '正文还在', q9.frame.params.message[0].data.text === '过期了')

/* ---------- Q10 开关关掉 ------------------ */
saveConfig({ reply: { quote: { enabled: false, chance: 100 } } })
const off = proxy.mergeFrames(items)
pass('Q10', '总开关关掉后不再提引用', !/\[\[引用/.test(off.text))
saveConfig({ reply: { quote: { enabled: true, chance: 60 } } })

/* ---------- Q11 概率大致符合配置 ---------- */
saveConfig({ reply: { quote: { enabled: true, chance: 100 } } })
let quoted = 0
for (let i = 0; i < 200; i++) {
  const m = proxy.mergeFrames(items)
  if (/\[\[引用/.test(m.text)) quoted++
}
const rate = (quoted / 200) * 100
pass('Q11', 'chance=100 时每次都给许可', rate === 100, `实测 ${rate}%`)
saveConfig({ reply: { quote: { enabled: true, chance: 0 } } })
let q0 = 0
for (let i = 0; i < 100; i++) if (/\[\[引用/.test(proxy.mergeFrames(items).text)) q0++
pass('Q11b', 'chance=0 时一次都不给', q0 === 0, `实测 ${q0}/100`)

/* ---------- Q12 一条回复里写了两个标记（2026-10-23 线上漏出 [[引用 1]]） ----------
 * 她的真实写法：段首一个用来引用，正文中间又写一个指向另一条。
 * 之前只剥段首那个，中间的原样发到聊天里，对方看到「[[引用 1]]」字样。
 * 下面这几条就是那次的回归测试。
 */
saveConfig({ reply: { quote: { enabled: true, chance: 100 } } })
proxy.quoteMap.clear()
proxy.mergeFrames(items)

pass('Q12', 'stripQuoteMarks 清掉正文中间的标记', stripQuoteMarks('那你去忙 [[引用 1]]记得别马上躺').count === 1)
pass('Q12a', '清完只剩正文', stripQuoteMarks('那你去忙 [[引用 1]]记得别马上躺').text === '那你去忙 记得别马上躺')
pass('Q12b', '无空格写法也认', stripQuoteMarks('A[[引用1]]B').text === 'AB')
pass('Q12c', '「第 N 条」变体也认', stripQuoteMarks('A[[引用第2条]]B').text === 'AB')
pass('Q12d', '普通「引用」二字不动', stripQuoteMarks('他引用了一句话').count === 0)

const two = proxy.applyQuote(modelFrame('[[引用 2]]那你去忙 [[引用 1]]记得别马上躺'))
const twoText = JSON.stringify(two.frame)
pass('Q13', '段首标记仍然变成真引用', two.quoted === true && two.frame.params.message[0].data.id === '222')
pass('Q13b', '正文里的第二个标记被剥掉', !twoText.includes('[[引用'), two.frame.params.message[1]?.data?.text)
pass('Q13c', '剥离后正文完整', two.frame.params.message[1]?.data?.text === '那你去忙 记得别马上躺')
pass('Q13d', '计数能对上（2 个标记都处理了）', two.removed === 2, String(two.removed))

const onlyMid = proxy.applyQuote(modelFrame('行 那我等你 [[引用 1]]我自己翻翻东西'))
pass('Q14', '只有中间标记时不硬造引用', onlyMid.quoted === false)
pass('Q14b', '但仍然要剥掉，不能发给对方', !JSON.stringify(onlyMid.frame).includes('[[引用'))
pass('Q14c', '原因为 extra（便于日志区分）', onlyMid.reason === 'extra' && onlyMid.dropped === true)
pass('Q14d', '正文保留', onlyMid.frame.params.message[0].data.text === '行 那我等你 我自己翻翻东西')

// 只有标记、没有正文：整条丢掉，不能发一条空消息
const markOnly = proxy.applyQuote(modelFrame('[[引用 1]]'))
pass('Q15', '只剩标记时整条不发', !markOnly.frame.params.message.length, JSON.stringify(markOnly.frame.params.message))

// 恢复共享配置
saveConfig({ campus: { enabled: true }, reply: { quote: { enabled: true, chance: 60 } } })

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
