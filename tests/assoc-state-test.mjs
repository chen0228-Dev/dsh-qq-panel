/**
 * 「她说要去干嘛」的识别 + 「按状态调跳题概率」的测试。
 *
 * 背景：用户发现她说完「我这边慢慢磨」四分钟后又岔题聊橘猫。
 * 查下来根因是两层：① 她一次都没调用过 qq-routine（campus-plan.json 从没被创建）；
 * ② 跳题概率只有三档（busy>=2 不岔 / 偷闲减半 / 其它原值），
 *    闲着和「正要开始忙」的概率一样，所以她一闲下来就容易岔。
 */
import { detectGoAway } from '../panel/lib/goaway.js'
import { stateFactor, assocLine } from '../panel/lib/assoc.js'
import { campusState, addPlanItem, DEFAULT_CAMPUS } from '../panel/lib/campus.js'
import fs from 'node:fs'
import path from 'node:path'

let fail = 0
let n = 0
const pass = (id, name, ok, extra = '') => {
  n++
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${name}${extra ? ' | ' + extra : ''}`)
  if (!ok) fail++
}

const NOW = new Date(2026, 9, 22, 20, 54, 0)

/* ================= 一、识别「我要去干嘛」 ================= */

/* ---------- G1 真实事故原文 ---------- */
{
  const h = detectGoAway('加油是加油 笔就是不动[face:264]\n你先忙设计吧 我这边慢慢磨', NOW)
  pass('G1a', '事故原话「我这边慢慢磨」能认出来', h && h.busy === 1, h ? h.label : 'null')
  pass('G1b', '从 20:54 起算 45 分钟', h && h.from === '20:54' && h.to === '21:39', h ? `${h.from}-${h.to}` : '-')
}
{
  const h = detectGoAway('行 那我先去写作业了\n你也别熬太晚 设计弄完就歇[face:21]', NOW)
  pass('G1c', '「那我先去写作业了」认得出具体的事', h && h.label === '写作业', h ? h.label : 'null')
}

/* ---------- G2 常见说法 ---------- */
{
  const cases = [
    ['我先去洗澡了', '洗澡'],
    ['那我先去吃饭啦', '吃饭'],
    ['我先去写稿了 晚点说', '写稿'],
    ['我去加班了', '加班'],
    ['我先去收拾一下', '收拾']
  ]
  let ok = 0
  for (const [t, want] of cases) {
    const h = detectGoAway(t, NOW)
    if (h && h.label === want) ok++
    else console.log(`   ✗ ${t} → ${h ? h.label : 'null'}`)
  }
  pass('G2', '常见说法都能认出来', ok === cases.length, `${ok}/${cases.length}`)
}

/* ---------- G3 睡觉单独处理 ---------- */
{
  const h = detectGoAway('不聊了 我去睡了', NOW)
  pass('G3a', '「我去睡了」→ busy=3', h && h.busy === 3 && h.label === '睡觉', h ? `${h.label} busy=${h.busy}` : 'null')
  const h2 = detectGoAway('我去睡午觉了', new Date(2026, 9, 22, 13, 0, 0))
  pass('G3b', '午睡也是睡觉状态', h2 && h2.busy === 3 && h2.from === '13:00', h2 ? `${h2.from}-${h2.to}` : 'null')
}

/* ---------- G4 不该误判的（比误判更重要） ---------- */
{
  const cases = [
    ['我不想去上课', '否定'],
    ['你别去洗澡了', '否定'],
    ['你今天去写作业了吗', '主语不是她'],
    ['刚才去洗澡的时候想到一个事', '过去时'],
    ['要是能去打球就好了', '假设句'],
    ['写作业好烦啊', '没有「去」'],
    ['[[引用 1]]我去打球了\n真的假的', '引用行是对方的话'],
    ['路上那只橘猫今天居然让我摸了', '无关内容']
  ]
  let bad = []
  for (const [t, why] of cases) {
    if (detectGoAway(t, NOW)) bad.push(`${why}：${t.slice(0, 16)}`)
  }
  pass('G4', '否定/过去时/假设/引用都不误判', bad.length === 0, bad.join(' / '))
}

/* ---------- G5 引用行剥掉、她自己那行还算 ---------- */
{
  const h = detectGoAway('[[引用 1]]去吧 别磨蹭了\n那我先去写了', NOW)
  pass('G5', '引用被剥掉，但她自己的「我先去写了」仍能认出', h !== null, h ? h.label : 'null')
}

/* ---------- G6 跨零点的睡觉 ---------- */
{
  const h = detectGoAway('我去睡了', new Date(2026, 9, 22, 23, 30, 0))
  pass('G6', '深夜说睡觉，结束时间截在 23:59', h && h.to === '23:59', h ? `${h.from}-${h.to}` : 'null')
}

/* ================= 二、按状态调跳题概率 ================= */

/* ---------- A1 各状态的倍率 ---------- */
{
  const cfg = { reply: { assoc: { enabled: true, chance: 30 } } }
  const f = (key, busy, sneak) => stateFactor(cfg, key, busy, sneak)
  pass('A1a', '睡着 / 午休 → 0', f('sleep', 3) === 0 && f('nap', 2) === 0)
  pass('A1b', '偷闲 → 0.35', Math.abs(f('sneak', 0, true) - 0.35) < 1e-9)
  pass('A1c', '躺着 / 晚上 → 最放松（>1）', f('dorm', 0) > 1 && f('evening', 0) > 1, `${f('dorm', 0)} / ${f('evening', 0)}`)
  pass('A1d', '闲着 → 1（基准值）', f('idle', 0) === 1)
  pass('A1e', '表里没有的状态按 busy 兜底', f('weird-key', 2) === 0 && f('weird-key', 1) === 0.6 && f('weird-key', 0) === 1)
  pass('A1f', '偷闲优先于 key（不管叫什么都是 0.35）', f('dorm', 2, true) === 0.35)
}

/* ---------- A2 用户设的 chance 是基准，倍率叠加在上面 ---------- */
{
  const mk = (chance, key, busy) => {
    const cfg = { reply: { assoc: { enabled: true, chance } } }
    return stateFactor(cfg, key, busy, false) * chance
  }
  pass('A2a', 'chance=60、闲着 → 60%', mk(60, 'idle', 0) === 60)
  pass('A2b', 'chance=60、躺着 → 78%', Math.abs(mk(60, 'dorm', 0) - 78) < 1e-9, String(mk(60, 'dorm', 0)))
  pass('A2c', 'chance=60、赶 DDL → 24%', Math.abs(mk(60, 'crunch', 1) - 24) < 1e-9, String(mk(60, 'crunch', 1)))
  pass('A2d', 'chance=0 怎么都不岔', mk(0, 'dorm', 0) === 0)
}

/* ---------- A3 配置能覆盖倍率 ---------- */
{
  const cfg = { reply: { assoc: { enabled: true, chance: 30, stateFactors: { dorm: 2 } } } }
  pass('A3a', '自定义倍率生效', stateFactor(cfg, 'dorm', 0) === 2)
  pass('A3b', '没覆盖的还用默认', Math.abs(stateFactor(cfg, 'sneak', 0, true) - 0.35) < 1e-9)
}

/* ---------- A4 睡着了 / 正忙真的不注入 ---------- */
{
  const cfg = { reply: { assoc: { enabled: true, chance: 100, maxStreak: 9 } } }
  const text = '今天好累啊'
  let slept = 0
  let idle = 0
  for (let i = 0; i < 40; i++) {
    if (assocLine(cfg, { text, busy: 3, stateKey: 'sleep' })) slept++
    if (assocLine(cfg, { text, busy: 0, stateKey: 'idle' })) idle++
  }
  pass('A4a', '睡着时 40 次一次都不岔', slept === 0, `${slept}/40`)
  pass('A4b', '闲着时 100% 概率会岔', idle > 0, `${idle}/40`)
}

/* ---------- A5 「要开始忙了」比「闲着」明显少岔 ---------- */
{
  // 赶 DDL（crunch 0.4）vs 躺着（dorm 1.3），同样 chance=50，各试 300 次
  const mk = (key) => ({ reply: { assoc: { enabled: true, chance: 50, maxStreak: 99 } } })
  const run = (key, busy) => {
    let hit = 0
    for (let i = 0; i < 300; i++) {
      if (assocLine(mk(key), { text: '今天好累啊', busy, stateKey: key })) hit++
    }
    return hit / 300
  }
  const lazy = run('dorm', 0)
  const busyish = run('crunch', 1)
  pass('A5', '躺着比赶 DDL 明显爱岔', lazy > busyish + 0.15, `躺着 ${(lazy * 100).toFixed(0)}% / 赶DDL ${(busyish * 100).toFixed(0)}%`)
}

/* ================= 三、端到端：她说要去磨作业 → 状态真的变 ================= */

/* ---------- E1 写计划 → 状态机读到 → busy=1 → 跳题概率降 ---------- */
{
  const dataDir = process.env.PANEL_DATA || './data'
  fs.mkdirSync(dataDir, { recursive: true })
  const planFile = path.join(dataDir, 'campus-plan.json')
  try {
    fs.unlinkSync(planFile)
  } catch {
    /* 本来就没有 */
  }

  const hit = detectGoAway('你先忙设计吧 我这边慢慢磨', NOW)
  const saved = addPlanItem(hit, NOW)
  pass('E1a', '计划真的写进文件了', saved && fs.existsSync(planFile), saved ? `${saved.from}-${saved.to}` : 'null')

  const cfg = { campus: { ...DEFAULT_CAMPUS, age: 20, job: 'student' } }
  const st = campusState(cfg, new Date(2026, 9, 22, 21, 0, 0))
  pass('E1b', '21:00 状态变成「计划里」（busy=1）', st.key === 'plan' && st.busy === 1, `${st.key} busy=${st.busy} ${st.label}`)

  const before = stateFactor({ reply: { assoc: { chance: 30 } } }, 'idle', 0, false)
  const after = stateFactor({ reply: { assoc: { chance: 30 } } }, st.key, st.busy, st.sneak === true)
  pass('E1c', '跳题倍率从 1 降到 0.6', before === 1 && after === 0.6, `${before} → ${after}`)

  // 到点之后自动失效
  const later = campusState(cfg, new Date(2026, 9, 22, 22, 30, 0))
  pass('E1d', '过了计划时段自动回到日常', later.key !== 'plan', `22:30 → ${later.key}`)
}

/* ---------- E2 重复说同一件事不会堆叠 ---------- */
{
  const hit = { from: '20:54', to: '21:39', label: '手头的事', busy: 1, line: 'x' }
  addPlanItem(hit, NOW)
  addPlanItem(hit, NOW)
  const d = JSON.parse(fs.readFileSync(path.join(process.env.PANEL_DATA || './data', 'campus-plan.json'), 'utf8'))
  const same = d.items.filter((x) => x.label === '手头的事').length
  pass('E2', '同一件事写两次只留一条', same === 1, `${same} 条`)
}

/* ---------- E3 隔夜的计划不带过来 ---------- */
{
  const dataDir = process.env.PANEL_DATA || './data'
  const planFile = path.join(dataDir, 'campus-plan.json')
  fs.writeFileSync(
    planFile,
    JSON.stringify({ date: '2026-10-21', items: [{ from: '01:00', to: '02:00', label: '旧事', busy: 1 }] }),
    'utf8'
  )
  addPlanItem({ from: '20:00', to: '21:00', label: '新事', busy: 1 }, new Date(2026, 9, 22, 20, 0, 0))
  const d = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  pass('E3', '昨天的事不会带今天', d.items.every((x) => x.label !== '旧事') && d.items.length === 1, JSON.stringify(d.items.map((x) => x.label)))
}

console.log(fail ? `\n${fail} 项失败` : `\n全部通过（${n} 项）`)
process.exit(fail ? 1 : 0)
