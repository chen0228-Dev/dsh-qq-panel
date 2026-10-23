// 主动搭话 × 状态机 × 节奏的接线测试
// 目标：她刚主动说完，你回一句必须秒回；上课/睡觉时不主动起话
import { createProxy } from '../panel/lib/proxy.js'
import { createProactive } from '../panel/lib/proactive.js'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, saveConfig } from '../panel/lib/store.js'

/** 清掉主动消息的当日计数，避免上一个用例的 lastAt 把下一个挡住 */
const resetProactiveState = () => {
  // 覆盖写成空状态，**不要 unlink**。
  // Windows 下删文件偶尔会失败（被占用），异常被 catch 吞掉后旧数据还在，
  // 上一条用例留下的 lastAt 会把这一条的「间隔」判断一直挡住 —— 排查了很久才定位到。
  try {
    fs.writeFileSync(path.join(process.env.PANEL_DATA || './data', 'proactive.json'), '{}')
  } catch {
    /* 写不进去也没别的办法 */
  }
}

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const cfg0 = loadConfig()
const p = createProxy(() => {})
p.log = () => {}

const mkFrame = (uid, text) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: uid,
  self_id: 10000,
  message_id: Math.floor(Math.random() * 1e9),
  message: [{ type: 'text', data: { text } }],
  raw_message: text
})

const timerOf = (key) => {
  const b = p.inbox.get(key)
  return b && b.timer ? b.timer._idleTimeout : null
}

/* ---------- W1 她刚说过话 → 你回复要快 ---------- */
// 关掉跳题联想：它按概率注入，会污染这里对「注入了什么」的断言
saveConfig({ reply: { assoc: { enabled: false }, opinion: { enabled: false }, pace: { enabled: true, mode: 'life', skipLowValue: true } } })
p.pace.clear()
p.inbox.clear()

// 模拟她主动发了一条（出站），这一步以前完全没有记录
p.markChatSpoke({ action: 'send_private_msg', params: { user_id: 10001, message: [] } })
const st = p.pace.get('private:10001')
pass('W1', '出站会记下「她刚说过话」', Boolean(st && st.lastSpokeAt), st ? new Date(st.lastSpokeAt).toISOString().slice(11, 19) : '无')

p.queueMessage(JSON.stringify(mkFrame(10001, '在呢 刚下课')), mkFrame(10001, '在呢 刚下课'))
const d1 = timerOf('private:10001')
pass('W1b', '紧接着你回复 → 走秒回档（≤6 秒）', d1 !== null && d1 <= 6000, `定时器 ${d1}ms`)

/* ---------- W2 上课状态也要让位于「正在聊」 ---------- */
p.pace.clear()
p.inbox.clear()
p.markChatSpoke({ action: 'send_private_msg', params: { user_id: 10001, message: [] } })
// 把课表设成「全天有课」，让 campus.busy 一定是 2
saveConfig({ campus: { classSlots: '00:00-23:59', busySlots: '00:00-23:59' } })
p.queueMessage(JSON.stringify(mkFrame(10001, '你刚说什么')), mkFrame(10001, '你刚说什么'))
const d2 = timerOf('private:10001')
pass('W2', '上课中但正在聊 → 仍然秒回', d2 !== null && d2 <= 6000, `定时器 ${d2}ms`)

/* ---------- W3 没在聊 + 上课 → 必须慢 ---------- */
p.pace.clear()
p.inbox.clear()
p.queueMessage(JSON.stringify(mkFrame(10001, '那个报告你写完了吗')), mkFrame(10001, '那个报告你写完了吗'))
const d3 = timerOf('private:10001')
pass('W3', '没在聊 + 上课 → 延迟到分钟级', d3 !== null && d3 > 60_000, `定时器 ${Math.round((d3 || 0) / 1000)} 秒`)

/* ---------- W4 她的回话也算「在聊」，不只主动搭话 ---------- */
p.pace.clear()
p.inbox.clear()
p.markChatSpoke({ action: 'send_group_msg', params: { group_id: 777, message: [] } })
pass('W4', '群聊出站也会记', Boolean(p.pace.get('group:777') && p.pace.get('group:777').lastSpokeAt))

/* ---------- W5 按会话隔离：访客说话不影响主号 ---------- */
p.chatLastAt.clear()
const now = Date.now()
p.chatLastAt.set('private:10002', now)
pass('W5', '访客的说话时间查得到', p.lastUserAtFor(10002) === now)
pass('W5b', '主号没说过就是 0', p.lastUserAtFor(10001) === 0)

/* ---------- W6 主动搭话受状态机约束 ---------- */
// 一天的课表铺满 → busy=2，应该拒绝主动起话
saveConfig({
  campus: { enabled: true, classSlots: '00:00-23:59', busySlots: '00:00-23:59' },
  // enabledAt 必须显式归零：别的用例可能留了个「刚刚启用」的时间戳，
  // 那样间隔判断会一直把消息挡住（这个坑踩过一次）
  proactive: { enabled: true, minGap: 1, maxGap: 2, dailyMax: 99, idleMinutes: 5, activeFrom: '00:00', activeTo: '23:59', enabledAt: 0 },
  qzone: { autoEnabled: false },
  qq: { adminQQ: cfg0.qq.adminQQ }
})

resetProactiveState()
const sent = []
const fakeProxy = {
  lastUserAt: 0,
  lastUserAtFor: () => 0,
  status: () => ({ napcat: true, dsh: true, botQQ: '10000' }),
  injectPrivateMessage: (t) => sent.push(t),
  setUserActivityHook: () => {},
  setQzoneHook: () => {}
}
const pro = createProactive(fakeProxy, () => {})
pro.checkNow()
pass('W6', '上课时段不主动起话', sent.length === 0, sent.length ? `竟然发了：${sent[0].slice(0, 20)}` : '没发')

// 课表清空（没课）→ 应该会说点什么
saveConfig({ campus: { enabled: true, classSlots: '', busySlots: '' } })
pro.checkNow()
pass('W6b', '没课的时候会主动开口', sent.length === 1, sent.length ? sent[0].slice(0, 26) + '…' : '没发')
const first = sent[0] || ''
pass('W6c', '主动消息里带上了当前状态', /你现在的状态：/.test(first))

/* ---------- W7 主动消息不该被访客的动静压住 ---------- */
resetProactiveState()
const sent2 = []
const fakeProxy2 = {
  lastUserAt: Date.now(), // 全局时间戳：刚有人说话（其实是访客）
  lastUserAtFor: () => 0, // 但主号很久没说了
  status: () => ({ napcat: true, dsh: true, botQQ: '10000' }),
  injectPrivateMessage: (t) => sent2.push(t),
  setUserActivityHook: () => {},
  setQzoneHook: () => {}
}
const pro2 = createProactive(fakeProxy2, () => {})
saveConfig({ proactive: { enabled: true, minGap: 1, maxGap: 2, dailyMax: 99, idleMinutes: 5, activeFrom: '00:00', activeTo: '23:59', enabledAt: 0 } })
pro2.checkNow()
pass('W7', '访客说话不挡住发给主号的消息', sent2.length === 1, sent2.length ? 'still fired' : '被挡住了')

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
