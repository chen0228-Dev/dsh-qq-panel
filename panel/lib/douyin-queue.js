/**
 * 抖音「还没聊过」的待聊队列。
 *
 * 【这个文件解决什么问题】
 * 2026-10-24 实测暴露了一个洞：采集端是**先**把视频 id 写进 inbox-seen.json、
 * **再** POST 给服务器（collect.mjs 里 seen.add 在 fetch 之前）。
 * 而服务器在「他 90 秒内刚说过话」时会直接返回 skipped:'busy' 什么都不做。
 * 两边一夹，那条分享就**永久消失**了 —— id 已记成"报过了"，下次采集器直接跳过。
 * 所以队列的第一职责不是"抬权重"，是**兜住被丢掉的那些分享**。
 *
 * 【为什么单独一个文件，不塞进 proactive.json】
 * proactive.json 由 proactive.js 的 loadState/saveState 管，里面有一套
 * 「跨天重置 count/hotUsed」的逻辑。server.js 也要往队列里写，
 * 两个模块共用一个带状态重置语义的文件，迟早出事。独立文件两边都只做增删。
 *
 * 【"已讨论"怎么判定 —— 刻意不加内部标记】
 * 曾经想过让她回一行 `[[抖音聊过 id]]`，放弃了。理由是那要同时改
 * `_plugin/lib/outbound.js` 的 hasInternalMark 和 proxy.js 的兜底正则，
 * 少改一处就会重演「标记被渲染成图片发给对方」的事故，而且每轮多烧 token。
 *
 * 现在的判据全部是零成本的硬信号：
 *  1. 「他发给她的」—— 注入之后**他只要回过话**，就说明这条已经被聊过了。
 *     `injectPrivateMessage` 直接走 upstream.send，不经过 queueMessage，
 *     所以不会更新 lastUserAt —— 这个信号不会被注入自己污染。
 *  2. 「她自己刷到的」—— 被主动提过一次就算聊过。这类内容不是专门发给她的，
 *     提第二次就成了复读。
 *  3. 兜底：24 小时过期、最多 6 条、每条最多被主动提 2 次。
 *
 * 设计上的偏置和「续聊」一致：**宁可少提，不要重复提**。
 * 同一条视频被主动说两遍，比一条都没说更出戏。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from './store.js'

export const QUEUE_FILE = path.join(DATA_DIR, 'douyin-pending.json')

/** 队列上限。她一天能主动提的次数远小于这个数，多了只是垃圾 */
export const QUEUE_MAX = 6
/** 超过这个时间就不提了 —— 两天前的视频突然提起来很怪 */
export const TTL_MS = 24 * 3600_000
/** 单条最多被主动提几次（inbound 允许 2 次：第一次没聊起来可以再试一次） */
export const MAX_MENTION = 2

const TITLE_MAX = 80
const AUTHOR_MAX = 24

function clip(s, n) {
  const v = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return v.length > n ? v.slice(0, n) : v
}

/**
 * 从采集端给的链接里取 aweme_id。
 *
 * 采集端交上来的是详情层地址 `...?modal_id=7693...`，
 * 和标准分享链接 `/video/7693...` 是同一条视频的两种写法，都要认。
 * 取不到就返回空串，由调用方退回「用标题做去重键」。
 */
export function videoIdOf(url) {
  const m = String(url || '').match(/(?:modal_id=|\/video\/)(\d{8,})/)
  return m ? m[1] : ''
}

/** 标准分享链接。缺 id 时返回空串 —— 宁可不给链接，也不给一个打不开的 */
export function shareUrlOf(url) {
  const id = videoIdOf(url)
  return id ? `https://www.douyin.com/video/${id}` : ''
}

function emptyQueue() {
  return { items: [] }
}

/**
 * 读队列。
 *
 * 读失败 / JSON 损坏一律当成空队列 —— 这是**可以**这么处理的少数场景：
 * 队列丢了最坏结果是"这次不主动提"，不影响聊天、不影响记忆。
 * （黑话库那种丢了会损失学习成果的，才必须区分 ENOENT 和损坏。）
 */
export function loadQueue() {
  try {
    const j = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
    const items = Array.isArray(j?.items) ? j.items : []
    return { items: items.filter((x) => x && typeof x === 'object') }
  } catch {
    return emptyQueue()
  }
}

