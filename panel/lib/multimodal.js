import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { execFile } from 'node:child_process'

export const IMAGE_LIMIT = 10 * 1024 * 1024
export const AUDIO_LIMIT = 20 * 1024 * 1024

export function endpoint(base, suffix) {
  const root = String(base || '').trim()
  if (!root) throw new Error('未配置接口地址')
  const url = new URL(root.replace(/\/+$/, '') + '/' + suffix)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址须为不带账号密码的 HTTP(S) 地址')
  return url.href
}

export function safeError(error, ...keys) {
  let text = String(error?.message || error || '请求失败')
  for (const key of keys.filter(Boolean)) text = text.split(String(key)).join('[密钥已隐藏]')
  return text.replace(/https?:\/\/\S+/g, '[接口地址]').slice(0, 240)
}

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const s = ip.toLowerCase()
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('::ffff:')
}

async function publicURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('媒体地址须为 HTTP(S) 地址')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  if (!addresses.length || addresses.some(({ address }) => privateIP(address))) throw new Error('媒体地址不能指向本机或内网')
  return url
}

export async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('媒体或接口响应超过大小限制')
  }
  const parts = []
  let size = 0
  for await (const part of response.body || []) {
    size += part.length
    if (size > limit) {
      await response.body?.cancel().catch(() => {})
      throw new Error('媒体或接口响应超过大小限制')
    }
    parts.push(part)
  }
  return Buffer.concat(parts)
}

export async function downloadMedia(value, limit, timeout = 20000) {
  const signal = AbortSignal.timeout(timeout)
  let current = value
  for (let i = 0; i < 4; i++) {
    const url = await publicURL(current)
    const response = await fetch(url, { signal, redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      current = new URL(response.headers.get('location'), url).href
      continue
    }
    if (!response.ok) throw new Error(`下载媒体 HTTP ${response.status}`)
    const buffer = await readLimited(response, limit)
    if (!buffer.length) throw new Error('媒体内容为空')
    return { buffer, mime: (response.headers.get('content-type') || '').split(';')[0] }
  }
  throw new Error('媒体重定向次数过多')
}

async function jsonRequest(url, options, key, limit = 16 * 1024 * 1024) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error' })
    const buffer = await readLimited(response, limit)
    let json
    try { json = JSON.parse(buffer.toString('utf8')) } catch { throw new Error(`接口返回无效 JSON（HTTP ${response.status}）`) }
    if (!response.ok) throw new Error(`接口 HTTP ${response.status}`)
    return json
  } catch (error) { throw new Error(safeError(error, key)) }
}

function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg'
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp'
  throw new Error('生图结果不是支持的 PNG/JPEG/WebP 图片')
}

export async function generateImage(prompt, config, workspace) {
  if (config?.enabled !== true) throw new Error('生图能力未开启')
  const text = String(prompt || '').trim()
  if (!text || text.length > 4000) throw new Error('生图描述须为 1–4000 字')
  if (!config.model) throw new Error('未配置生图模型')
  const json = await jsonRequest(endpoint(config.baseUrl, 'images/generations'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model, prompt: text, n: 1, size: config.size || '1024x1024' }), signal: AbortSignal.timeout(90000)
  }, config.apiKey)
  const item = json.data?.[0]
  let buffer
  if (typeof item?.b64_json === 'string') {
    if (item.b64_json.length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(item.b64_json)) throw new Error('生图 base64 无效或过大')
    buffer = Buffer.from(item.b64_json, 'base64')
  } else if (typeof item?.url === 'string') {
    buffer = (await downloadMedia(item.url, IMAGE_LIMIT)).buffer
  } else throw new Error('接口未返回 url 或 b64_json')
  if (!buffer.length || buffer.length > IMAGE_LIMIT) throw new Error('生图结果为空或超过 10MB')
  const ext = imageType(buffer)
  const directory = path.join(workspace, 'generated-images')
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, `${Date.now()}-${crypto.randomUUID()}.${ext}`)
  await fs.writeFile(file, buffer, { mode: 0o600 })
  // 只清理本功能生成的旧文件，避免长期积累。
  // stat 失败（文件正好被删/权限变动）不能连带把这次成功的生图也搞成失败，
  // 所以逐个 catch 掉。
  for (const name of await fs.readdir(directory)) {
    if (!/^\d+-[0-9a-f-]+\.(png|jpg|webp)$/.test(name)) continue
    const candidate = path.join(directory, name)
    try {
      const stat = await fs.stat(candidate)
      if (Date.now() - stat.mtimeMs > 7 * 86400000) await fs.unlink(candidate)
    } catch {
      /* 清理是顺手活，失败不影响本次结果 */
    }
  }
  return { file, bytes: buffer.length }
}

function convertAudio(input, output) {
  return new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-y', '-i', input, '-t', '180', '-ar', '16000', '-ac', '1', output], { timeout: 25000, maxBuffer: 65536 }, error => error ? reject(new Error('语音转码失败或超时')) : resolve()))
}

/**
 * 外部语音识别：转码 → multipart 上传 → 取 text。
 *
 * `deps.convert` 只为测试留的口子：没装 ffmpeg 的环境（比如开发机）
 * 也能验证请求构造和错误处理，不必为了跑测试去装一套 ffmpeg。
 * 生产调用不传第三参，走真实的 convertAudio。
 */
export async function transcribeAudio(buffer, config, deps = {}) {
  if (!buffer?.length || buffer.length > AUDIO_LIMIT) throw new Error('音频为空或超过 20MB')
  if (!config?.model) throw new Error('未配置语音识别模型')
  const convert = typeof deps.convert === 'function' ? deps.convert : convertAudio
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-asr-'))
  try {
    const input = path.join(directory, 'input.audio')
    const output = path.join(directory, 'audio.wav')
    await fs.writeFile(input, buffer, { mode: 0o600 })
    await convert(input, output)
    const form = new FormData()
    form.append('model', config.model)
    form.append('file', new Blob([await fs.readFile(output)], { type: 'audio/wav' }), 'audio.wav')
    if (config.language) form.append('language', config.language)
    const json = await jsonRequest(endpoint(config.baseUrl, 'audio/transcriptions'), {
      method: 'POST', headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, body: form, signal: AbortSignal.timeout(45000)
    }, config.apiKey, 256 * 1024)
    if (typeof json.text !== 'string' || !json.text.trim()) throw new Error('语音识别未返回文字')
    return json.text.trim().slice(0, 8000)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
