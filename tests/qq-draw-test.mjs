#!/usr/bin/env node
/**
 * qq-draw 客户端的成功分支验证。
 *
 * 为什么单独搭一个 mock：真实生图要第三方 key，没有凭证就不能假装测过。
 * 这里只验证「面板返回 ok + file 时，CLI 是否把路径原样打到 stdout」，
 * 以及 --out 拷贝、后端报错透传两条路径。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

let pass = 0
let fail = 0
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`  ok  ${n}${e ? ' — ' + e : ''}`) }
  else { fail++; console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-'))
const img = path.join(dir, 'real.png')
fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'))

let mode = 'ok'
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const auth = req.headers['x-panel-token']
  if (auth !== 'k'.repeat(32)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: '仅限本机工具调用' }))
  }
  if (mode === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: '上游 401：key 无效' }))
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, file: img, bytes: 8 }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`

const tokenFile = path.join(dir, 'internal.token')
fs.writeFileSync(tokenFile, 'k'.repeat(32))
// 服务器上工具装在 /usr/local/bin，源码目录不随部署走；
// 用 QQDRAW 覆盖，找不到就用部署位置，最后才回落到仓库里的源码。
const script =
  process.env.QQDRAW ||
  (fs.existsSync(path.join(import.meta.dirname, '..', 'tools', 'caps', 'qq-draw'))
    ? path.join(import.meta.dirname, '..', 'tools', 'caps', 'qq-draw')
    : '/usr/local/bin/qq-draw')
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
// 必须异步 spawn：mock 服务和测试在同一个进程里，同步等待会把事件循环堵死，
// 子进程发出的请求永远等不到响应，最后只能超时（第一次就是这么挂的）。
const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(py, [script, ...args], {
      env: { ...process.env, QQPANEL_URL: url, QQPANEL_TOKEN_FILE: tokenFile },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    const timer = setTimeout(() => child.kill(), 15000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out: out.trim(), err: err.trim() })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 99, out: '', err: String(e.message) })
    })
  })

try {
  console.log('\n[1] 成功路径')
  const a = await run(['一只橘猫，简笔画'])
  ok('退出码 0', a.code === 0)
  ok('stdout 就是图片路径', a.out === img, a.out)

  console.log('\n[2] --out 另存')
  const copy = path.join(dir, 'copy.png')
  const b = await run(['猫', '-o', copy])
  ok('退出码 0', b.code === 0)
  ok('打印的是新路径', b.out === copy, b.out)
  ok('文件确实复制过去', fs.existsSync(copy))

  console.log('\n[3] 后端报错透传')
  mode = 'fail'
  const c = await run(['猫'])
  ok('非 0 退出', c.code !== 0)
  ok('把后端原因带出来', /key 无效/.test(c.err || ''), c.err)

  console.log('\n[4] 空描述')
  const d = await run(['   '])
  ok('拒绝空描述', d.code !== 0)
} finally {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