/** tmp + rename 原子替换：面板和采集端可能同时写，半截文件会让下次读成空队列 */
export function saveQueue(q) {
  const items = Array.isArray(q?.items) ? q.items.slice(0, QUEUE_MAX) : []
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true })
    const tmp = `${QUEUE_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, QUEUE_FILE)
  } catch {
    /* 写不进去就算了，下次再写 —— 不能因为队列写失败把采集接口带崩 */
  }
  return { items }
}

function normalizeEntry(raw, src, now) {
  const url = String(raw?.url || '')
  const id = videoIdOf(url) || clip(raw?.id, 32)
  return {
    id,
    title: clip(raw?.title, TITLE_MAX),
    author: clip(raw?.author, AUTHOR_MAX),
    url: shareUrlOf(url) || (url.startsWith('http') ? url : ''),
    src: src === 'ingest' ? 'ingest' : 'inbound',
    at: Number(raw?.at) || now,
    // 注入给她成功的那一刻。0 = 没注入过（busy 被跳过就是这种）
    injectedAt: 0,
    mentionedCount: 0,
    lastMentionAt: 0
  }
}

/**
 * 入队。
 *
 * 去重按视频 id：同一条视频被她刷到一次、他再发一次，只留一条，
 * 但**以他发的为准**（src 抬成 inbound）—— 那是明确指名给她的东西，优先级更高。
 */
export function enqueue(rawItems, src, now = Date.now()) {
  const list = Array.isArray(rawItems) ? rawItems : []
  const q = loadQueue()
  const byId = new Map(q.items.map((e) => [e.id, e]))
  let added = 0

  for (const raw of list) {
    const e = normalizeEntry(raw, src, now)
    if (!e.id) continue
    const old = byId.get(e.id)
    if (old) {
      // 已经被提过的不再复活，否则会出现"聊完了又冒出来"
      if (old.mentionedCount > 0) continue
      // 他用私信发过来的，比她自己刷到的更重要
      if (e.src === 'inbound') old.src = 'inbound'
      // 标题/作者补齐（她刷到的那次可能没读到标题）
      if (!old.title) old.title = e.title
      if (!old.author) old.author = e.author
      if (!old.url) old.url = e.url
      continue
    }
    byId.set(e.id, e)
    added++
  }

  if (!added) return { added: 0, total: q.items.length }
  // 新的排前面；超上限丢最旧的
  const merged = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, QUEUE_MAX)
  saveQueue({ items: merged })
  return { added, total: merged.length }
}

/** 注入成功时打一个时间戳 —— 「注入后他回过话」这条判据全靠它 */
export function markInjected(ids, now = Date.now()) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String))
  const q = loadQueue()
  let hit = 0
  for (const e of q.items) {
    if (!want.has(String(e.id))) continue
    e.injectedAt = now
    hit++
  }
  if (hit) saveQueue(q)
  return hit
}

/**
 * 清理：过期、聊过、提够次数的一律删掉。
 *
 * `repliedAt` 是「他在主号私聊里最后一次说话的时刻」。
 * inbound 条目只要 repliedAt > injectedAt 就判定为「注入之后他接话了」→ 已聊。
 * 这不是 100% 准（他可能只是回了句别的事），但偏置方向是对的：
 * 宁可漏掉一次主动提，也不要把已经聊过的事再翻出来。
 */
export function sweep(items, now = Date.now(), ctx = {}) {
  const repliedAt = Number(ctx.repliedAt) || 0
  return items.filter((e) => {
    const at = Number(e.at) || 0
    if (!at || now - at > TTL_MS) return false
    const mentioned = Number(e.mentionedCount) || 0
    if (mentioned >= MAX_MENTION) return false
    if (e.src === 'ingest' && mentioned >= 1) return false
    const injectedAt = Number(e.injectedAt) || 0
    if (e.src === 'inbound' && injectedAt > 0 && repliedAt > injectedAt) return false
    return true
  })
}

/** 当前还能拿来主动提的条目（新的在前） */
export function pending(now = Date.now(), ctx = {}) {
  const q = loadQueue()
  return sweep(q.items, now, ctx)
}

/** 记一次"她已经主动提过了" */
export function noteMention(id, now = Date.now()) {
  const q = loadQueue()
  const e = q.items.find((x) => String(x.id) === String(id))
  if (!e) return false
  e.mentionedCount = (Number(e.mentionedCount) || 0) + 1
  e.lastMentionAt = now
  saveQueue(q)
  return true
}

/** 面板「清空待聊」用 */
export function clearQueue() {
  saveQueue(emptyQueue())
  return { items: [] }
}

/** 给面板看的快照：不清理、不修改，只如实反映磁盘上有什么 */
export function snapshot(now = Date.now(), ctx = {}) {
  const q = loadQueue()
  const alive = new Set(sweep(q.items, now, ctx).map((e) => e.id))
  return {
    items: q.items.map((e) => ({
      id: e.id,
      title: e.title,
      author: e.author,
      url: e.url,
      src: e.src,
      at: e.at,
      ageMin: Math.max(0, Math.round((now - (Number(e.at) || now)) / 60_000)),
      injected: Number(e.injectedAt) > 0,
      mentionedCount: Number(e.mentionedCount) || 0,
      /** 这条现在还能不能被提（false 表示已被判为聊过 / 过期 / 提够了） */
      available: alive.has(e.id)
    }))
  }
}
