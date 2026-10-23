/**
 * 出站草稿剥离测试（`stripDraftArtifacts` / `stripDraftFrame`）。
 *
 * 起因：2026-10-22 她把「写给自己看的推演」一起塞进了正文，
 * 被分条切成 3 条发出去，对方收到的是英文批注 + 半截中文。
 * 下面 A/B/C 三段是当时的**真实原文**，不能再退化。
 */
import { stripDraftArtifacts, createProxy } from '../panel/lib/proxy.js'
import { loadConfig } from '../panel/lib/store.js'

let fail = 0
/** 断言「没有英文」前先把 [face:14] 这种标记剔掉 —— 里面的 face 也是字母 */
const noFace = (t) => String(t).replace(/\[face:\d+\]/g, '')
const pass = (id, name, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${extra ? ' — ' + extra : ''}`)
}

const A = `I'm in class (14:00-15:40), hiding phone under desk. Reply briefly explaining.

"在上课呢 偷偷回的 手机藏桌子底下" 2 lines.在上课呢 手机藏桌子底下偷偷回的
刚才没看手机 别急[face:27]`

const B = `"顺序都打错了" — he means my sentence order was wrong? Hmm, maybe he refers to what I said: "拿着线看了半天" order weird? Or he's pointing my message ordering.

Respond lightly: 啊 我说反了吗 / 你先说清哪句[face:32].

Keep sh`

const C = `He says 噢噢. Reply minimal — maybe react with face. "先不说了 老师点人了" and go quiet.

Short.先不说了 老师好像要点人
下课找你[face:27]`

/* ---------- D1 三段真实原文：不能留英文批注 ---------- */
const ra = stripDraftArtifacts(A)
pass('D1a', 'A 段不再含英文批注', !/[A-Za-z]{4,}/.test(noFace(ra.text)), ra.text.replace(/\n/g, ' / '))
pass('D1b', 'A 段保住了「别急」这一句', ra.text.includes('别急'))
pass('D1c', 'A 段没有残留 "2 lines"', !/lines?/i.test(ra.text))
pass('D1d', 'A 段不留空引号', !/["“”]/.test(ra.text))

const rb = stripDraftArtifacts(B)
pass('D1e', 'B 段英文推演全清掉', !/[A-Za-z]{4,}/.test(noFace(rb.text)), rb.text.replace(/\n/g, ' / '))
pass('D1f', 'B 段留下「我说反了吗」', rb.text.includes('我说反了吗'))
pass('D1g', 'B 段没有残留 "Keep"', !/\bKeep\b/.test(rb.text))

const rc = stripDraftArtifacts(C)
pass('D1h', 'C 段英文推演全清掉', !/[A-Za-z]{4,}/.test(noFace(rc.text)), rc.text.replace(/\n/g, ' / '))
pass('D1i', 'C 段留下「老师好像要点人」', rc.text.includes('老师好像要点人'))
pass('D1j', 'C 段留下「下课找你」', rc.text.includes('下课找你'))

/* ---------- D2 正常回复一个字都不能动 ---------- */
const normal = [
  '这节在放片子 我一句没听进去\n突然有点想你[face:20]',
  '这个 useEffect 的依赖数组得加上\n不然会一直重复请求',
  'ok 我知道了\n那明天再说吧',
  '他问我"你吃了吗"\n我说吃了',
  'emmm 有点困\n等一下再说',
  '你说的对\n那我先试试',
  'hhhh 笑死\n这也太离谱了'
]
for (const [i, t] of normal.entries()) {
  const r = stripDraftArtifacts(t)
  pass(`D2${i}`, `正常回复不动：${t.split('\n')[0].slice(0, 14)}`, !r.changed && r.text === t, r.changed ? '被改成了 ' + JSON.stringify(r.text) : '')
}

/* ---------- D3 整条都是草稿 ---------- */
const allDraft = 'Let me think about how to reply here.\n\nHe said he is tired. Reply warmly but keep it short — 2 lines.'
const rd = stripDraftArtifacts(allDraft)
pass('D3', '整条草稿会被清空（不发）', !rd.text.trim(), JSON.stringify(rd.text))

/* ---------- D4 帧级：表情段位置不能乱 ---------- */
const proxy = createProxy(() => {})
const frame = {
  action: 'send_private_msg',
  params: {
    user_id: 1,
    message: [
      { type: 'text', data: { text: 'Reply briefly: 在上课呢[face:14]手机藏桌子底下' } },
      { type: 'face', data: { id: '14' } },
      { type: 'text', data: { text: '刚才没看手机' } }
    ]
  }
}
const f = proxy.stripDraftFrame(frame)
pass('D4a', '帧被判定为需要清洗', f.changed === true)
pass('D4b', '剥掉了 Reply 前缀', !/Reply/.test(f.text), f.text)
pass('D4c', '表情段还在原位（第 2 个）', f.frame.params.message[1]?.type === 'face')
pass('D4d', '后面那句「刚才没看手机」还在', f.text.includes('刚才没看手机'))
pass('D4e', '原帧没被就地改坏', frame.params.message[0].data.text.includes('Reply'))

/* ---------- D5 纯图片帧不受影响 ---------- */
const imgFrame = { action: 'send_private_msg', params: { user_id: 1, message: [{ type: 'image', data: { file: 'x.png' } }] } }
const fi = proxy.stripDraftFrame(imgFrame)
pass('D5', '纯图片帧原样返回', fi.changed === false && fi.frame === imgFrame)

/* ---------- D6 分条后不该出现英文碎片 ---------- */
const cfg = loadConfig()
const plan = proxy.splitPlan(JSON.stringify({
  action: 'send_private_msg',
  params: { user_id: 1, message: [{ type: 'text', data: { text: A } }] }
}))
const cleanedFirst = proxy.stripDraftFrame(JSON.parse(JSON.stringify({
  action: 'send_private_msg',
  params: { user_id: 1, message: [{ type: 'text', data: { text: A } }] }
})))
const planAfter = cleanedFirst.text
  ? proxy.splitPlan(JSON.stringify(cleanedFirst.frame))
  : null
const parts = planAfter ? planAfter.parts : []
pass('D6a', '清洗后仍能正常分条', parts.length >= 1 && parts.length <= 4, `${parts.length} 条：${JSON.stringify(parts)}`)
pass('D6b', '每一条都不含英文句子', parts.every((p) => !/[A-Za-z]{4,}/.test(noFace(p))), JSON.stringify(parts))


/* ---------- D7 真实事故：表情夹在两段文字之间，不能粘成一句 ---------- */
// 2026-10-22 17:07 原样复刻：模型输出「…想你就想你嘛」+[face:20]+「被你看出来了啊\n…」，
// 旧实现把两段直接 join('')，变成「想你就想你嘛被你看出来了啊」—— 看着就是断句错乱。
const frame7 = {
  action: 'send_private_msg',
  params: {
    user_id: 1,
    message: [
      {
        type: 'text',
        data: {
          text:
            'Both same thread, one reply. Playful: 想你了 那又怎样. No quote needed if merged. ' +
            'Actually rule: if same thing merge as one reply.\n\nReply: 被你看出来了 / 想你就想你嘛'
        }
      },
      { type: 'face', data: { id: '20' } },
      { type: 'text', data: { text: '被你看出来了啊\n想你就想你嘛 有什么好藏' } },
      { type: 'face', data: { id: '20' } }
    ]
  }
}
const f7 = proxy.stripDraftFrame(frame7)
pass('D7a', '英文推演被剥掉', !/Both same thread|Actually rule|No quote needed/.test(f7.text), f7.text.slice(0, 40))
// 注意看的是 message 里的 text 段，不是 f7.text（那是去分隔符后用来判空的合并串）
const texts7 = f7.frame.params.message.filter((x) => x && x.type === 'text').map((x) => String(x.data.text))
pass('D7b', '两段文字没粘成一句', texts7.every((t) => !/嘛被你看出来了/.test(t)), JSON.stringify(texts7))
pass('D7c', '两个表情都还在', f7.frame.params.message.filter((x) => x && x.type === 'face').length === 2)
// 清洗后文字合并成一个段，表情挂在它后面（splitPlan 会再挂到分条的最后一条）
const shape7 = f7.frame.params.message.map((x) => (x && x.type) || '').join(',')
pass('D7d', '文字合成一段、两个表情都保留', shape7 === 'text,face,face' && (shape7.match(/face/g) || []).length === 2, shape7)

// 分条之后：多行要拆开，且不能粘成一句长句
const plan7 = proxy.splitPlan(JSON.stringify(f7.frame))
const parts7 = plan7 ? plan7.parts : []
pass('D7e', '按行拆成了多条', parts7.length >= 2, `${parts7.length} 条：${JSON.stringify(parts7)}`)
pass('D7f', '每一段里都没有粘连', parts7.every((t) => !/嘛被你看出来了|嘛想你就想你嘛/.test(t)), JSON.stringify(parts7))

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
