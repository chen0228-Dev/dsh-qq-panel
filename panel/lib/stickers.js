/**
 * 表情包库：文件 + 语义索引。
 *
 * 为什么要有索引：文件名只能靠猜（`微笑_可爱.png` 还好，`007.png` 就废了），
 * 而模型挑图靠的是语义。所以每张图存一个 `index.json` 条目，写清楚
 * 它表达什么情绪、什么场景用，模型是按这些描述挑的，不是按文件名。
 *
 * 索引不会因为文件丢失而报错：读的时候以磁盘为准，索引只是补充说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadConfig } from './store.js'

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

function dirOf() {
  return loadConfig().paths.stickers
}

function indexPath() {
  return path.join(dirOf(), 'index.json')
}

export function isImage(name) {
  return IMAGE_EXT.includes(path.extname(String(name)).toLowerCase())
}

/** 读索引。文件损坏时返回空对象，不让一张坏 JSON 把整个面板带崩。 */
export function loadIndex() {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

export function saveIndex(index) {
  const dir = dirOf()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf8')
}

/** 列出现有图片，合并索引信息。以磁盘为准，索引里多余的直接忽略。 */
export function listStickers() {
  const dir = dirOf()
  let files = []
  try {
    files = fs.readdirSync(dir).filter(isImage)
  } catch {
    return []
  }
  const index = loadIndex()
  const out = files.map((name) => {
    const full = path.join(dir, name)
    let size = 0
    let mtime = 0
    try {
      const st = fs.statSync(full)
      size = st.size
      mtime = st.mtimeMs
    } catch {
      /* ignore */
    }
    const meta = index[name] || {}
    return {
      name,
      size,
      mtime,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      desc: typeof meta.desc === 'string' ? meta.desc : '',
      from: meta.from || '',
      used: Number(meta.used) || 0,
      lastUsed: Number(meta.lastUsed) || 0
    }
  })
  // 常用的排前面，方便一眼看到它偏爱哪些
  out.sort((a, b) => b.used - a.used || a.name.localeCompare(b.name, 'zh'))
  return out
}

export function countStickers() {
  const dir = dirOf()
  try {
    return fs.readdirSync(dir).filter(isImage).length
  } catch {
    return 0
  }
}

function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|]/g, '_').trim()
  return base || `sticker_${Date.now()}`
}

function hashOf(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

export { hashOf }

/** 库里有没有一模一样的图（按内容哈希）。用于自动保存时去重。 */
export function findDuplicate(srcPath) {
  const h = hashOf(srcPath)
  if (!h) return null
  const dir = dirOf()
  let files = []
  try {
    files = fs.readdirSync(dir).filter(isImage)
  } catch {
    return null
  }
  for (const name of files) {
    if (hashOf(path.join(dir, name)) === h) return name
  }
  return null
}

/**
 * 存一张图进库。
 *
 * 上限检查是关键：`max` 到了就抛错，不静默覆盖也不无限膨胀。
 * 返回 `{ name, replaced, count }`。
 */
export function saveSticker(srcPath, opts = {}) {
  const cfg = loadConfig()
  const cap = Math.max(1, Number(cfg.stickers?.max) || 100)
  const dir = dirOf()
  fs.mkdirSync(dir, { recursive: true })

  if (!fs.existsSync(srcPath)) throw new Error(`文件不存在: ${srcPath}`)
  const st = fs.statSync(srcPath)
  if (!st.isFile()) throw new Error('只能保存文件')
  if (st.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB，不存')

  const dup = findDuplicate(srcPath)
  if (dup) return { name: dup, replaced: true, count: countStickers(), duplicate: true }

  let name = sanitizeName(opts.name || path.basename(srcPath))
  if (!isImage(name)) name += path.extname(srcPath) || '.png'

  const target = path.join(dir, name)
  // 同名但内容不同：加序号，别把别人覆盖掉
  if (fs.existsSync(target)) {
    const ext = path.extname(name)
    const stem = name.slice(0, -ext.length)
    let n = 2
    while (fs.existsSync(path.join(dir, `${stem}_${n}${ext}`))) n++
    name = `${stem}_${n}${ext}`
  }

  if (countStickers() >= cap) {
    throw new Error(`表情库已满（上限 ${cap} 张）。先删几张再存，或者去面板把上限调大。`)
  }

  fs.copyFileSync(srcPath, path.join(dir, name))

  const index = loadIndex()
  index[name] = {
    tags: Array.isArray(opts.tags) ? opts.tags.filter(Boolean).slice(0, 6) : [],
    desc: String(opts.desc || '').slice(0, 120),
    from: opts.from || 'saved',
    addedAt: Date.now(),
    used: 0,
    lastUsed: 0
  }
  saveIndex(index)
  return { name, replaced: false, count: countStickers() }
}

export function removeSticker(name) {
  const dir = dirOf()
  const file = path.join(dir, path.basename(String(name || '')))
  if (!file.startsWith(dir)) throw new Error('非法路径')
  if (fs.existsSync(file)) fs.unlinkSync(file)
  const index = loadIndex()
  delete index[path.basename(name)]
  saveIndex(index)
  return countStickers()
}

/** 记一次使用，用来统计它偏爱哪几张（不影响随机挑选，只是数据）。 */
export function markUsed(name) {
  const index = loadIndex()
  const key = path.basename(String(name || ''))
  const meta = index[key] || {}
  meta.used = (Number(meta.used) || 0) + 1
  meta.lastUsed = Date.now()
  index[key] = meta
  saveIndex(index)
}

/**
 * 生成给模型看的清单。只列有语义信息的条目 —— 没有标签的用文件名兜底，
 * 因为模型至少能从「无语_白眼」这种名字里读出意思。
 */
export function renderCatalog(limit = 100) {
  const items = listStickers().slice(0, limit)
  if (!items.length) return null
  const now = Date.now()
  return items.map((it) => {
    const looks = it.tags.length ? it.tags.join('、') : ''
    const desc = it.desc || ''
    // 标一下最近发过的：不然它老挑同几张，对方看着像卡带
    const ago = Number(it.lastUsed || 0)
    let mark = ''
    if (ago) {
      const hours = (now - ago) / 3600000
      mark = hours < 12 ? '（12 小时内发过）' : hours < 48 ? '（一两天前发过）' : ''
    }
    const tail = [looks, desc].filter(Boolean).join('；')
    const body = tail ? `- \`${it.name}\` — ${tail}` : `- \`${it.name}\``
    return body + mark
  })
}

/** 当天统计：对方发了几个表情、它自己发了几个。给自适应频率做参考。 */
export function todayStats() {
  const cfg = loadConfig()
  const state = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(cfg.paths.workspace, 'sticker-stats.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  const today = new Date().toISOString().slice(0, 10)
  const s = state[today] || { incoming: 0, outgoing: 0 }
  return { date: today, incoming: Number(s.incoming) || 0, outgoing: Number(s.outgoing) || 0 }
}

export function bumpStats(kind) {
  const cfg = loadConfig()
  const file = path.join(cfg.paths.workspace, 'sticker-stats.json')
  let state = {}
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    state = {}
  }
  const today = new Date().toISOString().slice(0, 10)
  const s = state[today] || { incoming: 0, outgoing: 0 }
  s[kind] = (Number(s[kind]) || 0) + 1
  state[today] = s
  // 只留最近 14 天，别让这个文件长成巨无霸
  const keys = Object.keys(state).sort().slice(-14)
  const trimmed = {}
  for (const k of keys) trimmed[k] = state[k]
  try {
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
  return s
}
