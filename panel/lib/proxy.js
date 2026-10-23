import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  loadConfig,
  saveConfig,
  writePersona,
  patchState,
  getState,
  whitelistVerdict,
  resolveProfile,
  profileBlock,
  moodLine,
  stickerEveryN,
  DATA_DIR
} from './store.js'
import { bumpStats, markUsed } from './stickers.js'
import { isLowValue, planPace } from './pacing.js'
import { campusState, addPlanItem, addExtraEvent, pickSlotForCampus, normalizeEventsPerDay } from './campus.js'
import { detectGoAway, detectWish } from './goaway.js'
import { requestHint } from './request.js'
import { assocLine } from './assoc.js'
import { opinionLine } from './opinion.js'
import { describeFaceSeg } from './faces.js'
import { transcribeAudio } from './multimodal.js'
import { stripSlangMarks, parseLearnReceipt, parseMeaningReceipt, loadSlang, buildSlangBlock } from './slang.js'

const BACKOFF_MIN = 1000
const BACKOFF_MAX = 15000

/**
 * 说说回执的解析：`[已发] 正文` / `[不发]`。
 *
 * 这两种行是「说说的旁白」，出现在聊天里会很出戏（你会收到一条「[已发] 今天下雨了」）。
 * 所以出站时先认一下，认出来就吞掉，并要求调用方回 ack。
 */
/**
 * 引用标记：模型用 `[[引用 2]]` 表示「我回的是合并里的第 2 条」。
 *
 * 为什么给个标记、而不是让它自己加 CQ 码：她不知道 message_id，也不该知道。
 * 序号是唯一的约定，代理层负责换成真正的 reply 段。
 * 只认回复最开头的标记 —— 正文里出现这个词不该被当成指令。
 *
 * 【2026-10-23】一条回复里她经常写**两个**标记（分别指向合并消息的不同条），
 * 比如「[[引用 2]]那你去忙 [[引用 1]]记得别马上躺」。段首那个能变成真引用，
 * 剩下那个以前会原样发给对方 —— 聊天里出现的「[[引用 1]]」字样就是这么来的。
 * 所以除了段首的指令，正文里所有标记都要剥掉（见 stripQuoteMarks）。
 */
const QUOTE_MARK_SRC = '\\[\\[\\s*引用\\s*(?:第\\s*)?(\\d{1,2})\\s*(?:条)?\\s*\\]\\]'

export function parseQuoteMark(text) {
  const m = new RegExp('^\\s*' + QUOTE_MARK_SRC + '\\s*').exec(String(text || ''))
  if (!m) return null
  return { n: Number(m[1]), rest: String(text || '').slice(m[0].length) }
}

/**
 * 删掉文本里所有引用标记（含正文中间的）。
 *
 * 为什么要单独一个函数：`parseQuoteMark` 只认段首，可模型不一定只写一个；
 * 漏掉的那个会直接出现在对方屏幕上。这里是「宁可少一个引用，也不能漏标记」的兜底。
 * 删除后把落下的连续空格压成一个，否则会变成「等你  🐘🐘」这种双空格。
 */
export function stripQuoteMarks(text) {
  const src = String(text || '')
  if (!src.includes('引用')) return { text: src, count: 0 }
  let count = 0
  const out = src.replace(new RegExp(QUOTE_MARK_SRC, 'g'), () => {
    count++
    return ''
  })
  if (!count) return { text: src, count: 0 }
  return {
    text: out.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, ''),
    count
  }
}

export function parseQzoneReceipt(plain) {
  const m = /^\s*\[(已发|不发)\]\s*([\s\S]*)$/.exec(String(plain || ''))
  if (!m) return null
  return { posted: m[1] === '已发', text: m[2].trim() }
}

/**
 * 对话状态评估的回执：`[[对话状态]] {"ended":..,"mood":".."}`（2026-10-23 新增）。
 *
 * proactive 沉默到阈值时注入内部评估任务，模型按约定回这一行；
 * 出站时解析出来交给 convStateHook（proactive 存进 state 调倍率），
 * 本体**绝不能发到聊天里** —— 否则用户会收到一行 JSON。
 * 解析不出 JSON 就返回 null，由调用方当没看见（宁可不追问，不误追）。
 */
export function parseConvState(plain) {
  const m = /^\s*\[\[\s*对话状态\s*\]\]\s*(\{[\s\S]*\})\s*$/.exec(String(plain || '').trim())
  if (!m) return null
  const MOODS = ['angry', 'sad', 'cold', 'normal', 'happy', 'excited']
  try {
    const j = JSON.parse(m[1])
    // mood 在最外层就校验枚举 —— 非法值出不了这个函数，任何消费方都拿不到脏数据
    return { ended: j.ended === true, mood: MOODS.includes(j.mood) ? j.mood : 'normal' }
  } catch {
    return null
  }
}

/** 秒数说成人话：「45 秒」/「6 分钟」 */
function fmtSpan(sec) {
  return sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`
}

/** 每个会话最后一条入站消息的账本，`qq-react` 从这儿取 message_id */
function lastMsgFile() {
  return path.join(loadConfig().paths.workspace, 'last-msg.json')
}

/**
 * 从待发出的 message 里取纯文字。
 * OneBot 的 message 可能是 CQ 码字符串，也可能是消息段数组；
 * 图片 / 语音 / 表情包没有"打字"过程，一律不计数。
 */
function outboundText(msg) {
  if (typeof msg === 'string') return msg.replace(/\[CQ:[^\]]*\]/g, '')
  if (Array.isArray(msg)) {
    return msg
      .filter((s) => s && s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
  }
  return ''
}

/**
 * 这一帧是不是 OneBot 的 meta_event（心跳 / 上下线 / 生命周期）。
 *
 * 只用来决定「断线时要不要塞进补投队列」：心跳 30 秒一条，断线几分钟就能把
 * 20 条的队列占满，把真正要投递的消息挤出去。解析失败一律当作普通帧，照旧排队。
 */
function isMetaEventPayload(payload) {
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '')
    if (!text.includes('"post_type"')) return false
    return JSON.parse(text).post_type === 'meta_event'
  } catch {
    return false
  }
}

/**
 * 判断一条文本是不是插件自动发的「管理性提示」，不是聊天内容。
 *
 * 插件在任务运行中收到新消息时，会发一条「⏳ 当前任务运行中，新消息已排队…」；
 * steer 模式下会发「✅ 已作为补充指令提交给当前任务…」。这类提示：
 * - 用词是系统口吻（「任务」「排队」「处理」「指令」），人不会这么说；
 * - 混在聊天里显得很机械，用户明确表示不希望出现。
 *
 * 判据是「同时命中一组关键词」，而不是单看某个词 ——
 * 免得误杀「我刚处理完作业」这种正常聊天。
 */
const NOTICE_PATTERNS = [
  /当前任务运行中/,
  /新消息已排队/,
  /将在当前任务结束后/,
  /作为补充指令提交给当前任务/,
  /模型将在下一步读取/
]

function looksLikeSystemNotice(text) {
  const t = text.replace(/\s+/g, '')
  // 模板提示都在 40 字以内，长回复一定不是
  if (t.length > 60) return false
  // 必须同时命中至少两个模式：单看某个词会误杀
  // （比如「模型将在下一步读取那句歌词」是正常聊天）
  return NOTICE_PATTERNS.filter((re) => re.test(t)).length >= 2
}

/**
 * 模型偶尔会把「自言自语」写进正文，比如「6 lines — slightly long」「Trim to 5」。
 * 它本来是用中文聊天的，所以**纯英文**加**规划类词**就基本可以判定是这类杂质。
 * 只要出现中文就放行，正常的中英混聊不受影响。
 */
function looksLikeMetaComment(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 80) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false
  return /(lines?\b|chars?\b|tokens?\b|trim\b|slightly|wording|rewrite|too long|too short)/i.test(t)
}

/* ---------------- 模型把「思考草稿」写进正文 ---------------- */

/**
 * 她会把写给自己看的推演一起塞进正文，真实记录（2026-10-22）：
 *
 *   I'm in class (14:00-15:40), hiding phone under desk. Reply briefly explaining.
 *   "在上课呢 偷偷回的 手机藏桌子底下" 2 lines.
 *   Respond lightly: 啊 我说反了吗 / 你先说清哪句
 *   Keep sh
 *
 * 这些被分条逻辑切成 3 条发了出去 —— 对方收到的是英文批注和碎片。
 * 根子在提示（「先自己想」），但提示管不住，所以出站前必须兜一层。
 */

// 写给自己看的指令词。命中它们 + 英文压过中文，才判草稿；
// 单看英文会误杀「这个 useEffect 得加依赖」这种正常聊技术。
const DRAFT_MARKERS =
  /\b(reply|respond|answer|keep|trim|draft|final|text|lines?|chars?|tokens?|short|concise|slightly|maybe|hmm|actually|he says|he means|she says|she means|go quiet)\b/i

// 行首的指令前缀：`Respond lightly:` / `Short.` / `Hmm,` …
// 只留英文指令词，`ok`「其实」这种中文里也常开头的词不能放进来
const DRAFT_PREFIX =
  /^\s*["'“”‘’]?\s*(?:reply|respond|answer|keep(?:\s+it)?|draft|final|text|short|concise|slightly|hmm|actually)\b[^。！？\n]{0,40}?[.:：!?—]\s*/i

function letterChars(t) {
  return {
    en: (String(t).match(/[A-Za-z]/g) || []).length,
    zh: (String(t).match(/[\u4e00-\u9fff]/g) || []).length
  }
}

/** 这一行是不是她写给自己看的（不该出现在聊天里） */
function isDraftLine(line) {
  const t = String(line || '').trim()
  if (!t) return false
  const { en, zh } = letterChars(t)
  // 整行英文：她是中文人设，不会整句英文说话。门槛 6 个字母，放行 ok / hhhh / emo。
  if (zh === 0 && en >= 6) return true
  // 中英混杂：英文明显占优、并且带指令词
  if (en >= 12 && en > zh * 1.2 && DRAFT_MARKERS.test(t)) return true
  return false
}

/** 把一行里的草稿碎片剥掉，留下能读的话 */
function cleanDraftLine(line) {
  const raw = String(line)
  const hasCount = /\b\d+\s*(?:lines?|chars?)\b/i.test(raw)
  const hasPrefix = DRAFT_PREFIX.test(raw)

  // 「有批注特征 + 带引号」→ 引号里那版是她定下的正文，引号外全是旁白。
  // 没有批注特征时不动，免得把「他问我"你吃了吗"」也改了。
  const quoted = /["“”]([^"“”]{2,})["“”]/.exec(raw)
  if (quoted && (hasCount || hasPrefix)) return quoted[1].trim()

  let t = raw.replace(/\b\d+\s*(?:lines?|chars?)\b\.?/gi, ' ')
  if (hasPrefix) t = t.replace(DRAFT_PREFIX, '')
  // 引号只在有草稿特征时才当杂质去掉；正常对话里的引号是她想强调的
  if (hasCount || hasPrefix) t = t.replace(/["“”]/g, '')
  return t.replace(/\s{2,}/g, ' ').trim()
}

/**
 * 整段清洗。返回 { text, changed, dropped }。
 *
 * 空行保留（段落感是分条的依据），只有真正被改/被丢的行才计数。
 */
export function stripDraftArtifacts(raw) {
  const src = String(raw || '')
  if (!src) return { text: '', changed: false, dropped: 0 }
  const out = []
  let dropped = 0
  for (const line of src.split('\n')) {
    // 必须先剥前缀再判断：
    // 「Respond lightly: 啊 我说反了吗」这种是「指令 + 正文」挤在一行，
    // 直接看原文会把英文占优判成草稿，连正文一起丢了。
    const cleaned = cleanDraftLine(line)
    if (isDraftLine(cleaned)) {
      dropped++
      continue
    }
    if (!cleaned.trim()) {
      if (line.trim()) dropped++
      else out.push('')
      continue
    }
    if (cleaned !== line.trim()) dropped++
    out.push(cleaned)
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, changed: dropped > 0, dropped }
}

function countTypedChars(msg) {
  const text = outboundText(msg).replace(/\s+/g, '')
  if (!text) return 0
  // 按码点计数，避免 emoji 被算成两个字符
  let n = 0
  for (const _ of text) n++
  return n
}

/**
 * 打字延迟 = 反应时间 + 字数 / 打字速度。
 * 结果会被 maxMs 截断，保证再长的回复也不会等太久（也远低于插件 30 秒的 action 超时）。
 */
function calcTypingDelay(chars, t) {
  const cps = Math.max(1, Number(t.cps) || 6)
  const base = Math.max(0, Number(t.baseMs) || 0)
  const maxMs = Math.max(0, Number(t.maxMs) || 0)
  let ms = base + (chars / cps) * 1000
  if (maxMs > 0) ms = Math.min(ms, maxMs)
  return Math.round(ms)
}

const FACE_RE = /\[face:(\d{1,3})\]/g

/**
 * 把回复文字里的 [face:14] 变成真正的 QQ 小黄脸。
 *
 * 为什么必须在出站改：插件发文本用的是 `[{type:'text',data:{text}}]` 这种结构化段，
 * NapCat 对结构化段里的 CQ 码/自定义标记**不会**做二次解析，直接当普通字符显示。
 * 只有把标记拆成独立的 `{type:'face',data:{id}}` 段，QQ 才会渲染成表情。
 */
function expandFaceMarks(raw) {
  let frame
  try {
    frame = JSON.parse(raw)
  } catch {
    return raw
  }
  const act = String(frame.action || '')
  if (!/^send_(msg|private_msg|group_msg)$/.test(act)) return raw
  const msg = frame.params?.message
  if (!Array.isArray(msg)) return raw

  let changed = false
  const out = []
  for (const seg of msg) {
    if (!seg || seg.type !== 'text') {
      out.push(seg)
      continue
    }
    const text = String(seg.data?.text ?? '')
    if (!text.includes('[face:')) {
      out.push(seg)
      continue
    }
    FACE_RE.lastIndex = 0
    let last = 0
    let touched = false
    let m
    while ((m = FACE_RE.exec(text))) {
      touched = true
      if (m.index > last) out.push({ type: 'text', data: { text: text.slice(last, m.index) } })
      out.push({ type: 'face', data: { id: m[1] } })
      last = m.index + m[0].length
    }
    if (!touched) {
      out.push(seg)
      continue
    }
    changed = true
    const tail = text.slice(last)
    if (tail) out.push({ type: 'text', data: { text: tail } })
  }
  if (!changed) return raw
  return JSON.stringify({ ...frame, params: { ...frame.params, message: out } })
}

/**
 * 把一段回复切成几条，像真人一句一句发。
 *
 * 几个必须守住的点：
 * 1. 只在**中文与中文之间**的空格断句 —— 英文单词之间的空格动了就会变成
 *    "That's6 lines" 这种乱码；
 * 2. 空格/标点只是分隔符，不出现在发出去的消息里（英文占多数的片段除外）；
 * 3. 句子拆太多会刷屏，超过 maxParts 就按字数均分回上限。
 */
function chunkReplyText(text, maxChars, maxParts) {
  const limit = Math.max(6, Math.min(200, Number(maxChars) || 30))
  const maxN = Math.max(1, Math.min(12, Number(maxParts) || 8))
  const src = String(text)
  const CJK = '\u4e00-\u9fff'

  // 三级拆：换行 → 句末标点/逗号 → 中文之间的空格
  // `(?!\d+\])` 是给 [face:27] 让路：冒号后面紧跟「数字+右括号」说明那是表情标记，
  // 不是句读，切了会变成「别急[face」+「27]」两条。
  // 换行的位置打一个硬断点：她换行就是想分两条说。
  // 旧实现把每一行切碎后全塞进一个数组，行边界就没了 —— 于是「嗯 我加油」和
  // 「你也别老盯着手机等我了」会被按目标长度合并回一条，看着像不分段。
  const HARD = '\u0001'
  const rawPieces = []
  for (const line of src.split(/\n+/)) {
    for (const seg of line.split(/(?<=[。！？!?～…，,、；;：:])(?!\d+\])\s*/)) {
      for (const piece of seg.split(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`))) {
        rawPieces.push(piece)
      }
    }
    rawPieces.push(HARD)
  }

  const clean = (s) => {
    // 先剥掉模型爱加的列表序号：1. / 1、/ ①/ - / •
    // 不剥的话「1.欸 你现在上课了吧」这种会原样发到聊天里，一眼就是机器生成的
    let t0 = s
      .trim()
      .replace(/^(?:\d{1,2}\s*[.、．)）](?!\d)|[\u2460-\u2473]|[-*•]\s+)\s*/, '')
      // 句中夹的圈号（①②③）也去掉，它们几乎只会是列表标记
      .replace(/[\u2460-\u2473]\s*/g, '')
    const t = t0.trim()
    if (!t) return ''
    // 字母/数字占多数的片段保留单个空格（英文单词、数字列表），纯中文的删干净
    const alnum = (t.match(/[A-Za-z0-9]/g) || []).length
    const keepSpace = alnum / (countTypedChars(t) || 1) > 0.4
    const spaced = keepSpace ? t.replace(/\s+/g, ' ') : t.replace(/\s+/g, '')
    return spaced.replace(/[。，,、；;：:]+$/g, '').trim()
  }

  const pieces = rawPieces
    .map((s) => (s === HARD ? HARD : clean(s)))
    .filter((s) => s === HARD || (s && !/^[。！？!?～…、，,.;；:：]+$/.test(s)))

  /**
   * 先把碎片攒成「差不多一条消息那么长」的段，再决定切成几条。
   *
   * 老实现是**每个句末标点单独成条**：模型写 8 个短句 → 正好 8 条，条条顶格，
   * 看着像连发器而不是人说话。现在按目标长度合并，条数由内容长短自然决定：
   * 短短一句就 1-2 条，长回复才会多几条。目标长度每次随机（0.6~1.05 × 单条上限），
   * 所以同样长度的回复，条数也不是死的。
   */
  const targetLen = Math.max(10, Math.round(limit * (0.6 + Math.random() * 0.45)))
  const parts = []
  let cur = ''
  const flush = () => {
    if (cur) {
      parts.push(cur)
      cur = ''
    }
  }
  for (const piece of pieces) {
    // 碰到换行就收尾，不跟下一行合并
    if (piece === HARD) {
      flush()
      continue
    }
    const n = countTypedChars(piece)
    if (n === 0) continue
    if (n > limit) {
      // 超长片：先收尾，再硬切（模型没给分隔符时的兜底）
      flush()
      let rest = piece
      while (countTypedChars(rest) > limit) {
        const arr = [...rest]
        parts.push(arr.slice(0, limit).join('').trim())
        rest = arr.slice(limit).join('')
      }
      cur = rest.trim()
      continue
    }
    const curN = countTypedChars(cur)
    if (!cur) cur = piece
    // 还能塞就塞；不足 8 个字的段也留着继续接，避免「行」「嗯」这种单独一条
    else if (curN + n <= targetLen || curN < 8) cur += piece
    else {
      flush()
      cur = piece
    }
  }
  flush()

  // 条数超上限：合并**最短的相邻两条**。
  // 相邻两条本来就是连着说的一句话，拼回去还是原句；
  // 绝对不能按字数均分 —— 那会把「干脆放弃」切成「就干」+「脆放弃」。
  // 条数超上限：合并最短的相邻两条。允许的长度会逐步放宽 ——
  // maxChars 和 maxParts 有时候没法同时满足（20 字上限 + 最多 4 条，120 字就必须破一个），
  // 这里选择守 maxParts：宁可某一条略长，也别一次刷出 5-6 个气泡。
  let allow = Math.round(limit * 1.6)
  while (parts.length > maxN) {
    let bestI = -1
    let bestLen = Infinity
    for (let i = 0; i < parts.length - 1; i++) {
      const merged = countTypedChars(parts[i]) + countTypedChars(parts[i + 1])
      if (merged <= allow && merged < bestLen) {
        bestLen = merged
        bestI = i
      }
    }
    if (bestI < 0) {
      if (allow >= limit * 5) break
      allow = Math.round(allow * 1.3)
      continue
    }
    parts.splice(bestI, 2, parts[bestI] + parts[bestI + 1])
  }
  return parts
}

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function inWindow(from, to, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes()
  const parse = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }
  const a = parse(from)
  const b = parse(to)
  if (a === null || b === null) return false
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

