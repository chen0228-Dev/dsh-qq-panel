/**
 * 「允许发表情包」开关收敛 —— 人格面板那一份删掉，只留表情包页的总闸
 *
 * 背景：同一个能力原来有两个开关
 *   ① 身份与风格卡片：persona.stickers  → 人格层「这份人设爱不爱用」
 *   ② 表情包页：      stickers.enabled  → 总闸，关掉后 qq-sticker 三个命令直接被禁
 * 两个开关语义重叠，而且互相盖不住：
 *   总闸关了 → 人格里写「多发点」也是废的
 *   总闸开着 → 人格里设 false，但换个访客又能发，不是「全局不发」
 * 2026-10-22 删掉 ①，统一由 ② 控制。
 *
 * 本测试盯住三件容易漏的事：
 *   · 老配置里残留的 persona.stickers 必须被清掉，并且落盘
 *   · AGENTS.md 里那句「不发表情包」必须跟着消失（否则用户想改都改不掉）
 *   · 前端保存 persona 时不能再把字段写回去
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const pass = (id, desc, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${desc}${extra ? '  ' + extra : ''}`)
}

/* ---------- 准备一个带「老字段」的隔离数据目录 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-switch-'))
const workspace = path.join(tmp, 'ws')
fs.mkdirSync(workspace, { recursive: true })

const legacy = {
  qq: { adminQQ: '10001' },
  paths: { workspace, stickers: path.join(workspace, 'stickers') },
  // 关键：老配置里留着人格层的 false
  persona: { enabled: true, name: '小柒', stickers: false },
  // 总闸是开的、频率也在，说明「库里能用但人格不爱用」这种别扭状态
  stickers: { enabled: true, freq: 30, autoSave: true, react: true },
  // 顺手留一个别的字段，验证迁移只删该删的
  reply: { split: { enabled: true } }
}
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(legacy, null, 2), 'utf8')

// store.js 的路径常量是模块加载时求值的，所以必须先设 env 再动态 import
process.env.PANEL_DATA = tmp
process.env.HOME = tmp
const store = await import(new URL('../panel/lib/store.js', import.meta.url).href)

/* ---------- S1 内存里已经清掉 ---------- */
const cfg = store.loadConfig()
pass('S1a', 'loadConfig 后 persona.stickers 不存在', !('stickers' in cfg.persona), JSON.stringify(cfg.persona.stickers))
pass('S1b', '别的 persona 字段没被误删', cfg.persona.name === '小柒' && cfg.persona.enabled === true)
pass('S1c', '表情包总闸原样保留', cfg.stickers.enabled === true && cfg.stickers.freq === 30)
pass('S1d', '无关字段没被动', cfg.reply?.split?.enabled === true)

/* ---------- S2 已经落盘（不是只在内存里清） ---------- */
const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
pass('S2a', '磁盘上的 config.json 也清掉了', !('stickers' in (onDisk.persona || {})))
pass('S2b', '磁盘上总闸还在（迁移写盘没写丢）', onDisk.stickers?.enabled === true)

/* ---------- S3 AGENTS.md 不再写「不发表情包」 ---------- */
const md = store.renderPersona(cfg)
pass('S3a', '人格文件里没有「不发表情包」', !md.includes('不发表情包'))
pass('S3b', '总闸开着时仍会正常引导发表情包', md.includes('偶尔发个表情包'), md.match(/偶尔发个表情包[^\n]*/)?.[0]?.slice(0, 30) || '')

/* ---------- S4 总闸才是唯一开关 ---------- */
const off = JSON.parse(JSON.stringify(cfg))
off.stickers.enabled = false
const mdOff = store.renderPersona(off)
pass('S4a', '总闸关掉 → stickersOn 为 false', store.stickersOn(off) === false)
// 注意：这里不能简单断言「不含『表情包』三个字」。
// 还有些地方出现这三个字是**应该保留**的：
//   · 教她怎么看懂对方发来的 [表情包]
//   · 「他让你发个表情包就去办」这类指令遵循
//   · 能力清单里标注 `表情包：已关闭`
// 真正要消失的是「主动去发」的引导和 qq-sticker 命令。
pass('S4b', '总闸关掉 → 不再引导她主动发表情包', !mdOff.includes('偶尔发个表情包'))
pass('S4c', '总闸关掉 → 不再出现 qq-sticker 命令', !mdOff.includes('qq-sticker'))
pass('S4d', '总闸关掉 → 能力清单明确标注已关闭', mdOff.includes('表情包：已关闭'))

const freq0 = JSON.parse(JSON.stringify(cfg))
freq0.stickers = { enabled: true, freq: 0, autoSave: false, react: false }
pass('S4e', '总闸开但没有任何子能力 → 视为关（免得命令显示可用却被拒）', store.stickersOn(freq0) === false)

/* ---------- S5 前端保存 persona 不会再写回字段 ---------- */
// 模拟 collect('persona') 的产物：里面已经没有 stickers
store.saveConfig({
  persona: {
    enabled: true,
    name: '小柒',
    identity: '一个有点懒但很靠谱的朋友',
    emoji: true,
    faceRate: 30
  }
})
const afterSave = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'))
pass('S5a', '保存 persona 后字段没有复活', !('stickers' in (afterSave.persona || {})))
pass('S5b', '保存没把总闸带坏', afterSave.stickers?.enabled === true && afterSave.stickers?.freq === 30)

/* ---------- S6 面板源码里不该再有这个控件 ---------- */
const html = fs.readFileSync(new URL('../panel/public/index.html', import.meta.url), 'utf8')
pass('S6a', '身份与风格卡片已删掉 p-stickers 控件', !html.includes('p-stickers'))
pass('S6b', '原位置留了指向表情包页的说明', html.includes('统一在 <b>「表情包」</b> 页控制'))
pass('S6c', '表情包页自己的总开关还在', html.includes('id="s-enabled"'))
pass('S6d', '访客覆盖的开关保留（那是另一层）', html.includes('id="pf-s-enabled"'))

/* ---------- S7 默认配置里不该再有这个键 ---------- */
const src = fs.readFileSync(new URL('../panel/lib/store.js', import.meta.url), 'utf8')
const personaBlock = src.slice(src.indexOf('persona: {'), src.indexOf('campus: {'))
pass('S7a', 'DEFAULT_CONFIG.persona 里没有 stickers 键', !/^\s*stickers:\s*(true|false)/m.test(personaBlock))

/* ---------- 清理 ---------- */
fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
