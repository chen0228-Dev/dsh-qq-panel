/**
 * 状态机关闭后的「随时在线」+ 说话的味道（反问率 / 允许走）—— 回归测试
 *
 * 2026-10-24 修的两类问题：
 *
 * 一、关掉状态机后仍然「按钟点」变慢
 *    campus.enabled=false → campusState 返回 {line:'', busy:0}，状态描述确实不注入了，
 *    但 planPace 里的 nightSlow（0–7 点强制抬档）跟状态机无关，照样生效。
 *    面板文案还写着「关掉就退回按钟点给状态」——这句早就不成立了，纯误导。
 *    改法：状态机关闭时整套分档（instantRate/mix/nightSlow/busy）全部跳过，
 *    改成按字数估的打字延迟 0.8–3 秒。
 *
 * 二、反问率和「允许走」被活人味连带关掉，且 0 档会被抵消
 *    原来这两段写在 if (human > 0) 里面，活人味=0 就整段消失；
 *    而 human≥55/80 档里又无条件写「反问一句」，把 askBack=0 冲掉。
 *    改法：两段提到活人味外面独立判断；活人味里那两句按 askBack 决定加不加；
 *    askBack=0 时额外写一段明确的「别反问」。
 */

import { renderPersona } from '../panel/lib/store.js'
import { planPace } from '../panel/lib/pacing.js'

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

// 注意 persona.enabled 必须显式给 true —— renderPersona 第一行就是
// `if (!p.enabled) return '# 人格设定已关闭'`，漏了它整段渲染直接早退，
// 测出来的「反问段消失」全是假象。
//
// `...o` 必须放最前面：放最后会把 o.persona 整个对象覆盖上来，
// 只有 human/askBack 的 persona 会把 enabled 一起冲掉。
const mk = (o = {}) => ({
  ...o,
  persona: { enabled: true, human: 60, askBack: 30, canLeave: true, swear: 2, ...(o.persona || {}) },
  campus: { enabled: true, ...(o.campus || {}) },
  reply: { ...(o.reply || {}) },
  // renderPersona 末尾会写「你的长期记忆在 <workspace>/AGENTS.local.md」，
  // 少这个字段会把整个渲染炸掉（不是返回空，是抛异常）
  paths: { workspace: '/tmp/qq-test-workspace', stickers: '/tmp/qq-test-stickers', ...(o.paths || {}) }
})
const render = (cfg) => renderPersona(cfg, '')

/* ---------------- 一、状态机关闭 = 随时在线 ---------------- */
console.log('[1] 状态机关闭后：不再按钟点，改成打字延迟\n')

const offCfg = mk({ campus: { enabled: false } })
for (const hour of [3, 9, 14, 23]) {
  const r = planPace(offCfg, { chars: 10, hour })
  ok(`${hour} 点：延迟落在打字区间（300–3400ms）`, r.delayMs >= 300 && r.delayMs <= 3400, `实际 ${r.delayMs}ms`)
  ok(`${hour} 点：band 是 typing`, r.band === 'typing', `实际 ${r.band}`)
}

console.log('\n[2] 同一时刻，状态机开着 vs 关着 的差异\n')
{
  const on = planPace(mk({ campus: { enabled: true } }), { chars: 10, hour: 3, busy: 3, chatting: false })
  const off = planPace(offCfg, { chars: 10, hour: 3 })
  ok('凌晨3点+睡着了：开着会拖很久（>8分钟）', on.delayMs > 480_000, `实际 ${on.delayMs}ms`)
  ok('凌晨3点：关掉后仍是打字级（<3.4秒）', off.delayMs < 3400, `实际 ${off.delayMs}ms`)
  ok('关掉后确实不受 hour 影响', Math.abs(planPace(offCfg, { chars: 10, hour: 3 }).delayMs - planPace(offCfg, { chars: 10, hour: 15 }).delayMs) < 1500)
}

console.log('\n[3] 打字延迟随字数增长，但有上下限\n')
{
  const short = planPace(offCfg, { chars: 2, hour: 12 }).delayMs
  const mid = planPace(offCfg, { chars: 15, hour: 12 }).delayMs
  const long = planPace(offCfg, { chars: 200, hour: 12 }).delayMs
  ok('两个字的短句 ~1 秒上下', short >= 300 && short <= 1400, `实际 ${short}`)
  ok('15 字比 2 字慢', mid > short, `${mid} vs ${short}`)
  ok('超长句封顶 3.4 秒内', long <= 3400, `实际 ${long}`)
  ok('没传 chars 也不炸', planPace(offCfg, { hour: 12 }).delayMs > 0)
}

console.log('\n[4] 「生活节奏」总开关仍然优先\n')
{
  const r = planPace({ campus: { enabled: false }, reply: { pace: { enabled: false } } }, { chars: 10, hour: 12 })
  ok('pace 显式关掉 → 0 延迟（尊重那个语义）', r.delayMs === 0, `实际 ${r.delayMs}`)
}

/* ---------------- 二、反问率 / 允许走 独立 ---------------- */
console.log('\n[5] 活人味 = 0 不再连带关掉反问率和「允许走」\n')
{
  const t = render(mk({ persona: { human: 0, askBack: 80, canLeave: true } }))
  ok('反问段还在', t.includes('## 别只会答，也要问'), '整段消失')
  ok('「你也可以走」还在', t.includes('## 你也可以走'), '整段消失')
  ok('活人味段确实没了', !t.includes('## 说话要像个真人'))
}

console.log('\n[6] 反问率 = 0 是真的不反问（不被活人味抵消）\n')
for (const human of [30, 60, 90]) {
  const t = render(mk({ persona: { human, askBack: 0 } }))
  const bad = t.includes('反问一句') || t.includes('干脆反问回去') || t.includes('## 别只会答，也要问')
  ok(`活人味=${human} + 反问率=0：提示词里没有教她反问的句子`, !bad, '仍有残留')
  ok(`活人味=${human} + 反问率=0：有明确的「别反问」段`, t.includes('## 别反问'))
}

console.log('\n[7] 反问率分档与面板标签对齐（0 / 1-33 / 34-66 / 67-100）\n')
{
  const seg = (n) => {
    const t = render(mk({ persona: { askBack: n } }))
    if (t.includes('## 别反问')) return 'off'
    if (t.includes('偶尔才有必要问一句')) return 'low'
    if (t.includes('抛个问题回去')) return 'mid'
    if (t.includes('话多的人')) return 'high'
    return '?'
  }
  ok('0 → off', seg(0) === 'off', seg(0))
  ok('1 → low', seg(1) === 'low', seg(1))
  ok('33 → low（边界）', seg(33) === 'low', seg(33))
  ok('34 → mid（边界）', seg(34) === 'mid', seg(34))
  ok('66 → mid（边界）', seg(66) === 'mid', seg(66))
  ok('67 → high（边界）', seg(67) === 'high', seg(67))
  ok('100 → high', seg(100) === 'high', seg(100))
}

console.log('\n[8] 「允许走」可以单独关掉\n')
{
  const t = render(mk({ persona: { canLeave: false } }))
  ok('关掉后没有「你也可以走」段', !t.includes('## 你也可以走'))
  const t2 = render(mk({ persona: { canLeave: true } }))
  ok('开着时有', t2.includes('## 你也可以走'))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
