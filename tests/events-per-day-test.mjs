/**
 * 「每天抽几个活动」支持「让她自己定」
 *
 * 原来 `campus.eventsPerDay` 只能是 0/1/2/3 的死数字，每天抽出来的条数一模一样。
 * 用户要的是：这个数量也能放手给她 —— 忙的日子多安排两件，累了就一件不安排。
 *
 * 实现要点（也是最容易做错的地方）：
 *   1. `'auto'` 必须一路活到抽签那一刻。中途任何一处 `Number('auto')` 都会变 NaN，
 *      最后变成「一个活动都抽不出来」，而且面板上完全看不出原因。
 *   2. 同一天必须返回同一个数。状态机每 30 秒重算一次，数一变她的状态就跳。
 *   3. 不能影响固定模式。洗牌用的是 mulberry32(seed)，如果抽条数时借同一条随机流，
 *      洗牌序列会整体错位 —— 等于把「固定 1-3 个」的既有行为也一起改了。
 *
 * 本测试盯三件事：规范化、按天稳定、固定模式不受影响。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

// campus.js 会读 PANEL_DATA 下的 campus-extra.json，指到临时目录免得读到真实活动池
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evpd-'))
process.env.PANEL_DATA = tmp

const { normalizeEventsPerDay, resolveEventsPerDay, todaysEvents } = await import(
  new URL('../panel/lib/campus.js', import.meta.url).href
)

/* ---------- E1 规范化：'auto' 必须活着到抽签 ---------- */
const normCases = [
  ['auto', 'auto', "'auto' 原样保留"],
  ['random', 'auto', "'random' 归一成 auto"],
  [0, 0, '0 保留'],
  [1, 1, '1 保留'],
  [3, 3, '3 保留'],
  [5, 3, '超上限夹到 3'],
  [-2, 0, '负数夹到 0'],
  ['2', 2, '数字字符串转数字'],
  ['abc', 1, '垃圾值回默认 1（不是 0）'],
  [null, 1, 'null → 1'],
  [undefined, 1, 'undefined → 1'],
  ['', 1, '空串 → 1（Number("")=0 是坑）'],
  ['  ', 1, '纯空白也算空'],
  [NaN, 1, 'NaN → 1']
]
for (const [input, want, label] of normCases) {
  const got = normalizeEventsPerDay(input)
  pass('E1', label, got === want, `${JSON.stringify(input)} → ${JSON.stringify(got)}`)
}

/* ---------- E2 固定模式：原样返回，不摇 ---------- */
for (const n of [0, 1, 2, 3]) {
  const seen = new Set()
  for (let seed = 1; seed <= 200; seed++) seen.add(resolveEventsPerDay({ eventsPerDay: n }, seed))
  pass('E2', `固定 ${n} 个：200 个种子都返回 ${n}`, seen.size === 1 && seen.has(n), [...seen].join(','))
}

/* ---------- E3 同一天必须稳定 ---------- */
const seed1 = 12345
const once = resolveEventsPerDay({ eventsPerDay: 'auto' }, seed1)
let stable = true
for (let i = 0; i < 50; i++) {
  if (resolveEventsPerDay({ eventsPerDay: 'auto' }, seed1) !== once) stable = false
}
pass('E3a', '同一个 seed 连算 50 次结果一致（状态机每 30 秒会重算）', stable, `值 = ${once}`)

/* ---------- E4 auto 的分布 ---------- */
// 用「看起来像真实日期」的 seed 序列，跑一年
const counts = { 0: 0, 1: 0, 2: 0, 3: 0 }
const DAYS = 365
for (let i = 0; i < DAYS; i++) {
  const d = new Date(2026, 0, 1 + i)
  const ds = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  let h = 0
  for (let k = 0; k < ds.length; k++) h = (h * 31 + ds.charCodeAt(k)) % 1000003
  counts[resolveEventsPerDay({ eventsPerDay: 'auto' }, h)]++
}
const pct = (n) => Math.round((counts[n] / DAYS) * 100)
pass('E4a', '0-3 四种情况都出现过', Object.values(counts).every((v) => v > 0), `0:${pct(0)}% 1:${pct(1)}% 2:${pct(2)}% 3:${pct(3)}%`)
pass('E4b', '没有哪种情况占绝对多数（<70%）', Object.values(counts).every((v) => v / DAYS < 0.7))
pass('E4c', '一天一个都没有的日子是少数（<30%）', counts[0] / DAYS < 0.3, `${pct(0)}%`)
pass('E4d', '平均每天 1-2 个（体感和固定 1 个接近）', (() => {
  const sum = counts[0] * 0 + counts[1] * 1 + counts[2] * 2 + counts[3] * 3
  const avg = sum / DAYS
  return avg > 1.0 && avg < 2.0
})(), `${((counts[1] + counts[2] * 2 + counts[3] * 3) / DAYS).toFixed(2)} 个/天`)

