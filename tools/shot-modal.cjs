// 用 CDP 打开面板 → 点开「访客默认」弹窗 → 截图（headless Edge 不支持交互，只能走调试协议）
const fs = require('node:fs')
const path = require('node:path')

const PORT = process.env.CDP_PORT || '9333'
const OUT = process.argv[2] || path.join(process.env.TEMP, 'profile-modal.png')

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('<server-ip>'))
  if (!page) throw new Error('没找到面板页面标签：' + JSON.stringify(list.map((t) => t.url)))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => pending.has(mid) && reject(new Error('timeout ' + method)), 15000)
    })

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }

  await new Promise((r) => (ws.onopen = r))
  await send('Page.enable')
  await send('Runtime.enable')
  await new Promise((r) => setTimeout(r, 2500))
  const r = await send('Runtime.evaluate', {
    expression: process.argv[3] || "typeof openProfile === 'function' ? (openProfile('', ''), 'opened') : 'no fn'",
    returnByValue: true
  })
  console.log('evaluate:', JSON.stringify(r.result?.value))
  await new Promise((r) => setTimeout(r, 800))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('saved', OUT)
  ws.close()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
