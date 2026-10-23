/**
 * 火山语音「情感」的真相：emotion 字段对官方 2.0 音色无效，要用 context_texts 指令
 *
 * 用户报「发语音没配上根据文本判断的情感」。排查发现两层问题：
 *
 *   1. 配置里 emotion 是空字符串 —— 面板压根没选情感。
 *   2. 代码 `if (v.emotion) reqParams.emotion = v.emotion` 把 emotion 放在 req_params 顶层。
 *      实测这一层对官方 2.0 音色几乎无效，正确机制是 context_texts 语音指令。
 *
 * 实测数据（2026-10-23，真实凭据，同一句「我真的很想你…」）：
 *
 *   官方 Vivi 2.0（seed-tts-2.0）：
 *     基线                    38637 B
 *     audio_params.emotion=sad 38637 B   ← 没变化
 *     顶层 emotion=sad         41901 B   ← +8%，基本是抖动
 *     context_texts 难过        48237 B   ← +25%，真生效
 *     context_texts 撒娇        44973 B   ← +16%
 *
 *   复刻 S_xxx（seed-icl-2.0）：
 *     基线                      66285 B
 *     context_texts 难过         82797 B   ← +25%
 *
 * 结论：官方 2.0 音色是「指令遵循」型（音色列表支持能力那栏全是「指令遵循」），
 * 情感靠 context_texts，不靠 emotion 字段。
 *
 * 本测试只做源码级 + 逻辑级断言，不真调 API（那是收费的，且实测结论已经拿到）。
 */

import fs from 'node:fs'
import { EMOTION_INSTRUCTIONS } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- V1 映射表自洽 ---------- */
const keys = Object.keys(EMOTION_INSTRUCTIONS)
pass('V1a', '覆盖 6 种情感', keys.length === 6, keys.join(','))
pass('V1b', '每种都是非空中文指令', keys.every((k) => typeof EMOTION_INSTRUCTIONS[k] === 'string' && EMOTION_INSTRUCTIONS[k].includes('语气')))
pass('V1c', '指令是「用 XX 的语气说」句式', keys.every((k) => /语气说/.test(EMOTION_INSTRUCTIONS[k])))

/* ---------- V2 面板下拉与映射对账 ---------- */
const html = fs.readFileSync(new URL('../panel/public/index.html', import.meta.url), 'utf8')
const emoBlock = html.slice(html.indexOf('id="v-emotion"'), html.indexOf('</select>', html.indexOf('id="v-emotion"')))
const optionVals = [...emoBlock.matchAll(/<option value="([^"]*)"[^>]*>/g)].map((m) => m[1])
pass('V2a', '面板情感选项 = 空 + 6 个', optionVals.length === 7 && optionVals[0] === '', optionVals.join(','))
pass('V2b', '面板非空选项与映射键完全一致',
  optionVals.filter(Boolean).every((v) => keys.includes(v)) &&
  keys.every((k) => optionVals.includes(k)),
  optionVals.filter(Boolean).join(','))
pass('V2c', '面板有 fear 选项（之前漏了）', optionVals.includes('fear'))
pass('V2d', '面板说明点破了「语音指令」机制', html.includes('语音指令'))

/* ---------- V3 合成代码的正确性（源码级） ---------- */
const serverSrc = fs.readFileSync(new URL('../panel/server.js', import.meta.url), 'utf8')
pass('V3a', '不再往 req_params 顶层塞 emotion', !/reqParams\.emotion\s*=/.test(serverSrc))
pass('V3b', '用 additions + context_texts', serverSrc.includes('reqParams.additions = JSON.stringify({ context_texts'))
pass('V3c', 'additions 是 JSON 字符串（不是对象）', serverSrc.includes('JSON.stringify({ context_texts'))
pass('V3d', '只取映射表里的值（防野值）', /EMOTION_INSTRUCTIONS\[v\.emotion\]/.test(serverSrc))
pass('V3e', 'context_texts 只放一条', serverSrc.includes('context_texts: [EMOTION_INSTRUCTIONS[v.emotion]]'))
pass('V3f', 'store 导出 EMOTION_INSTRUCTIONS 供复用', serverSrc.includes('EMOTION_INSTRUCTIONS') && serverSrc.includes("from '../panel/lib/store.js'"))

/* ---------- V4 默认值语义 ---------- */
const storeSrc = fs.readFileSync(new URL('../panel/lib/store.js', import.meta.url), 'utf8')
pass('V4a', '默认 emotion 仍是空（= 不加指令，按文本发挥）', /emotion: ''/.test(storeSrc))
pass('V4b', '默认值注释说明了机制', /context_texts 指令/.test(storeSrc))

/* ---------- V5 回归：语音无关的能力没被碰 ---------- */
pass('V5a', 'speech_rate 仍在 audio_params（语速逻辑没动）', serverSrc.includes('speech_rate: Math.round((speed - 1) * 100)'))
pass('V5b', '失败回退 Edge 仍在', serverSrc.includes('回退到 Edge 音色'))
pass('V5c', '资源 ID 兜底仍在', serverSrc.includes('inferResourceId(v.speaker)'))

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
