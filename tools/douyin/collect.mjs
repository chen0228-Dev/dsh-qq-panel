/**
 * 抖音采集端 —— 跑在用户的 Windows 电脑上，不是服务器。
 *
 * 接管已登录的 Edge，逐个点开视频，点赞/收藏/分享，最后把看到的东西交回服务器。
 *
 * 【为什么在这边跑】服务器只剩 584MB、没装浏览器；点赞收藏是**写操作**，
 * 只读接口给不了，必须真浏览器带登录态。
 *
 * 【怎么跑】
 *   1. 双击 start-edge.bat（带调试口的专用 Edge，首次扫码登录）
 *   2. config.json 填服务器地址和面板令牌
 *   3. node collect.mjs         # 跑一轮
 *      node collect.mjs --loop  # 常驻，按 checkIntervalMin 轮询面板开关
 *      node collect.mjs --no-tap # 只采集不动手（调试用）
 *
 * 【2026-10-24 摸出来的页面结构（别再瞎猜）】
 *   列表页 /jingxuan 上**没有**点赞按钮，只有点开才会弹出详情层：
 *     点击封面 → URL 变成 /jingxuan?modal_id=<id> → 这一层里有：
 *       [data-e2e="video-desc"]            文案
 *       [data-e2e="feed-video-nickname"]   作者
 *       [data-e2e="video-player-digg"]     点赞（文本就是点赞数）
 *       [data-e2e="video-player-collect"]  收藏（文本是收藏数）
 *       [data-e2e="video-player-share"]    分享
 *   而且 digg 元素带 `data-e2e-state="video-player-no-digged"`：
 *   能**先查状态再点**，已点过的不会重复点 —— 这是最重要的保险。
 *
 *   附两条踩过的坑：`?recommend=1` 现在会落到 /jingxuan；
 *   `el.click()` 这类 JS 调用不触发抖音框架的事件，**必须用 page.mouse.click**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NO_TAP = process.argv.includes('--no-tap')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CFG_FILE = path.join(HERE, 'config.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rnd = (a, b) => a + Math.random() * (b - a)
/*
 * 日志同时往 stdout 和文件写。
 *
 * 为什么：Node 的 stdout 在重定向到文件时是异步的，进程被 kill（超时/ctrl-c）时
 * 缓冲区里那几百行直接丢掉 —— 之前排查时看到的就是「日志完全空白」，
 * 完全不知道跑到哪一步就死了。appendFileSync 是同步的，一定落盘。
 */
