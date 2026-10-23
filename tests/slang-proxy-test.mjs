/**
 * 出站层的黑话标记测试（需要 ws，服务器上跑）。
 *
 * 盯的是上一类 bug 的重演：`[[引用 1]]` 曾因为「只处理第一个 text 段」
 * 漏到聊天里。生词标记同样必须**扫全部 text 段**。
 *
 * 跑法：node /opt/qqbot/tests/slang-proxy-test.mjs
 */
import { createProxy } from '../panel/lib/proxy.js'

let pass = 0
let fail = 0
const ok = (n, c, e = '') => {
  if (c) {
    pass++
    console.log(`  ok  ${n}${e ? ' — ' + e : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

const proxy = createProxy(() => {})
const frame = (segs) => ({ action: 'send_private_msg', params: { user_id: 10001, message: segs } })
const t = (text) => ({ type: 'text', data: { text } })

console.log('\n[1] 单个 text 段')
let r = proxy.extractSlangMarks(frame([t('[[生词：yyds|绝绝子]]今天好累啊')]))
ok('标记被剥', r.hit === 1 && r.frame.params.message[0].data.text === '今天好累啊', r.frame.params.message[0].data.text)
ok('词被收集', r.words.join(',') === 'yyds,绝绝子')

console.log('\n[2] 标记在第二个 text 段（旧 bug 的形态）')
r = proxy.extractSlangMarks(frame([t('第一段话'), t('第二段 [[生词：xswl]] 后面')]))
ok('两个段都保留', r.frame.params.message.length === 2)
ok('第二段里的标记被剥', !JSON.stringify(r.frame).includes('[['), JSON.stringify(r.frame.params.message))
ok('词收集到', r.words[0] === 'xswl')

console.log('\n[3] face 段不受影响（位置不能挪）')
r = proxy.extractSlangMarks(frame([t('[[生词：yyds]]说话'), { type: 'face', data: { id: '14' } }, t('再一句')]))
ok('face 段还在原位置', r.frame.params.message[1]?.type === 'face')
ok('三段都还在', r.frame.params.message.length === 3)

console.log('\n[4] 只剩标记时整条清空（调用方据此不发）')
r = proxy.extractSlangMarks(frame([t('[[生词：yyds]]')]))
ok('message 为空', r.frame.params.message.length === 0)
ok('词照样收到', r.words.length === 1)

console.log('\n[5] 没有标记时一个字都不动')
const plain = frame([t('正常一句话'), t('第二句')])
r = proxy.extractSlangMarks(plain)
ok('原样返回同一个对象', r.frame === plain && r.hit === 0)

console.log('\n[6] 空段被清掉，不留空气泡')
r = proxy.extractSlangMarks(frame([t('前'), t('[[生词：abc]]'), t('后')]))
ok('中间的纯标记段被移除', r.frame.params.message.length === 2, String(r.frame.params.message.length))

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
