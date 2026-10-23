/**
 * dsh web 代理的 token 提取 —— 修一个「token 含 _ 和 - 被正则截断」的 bug
 *
 * 现象：概览页的「dsh 界面」卡片 iframe 显示「dsh web 没连上」，
 * 但概览页的 dsh 状态显示正常。
 *
 * 根因：这两处走的是两条独立链路。
 *   - 概览页「dsh 正常」= panel 通过 WS 连上 dsh 的 onebot（8645）
 *   - iframe 里的「dsh web 没连上」= panel 反向代理 3080 时没拿到 auth cookie
 *
 * auth cookie 拿不到的原因：dsh 的 token 是 40+ 字符、含 `_` 和 `-`，
 * 而抓取用的正则 `[A-Za-z0-9]+` 不含这两个字符，token 在第一个 `_`/`-` 处被截断，
 * 拿去换 cookie 必然 401。
 *
 * 实测（2026-10-23，真实服务器）：
 *   截断 token  IVMcpLxBup5jQanKTbNDyJpv7Z          → 401
 *   完整 token  IVMcpLxBup5jQanKTbNDyJpv7Z-PAH6...  → 303 + set-cookie
 */

import { extractTokenUrl } from '../panel/lib/dsh-proxy.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- T1 完整 token 不被截断 ---------- */
pass('T1a', '含下划线的 token 完整保留',
  extractTokenUrl('dsh web: http://127.0.0.1:3080/?token=oG2hrwG1tRGy_iF8CUK7bqhjnkoYJIEADqHuoJgwzv8') ===
    'http://127.0.0.1:3080/?token=oG2hrwG1tRGy_iF8CUK7bqhjnkoYJIEADqHuoJgwzv8')

pass('T1b', '含连字符的 token 完整保留',
  extractTokenUrl('dsh web: http://127.0.0.1:3080/?token=IVMcpLxBup5jQanKTbNDyJpv7Z-PAH6E8tTu3x5dJZw') ===
    'http://127.0.0.1:3080/?token=IVMcpLxBup5jQanKTbNDyJpv7Z-PAH6E8tTu3x5dJZw')

pass('T1c', '同时含下划线和连字符',
  extractTokenUrl('dsh web: http://127.0.0.1:3080/?token=N-ovLRU8ff_4ejjJzhZX5th_C7w7NSY9Mg1uk119-u0') ===
    'http://127.0.0.1:3080/?token=N-ovLRU8ff_4ejjJzhZX5th_C7w7NSY9Mg1uk119-u0')

/* ---------- T2 取最后一条（最新 token 覆盖旧的） ---------- */
const multi = [
  'dsh web: http://127.0.0.1:3080/?token=AAAA',
  'dsh web: http://127.0.0.1:3080/?token=BBBB-CCCC',
  'dsh web: http://127.0.0.1:3080/?token=LAST_token_123'
].join('\n')
pass('T2a', '多条日志取最后一条', extractTokenUrl(multi) === 'http://127.0.0.1:3080/?token=LAST_token_123')

/* ---------- T3 边界 ---------- */
pass('T3a', '没有 token 返回 null', extractTokenUrl('什么都没有\n只是一行普通日志') === null)
pass('T3b', '空串返回 null', extractTokenUrl('') === null)
pass('T3c', '只有残缺的 token=N 也能抓到（不崩溃）', extractTokenUrl('dsh web: http://127.0.0.1:3080/?token=N') === 'http://127.0.0.1:3080/?token=N')

/* ---------- T4 旧正则确实会坏（回归保护：确认新正则比旧的强） ---------- */
const badToken = 'http://127.0.0.1:3080/?token=oG2hrwG1tRGy_iF8CUK7bqhjnkoYJIEADqHuoJgwzv8'
const oldRegex = /http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9]+/g
const oldGot = badToken.match(oldRegex)
pass('T4a', '旧正则 [A-Za-z0-9]+ 确实会截断（证明 bug 真实存在）',
  oldGot && oldGot[0] === 'http://127.0.0.1:3080/?token=oG2hrwG1tRGy', oldGot && oldGot[0])

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
