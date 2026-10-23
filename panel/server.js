import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  loadConfig,
  saveConfig,
  publicConfig,
  setPassword,
  checkPassword,
  signSession,
  verifySession,
  writeDshProfile,
  writePersona,
  writeCapabilities,
  loadState,
  patchState,
  getState,
  whitelistAdminUsers,
  sanitizeOverrides,
  resolveProfile,
  setProfiles,
  inferResourceId,
  EMOTION_INSTRUCTIONS,
  DATA_DIR,
  DSH_HOME,
  MASK
} from './lib/store.js'
import { createProxy } from './lib/proxy.js'
import { createProactive } from './lib/proactive.js'
import { campusState, campusTimeline, todaysEvents, loadExtraEvents, normalizeEventsPerDay } from './lib/campus.js'
import { JOBS, templateFor } from './lib/campus-templates.js'
import { assocInfo } from './lib/assoc.js'
import { opinionInfo, deleteStance } from './lib/opinion.js'
import { collectStats } from './lib/stats.js'
import { proxyDsh, proxyDshUpgrade } from './lib/dsh-proxy.js'
import { resolveInRoot, listDir, formatSize, exists, copyPath, movePath, deletePath, mkdir as fsMkdir } from './lib/fsapi.js'
import { generateImage, transcribeAudio, endpoint, safeError, IMAGE_LIMIT } from './lib/multimodal.js'
import { loadSlang, saveSlang, addWords, buildLearnPrompt, buildResearchPrompt } from './lib/slang.js'
import {
  listStickers,
  countStickers,
  saveSticker,
  removeSticker,
  loadIndex,
  saveIndex,
  todayStats
} from './lib/stickers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const PORT = Number(process.env.PANEL_PORT || 18080)
const BIND = process.env.PANEL_BIND || '0.0.0.0'

/* ---------------- logger ---------------- */
const ring = []
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  ring.push(line)
  if (ring.length > 400) ring.shift()
  console.log(line)
}

/* ---------------- helpers ---------------- */
function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

/* ---------------- QQ 扫码登录 ----------------
 * NapCat 未登录时会把登录二维码画到容器内的 /app/napcat/cache/qrcode.png，
 * 而且每次刷新都会覆盖。这个文件在容器文件系统里（没挂到宿主机），
 * 只能通过 docker exec 读出来。一次 exec 同时取 mtime + base64，省一次进程开销。
 */
let qrCache = { at: 0, b64: '', mtime: 0, err: null }

async function readQrcode(force = false) {
  if (!force && Date.now() - qrCache.at < 2500) return qrCache
  const r = await run(
    'docker',
    [
      'exec',
      'napcat',
      'sh',
      '-c',
      'm=$(stat -c %Y /app/napcat/cache/qrcode.png 2>/dev/null || echo 0); echo "$m"; echo "@@@"; base64 /app/napcat/cache/qrcode.png 2>/dev/null | tr -d "\\n"'
    ],
    8000
  )
  const text = r.stdout || ''
  const i = text.indexOf('@@@')
  if (!r.ok || i < 0) {
    qrCache = { at: Date.now(), b64: '', mtime: 0, err: (r.stderr || '读不到容器里的二维码').trim().slice(0, 200) }
    return qrCache
  }
  const mtime = Number(text.slice(0, i).trim()) || 0
  const b64 = text.slice(i + 3).trim()
  qrCache = { at: Date.now(), b64, mtime, err: b64 ? null : '二维码文件为空（NapCat 可能还没生成）' }
  return qrCache
}

/**
 * 检测 NapCat 是否卡在「登录失败」状态。
 *
 * 为什么需要：NapCat 扫码登录失败（ErrType 1 ErrCode 5 = 二维码过期/超时）后，
 * **不会自动重新生成二维码**，进程就停在那儿。面板前端每 5 秒轮询、点「换一张」
 * force 重新读文件，读到的还是那个旧 qrcode.png —— 用户看到的就是「刷新不出新二维码」。
 * 这不是前端缓存，是 NapCat 根本没生成新的。
 *
 * 所以这里扫 docker logs 看有没有 Login Error：有 + 当前没登录 = 必须重启 NapCat
 * 才能重新走登录流程。只在未登录时调用，成功登录后那条旧 Error 日志不构成误判。
 */
let napcatErrCache = { at: 0, val: null }
async function napcatLoginError() {
  if (Date.now() - napcatErrCache.at < 5000) return napcatErrCache.val
  const r = await run('docker', ['logs', 'napcat', '--tail', '40'], 6000)
  const text = (r.stdout || '') + (r.stderr || '')
  const m = text.match(/Login Error,ErrType:\s*(\d+)\s+ErrCode:\s*(\d+)/)
  napcatErrCache = { at: Date.now(), val: m ? { errType: Number(m[1]), errCode: Number(m[2]) } : null }
  return napcatErrCache.val
}

const loginHits = new Map()
function hitLimit(ip) {
  const now = Date.now()
  const rec = loginHits.get(ip) || { count: 0, until: 0 }
  if (rec.until > now) return Math.ceil((rec.until - now) / 1000)
  return 0
}
function recordHit(ip, ok) {
  if (ok) {
    loginHits.delete(ip)
    return
  }
  const now = Date.now()
  const rec = loginHits.get(ip) || { count: 0, until: 0 }
  rec.count += 1
  if (rec.count >= 5) {
    rec.until = now + 10 * 60 * 1000
    rec.count = 0
  }
  loginHits.set(ip, rec)
}

function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * 访问者的真实 IP。
 *
 * X-Forwarded-For 只在**直连方是本机**时才采信：现在没有反向代理，
 * 要是无条件相信这个头，任何人伪造一个 `X-Forwarded-For: 信任IP` 就能免密进来。
 */
function clientIP(req) {
  const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const local = raw === '127.0.0.1' || raw === '::1'
  if (local) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xf) return xf
  }
  return raw
}

/**
 * IP 是否命中信任列表。
 * 支持三种写法：精确 `1.2.3.4`、前缀 `1.2.3.`、通配 `1.2.3.*`。
 * 前缀/通配是为了家宽动态 IP 只有后两位会变的情况。
 */
function ipTrusted(ip, list) {
  if (!ip || !Array.isArray(list) || !list.length) return false
  return list.some((pat) => {
    const p = String(pat || '').trim()
    if (!p) return false
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      return re.test(ip)
    }
    return ip === p || ip.startsWith(p)
  })
}

/** 等长常量时间比较，避免按字符提前返回泄露前缀（长度不同直接 false） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y)
}

/**
 * 本机 CLI（qq-draw）用的内部令牌。
 *
 * 为什么不用「本机免登录」：loopback 判断只保证「来自这台机器」，机器上任何
 * 进程都能打 127.0.0.1:18080。生图是花钱的接口，给个固定 token 文件（0600）
 * 更稳妥 —— CLI 以 root 读同一个文件，别人拿不到。
 *
 * 文件缺失/被删会重建；令牌只落在 panel/data 下，不写日志、不进 API 响应。
 */
const INTERNAL_TOKEN_FILE = path.join(DATA_DIR, 'internal.token')
function internalToken() {
  try {
    const t = fs.readFileSync(INTERNAL_TOKEN_FILE, 'utf8').trim()
    if (t.length >= 32) return t
  } catch {
    /* 不存在就重建 */
  }
  const t = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(INTERNAL_TOKEN_FILE, t + '\n', { mode: 0o600 })
  return t
}
function internalAuthed(req) {
  const given = String(req.headers['x-panel-token'] || '')
  return safeEqual(given, internalToken())
}


/**
 * 这里决定了「要不要输密码」。
 *
 * 顺序是：彻底免密 → 信任 IP 免密 → 会话 cookie。
 * 第三种才是原来那条路，前两种是后加的，因为用户嫌每次重启都要重输。
 */
