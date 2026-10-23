// 验证：列表序号会被剥掉、分条数量合理
import { createProxy } from '/opt/qqbot/panel/lib/proxy.js'

const p = createProxy(() => {})
const mk = (t) =>
  JSON.stringify({ action: 'send_private_msg', params: { user_id: 10001, message: [{ type: 'text', data: { text: t } }] } })

const cases = [
  '1.欸 你现在上课了吧十点一刻那节\n2.我这边正琢磨那个蓝色小人要是真有个名字\n3.该叫啥',
  '1、第一句在这\n2、第二句也在这',
  '① 一 ② 二 ③ 三',
  '- 用横杠开头的句子\n- 第二句',
  '1.5 倍速听起来刚刚好' // 这个不能把 1.5 吃掉
]

for (const c of cases) {
  const plan = p.splitPlan(mk(c))
  console.log('原文:', JSON.stringify(c))
  console.log('  →', JSON.stringify(plan ? plan.parts : [c]))
}
