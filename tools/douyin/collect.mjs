/**
 * 抖音采集端 —— 跑在用户的 Windows 电脑上，不是服务器。
 *
 * 它只做三件事：接管已登录的 Edge、刷一轮抖音、把结果交回服务器。
 *
 * 【为什么在这边跑】
 * 服务器只剩 584MB 可用内存、没装浏览器；而点赞/收藏/分享是**写操作**，
 * 抖音的只读接口给不了，必须有真浏览器带着登录态去点。
 *
 * 【怎么跑】
 *   1. 双击 start-edge.bat（带调试口的专用 Edge，首次扫码登录）
 *   2. 复制 config.example.json 为 config.json，填服务器地址和面板里的令牌
 *   3. node collect.mjs        # 跑一轮
 *      node collect.mjs --loop # 常驻，按 checkIntervalMin 轮询
 *
 * 【安全边界】
 * - 只碰你指定的这个 Edge（独立配置目录），不碰日常浏览器的书签/密码
 * - 只读配置、只交结果，拿不到面板登录态
 * - 所有额度（点赞/收藏/分享）由服务器下发，采完就停，不会自己加量
 * - 页面结构变了、点不到按钮 → 记日志跳过，绝不硬点
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CFG_FILE = path.join(HERE, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a)

function loadCfg() {
  if (!fs.existsSync(CFG_FILE)) {
    console.error('缺少 config.json —— 复制 config.example.json 改个名，填好服务器地址和令牌')
    process.exit(1)
  }
  const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
  if (!c.server || !c.token || c.token.includes('粘贴')) {
    console.error('config.json 里的 server / token 还没填')
    process.exit(1)
  }
  return c
}

/** 试一串选择器，返回第一个能拿到的元素（拿不到返回 null，不抛） */
async function pick(page, selectors) {
  for (const s of selectors) {
    try {
      const el = await page.$(s)
      if (el) return el
    } catch {
      /* 选择器语法问题也跳过 */
    }
  }
  return null
}

async function textOf(page, selectors) {
  const el = await pick(page, selectors)
  if (!el) return ''
  try {
    return (await el.innerText()).trim()
  } catch {
    return ''
  }
}

/** "1.2万" / "3.4w" / "1234" → 数字 */
function parseCount(s) {
  const t = String(s || '').replace(/[,\s]/g, '')
  const m = t.match(/([\d.]+)\s*(万|w|W|亿)?/)
  if (!m) return 0
  const n = parseFloat(m[1]) || 0
  const unit = m[2]
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000)
  if (unit === '亿') return Math.round(n * 100000000)
  return Math.round(n)
}

async function fetchConfig(cfg) {
  const url = `${cfg.server.replace(/\/$/, '')}/api/douyin/config`
  const r = await fetch(url, { headers: { 'x-douyin-token': cfg.token } })
  if (!r.ok) throw new Error(`拉配置失败 HTTP ${r.status}`)
  return r.json()
}

async function submit(cfg, payload) {
  const url = `${cfg.server.replace(/\/$/, '')}/api/douyin/ingest`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-douyin-token': cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }
}

/** 在页面里挂一个角标，让用户一眼看到"她正在刷" */
async function showBadge(page, text) {
  try {
    await page.evaluate((t) => {
      let el = document.getElementById('__dsh_badge')
      if (!el) {
        el = document.createElement('div')
        el.id = '__dsh_badge'
        el.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
          'padding:8px 14px', 'border-radius:10px', 'font-size:13px',
          'background:rgba(32,32,32,.86)', 'color:#fff', 'font-family:system-ui',
          'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'pointer-events:none',
          'transition:opacity .2s'
        ].join(';')
        document.body.appendChild(el)
      }
      el.textContent = t
      el.style.opacity = '1'
    }, text)
  } catch {
    /* 页面还没准备好就跳过 */
  }
}

async function hideBadge(page) {
  try {
    await page.evaluate(() => {
      const el = document.getElementById('__dsh_badge')
      if (el) el.style.opacity = '0'
    })
  } catch {
    /* ignore */
  }
}

/**
 * 采集当前这一屏的视频信息。
 *
 * 抖音网页版的结构经常变，所以这里**不依赖单一 class**：
 * 每类信息给几个候选选择器，全都拿不到就当这条没采到 —— 跳过，不猜。
 */
