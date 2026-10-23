import http from 'node:http'
import { execFile } from 'node:child_process'

/**
 * dsh web（服务器本机 3080）的反向代理。
 *
 * 背景：dsh web 的 UI 只绑 127.0.0.1:3080，且认证是「首访带 ?token=xxx → 种 30 天
 * cookie（dsh-auth-*，authority 写死 127.0.0.1:3080）→ 之后靠 cookie 访问」。
 * token 每次重启随机变，写在日志里。所以不能让浏览器直接去 3080，也不方便让用户
 * 自己抄 token。这里把整条链路收进面板后端：面板自己抓 token、持 cookie、中转，
 * iframe 只要指到面板自己的 /dsh/ 路径即可，点开就能看。
 *
 * 【关键】必须流式转发。
 * dsh 是 LLM 界面，回复是逐字吐出来的（chunked / 长连接），还有 WebSocket。
 * 早期版本用 `res.on('end')` 把整个响应攒成 Buffer 再发 —— 流永远不会 end，
 * 界面上就永远显示「正在连接」。这个坑踩过一次，别再改回缓冲式。
 */

const WEB_HOST = '127.0.0.1'
const WEB_PORT = 3080

/**
 * 从 dsh-web 日志里抽出最新的 token URL。
 *
 * 【坑】token 里含 `_` 和 `-`（如 `N-ovLRU8ff_4ejj...`、`...Jpv7Z-PAH6...`）。
 * 早期正则 `[A-Za-z0-9]+` 不含这两个字符，会把 token 在第一个 `_`/`-` 处截断，
 * 拿去换 cookie 必然 401 → authCookie 拿不到 → 界面显示「dsh web 没连上」。
 * 现在用 `[^\s"']+` 匹配到行尾/空白/引号为止，任何字符都能吃进来。
 *
 * 抽成纯函数导出，`tests/dsh-token-test.mjs` 直接喂各种日志样本验证。
 */
