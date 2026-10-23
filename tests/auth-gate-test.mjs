/**
 * 未登录时必须「先给页面，再给登录框」，不能给一行 JSON
 *
 * 现象（2026-10-23 用户报的）：手机打开面板，满屏就一行 `未登录`，
 * 输入框影子都没有。电脑端看着正常。
 *
 * 根因：静态文件服务排在 `if (!authed(req)) return 401` 后面。
 * 未登录访问 `/` 直接被拦成 JSON，浏览器拿不到 HTML —— 页面里的登录层
 * 根本没机会渲染。电脑端"正常"只是因为 cookie 还在，不是它没问题。
 *
 * 本测试起一个真实 server（独立端口 + 临时数据目录），断言各路径的行为：
 *
 *   /            200 text/html    ← 页面必须能拿到
 *   /index.html  200 text/html
 *   /api/me      200 authed:false ← 前端靠它决定弹不弹登录框
 *   /api/state   401             ← 数据必须锁住
 *   /dsh/        401             ← dsh 界面能看到模型对话，必须锁住
 *   /dsh         401             ← 不带斜杠也不能漏
 *
 * 注意：必须在装了 `ws` 的机器上跑（server.js → proxy.js → ws）。
 * 本地没装依赖时请到服务器上跑：`node /opt/qqbot/tests/auth-gate-test.mjs`
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

const PORT = Number(process.env.T_PORT || 19680)
const PROXY_PORT = PORT + 1
const ROOT = process.env.T_ROOT || '/opt/qqbot'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authgate-'))
const ws = path.join(tmp, 'ws')
fs.mkdirSync(ws, { recursive: true })

// 一份「已设密码、没开免密」的配置 —— 正好是用户的线上状态
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify(
    {
      qq: { adminQQ: '10000' },
      auth: {
        // 假的 scrypt hash，只为让 hasPassword 成立；这个密码没人需要真的能登进去
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        salt: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        open: false,
        skipIPs: []
      },
      paths: { workspace: ws, stickers: path.join(ws, 'stickers') },
      proxy: { port: PROXY_PORT, enabled: true },
      dsh: { onebotPort: PROXY_PORT + 1, webPort: PROXY_PORT + 2 },
      stickers: { enabled: false, freq: 0 },
      proactive: { enabled: false },
      qzone: { enabled: false }
    },
    null,
    2
  ),
  'utf8'
)

const child = spawn(process.execPath, [path.join(ROOT, 'panel/server.js')], {
  env: {
    ...process.env,
    PANEL_PORT: String(PORT),
    PANEL_DATA: tmp,
    HOME: tmp, // 让 DSH_HOME 落到临时目录，别去动真的 cordis.patch.yml
    DSH_HOME_DIR: path.join(tmp, '.dsh')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const base = `http://127.0.0.1:${PORT}`

/** 等端口起来。启动要写一堆文件，给足 15 秒 */
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/me', { signal: AbortSignal.timeout(1000) })
      if (r.status) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function probe(p, opt = {}) {
  const r = await fetch(base + p, { redirect: 'manual', ...opt })
  const ct = r.headers.get('content-type') || ''
  let body = ''
  try {
    body = await r.text()
  } catch {
    /* ignore */
  }
  return { status: r.status, ct, body }
}