async function readCurrentVideo(page) {
  const title = await textOf(page, [
    '[data-e2e="video-desc"]',
    '[data-e2e="feed-video-desc"]',
    'div[class*="video-info"] div[class*="desc"]'
  ])
  const author = await textOf(page, [
    '[data-e2e="video-author"]',
    '[data-e2e="feed-video-author"]',
    'a[class*="author"] span'
  ])
  const likeText = await textOf(page, [
    '[data-e2e="video-like-count"]',
    '[data-e2e="like-count"]',
    'div[class*="like"] span'
  ])
  const durationText = await textOf(page, ['[data-e2e="video-duration"]', 'span[class*="duration"]'])

  const href = page.url()
  const idMatch = href.match(/(?:modal_id|video)\/(\d+)/)
  return {
    id: idMatch ? idMatch[1] : '',
    title,
    author,
    likes: parseCount(likeText),
    duration: Number(String(durationText).replace(/\D/g, '')) || 0,
    url: href
  }
}

/** 点一个按钮，点不到就返回 false —— 绝不硬按 */
async function clickFirst(page, selectors) {
  for (const s of selectors) {
    try {
      const el = await page.$(s)
      if (el) {
        await el.click({ timeout: 3000 })
        return true
      }
    } catch {
      /* 被遮挡/失效都跳过 */
    }
  }
  return false
}

