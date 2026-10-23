/**
 * 连发合并 smart 模式 —— 判断「这句说完了没」
 *
 * 背景：原来是固定窗口（coalesceMs=2300），不管你发「我今天去」还是
 * 「今天真倒霉。」都等同样久。改成 smart 后按内容判断：
 *   看起来说完了 → 800ms 就回
 *   明显没说完   → 等后续，最多 5000ms
 *
 * 为什么不用大模型判断：模型是 reasoningEffort=high（全局配置，不能按请求降），
 * 判断一次 3~5 秒，5 秒上限几乎必满，比固定窗口还慢，成本还翻倍。
 *
 * 判错的代价不对称：
 *   · 「没说完」判成「说完了」→ 抢话，很尴尬
 *   · 「说完了」判成「没说完」→ 多等几秒，有 5s 上限兜着，不致命
 * 所以规则整体偏向「别抢话」，但**常见短应答绝不能掉进等待里**。
 */

import { looksIncomplete, smartWindowMs } from '../panel/lib/pacing.js'

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

const CFG = { reply: { coalesceSmartMinMs: 800, coalesceSmartMaxMs: 5000 } }

console.log('[1] 明显说完了 → 应该快回（800ms）\n')
const done = [
  ['句号结尾', '今天真倒霉。'],
  ['问号结尾', '你觉得呢？'],
  ['感叹号结尾', '太爽了！'],
  ['省略号结尾', '算了…'],
  ['波浪号结尾', '好呀~'],
  ['正常完整句', '我今天去打球了'],
  ['带标点的长句', '下午在体育馆打了两个小时，累死了。'],
  ['短应答', '好的'],
  ['单字应答', '行'],
  ['嗯嗯', '嗯嗯'],
  ['笑声', '哈哈哈'],
  ['666', '666'],
  ['英文 ok', 'ok'],
  ['完整应答「是的」', '是的'],
  ['我知道的（虚词结尾但够长）', '这个我知道的'],
]
for (const [name, text] of done) {
  ok(name, looksIncomplete(text) === false, `"${text}" 被误判成没说完`)
}

console.log('\n[2] 明显没说完 → 应该等（5000ms）\n')
const incomplete = [
  ['逗号结尾', '我今天去，'],
  ['顿号结尾', '买了苹果、'],
  ['分号结尾', '因为这样；'],
  ['连接词「然后」', '然后'],
  ['连接词「因为」', '因为'],
  ['连接词「所以」', '所以'],
  ['连接词「而且」', '而且'],
  ['悬空「我觉得」', '我觉得'],
  ['悬空「这个」', '这个'],
  ['悬空「感觉」', '感觉'],
  ['两个字的半句', '我刚'],
  ['一个字的半句', '我'],
]
for (const [name, text] of incomplete) {
  ok(name, looksIncomplete(text) === true, `"${text}" 被判成说完了`)
}

console.log('\n[3] 边界与容错\n')
ok('空字符串（纯图片/表情）放行', looksIncomplete('') === false)
ok('null 放行', looksIncomplete(null) === false)
ok('undefined 放行', looksIncomplete(undefined) === false)
ok('纯空格放行', looksIncomplete('   ') === false)
ok('首尾空格不影响判断（"然后 "）', looksIncomplete('  然后  ') === true)

console.log('\n[4] 等待时长换算\n')
ok('说完 → minMs(800)', smartWindowMs(CFG, '今天真倒霉。') === 800)
ok('没说完 → maxMs(5000)', smartWindowMs(CFG, '我今天去，') === 5000)
ok('配置改了跟着变（说完）', smartWindowMs({ reply: { coalesceSmartMinMs: 1200 } }, '好的') === 1200)
ok('配置改了跟着变（没说完）', smartWindowMs({ reply: { coalesceSmartMaxMs: 7000 } }, '然后') === 7000)
ok('没配时用默认 800/5000', smartWindowMs({}, '好的') === 800 && smartWindowMs({}, '然后') === 5000)
ok('min 大于 max 时以 min 为准（不会出现负数或 0 等待）', (() => {
  const v = smartWindowMs({ reply: { coalesceSmartMinMs: 6000, coalesceSmartMaxMs: 1000 } }, '然后')
  return v >= 6000
})())

console.log('\n[5] 真实场景（用户常发的几种）\n')
const real = [
  ['连发第一句（带逗号）', '我跟你说，', true],
  ['连发第二句（完整）', '今天组里来了个新人', false],
  ['连发第三句（带句号）', '特别有意思。', false],
  ['随口一个「嗯」', '嗯', false],
  ['吐槽完整', '这破代码又崩了，服了', false],
]
for (const [name, text, expectIncomplete] of real) {
  ok(name, looksIncomplete(text) === expectIncomplete, `"${text}"`)
}

console.log('\n[6] 已知局限（行为如此，不是 bug）\n')
ok('「我刚想说」会被当说完 —— 启发式认不出动词，宁可不为此拖慢所有正常短句',
   looksIncomplete('我刚想说') === false)
ok('「我不想去」也是说完（如果按动词判就会误伤这种完整应答）',
   looksIncomplete('我不想去') === false)

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