function authed(req) {
  const cfg = loadConfig()
  if (cfg.auth.open) return true
  if (ipTrusted(clientIP(req), cfg.auth.skipIPs)) return true
  return verifySession(parseCookies(req).qp_auth)
}

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body)
  const payload = isObj ? JSON.stringify(body) : body
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(payload)
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const buf = await readBody(req)
  try {
    return JSON.parse(buf.toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/* ---------------- proxy ---------------- */
const proxy = createProxy(log)
const proactive = createProactive(proxy, log)

/* ---------------- 黑话学习 ---------------- */
const SLANG_FILE = path.join(DATA_DIR, 'slang.json')

/**
 * 出站回调：她把生词标出来、或回了学词/释义回执时，这里负责落库。
 *
 * 注意「写文件失败不能把消息链路带崩」：hook 内部全 catch，
 * 最坏情况是这次没学到词，聊天照常。
 */
proxy.setSlangHook((payload) => {
  try {
    const entries = loadSlang(SLANG_FILE)
    if (payload.kind === 'meanings') {
      let n = 0
      for (const it of payload.items || []) {
        const idx = entries.findIndex((e) => e.word === it.word)
        if (idx < 0) continue
        entries[idx] = {
          ...entries[idx],
          meaning: it.meaning || entries[idx].meaning,
          usage: it.usage || entries[idx].usage,
          example: it.example || entries[idx].example,
          status: it.confirmed ? 'confirmed' : entries[idx].status,
          updatedAt: new Date().toISOString()
        }
        n++
      }
      if (!n) return
      saveSlang(SLANG_FILE, entries)
      log(`释义回填 ${n} 条`)
      // 「确认」会改变注入内容，得重写 AGENTS.md 才生效
      writePersona()
      return
    }
    const r = addWords(entries, payload.words || [], payload.evidence || [])
    if (!r.added && !r.bumped) return
    saveSlang(SLANG_FILE, r.entries)
    log(`生词入库：新增 ${r.added}，累加 ${r.bumped}`)
  } catch (e) {
    log(`黑话入库失败：${e.message}`)
  }
})

/** 手动/定时触发一次学词任务（注入内部回合，她回 `[[学词]] {JSON}` 后由 hook 落库） */
function runSlangLearn() {
  const cfg = loadConfig()
  if (cfg.slang?.enabled === false) throw new Error('黑话学习已关闭')
  const recent = proxy.recentSlang(120)
  if (recent.length < 6) throw new Error(`最近对话太少（${recent.length} 条），先聊几句再来`)
  const known = loadSlang(SLANG_FILE).map((e) => e.word)
  proxy.injectPrivateMessage(buildLearnPrompt(recent, known), {
    selfId: getState().botQQ || cfg.qq.botQQ
  })
  log(`已注入学词任务（语料 ${recent.length} 条，已学 ${known.length} 个）`)
  return { corpus: recent.length, known: known.length }
}

/** 让研究候选词的含义（同样走内部回合，回 `[[释义]] [...]`） */
function runSlangResearch(ids) {
  const cfg = loadConfig()
  if (cfg.slang?.enabled === false) throw new Error('黑话学习已关闭')
  const entries = loadSlang(SLANG_FILE)
  const want = Array.isArray(ids) ? ids.map(String) : []
  const picked = want.length
    ? entries.filter((e) => want.includes(e.id))
    : entries.filter((e) => e.status === 'candidate' && !e.meaning).slice(0, 10)
  if (!picked.length) throw new Error('没有需要研究的词（候选词都是空的话，试试先点一次「学习」）')
  proxy.injectPrivateMessage(buildResearchPrompt(picked), {
    selfId: getState().botQQ || cfg.qq.botQQ
  })
  log(`已注入释义研究任务：${picked.map((e) => e.word).slice(0, 6).join('、')}`)
  return { count: picked.length }
}

/**
 * 每日自动学词。
 *
 * 用「到点 + 当天只跑一次」而不是 cron：面板本身常驻，60 秒轮询足够，
 * 不需要额外依赖。重启后 lastLearnDay 清空，同一天可能再跑一次 ——
 * 这点重复无害（学词是幂等的，同一个词只会累加 count）。
 */
let lastLearnDay = ''
function slangScheduler() {
  try {
    const cfg = loadConfig()
    if (cfg.slang?.enabled === false || cfg.slang?.learnDaily === false) return
    const want = String(cfg.slang?.learnAt || '23:30')
    const now = new Date()
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    if (hhmm !== want || lastLearnDay === day) return
    lastLearnDay = day
    runSlangLearn()
  } catch (e) {
    log(`定时学词跳过：${e.message}`)
  }
}
setInterval(slangScheduler, 60_000)

/* ---------------- media helpers ---------------- */
function loopback(req) {
  const a = String(req.socket.remoteAddress || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/* ---------------- TTS ---------------- */

/**
 * 情感：用自然语言指令（context_texts），不用 emotion 字段。
 * 详见 store.js 的 `EMOTION_INSTRUCTIONS` 注释和实测数据。
 * 官方 2.0 音色是「指令遵循」型，emotion 字段对它几乎无效。
 */

/**
 * 火山引擎语音合成（V3 单向流式接口）。
 *
 * 同一个接口同时支持两类音色，靠 `X-Api-Resource-Id` 区分：
 *   官方音色库（`*_uranus_bigtts`）→ seed-tts-2.0
 *   自己复刻的（`S_xxx`）          → seed-icl-2.0
 * 两代不能混用，配错直接 `55000000`。`inferResourceId()` 负责把这一层挡住。
 *
 * 为什么不是 V1：V1 那套 `appid + token + cluster` 只对**旧体系**开通的资源有效。
 * 实测声音复刻 2.0 的音色（S_xxx）在 V1 上只会返回
 * `code=3001 [resource_id=volc.megatts.default] requested resource not granted`——
 * 不是没开通，而是这个音色属于新体系，要走 V3 + `X-Api-Resource-Id: seed-icl-2.0`。
 *
 * V3 的返回是一行一个 JSON（NDJSON），每行 `data` 是一小段 base64 音频，
 * 必须按行切、拼起来才是完整 mp3 —— 当普通 JSON 解析只会拿到第一块。
 */
/**
 * 掩码判断：只要含非 ASCII 字符就当成掩码。
 *
 * 为什么不直接 `=== MASK`：掩码字符串一变（历史遗留、全角点、前端复制时多了个点），
 * 精确比对就会漏判。而漏判的后果很脏 —— `•`（U+2022）被塞进 Authorization header，
 * Node 抛 `Cannot convert argument to a ByteString`，火山这条路静默失败、
 * 自动回退到 Edge 音色，用户听到的是另一个声音却查不出原因。
 * 真 token 一定是纯 ASCII，所以这个判断不会误伤。
 */
function looksMasked(s) {
  return !s || /[^\x20-\x7e]/.test(String(s))
}

async function synthesizeVolc(text, v, dir) {
  if (looksMasked(v.accessToken)) {
    throw new Error('火山 accessToken 含非法字符（多半是面板回填的掩码），请在面板里重新填一次')
  }
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `tts-volc-${Date.now()}.mp3`)

  const speed = Math.min(2, Math.max(0.5, Number(v.speed) || 1))
  // speech_rate 必须放在 audio_params 里！放 req_params 层会被静默忽略 ——
  // 实测同一句话：audio_params.speech_rate=-50 → 11.6 秒，+100 → 3.2 秒；
  // 而放 req_params 层，-50/0/+100 分别是 6.2/6.6/5.9 秒，基本没区别（就是没生效）。
  const reqParams = {
    text: String(text).slice(0, 500),
    speaker: v.speakerId,
    audio_params: {
      format: 'mp3',
      sample_rate: 24000,
      speech_rate: Math.round((speed - 1) * 100)
    }
  }
  // 情感走 context_texts 指令（见 EMOTION_INSTRUCTIONS 的注释）。
  // `additions` 在接口里是 string 类型，必须传 JSON 序列化后的字符串 ——
  // 直接传对象会 `code=55000000 json: cannot unmarshal object into Go struct f`。
  // context_texts 只第一个元素生效，所以只放一条；且不参与计费。
  if (v.emotion && EMOTION_INSTRUCTIONS[v.emotion]) {
    reqParams.additions = JSON.stringify({ context_texts: [EMOTION_INSTRUCTIONS[v.emotion]] })
  }

  const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': v.appId,
      'X-Api-App-Key': v.appId,
      'X-Api-Access-Key': v.accessToken,
      // 资源 ID 兜底顺序：配置里填的 → 按音色 ID 推断 → 历史默认（复刻 2.0）
      'X-Api-Resource-Id': v.resourceId || inferResourceId(v.speaker) || 'seed-icl-2.0',
      'X-Api-Request-Id': crypto.randomUUID()
    },
    body: JSON.stringify({ user: { uid: 'qqbot' }, req_params: reqParams }),
    signal: AbortSignal.timeout(60000)
  })

  const dec = new TextDecoder()
  const parts = []
  let buf = ''
  let apiErr = ''

  const handle = (line) => {
    let j
    try {
      j = JSON.parse(line)
    } catch {
      return
    }
    if (j.data) parts.push(Buffer.from(j.data, 'base64'))
    const code = j.code
    // 0 = 中间块；20000000 = 正常结束；其它都是业务错误
    if (code !== undefined && code !== null && code !== 0 && code !== 20000000) {
      apiErr = `code=${code} ${j.message || ''}`.trim()
    }
  }

  if (res.body) {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) handle(line)
      }
    }
    if (buf.trim()) handle(buf.trim())
  }

  if (apiErr) throw new Error(`火山 TTS ${apiErr}`)
  if (!parts.length) throw new Error(`火山 TTS HTTP ${res.status} 没有返回音频`)
  fs.writeFileSync(file, Buffer.concat(parts))
  return file
}

/**
 * 合成一段话，返回音频文件路径。
 *
 * provider=volc 但参数不全或调用失败时**自动回退**到 Edge 语音：
 * 聊天里发不出声音比音色不对更糟，宁可临时降级也要让它能说话。
 */