/* ---------- E5 集成：todaysEvents 真的按 auto 抽 ---------- */
const pool = [
  { label: 'A', from: '09:00', to: '10:30', busy: 1, line: 'a' },
  { label: 'B', from: '11:00', to: '12:30', busy: 1, line: 'b' },
  { label: 'C', from: '14:00', to: '15:30', busy: 1, line: 'c' },
  { label: 'D', from: '16:00', to: '17:30', busy: 1, line: 'd' },
  { label: 'E', from: '19:00', to: '20:30', busy: 1, line: 'e' }
]
const mk = (epd) => ({ campus: { enabled: true, eventsPerDay: epd, routine: { version: 1, source: 'custom', slots: [], events: pool, eventsPerDay: epd } } })

let integOk = true
const sizes = new Set()
for (let i = 0; i < 40; i++) {
  const picked = todaysEvents(mk('auto'), new Date(2026, 2, 1 + i))
  sizes.add(picked.length)
  if (picked.length > 3) integOk = false
  // 同一天调两次必须一样（面板刷新不能变）
  const again = todaysEvents(mk('auto'), new Date(2026, 2, 1 + i))
  if (again.length !== picked.length || again.map((x) => x.label).join() !== picked.map((x) => x.label).join()) integOk = false
}
pass('E5a', 'auto 下抽到的条数有变化（不是永远同一个数）', sizes.size > 1, `出现过 ${[...sizes].sort().join('/')} 个`)
pass('E5b', 'auto 下最多 3 个、同一天两次调用结果一致', integOk)

const fixed3 = todaysEvents(mk(3), new Date(2026, 2, 1))
pass('E5c', '固定 3 个时还是抽满 3 个（不受 auto 影响）', fixed3.length === 3, `${fixed3.length} 个`)

const fixed0 = todaysEvents(mk(0), new Date(2026, 2, 1))
pass('E5d', '0 个时确实一个都不抽', fixed0.length === 0, `${fixed0.length} 个`)

/* ---------- E6 三处入口都走同一套规范化 ---------- */
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const campusSrc = read('panel/lib/campus.js')
const serverSrc = read('panel/server.js')
const proxySrc = read('panel/lib/proxy.js')
const html = read('panel/public/index.html')

pass('E6a', 'campus.js 导出 normalizeEventsPerDay', campusSrc.includes('export function normalizeEventsPerDay'))
pass('E6b', 'server 套用模板走 normalize', serverSrc.includes('normalizeEventsPerDay(body.eventsPerDay'))
pass('E6c', 'proxy 自己重排一天走 normalize', proxySrc.includes('eventsPerDay: normalizeEventsPerDay'))
pass('E6d', 'normalizeRoutine 也走 normalize', (campusSrc.match(/eventsPerDay: normalizeEventsPerDay/g) || []).length >= 2)
pass('E6e', '面板读值时不会把 auto 过 Number()', html.includes('if (v === \'auto\') return \'auto\''))

/* ---------- E7 面板控件 ---------- */
pass('E7a', 'cp-events 是下拉（不是数字输入框）', /<select[^>]*id="cp-events"/.test(html))
const selBlock = html.slice(html.indexOf('id="cp-events"'), html.indexOf('</select>', html.indexOf('id="cp-events"')))
pass('E7b', '下拉里有 auto 选项', selBlock.includes('value="auto"'))
pass('E7c', '下拉覆盖 0-3', ['0', '1', '2', '3'].every((n) => selBlock.includes(`value="${n}"`)))
pass('E7d', '有条数的人话描述', html.includes('function describeEventsPerDay'))

/* ---------- E8 「她自己加活动」的既有机制没被破坏 ---------- */
pass('E8a', '人格里仍引导她 qq-event add', /qq-event add/.test(read('panel/lib/store.js')))
pass('E8b', '人格里提到了发呆/刷手机这种自发场景', /发呆|刷手机/.test(read('panel/lib/store.js')))
pass('E8c', 'captureWish 兜底仍在', proxySrc.includes('captureWish(text)'))
pass('E8d', 'detectWish 仍在 goaway.js', read('panel/lib/goaway.js').includes('export function detectWish'))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