const LOG_FILE = path.join(HERE, 'last-run.log')
const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ` + a.join(' ')
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* 写不了就算了，别因为日志把主流程搞崩 */
  }
}

function loadCfg() {
  if (!fs.existsSync(CFG_FILE)) {
    console.error('缺少 config.json —— 复制 config.example.json 改个名，填好 server 和 token')
    process.exit(1)
  }
  const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
  if (!c.server || !c.token || String(c.token).includes('粘贴')) {
    console.error('config.json 里的 server / token 还没填')
    process.exit(1)
  }
  return c
}

function parseCount(s) {
  const t = String(s || '').replace(/[,\s]/g, '')
  const m = t.match(/([\d.]+)\s*(万|w|W|亿)?/)
  if (!m) return 0
  const n = parseFloat(m[1]) || 0
  const u = m[2]
  if (u === '万' || u === 'w' || u === 'W') return Math.round(n * 10000)
  if (u === '亿') return Math.round(n * 100000000)
  return Math.round(n)
}

async function fetchConfig(cfg) {
  const r = await fetch(`${cfg.server.replace(/\/$/, '')}/api/douyin/config`, {
    headers: { 'x-douyin-token': cfg.token }
  })
  if (!r.ok) throw new Error(`拉配置失败 HTTP ${r.status}`)
  return r.json()
}

async function submit(cfg, payload) {
  const r = await fetch(`${cfg.server.replace(/\/$/, '')}/api/douyin/ingest`, {
    method: 'POST',
    headers: { 'x-douyin-token': cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { ok: r.ok, status: r.status }
}

async function badge(page, text, hide = false) {
  try {
    await page.evaluate(
      ({ t, h }) => {
        let el = document.getElementById('__dsh_badge')
        if (!el) {
          el = document.createElement('div')
          el.id = '__dsh_badge'
          el.style.cssText = [
            'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483647',
            'padding:8px 14px', 'border-radius:10px', 'font-size:13px',
            'background:rgba(32,32,32,.86)', 'color:#fff', 'font-family:system-ui',
            'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'pointer-events:none',
            'transition:opacity .2s', 'max-width:60vw'
          ].join(';')
          document.body.appendChild(el)
        }
        if (t) el.textContent = t
        el.style.opacity = h ? '0' : '1'
      },
      { t: text, h: hide }
    )
  } catch {
    /* 页面没准备好，忽略 */
  }
}

/** 找视口内可点的封面（大图，按从上到下排序） */
async function findCovers(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('img')]
      .filter((i) => {
        const r = i.getBoundingClientRect()
        return i.offsetParent !== null && r.width > 160 && r.height > 160 && r.y > 80 && r.y < window.innerHeight - 40
      })
      .map((i) => {
        const r = i.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) }
      })
      .slice(0, 6)
  })
}

async function modalOpen(page) {
  return page.evaluate(() => !!document.querySelector('[data-e2e="video-desc"], [data-e2e="video-player-digg"]'))
}

async function readModal(page) {
  return page.evaluate(() => {
    const txt = (s) => {
      const e = document.querySelector(s)
      return e ? (e.innerText || e.textContent || '').trim() : ''
    }
    const digg = document.querySelector('[data-e2e="video-player-digg"]')
    return {
      url: location.href,
      title: txt('[data-e2e="video-desc"]').slice(0, 140),
      author: txt('[data-e2e="feed-video-nickname"]').replace(/^@/, '').slice(0, 32),
      likeText: txt('[data-e2e="video-player-digg"]').slice(0, 12),
      collectText: txt('[data-e2e="video-player-collect"]').slice(0, 12),
      diggState: digg ? digg.getAttribute('data-e2e-state') || '' : '',
      hasDigg: !!digg
    }
  })
}

async function closeModal(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(600)
  if (await modalOpen(page)) {
    await page.mouse.click(20, 400).catch(() => {})
    await sleep(500)
  }
}

/**
 * 点赞。先读 `data-e2e-state`，已经是 digged 就直接跳过 ——
 * 这道保险防两件事：重复点、以及反复点触发风控。
 */

/**
 * 按坐标点一个元素。
 *
 * 为什么不用 page.click：抖音这些图标按钮外面套着多层 div，
 * Playwright 的可操作性检查（可见、不被遮挡、能接收事件）经常判失败，
 * 报 `page.click: Timeout 1200ms exceeded` —— 但人用手点是能点到的。
 * 所以这里取 boundingBox 自己算中心点，用 mouse.click 发真实鼠标事件。
 */
async function clickByE2E(page, sel) {
  const box = await page.evaluate((s) => {
    const e = document.querySelector(s)
    if (!e) return null
    const r = e.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return null
    if (r.x < 0 || r.y < 0 || r.x > window.innerWidth || r.y > window.innerHeight) return null
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }, sel)
  if (!box) return false
  await page.mouse.click(box.x, box.y)
  return true
}

async function tapDigg(page) {
  const st = await page.evaluate(() => {
    const e = document.querySelector('[data-e2e="video-player-digg"]')
    return e ? e.getAttribute('data-e2e-state') || '' : null
  })
  if (st === null) return { ok: false, why: '找不到点赞按钮' }
  if (/digged$/.test(st) && !/no-digged$/.test(st)) return { ok: true, skipped: true, why: st }
  try {
    if (!(await clickByE2E(page, '[data-e2e="video-player-digg"]'))) {
      return { ok: false, why: '按钮不在可视区' }
    }
    await sleep(800)
    const after = await page.evaluate(() => {
      const e = document.querySelector('[data-e2e="video-player-digg"]')
      return e ? e.getAttribute('data-e2e-state') || '' : ''
    })
    return { ok: !/no-digged$/.test(after), why: after }
  } catch (e) {
    return { ok: false, why: e.message.slice(0, 40) }
  }
}

async function tapCollect(page) {
  const st = await page.evaluate(() => {
    const e = document.querySelector('[data-e2e="video-player-collect"]')
    return e ? e.getAttribute('data-e2e-state') || '' : null
  })
  if (st === null) return { ok: false, why: '找不到收藏按钮' }
  if (/collected$/.test(st) && !/no-collected$/.test(st)) return { ok: true, skipped: true, why: st }
  try {
    if (!(await clickByE2E(page, '[data-e2e="video-player-collect"]'))) {
      return { ok: false, why: '按钮不在可视区' }
    }
    await sleep(800)
    const after = await page.evaluate(() => {
      const e = document.querySelector('[data-e2e="video-player-collect"]')
      return e ? e.getAttribute('data-e2e-state') || '' : ''
    })
    return { ok: !/no-collected$/.test(after), why: after }
  } catch (e) {
    return { ok: false, why: e.message.slice(0, 40) }
  }
}

/**
 * 抖音站内分享：把当前视频私信发给指定的人。
 *
 * 【2026-10-24 实测出来的结构】点分享后弹出 `video-share-container`，
 * 里面是**最近联系人列表**，每人一行，行尾有个「分享」按钮：
 *
 *     SPAN | <你的抖音昵称> | ...     DIV | 分享 |
 *     SPAN | 小小柒   | ...     DIV | 分享 |   ← 用户的号
 *
 * 所以不需要搜索：在面板里找"包含 target 的那一行"，点它自己的「分享」。
 *
 * 【为什么按昵称匹配】面板上显示的是**昵称**，不是抖音号。
 * 填抖音号那一串数字在这里对不上。所以 `shareToId` 允许填昵称，
 * 但昵称会重名 —— 找不到就放弃，绝不猜。
 *
 * 【安全】只点 innerText 短（<40 字）且包含目标的那一行里的「分享」按钮。
 * 不按坐标盲点，宁可这次不发。
 */
async function shareTo(page, target) {
  const t = String(target || '').trim()
  if (!t) return false
  try {
    if (!(await clickByE2E(page, '[data-e2e="video-player-share"]'))) return false
    await sleep(2200)

    const hit = await page.evaluate((needle) => {
      const cont = document.querySelector('[data-e2e="video-share-container"]')
      if (!cont) return null
      const rows = [...cont.querySelectorAll('div')]
        .filter((d) => {
          const txt = (d.innerText || '').trim()
          return txt.includes(needle) && txt.length < 40
        })
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)

      for (const row of rows) {
        const btn = [...row.querySelectorAll('div,button,span')].find(
          (b) => (b.innerText || '').trim() === '分享'
        )
        if (!btn) continue
        const r = btn.getBoundingClientRect()
        if (r.width < 10 || r.height < 10) continue
        return {
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          who: (row.innerText || '').trim().split('\n')[0].slice(0, 20)
        }
      }
      return null
    }, t)

    if (!hit) {
      log(`  分享：面板里没找到「${t}」，跳过（不猜人）`)
      await page.keyboard.press('Escape').catch(() => {})
      return false
    }

    await page.mouse.click(hit.x, hit.y)
    await sleep(1600)
    log(`  分享：点了「${hit.who}」的分享`)

    // 有些版本会再弹一次确认
    const cf = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,div')].find(
        (x) => /^(发送|确认|确定)$/.test((x.innerText || '').trim()) && x.getBoundingClientRect().width > 20
      )
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    if (cf) {
      await page.mouse.click(cf.x, cf.y)
      await sleep(1200)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 读抖音私信：把用户发来的视频捞出来。
 *
 * 【实测定下来的结构】
 *   点右上角「消息」（含"消息"文字的图标）→ 弹出 `im-dialog`（336x841）
 *   里面 `conversation-item` 是会话列表，`msg-item-content` 是消息气泡。
 *   **方向靠 x 坐标判断**：气泡在左侧（x < 对话区中线偏左）＝ 对方发的；
 *   右侧是她自己发的（她分享出去的那些就在右边）。
 *   视频卡片的 class 是 `MessageItemShareAwemecontainer` / `...awemeContainer`。
 *
 * 【视频链接怎么拿】卡片上没有 <a>、也没有 data-id。只能点开——
 * 点开会让 URL 带上 `?modal_id=<aweme_id>`，拿到再 ESC 退回。
 *
 * 【只处理最新的一条】每条都要点开+退回，批量做很慢也容易乱。
 * 轮询本来就 30 分钟一次，一次补一条足够。
 */
const INBOX_SEEN = path.join(HERE, 'inbox-seen.json')

function loadSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(INBOX_SEEN, 'utf8'))
    return new Set(Array.isArray(j.ids) ? j.ids : [])
  } catch {
    return new Set()
  }
}

function saveSeen(set) {
  try {
    // 只留最近 200 个，别让文件无限长
    fs.writeFileSync(INBOX_SEEN, JSON.stringify({ ids: [...set].slice(-200) }, null, 0))
  } catch {}
}

/**
 * 确认服务器收下了才记账。
 *
 * 必须在 POST 成功之后调用 —— 顺序反了就会出现「服务器丢弃 + 本地已标记」
 * 的双重失败，那条分享再也回不来。
 */
function markSeen(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
  if (!list.length) return
  const seen = loadSeen()
  for (const id of list) seen.add(String(id))
  saveSeen(seen)
}

async function checkInbox(page, cfg, target) {
  const t = String(target || '').trim()
  if (!t) return []
  const seen = loadSeen()

  try {
    // 1) 先回到干净状态
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(500)

    // 2) 点「消息」入口（右上角那个图标）
    const entry = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect()
        const label = e.getAttribute('aria-label') || ''
        const txt = (e.innerText || '').trim()
        return (label.includes('消息') || txt === '消息') && r.width > 10 && r.width < 90 && r.height > 10 && r.height < 90
      })
      if (!cands.length) return null
      const best = cands
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0]
      return { x: Math.round(best.r.x + best.r.width / 2), y: Math.round(best.r.y + best.r.height / 2) }
    })
    if (!entry) {
      log('  收件箱：页面上找不到「消息」入口，跳过')
      return []
    }
    await page.mouse.click(entry.x, entry.y)
    await sleep(5000)
    const probe = await page.evaluate(() => {
      const dlg = document.querySelector('[data-e2e="im-dialog"]')
      const dr = dlg ? dlg.getBoundingClientRect() : null
      return {
        hasDialog: !!dlg,
        size: dr ? Math.round(dr.width) + 'x' + Math.round(dr.height) : '-',
        convCount: document.querySelectorAll('[data-e2e="conversation-item"]').length,
        convNames: [...document.querySelectorAll('[data-e2e="conversation-item"]')].map(e => (e.innerText||'').split('\n')[0]).slice(0,5)
      }
    })
    log(`  收件箱：点了 (${entry.x},${entry.y}) → dialog=${probe.hasDialog?probe.size:'无'} 会话数=${probe.convCount} ${probe.convNames.join(' / ')}`)

    // 浮层偶尔停在 0x0（动画没跑完 / 点了但没展开）。这时候再点一次。
    if (!probe.hasDialog || probe.size === '0x0') {
      await page.mouse.click(entry.x, entry.y)
      await sleep(3500)
      const again = await page.evaluate(() => {
        const d = document.querySelector('[data-e2e="im-dialog"]')
        const r = d ? d.getBoundingClientRect() : null
        return { size: r ? Math.round(r.width) + 'x' + Math.round(r.height) : '-', n: document.querySelectorAll('[data-e2e="conversation-item"]').length }
      })
      log(`  收件箱：再点一次 → dialog=${again.size} 会话数=${again.n}`)
    }

    // 3) 找和目标的会话
    const conv = await page.evaluate((needle) => {
      const it = [...document.querySelectorAll('[data-e2e="conversation-item"]')].find((e) =>
        (e.innerText || '').includes(needle)
      )
      if (!it) return null
      const r = it.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }, t)
    if (!conv) {
      log(`  收件箱：没找到和「${t}」的会话`)
      await page.keyboard.press('Escape').catch(() => {})
      return []
    }
    await page.mouse.click(conv.x, conv.y)
    await sleep(3200)

    // 4) 找「对方发来的」视频卡片，取最新的一条
    const card = await page.evaluate(() => {
      const dlg = document.querySelector('[data-e2e="im-dialog"]')
      if (!dlg) return null
      const drect = dlg.getBoundingClientRect()
      /*
       * 判断"谁发的"：**看左边缘是否贴着对话区左边**。
       *
       * 之前用「中线偏左」(x < dialog.x + w*0.45) 判，实测会误判 ——
       * 因为她自己发出去的那些气泡也比较宽、左边缘不够靠右，
       * 结果把她分享出去的视频当成了用户发来的（读到了 @<她自己的账号>，那是她发的）。
       *
       * 改成：左边缘距对话区左边 < 60px 才算"对方发的"。
       * 自己发的是右对齐，左边缘会离得很远。
       */
      /*
       * 实测的坐标（对话区 x=680 宽=336）：
       *   他发的   x=729  → 距左边 49
       *   她发的   x=849  → 距左边 169
       * 所以「距左边 > 120」就跳过。阈值取 120 是为了留出气泡宽度差异的余量。
       */
      const found = []
      for (const m of dlg.querySelectorAll('[data-e2e="msg-item-content"]')) {
        const r = m.getBoundingClientRect()
        if (r.x - drect.x > 120) continue // 离左边太远 → 自己发的，跳过
        const c = m.querySelector('.MessageItemShareAwemecontainer, .MessageItemShareAwemeawemeContainer')
        if (!c) continue
        const cr = c.getBoundingClientRect()
        if (cr.width < 40) continue
        found.push({
          author: (m.innerText || '').trim().split('\n')[0].slice(0, 30),
          x: Math.round(cr.x + cr.width / 2),
          y: Math.round(cr.y + cr.height / 2)
        })
      }
      return found.length ? found[found.length - 1] : null
    })

    if (!card) {
      log('  收件箱：没有他发来的新视频')
      await page.keyboard.press('Escape').catch(() => {})
      return []
    }

    // 5) 点开卡片拿 id
    const before = page.url()
    await page.mouse.click(card.x, card.y)
    await sleep(3500)
    const after = page.url()
    const m = String(after).match(/(?:modal_id=|\/video\/)(\d{8,})/)
    const url = m ? `https://www.douyin.com/video/${m[1]}` : ''
    const id = m ? m[1] : ''

    /*
     * 顺便把详情层里的文案读出来。
     * 只给链接的话她根本不知道视频讲什么，说不出个所以然 ——
     * 实测第一次就是这样：注入进去了、turn 也 completed 了，但她一个字没回。
     */
    /*
     * 文案和作者只在**弹层容器内部**找。
     * 全局找会撞到侧边栏推荐、评论区里的同名 class，读出来是别人的名字 ——
     * 第一次就是这么错的：id 是他发的那个，作者却是她自己发的那条。
     */
    const detail = await page.evaluate(() => {
      const box = document.querySelector('[data-e2e="modal-video-container"]') || document.body
      const d = box.querySelector('[data-e2e="video-desc"]')
      const n = box.querySelector('[data-e2e="feed-video-nickname"]')
      return {
        desc: d ? (d.innerText || '').trim().slice(0, 120) : '',
        nick: n ? (n.innerText || '').trim().replace(/^@/, '').slice(0, 32) : ''
      }
    })

    // 退回
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(1200)
    if (page.url() !== before) {
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(800)
    }

    if (!id) {
      log('  收件箱：点开了卡片但没拿到视频 id')
      return []
    }
    if (seen.has(id)) {
      log(`  收件箱：视频 ${id} 之前已经报过了`)
      return []
    }
    /*
     * 【2026-10-24 修】这里原来立刻 seen.add + saveSeen。
     *
     * 那个顺序有个致命的洞：服务器在「他 90 秒内刚说过话」时会返回
     * skipped:'busy' 什么都不做，而 id 已经记成"报过了" ——
     * 于是那条分享**永远不会再上报**，等于被吞了。
     *
     * 现在改成：这里只读不记账，等 runOnce 拿到服务器的肯定答复
     * （injected 或 queued）之后再 markSeen。宁可重复上报一次，
     * 也不能把用户发的东西弄丢。
     */
    /*
     * 作者名优先用**气泡上那个**（card.author，稳定），弹层里读到的不靠谱。
     * 实测同一时刻：气泡上是「<他分享的账号>」（他发的），
     * 但弹层里的 feed-video-nickname 读出来是「<她自己的账号>」——那是她自己发的另一条。
     * id 是对的，只是名字串了。所以顺序调过来。
     */
    const author = card.author || detail.nick || ''
    log(`  收件箱：他发来一条视频 @${author || '?'} → ${id}`)
    log(`  收件箱：文案「${detail.desc.slice(0, 40)}」`)
    return [{ author, url, id, title: detail.desc }]
  } catch (e) {
    log(`  收件箱出错（不影响刷视频）：${e.message.slice(0, 60)}`)
    return []
  }
}

