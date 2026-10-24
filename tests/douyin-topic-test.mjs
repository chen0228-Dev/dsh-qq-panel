// 抖音待聊队列 + 主动话题概率闸 专项测试（不产生真实会话、不碰生产数据）
//
// 跑法（在项目根目录）：
//   bash tests/run-isolated.sh douyin-topic-test.mjs
//
// 隔离很重要：这个测试会真写 data/douyin-pending.json 和 proactive.json。
// run-isolated.sh 把 PANEL_DATA 指到临时目录，跑完连目录删掉。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, loadConfig } from '../panel/lib/store.js'
import {
  enqueue,
  markInjected,
  noteMention,
  pending,
  snapshot,
  clearQueue,
  loadQueue,
  QUEUE_MAX,
  TTL_MS,
  videoIdOf,
  shareUrlOf
} from '../panel/lib/douyin-queue.js'
import { pickDouyinTopic, createProactive } from '../panel/lib/proactive.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const NOW = Date.now()
const mkCfg = (dy = {}) => ({
  douyin: { enabled: true, talkChance: 100, talkMinGapMin: 0, talkDailyMax: 3, ...dy },
  qq: { adminQQ: '10000', botQQ: '20000' }
})
const hit = (cfg, state = {}, repliedAt = 0) => pickDouyinTopic(cfg, state, new Date(NOW), repliedAt, () => 0.5)
const miss = (cfg, state = {}, repliedAt = 0) => pickDouyinTopic(cfg, state, new Date(NOW), repliedAt, () => 0.999)

/* ---------- Q0 链接解析 ---------- */
pass('Q0', '详情层链接能取出 aweme_id', videoIdOf('https://www.douyin.com/jingxuan?modal_id=7693034514264014031') === '7693034514264014031')
pass('Q0b', '标准链接也能取出', videoIdOf('https://www.douyin.com/video/7693034514264014031') === '7693034514264014031')
pass('Q0c', '转成可分享的标准链接', shareUrlOf('https://www.douyin.com/jingxuan?modal_id=7693034514264014031') === 'https://www.douyin.com/video/7693034514264014031')
pass('Q0d', '认不出的链接返回空串（宁可不给链接）', shareUrlOf('https://www.douyin.com/user/abc') === '')

/* ---------- Q1 入队与去重 ---------- */
clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/111111111111', title: '猫在键盘上睡着了', author: '林可' }], 'inbound', NOW)
pass('Q1', '入队成功', loadQueue().items.length === 1)
pass('Q1b', '标题/作者/链接都存下来了', (() => {
  const e = loadQueue().items[0]
  return e.title === '猫在键盘上睡着了' && e.author === '林可' && e.url.includes('/video/111111111111')
})())

// 同一条再入一次（她刷到 + 他又发）不能变两条
enqueue([{ url: 'https://www.douyin.com/jingxuan?modal_id=111111111111', title: '' }], 'ingest', NOW + 1000)
pass('Q1c', '同一条视频只留一条', loadQueue().items.length === 1, `实际 ${loadQueue().items.length} 条`)

/* ---------- Q2 上限与 TTL ---------- */
clearQueue()
for (let i = 0; i < 10; i++) {
  enqueue([{ url: `https://www.douyin.com/video/${100000000000 + i}`, title: `第${i}条` }], 'ingest', NOW + i)
}
pass('Q2', `队列上限 ${QUEUE_MAX} 条`, loadQueue().items.length === QUEUE_MAX, `实际 ${loadQueue().items.length}`)
pass('Q2b', '超上限时丢最旧的（留下的都是新的）', (() => {
  const titles = loadQueue().items.map((e) => e.title)
  return titles.includes('第9条') && !titles.includes('第0条')
})())

clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/222222222222', title: '昨天的事' }], 'ingest', NOW - TTL_MS - 1000)
pass('Q2c', '超过 24 小时不再提', pending(NOW, {}).length === 0)

/* ---------- Q3 概率闸的四个开关 ---------- */
clearQueue()
const A = { url: 'https://www.douyin.com/video/333333333333', title: '一个视频', author: '某人' }
enqueue([A], 'ingest', NOW)

pass('Q3', '「允许她刷抖音」关掉 → 整块不生效',
  hit(mkCfg({ enabled: false })) === null)
pass('Q3b', '正常情况命中', hit(mkCfg()) !== null)
pass('Q3c', '概率 0 → 永不聊', miss(mkCfg({ talkChance: 0 })) === null)
pass('Q3d', '概率没抽中 → 这次不聊', miss(mkCfg({ talkChance: 50 })) === null)
pass('Q3e', '一天上限用完 → 不聊', hit(mkCfg({ talkDailyMax: 2 }), { dyTalkCount: 2 }) === null)
pass('Q3f', '一天上限没到 → 还能聊', hit(mkCfg({ talkDailyMax: 2 }), { dyTalkCount: 1 }) !== null)
pass('Q3g', '未到最小间隔 → 不聊',
  hit(mkCfg({ talkMinGapMin: 90 }), { dyTalkCount: 1, dyTalkLastAt: NOW - 30 * 60_000 }) === null)
pass('Q3h', '超过最小间隔 → 可以聊',
  hit(mkCfg({ talkMinGapMin: 90 }), { dyTalkCount: 1, dyTalkLastAt: NOW - 120 * 60_000 }) !== null)

clearQueue()
pass('Q3i', '队列空 → 不聊', hit(mkCfg()) === null)

/* ---------- Q4 「已讨论」判定 ---------- */
clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/444444444444', title: '他发的' }], 'inbound', NOW)
// 没注入成功（busy 被跳过）→ 之后还能提，这就是修 Bug 1 的意义
pass('Q4', '注入被跳过（injectedAt=0）→ 仍然可提', pending(NOW, { repliedAt: NOW + 60_000 }).length === 1)

