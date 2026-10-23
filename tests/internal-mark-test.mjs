/**
 * 内部标记不能泄漏到聊天里 —— 回归测试
 *
 * 事故：2026-10-23 20:22 前后，「研究含义」任务返回 2000+ 字的释义 JSON，
 * 走 dsh-onebot 插件的 outbound 时超过 textImageThreshold（默认 150），
 * 被渲染成一张标题为「To <昵称>」的图片卡片发给了用户。
 *
 * 三层防线，任何一层失效都会漏：
 *   ① 插件 outbound：含内部标记的文本不做 t2i（否则面板拿不到 text，后面全白搭）
 *   ② 面板 proxy：能解析就吞（parseConvState / parseLearnReceipt / parseMeaningReceipt）
 *   ③ 面板 proxy 兜底：解析失败也吞 —— **不看位置**，出现即丢弃
 *
 * 这个测试只验 ①③ 两处的判断逻辑（② 是纯函数，另有测试覆盖）。
 */

const INTERNAL_MARK = /\[\[\s*(学词|释义|对话状态)\s*\]\]/
const PLUGIN_SKIP_T2I = /\[\[\s*(生词|学词|释义|对话状态)/

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

console.log('[1] 插件层：这些文本不能渲染成图片卡片\n')
const t2iCases = [
  ['纯释义回执（本次事故原文形态）', '[[释义]] [{"word":"不烧心","meaning":"2026年短剧梗","confirmed":true}]', true],
  ['释义前面多了引导语', '好的，我查到了：\n[[释义]] [{"word":"a"}]', true],
  ['学词回执', '[[学词]] {"words":["yyds","绝绝子"]}', true],
  ['对话状态回执', '[[对话状态]] {"ended":false,"mood":"normal"}', true],
  ['生词标记（行内）', '今天听了个词 [[生词：yyds|绝绝子]] 挺有意思', true],
  ['标记被截断没闭合', '[[释义]] [{"word":"a","mean', true],
  ['普通长回复（应该照常转图）', '今天天气不错'.repeat(40), false],
  ['含普通方括号（不该误判）', '我看了[[一本好书]]，推荐给你'.repeat(10), false],
]
for (const [name, text, expectSkip] of t2iCases) {
  const got = PLUGIN_SKIP_T2I.test(text)
  ok(name, got === expectSkip, `期望 ${expectSkip ? '跳过转图' : '照常转图'}，实际 ${got ? '跳过' : '转图'}`)
}

console.log('\n[2] 面板兜底：解析失败也要吞（不看位置）\n')
const dropCases = [
  ['纯标记', '[[释义]] [{"word":"a"}]', true],
  ['前面有引导语', '好的我查到了：\n[[释义]] [{"word":"a"}]', true],
  ['JSON 坏掉', '[[释义]] [{word:a,', true],
  ['学词回执坏了', '[[学词]] {"words":', true],
  ['对话状态坏了（原来没兜底，会漏）', '[[对话状态]] {"ended":', true],
  ['对话状态正常', '[[对话状态]] {"ended":true}', true],
  ['正常聊天', '今天好累啊，早点睡吧', false],
  ['普通方括号', '我看了[[一本好书]]', false],
  ['正文里提到"释义"两个字', '这个词的释义是「永远的神」', false],
]
for (const [name, text, expectDrop] of dropCases) {
  const got = INTERNAL_MARK.test(text)
  ok(name, got === expectDrop, `期望 ${expectDrop ? '丢弃' : '正常发送'}，实际 ${got ? '丢弃' : '发送'}`)
}

console.log('\n[3] 真实事故原文（应被插件跳过 t2i、被面板丢弃）\n')
const incident = '[[释义]] [{"word":"不烧心","meaning":"2026年爆火的短剧台词梗，本指吃了不反胃，引申为「东西贵但值、让人安心」","usage":"评价某样东西虽然贵但品质靠谱时","example":"贵是贵点，但吃了不烧心","confirmed":true},{"word":"奶蛙","meaning":"2026年爆火的网络梗","confirmed":true}]'
ok('插件不做卡片', PLUGIN_SKIP_T2I.test(incident) === true)
ok('面板整条丢弃', INTERNAL_MARK.test(incident) === true)
ok('长度确实超过默认阈值 150', incident.length > 150, `实际 ${incident.length} 字`)

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