async function synthesize(text, voice) {
  const cfg = loadConfig()
  const v = voice || cfg.voice || {}
  // 以前写死 /root/qq-workspace/voice，换机器/改工作区就写不进去。
  const dir = path.join(cfg.paths.workspace, 'voice')
  fs.mkdirSync(dir, { recursive: true })

  if (v.provider === 'volc') {
    const vc = v.volc || {}
    if (vc.appId && vc.accessToken && vc.speakerId) {
      // 音色和资源 ID 必须同代，配错必炸（code=55000000 resource ID is mismatched）。
      // 面板已经会自动对齐，但配置可能是手改的、或者换了音色没换资源 ID，
      // 所以这里再兜一次：能认出来就直接纠正好，别把一个必然失败的请求打出去。
      const fixed = { ...vc }
      const want = inferResourceId(fixed.speakerId)
      if (want && fixed.resourceId !== want) {
        log(`语音：音色与资源 ID 不匹配（${fixed.speakerId} 应配 ${want}，配置里是 ${fixed.resourceId}），已自动纠正`)
        fixed.resourceId = want
      }
      try {
        const f = await synthesizeVolc(text, fixed, dir)
        log(`语音：火山合成完成（${fixed.speakerId} / ${fixed.resourceId}）`)
        return f
      } catch (e) {
        log(`语音：火山合成失败，回退到 Edge 音色 —— ${e.message}`)
      }
    } else {
      log('语音：选了火山音色但 APP ID / Token / 声音ID 不全，先用 Edge 音色')
    }
  }

  const file = path.join(dir, `tts-${Date.now()}.mp3`)
  /*
   * 【2026-10-23】必须写成 `--opt=value`，不能用 `'--rate', '-10%'` 这种分开的写法。
   *
   * edge-tts 用 argparse 解析参数，看到 `-10%` 会当成「另一个选项」，
   * 于是 `--rate` 缺参数 → 打印 usage 退出，报错只有一句
   * `语音合成失败: usage: edge-tts [-h] [-t TEXT] ...`，完全看不出是符号的问题。
   *
   * 触发条件很隐蔽：默认 `+8%` 是正数、不炸；一旦把语速拉到负数（如 -10%），
   * 或音调填负数（如 -5Hz），就必炸。用等号连写，argparse 才知道这是值。
   */
  const args = [
    `--voice=${v.voiceName || 'zh-CN-XiaoyiNeural'}`,
    `--rate=${v.rate || '+0%'}`,
    `--pitch=${v.pitch || '+0Hz'}`,
    `--text=${String(text).slice(0, 500)}`,
    `--write-media=${file}`
  ]
  const r = await run('edge-tts', args, 60000)
  if (!r.ok || !fs.existsSync(file)) {
    throw new Error(`语音合成失败: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
  }
  return file
}

/** 已经同步进 QQ 收藏的有多少张（book 里一个文件名一条记录） */
function qqSyncBook() {
  const cfg = loadConfig()
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.paths.workspace, 'sticker-qq-synced.json'), 'utf8'))
  } catch {
    return {}
  }
}

function isQqSynced(name) {
  return Boolean(qqSyncBook()[name])
}

function countQqSynced() {
  return Object.keys(qqSyncBook()).length
}

/**
 * 把本地表情库同步进机器人的 QQ 收藏夹。
 *
 * 麻烦点：`add_custom_face` 只认**容器内路径**（传 base64 会报 ENAMETOOLONG，
 * 传宿主机路径会报 ENOENT），所以每张图都要 `docker cp` 进容器，加完再删。
 * 每张图一次 docker cp + 一次 action，比较慢，所以要限流（一次最多 20 张）。
 *
 * 用 workspace 里的 `sticker-qq-synced.json` 记录加过哪些，避免重复添加
 * （`fetch_custom_face` 返回的标识不可靠，拿不到稳定的 md5 ↔ 文件名映射）。
 */
async function syncToQqFavorites() {
  const cfg = loadConfig()
  const items = listStickers()
  if (!items.length) return { ok: true, added: 0, skipped: 0, message: '表情库是空的' }

  const bookFile = path.join(cfg.paths.workspace, 'sticker-qq-synced.json')
  let book = {}
  try {
    book = JSON.parse(fs.readFileSync(bookFile, 'utf8'))
  } catch {
    book = {}
  }

  let added = 0
  let skipped = 0
  const failed = []
  const innerNames = []

  for (const it of items) {
    if (book[it.name]) {
      skipped++
      continue
    }
    if (added >= 20) break

    const full = path.join(cfg.paths.stickers, it.name)
    const ext = path.extname(it.name).toLowerCase() || '.png'
    let sendPath = full
    let innerExt = ext
    if (ext === '.webp') {
      // QQ 收藏不认 webp，转成 png 再传
      const png = path.join(os.tmpdir(), `_stk_${Date.now()}_${added}.png`)
      const conv = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', full, png], 20000)
      if (!conv.ok) {
        failed.push({ name: it.name, error: 'webp 转 png 失败' })
        continue
      }
      sendPath = png
      innerExt = '.png'
    }

    const inner = `/app/napcat/cache/_stk_${Date.now()}_${added}${innerExt}`
    const cp = await run('docker', ['cp', sendPath, `napcat:${inner}`], 20000)
    if (!cp.ok) {
      failed.push({ name: it.name, error: '拷贝进容器失败' })
      continue
    }
    innerNames.push(inner)

    try {
      const r = await proxy.sendAction('add_custom_face', { file: inner }, 25000)
      const msg = JSON.stringify(r || {})
      if (/error|ENOENT|Schema/i.test(msg) && !/"ok":true/i.test(msg)) {
        failed.push({ name: it.name, error: msg.slice(0, 80) })
      } else {
        book[it.name] = { at: Date.now() }
        added++
      }
    } catch (e) {
      failed.push({ name: it.name, error: e.message.slice(0, 80) })
    }
  }

  fs.writeFileSync(bookFile, JSON.stringify(book, null, 2), 'utf8')
  // 清掉容器里的临时文件
  if (innerNames.length) {
    await run('docker', ['exec', 'napcat', 'sh', '-c', `rm -f ${innerNames.join(' ')}`], 15000)
  }

  log(`QQ 收藏同步完成：新增 ${added}，跳过 ${skipped}，失败 ${failed.length}`)
  return {
    ok: true,
    added,
    skipped,
    failed,
    total: items.length,
    message: added ? `已添加 ${added} 张到 QQ 收藏` : '没有需要新增的'
  }
}

async function sendVoice(text, targetQQ, voiceOverride) {
  const cfg = loadConfig()
  const uid = targetQQ || cfg.qq.adminQQ
  if (!uid) throw new Error('未配置接收人 QQ')
  // 音色也按人：给访客换了 Edge 音色，就不该用主号的复刻音色
  let voice
  if (voiceOverride) {
    /*
     * 前端带上来的表单值：整块覆盖 cfg.voice，让「试听」和「发到 QQ」一致。
     * 但表单里的 accessToken 回填的是掩码（••••••），直接拿去合成会 401，
     * 所以掩码/空值一律换回已保存的真值；appId / speakerId 同理兜底。
     */
    const ov = { ...voiceOverride }
    if (ov.volc && typeof ov.volc === 'object') {
      ov.volc = { ...(cfg.voice?.volc || {}), ...ov.volc }
      if (looksMasked(ov.volc.accessToken)) {
        ov.volc.accessToken = cfg.voice?.volc?.accessToken || ''
      }
      if (!ov.volc.appId) ov.volc.appId = cfg.voice?.volc?.appId || ''
      if (!ov.volc.speakerId) ov.volc.speakerId = cfg.voice?.volc?.speakerId || ''
    }
    voice = { ...cfg.voice, ...ov }
  } else {
    voice = resolveProfile(cfg, uid).cfg.voice
  }
  const file = await synthesize(text, voice)
  // NapCat 跑在容器里，看不到宿主机路径，必须把音频编码成 base64 传过去
  const b64 = 'base64://' + fs.readFileSync(file).toString('base64')
  await proxy.sendAction('send_private_msg', {
    user_id: Number(uid),
    message: [{ type: 'record', data: { file: b64 } }]
  })
  return file
}

async function sendQzone(content, ugcRight) {
  const body = String(content || '').trim()
  if (!body) throw new Error('说说内容不能为空')
  return await proxy.sendAction('send_qzone_msg', {
    content: body.slice(0, 1000),
    images: [],
    ugc_right: Number(ugcRight) || 1,
    target_uins: []
  })
}

/* ---------------- status ---------------- */
async function getStatus() {
  const cfg = loadConfig()
  const [dshActive, napcatRunning, panelActive] = await Promise.all([
    run('systemctl', ['is-active', cfg.dsh.serviceName]),
    run('docker', ['inspect', '-f', '{{.State.Running}}', 'napcat']),
    run('systemctl', ['is-active', 'qqbot-panel'])
  ])
  const meminfo = await run('sh', ['-c', "free -m | awk 'NR==2{print $2\" \"$3\" \"$4}'"])
  const [total, used, free] = meminfo.stdout.trim().split(/\s+/).map(Number)
  const st = getState()
  return {
    dsh: dshActive.stdout.trim() === 'active',
    napcat: napcatRunning.stdout.trim() === 'true',
    panel: panelActive.stdout.trim() === 'active',
    botQQ: st.botQQ || '',
    proxy: proxy.status(),
    memory: { total, used, free },
    uptime: process.uptime(),
    node: process.version
  }
}

/* ---------------- apply ---------------- */

/**
 * 群聊配置的「签名」：只算会写进插件 patch 的那几项 ——
 * 总开关、是否 @、白名单群号的集合。
 *
 * 为什么不能拿整个 groups 比：改个备注名、调一下群档案，也会被判成变更、
 * 白重启一次 dsh（10 秒 + 聊天中断）。那些只影响我方逻辑，不用重启。
 */
function groupSig(g) {
  return JSON.stringify({
    on: g?.enabled === true,
    mention: g?.requireMention !== false,
    ids: (Array.isArray(g?.entries) ? g.entries : [])
      .filter((e) => e && e.enabled !== false && e.groupId)
      .map((e) => String(e.groupId))
      .sort()
  })
}

async function applyConfig(next, prev) {
  const before = publicConfig()
  if (next.vision && next.vision.apiKey === MASK) delete next.vision.apiKey
  // 【2026-10-23】生图和外部 ASR 各自一把 key，前端回传的同样是掩码。
  // 漏掉这两行的话，用户在面板点一次「保存」，真 key 就被写成 ••••••••，
  // 生图和语音识别会一起 401，而且从界面上看不出来。
  if (next.imageGen && next.imageGen.apiKey === MASK) delete next.imageGen.apiKey
  if (next.asr && next.asr.apiKey === MASK) delete next.asr.apiKey
  // 前端拿到的是掩码，原样回传时别把真 token 覆盖成 ••••••
  if (next.voice?.volc?.accessToken === MASK) delete next.voice.volc.accessToken
  if (next.search?.apiKey === MASK) delete next.search.apiKey
  const saved = saveConfig(next)
  const after = publicConfig()
  writeDshProfile()
  writePersona()
  writeCapabilities()

  const modelChanged = JSON.stringify(before.model) !== JSON.stringify(after.model)
  const featureChanged = JSON.stringify(before.features) !== JSON.stringify(after.features)
  const onebotChanged = before.dsh.onebotPort !== after.dsh.onebotPort
  /**
   * 【2026-10-23】切换语音识别方式必须重启 dsh。
   *
   * renderPatch() 会把 sttEnabled 写成 false 来停掉插件自带的本地转写，
   * 但那个 patch 文件只在 dsh 启动时读一次。如果不重启，插件仍然带着
   * 「sttEnabled=true」在跑：面板转一遍、插件又转一遍，同一条语音被识别两次。
   * 这是唯一一处「配置改了但没人重新加载」会直接造成错误行为的地方。
   */
  const asrChanged = (before.asr?.provider || 'local') !== (after.asr?.provider || 'local')
  /**
   * 群聊开关/群名单会写进 cordis.patch.yml 的 groupPolicy / groupAllowFrom，
   * 那是 dsh 启动时读的 —— 不重启，插件还在用旧策略：
   * 面板上开了群，实际一条群消息都进不来（或者反过来，关了还在回）。
   */
  const groupsChanged = groupSig(before.groups) !== groupSig(after.groups)
  // 上下文长度是写进 compaction-basic 插件的，改完必须重启才重新加载
  const contextChanged = JSON.stringify(before.context) !== JSON.stringify(after.context)

  if (modelChanged || featureChanged || onebotChanged || contextChanged || asrChanged || groupsChanged) {
    log(
      '配置变更需要重启 dsh：' +
        JSON.stringify({ modelChanged, featureChanged, onebotChanged, contextChanged, asrChanged, groupsChanged })
    )
    await run('systemctl', ['restart', saved.dsh.serviceName], 40000)
    await new Promise((r) => setTimeout(r, 2500))
  }
  if (before.proxy.port !== after.proxy.port) {
    log('代理端口变更，重启代理')
    proxy.start()
  }
  // 刚打开主动消息时，从现在开始计时，避免立刻弹一条
  if (!before.proactive?.enabled && after.proactive?.enabled) {
    saveConfig({ proactive: { enabledAt: Date.now() } })
    log('主动消息已开启，从现在开始计时')
  }
  return { modelChanged, featureChanged, onebotChanged, contextChanged, asrChanged, groupsChanged }
}

/* ---------------- http server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const p = url.pathname

  /**
   * 免登录链接：`/?k=<key>` 换一张长期 cookie 再跳回干净地址。
   *
   * 为什么要这个东西：按 IP 免密挡不住「笔记本换个地方就连不上」，
   * 家宽/手机热点的出口 IP 完全不一样，每换一次就要重输密码。
   * 链接里的 key 是 32 字节随机串，效果等于「只有拿到这个网址的浏览器能进」。
   */
  const linkKey = url.searchParams.get('k')
  if (req.method === 'GET' && linkKey) {
    const cfg = loadConfig()
    if (cfg.auth.linkKey && safeEqual(linkKey, cfg.auth.linkKey)) {
      const token = signSession(365)
      log(`通过免登录链接进入 ip=${clientIP(req)}`)
      res.writeHead(302, {
        Location: p,
        'Set-Cookie': `qp_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`,
        'Cache-Control': 'no-store'
      })
      return res.end()
    }
    return send(res, 403, '这个免登录链接无效（可能被重置过），请用密码登录。')
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim()

  try {
    /* --- public --- */
    if (p === '/api/login' && req.method === 'POST') {
      const wait = hitLimit(ip)
      if (wait) return send(res, 429, { error: `尝试过多，请 ${wait} 秒后再试` })
      const body = await readJson(req)
      const cfg = loadConfig()
      if (!cfg.auth.hash) return send(res, 400, { error: '尚未设置密码' })
      if (!checkPassword(body.password || '')) {
        recordHit(ip, false)
        log(`登录失败 ip=${ip}`)
        return send(res, 401, { error: '密码错误' })
      }
      recordHit(ip, true)
      log(`登录成功 ip=${ip}`)
      const token = signSession(365)
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `qp_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`
      })
    }

    if (p === '/api/setup' && req.method === 'POST') {
      const cfg = loadConfig()
      if (cfg.auth.hash) return send(res, 400, { error: '密码已设置' })
      if (cfg.auth.open) return send(res, 400, { error: '现在是免密模式，不需要设密码' })
      const body = await readJson(req)
      const pw = String(body.password || '')
      if (pw.length < 8) return send(res, 400, { error: '密码至少 8 位' })
      setPassword(pw)
      writeDshProfile()
      writePersona()
      log('已设置访问密码')
      const token = signSession(365)
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `qp_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`
      })
    }

    if (p === '/api/me') {
      const cfg = loadConfig()
      const ip = clientIP(req)
      return send(res, 200, {
        authed: authed(req),
        // 免密开着就不存在「首次设置密码」这一步
        needsSetup: !cfg.auth.hash && !cfg.auth.open,
        authOpen: Boolean(cfg.auth.open),
        skipIPs: cfg.auth.skipIPs || [],
        ip,
        ipTrusted: ipTrusted(ip, cfg.auth.skipIPs)
      })
    }

    /* 免密设置：只允许已登录的人改，否则任何人都能把自己加进信任 IP */
    if (p === '/api/access' && req.method === 'POST') {
      if (!authed(req)) return send(res, 403, { error: '未登录' })
      const body = await readJson(req)
      const cfg = loadConfig()
      const patch = { auth: {} }
      if (typeof body.open === 'boolean') patch.auth.open = body.open
      if (Array.isArray(body.skipIPs)) {
        patch.auth.skipIPs = body.skipIPs
          .map((s) => String(s || '').trim())
          .filter((s) => /^[0-9a-fA-F:.*]+$/.test(s))
          .slice(0, 20)
      }
      const next = saveConfig(patch)
      log(
        `免密设置已更新：${next.auth.open ? '完全免密' : '需要密码'}` +
          `，信任 IP ${next.auth.skipIPs.length ? next.auth.skipIPs.join('、') : '（无）'}`
      )
      return send(res, 200, {
        ok: true,
        authOpen: Boolean(next.auth.open),
        skipIPs: next.auth.skipIPs,
        ip: clientIP(req)
      })
    }

    /* --- 本机 CLI 专用：只接受 loopback，公网进不来 --- */
    if (p === '/api/qq/action' && req.method === 'POST') {
      if (!loopback(req)) return send(res, 403, { error: '仅限本机调用' })
      const body = await readJson(req)
      if (!body.action) return send(res, 400, { error: '缺少 action' })
      try {
        const data = await proxy.sendAction(body.action, body.params || {}, Number(body.timeout) || 25000)
        log(`本机调用 ${body.action} 成功`)
        return send(res, 200, { ok: true, data })
      } catch (e) {
        log(`本机调用 ${body.action} 失败: ${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    /* --- static（必须放在鉴权之前） ---
     *
     * index.html 自带登录层：页面先加载出来 → boot() 调 /api/me → 拿到 authed:false
     * → 弹出登录框。所以「页面本身」不能要求登录。
     *
     * 2026-10-23 之前这块在 `if (!authed)` 后面，未登录访问 `/` 直接返回
     * `{"error":"未登录"}` 这段 JSON —— 手机上就是白底黑字一行报错，
     * 输入框影子都没有。电脑端看起来没事，只是因为 cookie 还在。
     *
     * 安全性：PUBLIC_DIR 里只有 index.html，不含任何数据；真正的数据全在 /api/*
     * 和 /dsh/* 后面，那两个仍然要登录。所以这里放开没有额外暴露面。
     *
     * 注意排除 /dsh：否则 `/dsh/xxx` 的 GET 会被当静态文件查、返回 404，
     * 永远走不到下面的反向代理。
     */
    if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/dsh' && !p.startsWith('/dsh/')) {
      const file = p === '/' || p === '/index.html' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, path.normalize(p).replace(/^\/+/, ''))
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden')
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file)
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
        return res.end(fs.readFileSync(file))
      }
      return send(res, 404, 'not found')
    }

    /* --- 本机 CLI 专用：qq-draw 生图 ---
     * 位置在登录鉴权之前，因为 CLI 没有浏览器会话。放行条件是两个都给足：
     * ① 必须来自 loopback；② 必须带 data/internal.token 里的令牌。
     * 少任何一个都 403 —— 不把「本机能连」当成「有权限用」。
     */
    if (p === '/api/imagegen/generate' && req.method === 'POST') {
      if (!loopback(req) || !internalAuthed(req)) {
        return send(res, 403, { error: '仅限本机工具调用' })
      }
      const body = await readJson(req)
      try {
        const cfg = loadConfig()
        const out = await generateImage(body.prompt, cfg.imageGen, cfg.paths.workspace)
        log(`本机生图完成：${path.basename(out.file)}（${Math.round(out.bytes / 1024)} KB）`)
        return send(res, 200, { ok: true, ...out })
      } catch (e) {
        log(`本机生图失败：${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    /* --- 本机 CLI 专用：tts 合成 ---
     * 和面板试听走同一个 synthesize()，所以音色 / 语速 / 情感永远一致。
     *
     * 【为什么要有这个接口】原来 /usr/local/bin/tts 是个独立 bash 脚本，自己写死了
     * `edge-tts --voice zh-CN-XiaoyiNeural --rate "+8%"`。面板上把音色换成火山复刻的
     * vv、语速调到 0.8，试听是对的；可她聊天里真发出来的却是另一个声音 ——
     * 两条链路各用各的参数，设置根本没生效。现在只留一条。
     */
    if (p === '/api/voice/synth' && req.method === 'POST') {
      if (!loopback(req) || !internalAuthed(req)) {
        return send(res, 403, { error: '仅限本机工具调用' })
      }
      const body = await readJson(req)
      const text = String(body.text || '').slice(0, 500).trim()
      if (!text) return send(res, 400, { error: 'text 不能为空' })
      const cfg = loadConfig()
      try {
        let voice = cfg.voice || {}
        // 显式点了一个 Edge 音色才切 provider；不传就完全跟随面板配置
        if (body.voiceName) {
          voice = { ...voice, provider: 'edge', voiceName: String(body.voiceName) }
        }
        const file = await synthesize(text, voice)
        // 只保留最近 50 个，避免占满磁盘（老脚本里有这段，换实现不能丢）
        try {
          const dir = path.join(cfg.paths.workspace, 'voice')
          const names = fs
            .readdirSync(dir)
            .filter((n) => /^tts-.*\.mp3$/.test(n))
            .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          for (const it of names.slice(50)) fs.unlinkSync(path.join(dir, it.n))
        } catch {
          /* 清理失败不影响这次合成 */
        }
        const used =
          voice.provider === 'volc' ? voice.volc?.speakerId || '?' : voice.voiceName || '?'
        log(`本机 TTS 合成：${path.basename(file)}（${voice.provider} / ${used}）`)
        return send(res, 200, { ok: true, file })
      } catch (e) {
        log(`本机 TTS 失败：${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    /* --- everything below requires auth --- */
    if (!authed(req)) return send(res, 401, { error: '未登录' })

    /* ---------------- dsh web 反向代理 ----------------
     * 把服务器本机的 dsh web（127.0.0.1:3080）嵌进面板，点开就能看。
     * iframe 指到 /dsh/ 即可；token/cookie 由后端自动管理。
     * 位置在鉴权之后 —— dsh 界面里能看到模型对话，不能公开。
     * 静态块已经排除了 /dsh 前缀，不会抢先吃掉它的请求。
     */
    if (p === '/dsh' || p.startsWith('/dsh/')) {
      // 用原始 req.url 只切掉 /dsh 前缀，其余（含 ??、@、&）全部原样转发。
      // dsh 的资源路径形如 `plugins/??@scope/name.js,@scope2/name2.js&rev=xxx`，
      // 这里的 ? 和 & 是路径的一部分，不是标准 query —— 不能用 URL 解析，
      // 否则 ?? 会被当成 query 起始、路径被截断成 404。
      const raw = req.url || '/'
      const rest = raw === '/dsh' ? '/' : raw.slice('/dsh'.length) || '/'
      return proxyDsh(req, res, rest)
    }

    /* ---------------- QQ 扫码登录 ---------------- */
    if (p === '/api/qq/login' && req.method === 'GET') {
      const ps = proxy.status()
      const st = getState()
      const cfg = loadConfig()
      const [qr, ins] = await Promise.all([
        readQrcode(),
        run('docker', ['inspect', '-f', '{{.State.Running}}', 'napcat'], 6000)
      ])
      const now = Date.now()
      const loggedIn = Boolean(ps.napcat && ps.dsh)
      // 没登录时顺带看看 NapCat 是不是卡在「登录失败」—— 那种状态二维码不会自动刷新
      const loginError = loggedIn ? null : await napcatLoginError()
      return send(res, 200, {
        ok: true,
        container: (ins.stdout || '').trim() === 'true',
        loggedIn,
        botQQ: st.botQQ || cfg.qq.botQQ || '',
        qrMtime: qr.mtime,
        qrAgeSec: qr.mtime ? Math.max(0, Math.round(now / 1000 - qr.mtime)) : null,
        qrError: qr.err,
        loginError
      })
    }

    if (p === '/api/qq/qrcode' && req.method === 'GET') {
      const qr = await readQrcode(url.searchParams.get('force') === '1')
      if (!qr.b64) return send(res, 503, { ok: false, error: qr.err || '暂无二维码' })
      return send(res, 200, {
        ok: true,
        dataUrl: `data:image/png;base64,${qr.b64}`,
        mtime: qr.mtime,
        ageSec: qr.mtime ? Math.max(0, Math.round(Date.now() / 1000 - qr.mtime)) : null
      })
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'qp_auth=; Path=/; Max-Age=0' })
    }

    if (p === '/api/password' && req.method === 'POST') {
      const body = await readJson(req)
      if (!checkPassword(body.old || '')) return send(res, 400, { error: '原密码不正确' })
      const pw = String(body.new || '')
      if (pw.length < 8) return send(res, 400, { error: '新密码至少 8 位' })
      setPassword(pw)
      log('访问密码已修改')
      const token = signSession(365)
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `qp_auth=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`
      })
    }

    /* ---------------- 按用户对话设置 ---------------- */
    if (p === '/api/profiles' && req.method === 'GET') {
      const cfg = loadConfig()
      return send(res, 200, { adminQQ: cfg.qq.adminQQ, profiles: cfg.profiles })
    }

    if (p === '/api/profiles' && req.method === 'POST') {
      const body = await readJson(req)
      const cur = loadConfig().profiles || {}
      const next = {
        enabled: cur.enabled !== false,
        visitor: body.visitor !== undefined ? sanitizeOverrides(body.visitor) : cur.visitor || {},
        users: Array.isArray(body.users)
          ? body.users
              .map((u) => ({
                qq: String(u.qq || '').replace(/\D/g, ''),
                name: String(u.name || '').slice(0, 20),
                enabled: u.enabled !== false,
                overrides: sanitizeOverrides(u.overrides)
              }))
              .filter((u) => u.qq)
              .slice(0, 100)
          : cur.users || []
      }
      const saved = setProfiles(next)
      const groups = (o) => Object.keys(o || {}).length
      log(
        `按人设置已更新：访客默认 ${groups(saved.profiles.visitor)} 组，单独设置 ${saved.profiles.users.length} 个号`
      )
      return send(res, 200, { ok: true, profiles: saved.profiles })
    }

    /* ---------------- 群聊（开关 + 群白名单 + 每群档案） ---------------- */
    if (p === '/api/groups' && req.method === 'GET') {
      const cfg = loadConfig()
      return send(res, 200, { groups: cfg.groups || { enabled: false, requireMention: true, entries: [] } })
    }

    if (p === '/api/groups' && req.method === 'POST') {
      const body = await readJson(req)
      const prev = publicConfig()
      try {
        const cur = loadConfig().groups || {}
        const next = {
          enabled: body.enabled === true,
          requireMention: body.requireMention !== false,
          entries: Array.isArray(body.entries)
            ? body.entries
                .map((e) => ({
                  groupId: String(e.groupId || '').replace(/\D/g, ''),
                  name: String(e.name || '').slice(0, 24),
                  enabled: e.enabled !== false,
                  overrides: sanitizeOverrides(e.overrides)
                }))
                .filter((e) => e.groupId)
                .slice(0, 100)
            : cur.entries || []
        }
        const result = await applyConfig({ groups: next }, prev)
        log(
          `群聊设置已更新：${next.enabled ? '开启' : '关闭'}，白名单 ${next.entries.length} 个群` +
            (result.groupsChanged ? '（dsh 正在重启）' : '')
        )
        return send(res, 200, { ok: true, groups: loadConfig().groups, applied: result })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/state' && req.method === 'GET') {      const [status, stats] = await Promise.all([getStatus(), Promise.resolve().then(collectStats)])
      return send(res, 200, { config: publicConfig(), status, stats, logs: ring.slice(-120) })
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readJson(req)
      const prev = publicConfig()
      const result = await applyConfig(body, prev)
      const status = await getStatus()
      return send(res, 200, { ok: true, applied: result, config: publicConfig(), status })
    }

    /* ---------------- 长期记忆（AGENTS.local.md） ---------------- */
    if (p === '/api/memory' && req.method === 'GET') {
      const cfg = loadConfig()
      const f = path.join(cfg.paths.workspace, 'AGENTS.local.md')
      let text = ''
      try {
        text = fs.readFileSync(f, 'utf8')
      } catch {
        text = ''
      }
      const entries = text.split('\n').filter((l) => /^\s*-\s+\S/.test(l)).length
      return send(res, 200, { ok: true, path: f, content: text, entries, bytes: Buffer.byteLength(text) })
    }

    if (p === '/api/memory' && req.method === 'DELETE') {
      const cfg = loadConfig()
      const f = path.join(cfg.paths.workspace, 'AGENTS.local.md')
      const header = [
        '# 长期记忆',
        '',
        '<!-- 由它自己维护。一行一条，格式：- 2026-10-21 对方说他…… -->',
        '<!-- 只记以后还用得上的：称呼、喜好、忌讳、约定、重要日期、正在进行的事。 -->',
        ''
      ].join('\n')
      try {
        fs.writeFileSync(f, header, 'utf8')
      } catch (e) {
        return send(res, 500, { error: '写入失败：' + e.message })
      }
      log('长期记忆已清空（AGENTS.local.md 重置为模板）')
      return send(res, 200, { ok: true })
    }

    /* ---------------- 白名单 ---------------- */
    if (p === '/api/whitelist' && req.method === 'GET') {
      const cfg = loadConfig()
      return send(res, 200, {
        mode: cfg.whitelist.enabled ? 'only' : 'all',
        entries: cfg.whitelist.entries,
        adminQQ: cfg.qq.adminQQ,
        blocked: proxy.blockedList(),
        contacts: proxy.contactMap()
      })
    }

    if (p === '/api/whitelist/friends' && req.method === 'GET') {
      try {
        const raw = await proxy.sendAction('get_friend_list', {}, 25000)
        const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []
        const friends = arr
          .map((o) => ({
            qq: String(o.user_id ?? o.uin ?? ''),
            name: String(o.remark || o.nickname || o.card || ''),
            nick: String(o.nickname || '')
          }))
          .filter((o) => /^\d{5,12}$/.test(o.qq))
        return send(res, 200, { ok: true, friends })
      } catch (e) {
        return send(res, 500, { ok: false, error: '读好友列表失败：' + e.message })
      }
    }

    /* 自检：在面板进程内跑一次白名单判定（只接受本机调用，不转发消息） */
    if (p === '/api/whitelist/probe' && req.method === 'POST') {
      if (!loopback(req)) return send(res, 403, { error: '仅限本机调用' })
      const body = await readJson(req)
      const cfg = loadConfig()
      const text = String(body.text || '白名单自检')
      const frame = {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: Date.now() % 1000000000,
        user_id: Number(String(body.qq || '').replace(/\D/g, '')) || 0,
        self_id: Number(getState().botQQ || cfg.qq.botQQ || 0) || 0,
        raw_message: text,
        message: [{ type: 'text', data: { text } }],
        sender: { user_id: 0, nickname: String(body.name || '自检号'), card: '' },
        time: Math.floor(Date.now() / 1000)
      }
      const verdict = proxy.decide(frame)
      return send(res, 200, { ok: true, verdict, blocked: proxy.blockedList() })
    }

    if (p === '/api/whitelist' && req.method === 'POST') {
      const body = await readJson(req)
      const cfg = loadConfig()
      const entries = (cfg.whitelist.entries || []).map((e) => ({ ...e }))
      const act = String(body.action || '')
      const digits = (v) => String(v ?? '').replace(/\D/g, '')
      const idxOf = (qq) => entries.findIndex((e) => String(e.qq) === String(qq))
      let mode = cfg.whitelist.enabled ? 'only' : 'all'
      let message = ''

      try {
        if (act === 'add') {
          const qq = digits(body.qq)
          if (!/^\d{5,12}$/.test(qq)) throw new Error('QQ 号应为 5-12 位数字')
          if (idxOf(qq) >= 0) throw new Error('这个号已经在名单里了')
          entries.push({
            qq,
            name: String(body.name || '').slice(0, 24),
            note: String(body.note || '').slice(0, 40),
            enabled: true,
            addedAt: Date.now()
          })
          proxy.forgetBlocked(qq)
          message = `已加入：${body.name || qq}`
        } else if (act === 'update') {
          const i = idxOf(body.qq)
          if (i < 0) throw new Error('名单里没有这个号')
          const e = entries[i]
          if (body.enabled !== undefined) e.enabled = Boolean(body.enabled)
          if (body.name !== undefined) e.name = String(body.name).slice(0, 24)
          if (body.note !== undefined) e.note = String(body.note).slice(0, 40)
          message = e.enabled ? `已允许回复：${e.name || e.qq}` : `已停止回复：${e.name || e.qq}`
        } else if (act === 'remove') {
          const i = idxOf(body.qq)
          if (i < 0) throw new Error('名单里没有这个号')
          const [gone] = entries.splice(i, 1)
          proxy.forgetBlocked(gone.qq)
          message = `已移除：${gone.name || gone.qq}`
        } else if (act === 'mode') {
          mode = body.mode === 'all' ? 'all' : 'only'
          message = mode === 'only' ? '已改为：仅回复名单内' : '已改为：所有好友都能聊'
        } else if (act === 'clear-blocked') {
          proxy.clearBlocked()
          message = '被拦记录已清空'
        } else {
          throw new Error('未知操作')
        }
      } catch (e) {
        return send(res, 400, { error: e.message })
      }

      // allowAllUsers / adminUsers 是 dsh 插件启动时读的，变了就必须重启
      const patchKey = (c) => `${c.whitelist.enabled ? 'only' : 'all'}|${whitelistAdminUsers(c).join(',')}`
      const keyBefore = patchKey(cfg)
      saveConfig({ whitelist: { enabled: mode === 'only', entries } })
      writeDshProfile()
      const after = loadConfig()
      const keyAfter = patchKey(after)
      const needRestart = keyBefore !== keyAfter
      if (needRestart) {
        log(`名单放行范围变化（${keyBefore} → ${keyAfter}），重启 dsh 生效`)
        await run('systemctl', ['restart', after.dsh.serviceName], 40000)
        await new Promise((r) => setTimeout(r, 2500))
      }
      log(`白名单：${message}`)
      return send(res, 200, {
        ok: true,
        message,
        restarted: needRestart,
        mode: after.whitelist.enabled ? 'only' : 'all',
        entries: after.whitelist.entries,
        blocked: proxy.blockedList(),
        contacts: proxy.contactMap()
      })
    }

    if (p === '/api/action' && req.method === 'POST') {
      const body = await readJson(req)
      const cfg = loadConfig()
      switch (body.action) {
        case 'restart-dsh':
          await run('systemctl', ['restart', cfg.dsh.serviceName], 60000)
          log('手动重启 dsh')
          break
        case 'restart-proxy':
          proxy.start()
          log('手动重启代理')
          break
        case 'restart-napcat':
          await run('docker', ['restart', 'napcat'], 120000)
          log('重启 NapCat（可能需要重新扫码）')
          break
        case 'rewrite-files':
          writeDshProfile()
          writePersona()
          log('重新生成配置文件')
          break
        case 'reset-botqq':
          patchState({ botQQ: '' })
          break
        case 'clear-stats':
          patchState({ daily: {}, proxyStats: { inbound: 0, forwarded: 0, dropped: 0 } })
          break
        default:
          return send(res, 400, { error: '未知操作' })
      }
      await new Promise((r) => setTimeout(r, 2500))
      return send(res, 200, { ok: true, status: await getStatus() })
    }

    if (p === '/api/inject' && req.method === 'POST') {
      const body = await readJson(req)
      const text = String(body.text || '').trim()
      if (!text) return send(res, 400, { error: '注入内容为空' })
      // 带图模拟：只允许工作区和 /tmp 里的文件，别把面板变成任意文件读取器
      let imageFile = ''
      if (body.image) {
        const abs = path.resolve(String(body.image))
        const cfg = loadConfig()
        const ok = abs.startsWith(cfg.paths.workspace + path.sep) || abs.startsWith(os.tmpdir() + path.sep)
        if (!ok || !fs.existsSync(abs)) return send(res, 400, { error: '图片路径必须是工作区或 /tmp 下真实存在的文件' })
        imageFile = abs
      }
      try {
        // qq 只用于自检「按人设置」：模拟一条别人发来的消息，走同一个入站漏斗
        const fromQQ = body.qq ? String(body.qq).replace(/\D/g, '') : ''
        const evt = body.sim
          ? proxy.simulateInbound(text, { imageFile, userId: fromQQ || undefined })
          : proxy.injectPrivateMessage(text)
        log(
          `${body.sim ? '模拟入站' : '已向 dsh 注入'}消息（${text.length} 字${imageFile ? `，带图 ${path.basename(imageFile)}` : ''}` +
            `${fromQQ ? `，发件人 ${fromQQ}` : ''}）`
        )
        return send(res, 200, { ok: true, evt })
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    if (p === '/api/proactive' && req.method === 'GET') {
      return send(res, 200, proactive.info())
    }

    // 现在她处于什么状态（面板「她现在在干嘛」卡片用）
    if (p === '/api/campus/state' && req.method === 'GET') {
      const cfg = loadConfig()
      const s = campusState(cfg)
      const cp = cfg.campus || {}
      const cr = cp.routine
      // 判据必须和 campus.js 的 normalizeRoutine 一致：slots 或 events 有一个是数组就算配过。
      // 原来要求 slots.length 非空，导致「只配活动池、不要固定日程」的配置在这里也被当成没配，
      // 面板会显示成模板名、日程预览也用模板的 —— 和状态机的实际行为对不上。
      const routine = cr && typeof cr === 'object' && (Array.isArray(cr.slots) || Array.isArray(cr.events))
        ? cr
        : null
      const tpl = templateFor(cp.job || 'student')
      return send(res, 200, {
        key: s.key,
        label: s.label,
        line: s.line,
        busy: s.busy,
        // 活动里的偷闲：label 是「偷偷看手机」，event 才是她本来在干嘛
        event: s.event || '',
        focus: s.focus === true,
        at: new Date().toISOString(),
        job: cp.job || 'student',
        jobLabel: (JOBS[cp.job || 'student'] || JOBS.student).label,
        age: Number(cp.age) || 20,
        // 今日抽到的活动（让人看得出「随机」到底抽了什么）
        todayEvents: todaysEvents(cfg),
        // 她自己往活动池里加的东西（面板上「她的新爱好」那一块）
        extraEvents: loadExtraEvents().map((x) => ({
          label: x.label,
          from: x.from,
          to: x.to,
          busy: x.busy,
          focus: x.focus === true
        })),
        // 一整天状态变化的时间轴（压缩过，只留变化点）
        timeline: campusTimeline(cfg, new Date(), 24, 30),
        // 当前用的是自定义日程还是内置模板
        routineSource: routine?.source || `template:${cp.job || 'student'}`,
        routineCustom: Boolean(routine),
        // 面板上「看她现在这套日程」用
        slots: (routine?.slots || tpl.slots || []).map((x) => ({
          from: x.from,
          to: x.to,
          label: x.label,
          busy: x.busy
        })),
        events: (routine?.events || tpl.events || []).map((x) => ({
          from: x.from,
          to: x.to,
          label: x.label,
          busy: x.busy
        })),
        eventsPerDay: routine?.eventsPerDay ?? cp.eventsPerDay ?? 1
      })
    }

    // 套用内置日程模板：把 templateFor(job) 写进 config.campus.routine
    if (p === '/api/campus/template' && req.method === 'POST') {
      const body = await readJson(req)
      const job = String(body.job || 'student')
      const tpl = templateFor(job)
      const cfg = loadConfig()
      const next = {
        ...(cfg.campus || {}),
        job,
        routine: {
          version: 1,
          source: `template:${job}`,
          slots: tpl.slots || [],
          events: tpl.events || [],
          eventsPerDay: normalizeEventsPerDay(body.eventsPerDay ?? cfg.campus?.eventsPerDay ?? 1)
        }
      }
      saveConfig({ campus: next })
      writePersona()
      log(`已套用日程模板：${job}`)
      return send(res, 200, { ok: true, job, slotCount: (tpl.slots || []).length, eventCount: (tpl.events || []).length })
    }

    // 让她自己重排一天：注入一条内部任务，她把新日程当 JSON 回过来，出站时会被拦下写入
    if (p === '/api/campus/askai' && req.method === 'POST') {
      const cfg = loadConfig()
      const cp = cfg.campus || {}
      const job = cp.job || 'student'
      const jobLabel = (JOBS[job] || JOBS.student).label
      const age = Number(cp.age) || 20
      const hint = (JOBS[job] || JOBS.student).hint
      const prompt =
        `【内部任务，不要当成聊天】按你现在的身份（${age} 岁，${jobLabel}，${hint}）重新排一下你的一天。\n` +
        '要求：\n' +
        '- 固定日程 8-12 段，覆盖起床到睡觉；每段给 from/to（HH:MM）、label、busy（0 闲 / 1 有点忙 / 2 正忙）、line（一句有画面的话，用「你」自称）\n' +
        '- 活动池 8-12 个你想做的事（打球、游泳、看电影、逛超市…），同样给 from/to、label、busy、line\n' +
        '- busy 只用 0/1/2，不要用 3（3 是睡着，由作息时间自动判断）\n' +
        '- 只输出一个 JSON 对象，不要任何解释、不要代码块围栏：\n' +
        '{"slots":[{"from":"07:00","to":"08:00","label":"刚起","busy":1,"line":"..."}],"events":[{"from":"19:00","to":"20:30","label":"打篮球","busy":1,"line":"..."}]}'
      try {
        proxy.injectPrivateMessage(prompt)
        log('已请求她自己重排日程')
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 500, { error: e.message || '注入失败（dsh 可能没连上）' })
      }
    }

    // 她的固定立场 + 最近一次表态（面板「她有自己的看法」用）
    if (p === '/api/opinion' && req.method === 'GET') {
      return send(res, 200, opinionInfo())
    }

    // 删掉她自己记的一条立场（天生的那些不给删）
    if (p === '/api/stance/delete' && req.method === 'POST') {
      const body = await readJson(req)
      const id = String(body?.id || '')
      if (!id) return send(res, 400, { ok: false, error: '缺少 id' })
      const r = deleteStance(id)
      if (!r.ok) return send(res, 404, { ok: false, error: '没找到这条（可能已经删了）' })
      log(`面板删掉一条自己记的立场：${id}`)
      return send(res, 200, { ok: true, left: r.left })
    }

    // 跳题联想的最近一次记录（面板上「最近一次联想」用）
    if (p === '/api/assoc' && req.method === 'GET') {
      const s = assocInfo()
      return send(res, 200, { last: s.last, streak: s.streak, lastAt: s.lastAt })
    }

    // 最近自动发过的说说（面板上防重复用）
    if (p === '/api/qzone/recent' && req.method === 'GET') {
      let posts = []
      try {
        const f = path.join(DATA_DIR, 'qzone.json')
        const d = JSON.parse(fs.readFileSync(f, 'utf8'))
        posts = Array.isArray(d.posts) ? d.posts.slice(-5) : []
      } catch {
        posts = []
      }
      return send(res, 200, { posts })
    }

    if (p === '/api/proactive/trigger' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const r = proactive.triggerNow(body.topic)
        log(`手动触发主动消息（${r.label}）`)
        return send(res, 200, { ok: true, ...r })
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    if (p === '/api/qzone' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const data = await sendQzone(body.content, body.ugcRight)
        const d = new Date()
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        saveConfig({ qzone: { lastAt: Date.now(), lastDay: key } })
        log('已发布 QQ 空间说说')
        return send(res, 200, { ok: true, data })
      } catch (e) {
        log(`发说说失败: ${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    if (p === '/api/voice/preview' && req.method === 'POST') {
      const body = await readJson(req)
      const text = String(body.text || '').slice(0, 120) || '你好呀，我是这样说话的'
      try {
        const saved = loadConfig().voice || {}
        const overlay = { voiceName: body.voiceName, rate: body.rate, pitch: body.pitch }
        if (body.provider) overlay.provider = body.provider === 'volc' ? 'volc' : 'edge'
        // 试听用的是面板上「还没保存」的值，所以合并而不是整块替换
        if (body.volc && typeof body.volc === 'object') {
          overlay.volc = { ...(saved.volc || {}), ...body.volc }
          // 同样用宽松判断：掩码一进 header 就是 ByteString 报错，然后回退 Edge
          if (looksMasked(overlay.volc.accessToken)) overlay.volc.accessToken = saved.volc?.accessToken || ''
        }
        const file = await synthesize(text, { ...saved, ...overlay })
        const buf = fs.readFileSync(file)
        try {
          fs.unlinkSync(file)
        } catch {
          /* ignore */
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length })
        return res.end(buf)
      } catch (e) {
        // 这里以前不写日志，试听失败在 journalctl 里查不到，只能靠用户截图 —— 补上
        log(`试听合成失败（${body.provider || '?'}）：${e.message}`)
        return send(res, 500, { error: e.message })
      }
    }

    if (p === '/api/vision/test' && req.method === 'POST') {
      const body = await readJson(req)
      const sample = String(body.url || '').trim()
      if (!sample) return send(res, 400, { error: '请填一张可公开访问的图片地址' })
      try {
        const desc = await proxy.describeImage(sample, loadConfig().vision)
        log(`看图自检成功: ${desc.slice(0, 40)}`)
        return send(res, 200, { ok: true, desc })
      } catch (e) {
        log(`看图自检失败: ${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    /**
     * 生图自检：真的生成一张，生成完把文件删掉。
     *
     * 不做「只校验参数」的假自检 —— 生图失败的大头是模型名写错、
     * 接口路径少了 /v1、key 没额度，这些都只有真调一次才暴露。
     * 代价是点一次花一次钱，按钮文案里已经写明。
     */
    if (p === '/api/imagegen/test' && req.method === 'POST') {
      const cfg = loadConfig()
      if (cfg.imageGen?.enabled !== true) {
        return send(res, 400, { error: '先打开「启用生图」并保存，再来自检' })
      }
      if (!cfg.imageGen.baseUrl || !cfg.imageGen.model) {
        return send(res, 400, { error: '接口地址和模型名都要填' })
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imggen-probe-'))
      try {
        const out = await generateImage('一只橘猫坐在窗台上看雨，简笔画，白底', cfg.imageGen, dir)
        log(`生图自检成功：${Math.round(out.bytes / 1024)} KB`)
        return send(res, 200, { ok: true, bytes: out.bytes, note: '接口可用（测试图已删除，没发出去）' })
      } catch (e) {
        log(`生图自检失败：${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    /**
     * 外部语音识别自检：本地合成 1 秒静音传给对方接口。
     *
     * 为什么不要求用户上传音频：自检的目的是验证「地址/模型/key 通不通」，
     * 不是验证识别质量。静音走通即可；对方把静音识别成空字符串是正常结果，
     * 所以「未返回文字」这一种错误要单独算成功，否则永远显示失败。
     */
    if (p === '/api/asr/test' && req.method === 'POST') {
      const cfg = loadConfig()
      if ((cfg.asr?.provider || 'local') !== 'api') {
        return send(res, 400, { error: '当前用的是本地识别，不需要测外部接口' })
      }
      if (!cfg.asr.baseUrl || !cfg.asr.model) {
        return send(res, 400, { error: '接口地址和模型名都要填' })
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-probe-'))
      try {
        const wav = path.join(dir, 'silence.wav')
        const made = await run(
          'ffmpeg',
          ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', wav],
          20000
        )
        if (!made.ok) throw new Error('本机 ffmpeg 不可用，无法生成测试音频')
        const text = await transcribeAudio(fs.readFileSync(wav), cfg.asr)
        log('语音接口自检成功')
        return send(res, 200, { ok: true, text, note: '接口通了' })
      } catch (e) {
        const msg = String(e.message || '请求失败')
        if (msg.includes('未返回文字')) {
          log('语音接口自检成功（静音识别为空，正常）')
          return send(res, 200, { ok: true, text: '', note: '接口通了（静音样本识别为空，正常）' })
        }
        log(`语音接口自检失败：${msg}`)
        return send(res, 500, { ok: false, error: msg })
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    /* ---------------- 黑话库 ---------------- */
    if (p === '/api/slang' && req.method === 'GET') {
      try {
        const entries = loadSlang(SLANG_FILE).sort(
          (a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt))
        )
        return send(res, 200, {
          entries,
          counts: {
            total: entries.length,
            candidate: entries.filter((e) => e.status === 'candidate').length,
            confirmed: entries.filter((e) => e.status === 'confirmed').length,
            rejected: entries.filter((e) => e.status === 'rejected').length
          }
        })
      } catch (e) {
        return send(res, 500, { error: e.message })
      }
    }

    if (p === '/api/slang/save' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const entries = loadSlang(SLANG_FILE)
        const id = String(body.id || '')
        if (id) {
          const idx = entries.findIndex((e) => e.id === id)
          if (idx < 0) return send(res, 404, { error: '没有这个词' })
          entries[idx] = {
            ...entries[idx],
            word: String(body.word ?? entries[idx].word).trim() || entries[idx].word,
            meaning: String(body.meaning ?? entries[idx].meaning).trim(),
            usage: String(body.usage ?? entries[idx].usage).trim(),
            example: String(body.example ?? entries[idx].example).trim(),
            updatedAt: new Date().toISOString()
          }
        } else {
          const word = String(body.word || '').trim()
          if (!word) return send(res, 400, { error: '词不能为空' })
          if (entries.some((e) => e.word === word)) return send(res, 400, { error: '这个词已经在库里了' })
          entries.push({
            id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            word,
            meaning: String(body.meaning || '').trim(),
            usage: String(body.usage || '').trim(),
            example: String(body.example || '').trim(),
            status: body.status === 'confirmed' ? 'confirmed' : 'candidate',
            source: 'manual',
            count: 1,
            evidence: [],
            sources: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          })
        }
        saveSlang(SLANG_FILE, entries)
        writePersona()
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/slang/status' && req.method === 'POST') {
      const body = await readJson(req)
      const next = String(body.status || '')
      if (!['candidate', 'confirmed', 'rejected'].includes(next)) {
        return send(res, 400, { error: '非法状态' })
      }
      try {
        const entries = loadSlang(SLANG_FILE)
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id || '')]
        let n = 0
        for (const e of entries) {
          if (!ids.includes(e.id)) continue
          e.status = next
          e.updatedAt = new Date().toISOString()
          n++
        }
        if (!n) return send(res, 404, { error: '没有匹配的词' })
        saveSlang(SLANG_FILE, entries)
        writePersona()
        log(`黑话状态改为 ${next}：${n} 条`)
        return send(res, 200, { ok: true, changed: n })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/slang/delete' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const entries = loadSlang(SLANG_FILE)
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [String(body.id || '')]
        const kept = entries.filter((e) => !ids.includes(e.id))
        if (kept.length === entries.length) return send(res, 404, { error: '没有匹配的词' })
        saveSlang(SLANG_FILE, kept)
        writePersona()
        return send(res, 200, { ok: true, removed: entries.length - kept.length })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/slang/learn' && req.method === 'POST') {
      try {
        return send(res, 200, { ok: true, ...runSlangLearn() })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/slang/research' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        return send(res, 200, { ok: true, ...runSlangResearch(body.ids) })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/voice' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        // 前端会把「当前表单上的值」一起带过来，这样「试听」和「发到 QQ」用的是同一套
        // 参数。以前只传 text，发送走的是已保存配置、试听走的是未保存表单值，
        // 改完没保存就会听到两个完全不同的声音。
        const override = body.voice && typeof body.voice === 'object' ? body.voice : null
        const file = await sendVoice(body.text || '这是一条测试语音', body.qq, override)
        log(`已发送语音: ${path.basename(file)}`)
        return send(res, 200, { ok: true, file })
      } catch (e) {
        log(`发语音失败: ${e.message}`)
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const src = url.searchParams.get('src') || 'dsh'
      const n = String(Math.min(Number(url.searchParams.get('lines') || 80), 500))
      let text = ''
      if (src === 'dsh') {
        const cfg = loadConfig()
        const r = await run('journalctl', ['-u', cfg.dsh.serviceName, '-n', n, '--no-pager', '-o', 'short-iso'])
        text = r.stdout
      } else if (src === 'napcat') {
        const r = await run('docker', ['logs', 'napcat', '--tail', n])
        text = (r.stdout || '') + (r.stderr || '')
      } else {
        text = ring.slice(-Number(n)).join('\n')
      }
      return send(res, 200, { text })
    }

    if (p === '/api/stickers' && req.method === 'GET') {
      const cfg = loadConfig()
      fs.mkdirSync(cfg.paths.stickers, { recursive: true })
      const files = listStickers()
      const index = loadIndex()
      return send(res, 200, {
        dir: cfg.paths.stickers,
        files,
        count: files.length,
        max: Number(cfg.stickers?.max) || 100,
        config: cfg.stickers,
        // 它自己从聊天里收进来的张数（区别于你手动上传的）
        savedCount: files.filter((f) => f.from && f.from !== 'upload').length,
        // 已经进过 QQ 收藏的张数
        syncedCount: Object.keys(index).length ? countQqSynced() : 0,
        stats: todayStats()
      })
    }

    /* 上传：走 saveSticker，这样上限、去重、索引入口是同一套 */
    if (p === '/api/stickers' && req.method === 'POST') {
      const cfg = loadConfig()
      const name = (url.searchParams.get('name') || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '')
      if (!name || !/\.(png|jpg|jpeg|gif|webp)$/i.test(name)) return send(res, 400, { error: '文件名不合法，需图片扩展名' })
      const buf = await readBody(req, 6 * 1024 * 1024)
      if (!buf.length) return send(res, 400, { error: '空文件' })

      const tmp = path.join(os.tmpdir(), `stk_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(name)}`)
      fs.writeFileSync(tmp, buf)
      try {
        const r = saveSticker(tmp, { name, from: 'upload' })
        log(`新增表情: ${r.name}${r.duplicate ? '（已存在，跳过）' : ''}`)
        return send(res, 200, { ok: true, name: r.name, count: r.count, duplicate: Boolean(r.duplicate) })
      } catch (e) {
        return send(res, 400, { error: e.message })
      } finally {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
      }
    }

    /* 改标签 / 描述：让用户能手动纠正模型的判断 */
    if (p === '/api/stickers/meta' && req.method === 'POST') {
      const body = await readJson(req)
      const name = path.basename(String(body.name || ''))
      const index = loadIndex()
      if (!index[name] && !fs.existsSync(path.join(loadConfig().paths.stickers, name))) {
        return send(res, 404, { error: '没有这张图' })
      }
      index[name] = {
        ...(index[name] || {}),
        tags: Array.isArray(body.tags) ? body.tags.filter(Boolean).slice(0, 6) : index[name]?.tags || [],
        desc: typeof body.desc === 'string' ? body.desc.slice(0, 120) : index[name]?.desc || ''
      }
      saveIndex(index)
      return send(res, 200, { ok: true, meta: index[name] })
    }

    if (p === '/api/stickers' && req.method === 'DELETE') {
      const cfg = loadConfig()
      const name = url.searchParams.get('name') || ''
      const file = path.join(cfg.paths.stickers, path.basename(name))
      if (!file.startsWith(cfg.paths.stickers)) return send(res, 403, { error: '非法路径' })
      return send(res, 200, { ok: true, count: removeSticker(name) })
    }

    /* ---------------- 文件管理器 ----------------
     * 根目录可切换，但每一档都锁死在自己的目录内，越界一律 403：
     *   root=workspace（默认）→ cfg.paths.workspace（/root/qq-workspace）
     *   root=dsh              → DSH_HOME（/root/.dsh，dsh 的数据目录）
     * 上传走 raw body（query 带文件名），不引 multipart 解析依赖。
     */
    const FS_ROOTS = {
      workspace: () => path.resolve(loadConfig().paths.workspace),
      dsh: () => path.resolve(DSH_HOME)
    }
    const fsRootOf = () => {
      const name = String(url.searchParams.get('root') || 'workspace')
      return (FS_ROOTS[name] || FS_ROOTS.workspace)()
    }
    // 写类接口的 root 在 body 里，读类接口在 query 里 —— 统一从两处取
    const fsRootFor = (body) => {
      const name = String(body && body.root ? body.root : url.searchParams.get('root') || 'workspace')
      return (FS_ROOTS[name] || FS_ROOTS.workspace)()
    }

    /**
     * 校验上传的相对路径，允许 `文件夹/子目录/文件.txt`。
     *
     * 【为什么要放行子目录】浏览器选文件夹上传时，每个文件都带
     * `webkitRelativePath`（形如 `我的资料/2026/图.png`）。以前这里要求
     * `name === basename(name)`，路径里的斜杠会被判非法 —— 结果「选了整个文件夹，
     * 一个都传不上去」。放行子路径才能保住目录结构。
     *
     * 【安全不降级】放行斜杠不等于放行穿越：
     * - 反斜杠统一成 `/`，防止 Windows 风格绕过；
     * - 拒绝绝对路径（`/x`、`C:x`）、空段、`.`、`..`、NUL；
     * - 最后仍然过 `resolveInRoot()`（真实前缀检查）—— 这层才是最终防线。
     */
    const safeRelPath = (rel) => {
      const s = String(rel || '').replace(/\\/g, '/')
      if (!s || s.length > 1024) return null
      if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
      const parts = s.split('/')
      for (const part of parts) {
        if (!part || part === '.' || part === '..') return null
        if (part.includes('\0')) return null
      }
      return parts.join('/')
    }

    if (p === '/api/fs/list' && req.method === 'GET') {
      try {
        const root = fsRootOf()
        const rel = url.searchParams.get('path') || ''
        const abs = resolveInRoot(root, rel)
        if (!abs) return send(res, 403, { error: '非法路径' })
        const st = fs.statSync(abs)
        if (st.isDirectory()) {
          return send(res, 200, { root, rootName: url.searchParams.get('root') || 'workspace', path: rel, dir: true, items: listDir(root, rel) })
        }
        return send(res, 200, { root, rootName: url.searchParams.get('root') || 'workspace', path: rel, dir: false, size: st.size, mtime: st.mtimeMs })
      } catch (e) {
        return send(res, 404, { error: e.message })
      }
    }

    if (p === '/api/fs/download' && req.method === 'GET') {
      try {
        const root = fsRootOf()
        const rel = url.searchParams.get('path') || ''
        const abs = resolveInRoot(root, rel)
        if (!abs) return send(res, 403, { error: '非法路径' })
        const st = fs.statSync(abs)
        if (st.isDirectory()) return send(res, 400, { error: '目录不能下载' })
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`
        })
        return fs.createReadStream(abs).pipe(res)
      } catch (e) {
        return send(res, 404, { error: e.message })
      }
    }

    if (p === '/api/fs/upload' && req.method === 'POST') {
      try {
        const root = fsRootOf()
        const dirRel = url.searchParams.get('path') || ''
        const rawName = url.searchParams.get('name') || ''
        // 允许 `文件夹/子目录/文件.txt`（文件夹上传要保结构），但每一段都必须是干净名字。
        // 不是放弃校验，是换成更细的校验 —— 原来的 basename 规则会连带把合法子目录拒掉，
        // 结果就是「选了整个文件夹，一个都传不上去」。
        const rel = safeRelPath(rawName)
        if (!rel) return send(res, 400, { error: '非法文件名' })
        const abs = resolveInRoot(root, path.join(dirRel, rel))
        if (!abs) return send(res, 403, { error: '非法文件名' })
        const buf = await readBody(req, 64 * 1024 * 1024)
        // 文件夹上传要就地建出缺失的子目录，否则写文件 ENOENT
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, buf)
        log(`文件上传：${path.join(dirRel, rel)}（${buf.length} 字节）`)
        return send(res, 200, { ok: true, path: path.join(dirRel, rel), size: buf.length })
      } catch (e) {
        return send(res, 500, { error: e.message })
      }
    }

    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        fsMkdir(fsRootFor(body), body.path)
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/fs/copy' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        copyPath(fsRootFor(body), body.from, body.to)
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/fs/rename' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        movePath(fsRootFor(body), body.from, body.to)
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    if (p === '/api/fs/delete' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        deletePath(fsRootFor(body), body.path)
        return send(res, 200, { ok: true })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }

    /* 同步本地库到机器人的 QQ 收藏夹（要 docker cp 进容器，慢，单独接口） */
    if (p === '/api/stickers/sync-qq' && req.method === 'POST') {
      try {
        const result = await syncToQqFavorites()
        return send(res, 200, result)
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message })
      }
    }

    if (p === '/api/stickers/file' && req.method === 'GET') {
      const cfg = loadConfig()
      const name = url.searchParams.get('name') || ''
      const file = path.join(cfg.paths.stickers, path.basename(name))
      if (!file.startsWith(cfg.paths.stickers) || !fs.existsSync(file)) return send(res, 404, 'not found')
      const ext = path.extname(file).toLowerCase()
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
      return res.end(fs.readFileSync(file))
    }

    return send(res, 404, { error: 'not found' })
  } catch (e) {
    log(`请求异常 ${p}: ${e.message}`)
    return send(res, 500, { error: e.message })
  }
})

