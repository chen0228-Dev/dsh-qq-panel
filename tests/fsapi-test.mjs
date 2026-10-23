/**
 * 文件管理器安全模块测试
 *
 * 核心安全规则：任何路径 resolve 后必须落在根目录内，越界一律拒绝。
 * 这是给用户「整理服务器文件」用的，绝不能让他碰到 /etc、/root/.ssh 之类。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInRoot, listDir, formatSize, exists, copyPath, movePath, deletePath, mkdir } from '../panel/lib/fsapi.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsapi-'))
const root = path.join(tmp, 'workspace')
fs.mkdirSync(root, { recursive: true })

/* ---------- F1 路径穿越防护 ---------- */
pass('F1a', '根目录本身合法', resolveInRoot(root, '') === path.resolve(root))
pass('F1b', '正常子路径合法', resolveInRoot(root, 'a/b/c') === path.join(root, 'a', 'b', 'c'))
pass('F1c', '../ 穿越被拒', resolveInRoot(root, '../etc') === null)
pass('F1d', '绝对路径指向根外被拒', resolveInRoot(root, '/etc/passwd') === null)
pass('F1e', '深层穿越被拒', resolveInRoot(root, 'a/../../etc') === null)
pass('F1f', '用 .. 但仍在根内是允许的', resolveInRoot(root, 'a/../b') === path.join(root, 'b'))
pass('F1g', '根目录再往上一级被拒', resolveInRoot(root, '..') === null)

/* ---------- F2 列目录 ---------- */
fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
fs.writeFileSync(path.join(root, 'readme.txt'), 'hello')
fs.writeFileSync(path.join(root, 'docs', 'note.md'), '# hi')
const items = listDir(root, '')
pass('F2a', '列根目录拿到 2 项', items.length === 2, items.map((i) => i.name).join(','))
pass('F2b', '目录排前面', items[0].dir === true && items[0].name === 'docs')
pass('F2c', '文件带大小', items.find((i) => i.name === 'readme.txt').size === 5)
pass('F2d', '越界列目录抛错', (() => { try { listDir(root, '../etc'); return false } catch { return true } })())

/* ---------- F3 复制 / 移动 / 删除 / 建夹 ---------- */
copyPath(root, 'readme.txt', 'copy.txt')
pass('F3a', '复制文件', exists(root, 'copy.txt') && fs.readFileSync(path.join(root, 'copy.txt'), 'utf8') === 'hello')

movePath(root, 'copy.txt', 'docs/moved.txt')
pass('F3b', '移动（跨目录）', exists(root, 'docs/moved.txt') && !exists(root, 'copy.txt'))

mkdir(root, 'newdir')
pass('F3c', '新建文件夹', fs.existsSync(path.join(root, 'newdir')) && fs.statSync(path.join(root, 'newdir')).isDirectory())

copyPath(root, 'docs', 'docs-backup')
pass('F3d', '复制整个目录（递归）', exists(root, 'docs-backup/note.md'))

deletePath(root, 'docs-backup')
pass('F3e', '删除目录（递归）', !exists(root, 'docs-backup'))

/* ---------- F4 防护：不能删根、不能覆盖 ---------- */
pass('F4a', '删根目录被拒', (() => { try { deletePath(root, ''); return false } catch { return true } })())
pass('F4b', '复制到已存在的目标被拒', (() => { try { copyPath(root, 'readme.txt', 'readme.txt'); return false } catch { return true } })())
pass('F4c', '复制不存在的源被拒', (() => { try { copyPath(root, 'nope.txt', 'x.txt'); return false } catch { return true } })())
pass('F4d', '移动的源被限制在根内', (() => { try { movePath(root, '../readme.txt', 'x.txt'); return false } catch { return true } })())

/* ---------- F5 formatSize ---------- */
pass('F5a', '字节', formatSize(500) === '500 B')
pass('F5b', 'KB', formatSize(2048) === '2.0 KB')
pass('F5c', 'MB', formatSize(5 * 1024 * 1024) === '5.0 MB')
pass('F5d', '0 不崩', formatSize(0) === '0 B')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