/* ------------------------------------------------------------------
 * 自己拉起 Edge（2026-10-24 新增）
 *
 * 【为什么需要】
 * 原来的设计是「用户先双击 启动专用Edge.bat，采集端只负责连」。
 * 实际上有两个问题：
 *  1. 电脑重启后自启动里只有采集循环，没有 Edge —— 于是每 30 分钟报一次
 *     「连不上 9222」，而错误是被 catch 掉的，**静默失败**，用户根本不会知道。
 *  2. 用户以为「电脑开着就会自己刷」，结果要先点两个脚本。
 *
 * 所以改成：连不上就自己 spawn 一个 Edge。
 *
 * 【三条红线】
 *  ① 必须复用同一个 `--user-data-dir`（默认 D:/ccPrograms/EdgeDouyin）——
 *     换目录等于换浏览器，抖音登录态就没了，要重新扫码。
 *  ② 必须带 `--remote-debugging-port`，否则 CDP 连不上，等于白起。
 *  ③ **不碰用户平时用的 Edge**：不同 user-data-dir 是两个独立实例，可以并存，
 *     不会把他的标签页抢过来、也不会退出他的登录态。
 *
 * `autoStartEdge: false` 可以关掉这个行为，退回手动起 Edge 的老路子。
 * ------------------------------------------------------------------ */

