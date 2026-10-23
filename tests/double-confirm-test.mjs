/**
 * 危险操作双确认 —— 回归测试
 *
 * 背景：2026-10-23 用户要求「清空记忆」「删除文件」两个按钮点下去要弹两次确认，
 * 因为浏览器 confirm 的「确定」就在同一个位置，一次弹窗很容易连点误触，
 * 而这两个操作都是**不可撤销**的（没有回收站、没有备份）。
 *
 * 这个测试是静态检查（项目没装 jsdom，不值得为一个断言引入依赖）：
 * 它保证「结构还在」——以后重构前端时如果有人把双确认改回单次，
 * 或者把两次的文案写成一样，这里会红。
 */

import fs from 'node:fs'
import path from 'node:path'

const html = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'panel', 'public', 'index.html'),
  'utf8'
)

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

console.log('[1] 双确认函数本身\n')
ok('定义了 confirmTwice', /function confirmTwice\s*\(/.test(html))
ok('第一次不通过就不问第二次（短路返回 false）', /if\s*\(!window\.confirm\(first\)\)\s*return false/.test(html))
ok('第二次的返回值就是最终结果', /return window\.confirm\(second\)/.test(html))

console.log('\n[2] 清空记忆（btnMemClear）\n')
const clearBlock = (() => {
  const i = html.indexOf("$('btnMemClear').onclick")
  return i >= 0 ? html.slice(i, i + 1200) : ''
})()
ok('找到了 btnMemClear 的处理函数', clearBlock.length > 0)
ok('走的是 confirmTwice', clearBlock.includes('confirmTwice('))
ok('没有退回单次 confirm', !/if\s*\(!confirm\(/.test(clearBlock))
ok('第一次文案说明「清什么」', clearBlock.includes('长期记忆'))
ok('第一次文案说明「不清什么」（对话历史/立场/黑话）', clearBlock.includes('对话历史'))
ok('第二次文案是"第二次确认"', clearBlock.includes('第二次确认'))
ok('第二次文案强调不可恢复', clearBlock.includes('无法恢复') || clearBlock.includes('不能撤销'))
ok('两次文案不同（第二次不是复制第一次）', (() => {
  const calls = clearBlock.match(/['"]([^'"]{20,})['"]/g) || []
  return new Set(calls).size > 1
})())

console.log('\n[3] 删除文件（data-fs="del"）\n')
const delBlock = (() => {
  const i = html.indexOf("if (act === 'del')")
  return i >= 0 ? html.slice(i, i + 900) : ''
})()
ok('找到了删除分支', delBlock.length > 0)
ok('走的是 confirmTwice', delBlock.includes('confirmTwice('))
ok('没有退回单次 confirm', !/if\s*\(!confirm\(/.test(delBlock))
ok('第一次文案带文件名', delBlock.includes('${name}'))
ok('第一次文案提示文件夹会连内容一起删', delBlock.includes('文件夹'))
ok('第二次文案是"第二次确认"', delBlock.includes('第二次确认'))
ok('第二次文案说明没有回收站', delBlock.includes('没有回收站'))

console.log('\n[4] 不该被误伤的地方\n')
ok('其它可逆操作用单次确认是可以的（重排日程仍在）', /继续？'\)\)\s*return/.test(html))
ok('旧的清空记忆单次文案已移除', !html.includes('清空它记住的所有人和事'))

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