markInjected(['444444444444'], NOW)
pass('Q4b', '注入成功但还没回话 → 仍可提', pending(NOW + 60_000, { repliedAt: 0 }).length === 1)
pass('Q4c', '注入之后他回过话 → 判为聊过了',
  pending(NOW + 60_000, { repliedAt: NOW + 30_000 }).length === 0)

// ingest 类：提一次就作废
clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/555555555555', title: '她刷到的' }], 'ingest', NOW)
pass('Q4d', '她刷到的还没提过 → 可提', pending(NOW, {}).length === 1)
noteMention('555555555555', NOW)
pass('Q4e', '她刷到的提一次后作废', pending(NOW + 1000, {}).length === 0)
// 提过的不允许被"再次入队"复活
enqueue([{ url: 'https://www.douyin.com/video/555555555555', title: '她刷到的' }], 'ingest', NOW + 2000)
pass('Q4f', '提过的不会被重新入队复活', pending(NOW + 3000, {}).length === 0)

/* ---------- Q5 优先级：他发的 > 她刷到的 ---------- */
clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/666666666666', title: '她自己刷的' }], 'ingest', NOW + 5000)
enqueue([{ url: 'https://www.douyin.com/video/777777777777', title: '他专门发的' }], 'inbound', NOW + 1000)
const picked = hit(mkCfg())
pass('Q5', '两条都在时优先「他发的」', picked && picked.id === '777777777777', `实际 ${picked && picked.title}`)

/* ---------- Q6 快照（面板用） ---------- */
const snap = snapshot(NOW + 6000, { repliedAt: 0 })
pass('Q6', '快照列出条目', Array.isArray(snap.items) && snap.items.length === 2, `实际 ${snap.items.length} 条`)
pass('Q6b', '快照带 available 标记', snap.items.every((x) => typeof x.available === 'boolean'))
pass('Q6c', '快照带来源标记', snap.items.some((x) => x.src === 'inbound') && snap.items.some((x) => x.src === 'ingest'))

/* ---------- Q7 注入文本 ---------- */
// triggerNow 会读 loadConfig()。隔离目录里的 config 没有 douyin 段时，
// enabled=false —— 手动试是"强制"，不看这个开关，正好能测到文本。
const sent = []
const proxy = {
  lastUserAt: 0,
  lastUserAtFor: () => 0,
  status: () => ({ napcat: true, dsh: true, botQQ: '20000' }),
  injectPrivateMessage: (t) => sent.push(t),
  setUserActivityHook: () => {},
  setQzoneHook: () => {},
  setConvStateHook: () => {}
}
const p = createProactive(proxy, () => {})

clearQueue()
enqueue([{ url: 'https://www.douyin.com/video/888888888888', title: '有人在楼顶养了只鸡', author: '张三' }], 'inbound', NOW)
const r = p.triggerNow('douyin')
const text = sent[sent.length - 1] || ''
pass('Q7', '拿到的是队列里那一条', r.topic === 'douyin' && r.title === '有人在楼顶养了只鸡', `实际 ${r.title}`)
pass('Q7b', '提示里带具体标题', text.includes('《有人在楼顶养了只鸡》'))
pass('Q7c', '提示里带作者', text.includes('@张三'))
pass('Q7d', '提示里带可分享链接', text.includes('https://www.douyin.com/video/888888888888'))
// 提示里「你发的那个我看了」和「不是『我刚刷到』」两句都会出现，
// 所以不能简单断言 text 里没有「我刚刷到」—— 那是禁止语，本来就该在。
pass('Q7e', '口气指定为「你发的那个我看了」', /口气是「你发的那个我看了/.test(text))
pass('Q7f', '明确不许编视频内容', /别硬编/.test(text))
// 提示里要**禁止**她说"没接口"，而不是让这句话变成她可以说的话
pass('Q7g', '明令禁止「我没有接口」这类说法', /别说「我发不了链接」「我没有接口」/.test(text))
pass('Q7h', '仍然禁止列清单/提提示', /别列清单/.test(text) && /不要提到这条提示/.test(text))
// 这一条是 inbound：允许被提两次（第一次没聊起来还能再试），所以要断言"记了一笔"而不是"被删掉"
pass('Q7i', '手动触发也记一次「提过了」',
  snapshot(NOW + 1000, {}).items[0]?.mentionedCount === 1,
  `实际 ${snapshot(NOW + 1000, {}).items[0]?.mentionedCount}`)

// 队列空了要明确报错，不能假装有一条
clearQueue()
let threw = ''
try {
  p.triggerNow('douyin')
} catch (e) {
  threw = e.message
}
pass('Q8', '队列空时手动试会明确报错', /待聊队列是空的/.test(threw), `实际「${threw}」`)

/* ---------- Q9 配置兜底：老 config.json 没有新字段 ---------- */
const noFields = { douyin: { enabled: true }, qq: { adminQQ: '10000' } }
clearQueue()
enqueue([A], 'ingest', NOW)
const withDefault = pickDouyinTopic(noFields, {}, new Date(NOW), 0, () => 0.5)
pass('Q9', '老配置没 talkChance 也能跑（走默认 70）', withDefault !== null)

/* ---------- Q10 生产/测试隔离自检 ---------- */
pass('Q10', 'PANEL_DATA 指向临时目录', DATA_DIR !== '/opt/qqbot/panel/data' && path.basename(DATA_DIR) !== 'data', `实际 ${DATA_DIR}`)

clearQueue()
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
