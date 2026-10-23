/**
 * 整条回复级判重（sameReplyAsLast）
 *
 * 背景：2026-10-22 18:15 的真实事故 —— dsh 把同一条回复发了两遍帧（相隔 3 秒），
 * 两次都走了「分条 + 补发队列」，两条链交错执行，对方收到的顺序就乱了：
 *
 *   18:15:21 拆成 4 条 / 补发 2/4
 *   18:15:24 拆成 4 条 / 丢弃首条 / 又补发 2/4    ← 第二链起来了
 *   18:15:24 补发 3/4（第二链）
 *   18:15:27 补发 3/4（第一链）
 *   18:15:30 补发 4/4（第一链）
 *   18:15:31 补发 4/4（第二链）
 *
 * 原有的「逐条去重」挡不住：两条链的延迟不同，对方那条还没发出去，去重自然命不中。
 * 而且原来的整条去重是拿**原始文本**算 sha1，两次文本只要差一个标点就不命中。
 *
 * 所以补了「分条后、起发送链之前」的整条判重：去掉空白和标点后比对 parts 指纹，
 * 命中就整条丢弃、连补发链都不启动。
 */

import { createProxy } from '../panel/lib/proxy.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${name}${extra ? ' | ' + extra : ''}`)
  if (!ok) fail++
}

const outFrame = (uid = 10001) => ({
  action: 'send_private_msg',
  echo: 'e1',
  params: { user_id: uid, message: [] }
})

/* ---------- D1 判重的基本行为 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  const A = ['欸问你个正经的', '我这件外套你觉得我送去干洗还是自己手洗']

  pass('D1a', '第一次不算重复', p.sameReplyAsLast(f, A) === false)
  pass('D1b', '同样的内容第二次算重复', p.sameReplyAsLast(f, A) === true)
}

/* ---------- D2 标点 / 空白 / 表情不影响判重 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  const A = ['欸问你个正经的', '我这件外套你觉得我送去干洗还是自己手洗']
  const A2 = ['欸 问你个正经的！', '我这件外套，你觉得我送去干洗还是自己手洗？']

  p.sameReplyAsLast(f, A)
  pass('D2', '只差标点和空白也算同一轮', p.sameReplyAsLast(f, A2) === true)
}

/* ---------- D3 内容不同不能误杀 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  p.sameReplyAsLast(f, ['今天好累啊一点力气都没有'])
  pass(
    'D3',
    '内容不同不判重复',
    p.sameReplyAsLast(f, ['食堂三楼那个阿姨给的量特别大每次吃不完']) === false
  )
}

/* ---------- D4 不同会话互不影响 ---------- */
{
  const p = createProxy(() => {})
  const A = ['同一句话啊啊啊啊']
  p.sameReplyAsLast(outFrame(111), A)
  pass('D4', '另一个会话的同样内容不算重复', p.sameReplyAsLast(outFrame(222), A) === false)
}

/* ---------- D5 尾巴差一点也算（真实重发常这样） ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  p.sameReplyAsLast(f, ['这句等一下', '我去看看课表'])
  pass('D5', '尾巴差一个字也判重复', p.sameReplyAsLast(f, ['这句等一下', '我去看看课表了']) === true)
}

/* ---------- D6 极短的句子不做包含判重，避免误杀 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  p.sameReplyAsLast(f, ['好'])
  pass('D6', '极短句不做包含判重', p.sameReplyAsLast(f, ['好的']) === false)
}

/* ---------- D7 30 秒窗口 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  const A = ['这句等一下', '我去看看课表']
  p.sameReplyAsLast(f, A)
  // 把上一轮的时间往前推 60 秒，模拟隔了很久
  for (const v of p.lastSplit.values()) v.at -= 60_000
  pass('D7', '超过 30 秒窗口后不再判重', p.sameReplyAsLast(f, A) === false)
}

/* ---------- D8 空内容不参与判重 ---------- */
{
  const p = createProxy(() => {})
  const f = outFrame()
  pass('D8', '空的 parts 直接放过', p.sameReplyAsLast(f, ['', '  ']) === false)
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
