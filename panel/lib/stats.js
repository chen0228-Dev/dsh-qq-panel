import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { DSH_HOME, PROFILE_DIR } from './store.js'

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cachedTokens']
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// dsh 的会话落盘是 .jsonl 或 .jsonl.zstd。早期版本还可能是纯 .jsonl，两者都要认。
const SESSION_FILE = /\.(jsonl|jsonl\.zstd|ndjson|ndjson\.zstd)$/i

/* ---------------- 会话文件读取（含 zstd 多帧） ---------------- */

/**
 * dsh 的 zstd 会话文件是「多帧追加」结构：每次 flush 压一帧接在后面。
 * Node 的 zstdDecompressSync / createZstdDecompress 只解第一帧，所以必须逐帧切。
 */
function inflateFrames(buf) {
  const starts = []
  let i = 0
  while (i < buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  if (!starts.length) return null
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)))
    } catch {
      /* 末帧可能正在写入被截断，跳过 */
    }
  }
  return parts.length ? Buffer.concat(parts) : null
}

function zstdToText(file, buf) {
  // 1) 系统 zstd：原生处理多帧追加，最稳
  try {
    const out = execFileSync('zstd', ['-dc', '--quiet', file], {
      maxBuffer: 96 * 1024 * 1024,
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (out && out.length) return out.toString('utf8')
  } catch (e) {
    // 文件尾部还在写时 zstd 会非零退出，但标准输出里的完整帧是有效的
    if (e && e.stdout && e.stdout.length) return e.stdout.toString('utf8')
  }
  // 2) 手工切帧
  const man = inflateFrames(buf)
  if (man && man.length) return man.toString('utf8')
  // 3) 单帧兜底
  try {
    return zlib.zstdDecompressSync(buf).toString('utf8')
  } catch {
    return ''
  }
}

// 解压结果按 (文件, 大小, mtime) 缓存，避免每次刷新都 spawn zstd
const textCache = new Map()
const CACHE_LIMIT = 12

function readText(file, size, mtime) {
  const key = `${file}|${size}|${mtime}`
  if (textCache.has(key)) return textCache.get(key)
  for (const k of [...textCache.keys()]) if (k.startsWith(`${file}|`)) textCache.delete(k)

  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return null
  }
  const text = /\.zstd$/i.test(file) ? zstdToText(file, buf) : buf.toString('utf8')
  if (textCache.size >= CACHE_LIMIT) textCache.delete(textCache.keys().next().value)
  textCache.set(key, text)
  return text
}

/* ---------------- 目录扫描 ---------------- */

function walk(dir, depth, out, seen) {
  if (depth < 0) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'media') continue
      walk(full, depth - 1, out, seen)
    } else if (SESSION_FILE.test(e.name) && !seen.has(full)) {
      seen.add(full)
      try {
        const st = fs.statSync(full)
        if (st.size > 0 && st.size < 64 * 1024 * 1024) out.push({ file: full, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* ignore */
      }
    }
  }
}

/* ---------------- 字段提取 ---------------- */

function dayOf(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function lineTs(obj) {
  const cands = [obj.ts, obj.timestamp, obj.createdAt, obj.time, obj.at, obj.data?.time]
  for (const c of cands) {
    if (typeof c === 'number' && c > 1e11) return c
    if (typeof c === 'number' && c > 1e9) return c * 1000
    if (typeof c === 'string') {
      const t = Date.parse(c)
      if (!Number.isNaN(t)) return t
    }
  }
  return null
}

/**
 * 取这一行的用量。
 * 注意：dsh 的 assistant/message 行里 usage 出现两次（data.usage 和 data.stream[].chunk.usage，
 * 后者是流式过程里的同一份副本），全树递归会把数字算成两倍。所以只认权威路径，
 * 找不到才退回「取第一个命中的 usage」，绝不做全树累加。
 */
function pickUsage(obj) {
  const a = obj?.data?.usage
  if (a && typeof a === 'object' && !Array.isArray(a)) return a
  const b = obj?.usage
  if (b && typeof b === 'object' && !Array.isArray(b)) return b
  return firstUsage(obj, 0)
}

function firstUsage(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = firstUsage(it, depth + 1)
      if (r) return r
    }
    return null
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'usage' && v && typeof v === 'object' && !Array.isArray(v)) return v
  }
  for (const v of Object.values(node)) {
    const r = firstUsage(v, depth + 1)
    if (r) return r
  }
  return null
}

