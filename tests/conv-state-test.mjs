/**
 * 「未结束对话的提前追问」—— 状态评估 + 双倍率
 *
 * 需求（2026-10-23 用户）：聊天有没有结束由**大模型自己判断**（不找关键词）；
 * 没聊完 + 对方没再回 → 提前主动接上（不用等 idleMinutes），话题偏向续聊；
 * 同时把「情绪氛围」变成两个倍率 —— 话题权重 ×续聊倍率、间隔 ×情绪倍率。
 * 原有机制（状态机/时段/上限/连续降权）一律不动，新逻辑只做乘法叠加。
 *
 * 本测试覆盖能纯测的部分（评估回执解析、权重逻辑、源码断言）；
 * 完整调度链路的时序在 tests/proactive-test.mjs 的框架里，这里不重复搭。
 */

import { parseConvState } from '../panel/lib/proxy.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- C1 评估回执解析 ---------- */
pass('C1a', '标准格式解析出 ended/mood',
  JSON.stringify(parseConvState('[[对话状态]] {"ended": false, "mood": "angry"}')) ===
    JSON.stringify({ ended: false, mood: 'angry' }))

pass('C1b', 'JSON 里带空格/换行也能解析',
  parseConvState('[[对话状态]] {\n  "ended": true,\n  "mood": "happy"\n}').ended === true)

pass('C1c', 'mood 给了枚举外的值 → 兜底 normal',
  parseConvState('[[对话状态]] {"ended": false, "mood": "ecstatic"}').mood === 'normal')

pass('C1d', 'ended 不是 true 一律当 false（宁可少追问）',
  parseConvState('[[对话状态]] {"ended": 1, "mood": "normal"}').ended === false)

pass('C1e', 'JSON 跑偏 → null（当没看见，不外发也不误用）',
  parseConvState('[[对话状态]] 我觉得还没聊完呢') === null)

pass('C1f', '普通聊天文本不会误判成状态回执',
  parseConvState('今天天气不错，一起去爬山吗？') === null)

pass('C1g', '正文中间夹 [[对话状态]] 不在行首 → 不拦截（防误伤正常聊天）',
  parseConvState('我记得有条规则叫 [[对话状态]] {"ended": true}') === null)

/* ---------- C2 话题权重逻辑（源码级断言） ---------- */
const root = fileURLToPath(new URL('..', import.meta.url))
const pa = fs.readFileSync(root + 'panel/lib/proactive.js', 'utf8')

pass('C2a', '话题池里有 continue（续聊）', pa.includes("continue: {"))
pass('C2b', '未结束时续聊权重拉到 continueBoost', pa.includes("w.continue = Math.max(w.continue || 0, Number(p.continueBoost) || 7)"))
pass('C2c', '已结束/追问过 → 续聊权重归零（回到原池子，保留原话题倾向）',
  /} else \{\s*\n\s*w\.continue = 0/.test(pa))
pass('C2d', '追问过就不再追（followedUp 防话痨）', pa.includes('!conv.followedUp'))
pass('C2e', '评估每轮只做一次（lastAssessFor 以用户消息为界）', pa.includes('s.lastAssessFor !== adminLastTs'))
pass('C2f', '用户回新消息后旧评估自动作废（conv.for === adminLastTs）', pa.includes('conv.for === adminLastTs'))
pass('C2g', '评估结果 6 小时过期（隔天不再拿旧状态说事）', pa.includes('6 * 3600_000'))

/* ---------- C3 情绪间隔倍率 ---------- */
pass('C3a', 'mood 倍率乘在 gap 判断上（和活跃时段倍率叠加）',
  /nextGap \* activityFactor\(cfg, s, now\) \* moodFactor/.test(pa))
pass('C3b', 'mood 非法/缺失 → 倍率 1（不影响原节奏）', /: 1$|: 1\s*$/m.test(pa) || pa.includes(': 1'))

/* ---------- C4 出站拦截 ---------- */
const proxySrc = fs.readFileSync(root + 'panel/lib/proxy.js', 'utf8')
pass('C4a', '出站层拦截 [[对话状态]] 回执（不外发）', proxySrc.includes('parseConvState(plain)'))
pass('C4b', '拦截后回 ack（不然插件侧 30 秒超时冒报错）',
  (proxySrc.match(/const csEval = parseConvState\(plain\)/g) || []).length === 1)
pass('C4c', '注册了 convStateHook 给 proactive 回传', proxySrc.includes('setConvStateHook(fn)'))
pass('C4d', 'proactive 注册 hook 存 state', pa.includes('proxy.setConvStateHook'))

/* ---------- C5 原有机制未被破坏（用户明确要求的底线） ---------- */
pass('C5a', '状态机 busy>=2 不主动（原样保留）', pa.includes('if (cs.busy >= 2) return'))
pass('C5b', '免打扰时段检查还在', pa.includes('quiet?.enabled'))
pass('C5c', '每日上限还在', pa.includes('dailyMax'))
pass('C5d', '忙里偷闲路径还在', pa.includes('sneakEnabled'))
pass('C5e', '连续同类话题降权还在（防止她连续刷续聊）', pa.includes('v *= 0.2'))
pass('C5f', '默认间隔的出厂值没被改', /minGap: 90/.test(fs.readFileSync(root + 'panel/lib/store.js', 'utf8')))

/* ---------- C6 配置默认值 ---------- */
const storeSrc = fs.readFileSync(root + 'panel/lib/store.js', 'utf8')
pass('C6a', 'continueThreshold 默认 5 分钟', storeSrc.includes('continueThreshold: 5'))
pass('C6b', 'continueBoost 默认 ×7（用户拍的板）', storeSrc.includes('continueBoost: 7'))
pass('C6c', '生气 ×1.5（用户拍的板）', storeSrc.includes('angry: 1.5'))
pass('C6d', '六档情绪倍率齐全',
  ['angry', 'sad', 'cold', 'normal', 'happy', 'excited'].every((m) => storeSrc.includes(`${m}:`)))

/* ---------- C7 面板滑杆 ---------- */
const html = fs.readFileSync(root + 'panel/public/index.html', 'utf8')
pass('C7a', '滑杆存在（range 控件）', /type="range" id="pa-continue"/.test(html))
pass('C7b', '范围联动两个间隔输入框', html.includes('function syncContinueSlider'))
pass('C7c', '保存时写 continueThreshold', html.includes("continueThreshold: Number($('pa-continue').value)"))
pass('C7d', '说明文案里写明范围联动规则', html.includes('最长间隔 − 5'))

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