export function extractTokenUrl(logText) {
  const matches = String(logText || '').match(/http:\/\/127\.0\.0\.1:3080\/\?token=[^\s"']+/g)
  if (!matches || !matches.length) return null
  return matches[matches.length - 1]
}

// 从 dsh-web 的 systemd 日志里抓最新的 token URL
function fetchTokenUrl() {
  return new Promise((resolve) => {
    execFile(
      'journalctl',
      ['-u', 'dsh-web', '--no-pager', '--output=cat'],
      { timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        resolve(extractTokenUrl(stdout))
      }
    )
  })
}

// 当前持有的 dsh auth cookie（30 天有效，进程内缓存即可，失效再刷）
let authCookie = null
let cookieAt = 0
let cookiePending = null

/** 用 token 换一张 dsh cookie（不取 body，只看响应头） */
function exchangeToken(tokenUrl) {
  return new Promise((resolve) => {
    const tk = String(tokenUrl).replace(/^.*token=/, '')
    const req = http.request(
      {
        host: WEB_HOST,
        port: WEB_PORT,
        method: 'GET',
        path: `/?token=${encodeURIComponent(tk)}`,
        headers: { 'Accept-Encoding': 'identity' }
      },
      (res) => {
        const setCookie = res.headers['set-cookie']
        res.resume()
        if (!setCookie || !setCookie.length) return resolve(null)
        const dsh = setCookie.find((c) => c.startsWith('dsh-auth-'))
        resolve(dsh ? dsh.split(';')[0] : null)
      }
    )
    req.on('error', () => resolve(null))
    req.end()
  })
}

/**
 * 拿一个可用的 dsh cookie。有缓存直接用；过期就重抓 token 换一张。
 * cookiePending 去重：并发请求只换一次，否则会同时打好几次 journalctl。
 */
async function ensureCookie(force = false) {
  if (!force && authCookie && Date.now() - cookieAt < 29 * 86400 * 1000) return authCookie
  if (cookiePending) return cookiePending
  cookiePending = (async () => {
    const tokenUrl = await fetchTokenUrl()
    if (!tokenUrl) return null
    const val = await exchangeToken(tokenUrl)
    if (val) {
      authCookie = val
      cookieAt = Date.now()
    }
    return authCookie
  })()
  try {
    return await cookiePending
  } finally {
    cookiePending = null
  }
}

/** 要转发的请求头（挑需要的，避免把面板自己的 qp_auth 带过去） */
function pickHeaders(req) {
  const out = {}
  for (const k of [
    'user-agent',
    'accept',
    'accept-language',
    'content-type',
    'content-length',
    'x-requested-with',
    'range',
    'if-none-match',
    'if-modified-since'
  ]) {
    if (req.headers[k]) out[k] = req.headers[k]
  }
  // 明确 identity：不要压缩。压缩流会让 chunk 边界和长度变得难处理
  out['Accept-Encoding'] = 'identity'
  if (authCookie) out.Cookie = authCookie
  return out
}

/** 要回传给浏览器的响应头 */
function pickResHeaders(up) {
  const h = {}
  for (const k of [
    'content-type',
    'content-encoding',
    'cache-control',
    'etag',
    'last-modified',
    'content-range',
    'accept-ranges',
    'location'
  ]) {
    if (up.headers[k]) h[k] = up.headers[k]
  }
  // 故意不透传 content-length / transfer-encoding：
  // 上游可能是 chunked，管道转发时由 Node 自己决定分帧；硬抄 length 会在流式场景卡住
  return h
}

/**
 * 处理 /dsh/* 的普通 HTTP 请求：流式管道转发。
 * reqPath 是去掉 /dsh 前缀后的路径，含 ??、& 等字符，必须原样透传。
 */
export async function proxyDsh(req, res, reqPath) {
  await ensureCookie()
  if (!authCookie) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('dsh web 没连上或取不到认证（服务可能没起）。请先在概览页确认 dsh 状态。')
  }

  const forward = (path, retried) => {
    const headers = pickHeaders(req)

    const upReq = http.request(
      { host: WEB_HOST, port: WEB_PORT, method: req.method, path, headers },
      (upRes) => {
        // cookie 失效：清缓存重换一次（只重试一次，避免死循环）
        if (upRes.statusCode === 401 && !retried) {
          upRes.resume()
          ensureCookie(true)
            .then((c) => {
              if (!c) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
                return res.end('dsh web 认证失效且重取失败。')
              }
              forward(path, true)
            })
            .catch(() => {
              if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('dsh web 认证重取异常。')
            })
          return
        }

        res.writeHead(upRes.statusCode || 502, pickResHeaders(upRes))
        // 关键：直接管道，边收边发，不攒整包
        upRes.pipe(res)
        upRes.on('error', () => res.destroy())
      }
    )

    upReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dsh web 未连接')
    })

    // 请求体同样流式转发（上传文件、长请求用得上）
    req.pipe(upReq)
  }

  forward(reqPath, false)
}

/**
 * 处理 /dsh/* 的 WebSocket 升级：把客户端 socket 和上游 socket 对接。
 * 缺这一步，前端任何 WS 都会握手失败，表现同样是「一直在连接」。
 */
export async function proxyDshUpgrade(req, socket, head, reqPath) {
  await ensureCookie()
  if (!authCookie) {
    socket.destroy()
    return
  }

  const headers = pickHeaders(req)
  headers.Connection = 'Upgrade'
  headers.Upgrade = req.headers.upgrade || 'websocket'
  for (const k of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    if (req.headers[k]) {
      headers[k.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] = req.headers[k]
    }
  }

  const upReq = http.request({
    host: WEB_HOST,
    port: WEB_PORT,
    method: 'GET',
    path: reqPath,
    headers
  })

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    // 把上游 101 原样回给浏览器
    let head101 = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      head101 += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`
    }
    head101 += '\r\n'
    socket.write(head101)

    if (upHead && upHead.length) upSocket.unshift(upHead)
    if (head && head.length) upSocket.write(head)

    upSocket.pipe(socket)
    socket.pipe(upSocket)

    const bye = () => {
      upSocket.destroy()
      socket.destroy()
    }
    upSocket.on('error', bye)
    socket.on('error', bye)
    upSocket.on('close', bye)
    socket.on('close', bye)
  })

  // 上游不认这个升级（返回普通响应）→ 把状态码回给客户端就断开
  upReq.on('response', (upRes) => {
    socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}\r\n\r\n`)
    upRes.resume()
    socket.destroy()
  })

  upReq.on('error', () => socket.destroy())
  upReq.end()
}