try {
  const up = await waitUp()
  if (!up) {
    console.log('服务器没起来，日志：\n' + out.slice(-1500))
    process.exit(1)
  }

  /* ---------- A 页面必须公开 ---------- */
  const root = await probe('/')
  pass('A1', '未登录访问 / 返回 200（不是 401）', root.status === 200, `HTTP ${root.status}`)
  pass('A2', '/ 返回的是 HTML', root.ct.includes('text/html'), root.ct)
  pass('A3', '/ 拿到的是完整页面（有 DOCTYPE）', root.body.trimStart().startsWith('<!DOCTYPE html'), root.body.slice(0, 30))
  pass('A4', '页面里带着登录门', root.body.includes('id="gate"'))
  pass('A5', '/ 不再是那行 JSON', !root.body.includes('"error":"未登录"'), root.body.slice(0, 60))

  const idx = await probe('/index.html')
  pass('A6', '/index.html 也公开', idx.status === 200 && idx.ct.includes('text/html'), `HTTP ${idx.status}`)

  /* ---------- B 手机 UA 一样能拿到页面 ---------- */
  const mobile = await probe('/', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    }
  })
  pass('B1', '手机 UA 拿到的也是 HTML', mobile.status === 200 && mobile.ct.includes('text/html'), `HTTP ${mobile.status} ${mobile.ct}`)
  pass('B2', '手机 UA 拿到的是同一个页面', mobile.body.length === root.body.length, `${mobile.body.length}B vs ${root.body.length}B`)

  /* ---------- C /api/me 必须公开，且说实话 ---------- */
  const me = await probe('/api/me')
  let meJson = null
  try {
    meJson = JSON.parse(me.body)
  } catch {
    /* ignore */
  }
  pass('C1', '/api/me 返回 200', me.status === 200, `HTTP ${me.status}`)
  pass('C2', '/api/me 明确说 authed:false', meJson && meJson.authed === false, JSON.stringify(meJson && meJson.authed))
  pass('C3', '/api/me 说 hasPassword 状态（needsSetup:false）', meJson && meJson.needsSetup === false, JSON.stringify(meJson && meJson.needsSetup))
  pass('C4', '/api/me 带上真实来源 IP', Boolean(meJson && meJson.ip), meJson && meJson.ip)

  /* ---------- D 数据必须锁住 ---------- */
  const st = await probe('/api/state')
  pass('D1', '/api/state 未登录 401', st.status === 401, `HTTP ${st.status}`)
  pass('D2', '/api/state 401 时带 error 字段', st.body.includes('未登录'), st.body.slice(0, 60))

  const cfg = await probe('/api/config')
  pass('D3', '/api/config 未登录 401', cfg.status === 401, `HTTP ${cfg.status}`)

  /* ---------- E dsh 代理必须锁住（这是最要紧的） ---------- */
  const dshSlash = await probe('/dsh/')
  pass('E1', '/dsh/ 未登录 401', dshSlash.status === 401, `HTTP ${dshSlash.status}`)
  const dshBare = await probe('/dsh')
  pass('E2', '/dsh（不带斜杠）也 401', dshBare.status === 401, `HTTP ${dshBare.status}`)
  const dshDeep = await probe('/dsh/plugins/??a.js,b.js&rev=1')
  pass('E3', '/dsh 深路径也 401', dshDeep.status === 401, `HTTP ${dshDeep.status}`)

  /* ---------- F 静态块的边界 ---------- */
  const nope = await probe('/nope.html')
  pass('F1', '不存在的静态路径 404（不是 401）', nope.status === 404, `HTTP ${nope.status}`)
  const trav = await probe('/../server.js')
  pass('F2', '穿越路径拿不到源码', trav.status !== 200 || !trav.body.includes('createServer'), `HTTP ${trav.status}`)

  /* ---------- G 源码层面锁死这次修法 ---------- */
  const src = fs.readFileSync(path.join(ROOT, 'panel/server.js'), 'utf8')
  const staticAt = src.indexOf('/* --- static（必须放在鉴权之前） ---')
  const authAt = src.indexOf("if (!authed(req)) return send(res, 401, { error: '未登录' })")
  pass('G1', '静态块在鉴权之前', staticAt > 0 && authAt > 0 && staticAt < authAt, `static@${staticAt} auth@${authAt}`)
  pass(
    'G2',
    '静态块排除了 /dsh 前缀',
    /!p\.startsWith\('\/dsh\/'\)/.test(src.slice(staticAt, staticAt + 900)),
    ''
  )
  const dshAt = src.indexOf("if (p === '/dsh' || p.startsWith('/dsh/'))")
  pass('G3', 'dsh 代理在鉴权之后', dshAt > authAt, `dsh@${dshAt} auth@${authAt}`)

  const html = fs.readFileSync(path.join(ROOT, 'panel/public/index.html'), 'utf8')
  pass('G4', '前端有 needLogin()', html.includes('function needLogin()'))
  pass('G5', 'api() 按状态码 401 判断（不是比 message 字符串）', /r\.status === 401/.test(html))
  pass('G6', '401 会打 authRequired 标记', html.includes('e.authRequired = true'))
  pass('G7', 'refresh 不再用 message 匹配 + reload', !html.includes("String(e.message).includes('未登录')"))
} finally {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400))
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