/* ---------------- boot ---------------- */
loadState()
const bootCfg = loadConfig()
writeDshProfile()
writePersona()
writeCapabilities()
proxy.start()
proactive.start()

server.listen(PORT, BIND, () => {
  log(`控制面板已启动: http://${BIND}:${PORT}`)
  log(`代理端口 ${bootCfg.proxy.port} → dsh 端口 ${bootCfg.dsh.onebotPort}`)
})

/**
 * /dsh/* 的 WebSocket 升级。
 *
 * 必须单独挂在 server 的 upgrade 事件上：http.createServer 的回调只处理普通
 * 请求，WS 握手（Upgrade 头）不会走到那里，会直接被 Node 丢弃，前端就永远「连接中」。
 */
server.on('upgrade', (req, socket, head) => {
  const raw = req.url || '/'
  const p = raw.split('?')[0]
  if (p !== '/dsh' && !p.startsWith('/dsh/')) {
    socket.destroy()
    return
  }
  // 和普通请求一样的鉴权：没登录不让升级
  if (!authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  // 只切 /dsh 前缀，其余原样（含 ??、&）
  const rest = raw === '/dsh' ? '/' : raw.slice('/dsh'.length) || '/'
  proxyDshUpgrade(req, socket, head, rest).catch(() => {
    try {
      socket.destroy()
    } catch {
      /* 已经断了 */
    }
  })
})

/**
 * QQ 收藏自动同步：每 10 分钟瞄一眼本地库有没有新图。
 *
 * 不放在「存图那一刻」同步是有原因的：每张图都要 docker cp 进容器再调一次
 * add_custom_face，一次要一两秒。聊天里的存图是突发的高频动作，
 * 当场同步会拖慢它回话。聚成一批慢慢来更合适。
 */
let syncing = false
const autoSyncTimer = setInterval(async () => {
  if (syncing) return
  let cfg
  try {
    cfg = loadConfig()
  } catch {
    return
  }
  if (!cfg.stickers?.syncToQQ || !cfg.stickers?.enabled) return
  const pending = listStickers().filter((it) => !isQqSynced(it.name))
  if (!pending.length) return

  syncing = true
  try {
    const r = await syncToQqFavorites()
    log(`QQ 收藏自动同步：新增 ${r.added}，失败 ${(r.failed || []).length}`)
  } catch (e) {
    log(`QQ 收藏自动同步失败: ${e.message}`)
  } finally {
    syncing = false
  }
}, 10 * 60 * 1000)
autoSyncTimer.unref?.()

process.on('SIGTERM', () => {
  log('收到 SIGTERM，正在退出')
  proactive.stop()
  proxy.stop()
  clearInterval(autoSyncTimer)

  // 【为什么要有这个强制兜底】
  // `server.close()` 的回调要等**所有连接都断开**才触发。但面板有 SSE 长连接
  // （日志流、状态轮询、dsh 的反向代理），这些连接不会自己结束 ——
  // 于是回调永远不执行，进程不退出，systemd 等 90 秒后 SIGKILL。
  // 实测 21:06 那次重启就卡了 90 秒（`stop-sigterm timed out. Killing.`），
  // 期间 NapCat 连不上 8643，这段时间收到的消息全丢。
  //
  // 所以：先掐断所有连接，再用 800ms 硬超时兜底，绝不拖到 systemd 动手。
  //
  // 实测（2026-10-22 21:21）：closeAllConnections 之后 `server.close` 的回调仍然不触发
  // （面板进程里有 dsh 反向代理的 socket），所以实际每次都走兜底分支 —— 2 秒退出。
  // 收到 SIGTERM 到真正退出这段时间 NapCat 连不上 8643，越短越好，收到 800ms。
  const force = setTimeout(() => {
    log('退出超时，强制结束')
    process.exit(0)
  }, 800)
  force.unref?.()

  server.close(() => {
    clearTimeout(force)
    process.exit(0)
  })
  // Node 18.2+ 才有；有它才能立刻断开 SSE
  server.closeAllConnections?.()
})
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.stack || e.message}`))
