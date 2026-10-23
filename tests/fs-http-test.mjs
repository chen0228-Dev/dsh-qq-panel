/**
 * 文件管理器 HTTP 层端到端测试
 *
 * 起一个独立 server（临时 PANEL_DATA + 免密），真实打 /api/fs/* 接口，
 * 验证：列目录、上传、建夹、复制、移动、删除、下载、路径穿越拦截。
 *
 * 只能在装了 ws 的机器上跑（server.js → proxy.js → ws），本地请到服务器跑：
 *   node /opt/qqbot/tests/fs-http-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const PORT = Number(process.env.T_PORT || 19690)
const PROXY_PORT = PORT + 1
const ROOT = process.env.T_ROOT || '/opt/qqbot'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fshttp-'))
const ws = path.join(tmp, 'ws')
fs.mkdirSync(ws, { recursive: true })

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  qq: { adminQQ: '10000' },
  auth: { open: true, skipIPs: [] },   // 免密，只测文件功能
  paths: { workspace: ws, stickers: path.join(ws, 'stickers') },
  proxy: { port: PROXY_PORT, enabled: true },
  dsh: { onebotPort: PROXY_PORT + 1, webPort: PROXY_PORT + 2 },
  stickers: { enabled: false, freq: 0 },
  proactive: { enabled: false },
  qzone: { enabled: false }
}, null, 2), 'utf8')

const child = spawn(process.execPath, [path.join(ROOT, 'panel/server.js')], {
  env: { ...process.env, PANEL_PORT: String(PORT), PANEL_DATA: tmp, HOME: tmp, DSH_HOME_DIR: path.join(tmp, '.dsh') },
  stdio: ['ignore', 'pipe', 'pipe']
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const base = `http://127.0.0.1:${PORT}`

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/me', { signal: AbortSignal.timeout(1000) }); if (r.status) return true } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const j = async (r) => { try { return await r.json() } catch { return {} } }

try {
  if (!(await waitUp())) { console.log('起不来：\n' + out.slice(-1200)); process.exit(1) }

  /* 1 根目录（启动时会自动生成 AGENTS.md / .capabilities.json 等，不要求空） */
  let r = await fetch(base + '/api/fs/list?path='); let d = await j(r)
  pass('H1a', '列根目录 200 且是目录', r.status === 200 && d.dir === true && Array.isArray(d.items), `items=${d.items ? d.items.length : 'n/a'}`)
  pass('H1b', '返回 root 路径', d.root === ws, d.root)

  /* 2 建夹 + 上传 */
  r = await fetch(base + '/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'docs' }) })
  pass('H2a', '建文件夹', (await j(r)).ok === true)
  r = await fetch(base + '/api/fs/upload?path=docs&name=hello.txt', { method: 'POST', body: Buffer.from('你好，世界') })
  pass('H2b', '上传文件', (await j(r)).ok === true)
  r = await fetch(base + '/api/fs/list?path=docs'); d = await j(r)
  pass('H2c', 'docs 里有 hello.txt', d.items.length === 1 && d.items[0].name === 'hello.txt' && d.items[0].size === 15)

  /* 3 复制 + 移动 + 删除 */
  r = await fetch(base + '/api/fs/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'docs/hello.txt', to: 'docs/copy.txt' }) })
  pass('H3a', '复制', (await j(r)).ok === true)
  r = await fetch(base + '/api/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'docs/copy.txt', to: 'moved.txt' }) })
  pass('H3b', '移动', (await j(r)).ok === true)
  r = await fetch(base + '/api/fs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'moved.txt' }) })
  pass('H3c', '删除', (await j(r)).ok === true)

  /* 4 下载 */
  r = await fetch(base + '/api/fs/download?path=docs/hello.txt')
  const txt = await r.text()
  pass('H4a', '下载文件内容正确', r.status === 200 && txt === '你好，世界')

  /* 5 路径穿越拦截（安全红线） */
  r = await fetch(base + '/api/fs/list?path=' + encodeURIComponent('../etc'))
  pass('H5a', '列 ../etc 被 403', r.status === 403)
  r = await fetch(base + '/api/fs/download?path=' + encodeURIComponent('../../etc/passwd'))
  pass('H5b', '下载 /etc/passwd 被 403', r.status === 403)
  r = await fetch(base + '/api/fs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '..' }) })
  pass('H5c', '删根目录被拒', r.status === 400)
  r = await fetch(base + '/api/fs/upload?path=..&name=evil.txt', { method: 'POST', body: 'x' })
  pass('H5d', '上传到 .. 被 403', r.status === 403)

  /* 6 上传的文件名带 ../ 也被拦（400 非法文件名） */
  r = await fetch(base + '/api/fs/upload?path=&name=' + encodeURIComponent('../escape.txt'), { method: 'POST', body: 'x' })
  pass('H6a', '文件名穿越被拦', r.status === 400, `HTTP ${r.status}`)

  /* 7 文件夹上传：路径里带子目录要能传，且目录结构要建出来 */
  r = await fetch(
    base + '/api/fs/upload?path=&name=' + encodeURIComponent('我的资料/2026/图.png'),
    { method: 'POST', body: 'fake-png' }
  )
  pass('H7a', '带子目录的文件能上传', r.status === 200, `HTTP ${r.status}`)
  pass('H7b', '子目录被自动建出来', fs.existsSync(path.join(ws, '我的资料', '2026', '图.png')))
  r = await fetch(base + '/api/fs/upload?path=&name=' + encodeURIComponent('我的资料/说明.txt'), { method: 'POST', body: 'hi' })
  pass('H7c', '同一文件夹的第二个文件也能传', r.status === 200 && fs.existsSync(path.join(ws, '我的资料', '说明.txt')))
  const listing = await j(await fetch(base + '/api/fs/list?path='))
  pass('H7d', '列表里能看到新文件夹', (listing.items || []).some((i) => i.name === '我的资料' && i.dir))

  /* 8 放行子目录不等于放行穿越：这些必须全被拒 */
  const bad = [
    ['..', '纯 ..'],
    ['../x.txt', '开头 ..'],
    ['a/../../x.txt', '中间 ..'],
    ['a/./x.txt', '单点段'],
    ['/etc/x.txt', '绝对路径'],
    ['C:/x.txt', 'Windows 盘符'],
    ['a//x.txt', '空段'],
    ['a\\..\\x.txt', '反斜杠穿越'],
    ['', '空名字']
  ]
  for (const [name, label] of bad) {
    const res = await fetch(base + '/api/fs/upload?path=&name=' + encodeURIComponent(name), { method: 'POST', body: 'x' })
    pass('H8', `${label} 被拒`, res.status === 400 || res.status === 403, `HTTP ${res.status}`)
  }
  pass('H8z', '没有文件被写到根目录外', !fs.existsSync(path.join(tmp, 'x.txt')) && !fs.existsSync('/etc/x.txt'))
} finally {
  try { child.kill('SIGTERM') } catch {}
  await new Promise((r) => setTimeout(r, 400))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