async function runOnce(cfg) {
  const cfgSrv = await fetchConfig(cfg)
  if (!cfgSrv.enabled) {
    log('面板里「允许她刷抖音」是关的，这轮跳过')
    return { skipped: true }
  }
  const nowHM = new Date().toTimeString().slice(0, 5)
  if (cfgSrv.activeFrom && cfgSrv.activeTo && (nowHM < cfgSrv.activeFrom || nowHM > cfgSrv.activeTo)) {
    log(`不在允许时段（${cfgSrv.activeFrom}–${cfgSrv.activeTo}），这轮跳过`)
    return { skipped: true }
  }
  if (cfgSrv.likeLeft <= 0 && cfgSrv.favLeft <= 0 && cfgSrv.shareLeft <= 0) {
    log('今天的额度都用完了，这轮跳过')
    return { skipped: true }
  }

  log(`开始：点赞剩 ${cfgSrv.likeLeft} / 收藏剩 ${cfgSrv.favLeft} / 分享剩 ${cfgSrv.shareLeft}`)

  const { chromium } = await import('playwright-core')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort || 9222}`)
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('Edge 里没有可用的浏览器上下文，先确认 start-edge.bat 起的那个窗口还在')
  const page = ctx.pages()[0] || (await ctx.newPage())

  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await sleep(3000)

  if (cfg.mute !== false) {
    try {
      await page.evaluate(() => {
        document.querySelectorAll('video').forEach((v) => (v.muted = true))
      })
    } catch {}
  }

  const blockWords = String(cfgSrv.blockWords || '')
    .split(/[,，、\s]+/)
    .map((w) => w.trim())
    .filter(Boolean)

  const items = []
  const seen = new Set()
  const budget = { likes: cfgSrv.likeLeft, favs: cfgSrv.favLeft, shares: cfgSrv.shareLeft }
  const acted = { likes: 0, favs: 0, shared: 0 }
  const deadline = Date.now() + (Number(cfgSrv.roundMaxMin) || 10) * 60_000
  const maxScroll = Number(cfgSrv.scrollRounds) || 25

  for (let i = 0; i < maxScroll; i++) {
    if (Date.now() > deadline) {
      log('到单轮时长上限，收手')
      break
    }
    if (acted.likes >= budget.likes && acted.favs >= budget.favs && acted.shared >= budget.shares) {
      log('额度用满，收手')
      break
    }

    const v = await readCurrentVideo(page)
    const key = v.id || v.title
    if (key && !seen.has(key)) {
      seen.add(key)
      // 硬筛：不花 token，先剔掉明显不值得的
      const blocked = blockWords.some((w) => (v.title || '').includes(w))
      const tooLowLike = v.likes > 0 && v.likes < (Number(cfgSrv.minLikes) || 0)
      const tooShort = v.duration > 0 && v.duration < (Number(cfgSrv.minDuration) || 0)
      const noTitle = !v.title

      if (blocked || tooLowLike || tooShort || noTitle) {
        log(`跳过《${(v.title || '无标题').slice(0, 20)}》` +
          (blocked ? '（屏蔽词）' : tooLowLike ? '（赞太少）' : tooShort ? '（太短）' : '（无文案）'))
      } else {
        items.push(v)
        await showBadge(page, `她正在看：${v.title.slice(0, 20)}`)

        // 点赞 / 收藏：额度够就点，点不动就算了
        if (acted.likes < budget.likes && (await clickFirst(page, ['[data-e2e="video-like-icon"]', '[data-e2e="like-icon"]']))) {
          acted.likes++
          await sleep(1200 + Math.random() * 1800)
        }
        if (acted.favs < budget.favs && (await clickFirst(page, ['[data-e2e="video-collect-icon"]', '[data-e2e="collect-icon"]']))) {
          acted.favs++
          await sleep(1200 + Math.random() * 1800)
        }
        // 分享：只发给配置里那个人，一天几条
        if (acted.shared < budget.shares && cfgSrv.shareToId) {
          const ok = await shareTo(page, cfgSrv.shareToId)
          if (ok) {
            acted.shared++
            await sleep(2500 + Math.random() * 2500)
          }
        }
      }
    }

    // 下一个：模拟人往下滚，间隔随机
    try {
      await page.keyboard.press('ArrowDown')
    } catch {}
    await sleep(2500 + Math.random() * 3500)
  }

  await hideBadge(page)
  log(`本轮结束：采到 ${items.length} 条，点赞 ${acted.likes} / 收藏 ${acted.favs} / 分享 ${acted.shared}`)

  const res = await submit(cfg, { items, acted, at: Date.now() })
  log(res.ok ? '已交回服务器' : `交回失败 HTTP ${res.status}`)
  return { items: items.length, acted, submitted: res.ok }
}

/**
 * 分享给指定抖音号。
 *
 * 走抖音自己的分享面板，**只发不读**。任何一步找不到就放弃 ——
 * 私信频率敏感，宁可少发一次也不要乱点。
 */
async function shareTo(page, douyinId) {
  try {
    const opened = await clickFirst(page, ['[data-e2e="video-share-icon"]', '[data-e2e="share-icon"]'])
    if (!opened) return false
    await sleep(1500)

    // 分享面板里的「私信」/「发给朋友」
    const dm = await clickFirst(page, [
      'text=私信',
      'text=发给朋友',
      '[data-e2e="share-panel-friend"]'
    ])
    if (!dm) {
      await page.keyboard.press('Escape').catch(() => {})
      return false
    }
    await sleep(1200)

    // 搜人：输入抖音号，等结果，点第一个
    const input = await pick(page, ['input[placeholder*="搜索"]', 'input[type="text"]'])
    if (!input) {
      await page.keyboard.press('Escape').catch(() => {})
      return false
    }
    await input.fill(String(douyinId))
    await sleep(2000)
    const picked = await clickFirst(page, ['[data-e2e="share-search-item"]', 'div[class*="search-item"]'])
    if (!picked) {
      await page.keyboard.press('Escape').catch(() => {})
      return false
    }
    await sleep(800)
    const sent = await clickFirst(page, ['button:has-text("发送")', '[data-e2e="share-send"]'])
    await sleep(800)
    return sent
  } catch {
    return false
  }
}

async function main() {
  const cfg = loadCfg()
  const loop = process.argv.includes('--loop')
  if (!loop) {
    await runOnce(cfg)
    return
  }
  const gap = Math.max(5, Number(cfg.checkIntervalMin) || 30) * 60_000
  log(`常驻模式：每 ${Math.round(gap / 60000)} 分钟看一次面板开关`)
  for (;;) {
    try {
      await runOnce(cfg)
    } catch (e) {
      log(`这一轮出错（不影响下一轮）：${e.message}`)
    }
    await sleep(gap)
  }
}

main().catch((e) => {
  console.error('致命错误：', e.message)
  process.exit(1)
})
