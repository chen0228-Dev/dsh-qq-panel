/**
 * 「正在聊」状态的持久化
 *
 * 背景：2026-10-22 18:47 的真实事故 —— 我改完代码重启了面板，`this.pace` 是纯内存
 * Map，一重启 `lastDispatchAt` / `lastSpokeAt` 全归零。用户紧接着发消息，
 * `lastTouched = 0` → `chatting = false` → 系统以为「很久没聊」，
 * 于是走随机节奏抽到 long 档（8-25 分钟），实际拖了 350 秒才回。
 * 他的体感是「上一句都还在分岔闲聊，我一说话她就不回了」。
 *
 * 18:47:45 收到 + 350 秒 ≈ 18:53:36，和日志里「攒了一会儿，现在回」完全吻合。
 *
 * 所以这两个时间戳必须落盘，重启后读回来。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createProxy } from '../panel/lib/proxy.js'
import { getState, patchState, loadState, DATA_DIR } from '../panel/lib/store.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${name}${extra ? ' | ' + extra : ''}`)
  if (!ok) fail++
}

const KEY = 'private:10001'
const clean = () => {
  const st = getState()
  const all = { ...(st.chatPace || {}) }
  delete all[KEY]
  patchState({ chatPace: all })
}

/* ---------- P1 她说过话 → 写进 state ---------- */
{
  clean()
  const p = createProxy(() => {})
  p.markChatSpoke({ params: { user_id: 10001 } })
  const saved = getState().chatPace || {}
  pass('P1a', '她说过话后 state 里有这个会话', Boolean(saved[KEY]), JSON.stringify(saved[KEY] || null))
  pass('P1b', '记下了 lastSpokeAt', (saved[KEY]?.s || 0) > 0)
}

/* ---------- P2 「看到消息」也要写 ---------- */
{
  clean()
  const p = createProxy(() => {})
  const key = p.chatKey({
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗'
  })
  // 直接建一个 inbox 然后 flush，走真实的写入路径
  p.inbox.set(key, {
    items: [{ text: 'x', frame: { post_type: 'message', message_type: 'private', user_id: 10001, message: [] }, at: Date.now() }],
    timer: null,
    firstAt: Date.now()
  })
  p.dispatch = () => {} // 不真的走下游
  p.flushInbox(key)
  const saved = getState().chatPace || {}
  pass('P2', 'flush 后记下了 lastDispatchAt', (saved[key]?.d || 0) > 0, JSON.stringify(saved[key] || null))
}

/* ---------- P3 重启（新实例）能把状态读回来 ---------- */
{
  clean()
  const before = Date.now()
  const a = createProxy(() => {})
  a.markChatSpoke({ params: { user_id: 10001 } })
  const savedAt = getState().chatPace[KEY].s

  // 模拟重启：换一个全新实例，内存里什么都没有
  const b = createProxy(() => {})
  pass('P3a', '新实例启动前内存是空的', b.pace.size === 0, `size=${b.pace.size}`)
  b.restorePace()
  const st = b.pace.get(KEY)
  pass('P3b', 'restorePace 把会话读回来了', Boolean(st), JSON.stringify(st || null))
  pass('P3c', '时间戳没丢', (st?.lastSpokeAt || 0) === savedAt, `${st?.lastSpokeAt} vs ${savedAt}`)

  // 关键：这个时间戳能让「正在聊」判定成立
  const CHAT_WINDOW = 240_000
  const chatting = (st?.lastSpokeAt || 0) > 0 && Date.now() - st.lastSpokeAt < CHAT_WINDOW
  pass('P3d', '恢复后立刻判定为「正在聊」（不会再拖几分钟）', chatting === true, `savedAt-now=${Date.now() - savedAt}ms`)
  pass('P3e', '时间戳是刚才的，不是 0', savedAt >= before - 1000)
}

/* ---------- P4 很久以前的记录 → 恢复后不算「正在聊」 ---------- */
{
  clean()
  patchState({ chatPace: { [KEY]: { d: 0, s: Date.now() - 30 * 60_000 } } })
  const p = createProxy(() => {})
  p.restorePace()
  const st = p.pace.get(KEY)
  const CHAT_WINDOW = 240_000
  const chatting = (st?.lastSpokeAt || 0) > 0 && Date.now() - st.lastSpokeAt < CHAT_WINDOW
  pass('P4', '半小时前的记录不会误判成「正在聊」', chatting === false)
}

/* ---------- P5 状态里没有这个会话 → 不影响启动 ---------- */
{
  clean()
  const p = createProxy(() => {})
  let threw = false
  try {
    p.restorePace()
  } catch {
    threw = true
  }
  pass('P5', '什么都没有时 restorePace 不报错', threw === false)
}

/* ---------- P6 脏数据不能把启动搞崩 ---------- */
{
  clean()
  patchState({ chatPace: { [KEY]: null, 'private:bad': 'not-an-object' } })
  const p = createProxy(() => {})
  let threw = false
  try {
    p.restorePace()
  } catch {
    threw = true
  }
  pass('P6', '脏数据被跳过、不抛异常', threw === false)
  clean()
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