/** Edge 的两个常见安装位置（64 位系统上 x86 那个才是默认） */
const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
]

function findEdgeExe(cfg) {
  const custom = String(cfg.edgePath || '').trim()
  if (custom && fs.existsSync(custom)) return custom
  for (const p of EDGE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return ''
}

/** 调试口通了没有（这是唯一可靠的判据，别用进程名猜） */
async function cdpReady(port, waitMs = 1500) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), waitMs)
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal })
    clearTimeout(timer)
    return r.ok
  } catch {
    return false
  }
}

async function launchEdge(cfg) {
  const exe = findEdgeExe(cfg)
  if (!exe) {
    log('  [Edge] 找不到 msedge.exe —— 在 config.json 里填 edgePath（完整路径）')
    return false
  }
  const port = Number(cfg.cdpPort) || 9222
  // 登录态就在这个目录里，**不能换**
  const profile = String(cfg.edgeProfile || 'D:/ccPrograms/EdgeDouyin')
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    'https://www.douyin.com/'
  ]
  log(`  [Edge] 9222 没人，自己拉起：${exe}`)
  log(`  [Edge] 用配置目录 ${profile}（登录态在这儿）`)
  try {
    // detached + unref：采集端退出时不要把这个 Edge 一起带走，
    // 否则每轮结束浏览器就没了，下一轮又得重开
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.on('error', (e) => log(`  [Edge] spawn 报错：${e.message}`))
    child.unref()
  } catch (e) {
    log(`  [Edge] 拉起失败：${e.message}`)
    return false
  }
  // 等调试口就绪。20 秒够冷启动 + 首屏；等不到就认输，下一轮再试
  for (let i = 1; i <= 20; i++) {
    await sleep(1000)
    if (await cdpReady(port)) {
      log(`  [Edge] 起来了（等了 ${i} 秒）`)
      return true
    }
  }
  log('  [Edge] 等了 20 秒调试口还是不通，可能是 Edge 弹了别的窗口挡住了')
  return false
}

