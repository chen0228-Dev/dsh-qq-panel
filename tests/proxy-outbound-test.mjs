/**
 * 出站链路回归测试：dsh 发来的 send_private_msg 必须真的送到 NapCat 那边。
 *
 * 盯的是 2026-10-23 线上那次事故：`plain` 被声明在 `if (outFrame)` 块里，
 * 块外「记语料」那行引用它 → 每条出站消息都抛
 * `ReferenceError: plain is not defined`，消息一条都没发出去，而且异常从
 * ws 的 message 事件里抛出去，把上游连接的 close 事件也一起吃掉了。
 *
 * 所以这里断言两件事：
 *   1. 消息能被转发到 NapCat（旧代码会因为异常直接不发）；
 *   2. 处理过程中的异常不会冒到进程外（有 try/catch 兜住）。
 *
 * 跑法（在 /opt/qqbot 下）：node tests/proxy-outbound-test.mjs
 * 全程用临时 PANEL_DATA + 随机端口，不碰生产 config、不连真 dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ws 装在 panel/node_modules 下（测试从 /opt/qqbot 跑，自身没有 node_modules）
const require = createRequire(new URL('../panel/package.json', import.meta.url))
const { WebSocketServer, WebSocket } = require('ws')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-outbound-'))
const UP_PORT = 18645
const NAPCAT_PORT = 18643
const TOKEN = 'test-token'

fs.writeFileSync(
  path.join(TMP, 'config.json'),
  JSON.stringify({
    dsh: { onebotPort: UP_PORT, accessToken: TOKEN },
    proxy: { port: NAPCAT_PORT },
    pacing: { enabled: false },
    typing: { enabled: false }
  })
)
process.env.PANEL_DATA = TMP

const { createProxy } = await import('../panel/lib/proxy.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const logs = []
const proxy = createProxy((m) => logs.push(String(m)))

// 进程级兜底：旧代码的 ReferenceError 会从这里冒出来，直接算失败
let escaped = null
process.on('uncaughtException', (e) => {
  escaped = e
  console.log(`  !! 逃逸到进程外的异常: ${e.message}`)
})

const up = new WebSocketServer({ host: '127.0.0.1', port: UP_PORT, path: '/ws' })
let upSock = null
const upReady = new Promise((resolve) => {
  up.on('connection', (s) => {
    upSock = s
    resolve()
  })
})

proxy.start()

const napcat = new WebSocket(`ws://127.0.0.1:${NAPCAT_PORT}/ws`, {
  headers: { Authorization: `Bearer ${TOKEN}` }
})
const received = []
napcat.on('message', (d) => received.push(d.toString()))
await new Promise((resolve, reject) => {
  napcat.on('open', resolve)
  napcat.on('error', reject)
})
await upReady
ok('上游连接建立', proxy.status().dsh === true)

// dsh 发一条普通回复（正是线上抛异常的那条路径）
upSock.send(
  JSON.stringify({
    action: 'send_private_msg',
    params: { user_id: 10001, message: [{ type: 'text', data: { text: '今天有点累，早点睡吧' } }] },
    echo: 'e2e-1'
  })
)

const deadline = Date.now() + 20000
while (Date.now() < deadline && !received.some((t) => t.includes('今天有点累'))) await sleep(200)

const hit = received.find((t) => t.includes('今天有点累'))
ok('消息转发到 NapCat', Boolean(hit), `收到 ${received.length} 帧`)
ok('回执带 echo（dsh 才不会等 30 秒超时）', Boolean(hit && hit.includes('e2e-1')))
ok('没有异常逃逸到进程外', escaped === null, escaped ? escaped.message : '')
ok('日志里没有 plain is not defined', !logs.some((l) => l.includes('plain is not defined')))

// 断线期间的心跳不该占补投队列（否则 30 秒一条，几分钟就把队列挤满）
upSock.close()
await sleep(300)
const before = logs.length
proxy.forwardUp(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 }), false)
await sleep(100)
const queued = logs.slice(before).some((l) => l.includes('消息进队列'))
ok('心跳不进补投队列', !queued)

// 探活兜底：上游还挂着 OPEN，但对 ping 一声不吭 —— 必须自己判定连接已死并重连。
// 线上那次「假在线 20 分钟」就是 close 事件根本没来，只能靠这个闹钟。
let pings = 0
let terminated = false
proxy.upstream = {
  readyState: WebSocket.OPEN,
  ping() {
    pings++
  },
  terminate() {
    terminated = true
  }
}
proxy.missedPings = 0
proxy.retryTimer = null
for (let i = 0; i < 4; i++) proxy.checkUpstream()
ok('连续无 pong 会主动断开', terminated === true, `ping ${pings} 次`)
ok('断开后置空上游并安排重连', proxy.upstream === null && proxy.retryTimer !== null)

proxy.stop()
napcat.close()
up.close()

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