class Proxy {
  constructor(logger) {
    this.log = logger || (() => {})
    this.wss = null
    this.upstream = null
    this.napcatSock = null
    this.backoff = BACKOFF_MIN
    this.retryTimer = null
    this.closed = false
    this.stats = { inbound: 0, forwarded: 0, dropped: 0, outbound: 0, reconnects: 0 }
    this.lastEvent = null
    this.connectedAt = null
    this.pending = new Map()
    this.lastUserAt = 0
    this.nextAt = 0
    this.timers = new Set()
    // 连发合并：同一会话在 1 秒内收到的多条消息先攒着，合成一条再交给模型，
    // 这样它才能判断这几句是不是一件事，而不是一句一句地回。
    this.inbox = new Map()
    // 节奏状态：每个会话上一次交给模型的时刻、连着跳过几条。
    // 「正在聊」要快、「刚发的消息」可以慢，全靠这里判断。
    this.pace = new Map()
    // 每个会话「最后一条消息的计划发送时刻」。
    // 补发链是链式的（发完第 1 条才安排第 2 条），所以**同一轮内部本来就有序**；
    // 但跨轮次没有排队 —— 上一轮还剩两条没发完，新一轮的首条会直接插进去，
    // 用户看到的就是「几条语义不同的回答混在一起、顺序不对」。
    // 这里记一个水位线，新一轮必须排在它后面。
    // outAt：这个会话「下一条消息最早什么时候发」（链式顺序用）
    // outUntil：这个会话「这一整轮预计什么时候发完」（挡住新一轮用）
    // 两者分开的原因：一条消息的时刻是点，一整轮是段。只用点挡不住后续几条。
    this.outAt = new Map()
    this.outUntil = new Map()
    // 每个会话「对方最后一次说话」的时刻。主动消息用它判断「你多久没理我」，
    // 不能用全局的 lastUserAt —— 访客说一句话就把发给主号的消息压掉了。
    this.chatLastAt = new Map()
    // 最近一次「合并交给模型」的那批消息 id。
    // 模型用 [[引用 N]] 说要回第几条时，这里按序号查真正的 message_id。
    this.quoteMap = new Map()
    // 白名单相关：不在名单里的人也记下来，方便在面板上一键拉进来
    this.unknown = new Map()
    this.contacts = new Map()
    // 最近一轮分条的指纹，用来整条判重（见 sameReplyAsLast）
    this.lastSplit = new Map()
    this.flushTimer = null
    // 上游探活（见 checkUpstream）：定时器 / 握手起始时刻 / 连续没回 pong 的次数
    this.healthTimer = null
    this.connectAt = 0
    this.missedPings = 0
  }

  /* ---------------- 访客记录 ---------------- */

  rememberContact(frame) {
    const qq = String(frame.user_id || '')
    if (!qq) return
    const c = this.contacts.get(qq) || { qq, count: 0 }
    c.count = (c.count || 0) + 1
    c.lastAt = Date.now()
    const nick = frame.sender?.card || frame.sender?.nickname
    if (nick) c.name = String(nick).slice(0, 24)
    this.contacts.set(qq, c)
    this.scheduleFlush()
  }

