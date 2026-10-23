/**
 * QQ 小黄脸 / 超级表情的识别
 *
 * 背景：她能发 [face:14]，但**看不懂对方发来的表情**。
 * 根因有三层，这次一起修了：
 *   ① dsh 官方 onebot 插件里的编号→emoji 表用的是老版 CQ 编号，
 *      和 NTQQ 现在的编号对不上（13 呲牙 → 😘、66 爱心 → 😡、264 捂脸 落到 😀）
 *   ② 超级表情（mface）插件完全不认，模型只看到 `[mface]`
 *   ③ 代理层把 face 排除在「有内容」之外，只发一个表情会被当成空消息直接不回
 *
 * 所以改成在面板这层把表情段翻译成文字（`[表情:呲牙]`），
 * 插件收到的就是纯文本，不再二次映射 —— 也就不用去改第三方包。
 */

import { createProxy } from '../panel/lib/proxy.js'
import { faceName, describeFaceSeg, isFaceLikeSeg, FACE_NAMES, COMMON_FACES } from '../panel/lib/faces.js'
import { renderPersona } from '../panel/lib/store.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- F1 映射表本身 ---------- */
pass('F1a', '映射表是 275 条（NTQQ 全量）', Object.keys(FACE_NAMES).length === 275, `${Object.keys(FACE_NAMES).length} 条`)
pass('F1b', '14 = 微笑', faceName(14) === '微笑', faceName(14))
pass('F1c', '13 = 呲牙', faceName(13) === '呲牙', faceName(13))
pass('F1d', '264 = 捂脸', faceName(264) === '捂脸', faceName(264))
pass('F1e', '271 = 吃瓜', faceName(271) === '吃瓜', faceName(271))
pass('F1f', '未知编号返回空串', faceName(99999) === '')
pass('F1g', '常用编号清单非空', COMMON_FACES.length >= 20, `${COMMON_FACES.length} 个`)

/* ---------- F2 段翻译 ---------- */
pass('F2a', 'face → 带名字', describeFaceSeg({ type: 'face', data: { id: '13' } }) === '[表情:呲牙]')
pass('F2b', 'face 未知编号 → 保留数字', describeFaceSeg({ type: 'face', data: { id: '99999' } }) === '[表情:99999]')
pass('F2c', 'mface 用 summary', describeFaceSeg({ type: 'mface', data: { summary: '[汪星人]' } }) === '[超级表情:汪星人]')
pass('F2d', 'mface 没 summary 也不空', describeFaceSeg({ type: 'mface', data: {} }) === '[超级表情]')
pass('F2e', '表情包图', describeFaceSeg({ type: 'image', data: { sub_type: '1' } }) === '[表情包]')
pass('F2f', '普通图片不归我管（返回 null）', describeFaceSeg({ type: 'image', data: {} }) === null)
pass('F2g', '文本段不归我管', describeFaceSeg({ type: 'text', data: { text: 'hi' } }) === null)

/* ---------- F3 isFaceLikeSeg ---------- */
pass('F3a', 'face 算表情类', isFaceLikeSeg({ type: 'face', data: { id: '1' } }) === true)
pass('F3b', 'mface 算表情类', isFaceLikeSeg({ type: 'mface' }) === true)
pass('F3c', '文本不算', isFaceLikeSeg({ type: 'text' }) === false)
pass('F3d', '普通图不算', isFaceLikeSeg({ type: 'image', data: {} }) === false)

/* ---------- F4 整帧转换：混合文本和表情 ---------- */
{
  const p = createProxy(() => {})
  // 入站 OneBot 事件（deliver 交给 dsh 的就是这个结构）
  const frame = {
    post_type: 'message',
    message_type: 'private',
    user_id: 1,
    message: [
      { type: 'text', data: { text: '你看这个' } },
      { type: 'face', data: { id: '264' } },
      { type: 'text', data: { text: '笑死' } }
    ],
    raw_message: '你看这个[face:264]笑死'
  }
  const out = p.describeSegments(JSON.stringify(frame), frame)
  const segs = JSON.parse(out).message
  const joined = segs.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')
  pass('F4a', '表情被换成文字', joined.includes('[表情:捂脸]'), joined)
  pass('F4b', '原有文字没丢', joined.includes('你看这个') && joined.includes('笑死'), joined)
  pass('F4c', '帧里不再有 face 段', segs.every((s) => s.type === 'text'), segs.map((s) => s.type).join(','))
  pass('F4d', '传进来的 frame 被原地更新（后续分条看到的是同一份）', frame.message.every((s) => s.type === 'text'))
}

/* ---------- F5 纯表情帧也要变成模型能读的内容 ---------- */
{
  const p = createProxy(() => {})
  const frame = {
    post_type: 'message',
    message_type: 'private',
    user_id: 1,
    message: [{ type: 'face', data: { id: '14' } }]
  }
  const out = p.describeSegments(JSON.stringify(frame), frame)
  const segs = JSON.parse(out).message
  pass('F5', '纯表情帧转成 [表情:微笑]', segs.length === 1 && segs[0].data.text === '[表情:微笑]', JSON.stringify(segs))
}

/* ---------- F6 没表情时不动它 ---------- */
{
  const p = createProxy(() => {})
  const frame = {
    post_type: 'message',
    message_type: 'private',
    user_id: 1,
    message: [{ type: 'text', data: { text: '纯文本' } }]
  }
  const src = JSON.stringify(frame)
  const out = p.describeSegments(src, frame)
  pass('F6', '纯文本帧原样返回', out === src)
}

/* ---------- F7 非 JSON 输入不能崩 ---------- */
{
  const p = createProxy(() => {})
  let threw = false
  let out = ''
  try {
    out = p.describeSegments('这不是 json', null)
  } catch {
    threw = true
  }
  pass('F7', '非 JSON 输入原样返回、不抛异常', threw === false && out === '这不是 json')
}

/* ---------- F8 人格里要告诉她「收到的表情不是暗号」 ---------- */
{
  const persona = renderPersona({
    persona: { enabled: true, name: 'x', identity: 'y', style: 'z', tone: 'w', maxChars: 100 },
    campus: { enabled: false },
    stickers: { enabled: false },
    capabilities: {},
    paths: { workspace: '/tmp' }
  })
  pass('F8a', 'AGENTS.md 提到收到的表情形式', /\[表情:/.test(persona), '')
  pass('F8b', '明确说了不是暗号', /不是暗号/.test(persona))
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
