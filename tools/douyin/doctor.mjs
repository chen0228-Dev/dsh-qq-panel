/**
 * 自检脚本 —— 跑一遍看看环境齐不齐。
 *
 * 用法： node doctor.mjs
 *
 * 它只读不写，不会点任何按钮、不会发任何消息。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ok = (t) => console.log(`  ✅ ${t}`)
const bad = (t, hint) => console.log(`  ❌ ${t}${hint ? `\n     → ${hint}` : ''}`)
const warn = (t) => console.log(`  ⚠️  ${t}`)

let fails = 0

console.log('\n=== 1. Node ===')
console.log(`  Node ${process.version}`)

console.log('\n=== 2. 依赖 ===')
try {
  const { chromium } = await import('playwright-core')
  ok(`playwright-core 可用（chromium: ${typeof chromium}）`)
} catch (e) {
  bad('playwright-core 没装', '在 tools/douyin 目录下跑: npm i playwright-core')
  fails++
}

console.log('\n=== 3. 配置 ===')
let cfg = null
try {
  cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'))
  ok('config.json 读到了')
  if (String(cfg.token || '').includes('粘贴') || !cfg.token) {
    bad('token 还没填', '面板 → 功能 → 刷抖音 → 采集端令牌 → 复制')
    fails++
  } else ok(`token 已填（${cfg.token.slice(0, 8)}…）`)
  if (String(cfg.server || '').includes('<')) {
    bad('server 还是占位符', '改成你服务器的真实地址')
    fails++
  } else ok(`server: ${cfg.server}`)
} catch (e) {
  bad('config.json 不存在或格式错', '复制 config.example.json 改名，填 server 和 token')
  fails++
}

console.log('\n=== 4. 服务器连通 ===')
if (cfg) {
  try {
    const r = await fetch(`${String(cfg.server).replace(/\/$/, '')}/api/douyin/config`, {
      headers: { 'x-douyin-token': cfg.token },
      signal: AbortSignal.timeout(15000)
    })
    if (r.status === 401) {
      bad('token 被拒绝（401）', '面板里重置过令牌？重新复制一次')
      fails++
    } else if (!r.ok) {
      bad(`服务器返回 HTTP ${r.status}`)
      fails++
    } else {
      const j = await r.json()
      ok('服务器通了')
      console.log(`     开关: ${j.enabled ? '开' : '关'}`)
      console.log(`     时段: ${j.activeFrom}–${j.activeTo}`)
      console.log(`     今日剩余: 赞 ${j.likeLeft} / 藏 ${j.favLeft} / 分享 ${j.shareLeft}`)
      if (!j.enabled) warn('面板上「允许她刷抖音」是关的 —— 采集端会直接退出，不会刷')
      if (!j.shareToId) warn('「分享给谁」没填 —— 只能把视频带回来在 QQ 聊，发不到抖音')
    }
  } catch (e) {
    bad(`连不上服务器: ${e.message}`, '检查地址、端口、防火墙；服务器上 qqbot-panel 是否在跑')
    fails++
  }
}

console.log('\n=== 5. Edge 调试口 ===')
if (cfg) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.cdpPort || 9222}/json/version`, {
      signal: AbortSignal.timeout(6000)
    })
    const j = await r.json()
    ok(`CDP 可用（${j.Browser}）`)
  } catch {
    bad('调试口 9222 连不上', '先双击桌面「抖音-启动专用Edge.bat」，别用日常那个 Edge')
    fails++
  }
}

console.log('\n=== 6. 抖音登录状态 ===')
if (cfg) {
  try {
    const { chromium } = await import('playwright-core')
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort || 9222}`)
    const ctx = b.contexts()[0]
    const page = ctx.pages()[0] || (await ctx.newPage())
    const url = page.url()
    console.log(`  当前页面: ${url.slice(0, 70)}`)
    const hasLogin = await page.evaluate(() => {
      const t = document.body?.innerText || ''
      return /登录|扫码/.test(t) && t.length < 3000
    }).catch(() => false)
    if (hasLogin) {
      bad('看起来还没登录抖音', '在打开的 Edge 窗口里扫码登录，然后重跑自检')
      fails++
    } else {
      ok('页面正常（不像登录引导页）')
    }
    await b.close()
  } catch (e) {
    bad(`检查登录态失败: ${e.message}`)
    fails++
  }
}

console.log(`\n=== ${fails ? `还有 ${fails} 项要处理` : '全部就绪，可以刷了'} ===\n`)
if (!fails) {
  console.log('下一步：双击桌面「抖音-让她刷一轮.bat」，或者在这里跑 node collect.mjs\n')
}
process.exit(fails ? 1 : 0)
