/**
 * 线上代码的「无记忆」验证。
 *
 * 原则：
 * 1. 不经过 NapCat / dsh —— 直接把 proxy 的上游换成一个假的 send，捕获它「本来要发什么」；
 * 2. 不产生会话 —— 没有真实入站，dsh 那边收不到任何东西；
 * 3. 所有写操作都落到临时 PANEL_DATA（config 先复制一份），真实 data/ 一个字节都不动；
 * 4. 跑完对比会话目录和 AGENTS.local.md 的哈希，证明没留痕。
 *
 * 用法（在服务器上）：
 *   mkdir -p /tmp/live-check && cp /opt/qqbot/panel/data/config.json /tmp/live-check/
 *   PANEL_DATA=/tmp/live-check PANEL_ROOT=/opt/qqbot/panel node /root/live-campus-check.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 先把临时配置里的「回复速度」设成 1（立即交付），否则测试要等几十秒
const CFG = path.join(process.env.PANEL_DATA || '/tmp/live-check', 'config.json')
{
  const raw = JSON.parse(fs.readFileSync(CFG, 'utf8'))
  raw.reply = { ...(raw.reply || {}), speed: 1 }
  fs.writeFileSync(CFG, JSON.stringify(raw, null, 2))
}

const PANEL = 'file:///opt/qqbot/panel/lib'
const { createProxy } = await import(`${PANEL}/proxy.js`)
const { campusState } = await import(`${PANEL}/campus.js`)
const { planPace } = await import(`${PANEL}/pacing.js`)
const { loadConfig, moodLine } = await import(`${PANEL}/store.js`)

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const SESS = '/root/.dsh/sessions'
const AGENTS_LOCAL = '/root/qq-workspace/AGENTS.local.md'

function snap() {
  const walk = (dir) => {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(p))
      else out.push(`${p}:${fs.statSync(p).size}`)
    }
    return out.sort()
  }
  const hash = (f) => (fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : 'none')
  return { files: walk(SESS), agents: hash(AGENTS_LOCAL) }
}

const before = snap()
const cfg = loadConfig()
const p = createProxy(() => {})
p.log = () => {}

console.log('=== 0. 配置里确实有在校生设定 ===')
const cp = cfg.campus || {}
pass('K0', '年龄/年级/专业已生效', cp.age === 20 && Boolean(cp.grade) && Boolean(cp.major), `${cp.age} 岁 ${cp.grade} ${cp.major}`)
pass('K0b', '课表已配置', /\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(String(cp.classSlots || '')), cp.classSlots)

console.log('\n=== 1. 一天里的状态（用线上配置算） ===')
const at = (h, m) => {
  const d = new Date(2026, 9, 22) // 周四
  d.setHours(h, m, 0, 0)
  return d
}
const want = [
  [2, 30, 'sleep'],
  [8, 30, 'class'],
  [9, 45, 'after-class'],
  [12, 0, 'lunch'],
  [13, 20, 'nap'],
  [16, 20, null], // 由课表决定，只要求「不是上课」
  [21, 30, 'dorm'],
  [23, 50, 'lightsout']
]
for (const [h, m, key] of want) {
  const s = campusState(cfg, at(h, m))
  const ok = key ? s.key === key : s.key !== 'class'
  pass('K1', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, ok, `→ ${s.key} busy=${s.busy}`)
}
const weekend = campusState(cfg, new Date(2026, 9, 24, 9, 30))
pass('K1b', '周六 9:30 还在睡', weekend.key === 'sleep', `→ ${weekend.key}`)

console.log('\n=== 2. 状态注入到入站消息里 ===')
const captured = []
p.upstream = { readyState: 1, send: (payload) => captured.push(String(payload)) }

const mkFrame = (text) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: cfg.qq.adminQQ,
  self_id: cfg.qq.botQQ,
  message_id: 123456789,
  message: [{ type: 'text', data: { text } }],
  raw_message: text
})

// 走完整 dispatch：注入 → 交付（配置里已是 speed=1，不会挂起）
p.dispatch(JSON.stringify(mkFrame('在干嘛呢')), mkFrame('在干嘛呢'))
// dispatch 里的 deliver 是异步的（要先做图片本地化），等它一拍再断言
await new Promise((r) => setTimeout(r, 400))

const sent = captured.join('\n')
const nowState = campusState(cfg, new Date())
pass('K2', '注入里有【你现在的状态】', sent.includes('【你现在的状态'), nowState.label)
pass('K2b', '状态文本和此刻算出来的一致', sent.includes(nowState.line.slice(0, 12)))
pass('K2c', '主号没有被注入「按人设定」', !sent.includes('【本对话设定'))
pass('K2d', '原消息没被弄丢', sent.includes('在干嘛呢'))
pass('K2e', '确实只发了一帧', captured.length === 1, `捕获 ${captured.length} 帧`)

console.log('\n=== 3. 忙碌真的会压慢回复 ===')
const paceCfg = { reply: { pace: { enabled: true, mode: 'mix', instantRate: 100 } } }
const atClass = planPace(paceCfg, { hour: 10, chatting: false, busy: 2, unanswered: 0 })
const atSleep = planPace(paceCfg, { hour: 3, chatting: false, busy: 3, unanswered: 0 })
const atFree = planPace(paceCfg, { hour: 21, chatting: false, busy: 0, unanswered: 0 })
pass('K3', '上课中：即使用 100% 秒回也会拖', atClass.delayMs > 0, `${Math.round(atClass.delayMs / 60) / 1000} 分钟`)
pass('K3b', '睡着了：最长档', atSleep.band === 'long', atSleep.band)
pass('K3c', '闲着：秒回', atFree.delayMs === 0)

console.log('\n=== 4. 入站队列：不值得回的不回、值得回的攒着 ===')
p.inbox.clear()
p.pace.clear()
let dispatched = 0
const realDispatch = p.dispatch.bind(p)
p.dispatch = (...a) => {
  dispatched++
  realDispatch(...a)
}
p.queueMessage(JSON.stringify(mkFrame('嗯')), mkFrame('嗯'))
pass('K4', '单字「嗯」被跳过', dispatched === 0 && !p.inbox.size, `dispatched=${dispatched}`)
p.queueMessage(JSON.stringify(mkFrame('你今天上课到几点')), mkFrame('你今天上课到几点'))
pass('K4b', '有内容的消息被收下', p.inbox.size === 1, `队列 ${p.inbox.size}`)
for (const [, b] of p.inbox) clearTimeout(b.timer)
p.inbox.clear()
p.dispatch = realDispatch

console.log('\n=== 5. 关掉在校生设定后不注入 ===')
const offLine = moodLine({ persona: { moodEnabled: true }, campus: { ...cp, enabled: false } }, new Date())
pass('K5', '关掉后 moodLine 为空', offLine === '')
const offMood = moodLine({ persona: { moodEnabled: false }, campus: cp }, new Date())
pass('K5b', '「让它有当前状态」关掉后也为空', offMood === '')

console.log('\n=== 6. 有没有留下痕迹 ===')
const after = snap()
pass('K6', '没有新建/改动任何会话文件', JSON.stringify(before.files) === JSON.stringify(after.files), `${after.files.length} 个文件`)
pass('K6b', 'AGENTS.local.md 未变', before.agents === after.agents, before.agents.slice(0, 10))

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
