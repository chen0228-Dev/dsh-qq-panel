/**
 * tts 命令测试：确认它不再自己写死音色，而是把面板配置交给合成接口。
 *
 * 背景（线上 bug）：面板调好音色/语速后，QQ 里收到的是另一个声音。
 * 原因是 /usr/local/bin/tts 是独立 bash 脚本，写死了
 * `edge-tts --voice zh-CN-XiaoyiNeural --rate "+8%"`，从不读面板配置。
 * 现在 tts 只做一件事：把文字（和可选音色）交给 /api/voice/synth。
 *
 * 这里对着 mock 面板跑，验证「发给后端的是什么」——不需要真实 TTS 额度。
 *
 * 跑法：node tests/tts-cli-test.mjs
 * 需要 python3（服务器自带；本地用 PYTHON 环境变量指定）。
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'))
const audio = path.join(dir, 'out.mp3')
fs.writeFileSync(audio, Buffer.from('ID3fake', 'utf8'))

let mode = 'ok'
let lastBody = null
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const auth = req.headers['x-panel-token']
  if (auth !== 'k'.repeat(32)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: '仅限本机工具调用' }))
  }
  lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (mode === 'fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: '火山 TTS 55000000' }))
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, file: audio }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`

const tokenFile = path.join(dir, 'internal.token')
fs.writeFileSync(tokenFile, 'k'.repeat(32))
// 服务器上工具装在 /usr/local/bin，源码目录不随部署走；
// 用 TTSBIN 覆盖，找不到就用部署位置，最后才回落到仓库里的源码。
const script =
  process.env.TTSBIN ||
  (fs.existsSync(path.join(import.meta.dirname, '..', 'tools', 'tts'))
    ? path.join(import.meta.dirname, '..', 'tools', 'tts')
    : '/usr/local/bin/tts')
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')

// 必须异步 spawn：mock 和测试同进程，同步等待会堵死事件循环（qq-draw 那边踩过）
const run = (args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(py, [script, ...args], {
      env: { ...process.env, QQPANEL_URL: url, QQPANEL_TOKEN_FILE: tokenFile, ...env },
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
  console.log('\n[1] 不指定音色：完全跟随面板配置')
  const a = await run(['你好呀，我是这样说话的'])
  ok('退出码 0', a.code === 0, a.err)
  ok('打印音频路径', a.out === audio, a.out)
  ok('只提交 text', Object.keys(lastBody || {}).join(',') === 'text', JSON.stringify(lastBody))
  ok('不自己塞音色', !('voiceName' in (lastBody || {})), '这是修复的关键：以前写死 XiaoyiNeural')

  console.log('\n[2] 显式指定 Edge 音色')
  const b = await run(['换个声音', 'zh-CN-XiaoxiaoNeural'])
  ok('退出码 0', b.code === 0, b.err)
  ok('音色原样传递', lastBody?.voiceName === 'zh-CN-XiaoxiaoNeural', String(lastBody?.voiceName))
  ok('正文没把音色吃进去', lastBody?.text === '换个声音', String(lastBody?.text))

  console.log('\n[3] 简写音色')
  const c = await run(['再换一个', 'Xiaoyi'])
  ok('Xiaoyi 补全为完整名字', lastBody?.voiceName === 'zh-CN-XiaoyiNeural', String(lastBody?.voiceName))

  console.log('\n[4] 正文里出现英文单词不能被当音色')
  const d = await run(['好的', 'OK'])
  ok('OK 留在正文里', lastBody?.text === '好的 OK', String(lastBody?.text))
  ok('没有乱造音色', !('voiceName' in (lastBody || {})), JSON.stringify(lastBody?.voiceName))

  console.log('\n[5] 后端报错要透传')
  mode = 'fail'
  const e = await run(['测试'])
  ok('非 0 退出', e.code !== 0)
  ok('带出后端原因', /55000000/.test(e.err || ''), e.err)

  console.log('\n[6] 空内容与缺令牌')
  const f = await run(['   '])
  ok('空内容拒绝', f.code !== 0)
  const g = await run(['你好'], { QQPANEL_TOKEN_FILE: path.join(dir, 'missing.token') })
  ok('缺令牌时明确报错', g.code !== 0 && /令牌/.test(g.err), g.err)
} finally {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