/**
 * 连接 Edge；连不上且允许自动拉起，就拉起后再连。
 *
 * 注意第二次连接要重试几次：刚起来的 Edge 虽然 /json/version 通了，
 * CDP 的 browser endpoint 偶尔还要再等一两秒才 accept。
 */
async function connectEdge(chromium, cfg) {
  const port = Number(cfg.cdpPort) || 9222
  const url = `http://127.0.0.1:${port}`

  /*
   * connectOverCDP 一定要给 timeout。
   * 默认 30 秒，而如果上一条 collect 进程没退干净、还挂着这个 CDP 连接，
   * 新的连接会一直等到超时 —— 表现出来的就是「日志停在开始，后面什么都没有」。
   * 2026-10-24 就被这个坑了一轮，最后是用 wmic 发现有个僵尸 node 占着。
   */
  try {
    return await chromium.connectOverCDP(url, { timeout: 12000 })
  } catch (e) {
    log(`  [Edge] 第一次连接失败：${String(e.message || e).slice(0, 60)}`)
    if (cfg.autoStartEdge === false) throw e
  }

  if (!(await launchEdge(cfg))) {
    throw new Error('Edge 没在跑，自动拉起也没成功。手动双击「启动专用Edge.bat」再试一次')
  }

  let lastErr = null
  for (let i = 0; i < 4; i++) {
    try {
      return await chromium.connectOverCDP(url, { timeout: 10000 })
    } catch (e) {
      lastErr = e
      await sleep(2000)
    }
  }
  throw new Error(`Edge 起来了但 CDP 连不上：${String(lastErr?.message || lastErr).slice(0, 60)}`)
}

