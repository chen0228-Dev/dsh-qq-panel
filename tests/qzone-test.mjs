// 说说（Qzone）专项测试：提示词内容 + 回执拦截 + 配图选择
import { buildQzonePrompt } from '../panel/lib/proactive.js'
import { parseQzoneReceipt } from '../panel/lib/proxy.js'
import { DEFAULT_CAMPUS } from '../panel/lib/campus.js'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

const baseCfg = {
  persona: { moodEnabled: true },
  campus: { ...DEFAULT_CAMPUS },
  qzone: { imageChance: 0 }
}

/* ---------- Z1 提示词的基本结构 ---------- */
const p1 = buildQzonePrompt(baseCfg, { posts: [] }, null)
pass('Z1', '要求先判断今天值不值得记', /先想，再决定发不发/.test(p1))
pass('Z1b', '明确允许不发', /干脆不发/.test(p1) && /不用勉强/.test(p1))
pass('Z1c', '回执协议写清楚了', p1.includes('[已发]') && p1.includes('[不发]'))
pass('Z1d', '不再用旧版「20-40 字」的死指令', !/20-40 字/.test(p1))
pass('Z1e', '不许出现「你」/提问/称呼', /不要出现「你」/.test(p1) && /不要提问/.test(p1))
pass('Z1f', '带上了她此刻的状态', /^现在：/m.test(p1), (p1.match(/^现在：.*$/m) || [''])[0].slice(0, 24))
pass('Z1g', '给了素材方向', (p1.match(/^ {2}· /gm) || []).length >= 2)

/* ---------- Z2 风格档要轮换 ---------- */
const styles = new Set()
for (let i = 0; i < 30; i++) {
  const t = buildQzonePrompt(baseCfg, { posts: [] }, null)
  const m = /如果发，就用这种口气：(.+?)。/.exec(t)
  if (m) styles.add(m[1].slice(0, 6))
}
pass('Z2', '口气有三种以上', styles.size >= 3, `实际 ${styles.size} 种`)

/* ---------- Z3 防重复：最近发过的要列出来 ---------- */
const p3 = buildQzonePrompt(baseCfg, { posts: [{ text: '食堂的饭今天意外好吃', at: 1 }, { text: '图书馆抢到座位了', at: 2 }] }, null)
pass('Z3', '提示里带最近发过的内容', /别写重复的意思/.test(p3) && p3.includes('食堂的饭'))
pass('Z3b', '最多只列 3 条', (p3.match(/｜/g) || []).length <= 2)

/* ---------- Z4 配图：两条路都给她 ---------- */
const sticker = { name: '摆烂_你骂我也没用.png', path: '/root/qq-workspace/stickers/摆烂_你骂我也没用.png', tags: '摆烂、累' }
const p4 = buildQzonePrompt(baseCfg, { posts: [] }, { want: true, sticker })
pass('Z4', '给了表情包这条路', p4.includes(sticker.path) && p4.includes('--image'))
pass('Z4b', '同时给了自己搜图这条路', p4.includes('qq-pic') && /qq-pic "关键词"/.test(p4))
pass('Z4c', '给了搜图关键词建议', /比如「.+」「.+」/.test(p4), (p4.match(/比如「.+?」/) || [''])[0])
pass('Z4d', '明确禁止搜人像', /别搜人/.test(p4))
const p4e = buildQzonePrompt(baseCfg, { posts: [] }, { want: true, sticker: null })
pass('Z4e', '没有表情包时仍能自己搜', p4e.includes('qq-pic') && !p4e.includes('/stickers/'))
const p4b = buildQzonePrompt(baseCfg, { posts: [] }, { want: false, sticker: null })
pass('Z4f', '这轮不配图时完全不提图', !p4b.includes('--image') && !p4b.includes('qq-pic'))

/* ---------- Z5 回执解析 ---------- */
const r1 = parseQzoneReceipt('[已发] 今天下雨了 鞋全湿')
pass('Z5', '解析 [已发] 正文', r1 && r1.posted === true && r1.text === '今天下雨了 鞋全湿', JSON.stringify(r1))
const r2 = parseQzoneReceipt('[不发]')
pass('Z5b', '解析 [不发]', r2 && r2.posted === false && r2.text === '')
const r3 = parseQzoneReceipt('[已发]')
pass('Z5c', '只回标记也算已发', r3 && r3.posted === true && r3.text === '')
pass('Z5d', '普通消息不会被误判', parseQzoneReceipt('今天下雨了') === null)
pass('Z5e', '聊天里提到「已发」不会误判', parseQzoneReceipt('我刚已发给你了') === null)
pass('Z5f', '前面有空格也能认', parseQzoneReceipt('  [已发] 嗯') !== null)

/* ---------- Z6 关掉配图 ---------- */
const offCfg = { ...baseCfg, qzone: { imageChance: 0 } }
const p6 = buildQzonePrompt(offCfg, { posts: [] }, { want: false, sticker: null })
pass('Z6', 'imageChance=0 时不会出现配图片段', !/配图（可选/.test(p6))

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
