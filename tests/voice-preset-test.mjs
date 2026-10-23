/**
 * 火山引擎「官方音色库」音色接入
 *
 * 背景：项目原来只支持「声音复刻」（自己训练的音色，S_ 开头）。
 * 用户问能不能用火山音色库里那些官方预置音色 —— 能，而且不用额外花钱：
 * 该账号的「语音合成 2.0」商品早就开通了，只是面板上找不到入口。
 *
 * 真正的坑不是「能不能用」，而是**音色和资源 ID 必须同代**：
 *   seed-tts-2.0 只认 *_uranus_bigtts
 *   seed-icl-*   只认 S_
 * 配错不会音色失真，会直接 `code=55000000 resource ID is mismatched`，
 * 而面板原来把这个错误笼统写成「集群或音色 ID 不对」，根本查不出来。
 *
 * 本测试盯四件事：
 *   1. inferResourceId 对各种 ID 格式判断正确
 *   2. 权威清单 VOLC_PRESET_VOICES 自洽（全是 2.0、不重复）
 *   3. **面板下拉里的 option 和清单一一对应**（改了一边忘另一边就红）
 *   4. 面板有「选下拉自动填 ID + 自动配资源 ID」这套控件
 */

import fs from 'node:fs'
import { inferResourceId, VOLC_PRESET_VOICES } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- V1 资源 ID 推断 ---------- */
const cases = [
  ['S_5eBLaJQi2', 'seed-icl-2.0', '复刻 2.0（大写 S）'],
  ['s_abc123', 'seed-icl-2.0', '复刻 2.0（小写 s 也认）'],
  ['zh_female_vv_uranus_bigtts', 'seed-tts-2.0', '官方 2.0'],
  ['zh_male_m191_uranus_bigtts', 'seed-tts-2.0', '官方 2.0 男声'],
  ['zh_female_shuangkuaisisi_moon_bigtts', 'seed-tts-1.0', '官方 1.0 moon'],
  ['zh_female_cancan_mars_bigtts', 'seed-tts-1.0', '官方 1.0 mars'],
  ['BV700_streaming', 'seed-tts-1.0', '官方 1.0 老编号'],
  ['  zh_female_vv_uranus_bigtts  ', 'seed-tts-2.0', '首尾空格不影响'],
  ['', null, '空字符串 → 认不出'],
  ['S_', 'seed-icl-2.0', '只有前缀也算复刻（交给服务端报错）'],
  ['garbage_id', null, '野 ID → 不瞎猜'],
  ['zh_female_vv', null, '缺后缀 → 不瞎猜']
]
for (const [input, want, label] of cases) {
  const got = inferResourceId(input)
  pass('V1', label, got === want, `${JSON.stringify(input)} → ${got}`)
}

/* ---------- V2 权威清单自洽 ---------- */
const ids = VOLC_PRESET_VOICES.map((v) => v.id)
pass('V2a', '清单 14 条', VOLC_PRESET_VOICES.length === 14, `${VOLC_PRESET_VOICES.length} 条`)
pass('V2b', '全部是 2.0 音色（_uranus_bigtts）', ids.every((i) => i.endsWith('_uranus_bigtts')))
pass('V2c', '没有重复 ID', new Set(ids).size === ids.length)
pass('V2d', '每条都有中文名和说明', VOLC_PRESET_VOICES.every((v) => v.name && v.note))
pass('V2e', '男女声都有', VOLC_PRESET_VOICES.some((v) => v.gender === 'f') && VOLC_PRESET_VOICES.some((v) => v.gender === 'm'))
pass('V2f', '清单里每个 ID 都能推断出 seed-tts-2.0', ids.every((i) => inferResourceId(i) === 'seed-tts-2.0'))

/* ---------- V3 面板下拉与清单对账 ---------- */
const html = fs.readFileSync(new URL('../panel/public/index.html', import.meta.url), 'utf8')
const presetBlock = html.slice(html.indexOf('id="v-voicepreset"'), html.indexOf('</select>', html.indexOf('id="v-voicepreset"')))
const optionIds = [...presetBlock.matchAll(/<option value="([^"]+)"[^>]*>/g)]
  .map((m) => m[1])
  .filter(Boolean)

pass('V3a', '面板下拉里正好 14 个音色', optionIds.length === 14, `${optionIds.length} 个`)
pass('V3b', '面板下拉与清单完全一致（少了提示没加，多了提示加了没登记）',
  optionIds.length === ids.length && optionIds.every((i, k) => i === ids[k]),
  optionIds.length === ids.length ? '' : `面板 ${optionIds.length} vs 清单 ${ids.length}`)

/* ---------- V4 面板控件齐了 ---------- */
pass('V4a', '有音色预设下拉', html.includes('id="v-voicepreset"'))
pass('V4b', '有识别结果提示行', html.includes('id="v-voicehint"'))
pass('V4c', '资源 ID 下拉补齐 4 个档位',
  ['seed-tts-2.0', 'seed-icl-2.0', 'seed-icl-1.0', 'seed-tts-1.0'].every((r) => html.includes(`value="${r}"`)))
pass('V4d', '前端也有推断函数', html.includes('function inferResource')
  && html.includes('function voiceKind') && html.includes('function syncVoiceKind'))
pass('V4e', '选了预设会自动填 ID', html.includes("$('v-speaker').value = v"))
pass('V4f', '声音 ID 的 placeholder 说明了两种格式',
  /placeholder="zh_female_[^"]*或 S_/.test(html))
pass('V4g', '错误提示写明了 55000000 的含义', html.includes('55000000 resource ID is mismatched'))

/* ---------- V5 前后端规则一致 ---------- */
// 前端 inferResource 里的判定必须和后端 inferResourceId 同序同结果
const got = ['S_x', 'zh_female_vv_uranus_bigtts', 'zh_female_x_uranus_bigtts', 'BV700_streaming']
const frontRuleOk = html.includes("/^S_/i.test(s)") && html.includes('/_uranus_bigtts$/i.test(s)')
  && html.includes('/_moon_bigtts$|_mars_bigtts$/i.test(s)') && html.includes('/^BV\\d+_streaming$/i.test(s)')
pass('V5a', '前端正则与后端一致（四类都覆盖）', frontRuleOk, got.join(' / '))

/* ---------- V6 音色下拉的「不选」要能存住（2026-10-23 线上问题） ----------
 * 现象：选「— 不选，用下面手填的 ID —」再点保存，界面又跳回之前的音色。
 * 根因：这个选择从来没被提交过；回填时只能拿 speakerId 去反查清单，
 *      于是「不选」这个意图丢了，永远显示反查出来的旧音色。
 */
pass('V6a', '下拉有「不选」这一项', /<option value="">—\s*不选/.test(html))
pass('V6b', '保存时会提交下拉的选择', /preset:\s*\$\('v-voicepreset'\)/.test(html))
pass('V6c', '回填优先用存下来的 preset', /typeof vc\.preset === 'string'/.test(html))
pass('V6d', '老配置没有 preset 时才按 speakerId 反查',
  /hasPreset \? vc\.preset : inPreset \? vc\.speakerId : ''/.test(html))
pass('V6e', '手填 ID 与下拉不一致时下拉回到「不选」',
  /\$\('v-voicepreset'\)\.value !== \$\('v-speaker'\)\.value\.trim\(\)/.test(html))
pass('V6f', '选「不选」不会清空手填的 ID',
  /选「不选」\*\*不清空\*\*输入框/.test(html), '复刻音色 S_xxx 不能丢')

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