/** 告诉她/状态机「我开始刷了 / 我刷完了」。失败不影响刷本身 */
async function reportPhase(cfg, phase, ackRun) {
  try {
    await fetch(`${cfg.server.replace(/\/$/, '')}/api/douyin/phase`, {
      method: 'POST',
      headers: { 'x-douyin-token': cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase, ackRun: ackRun || undefined })
    })
  } catch (e) {
    log(`  状态上报失败（不影响刷）：${String(e.message).slice(0, 40)}`)
  }
}

async function runOnce(cfg) {
  try { fs.writeFileSync(LOG_FILE, '') } catch {}
  const srv = await fetchConfig(cfg)
  /*
   * 她在对话里要求「去刷会儿」→ 面板写下一条 runNow 留言 → 这里取到就把回执销掉。
   *
   * 注意回执要**放在所有跳过判断之前**：服务端已经先验过开关/时段/额度才排进来的，
   * 这里再因为某些边界条件跳过，也不能把留言留着 —— 否则循环会一直看到它、
   * 每 60 秒重跑一轮空转。
   */
  if (srv.runNow && srv.runNow.id) {
    log(`她要求刷一轮（${srv.runNow.id}），这轮就是`)
    await reportPhase(cfg, undefined, srv.runNow.id)
  }
  if (!srv.enabled) {
    log('面板里「允许她刷抖音」是关的，这轮跳过')
    return { skipped: true }
  }
  const hm = new Date().toTimeString().slice(0, 5)
  if (srv.activeFrom && srv.activeTo && (hm < srv.activeFrom || hm > srv.activeTo)) {
    log(`不在允许时段（${srv.activeFrom}–${srv.activeTo}），这轮跳过`)
    return { skipped: true }
  }
  if (srv.likeLeft <= 0 && srv.favLeft <= 0 && srv.shareLeft <= 0) {
    log('今天的额度都用完了，这轮跳过')
    return { skipped: true }
  }

  log(`开始：赞剩 ${srv.likeLeft} / 藏剩 ${srv.favLeft} / 分享剩 ${srv.shareLeft}${NO_TAP ? '（--no-tap 只采集）' : ''}`)

  const { chromium } = await import('playwright-core')
  // 连不上会自己拉起 Edge（复用登录态那份配置目录），见 connectEdge 的注释
  const browser = await connectEdge(chromium, cfg)
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('Edge 没有可用上下文。删掉 D:/ccPrograms/EdgeDouyin 里的单实例锁再试')
  const page = ctx.pages()[0] || (await ctx.newPage())

  /*
   * 上一次运行可能把它留在 `?modal_id=xxx` 的详情层里。
   * 那种状态下 page.goto 在抖音这个 SPA 里**不一定触发真正的导航**，
   * 于是一直挂到超时 —— 日志停在「开始」后面再没有下文，就是卡在这。
   * 所以先按两次 ESC 退出弹层，再用 waitUntil:'commit'（收到响应头就返回，不等到 DOM）。
   */
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(400)
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(600)
  try {
    await page.goto('https://www.douyin.com/jingxuan', { waitUntil: 'commit', timeout: 25000 })
  } catch {
    log('导航超时，直接用当前页面继续')
  }
  await sleep(5000)
  if (cfg.mute !== false) {
    await page.evaluate(() => document.querySelectorAll('video').forEach((v) => (v.muted = true))).catch(() => {})
  }

  /*
   * 从这一刻起她真的在看视频了 —— 上报给状态机。
   *
   * 放在这里而不是 runOnce 开头：前面那些「跳过」分支根本没刷，
   * 报了会让状态机凭空显示「在刷抖音」。
   * 服务端会给一个 roundMaxMin 的超时兜底，所以就算下面崩了没报 idle，
   * 到点也会自动回落，不会永远卡在「在刷」。
   */
  // 记一笔：状态已经报上去了，退出时才知道要不要撤
  let scrollingReported = false
  await reportPhase(cfg, 'scrolling')
  scrollingReported = true

  /*
   * 先看私信：他是不是给她发了视频。
   * 放在刷之前 —— 刚发过来的东西优先，别等她刷完一轮才看到。
   * 这个动作会打开消息浮层、点开视频卡片、再退回，所以做完要重新回列表页。
   */
  if (srv.shareToId) {
    const inbox = await checkInbox(page, cfg, srv.shareToId)
    if (inbox.length) {
      let accepted = false
      try {
        const r = await fetch(`${cfg.server.replace(/\/$/, '')}/api/douyin/inbound`, {
          method: 'POST',
          headers: { 'x-douyin-token': cfg.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: inbox, at: Date.now() })
        })
        if (r.ok) {
          /*
           * 服务器只要「注入成功」或「入队待聊」任一成立，这条就算交代了，
           * 本地才可以标记已上报。两个都 false（理论上不该发生）也标记 ——
           * 服务器明确收下并处理过了，重复上报只会让队列去重白跑。
           */
          let j = {}
          try {
            j = await r.json()
          } catch {}
          accepted = true
          log(
            `  已把他发来的 ${inbox.length} 条交回服务器` +
              (j.injected ? '（已即时告诉她）' : j.queued ? '（已进待聊队列）' : '')
          )
        } else {
          log(`  私信交回失败 HTTP ${r.status}（下轮重试，不记账）`)
        }
      } catch (e) {
        log(`  私信交回出错：${e.message.slice(0, 50)}（下轮重试，不记账）`)
      }
      if (accepted) markSeen(inbox.map((x) => x.id))
      // 收件箱操作会改变页面状态，重新导航再开始刷
      await page.goto('https://www.douyin.com/jingxuan', { waitUntil: 'commit', timeout: 25000 }).catch(() => {})
      /*
       * 这里必须等够久。
       *
       * 一次 runOnce 会注入**两次**：先私信（上面），再刷完的结果（下面）。
       * 实测两次间隔 5 秒时，两个 turn 几乎同时触发回复，
       * 面板的发送队列会互相等（日志刷「上一条还没发完」），
       * 结果两条回复全卡死、一条都没发出去。
       *
       * 20 秒够一次完整 turn（生成 + 分条 + 按打字速度发出）跑完。
       */
      log('  等他/她这轮回完再开始刷（20 秒）')
      await sleep(20000)
    }
  }

  try {
  const blockWords = String(srv.blockWords || '')
    .split(/[,，、\s]+/)
    .map((w) => w.trim())
    .filter(Boolean)

  const seen = new Set()
  const picked = []
  const acted = { likes: 0, favs: 0, shared: 0 }
  const budget = { likes: srv.likeLeft, favs: srv.favLeft, shares: srv.shareLeft }
  const deadline = Date.now() + (Number(srv.roundMaxMin) || 10) * 60_000
  // 调试时可以用 DY_MAX_STEPS=3 限步数，别等满 25 步才看出问题
  const maxSteps = Number(process.env.DY_MAX_STEPS) || Number(srv.scrollRounds) || 25
  let idleRounds = 0

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) {
      log('到单轮时长上限，收手')
      break
    }
    if (!NO_TAP && acted.likes >= budget.likes && acted.favs >= budget.favs && acted.shared >= budget.shares) {
      log('额度用满，收手')
      break
    }

    const covers = await findCovers(page)
    log(`第 ${step + 1} 步：屏幕上有 ${covers.length} 个可点封面`)
    if (!covers.length) {
      await page.mouse.wheel(0, 900)
      await sleep(rnd(1500, 2500))
      if (++idleRounds > 4) {
        log('找不到可点的内容了，收手')
        break
      }
      continue
    }

    let handled = false
    for (const c of covers.slice(0, 3)) {
      await page.mouse.click(c.x, c.y)
      await sleep(rnd(2200, 3200))
      if (!(await modalOpen(page))) {
        log(`  点了 (${c.x},${c.y}) 但没弹出详情层，试下一个`)
        continue
      }

      const info = await readModal(page)
      const key = (info.title || '').slice(0, 24)
      if (!key || seen.has(key)) {
        await closeModal(page)
        continue
      }
      seen.add(key)
      handled = true

      const likes = parseCount(info.likeText)
      const blocked = blockWords.some((w) => info.title.includes(w))
      const tooLow = likes > 0 && likes < (Number(srv.minLikes) || 0)
      if (blocked || tooLow) {
        log(`跳过《${key}》${blocked ? '（屏蔽词）' : '（赞太少）'}`)
        await closeModal(page)
        break
      }

      await badge(page, `她正在看：${key}`)

      if (!NO_TAP) {
        if (acted.likes < budget.likes) {
          const r = await tapDigg(page)
          if (r.ok && !r.skipped) acted.likes++
          if (!r.ok) log(`  点赞没成功：${r.why}`)
        }
        if (acted.favs < budget.favs) {
          const r = await tapCollect(page)
          if (r.ok && !r.skipped) acted.favs++
          if (!r.ok) log(`  收藏没成功：${r.why}`)
        }
        if (acted.shared < budget.shares && srv.shareToId) {
          if (await shareTo(page, srv.shareToId)) acted.shared++
        }
      }

      picked.push({
        title: info.title,
        author: info.author,
        likes,
        collects: parseCount(info.collectText),
        url: info.url
      })

      await closeModal(page)
      await sleep(rnd(800, 1600))
      break
    }

    if (!handled) {
      await page.mouse.wheel(0, 900)
      await sleep(rnd(1500, 2500))
      if (++idleRounds > 4) {
        log('连续几轮没点到新内容，收手')
        break
      }
    } else {
      idleRounds = 0
    }
  }

  await badge(page, '', true)
  log(`本轮结束：采到 ${picked.length} 条，点赞 ${acted.likes} / 收藏 ${acted.favs} / 分享 ${acted.shared}`)
  for (const p of picked.slice(0, 3)) {
    log(`  · ${p.title.slice(0, 26)} @${p.author} [${p.likes}]`)
  }

  const res = await submit(cfg, { items: picked, acted, at: Date.now() })
  log(res.ok ? '已交回服务器' : `交回失败 HTTP ${res.status}`)
  return { items: picked.length, acted, submitted: res.ok }
  } finally {
    /*
     * 不管前面怎么退出，都要做两件事：
     *  ① 把「在刷抖音」状态撤掉 —— 否则她会在 QQ 里一直说自己在刷；
     *  ② 放掉 CDP 连接，否则下次连不上（会一直等到 timeout）。
     * 顺序是先报状态再关浏览器：关浏览器可能抛异常，不能让它挡掉状态上报。
     */
    if (scrollingReported) await reportPhase(cfg, 'idle')
    await browser.close().catch(() => {})
  }
}