  rememberBlocked(frame, reason) {
    const qq = String(frame.user_id || '')
    if (!qq) return
    const b = this.unknown.get(qq) || { qq, count: 0, firstAt: Date.now() }
    b.count = (b.count || 0) + 1
    b.lastAt = Date.now()
    b.reason = reason
    const nick = frame.sender?.card || frame.sender?.nickname
    if (nick) b.name = String(nick).slice(0, 24)
    const txt = String(frame.raw_message || '')
      .replace(/\[CQ:[^\]]*\]/g, '[媒体]')
      .replace(/\s+/g, ' ')
      .trim()
    if (txt) b.lastText = txt.slice(0, 60)
    this.unknown.set(qq, b)
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      patchState({ blocked: this.blockedList(), contacts: this.contactMap() })
    }, 5000)
  }

  blockedList() {
    return [...this.unknown.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 60)
  }

  contactMap() {
    const out = {}
    for (const [qq, v] of this.contacts) out[qq] = v
    return out
  }

  forgetBlocked(qq) {
    if (this.unknown.delete(String(qq))) patchState({ blocked: this.blockedList() })
  }

  clearBlocked() {
    this.unknown.clear()
    patchState({ blocked: [], contacts: this.contactMap() })
  }

  loadVisitors() {
    if (this.visitorsLoaded) return
    this.visitorsLoaded = true
    const st = getState()
    for (const b of st.blocked || []) if (b && b.qq) this.unknown.set(String(b.qq), b)
    for (const [qq, c] of Object.entries(st.contacts || {})) if (qq) this.contacts.set(qq, c)
  }

  /**
   * 主动调用 NapCat 的 OneBot API。
   * 复用 NapCat 反连上来的那条 WebSocket，不需要额外开 HTTP 端口，
   * 也就不需要重启容器（重启会丢 QQ 登录态）。
   */
  sendAction(action, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const sock = this.napcatSock
      if (!sock || sock.readyState !== WebSocket.OPEN) {
        reject(new Error('NapCat 未连接'))
        return
      }
      const echo = `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`action ${action} 超时`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        sock.send(JSON.stringify({ action, params, echo }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(e)
      }
    })
  }

  /* ---------------- 出站：模拟真人打字速度 ---------------- */

  toNapcat(data, isBinary) {
    if (this.napcatSock && this.napcatSock.readyState === WebSocket.OPEN) {
      try {
        // 撤回类动作单独留痕。
        // 平时不记所有出站动作（太吵，一条回复拆四段就是四行），
        // 但「消息被撤回」是能直接看到的现象，出事必须查得到是谁发的。
        // 之前排查撤回时发现日志里一条都没有 —— 不是没发生，是根本没记。
        if (!isBinary && data && data.length < 8192) {
          const s = data.toString('utf8')
          if (s.includes('delete_msg') || s.includes('"recall"')) {
            this.log(`出站撤回动作：${s.slice(0, 200)}`)
          }
        }
        this.napcatSock.send(data, { binary: isBinary })
      } catch (e) {
        this.log(`回传 NapCat 失败: ${e.message}`)
      }
    }
  }

  /** 原来挂在出站回调里的副作用：顺手记下 bot 的 QQ 号。延迟分支也要执行。 */
  tailPatch(raw) {
    if (!raw || raw.length >= 4096) return
    try {
      const f = JSON.parse(raw)
      if (f.post_type === 'meta_event' && f.self_id) {
        patchState({ botQQ: String(f.self_id), botOnline: true })
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 按「这条回复有多少字」算出该等多久再发出去，模拟真人打字。
   *
   * 只认 send_msg / send_private_msg / send_group_msg，且必须含文字：
   * 纯图片、语音、表情包没有打字过程，不延迟。
   * 其他 action（取好友列表、撤回、查询）必须立刻转发，否则会让调用方超时。
   */
  typingDelayFor(raw) {
    if (!raw || raw.length > 200 * 1024) return 0

    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return 0
    }
    const act = String(frame.action || '')
    if (!/^send_(msg|private_msg|group_msg)$/.test(act)) return 0

    const t = this.cfgFor(this.chatUserOf(frame)).typing || {}
    if (t.enabled === false) return 0

    const chars = countTypedChars(frame.params?.message)
    if (chars <= 0) return 0

    const ms = calcTypingDelay(chars, t)
    if (ms > 0) this.log(`按打字速度等待 ${(ms / 1000).toFixed(1)} 秒（${chars} 字）再发出`)
    return ms
  }

  /**
   * 判断这条出站消息要不要拆条。纯文本才会拆；
   * 带图片/语音/表情的消息段结构复杂，拆了会错位。
   */
  /**
   * 挡住插件自带的管理性提示（「⏳ 当前任务运行中，新消息已排队…」这类）。
   *
   * 这些是插件在「忙的时候收到新消息」时自动发到聊天里的，语气像系统通知，
   * 混在日常对话里很出戏。插件把文案写死在 bridge.js 里，没有开关，
   * 所以只能在我们这层截掉。
   *
   * 关键：拦下来之后必须**自己造一个成功响应**回给 dsh，
   * 否则插件那边 `await ctx.call()` 会一直等到 30 秒超时。
   */
  systemNoticePlan(rawText) {
    const cfg = loadConfig()
    if (cfg.reply?.hideSystemNotice === false) return null

    let frame
    try {
      frame = JSON.parse(rawText)
    } catch {
      return null
    }
    const act = String(frame.action || '')
    if (!/^send_(msg|private_msg|group_msg)$/.test(act)) return null

    const segs = frame.params?.message
    if (!Array.isArray(segs) || !segs.length) return null

    const text = segs
      .filter((s) => s && s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
      .trim()
    if (!text) return null
    if (!looksLikeSystemNotice(text)) return null

    return { frame, text }
  }

  splitPlan(rawText) {
    let frame
    try {
      frame = JSON.parse(rawText)
    } catch {
      return null
    }
    const act = String(frame.action || '')
    if (!/^send_(msg|private_msg|group_msg)$/.test(act)) return null

    // 分条策略也按人：给访客关掉分条、给主号开着，互不影响
    const sp = this.cfgFor(this.chatUserOf(frame)).reply?.split || {}
    if (sp.enabled === false) return null

    const segs = frame.params?.message
    if (!Array.isArray(segs) || !segs.length) return null

    // 表情段可以跟着走（挂到最后一条末尾），引用段只在第一条，
    // 图片/语音/文件不行 —— 段结构拆了会错位。
    if (segs.some((s) => s && s.type !== 'text' && s.type !== 'face' && s.type !== 'reply')) return null
    const tailSegs = segs.filter((s) => s && s.type === 'face')
    // 引用段单独拎出来：分条时只有第一条带引用，后面几条都是纯文字。
    // 不拎出来的话，「带引用」会被上面的类型判断直接判成不可分条 —— 引用和分条打架。
    const quoteSegs = segs.filter((s) => s && s.type === 'reply')

    const text = segs
      .filter((s) => s && s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
    // 拆条阈值。字段从 maxChars 改名成 threshold —— 原来它和「人格·回复字数上限」
    // 都叫 maxChars，配置里两个同名字段含义完全不同（一个 30 一个 120），非常容易改错。
    // 旧字段仍然认，老配置不用动。
    const threshold = Number(sp.threshold ?? sp.maxChars ?? 30)
    let parts = chunkReplyText(text, threshold, sp.maxParts)
    if (!parts.length) return null

    // 丢掉模型混进正文的英文自述（「6 lines — slightly long」这类）
    const kept = parts.filter((p) => !looksLikeMetaComment(p))
    if (kept.length && kept.length < parts.length) {
      this.log(`丢掉 ${parts.length - kept.length} 条模型自述`)
      parts = kept
    }
    // 只有一条、且内容和原文一致（没有可拆也没用空格），就不用动
    if (parts.length === 1 && parts[0] === text) return null

    const lead = Math.max(200, Number(sp.gapMs) || 700)
    if (parts.length > 1) {
      const warn = parts.length > Number(sp.maxParts) ? `（超过建议的 ${sp.maxParts} 条）` : ''
      this.log(`回复拆成 ${parts.length} 条逐条发（首条 ${countTypedChars(parts[0])} 字）${warn}`)
      return { frame, parts, tailSegs, quoteSegs, gapMs: lead }
    }
    // 拆不开但原本带空格：至少把空格清掉再发
    this.log('回复里的空格已清理')
    return { frame, parts, tailSegs, quoteSegs, gapMs: lead }
  }

  /** 首条发出去之后，按节奏把剩下的补齐。后续帧去掉 echo，免得 dsh 收到陌生响应。 */
  /**
   * 出站统一调度：保证同一个会话的消息**按顺序**发出去。
   *
   * @param {string} key    会话 key
   * @param {Buffer} payload 要发的帧
   * @param {number} delay  想等多久（打字延迟 / 起手停顿）
   * @param {number} gapMs  和上一条之间至少隔多久
   * @returns {number} 实际等待毫秒数
   *
   * 规则：实际发送时刻 = max(现在 + delay, 上一条的计划时刻 + gapMs)。
   * 也就是说 delay 只是「希望」，顺序是硬的 —— 宁可晚一点，也不插队。
   */
  scheduleOut(key, payload, delay, gapMs = 0) {
    const now = Date.now()
    // 取「上一条的时刻」和「整轮预计结束」里更晚的那个 —— 后者才能挡住
    // 「上一轮还剩几条没发完」的情况。
    const prev = Math.max(this.outAt.get(key) || 0, this.outUntil.get(key) || 0)
    // 只有「前面排过东西」才谈间隔。否则一条回复的第一句会白等一个 gap。
    const floor = prev > 0 ? prev + Math.max(0, gapMs) : 0
    // 排队上限：上一轮话特别多时不能把新问题拖太久。
    // 超过 15 秒就只等到 15 秒（这时候宁可轻微交错，也不能让用户等半分钟）。
    const MAX_WAIT = 15_000
    let at = Math.max(now + Math.max(0, delay), floor)
    if (at - now > MAX_WAIT) at = now + MAX_WAIT
    this.outAt.set(key, at)
    this.outUntil.set(key, Math.max(this.outUntil.get(key) || 0, at))
    const wait = Math.max(0, at - now)
    if (wait > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.toNapcat(payload, false)
      }, wait)
      this.timers.add(timer)
    } else {
      this.toNapcat(payload, false)
    }
    return wait
  }

  /**
   * 把一整轮拆条**一次性**排进发送队列。
   *
   * 【为什么必须一次排完，而不是「发完第 1 条再排第 2 条」】
   * 老实现是链式的：第 2 条发完才去排第 3 条。于是出现这个 bug ——
   * 排第 3 条时，新一轮回答已经把水位线（outAt）占到了后面，
   * 第 3 条就按「上一条之后」算，被推到新一轮后面。
   * 用户看到的就是：甲一、甲二、乙一、乙二、甲三 —— 上一轮的最后一句跑到最后。
   *
   * 一次性排完，这一轮就是一个不可分割的时间段：只要算出起点，后面每条
   * 都是「上一条 + 间隔」，新一轮只能在整轮结束之后开始。
   *
   * @param {object} plan        splitPlan 的结果
   * @param {number} firstDelay  第一条要等多久（打字延迟）
   */
  scheduleRound(plan, firstDelay) {
    const { frame, parts } = plan
    const qkey = this.outKey(frame)
    const cfg = this.cfgFor(this.chatUserOf(frame))
    const t = cfg.typing || {}
    const typingOn = t.enabled !== false
    const pause = Math.max(200, Number(plan.gapMs) || 1200)
    const capMs = Math.max(3000, (Number(t.maxMs) || 12000) + 3000)

    // 起点 = 这个会话里已经排到的最后时刻（可能是上一轮的结尾）。
    // 如果确实接在上一轮后面，多留一个换气停顿 —— 换话头跟同一条里接着往下说
    // 是不一样的，后者 200ms 就够，前者得像「说完上一件事、想了一下」。
    const ROUND_GAP = 400
    const prevAt = this.outAt.get(qkey) || 0
    let base = prevAt > Date.now() ? prevAt + ROUND_GAP : Date.now()
    const slots = []
    for (let i = 0; i < parts.length; i++) {
      let delay
      if (i === 0) {
        delay = Math.max(0, Number(firstDelay) || 0)
      } else {
        const chars = countTypedChars(parts[i])
        const typing = typingOn ? calcTypingDelay(chars, t) : 0
        // 只往上浮动：人累了会慢，但不会比自己的手速还快
        const jitter = 1 + Math.random() * 0.35
        delay = Math.min(Math.round(pause + typing * jitter), capMs)
      }
      base += delay
      slots.push(base)
    }

    const end = slots[slots.length - 1]
    const now0 = Date.now()
    // 整轮太靠后就不硬排（避免上一轮话多把新问题拖到半分钟）
    if (end - now0 > 15_000) {
      const shift = end - now0 - 15_000
      for (let i = 0; i < slots.length; i++) slots[i] -= shift
    }
    this.outAt.set(qkey, Math.max(this.outAt.get(qkey) || 0, slots[slots.length - 1]))
    this.outUntil.set(qkey, Math.max(this.outUntil.get(qkey) || 0, slots[slots.length - 1]))

    const n = parts.length
    this.log(
      `本轮 ${n} 条，排在 ${(Math.max(0, slots[0] - Date.now()) / 1000).toFixed(1)}~` +
        `${(Math.max(0, slots[n - 1] - Date.now()) / 1000).toFixed(1)} 秒之间`
    )

    for (let i = 0; i < n; i++) {
      const wait = Math.max(0, slots[i] - Date.now())
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.firePart(plan, i)
      }, wait)
      this.timers.add(timer)
    }
  }

  /** 发一轮拆条里的第 i 条（判重、引用段、尾巴表情都在这里处理） */
  firePart(plan, i) {
    const { frame, parts } = plan
    const msg = [{ type: 'text', data: { text: parts[i] } }]
    // 引用段只能挂在第一条（QQ 只认消息开头的 reply 段）
    if (i === 0 && plan.quoteSegs?.length) msg.unshift(...plan.quoteSegs)
    if (i === parts.length - 1 && plan.tailSegs?.length) msg.push(...plan.tailSegs)

    const { echo, ...rest } = frame
    const out = i === 0
      ? { ...frame, params: { ...frame.params, message: msg } }
      : { ...rest, params: { ...frame.params, message: msg } }
    const partText = String(parts[i] || '')

    // 首条不在这里判重：调用方（出站那段）已经拿它判过一次了，
    // 而 isDuplicate 是「检查并记录」语义 —— 第二次调用必然命中刚记下的那条，
    // 于是首条被自己挡掉（之前的表现就是「每条回复的第一句都不见了」）。
    const needCheck = i > 0 && countTypedChars(partText) >= 6
    if (needCheck && this.isDuplicate(frame, partText, 90 * 1000)) {
      this.log(`丢弃重复分条：${partText.slice(0, 20)}…`)
    } else {
      try {
        this.toNapcat(Buffer.from(JSON.stringify(out), 'utf8'), false)
      } catch (e) {
        this.log(`第 ${i + 1} 条发送失败: ${e.message}`)
      }
    }

    // 整轮发完再看一眼要不要补个表情
    if (i === parts.length - 1) this.armAutoSticker(frame, 1500)
  }

  /** NapCat side: we are the server */
  start() {
    const cfg = loadConfig()
    this.cfg = cfg
    this.closed = false
    this.startedAt = Date.now()
    this.loadVisitors()
    // 把「刚才还在聊」的时间戳读回来。不读的话每次重启都会把正在进行的对话
    // 当成「很久没聊」，然后按随机节奏拖几分钟 —— 用户体感就是「我说话她不回」。
    this.restorePace()
    this.stopServer()
    const port = cfg.proxy.port
    this.wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/ws', maxPayload: 64 * 1024 * 1024 })

    this.wss.on('listening', () => this.log(`代理已监听 ws://127.0.0.1:${port}/ws`))
    this.wss.on('error', (e) => this.log(`代理监听错误: ${e.message}`))

    this.wss.on('connection', (sock, req) => {
      if (!this.checkToken(req)) {
        this.log('拒绝连接: token 不匹配')
        try {
          sock.close(4003, 'invalid token')
        } catch {
          /* ignore */
        }
        return
      }
      this.log('NapCat 已接入代理')
      this.napcatSock = sock
      patchState({ napcatConnected: true, napcatSince: Date.now() })
      this.ensureUpstream()

      sock.on('message', (data, isBinary) => {
        if (isBinary) {
          this.forwardUp(data, isBinary)
          return
        }
        const text = data.toString()
        let frame
        try {
          frame = JSON.parse(text)
        } catch {
          this.forwardUp(text, false)
          return
        }

        // 面板自己发出去的 API 请求的响应，不能转给 dsh（否则它收到无法识别的帧）
        if (frame.echo && this.pending.has(frame.echo)) {
          const p = this.pending.get(frame.echo)
          this.pending.delete(frame.echo)
          clearTimeout(p.timer)
          const ok = frame.status === 'ok' || frame.retcode === 0
          if (ok) p.resolve(frame.data === undefined ? frame : frame.data)
          else p.reject(new Error(frame.message || frame.wording || `retcode ${frame.retcode}`))
          return
        }

        // dsh 发出去的 action 的响应（带 echo、没有 post_type）：必须立即原样上送。
        // 绝不能进 decide/queueMessage —— 那会把它当聊天消息缓冲合并，
        // 几条响应挤进同一个桶被拼成一段 JSON，dsh 就匹配不上 echo，30 秒后报超时。
        if (frame.echo !== undefined && frame.post_type === undefined) {
          this.forwardUp(text, false)
          return
        }

        // 事件类（心跳 / 上下线 / 撤回 / 加好友请求）只透传给 dsh，绝不进聊天管道。
        //
        // 这是个存量 bug：以前它们和聊天消息走同一条路，被 queueMessage 当成用户发言
        // 攒起来交给模型。OneBot 的心跳默认 30 秒一次，所以模型每半分钟就被喂一段
        // status JSON —— 白烧 token，还可能顺着这段 JSON 说出莫名其妙的话。
        // 定位方法：日志里每 30 秒一条「按回复节奏等待」，但入站消息计数是 0。
        if (frame.post_type !== 'message') {
          this.forwardUp(text, false)
          return
        }

        this.stats.inbound++
        if (frame.post_type === 'message') {
          this.lastUserAt = Date.now()
          this.chatLastAt.set(this.chatKey(frame), Date.now())
          // 每条入站都记一行：出问题时能一眼看出「谁在发消息、发了什么」。
          // 之前没有这行，查一次「定时收到消息却找不到来源」花了半小时。
          {
            const segs0 = Array.isArray(frame.message) ? frame.message : []
            const pv = segs0
              .filter((s) => s && s.type === 'text')
              .map((s) => String(s.data?.text || ''))
              .join('')
              .slice(0, 30)
            const who = frame.message_type === 'group' ? `群 ${frame.group_id}` : `私聊 ${frame.user_id}`
            this.log(`收到 ${who}${frame.message_id ? '' : '（无 message_id）'}：${pv || '[非文字]'}`)
          }
          // 有图片 / 表情的消息也算「对方发了一张」，自适应频率要用到
          this.rememberMessage(frame)
          // 主动消息靠这个统计「你平时几点在线」，用来调整开口时机
          if (this.userActivityHook) {
            try {
              this.userActivityHook(frame)
            } catch {
              /* 统计失败不能影响收消息 */
            }
          }
        }
        if (frame.post_type === 'meta_event' && frame.self_id) {
          patchState({ botQQ: String(frame.self_id), botOnline: true })
        }
        const verdict = this.decide(frame)
        if (!verdict.pass) {
          this.stats.dropped++
          this.bumpDropped()
          if (this.stats.dropped % 20 === 1) this.log(`跳过消息: ${verdict.reason}`)
          return
        }
        this.stats.forwarded++
        this.lastEvent = Date.now()
        this.queueMessage(text, frame)
      })

      sock.on('close', () => {
        this.log('NapCat 断开代理')
        this.napcatSock = null
        patchState({ napcatConnected: false })
      })
      sock.on('error', (e) => this.log(`NapCat 连接错误: ${e.message}`))
    })

    this.ensureUpstream()
    // 上游探活闹钟：close 事件可能永远不来（见 checkUpstream 的注释），
    // 必须有独立的定时器兜底，否则一次异常就能让代理「假在线」到下次重启。
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => {
      try {
        this.checkUpstream()
      } catch (e) {
        this.log(`上游健康检查出错: ${e.message}`)
      }
    }, 20000)
  }

  /**
   * 对方发的是不是表情包：NapCat 会给贴纸打 summary（如「[动画表情]」），
   * 商城表情是 mface 类型。普通照片不带这些标记，不统计。
   */
  countIncomingSticker(frame) {
    try {
      const segs = Array.isArray(frame?.message) ? frame.message : []
      const isSticker = segs.some(
        (s) => (s?.type === 'image' && /\[.+表情/.test(String(s?.data?.summary || ''))) || s?.type === 'mface'
      )
      if (isSticker) bumpStats('incoming')
    } catch {
      /* 统计失败不该影响聊天 */
    }
  }

  /**
   * 数一数「这条回复该配图了吗」。
   *
   * 频率是面板上的 0-100，换算成「大约每 N 条一次」。每来一条入站就 +1，
   * 到点就在消息前塞一句提醒。计数**只在真的发出表情后清零**，
   * 所以跳过几次也不会漏掉下一次机会；超过 3 倍还没发就当作它这会儿不想发，归零重来。
   */
  /** 读表情库索引（按 mtime 缓存，存图/删图后自动重建） */
  stickerIndex(dir) {
    try {
      const f = path.join(dir, 'index.json')
      const st = fs.statSync(f)
      if (this.idxCache && this.idxCache.dir === dir && this.idxCache.at === st.mtimeMs) return this.idxCache.data
      const data = JSON.parse(fs.readFileSync(f, 'utf8'))
      this.idxCache = { dir, at: st.mtimeMs, data }
      return data
    } catch {
      return {}
    }
  }

  /**
   * 替它挑几张候选。
   *
   * 光说「该配图了」它还是懒得去列库挑 —— 增加一步它就少发一次。
   * 这里直接用**当前这句话**跟标签做粗匹配，把 2-3 张候选连同完整路径递到手里，
   * 它只要选一个、发出去。
   */
  /**
   * 极简 BM25（中文按字符二元组切，不依赖分词库）。
   *
   * 为什么需要：以前是「消息里是否包含某个标签」的硬匹配 —— 标签写「疲惫」、对方说「好累」，
   * 就完全对不上，候选全靠新鲜度随机。BM25 至少能吃到部分字面重叠，纯 JS 几十行，13 张图毫无压力。
   */
  bm25Rank(docs, query) {
    const tok = (str) => {
      const s = String(str || '').toLowerCase().replace(/[\s\p{P}]+/gu, '')
      const out = []
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
      return out
    }
    const qTerms = [...new Set(tok(query))]
    if (!qTerms.length || !docs.length) return docs.map(() => 0)

    const tokenized = docs.map((d) => tok(d.text))
    const avgdl = tokenized.reduce((n, t) => n + t.length, 0) / tokenized.length || 1
    const k1 = 1.2
    const b = 0.75
    const df = {}
    for (const t of qTerms) df[t] = tokenized.filter((tk) => tk.includes(t)).length
    const N = docs.length
    const out = []
    for (const tk of tokenized) {
      let score = 0
      for (const term of qTerms) {
        const tf = tk.filter((x) => x === term).length
        if (!tf) continue
        const idf = Math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tk.length) / avgdl)))
      }
      out.push(score)
    }
    return out
  }

  /**
   * 口语 → 标签的同义扩展。
   * 标签是「生气」，对方说「气死我了 / 烦死 / 火大」，纯字面匹配一个都对不上。
   * 这张小表就是补这一段，比上 embedding 便宜得多。
   */
  expandEmotion(text) {
    // 注意：这里扩展出来的必须是**库里真实存在的标签**。
    // 上一版扩展到「疲惫」这种规范情绪词，库里根本没有这个标签，等于白扩。
    const IMPLY = {
      摆烂: ['好累', '累死', '没力气', '不想动', '躺平', '懒', '不想干'],
      无奈: ['算了', '没辙', '没办法', '又这样', '唉'],
      大哭: ['想哭', '哭了', '难过', '委屈', '伤心', '呜呜'],
      生气: ['气死', '生气', '火大', '烦死', '不爽', '恼火'],
      欠揍: ['欠揍', '讨打', '烦人', '找骂'],
      得意: ['厉害', '牛逼', '牛啊', '赢了', '考过', '过线', '我做到了'],
      微笑: ['开心', '高兴', '嘿嘿', '哈哈', '笑死', '好耶'],
      无语: ['无语', '服了', '离谱', '绝了', '什么鬼'],
      慌张: ['慌', '紧张', '来不及', '急死'],
      吵嘴: ['吵', '顶嘴', '抬杠', '你才'],
      抱怨: ['抱怨', '吐槽', '每次都', '又来了']
    }
    const hay = String(text || '')
    const extra = []
    for (const [tag, words] of Object.entries(IMPLY)) {
      if (words.some((w) => hay.includes(w))) extra.push(tag)
    }
    return hay + (extra.length ? ' ' + extra.join(' ') : '')
  }

  stickerCandidates(dir, text, k = 3) {
    const idx = this.stickerIndex(dir)
    const names = Object.keys(idx)
    if (!names.length) return []
    const hay = String(text || '')
    const now = Date.now()
    const docs = names.map((n) => {
      const meta = idx[n] || {}
      const tags = Array.isArray(meta.tags) ? meta.tags : []
      return { n, text: [n, ...tags, meta.desc || ''].join(' '), tags, meta }
    })
    const bm = this.bm25Rank(docs, this.expandEmotion(hay))
    const bmMax = Math.max(1e-6, ...bm)
    const scored = docs.map((d, i) => {
      const tags = d.tags
      // 标签命中给硬加分（比 BM25 更可信）；BM25 负责同义/部分重叠的软匹配
      let score = 0
      for (const t of tags) if (t && hay.includes(String(t))) score += 3
      // BM25 归一化到 0-2：标签命中永远比字面重叠更可信
      score += (bm[i] / bmMax) * 2
      const last = Number(d.meta.lastUsed || 0)
      const fresh = last ? Math.min(3, (now - last) / 3600000) : 4
      // 最近发过的按比例打折，而不是直接扣分 ——
      // 扣分会把「内容最贴但刚发过」的那张压到 0，反而选出完全不搭的
      if (last && now - last < 2 * 3600000) score *= 0.4
      return { n: d.n, score, fresh, tags }
    })
    scored.sort((a, b) => b.score - a.score || b.fresh - a.fresh)
    return scored.slice(0, k)
  }

  /**
   * 真发一张（兜底用）。
   *
   * 模型有时候看了催促还是不发。那就由代理层替它补一张：
   * 只在「这轮催促过 + 它没发 + 候选真的扣上了标签」这三个条件同时成立时才补，
   * 免得乱甩一张不搭的图反而更尴尬。
   */
  sendStickerFile(frame, file) {
    try {
      const b64 = fs.readFileSync(file).toString('base64')
      const payload = { ...frame, params: { ...frame.params, message: [{ type: 'image', data: { file: 'base64://' + b64 } }] } }
      delete payload.echo
      this.toNapcat(Buffer.from(JSON.stringify(payload), 'utf8'), false)
      const name = path.basename(file)
      bumpStats('outgoing')
      markUsed(name)
      const key = this.chatKey(frame)
      if (this.stickerGap) this.stickerGap.set(key, 0)
      if (this.stickerTarget) this.stickerTarget.delete(key)
      if (!this.stickerAt) this.stickerAt = new Map()
      this.stickerAt.set(key, Date.now())
      this.log(`兜底补发表情：${name}`)
      return true
    } catch (e) {
      this.log(`兜底补表情失败：${e.message}`)
      return false
    }
  }

  /** 回复发完之后再看一眼：这轮该配图、它没配、候选够贴，就补一张 */
  armAutoSticker(frame, afterMs) {
    const p = this.pendingSticker
    if (!p) return
    if (this.chatKey(frame) !== p.key) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const still = this.pendingSticker
      if (!still || still.key !== p.key) return
      this.pendingSticker = null
      if (Date.now() - still.at > 150 * 1000) return
      if (still.score < 2) return // 没有真正扣上标签，宁可不发
      this.sendStickerFile(frame, still.file)
    }, Math.max(1200, afterMs) + 500 + Math.random() * 1800)
    this.timers.add(timer)
  }

  stickerNudge(cfg, frame) {
    try {
      const sk = cfg.stickers || {}
      if (sk.enabled === false) return ''
      const n = stickerEveryN(sk.freq)
      if (!n) return ''
      if (!this.stickerGap) this.stickerGap = new Map()
      if (!this.stickerTarget) this.stickerTarget = new Map()
      if (!this.stickerAt) this.stickerAt = new Map()
      const key = this.chatKey(frame)
      const count = (this.stickerGap.get(key) || 0) + 1
      this.stickerGap.set(key, count)
      // 目标条数加抖动：固定「每 7 条准时来一张」比不发还假
      let target = this.stickerTarget.get(key)
      if (!target) {
        target = Math.max(2, Math.round(n * (0.75 + Math.random() * 0.6)))
        this.stickerTarget.set(key, target)
      }
      // 冷却：刚发过就往后挪，别连着甩
      const lastAt = this.stickerAt.get(key) || 0
      if (Date.now() - lastAt < 120 * 1000) return ''
      if (count < target) return ''
      if (count >= target * 3) {
        // 提醒了这么多次还是不发，说明这会儿气氛真的不适合，归零重新计时
        this.stickerGap.set(key, 0)
        this.stickerTarget.delete(key)
        return ''
      }
      // 到点提醒一次，之后每 target/2 条催一次，别每条都念
      const step = Math.max(2, Math.round(target / 2))
      if ((count - target) % step !== 0) return ''
      // 直接给候选，别让它再去列库挑（多一步它就少发一次）
      const dir = cfg.paths?.stickers || ''
      const incoming = (Array.isArray(frame.message) ? frame.message : [])
        .filter((x) => x && x.type === 'text')
        .map((x) => String(x.data?.text || ''))
        .join(' ')
      const cands = dir ? this.stickerCandidates(dir, incoming, 3) : []
      if (!cands.length) {
        return `【该配图了】你连着 ${count} 条没发表情包了。\`qq-sticker\` 看一眼库里有什么，挑一张发出去。\n`
      }
      // 记下最优候选：万一它看完还是不发，回复结束后由我们补一张
      this.pendingSticker = {
        key: this.chatKey(frame),
        file: path.join(dir, cands[0].n),
        score: cands[0].score,
        at: Date.now()
      }
      const lines = cands.map(
        (c, i) => `${i + 1}. ${c.n}（${(c.tags || []).slice(0, 3).join('、') || '无标签'}）→ ${dir}/${c.n}`
      )
      return (
        `【该配图了】你连着 ${count} 条没发表情包了。这几张比较贴现在的话题：\n` +
        lines.join('\n') +
        '\n选一个直接 `qq_send_image(sources=["上面那个完整路径"])` 发出去，一张就够；实在都不搭才跳过。\n'
      )
    } catch {
      return ''
    }
  }

  /**
   * 语音也来催一下。
   *
   * 之前只有人格里一句「大约十条来一条」，结果它一条都不主动发 —— 因为发语音
   * 得先跑 `tts` 再 `qq_send_voice`，两步，比打字贵。到点给个明确出口，它才肯动。
   */
  voiceNudge(cfg, frame) {
    try {
      const v = cfg.voice || {}
      if (v.enabled === false || v.allowAuto === false) return ''
      const rate = Number(v.autoRate || 0)
      if (!(rate > 0)) return ''
      const n = Math.max(2, Math.round(200 / rate))
      if (!this.voiceGap) this.voiceGap = new Map()
      const key = this.chatKey(frame)
      const count = (this.voiceGap.get(key) || 0) + 1
      this.voiceGap.set(key, count)
      if (count < n) return ''
      if (count >= n * 3) {
        this.voiceGap.set(key, 0)
        return ''
      }
      const step = Math.max(2, Math.round(n / 2))
      if ((count - n) % step !== 0) return ''
      return (
        `【这条可以发语音】按面板频率轮到语音了（连着 ${count} 条纯文字）。这句话如果很短（十几个字以内）、` +
        '又是撒娇、关心、道晚安、吐槽这种说出来更带味道的，就直接 `tts "要说的话"` 拿路径再用 `qq_send_voice` 发出来；' +
        '内容长了或者不适合开口，就正常打字。\n'
      )
    } catch {
      return ''
    }
  }

  /**
   * 它发出去的消息里有没有带着表情库里的图。
   *
   * 这些图是它自己挑的，所以「今天发了几张」得从真实出站帧里数，
   * 不能靠它汇报 —— 它自己也记不住。
   *
   * 坑：插件的 `qq_send_image` 不会把路径交给 NapCat，而是先读成
   * `base64://...`（为了绕开容器看不到宿主机文件的问题）。所以出站帧里
   * 拿不到文件名，只能拿内容哈希去比对库里的指纹。
   */
  accountOutboundStickers(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const msg = frame?.params?.message
    if (!Array.isArray(msg)) return
    const dir = (() => {
      try {
        const c = this.cfgFor(this.chatUserOf(frame))
        if (c.stickers?.enabled === false) return ''
        return c.paths.stickers
      } catch {
        return ''
      }
    })()
    if (!dir) return

    for (const seg of msg) {
      // 真发了语音，语音催促重新计时
      if (seg && seg.type === 'record' && this.voiceGap) {
        this.voiceGap.set(this.chatKey(frame), 0)
      }
      if (!seg || seg.type !== 'image') continue
      const raw = String(seg?.data?.file || seg?.data?.url || '')
      let name = ''

      if (raw.startsWith('base64://')) {
        name = this.matchStickerByHash(raw.slice('base64://'.length))
      } else {
        // 路径有三种写法：原样透传、file:/// 前缀、还有 URL 编码过的空格。
        // 以前只认第一种，所以「明明发了表情，统计里却是 0」，连带着提醒也不会重新计时。
        let cand = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
        try {
          cand = decodeURIComponent(cand)
        } catch {
          /* 保底用原串 */
        }
        const norm = cand.replace(/\\/g, '/')
        if (norm.startsWith(dir)) name = norm.slice(dir.length).replace(/^\/+/, '')
        else if (!norm.includes('/') && norm) name = norm
      }
      if (!name) continue
      this.pendingSticker = null // 它自己配了图，兜底就不用了
      bumpStats('outgoing')
      markUsed(name)
      const ck = this.chatKey(frame)
      if (this.stickerGap) this.stickerGap.set(ck, 0)
      if (this.stickerTarget) this.stickerTarget.delete(ck)
      if (!this.stickerAt) this.stickerAt = new Map()
      this.stickerAt.set(ck, Date.now())
      this.log(`发出表情: ${name}`)
    }
  }

  /**
   * 内容哈希 → 文件名。库不大（上限 100 张），整库建一次指纹表就够；
   * 用 index.json 的 mtime 当缓存版本号，存图/删图后自动重建。
   */
  matchStickerByHash(b64) {
    try {
      const cfg = loadConfig()
      const dir = cfg.paths.stickers
      const idx = path.join(dir, 'index.json')
      const ver = (() => {
        try {
          return `${fs.statSync(idx).size}:${fs.statSync(dir).mtimeMs}`
        } catch {
          return String(Date.now())
        }
      })()
      if (!this.stickerHashCache || this.stickerHashCache.ver !== ver) {
        const map = new Map()
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue
          try {
            const h = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex')
            map.set(h, f)
          } catch {
            /* 单张读不了不影响其它 */
          }
        }
        this.stickerHashCache = { ver, map }
      }
      const buf = Buffer.from(b64, 'base64')
      const h = crypto.createHash('sha1').update(buf).digest('hex')
      return this.stickerHashCache.map.get(h) || ''
    } catch {
      return ''
    }
  }

  /**
   * 记下每个会话最后一条入站消息的 id。
   *
   * `qq-react` 要靠它知道往哪条消息上贴表情 —— 模型在对话里看到的只是文字，
   * 根本不知道 message_id 这种东西。
   */
  /** 注册「收到消息」回调，主动消息用它统计活跃时段 */
  setUserActivityHook(fn) {
    this.userActivityHook = typeof fn === 'function' ? fn : null
  }

  /** 注册「说说已发」回调，主动消息用它记最近发过什么（防重复题材） */
  setQzoneHook(fn) {
    this.qzoneHook = typeof fn === 'function' ? fn : null
  }

  /** 注册「对话状态评估」回调，proactive 用它把 ended/mood 存进 state 调倍率 */
  setConvStateHook(fn) {
    this.convStateHook = typeof fn === 'function' ? fn : null
  }

  /** 注册「生词」回调：她在回复里标了 `[[生词]]`、或回了 `[[学词]]` 回执时触发入库 */
  setSlangHook(fn) {
    this.slangHook = typeof fn === 'function' ? fn : null
  }

  /**
   * 记一条最近对话，供「每日学词」任务当语料。
   *
   * 只留 200 条、每条 200 字：够了就行。内部注入（`【内部任务`）必须排除，
   * 否则她会在语料里读到自己的任务说明，学出莫名其妙的词。
   */
  rememberSlang(who, text) {
    const t = String(text || '').trim()
    if (t.length < 2) return
    if (t.includes('【内部任务')) return
    if (!this.slangRecent) this.slangRecent = []
    this.slangRecent.push({ who, text: t.slice(0, 200), at: Date.now() })
    if (this.slangRecent.length > 200) this.slangRecent.splice(0, this.slangRecent.length - 200)
  }

  /** 取最近对话（最多 n 条），给 server.js 拼学习提示词 */
  recentSlang(n = 120) {
    const list = this.slangRecent || []
    return list.slice(-Math.max(1, Number(n) || 120))
  }

  /**
   * 剥掉回复里的 `[[生词]]` 标记并收集词。
   *
   * 和 applyQuote 一样是「内部标记」：**必须扫全部 text 段、任意位置**。
   * 上午刚修过 `[[引用 1]]` 漏在正文中间发出去的问题，这里不能再犯。
   */
  extractSlangMarks(frame) {
    const msg = frame?.params?.message
    if (!Array.isArray(msg)) return { frame, words: [], hit: 0 }
    const words = []
    let hit = 0
    const out = msg
      .map((s) => {
        if (!s || s.type !== 'text') return s
        const r = stripSlangMarks(String(s.data?.text ?? ''))
        if (!r.hit) return s
        hit += r.hit
        words.push(...r.words)
        return { ...s, data: { ...s.data, text: r.text } }
      })
      .filter((s) => !(s && s.type === 'text' && !String(s.data?.text ?? '').trim()))
    if (!hit) return { frame, words: [], hit: 0 }
    return { frame: { ...frame, params: { ...frame.params, message: out } }, words, hit }
  }

  /** 某个私聊里，对方最后一次说话的时刻（没有就是 0） */
  lastUserAtFor(userId) {
    return this.chatLastAt.get(`private:${String(userId || '')}`) || 0
  }

  /**
   * 把 `[[引用 N]]` 换成真正的 QQ 引用段。
   *
   * 三种结果：
   * - 没写标记 → 原样返回，不多事；
   * - 写了但序号查不到（过期/手滑）→ **只把标记删掉**，照常发，不能让整条回复丢掉；
   * - 查到了 → 在 message 最前面插 `{type:'reply'}`，正文去掉标记。
   *
   * 引用段必须排第一：QQ 客户端只认消息开头的 reply 段，夹在中间不显示。
   *
   * 【2026-10-23】不再只处理段首那一个标记：她常写两个（对应合并里的两条），
   * 第二个夹在正文中间，以前会原样发出去。现在所有 text 段的标记一律剥掉，
   * 只有段首那个会变成真引用。
   */
  applyQuote(frame) {
    const msg = frame?.params?.message
    if (!Array.isArray(msg)) return { frame, quoted: false }

    // 取第一个**非空** text 段：转发/分条有时会在最前面塞一个空 text 段，
    // 拿空段去解析永远匹配不到标记。
    const firstText = msg.find((s) => s && s.type === 'text' && String(s.data?.text ?? '').trim())
    const q = firstText ? parseQuoteMark(String(firstText.data?.text ?? '')) : null

    // 不管有没有「要引用哪条」的指令，正文里残留的标记都必须清掉
    let removed = 0
    const stripped = msg
      .map((s) => {
        if (!s || s.type !== 'text') return s
        const r = stripQuoteMarks(String(s.data?.text ?? ''))
        if (!r.count) return s
        removed += r.count
        return { ...s, data: { ...s.data, text: r.text } }
      })
      // 如果这条只剩标记，就整个丢掉（不能发一条空的）
      .filter((s) => !(s && s.type === 'text' && !String(s.data?.text ?? '').trim()))

    if (!q) {
      if (!removed) return { frame, quoted: false }
      return {
        frame: { ...frame, params: { ...frame.params, message: stripped } },
        quoted: false,
        dropped: true,
        removed,
        reason: 'extra'
      }
    }

    const rec = this.quoteMap.get(this.outKey(frame))
    const fresh = rec && Date.now() - (rec.at || 0) < 10 * 60_000
    const id = fresh ? rec.ids[q.n - 1] : null

    const base = { ...frame, params: { ...frame.params, message: stripped } }

    // 开关关掉了：标记必须删（否则 `[[引用 2]]` 会原样发到聊天里），但不引用
    const qcfg = this.cfgFor(this.chatUserOf(frame)).reply?.quote || {}
    if (qcfg.enabled === false) {
      return { frame: base, quoted: false, dropped: true, n: q.n, removed, reason: 'off' }
    }

    if (!id) {
      return { frame: base, quoted: false, dropped: true, n: q.n, removed, reason: 'stale' }
    }
    // 只剩标记、没有正文：不能只发一个引用气泡。返回空 message，上层会整条丢弃并回 ack。
    if (!stripped.length) {
      return { frame: base, quoted: false, dropped: true, n: q.n, removed, reason: 'empty' }
    }
    return {
      frame: { ...frame, params: { ...frame.params, message: [{ type: 'reply', data: { id: String(id) } }, ...stripped] } },
      quoted: true,
      n: q.n,
      removed
    }
  }

  /**
   * 把一帧里的思考草稿剥掉。
   *
   * 只动 text 段：第一个 text 段换成清洗后的内容，其余 text 段清空并移除，
   * face / image 段的相对位置保持不变（挪了表情就跑到句子中间去了）。
   */
  stripDraftFrame(frame) {
    const msg = frame?.params?.message
    if (!Array.isArray(msg)) return { changed: false, frame, text: '', dropped: 0 }
    const textSegs = msg.filter((s) => s && s.type === 'text')
    if (!textSegs.length) return { changed: false, frame, text: '', dropped: 0 }

    /**
     * 拼接时用占位符代替表情段，不能直接 join('')。
     *
     * 真实事故（2026-10-22 17:07）：模型输出
     *   `…想你就想你嘛` + [face:20] + `被你看出来了啊\n…`
     * 直接拼接会把两段粘成「想你就想你嘛被你看出来了啊」—— 看着就像断句错乱。
     * 表情段本身不会丢（它还在 message 数组里），但文字的位置信息必须留住。
     */
    const SEP = '\u0000'
    const raw = msg
      .map((s) => {
        if (!s) return ''
        if (s.type === 'text') return String(s.data?.text ?? '')
        // 只有表情留在原位有意义；图片/语音这类本来就不会走到这里
        return s.type === 'face' ? SEP : ''
      })
      .join('')

    const res = stripDraftArtifacts(raw)
    if (!res.changed) return { changed: false, frame, text: raw.split(SEP).join(''), dropped: 0 }

    // 表情夹在两段文字中间时，那里本来就是一个断点。
    // 把占位符换成换行，让后续分条能按行切开；否则两段会粘成一句
    // （真实事故：「想你就想你嘛」+[face]+「被你看出来了啊」）。
    const merged = res.text.split(SEP).map((s) => s.replace(/^\n+|\n+$/g, '')).filter(Boolean).join('\n')

    // 文字合并成一个段，表情段留在后面 —— splitPlan 会把它们挂到最后一条末尾
    const outMsg = []
    let placed = false
    for (const s of msg) {
      if (!s) continue
      if (s.type === 'text') {
        if (!placed) {
          outMsg.push({ ...s, data: { ...s.data, text: merged } })
          placed = true
        }
        continue
      }
      outMsg.push(s)
    }

    return {
      changed: true,
      dropped: res.dropped,
      text: merged,
      frame: { ...frame, params: { ...frame.params, message: outMsg } }
    }
  }

  /**
   * 记一笔「她刚在这个会话里说过话」。
   *
   * 主动搭话、补发表情、拆条的后几条都会走到出站这条路 ——
   * 只要她说了什么，接下来的 4 分钟里你回消息就该按「正在聊」秒回。
   */
  markChatSpoke(frame) {
    try {
      const p = (frame && frame.params) || {}
      const uid = p.user_id || p.group_id
      if (!uid) return
      const key = p.group_id ? `group:${p.group_id}` : `private:${p.user_id}`
      let st = this.pace.get(key)
      if (!st) {
        st = { lastDispatchAt: 0, skipped: 0 }
        this.pace.set(key, st)
      }
      st.lastSpokeAt = Date.now()
      st.skipped = 0
      this.persistPace(key)
    } catch {
      /* 记不上不影响发消息 */
    }
  }

  /**
   * 把「这个会话最后活动时间」写进 state，供重启后恢复。
   *
   * 真实事故（2026-10-22 18:47）：我改完代码重启了面板，`this.pace` 是纯内存 Map，
   * 一重启 `lastDispatchAt` / `lastSpokeAt` 全归零。用户紧接着发消息，
   * `lastTouched = 0` → `chatting = false` → 系统以为「很久没聊」，
   * 于是走随机节奏抽到 long 档（8-25 分钟），实际拖了 350 秒才回。
   * 他的体感是「上一句还在聊，我说话她就不回了」。
   *
   * 所以这两个时间戳必须落盘。人聊天的频率很低，每条消息写一次几百字节完全没负担，
   * 不需要节流。
   */
  persistPace(key) {
    try {
      const st = this.pace.get(key)
      if (!st) return
      const all = { ...(getState().chatPace || {}) }
      all[key] = {
        d: Number(st.lastDispatchAt) || 0,
        s: Number(st.lastSpokeAt) || 0
      }
      // 只留最近活跃的 20 个会话，别让这个对象无限长大
      const keys = Object.keys(all)
      if (keys.length > 20) {
        keys.sort((a, b) => (all[b].d || 0) + (all[b].s || 0) - ((all[a].d || 0) + (all[a].s || 0)))
        for (const k of keys.slice(20)) delete all[k]
      }
      patchState({ chatPace: all })
    } catch {
      /* 写不进去就退回纯内存行为，不影响聊天 */
    }
  }

  /** 启动时把上次的会话活跃时间读回来，避免重启后把「正在聊」当成「很久没聊」 */
  restorePace() {
    try {
      const all = getState().chatPace || {}
      for (const [key, v] of Object.entries(all)) {
        if (!v || typeof v !== 'object') continue
        this.pace.set(key, {
          lastDispatchAt: Number(v.d) || 0,
          lastSpokeAt: Number(v.s) || 0,
          skipped: 0
        })
      }
    } catch {
      /* 恢复不了就按内存版跑 */
    }
  }

  rememberMessage(frame) {
    if (!frame || frame.post_type !== 'message') return
    if (frame.message_id === undefined || frame.message_id === null) return
    try {
      const cfg = loadConfig()
      const key = this.chatKey(frame)
      let book = {}
      try {
        book = JSON.parse(fs.readFileSync(lastMsgFile(), 'utf8'))
      } catch {
        book = {}
      }
      const segs = Array.isArray(frame.message) ? frame.message : []
      const text = segs.filter((s) => s?.type === 'text').map((s) => String(s?.data?.text || '')).join('').slice(0, 60) ||
        String(frame.raw_message || '').slice(0, 60)
      book[key] = {
        id: String(frame.message_id),
        time: Date.now(),
        sender: String(frame.user_id || frame.group_id || ''),
        preview: text
      }
      // 只留最近 30 个会话，别让它无限长
      const keys = Object.keys(book)
      if (keys.length > 30) {
        for (const k of keys.sort((a, b) => (book[a].time || 0) - (book[b].time || 0)).slice(0, keys.length - 30)) delete book[k]
      }
      fs.writeFileSync(lastMsgFile(), JSON.stringify(book, null, 2), 'utf8')
    } catch (e) {
      // 记不下来也不影响聊天，不值得打断流程
    }
  }

  checkToken(req) {
    const cfg = loadConfig()
    const want = cfg.proxy.token || cfg.dsh.accessToken
    if (!want) return true
    const hdr = req.headers['authorization'] || ''
    if (hdr.toLowerCase().startsWith('bearer ')) {
      return hdr.slice(7).trim() === want
    }
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const q = u.searchParams.get('access_token') || u.searchParams.get('token')
      if (q) return q === want
    } catch {
      /* ignore */
    }
    return false
  }

  /**
   * 这个 QQ 该用哪套配置。主号/没配覆盖时直接返回全局配置（同一个对象，零开销），
   * 访客返回合并后的副本。所有「按人可调」的行为都必须走这里，别直接 loadConfig()。
   *
   * 【群聊】传 groupId 时走**群档案**，不套访客默认 ——
   * 群里面对的可能是一屋子熟人，和「私聊陌生人」语义完全不同。
   */
  cfgFor(qq, groupId) {
    try {
      return resolveProfile(loadConfig(), groupId ? null : qq, groupId ? { groupId } : {}).cfg
    } catch {
      return loadConfig()
    }
  }

  /** 按 frame 取配置：群聊按群、私聊按人。新增的代码一律用这个。 */
  cfgForFrame(frame) {
    const gid = frame && (frame.message_type === 'group' || frame.group_id) ? frame.group_id : null
    return this.cfgFor(this.chatUserOf(frame), gid)
  }

  /** 按 frame 取完整档案信息（label/overrides 也要用的时候） */
  profileFor(frame) {
    const gid = frame && (frame.message_type === 'group' || frame.group_id) ? frame.group_id : null
    if (gid) return resolveProfile(loadConfig(), null, { groupId: gid })
    return resolveProfile(loadConfig(), this.chatUserOf(frame) || frame?.user_id)
  }

  /**
   * 这个会话要注入的黑话词表。
   *
   * 按档案取 `cfg.slang`（来自 resolveProfile 深合并后的结果），所以
   * 「这个群/这个人能不能用黑话」是各档案自己说了算；词库本身全局共享。
   *
   * 缓存按文件 mtime：每条消息都读一次 JSON 没必要，但改了词库要立刻生效。
   */
  slangBlockFor(cfg) {
    try {
      const sc = cfg?.slang || {}
      if (sc.enabled === false) return ''
      const file = path.join(DATA_DIR, 'slang.json')
      if (!this.slangCache) this.slangCache = { mtime: -1, entries: [] }
      let mtime = 0
      try {
        mtime = fs.statSync(file).mtimeMs
      } catch {
        return ''
      }
      if (mtime !== this.slangCache.mtime) {
        this.slangCache = { mtime, entries: loadSlang(file) }
      }
      return buildSlangBlock(this.slangCache.entries, {
        max: Number(sc.injectMax) || 8,
        minCount: Number(sc.minCount) || 2
      })
    } catch {
      return ''
    }
  }

  /** 出站帧是发给谁 —— 私聊取 params.user_id，群聊不做按人（返回空） */
  chatUserOf(frame) {
    if (frame?.params?.group_id) return ''
    const u = frame?.params?.user_id
    return u === undefined || u === null ? '' : String(u)
  }

  /**
   * 同一条内容短时间内只发一次。
   *
   * 为什么需要：dsh 重启、插件重试、任务重跑都可能把同一条回复再交过来一次，
   * 而我们在出站层是「来一条就拆一条发」——没有幂等，结果就是聊天里出现一模一样的重复气泡。
   * 用「会话 + 内容哈希 + 时间窗」挡住：整条 90 秒、单个分条 180 秒内不许重复。
   */
  /**
   * 整条回复级判重：这轮分条的结果是不是和刚处理过的那轮几乎一样？
   *
   * 真实事故（2026-10-22 18:15）：dsh 把同一条回复发了两次帧（相隔 3 秒），
   * 两次都走了 splitPlan + scheduleRest，**两条补发链交错执行**：
   *   18:15:21 拆成 4 条 / 补发 2/4
   *   18:15:24 拆成 4 条 / 丢弃首条 / 又补发 2/4   ← 第二链起来了
   *   18:15:24 补发 3/4（第二链）
   *   18:15:27 补发 3/4（第一链）
   *   18:15:30 补发 4/4（第一链）
   *   18:15:31 补发 4/4（第二链）
   * 逐条去重只挡住了一部分 —— 因为两条链的延迟不同，对方那条「还没发出去」，
   * 去重自然命不中。结果就是顺序乱 + 重复。
   *
   * 所以必须在「分条之后、起发送链之前」按整条判重：只要这轮和上轮几乎一样，
   * 整条丢弃，连 scheduleRest 都不启动。
   *
   * 窗口 30 秒：真人不会半分钟内把一模一样的一串话说两遍。
   */
  sameReplyAsLast(frame, parts) {
    if (!this.lastSplit) this.lastSplit = new Map()
    const key = this.outKey(frame)
    // 指纹：去掉所有空白和标点，只留字。标点/表情差异不该影响判重
    const fp = (parts || []).map((p) => String(p).replace(/[\s\p{P}\p{S}]/gu, '')).join('|')
    if (!fp) return false

    const now = Date.now()
    const prev = this.lastSplit.get(key)
    this.lastSplit.set(key, { fp, at: now })
    if (!prev || now - prev.at > 30_000) return false
    if (prev.fp === fp) return true

    // 不完全相同也判：一方包含另一方（第二次只是多/少了点尾巴），且长度差不超过 15%
    const a = prev.fp
    const b = fp
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (short.length > 10 && long.includes(short) && short.length / long.length > 0.85) return true
    return false
  }

  isDuplicate(frame, text, windowMs) {
    if (!this.sentCache) this.sentCache = new Map()
    const key = this.chatKey({ user_id: this.chatUserOf(frame) || frame?.params?.user_id })
    const sig = crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
    const id = key + '|' + sig
    const now = Date.now()
    if (this.sentCache.size > 200) {
      for (const [k, ts] of this.sentCache) if (now - ts > 600000) this.sentCache.delete(k)
    }
    const prev = this.sentCache.get(id)
    if (prev && now - prev < windowMs) return true
    this.sentCache.set(id, now)
    return false
  }

  decide(frame) {
    const cfg = this.cfgFor(frame.user_id)
    if (frame.post_type !== 'message') return { pass: true }

    const raw = typeof frame.raw_message === 'string' ? frame.raw_message.trim() : ''
    const plain = Array.isArray(frame.message)
      ? frame.message
          .filter((s) => s && s.type === 'text')
          .map((s) => s.data?.text || '')
          .join('')
          .trim()
      : raw

    const isGroup = frame.message_type === 'group' || Boolean(frame.group_id)

    // 群聊总开关（面板「名单 → 群聊」）。关着就一条群消息都不处理。
    const gcfg = cfg.groups || {}
    if (isGroup && gcfg.enabled !== true) return { pass: false, reason: '群聊已关闭' }

    // 群里要 @ 才算在叫她。
    // 原来这条只写进 AGENTS.md 当提示（「被点名才接话」），代码完全不检查 ——
    // 一旦把群聊打开，她不 @ 也会插嘴，而这恰恰是群里最招人烦的行为。
    if (isGroup && gcfg.requireMention !== false) {
      const segs = Array.isArray(frame.message) ? frame.message : []
      const me = String(frame.self_id || cfg.qq?.botQQ || '')
      const atMe = segs.some(
        (x) => x && x.type === 'at' && String(x.data?.qq || '') === me && me
      )
      if (!atMe) return { pass: false, reason: '群里没 @ 她' }
    }

    const selfId = String(frame.self_id || '')
    if (selfId && String(frame.user_id) === selfId) return { pass: false, reason: '自己发的消息' }

    // 白名单闸门：名单外的人直接丢掉，消息不进模型，也不花 token。
    // 群聊查的是「群号在不在白名单」，群成员本身不需要逐个加进来。
    const verdict = whitelistVerdict(cfg, frame.user_id, isGroup, frame.group_id)
    if (!verdict.pass) {
      this.rememberBlocked(frame, verdict.reason)
      return { pass: false, reason: `名单拦截（${verdict.reason}）` }
    }
    if (!isGroup) this.rememberContact(frame)

    // 斜杠命令放行（走到这里说明发件人已经在名单内）
    if (plain.startsWith('/')) return { pass: true }

    if (cfg.reply.quiet.enabled && inWindow(cfg.reply.quiet.from, cfg.reply.quiet.to)) {
      return { pass: false, reason: `免打扰时段 ${cfg.reply.quiet.from}-${cfg.reply.quiet.to}` }
    }

    if (cfg.reply.keywordOnly.enabled && cfg.reply.keywordOnly.words.length) {
      const hit = cfg.reply.keywordOnly.words.some((w) => w && plain.includes(w))
      if (!hit) return { pass: false, reason: '未命中关键词' }
    }

    const p = Number(cfg.reply.probability)
    if (Number.isFinite(p) && p < 1) {
      if (p <= 0) return { pass: false, reason: '回复概率为 0' }
      if (Math.random() > p) return { pass: false, reason: `回复概率 ${Math.round(p * 100)}% 未命中` }
    }

    return { pass: true }
  }

  /**
   * 往 dsh 注入一条「私聊消息」，让 agent 当作收到的消息来回复。
   * 这是主动搭话的实现方式：不伪造发送动作，而是让它正常走一遍
   * 「收到消息 → 按人格生成回复 → 通过插件发出去」的链路，
   * 好处是人格、上下文、工具能力全部原样生效。
   */
  injectPrivateMessage(text, opts = {}) {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      throw new Error('dsh 未连接')
    }
    const evt = this.buildPrivateFrame(text, opts)
    this.upstream.send(JSON.stringify(evt))
    return evt
  }

  /** 模拟一条「刚收到的私聊」，走完整的入站处理链（看图 + 延迟），用于自检 */
  simulateInbound(text, opts = {}) {
    const evt = this.buildPrivateFrame(text, opts)
    this.queueMessage(JSON.stringify(evt), evt)
    return evt
  }

  buildPrivateFrame(text, opts = {}) {
    const cfg = loadConfig()
    const st = getState()
    const userId = String(opts.userId || cfg.qq.adminQQ || '')
    const selfId = String(opts.selfId || st.botQQ || cfg.qq.botQQ || '')
    if (!userId) throw new Error('未配置接收人 QQ')

    const message = [{ type: 'text', data: { text } }]
    // 带图模拟：插件认 file:// 引用，会把它拷进自己的 media 目录再给模型看，
    // 效果和真人发一张图完全一致（模型看到 `[图片:/路径]`）。
    if (opts.imageFile) {
      message.push({ type: 'image', data: { file: 'file://' + opts.imageFile, summary: '[动画表情]' } })
    }

    return {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: Date.now() % 1000000000,
      user_id: Number(userId),
      self_id: Number(selfId) || 0,
      raw_message: text,
      message,
      sender: { user_id: Number(userId), nickname: '我', card: '', role: 'owner' },
      time: Math.floor(Date.now() / 1000)
    }
  }

  /**
   * 消息进入 dsh 前的第一道加工：连发合并。
   *
   * 同一个人连着发三句「在吗」「我今天去打球了」「累死了」，如果逐条转发，
   * 模型会把它们当成三次独立的对话，一句一句地回。所以先攒一个短窗口：
   * 窗口内每来一条就重新计时（debounce），到期后把这几条合成一条消息交出去，
   * 并在前面加一句提示，让它自己判断「是一件事就合并回，不是就分开回」。
   */
  queueMessage(text, frame) {
    const cfg = this.cfgFor(frame.user_id)
    const paceOn = cfg.reply?.pace?.enabled !== false

    if (!paceOn) {
      const win = Number(cfg.reply?.coalesceMs ?? 1000)
      if (!(win > 0)) {
        this.dispatch(text, frame)
        return
      }
      this.bufferMessage(text, frame, win)
      return
    }

    // ---- 生活节奏模式 ----
    const key = this.chatKey(frame)
    let st = this.pace.get(key)
    if (!st) {
      st = { lastDispatchAt: 0, skipped: 0 }
      this.pace.set(key, st)
    }
    const now = Date.now()
    // 「正在聊」= 最近 4 分钟内这个会话有过一次来回。
    //
    // 这里有个坑（8-22 修）：只看 lastDispatchAt（我们把它的话交出去的时刻）是不够的 ——
    // 她**主动搭话**走的是注入，不经过入站漏斗，所以那个时间戳从头到尾没更新。
    // 结果：她刚主动说完，你回一句，系统却认为「你们没在聊」，按 2-25 分钟档拖。
    // 现在把「她刚说过话」也算进来，她开的头就由她接着快回。
    const CHAT_WINDOW = 240_000
    const lastTouched = Math.max(st.lastDispatchAt || 0, st.lastSpokeAt || 0)
    const cs = campusState(cfg)
    let chatting = lastTouched > 0 && now - lastTouched < CHAT_WINDOW

    // 刚启动的 3 分钟内一律当「正在聊」。
    // 重启几乎都是人为操作（改代码、修问题），你紧接着就会来试一句 ——
    // 这时候按随机节奏抽到 long 档拖几分钟，体感就是「我说话她不回」。
    // （状态已经落盘了，正常重启能读回时间戳；这条兜的是「首次部署 / state 被清」）
    if (!chatting && this.startedAt && now - this.startedAt < 180_000) chatting = true

    // 忙的时候不会一直聊下去。
    // 上课/自习期间，她最多偷看手机回你一条 —— 回完就得收心，
    // 后面的消息按「在忙」处理，拖到几分钟后再回。
    // （偷闲窗口里 busy=0，不走这条分支，那几分钟可以正常聊。）
    if (chatting && cs.busy >= 2) {
      st.busyTurns = (st.busyTurns || 0) + 1
      if (st.busyTurns > 1) chatting = false
    } else if (cs.busy < 2) {
      st.busyTurns = 0
    }

    // 纯文本才判「值不值得回」；带图/语音/文件一律当有意义。
    // 注意：传进来的 text 是整段 OneBot JSON，不能直接拿去判 —— 必须先从 frame 里
    // 把文字段拼出来，不然什么都是「有内容」。
    const segs = Array.isArray(frame.message) ? frame.message : []
    // 表情（face / mface / 表情包图）也算「有内容」。
    // 原来把 face 排除在外，导致「只发一个表情」在她眼里等于空消息，
    // 判定低价值后直接不回 —— 对方的体感是「发了表情她没反应」。
    const hasRich = segs.some((s) => s && s.type !== 'text')
    const plain = segs
      .filter((s) => s && s.type === 'text')
      .map((s) => String(s.data?.text || ''))
      .join('')
    // 纯表情（有 rich 但没文字）不算低价值
    const lowValue = !hasRich && isLowValue(plain)

    const plan = planPace(cfg, {
      hour: new Date().getHours(),
      chatting,
      unanswered: st.skipped,
      // 上课/自习/睡着了：状态机给出忙闲等级，节奏层据此抬档
      busy: cs.busy
    })

    if (lowValue && cfg.reply?.pace?.skipLowValue !== false && !chatting) {
      // 判据是「是不是正在聊」，不是「抽到了哪一档」。
      // 用档位判会有漏洞：正在聊时抽到 instant 才该应一声，可没在聊也可能抽到 instant，
      // 那样一个「嗯」也会被认真回一句。
      if (st.skipped < 3) {
        st.skipped++
        this.log(`这条先不回（像是没内容的消息，第 ${st.skipped} 条）`)
        this.stats.skipped = (this.stats.skipped || 0) + 1
        return
      }
    }

    st.skipped = 0
    if (plan.delayMs <= 0) {
      const win = Number(cfg.reply?.coalesceMs ?? 1000)
      if (win > 0) this.bufferMessage(text, frame, win)
      else {
        st.lastDispatchAt = now
        this.dispatch(text, frame)
      }
      return
    }
    this.bufferPaced(key, text, frame, plan.delayMs)
  }

  /**
   * 压着、到点一起看。
   *
   * 和 bufferMessage 的区别：**不 debounce**。
   * 连发合一是「你说完了他再说」，所以要等你停下来；
   * 这里是「它过一会儿才看手机」，你在这期间发多少句都一起攒着，
   * 到点一次看完 —— 真人翻手机就是这样翻的。
   */
  bufferPaced(key, text, frame, delayMs) {
    const now = Date.now()
    let b = this.inbox.get(key)
    if (!b) {
      b = { items: [], timer: null, firstAt: now, paced: true }
      this.inbox.set(key, b)
    }
    b.paced = true
    b.items.push({ text, frame, at: now })
    if (b.timer) return
    b.timer = setTimeout(() => this.flushInbox(key), Math.max(200, delayMs))
  }

  chatKey(frame) {
    if (frame.message_type === 'group' || frame.group_id) return `group:${frame.group_id}`
    return `private:${frame.user_id}`
  }

  /**
   * 会话 key，入站帧和出站帧都能用。
   *
   * `chatKey()` 认的是入站事件（post_type / message_type 那套），
   * 而出站帧长这样：`{action:'send_private_msg', params:{user_id, message}}` ——
   * 直接传进去会算出 `private:undefined`，导致「引用」查不到刚才那批消息。
   */
  outKey(frame) {
    const g = frame?.params?.group_id ?? frame?.group_id
    if (g) return `group:${g}`
    const u = frame?.params?.user_id ?? frame?.user_id
    return `private:${u}`
  }

  bufferMessage(text, frame, win) {
    const cfg = this.cfgFor(frame.user_id)
    const maxWait = Math.max(win, Number(cfg.reply?.coalesceMaxMs ?? 3000))
    const key = this.chatKey(frame)
    const now = Date.now()

    let b = this.inbox.get(key)
    if (!b) {
      b = { items: [], timer: null, firstAt: now }
      this.inbox.set(key, b)
    }
    b.items.push({ text, frame, at: now })
    clearTimeout(b.timer)

    // 对方可能一直在发，别无限等下去
    const elapsed = now - b.firstAt
    const left = maxWait - elapsed
    if (left <= 0) {
      this.flushInbox(key)
      return
    }
    b.timer = setTimeout(() => this.flushInbox(key), Math.min(win, left))
  }

  flushInbox(key) {
    const b = this.inbox.get(key)
    if (!b) return
    this.inbox.delete(key)
    clearTimeout(b.timer)
    const items = b.items.filter((it) => it && it.frame)
    if (!items.length) return

    // 记下来：这一刻才算「看到了」。下次判断「正在聊」就用它
    let st = this.pace.get(key)
    if (!st) {
      // 正常路径下 handleIncoming 已经建好了；这里是防御性兜底，
      // 保证「看到消息」这件事在任何入口上都会被记下来（重启后要靠它恢复）
      st = { lastDispatchAt: 0, skipped: 0 }
      this.pace.set(key, st)
    }
    st.lastDispatchAt = Date.now()
    st.skipped = 0
    this.persistPace(key)

    if (items.length === 1) {
      if (b.paced) this.log('攒了一会儿，现在回')
      this.dispatch(items[0].text, items[0].frame)
      return
    }
    const merged = this.mergeFrames(items, b.paced)
    const span = Math.max(1, Math.round((items[items.length - 1].at - items[0].at) / 1000))
    this.log(
      b.paced
        ? `攒了 ${items.length} 条（跨 ${span} 秒），一起交给模型自己挑值得回的`
        : `连发合并：${items.length} 条消息（跨 ${span} 秒）合成一条交给模型`
    )
    this.dispatch(merged.text, merged.frame)
  }

  /**
   * 把多条 OneBot 事件拼成一条：
   * - 以最后一条为基底（保留 sender / message_id / time / self_id）
   * - message 数组里插入换行段，保证几条之间不会黏成一串
   * - 开头插一段提示，明确告诉模型这是连发的多条、要它先判断是否连续
   */
  mergeFrames(items, paced = false) {
    const last = items[items.length - 1].frame
    const n = items.length
    const span = Math.max(1, Math.round((items[items.length - 1].at - items[0].at) / 1000))

    // 记住这批消息的 id —— 模型说「回第 2 条」时，按序号查真正的 message_id。
    // 只留最近一次合并，超过 10 分钟就当过期（在 applyQuote 里判）。
    const ids = items.map((it) => String(it.frame?.message_id ?? '')).filter(Boolean)
    if (ids.length) this.quoteMap.set(this.outKey(last), { ids, at: Date.now() })

    // 引用许可：只在「合并了多条」时才给 —— 只有一条没什么可区分的，引用反而多余。
    // 给了许可也不强制：它自己判断分不分得清，分得清就正常回。
    const rp = this.cfgFor(this.chatUserOf(last)).reply || {}
    const quoteOn =
      ids.length >= 2 &&
      rp.quote?.enabled !== false &&
      Math.random() * 100 < Math.max(0, Math.min(100, Number(rp.quote?.chance ?? 60)))

    const ifApart = quoteOn
      ? '不是同一件事就回最要紧那条，想让人看清你在回哪条，就在最前面写 `[[引用 2]]`。'
      : '不是同一件事就分别回，或者只回最要紧的那条。'

    // 「攒着一起看」和「连发」是两种不同场景，提示不能一样：
    // 连发要它判断是不是一件事；积压要它判断哪几条值得回 —— 后者允许直接不回。
    //
    // 提示刻意写短：第一版把规则写得像说明书（「如果是…就…；如果不是，就在最前面写…，
    // 这样对方看得出…」），结果它把规则原文念进了正文（真实事故：`Actually rule: if same thing
    // merge as one reply.`）。规则越像说明文，越容易被子模型复述。
    const hint = paced
      ? `[你有 ${fmtSpan(span)} 没看手机，这期间他发了 ${n} 条（[#1] [#2] 标了序号）。挑值得回的接上，` +
        '纯表情、单字这种可以不回；真要回就一次说完。是同一件事就合起来回，' +
        `${ifApart}（判断过程别写出来。）]\n`
      : `[他连着发了 ${n} 条（[#1] [#2] 标了序号）。是同一件事就合起来回一次；${ifApart}` +
        '判断过程别写出来。]\n'
    const segs = [
      {
        type: 'text',
        data: { text: hint }
      }
    ]
    for (let i = 0; i < items.length; i++) {
      if (i > 0) segs.push({ type: 'text', data: { text: '\n' } })
      // 每条前面标序号。模型看到的是拼在一起的文本，不标就分不清哪句属于哪一条，
      // 也就没法指「我要回的是第 2 条」。
      if (n > 1) segs.push({ type: 'text', data: { text: `[#${i + 1}] ` } })
      const m = Array.isArray(items[i].frame.message)
        ? items[i].frame.message
        : [{ type: 'text', data: { text: String(items[i].frame.raw_message || '') } }]
      segs.push(...m)
    }
    const frame = {
      ...last,
      message: segs,
      raw_message: items.map((it) => String(it.frame.raw_message || '')).join('\n')
    }
    return { text: JSON.stringify(frame), frame }
  }

  /**
   * 交给 dsh 前的第二道加工：
   * 1) 图片消息 —— 交给「图片模型」先翻译成文字描述；
   * 2) 回复速度 —— 按面板上的滑块决定等多久再交出去。
   */
  dispatch(text, frame) {
    const prof = this.profileFor(frame)
    const cfg = prof.cfg
    // 入站原文只取一次：下面几个注入都会往 message 前面插提示，插完就取不出「他到底说了什么」了
    const incomingText = (Array.isArray(frame.message) ? frame.message : [])
      .filter((s) => s && s.type === 'text')
      .map((s) => String(s.data?.text ?? ''))
      .join('')
    // 统计「对方发了几张表情」放在这个漏斗里：真消息和模拟消息都会经过，
    // 不会因为走了 coalesce / simulate 哪条路就漏记。
    this.countIncomingSticker(frame)

    // 人格层按人分的部分只能靠注入：AGENTS.md 是整个进程一份，
    // dsh 没有「每个会话一套系统提示」这回事。只在有覆盖时才注入。
    const block = profileBlock(prof.overrides)
    if (block) {
      const segs = Array.isArray(frame.message) ? frame.message : []
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: block } }, ...segs],
        raw_message: block + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
      this.log(`已注入「${prof.label}」的对话设定（${block.length} 字）`)
    }

    /*
     * 黑话词表：从「写进 AGENTS.md」改成**按会话注入**。
     *
     * 原因：AGENTS.md 是整个 dsh 进程一份，做不到「A 群不注入、B 群注入」。
     * 词库本身仍然全局共享（学到的词大家都能用），这里只按档案决定「用不用、用几条」。
     * 档案里 slang.enabled=false 就整个跳过 —— 不占一个字。
     */
    const slangBlock = this.slangBlockFor(cfg)
    if (slangBlock) {
      const segs = Array.isArray(frame.message) ? frame.message : []
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: slangBlock } }, ...segs],
        raw_message: slangBlock + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
    }

    // 当前状态（困/刚醒/在忙）：AGENTS.md 是静态的，状态每小时都在变，
    // 只能按条注入。一格一行，别写成小作文。
    const mood = moodLine(cfg)
    if (mood) {
      const segs = Array.isArray(frame.message) ? frame.message : []
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: mood } }, ...segs],
        raw_message: mood + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
    }

    // 表态优先于跳题联想：同一条消息只塞一段提示，
    // 两段叠在一起她会收到一堆「内部提示」，反而不知道该听哪个。
    const csNow = campusState(cfg)
    // 指令优先级最高。他明确让她做事的时候，既不该给她「岔题讲自己小事」的许可，
    // 也不该让表态挤掉办正事 —— 三选一，不叠加（叠多了她会开始念规则）。
    const request = requestHint(incomingText)
    const stance = request ? '' : opinionLine(cfg, { text: incomingText })
    const assoc = request || stance
      ? ''
      : assocLine(cfg, {
          text: incomingText,
          busy: csNow.busy,
          sneak: csNow.sneak === true,
          // 状态名一起传：跳题概率按状态分档（躺着爱扯、赶 DDL 不爱扯）
          stateKey: csNow.key
        })
    const hints = request || stance || assoc
    if (hints) {
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: hints } }, ...(Array.isArray(frame.message) ? frame.message : [])],
        raw_message: hints + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
      this.log(
        stance
          ? `允许这次表态（话题：${incomingText.replace(/\s+/g, ' ').slice(0, 14) || '无'}）`
          : `允许这次联想（由头：${incomingText.replace(/\s+/g, ' ').slice(0, 14) || '无'}）`
      )
    }

    // 表情包「催更」：光靠人格里那句「大约每 N 条发一张」它经常一整天一张都不发，
    // 所以在超期时往这条入站消息里塞一句提醒；真发出去之后计数清零。
    const nudge = this.stickerNudge(cfg, frame)
    if (nudge) {
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: nudge } }, ...(Array.isArray(frame.message) ? frame.message : [])],
        raw_message: nudge + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
      this.log(`表情催促已注入：连着 ${this.stickerGap?.get(this.chatKey(frame)) || '?'} 条没发`)
    }

    // 语音同理：光靠人格里那句「大约十条一次」，它一条都不会主动发
    const vn = this.voiceNudge(cfg, frame)
    if (vn) {
      frame = {
        ...frame,
        message: [{ type: 'text', data: { text: vn } }, ...(Array.isArray(frame.message) ? frame.message : [])],
        raw_message: vn + String(frame.raw_message || '')
      }
      text = JSON.stringify(frame)
      this.log('语音催促已注入')
    }

    // 【这里原来有第二段延迟】按 reply.speed 再等 0~120 秒。
    // 删掉的原因：延迟已经由生活节奏（reply.pace）在 onMessage 那一层算过了，
    // 两段串联的结果是「调哪个都不对」—— 面板上把「回复速度」拉到秒回，
    // 生活节奏照样拖几分钟；把生活节奏设成秒回，又会被这 0~120 秒加上去。
    // 现在延迟只有一处：pace（到点才交给模型）→ typing（发出前模拟打字）。
    this.deliver(text, frame, 0)
  }

  /**
   * 按面板上的「小黄脸频率」决定这条回复带不带 [face:N]。
   *
   * 命中（概率内）→ 原样保留；没命中 → 把文字段里的 [face:N] 全剥掉。
   *
   * 【为什么按「整条」而不是「每个表情」】
   * 一条回复里带两个脸是常态。逐个剥容易出现「一句话带半截表情」的怪样子，
   * 而且不容易调 —— 面板上写 30% 就该是「十句里三句带表情」这种直观手感。
   *
   * 【为什么要有代码这一层】
   * 人格里只能写「大约多少比例带表情」，模型不会精确遵守（实测偏高很多）。
   * 用户要的是一个能自己调的旋钮，那就得真按概率裁。
   */
  applyFaceRate(raw) {
    try {
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return raw
      }
      if (!/^send_(msg|private_msg|group_msg)$/.test(String(frame.action || ''))) return raw

      const cfg = this.cfgFor(this.chatUserOf(frame))
      const rate = Number(cfg?.persona?.faceRate ?? 30)
      // 100 = 不干预；没设过也按 30 兜底（默认值）
      if (!Number.isFinite(rate) || rate >= 100) return raw
      if (rate > 0 && Math.random() * 100 < rate) return raw

      const msg = frame.params?.message
      if (!Array.isArray(msg)) return raw
      let touched = false
      const out = msg.map((seg) => {
        if (!seg || seg.type !== 'text') return seg
        const t = String(seg.data?.text ?? '')
        if (!t.includes('[face:')) return seg
        FACE_RE.lastIndex = 0
        const stripped = t
          .replace(FACE_RE, ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\s+([，。！？、~～])/g, '$1')
        touched = true
        return { ...seg, data: { ...seg.data, text: stripped } }
      })
      if (!touched) return raw
      // 剥完变空的文字段直接丢掉；全空就保留原文 —— 纯表情回复不该变成空气
      const keep = out.filter((x) => !(x && x.type === 'text' && !String(x.data?.text ?? '').trim()))
      if (!keep.length) return raw
      return JSON.stringify({ ...frame, params: { ...frame.params, message: keep } })
    } catch {
      return raw
    }
  }

  /**
   * 她说「我想学吉他」「下次想去爬山」时，把这件事加进她自己的活动池。
   *
   * 和 captureGoAway 的区别：那个是「我现在就去」（改今天的状态），
   * 这个是「以后想干这件事」（进池子，哪天可能抽到）。
   *
   * 同样是因为「提示管不住」才做的：qq-routine 上线至今她一次没调用过，
   * 不能指望她会记得用 qq-event。用 `reply.autoWish: false` 可以关掉。
   */
  captureWish(raw) {
    try {
      const cfg = loadConfig()
      if (cfg.reply?.autoWish === false) return

      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (!/^send_(msg|private_msg|group_msg)$/.test(String(frame.action || ''))) return

      const segs = Array.isArray(frame.params?.message) ? frame.params.message : []
      const plain = segs
        .filter((s) => s && s.type === 'text')
        .map((s) => String(s.data?.text || ''))
        .join('\n')
      if (!plain.trim()) return

      const wish = detectWish(plain)
      if (!wish) return
      // 挑一个不和现有活动撞的时段。这一天已经排满了就不加了 ——
      // 硬塞的话抽签时会跟别的活动撞，加了也白加。
      const slot = pickSlotForCampus(cfg, wish.label)
      if (!slot) {
        this.log(`她说想「${wish.label}」，但活动池挤不下了，这次没加`)
        return
      }
      const saved = addExtraEvent({ label: wish.label, from: slot.from, to: slot.to, busy: 1 })
      if (saved) {
        this.log(`她说想「${saved.label}」→ 加进活动池（${saved.from}-${saved.to}）`)
      }
    } catch {
      /* 认不出来不影响发消息 */
    }
  }

  /**
   * 她说「我先去写作业了」这类话时，替她把状态改掉。
   *
   * 只认明确的自述（规则在 goaway.js，写得比较窄），认错了代价也只是
   * 「接下来一小时语气偏忙」，比她说一套做一套轻得多。
   * 用 `reply.autoPlan: false` 可以关掉。
   */
  captureGoAway(raw) {
    try {
      const cfg = loadConfig()
      if (cfg.reply?.autoPlan === false) return

      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (!/^send_(msg|private_msg|group_msg)$/.test(String(frame.action || ''))) return

      const segs = Array.isArray(frame.params?.message) ? frame.params.message : []
      const plain = segs
        .filter((s) => s && s.type === 'text')
        .map((s) => String(s.data?.text || ''))
        .join('\n')
      if (!plain.trim()) return

      const hit = detectGoAway(plain)
      if (!hit) return
      const saved = addPlanItem(hit)
      if (saved) {
        this.log(`她说要去「${saved.label}」了 → 状态改到 ${saved.from}-${saved.to}（busy ${saved.busy}）`)
      }
    } catch {
      /* 认不出来不影响发消息 */
    }
  }

  /**
   * 拦截「她自己重排的日程」。
   *
   * 面板上点「让她自己重排一天」会注入一条内部任务，她按约定回一个 JSON。
   * 这里把它拦下来写进 config.campus.routine，不发给 QQ —— 对方不该看到一坨 JSON。
   *
   * 为什么要容错：模型经常把 JSON 包在 ```json 围栏里，或者前面先来一句
   * 「好的，我排一下」。所以不要求整条都是 JSON，从第一个 { 到最后一个 } 抠出来就行。
   *
   * 校验从严：字段缺了、busy 越界、时间格式不对，整条丢弃（拒绝半截数据污染配置）。
   */
  captureRoutineJson(text) {
    let raw = ''
    let echo
    try {
      const frame = JSON.parse(text)
      const act = String(frame.action || '')
      if (!/^send_(msg|private_msg|group_msg)$/.test(act)) return null
      echo = frame.echo
      raw = (frame.params?.message || [])
        .filter((s) => s && s.type === 'text')
        .map((s) => String(s.data?.text || ''))
        .join('')
    } catch {
      return null
    }
    if (!raw || raw.indexOf('"slots"') < 0) return null

    const a = raw.indexOf('{')
    const b = raw.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    let obj
    try {
      obj = JSON.parse(raw.slice(a, b + 1))
    } catch {
      return null
    }
    if (!obj || !Array.isArray(obj.slots) || !obj.slots.length) return null

    const timeRe = /^\d{1,2}:\d{2}$/
    const norm = (list, kind) => {
      const out = []
      for (const x of list || []) {
        if (!x || !timeRe.test(String(x.from || '')) || !timeRe.test(String(x.to || ''))) continue
        const busy = Number(x.busy)
        if (!Number.isFinite(busy) || busy < 0 || busy > 2) continue
        const label = String(x.label || '').trim()
        if (!label) continue
        out.push({
          from: String(x.from),
          to: String(x.to),
          label,
          busy: Math.round(busy),
          line: String(x.line || `你现在在${kind === 'event' ? '' : ''}${label}`).trim()
        })
      }
      return out
    }

    const slots = norm(obj.slots, 'slot')
    const events = norm(obj.events, 'event')
    if (!slots.length) return null

    try {
      const cfg = loadConfig()
      // eventsPerDay 可能是 'auto'（让她自己定）。Number('auto') 是 NaN，
      // 直接过 Math.max/min 会把它写成 NaN —— 那就永远抽不出活动了。
      // 统一走 normalizeEventsPerDay，和面板保存、套用模板同一个规则。
      saveConfig({
        campus: {
          ...(cfg.campus || {}),
          routine: {
            version: 1,
            source: 'ai',
            slots,
            events,
            eventsPerDay: normalizeEventsPerDay(cfg.campus?.eventsPerDay ?? 1)
          }
        }
      })
      writePersona()
      return { ok: true, slotCount: slots.length, eventCount: events.length, echo }
    } catch (e) {
      this.log(`日程写入失败：${e.message}`)
      return null
    }
  }

  /**
   * 把入站的「表情段」翻译成模型能读的文字。
   *
   * 为什么必须在这层做：dsh 官方 onebot 插件里有一份编号→emoji 的表，
   * 但它用的是**老版 CQ 编号**，和 NTQQ 现在的编号对不上 ——
   * 13（呲牙）被映射成 😘、66（爱心）被映射成 😡、264（捂脸）表里没有落到 😀。
   * 超级表情（mface）更是完全不认，直接给模型一个 `[mface]`。
   * 结果模型以为对方在发暗号，反过来要求对方解释。
   *
   * 改成在面板这层把段替换成文字，插件收到的就是纯文本，不再二次映射。
   * 不动第三方包：升级 dsh 插件不会把我们的改动冲掉。
   */
  describeSegments(text, frame) {
    let next = text
    try {
      const parsed = JSON.parse(text)
      // 注意：这里处理的是**入站事件**（post_type/message 在顶层），
      // 不是出站的 action/params 结构。deliver() 交给 dsh 的就是入站帧。
      const msg = Array.isArray(parsed?.message) ? parsed.message : null
      if (!msg || !msg.length) return text
      let touched = false
      const out = msg.map((seg) => {
        if (!seg || typeof seg !== 'object') return seg
        const desc = describeFaceSeg(seg)
        if (!desc) return seg
        touched = true
        return { type: 'text', data: { text: desc } }
      })
      if (!touched) return text
      // 原地改 frame，后续逻辑（引用、分条）看到的就是同一份
      if (frame && Array.isArray(frame.message)) {
        frame.message = out
        if (typeof frame.raw_message === 'string') {
          frame.raw_message = out.map((s) => (s.type === 'text' ? s.data.text : '')).join('')
        }
      }
      parsed.message = out
      next = JSON.stringify(parsed)
    } catch {
      /* 不是 JSON 就原样放行 */
    }
    return next
  }

  deliver(text, frame, delay) {
    const go = async () => {
      // 记一条对方说的话，供「每日学词」当语料（内部注入会被 rememberSlang 过滤掉）
      this.rememberSlang('对方', frame?.raw_message || '')
      let payload = text
      try {
        payload = await this.localizeImages(text, frame)
      } catch (e) {
        this.log(`图片转述失败: ${e.message}`)
      }
      // 语音要在图片之后、表情之前：外部 ASR 也是把段换成文字，
      // 交给 describeSegments 之前换完，它就不用再判一次段类型。
      try {
        payload = await this.localizeVoice(payload, frame)
      } catch (e) {
        this.log(`语音转写失败: ${e.message}`)
      }
      // 图片处理完之后再翻表情：顺序反了的话，describeSegments 会把
      // localizeImages 刚换出来的 text 段当成自己的活儿，虽然不会出错但白跑一遍
      payload = this.describeSegments(payload, frame)
      this.forwardUp(payload, false)
    }
    if (!delay) {
      go()
      return
    }
    const at = Math.max(Date.now(), this.nextAt) + delay
    this.nextAt = at
    if (delay > 1500) this.log(`按回复节奏等待 ${Math.round(delay / 1000)} 秒后再交给模型`)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      go()
    }, at - Date.now())
    this.timers.add(timer)
  }

  /**
   * 图片消息处理。
   * - auto：主模型自带看图能力（deepseek-flash），原样放行；
   * - api ：主模型看不了图（如 v4-pro），先调外部多模态接口把图翻译成一句描述，
   *         再把图片段替换成文字，这样文本模型也能「看懂」；
   * - off ：把图片段替换成 [图片]，不耗 token。
   */
  async localizeImages(text, frame) {
    const cfg = loadConfig()
    const v = cfg.vision || {}
    let mode = v.mode || 'auto'
    /*
     * 「能力」页的总开关必须真的管得住外部调用。
     * 以前 features.vision 只影响面板文案，mode=api 时照样往外发图 ——
     * 关了开关还以为图片不出机器，其实一直在传第三方。
     * 只拦 api：auto 是把图交给自己的主模型，跟外部接口无关，不该被这个开关杀。
     */
    if (cfg.features?.vision === false && mode === 'api') {
      mode = 'off'
      this.log('图片识别总开关已关，跳过外部看图接口')
    }
    const segs = Array.isArray(frame?.message) ? frame.message : []
    const imgIdx = segs.map((s, i) => (s && s.type === 'image' ? i : -1)).filter((i) => i >= 0)
    if (!imgIdx.length) return text
    if (mode === 'auto') return text

    const out = segs.map((s) => ({ ...s, data: { ...(s.data || {}) } }))
    for (const i of imgIdx) {
      const seg = out[i]
      let desc = ''
      if (mode === 'api') {
        try {
          desc = await this.describeImage(seg.data?.url || seg.data?.file, v)
        } catch (e) {
          this.log(`看图接口失败: ${e.message}`)
        }
      }
      seg.type = 'text'
      seg.data = { text: desc ? `[图片：${desc}]` : '[图片]' }
    }
    const next = { ...frame, message: out, raw_message: out.map((s) => (s.type === 'text' ? s.data.text : '')).join(' ') }
    return JSON.stringify(next)
  }

  /**
   * 语音消息处理（外部 ASR）。
   *
   * 为什么放在面板层：插件自带的 STT 只能跑本地 whisper / 本机命令行，
   * 接不了云端接口。面板是唯一能同时拿到「语音文件」和「配置」的地方。
   *
   * 关键约束：**两条链路只能活一条**。
   * 选了 api 就由这里把 record 段换成文字，插件那边看得到的是 text，
   * 自然不会再转一遍；同时 renderPatch() 会把 sttEnabled 写成 false。
   * 双保险是必要的 —— 只靠其中一层，升级插件或改配置都可能让同一条语音
   * 被识别两次，第二次还会以 steer 形式补进上下文。
   *
   * 失败不抛给上层：识别不出来就退回 `[语音]`，跟没有这个功能时的行为一致，
   * 总比把整条消息吞掉好。
   */
  async localizeVoice(text, frame) {
    const cfg = loadConfig()
    const a = cfg.asr || {}
    if ((a.provider || 'local') !== 'api') return text
    if (cfg.features?.stt === false) return text
    if (!a.baseUrl || !a.model) return text

    const segs = Array.isArray(frame?.message) ? frame.message : []
    const idx = segs.map((s, i) => (s && s.type === 'record' ? i : -1)).filter((i) => i >= 0)
    if (!idx.length) return text

    const out = segs.map((s) => ({ ...s, data: { ...(s.data || {}) } }))
    for (const i of idx) {
      const seg = out[i]
      let said = ''
      try {
        const audio = await this.recordBuffer(seg.data?.file || seg.data?.url)
        said = await transcribeAudio(audio, a)
      } catch (e) {
        this.log(`外部语音识别失败，退回 [语音]：${e.message}`)
      }
      seg.type = 'text'
      seg.data = { text: said ? `[语音：${said}]` : '[语音]' }
    }
    const next = { ...frame, message: out, raw_message: out.map((s) => (s.type === 'text' ? s.data.text : '')).join(' ') }
    return JSON.stringify(next)
  }

  /**
   * 把一条语音引用换成音频字节。
   *
   * 三种来源都试：直接是 URL 就下；NapCat 的 get_record 可能给 base64；
   * 也可能给容器内的本地路径（宿主机通常读不到，这时如实失败让上层降级）。
   */
  async recordBuffer(ref) {
    if (!ref) throw new Error('语音引用为空')
    const grab = async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) throw new Error(`下载语音 HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length) throw new Error('语音内容为空')
      return buf
    }
    if (/^https?:\/\//i.test(ref)) return await grab(ref)

    const res = await this.sendAction('get_record', { file: ref, out_format: 'mp3' }, 30000)
    const data = res?.data || {}
    if (typeof data.base64 === 'string' && data.base64) {
      return Buffer.from(data.base64, 'base64')
    }
    const file = String(data.file || '')
    if (file && /^https?:\/\//i.test(file)) return await grab(file)
    if (file && path.isAbsolute(file) && fs.existsSync(file)) return fs.readFileSync(file)
    throw new Error('拿不到语音内容（NapCat 未返回 base64，本地路径对宿主机不可读）')
  }

  async describeImage(url, v) {
    if (!url) throw new Error('图片地址为空')
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(20000)
    })
    if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) throw new Error('图片为空')
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]
    const base = String(v.baseUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('未配置看图接口地址')
    const body = {
      model: v.model || 'deepseek-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: v.prompt || '用一两句话客观描述这张图片。' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
          ]
        }
      ],
      max_tokens: 300,
      stream: false
    }
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(v.apiKey ? { Authorization: `Bearer ${v.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`)
    return String(j.choices?.[0]?.message?.content || '').trim().slice(0, 200)
  }

  forwardUp(payload, isBinary) {
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      try {
        this.upstream.send(payload, { binary: isBinary })
        return
      } catch (e) {
        this.log(`转发失败: ${e.message}`)
      }
    }
    // 心跳 / 生命周期这类 meta 事件断线期间没有补投价值：OneBot 默认 30 秒一条，
    // 几分钟就能把 20 条的补投队列挤满，真正要发的消息反而被 shift 掉（2026-10-23）。
    if (!isBinary && isMetaEventPayload(payload)) return
    // dsh 重启那十秒里进来的消息，以前直接扔了（只在日志里留一句，用户完全没反应的机会）。
    // 现在先进队列，重连后补投；超过 15 秒的就不要了，免得重连时突然回一堆过时消息。
    if (!this.upQueue) this.upQueue = []
    this.upQueue.push({ payload, isBinary, at: Date.now() })
    if (this.upQueue.length > 20) this.upQueue.shift()
    this.log(`dsh 未连接，消息进队列（待投 ${this.upQueue.length} 条）`)
  }

  flushUpQueue() {
    if (!this.upQueue || !this.upQueue.length) return
    const now = Date.now()
    let sent = 0
    let dropped = 0
    while (this.upQueue.length) {
      const it = this.upQueue.shift()
      if (now - it.at > 15000) {
        dropped++
        continue
      }
      try {
        this.upstream.send(it.payload, { binary: it.isBinary })
        sent++
      } catch {
        /* 忽略，后面的也发不出去 */
      }
    }
    if (sent) this.log(`重连后补投 ${sent} 条消息`)
    if (dropped) this.log(`丢弃 ${dropped} 条过期消息（超过 15 秒）`)
  }

  ensureUpstream() {
    if (this.closed) return
    if (this.upstream && (this.upstream.readyState === WebSocket.OPEN || this.upstream.readyState === WebSocket.CONNECTING)) return
    const cfg = loadConfig()
    const url = `ws://127.0.0.1:${cfg.dsh.onebotPort}/ws`
    const headers = cfg.dsh.accessToken ? { Authorization: `Bearer ${cfg.dsh.accessToken}` } : {}
    let sock
    try {
      sock = new WebSocket(url, { headers, handshakeTimeout: 8000 })
    } catch (e) {
      this.log(`连接 dsh 失败: ${e.message}`)
      this.scheduleRetry()
      return
    }
    this.upstream = sock
    this.connectAt = Date.now()
    this.missedPings = 0

    sock.on('open', () => {
      this.log(`已连接 dsh: ${url}`)
      this.backoff = BACKOFF_MIN
      this.connectedAt = Date.now()
      this.missedPings = 0
      this.stats.reconnects++
      patchState({ dshConnected: true, dshSince: Date.now() })
      this.flushUpQueue()
    })

    sock.on('message', (data, isBinary) => {
      // 单条消息处理出错，绝不能让它把这条 WS 的接收流弄死：异常从 ws 的 message
      // 事件里抛出去以后，socket 之后的帧收不到、close 事件也不来，重连链路彻底停摆
      // （2026-10-23 线上：一条 ReferenceError 让面板「假在线」20 多分钟）。
      try {
      this.stats.outbound++
      if (isBinary) {
        this.toNapcat(data, true)
        return
      }

      let text = data.toString()

      // 0) 插件自动发的「任务运行中 / 已排队」提示，直接丢掉，别让它出现在聊天里。
      //    必须自己回一个成功响应，否则插件那边会等到 30 秒超时。
      const notice = this.systemNoticePlan(text)
      if (notice) {
        this.log(`已拦截系统提示：${notice.text.slice(0, 30)}`)
        if (notice.frame.echo !== undefined) {
          const ack = {
            status: 'ok',
            retcode: 0,
            data: { message_id: Date.now() % 100000000 },
            echo: notice.frame.echo
          }
          this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
        }
        return
      }

      // 0.5) 它发出去的消息里如果带着库里的图，记一笔账（面板上「它今天发几张」就用这个）
      this.accountOutboundStickers(text)

      // 0.6) 她按面板要求重排日程时会回一个 JSON —— 拦下来写进配置，别发到聊天里。
      //      这是「让大模型自己设计一天」的落地方式：模型只管出创意，落库和校验我们做。
      const routine = this.captureRoutineJson(text)
      if (routine) {
        this.log(`收到她自己排的日程：${routine.slotCount} 段 + ${routine.eventCount} 个活动`)
        if (routine.echo !== undefined) {
          const ack = {
            status: 'ok',
            retcode: 0,
            data: { message_id: Date.now() % 100000000 },
            echo: routine.echo
          }
          this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
        }
        return
      }

      // 0.7) 她说了「我先去写作业了」「我这边慢慢磨」这类话 —— 替她把状态改掉。
      //
      //      人格里早就吩咐过让她自己 `qq-routine add` 记一笔，但从上线到现在一次都没记过
      //      （`campus-plan.json` 从没被创建）。结果就是用户看到的那一幕：
      //      20:54 说「我这边慢慢磨」→ 20:58 岔题聊橘猫（状态机还以为她在闲逛）→ 20:59 才说要去写作业。
      //      提示管不住的事，这里兜一层。
      this.captureGoAway(text)

      // 0.8) 她说了「我想学吉他」「下次想去爬山」—— 把这件事加进她自己的活动池。
      //      活动池原来只有模板那十来条，翻来覆去就那几件；这条让她能长出新的爱好。
      this.captureWish(text)

      // 0.9) 小黄脸频率：这条按概率决定带不带表情（剥在拆段之前做，才数得准）
      text = this.applyFaceRate(text)

      // 1) 先把 [face:14] 拆成真正的表情段（必须在算字数之前，表情不算打字量）
      const rewritten = expandFaceMarks(text)
      if (rewritten !== text) {
        text = rewritten
        data = Buffer.from(text, 'utf8')
      }

      const send = (payload, ms) => {
        // 走统一调度：排在上一轮未发完的消息之后，至少隔 800ms。
        // 这一层是「语义混杂、顺序不对」的根治点 —— 之前每条消息各自 setTimeout，
        // 上一轮的补发链还没走完，新一轮的首条就已经插进去了。
        let key = ''
        try {
          key = this.outKey(JSON.parse(text))
        } catch {
          key = ''
        }
        if (!key) {
          // 认不出会话就退化成原来的行为，别因为一个解析失败卡住消息
          this.toNapcat(payload, false)
          return
        }
        const waited = this.scheduleOut(key, payload, ms, 800)
        if (waited > ms + 500) {
          this.log(`上一条还没发完，这条排到 ${(waited / 1000).toFixed(1)} 秒后再发`)
        }
      }

      // 2) 长回复拆成多条：首条按打字速度发，剩下的按节奏补齐
      // 整条重发（重启/重试/重跑）直接丢，别在聊天里刷重复气泡
      let outFrame = null
      try {
        outFrame = JSON.parse(text)
      } catch {
        outFrame = null
      }
      // 注意：plain 必须声明在 if (outFrame) 外面 —— 下面 3181 左右「记语料」那步
      // 在块外也要用它。曾经因为缩进把它声明进了块里，线上每条出站消息都抛
      // `ReferenceError: plain is not defined`，消息一条都没发出去（2026-10-23）。
      let plain = ''
      if (outFrame) {
        plain = (outFrame.params?.message || [])
          .filter((x) => x && x.type === 'text')
          .map((x) => String(x.data?.text || ''))
          .join('')

        // 说说那边的回执：`[已发] 正文` / `[不发]`。
        // 这些是「说说的旁白」，绝不能发到聊天里 —— 否则你会收到一条「[已发] 今天下雨了」。
        const qz = parseQzoneReceipt(plain)
        if (qz) {
          const posted = qz.posted
          const body = qz.text
          if (posted && this.qzoneHook) {
            try {
              this.qzoneHook({ text: body, at: Date.now() })
            } catch {
              /* 记账失败不影响别的 */
            }
          }
          this.log(posted ? `说说已发：${body.slice(0, 24) || '（正文没回传）'}` : '她今天不想发说说')
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 对话状态评估的回执：`[[对话状态]] {JSON}`。
        // proactive 沉默到阈值时注入的内部评估，她只回这一行 —— 拦下来交给
        // convStateHook 存档调倍率，本体吞掉不发（否则你会收到一行 JSON）。
        // 解析失败（格式跑偏）就当没看见：宁可不追问，也不能把坏数据当真。
        const csEval = parseConvState(plain)
        if (csEval) {
          if (this.convStateHook) {
            try {
              this.convStateHook(csEval)
            } catch {
              /* 存档失败不影响别的 */
            }
          }
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 学词任务的回执：`[[学词]] {"words":[...]}`。
        // 和 `[[对话状态]]` 同一套：整条吞掉、不外发、必须回 ack。
        const learn = parseLearnReceipt(plain)
        if (learn) {
          this.log(`学词回执：${learn.words.length} 个候选${learn.words.length ? '（' + learn.words.slice(0, 6).join('、') + '）' : ''}`)
          if (learn.words.length && this.slangHook) {
            try {
              this.slangHook({ words: learn.words, evidence: [] })
            } catch (e) {
              this.log(`生词入库失败：${e.message}`)
            }
          }
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 研究任务的回执：`[[释义]] [{word,meaning,...}]`。整条吞掉，交给 hook 回填含义。
        const mean = parseMeaningReceipt(plain)
        if (mean) {
          this.log(`释义回执：${mean.items.length} 条`)
          if (this.slangHook) {
            try {
              this.slangHook({ kind: 'meanings', items: mean.items })
            } catch (e) {
              this.log(`释义入库失败：${e.message}`)
            }
          }
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        /*
         * 兜底：plain 以 `[[学词]]` / `[[释义]]` 开头但 JSON 解析失败（格式跑偏）。
         * 上面两个 parse 都会返回 null，然后这条就继续往下走、**原样发到聊天里**——
         * 对方会收到一行 `[[学词]] {"words":...}`。和 [[对话状态]] 一样，
         * 「格式坏了」也必须吞掉并回 ack，宁可这次没学到词。
         */
        if (/^\s*\[\[\s*(学词|释义)\s*\]\]/.test(plain)) {
          this.log('内部回执格式异常，已丢弃（避免泄漏到聊天）')
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 它自己决定「这条不回」的暗号：走积压消息时允许它挑着回，
        // 剩下不值得回的就输出 [[跳过]]。我们吞掉不发，但**必须回 ack**，
        // 否则插件那边会等到 30 秒超时，聊天里还会冒报错。
        if (/^\s*\[\[?\s*跳过\s*\]?\]\s*$/.test(plain)) {
          this.log('它判断这条不用回，已跳过')
          this.stats.skipped = (this.stats.skipped || 0) + 1
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 整条重复的窗口放宽到 10 分钟：整段一模一样的回复，正常聊天里不会故意再来一遍
        if (plain && this.isDuplicate(outFrame, plain, 600 * 1000)) {
          this.log(`丢弃重复回复：${plain.slice(0, 24)}…`)
          if (outFrame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }
      }

      // 把「思考草稿」剥掉再发。
      // 她偶尔会把写给自己看的推演一起塞进正文（英文批注、「2 lines」、「Respond lightly: …」），
      // 分条逻辑会把这些切成碎片发出去，对方看到的就是几句英文加半截中文。
      if (outFrame) {
        const cleaned = this.stripDraftFrame(outFrame)
        if (cleaned.changed) {
          outFrame = cleaned.frame
          text = JSON.stringify(outFrame)
          data = Buffer.from(text, 'utf8')
          if (!cleaned.text.trim()) {
            this.log(`整条都是思考草稿（剥掉 ${cleaned.dropped} 处），不发`)
            if (outFrame.echo !== undefined) {
              const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
              this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
            }
            return
          }
          this.log(`剥掉 ${cleaned.dropped} 处思考草稿`)
        }
      }

      // 生词标记：`[[生词：yyds|绝绝子]]` / `[[生词]] yyds|绝绝子`。
      // 放在引用之前剥 —— 两者互不影响，但都要赶在分条之前处理完。
      // **任意位置都剥**，剥完没正文就整条不发，绝不让标记出现在对方屏幕上。
      if (outFrame) {
        const sl = this.extractSlangMarks(outFrame)
        if (sl.hit) {
          outFrame = sl.frame
          text = JSON.stringify(outFrame)
          data = Buffer.from(text, 'utf8')
          if (!Array.isArray(outFrame.params.message) || !outFrame.params.message.length) {
            this.log('只剩生词标记，这条不发')
            if (outFrame.echo !== undefined) {
              const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
              this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
            }
            return
          }
          if (sl.words.length) {
            this.log(`她报告生词 ${sl.words.length} 个：${sl.words.slice(0, 6).join('、')}`)
            if (this.slangHook) {
              try {
                this.slangHook({ words: sl.words, evidence: [] })
              } catch (e) {
                this.log(`生词入库失败：${e.message}`)
              }
            }
          }
        }
      }

      // 引用：模型用 [[引用 N]] 指定「我回的是合并里的第几条」。
      // 放在分条之前处理 —— 分条会把文本切碎，标记被切开就认不出来了。
      if (outFrame) {
        const q = this.applyQuote(outFrame)
        if (q.quoted || q.dropped) {
          outFrame = q.frame
          if (!Array.isArray(outFrame.params.message) || !outFrame.params.message.length) {
            this.log('引用之后没有正文了，这条不发')
            if (outFrame.echo !== undefined) {
              const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: outFrame.echo }
              this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
            }
            return
          }
          text = JSON.stringify(outFrame)
          data = Buffer.from(text, 'utf8')
          if (q.quoted) {
            this.log(
              `引用第 ${q.n} 条消息回复` + (q.removed > 1 ? `（另剥掉 ${q.removed - 1} 个多余标记）` : '')
            )
          } else if (q.reason === 'off') this.log('引用功能已关闭，去掉标记照常发')
          else if (q.reason === 'extra') this.log(`剥掉正文里多余的 ${q.removed} 个引用标记`)
          else this.log(`引用序号 ${q.n} 查不到（可能已过期），去掉标记照常发`)
        }
      }

      // 到这里就是要真的发出去了：记一笔「她刚说过话」。
      // 主动搭话、她先开的话题都靠这一笔，让你接下来的回复按「正在聊」处理。
      this.markChatSpoke(outFrame)
      // 顺带留一份语料给「每日学词」用（只记纯文本，不带标记）
      this.rememberSlang('她', plain)

      const plan = this.splitPlan(text)
      if (plan) {
        // 整条判重：dsh 偶尔把同一条回复发两遍。只要这轮和上轮几乎一样就整条丢弃，
        // 连补发队列都不启动 —— 否则两条链交错，对方收到的顺序就乱了。
        // 注意必须回 ack：不然 dsh 收不到响应会重试，重复反而更多。
        if (this.sameReplyAsLast(plan.frame, plan.parts)) {
          this.log(`整条回复重复，丢弃这一轮（${plan.parts.length} 条）`)
          if (plan.frame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: plan.frame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }

        // 引用段必须在最前面（QQ 只认消息开头的 reply 段），然后才是正文
        const firstMsg = []
        if (plan.quoteSegs?.length) firstMsg.push(...plan.quoteSegs)
        firstMsg.push({ type: 'text', data: { text: plan.parts[0] } })
        if (plan.parts.length === 1 && plan.tailSegs?.length) firstMsg.push(...plan.tailSegs)
        const first = {
          ...plan.frame,
          params: { ...plan.frame.params, message: firstMsg }
        }
        const firstText = String(plan.parts[0] || '')
        if (countTypedChars(firstText) >= 6 && this.isDuplicate(first, firstText, 90 * 1000)) {
          // 首条已经是逐条去重的兜底；这里也整条停掉，别再起补发链
          this.log(`丢弃重复分条（整轮跳过）：${firstText.slice(0, 20)}…`)
          if (plan.frame.echo !== undefined) {
            const ack = { status: 'ok', retcode: 0, data: { message_id: Date.now() % 100000000 }, echo: plan.frame.echo }
            this.forwardUp(Buffer.from(JSON.stringify(ack), 'utf8'), false)
          }
          return
        }
        // 整轮一次排完（不是发一条排一条）—— 顺序才不会在新一轮到来时错位
        this.scheduleRound(plan, this.typingDelayFor(JSON.stringify(first)))
        this.tailPatch(text)
        return
      }

      // 3) 不拆：按整条字数模拟打字，只作用于发消息类 action
      const typingMs = this.typingDelayFor(text)
      send(data, typingMs)
      if (outFrame) this.armAutoSticker(outFrame, typingMs + 1500)
      this.tailPatch(text)
      } catch (e) {
        this.log(`处理 dsh 消息失败: ${e.stack || e.message}`)
      }
    })

    const fail = (why) => {
      // 旧连接迟到的 close/error：新连接已经建好了，别把它连坐掉
      if (this.upstream && this.upstream !== sock) return
      this.log(`dsh 连接中断: ${why}`)
      patchState({ dshConnected: false })
      this.upstream = null
      this.scheduleRetry()
    }
    sock.on('close', () => fail('closed'))
    sock.on('error', (e) => fail(e.message))
    sock.on('pong', () => {
      this.missedPings = 0
    })
  }

  /**
   * 上游（dsh）健康检查，每 20 秒一次。
   *
   * 为什么必须有这个闹钟：2026-10-23 的事故里，出站回调抛异常把 ws 接收流弄坏，
   * `close` 再也没到过，`fail()` 一次都没执行 —— 于是重连定时器根本没挂上，
   * 面板就这么「以为还连着」空等了 20 多分钟（state.json 里 dshConnected 仍是 true）。
   * 光靠被动等 close 不可靠，得主动探活：
   *   1. 没有连接 / 已经 CLOSED —— 直接重连（兜住丢失的 close 事件）；
   *   2. 卡在 CONNECTING 超过 20 秒 —— 掐掉重来；
   *   3. OPEN 但连续 3 次 ping 没有 pong —— 判定半死连接，主动断开重连。
   */
  checkUpstream() {
    if (this.closed) return
    const sock = this.upstream
    if (!sock || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
      // 已经有重连定时器在排队就交给它，避免和退避逻辑各开一条连接
      if (!this.retryTimer) this.ensureUpstream()
      return
    }
    if (sock.readyState === WebSocket.CONNECTING) {
      if (this.connectAt && Date.now() - this.connectAt > 20000) {
        this.log('dsh 连接卡在握手阶段，重置')
        try {
          sock.terminate()
        } catch {
          /* ignore */
        }
        if (this.upstream === sock) this.upstream = null
        this.scheduleRetry()
      }
      return
    }
    if (this.missedPings >= 3) {
      this.log('dsh 上游连续 3 次 ping 无响应，判定连接已死，重连')
      this.missedPings = 0
      try {
        sock.terminate()
      } catch {
        /* ignore */
      }
      if (this.upstream === sock) this.upstream = null
      patchState({ dshConnected: false })
      this.scheduleRetry()
      return
    }
    try {
      sock.ping()
      this.missedPings = (this.missedPings || 0) + 1
    } catch {
      /* ping 发不出去说明连接已经坏了，下一轮会按 CLOSED 处理 */
    }
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.ensureUpstream()
    }, wait)
  }

  bumpDropped() {
    const key = todayKey()
    const st = getState()
    const daily = { ...(st.daily || {}) }
    const d = daily[key] || { inbound: 0, forwarded: 0, dropped: 0 }
    d.dropped = (d.dropped || 0) + 1
    daily[key] = d
    patchState({ daily })
    this.persistCounters()
  }

  persistCounters() {
    const key = todayKey()
    const st = getState()
    const daily = { ...(st.daily || {}) }
    const d = daily[key] || { inbound: 0, forwarded: 0, dropped: 0 }
    const total = {
      inbound: this.stats.inbound,
      forwarded: this.stats.forwarded,
      dropped: this.stats.dropped
    }
    daily[key] = { ...d, ...total }
    patchState({ daily, proxyStats: total })
  }

  stopServer() {
    try {
      this.wss?.close()
    } catch {
      /* ignore */
    }
    try {
      this.napcatSock?.close()
    } catch {
      /* ignore */
    }
    this.wss = null
    this.napcatSock = null
  }

  stop() {
    this.closed = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    clearInterval(this.healthTimer)
    this.healthTimer = null
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const b of this.inbox.values()) clearTimeout(b.timer)
    this.inbox.clear()
    this.nextAt = 0
    try {
      this.upstream?.close()
    } catch {
      /* ignore */
    }
    this.stopServer()
  }

  status() {
    const cfg = loadConfig()
    return {
      listening: Boolean(this.wss),
      port: cfg.proxy.port,
      napcat: Boolean(this.napcatSock && this.napcatSock.readyState === WebSocket.OPEN),
      dsh: Boolean(this.upstream && this.upstream.readyState === WebSocket.OPEN),
      upstream: `ws://127.0.0.1:${cfg.dsh.onebotPort}/ws`,
      stats: this.stats,
      connectedAt: this.connectedAt,
      lastEvent: this.lastEvent,
      blocked: this.blockedList(),
      contacts: this.contactMap()
    }
  }
}

export function createProxy(logger) {
  return new Proxy(logger)
}

// 供离线测试用（tools/merge_test.mjs 之类），不影响运行
export { chunkReplyText, expandFaceMarks, looksLikeSystemNotice, looksLikeMetaComment }
