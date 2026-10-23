/**
 * 文件管理器：安全路径解析 + 文件操作。
 *
 * 所有函数都假设「根目录」是 cfg.paths.workspace（默认 /root/qq-workspace）。
 * 核心安全规则只有一条：**任何路径 resolve 后必须在根目录内**，
 * 否则返回 null / 抛错。绝不访问系统目录。
 *
 * 这里只放不依赖 `ws` 的纯函数和文件操作，方便 `tests/fsapi-test.mjs` 直接测。
 * HTTP 层的路由写在 server.js 里。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 把「相对根目录的路径」解析成绝对路径；越界返回 null。
 *
 * @param {string} root 根目录绝对路径
 * @param {string} rel  相对路径（可以是 '' 表示根、'a/b'、'../etc' 之类）
 */
export function resolveInRoot(root, rel) {
  const r = path.resolve(String(root || ''))
  const p = path.resolve(r, String(rel || ''))
  if (p !== r && !p.startsWith(r + path.sep)) return null
  return p
}

/** 字节数 → 人话 */
export function formatSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 列目录：返回 [{name, dir, size, mtime}]，按目录在前、名称排序 */
export function listDir(root, rel = '') {
  const dir = resolveInRoot(root, rel)
  if (!dir) throw new Error('非法路径')
  const st = fs.statSync(dir)
  if (!st.isDirectory()) throw new Error('不是目录')
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const full = path.join(dir, e.name)
      let size = 0
      let mtime = 0
      try {
        const s = fs.statSync(full)
        size = s.isDirectory() ? 0 : s.size
        mtime = s.mtimeMs
      } catch {
        /* 读不到就跳过 size */
      }
      return { name: e.name, dir: e.isDirectory(), size, mtime }
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))
}

/** 判断某个相对路径是否存在（且不越界） */
export function exists(root, rel) {
  const p = resolveInRoot(root, rel)
  if (!p) return false
  return fs.existsSync(p)
}

/** 复制：文件用 copyFile，目录用 cpSync 递归。目标已存在则抛错（防覆盖）。 */
export function copyPath(root, fromRel, toRel) {
  const src = resolveInRoot(root, fromRel)
  const dst = resolveInRoot(root, toRel)
  if (!src || !dst) throw new Error('非法路径')
  if (src === dst) throw new Error('源和目标相同')
  if (!fs.existsSync(src)) throw new Error('源不存在')
  if (fs.existsSync(dst)) throw new Error('目标已存在')
  const s = fs.statSync(src)
  if (s.isDirectory()) fs.cpSync(src, dst, { recursive: true })
  else fs.copyFileSync(src, dst)
  return dst
}

/** 移动/重命名：源在根内、目标在根内、目标不存在 */
export function movePath(root, fromRel, toRel) {
  const src = resolveInRoot(root, fromRel)
  const dst = resolveInRoot(root, toRel)
  if (!src || !dst) throw new Error('非法路径')
  if (!fs.existsSync(src)) throw new Error('源不存在')
  if (fs.existsSync(dst)) throw new Error('目标已存在')
  fs.renameSync(src, dst)
  return dst
}

/** 删除：文件或目录都行（目录递归）。不可删根目录本身。 */
export function deletePath(root, rel) {
  const p = resolveInRoot(root, rel)
  if (!p) throw new Error('非法路径')
  if (p === path.resolve(root)) throw new Error('不能删除根目录')
  if (!fs.existsSync(p)) throw new Error('不存在')
  fs.rmSync(p, { recursive: true, force: true })
  return p
}

/** 新建文件夹 */
export function mkdir(root, rel) {
  const p = resolveInRoot(root, rel)
  if (!p) throw new Error('非法路径')
  fs.mkdirSync(p, { recursive: true })
  return p
}