function pickModel(obj) {
  return (
    obj?.data?.message?.source?.model ||
    obj?.data?.source?.model ||
    obj?.data?.model ||
    obj?.model ||
    null
  )
}

function sumTokens(u, acc) {
  let hit = false
  for (const tk of TOKEN_KEYS) {
    const n = Number(u[tk])
    if (Number.isFinite(n) && n > 0) {
      acc[tk] = (acc[tk] || 0) + n
      hit = true
    }
  }
  return hit
}

/* ---------------- 汇总 ---------------- */

export function collectStats() {
  const roots = [path.join(DSH_HOME, 'sessions'), path.join(PROFILE_DIR, 'sessions'), path.join(DSH_HOME, 'storages')]
  const files = []
  const seen = new Set()
  for (const r of roots) walk(r, 5, files, seen)
  if (!files.length) walk(DSH_HOME, 3, files, seen)

  const totals = {}
  const byDay = {}
  const byModel = {}
  const byKey = {} // 去重：同一 seq/消息 id 只认一次
  let filesWithUsage = 0
  let readFailed = 0

  for (const f of files) {
    const text = readText(f.file, f.size, f.mtime)
    if (!text) {
      readFailed++
      continue
    }
    let touched = false
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s || s[0] !== '{') continue
      let obj
      try {
        obj = JSON.parse(s)
      } catch {
        continue
      }
      const usage = pickUsage(obj)
      if (!usage) continue
      const acc = {}
      if (!sumTokens(usage, acc)) continue

      // 同一轮对话的同一 step 只计一次（防止重复写入导致翻倍）
      const uniq = obj.seq != null ? `${f.file}#${obj.seq}#${obj.type || ''}` : null
      if (uniq) {
        if (byKey[uniq]) continue
        byKey[uniq] = 1
      }

      touched = true
      const day = dayOf(lineTs(obj) || f.mtime)
      const model = pickModel(obj) || 'unknown'

      for (const k of Object.keys(acc)) totals[k] = (totals[k] || 0) + acc[k]

      const d = byDay[day] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
      d.inputTokens += acc.inputTokens || 0
      d.outputTokens += acc.outputTokens || 0
      d.cacheReadTokens += acc.cacheReadTokens || 0
      d.calls += 1
      byDay[day] = d

      const m = byModel[model] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
      m.inputTokens += acc.inputTokens || 0
      m.outputTokens += acc.outputTokens || 0
      m.cacheReadTokens += acc.cacheReadTokens || 0
      m.calls += 1
      byModel[model] = m
    }
    if (touched) filesWithUsage++
  }

  const sum = (n) => {
    const cutoff = Date.now() - n * 86400_000
    let input = 0
    let output = 0
    let cached = 0
    let calls = 0
    for (const [d, v] of Object.entries(byDay)) {
      if (new Date(`${d}T23:59:59`).getTime() < cutoff) continue
      input += v.inputTokens
      output += v.outputTokens
      cached += v.cacheReadTokens
      calls += v.calls
    }
    return { inputTokens: input, outputTokens: output, cacheReadTokens: cached, calls }
  }
  const today = byDay[dayOf(Date.now())] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }

  // 估算费用，仅量级参考；真实账单以 DeepSeek 后台为准
  const PRICE = { input: 0.15, cacheRead: 0.015, output: 0.6 }
  const costOf = (v) =>
    (v.inputTokens / 1e6) * PRICE.input + (v.cacheReadTokens / 1e6) * PRICE.cacheRead + (v.outputTokens / 1e6) * PRICE.output

  let note = null
  if (!files.length) note = '还没找到会话文件（dsh 会在第一次对话后写入 ~/.dsh/sessions/）'
  else if (readFailed && !filesWithUsage) note = `找到 ${files.length} 个会话文件但都读不出来，可能缺少 zstd 解压能力`
  else if (!filesWithUsage) note = '会话文件还没有用量记录（发条消息后这里就会有数据）'

  return {
    files: files.length,
    filesWithUsage,
    today,
    last7: sum(7),
    last30: sum(30),
    allTime: totals,
    byDay,
    byModel,
    estimateUSD: { today: costOf(today), last7: costOf(sum(7)), last30: costOf(sum(30)) },
    price: PRICE,
    note
  }
}