async function main() {
  const cfg = loadCfg()
  if (!process.argv.includes('--loop')) {
    await runOnce(cfg)
    return
  }
  const gap = Math.max(5, Number(cfg.checkIntervalMin) || 30) * 60_000
  const FAST = 60_000
  log(`常驻模式：本来每 ${Math.round(gap / 60000)} 分钟刷一轮；`)
  log(`            期间每 ${FAST / 1000} 秒问一次面板「有没有人让我刷」，有就提前开始`)

  for (;;) {
    try {
      await runOnce(cfg)
    } catch (e) {
      log(`这轮出错（不影响下一轮）：${e.message}`)
    }

    /*
     * 分段睡：不能一次 sleep(gap)，否则她在对话里说「去刷会儿」
     * 最长要等 30 分钟才生效，体感就是「说了没反应」。
     *
     * 每 60 秒只拉一个很小的配置 JSON（顺带刷新服务端的 aliveAt ——
     * 那是「电脑开着」的唯一判据，所以这一步不能省）。
     */
    const until = Date.now() + gap
    while (Date.now() < until) {
      await sleep(Math.min(FAST, Math.max(1000, until - Date.now())))
      try {
        const s = await fetchConfig(cfg)
        if (s.runNow && s.runNow.id) {
          log('面板说她要求刷一轮，不等了，现在开始')
          break
        }
      } catch {
        /* 网络抖一下就继续等，不要把常驻循环搞死 */
      }
    }
  }
}

main().catch((e) => {
  console.error('致命错误：', e.message)
  process.exit(1)
})
