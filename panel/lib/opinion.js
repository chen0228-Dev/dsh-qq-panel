/**
 * 独立观点：让她在被问看法时给态度，而不是「各有优劣」。
 *
 * 为什么需要：她最像客服的地方不是措辞，是**从不表态**。
 * 「取决于你的需求」「看个人习惯」「两方面都有道理」—— 这种话没人会跟朋友说。
 * 真人会说「我不喜欢 X，因为 Y」，说完就停。
 *
 * 立场分两层：
 *
 * 1. **天生的**（`stances-builtin.js`）：她本来就有的一批偏好，写在代码里，不会变。
 * 2. **自己记的**（`data/stances.json`）：日常聊出来、或者上网搜到什么之后形成的看法。
 *    用 `qq-stance` 命令记，和 AGENTS.local.md 一个思路 —— 她自己的东西，她自己维护。
 *
 * 两个原则：
 * - **立场固定**：聊到同一件事永远同一个说法。今天说讨厌香菜、明天说好吃，比没有立场更假。
 * - **只注入素材**：给的是「你对这件事的态度」，说法由她自己组织。
 *
 * 边界（写死在代码里，不靠模型自觉）：
 * 政治、民族、宗教、领土主权这类话题，**不注入任何立场**，让人格里那条
 * 「这个我不聊」的规则去处理。这是产品边界，不是技术限制。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './store.js'
import { STANCES } from './stances-builtin.js'

/** 她自己记的立场最多存这么多条。超过就不再收，让她先删。 */
export const MAX_DYNAMIC = 40

/**
 * 这些话题**不注入立场**。
 *
 * 不是判断敏感与否，是产品边界：她是个私人聊天对象，但没有任何理由在这种话题上站队。
 * 人格里有一条「这个我不聊」，这里让那条规则生效，别把素材递过去。
 */
const NO_STANCE_RE = /(政治|政府|政党|执政|选举|体制|民族|宗教|信仰|教会|领土|主权|两岸|统一|港澳|国家政策|战争|军队|外交)/

/** 在问看法 */
const ASK_RE = /(你觉得|你认为|你怎么看|你怎么想|你觉得呢|喜欢吗|喜不喜欢|讨厌吗|好不好|值得吗|怎么样|你会选|你会怎么选|有道理吗|同意吗|你说是吧|你站哪边)/

function dynFile() {
  return path.join(DATA_DIR, 'stances.json')
}

/* ---------------- 她自己记的立场 ---------------- */

/**
 * 缓存按 mtime 失效 —— 文件是她用 `qq-stance`（Python 进程）写的。
 * 纯内存缓存的话，她刚记完这边还看不到。
 */
let dynCache = { mtime: 0, items: [] }

export function loadDynamic() {
  try {
    const st = fs.statSync(dynFile())
    if (st.mtimeMs !== dynCache.mtime) {
      const d = JSON.parse(fs.readFileSync(dynFile(), 'utf8'))
      const items = Array.isArray(d.items) ? d.items : []
      dynCache = {
        mtime: st.mtimeMs,
        items: items.filter((x) => x && x.id && Array.isArray(x.tags) && x.take)
      }
    }
  } catch {
    dynCache = { mtime: 0, items: [] }
  }
  return dynCache.items
}

function saveDynamic(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(dynFile(), JSON.stringify({ items }, null, 1))
    dynCache = { mtime: 0, items }
  } catch {
    /* 写不进去就当没记，不影响聊天 */
  }
}

/** 内置 + 自己记的，统一成同一种形状 */
export function allStances() {
  return [
    ...STANCES.map((s) => ({ ...s, builtin: true })),
    ...loadDynamic().map((s) => ({ ...s, builtin: false }))
  ]
}

/** 面板删掉某条自己记的立场 */
export function deleteStance(id) {
  const items = loadDynamic()
  const next = items.filter((x) => String(x.id) !== String(id))
  if (next.length === items.length) return { ok: false, reason: 'not-found' }
  saveDynamic(next)
  return { ok: true, left: next.length }
}

/* ---------------- 表态记录 ---------------- */

/** 进程内状态；文件只作持久化副本（Windows 下删文件偶尔失败，见 assoc.js 里的说明） */
let mem = null

function blank() {
  return { last: null, count: 0, used: [] }
}

function loadState() {
  if (mem) return { ...mem, used: [...mem.used] }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'opinions.json'), 'utf8'))
    mem = {
      last: d.last && typeof d.last === 'object' ? d.last : null,
      count: Number(d.count) || 0,
      used: Array.isArray(d.used) ? d.used : []
    }
  } catch {
    mem = blank()
  }
  return { ...mem, used: [...mem.used] }
}

function saveState(s) {
  mem = { last: s.last || null, count: Number(s.count) || 0, used: [...(s.used || [])].slice(-20) }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, 'opinions.json'), JSON.stringify(mem, null, 1))
  } catch {
    /* 落盘失败不影响聊天 */
  }
}

/* ---------------- 对外 ---------------- */

/** 这条消息是不是在问看法（测试和面板都会用到） */
export function isAskingOpinion(text) {
  return ASK_RE.test(String(text || ''))
}

/** 命中了哪几条立场（内置 + 自己记的） */
export function matchStances(text) {
  const t = String(text || '')
  if (!t.trim() || NO_STANCE_RE.test(t)) return []
  return allStances().filter((s) => s.tags.some((tag) => t.includes(tag)))
}

/**
 * 生成注入文本。返回 '' 表示这条不给「表态许可」。
 *
 * @param {object} cfg  config
 * @param {object} opts { text }
 */
export function opinionLine(cfg, opts = {}) {
  const o = cfg?.reply?.opinion || {}
  if (o.enabled === false) return ''

  const text = String(opts.text || '')
  if (!text.trim()) return ''

  // 边界话题：不递素材，让人格里那条硬规则接管
  if (NO_STANCE_RE.test(text)) return ''

  const asking = ASK_RE.test(text)
  const hits = matchStances(text)
  if (!asking && !hits.length) return ''

  const chance = Math.max(0, Math.min(100, Number(o.chance ?? 70)))
  // 只是「碰到相关话题」而不是在问看法时，收敛一些 —— 不然她每条都要评价两句
  const effective = asking ? chance : chance * 0.45
  if (Math.random() * 100 >= effective) return ''

  // 命中立场时从没用过的里面挑，避免翻来覆去说同一件
  const s = loadState()
  let pick = null
  if (hits.length) {
    const usedSet = new Set(s.used || [])
    const fresh = hits.filter((h) => !usedSet.has(h.id))
    const pool = fresh.length ? fresh : hits
    pick = pool[Math.floor(Math.random() * pool.length)]
  }

  const lines = ['【这条要表态，别和稀泥（内部提示，别向对方解释这句）】']
  if (pick) {
    lines.push(`- 说到这个你一直是这个态度（别改口）：**${pick.take}**。理由是：${pick.why || '（你自己的判断）'}。`)
    lines.push('- 用你自己的话说一遍，别照抄；一句话给态度、一句话给理由，说完就停。')
  } else {
    lines.push('- 他在问你的看法。你有看法，直接给：**先说结论，再说一句为什么**。')
    lines.push('- 你以前聊到过类似的事就保持一致；没聊过就按你的性格直接判断，别打太极。')
  }
  lines.push(
    '- **禁止**这些词：各有优劣 / 取决于 / 因人而异 / 看个人 / 两方面都有道理 / 没有绝对的对错。',
    '- 可以不同意他，但别讽刺人、别说教、别上升到人身。'
  )

  saveState({
    last: pick
      ? { topic: text.slice(0, 20), take: pick.take }
      : { topic: text.slice(0, 20), take: '（临时判断，没押在固定立场上）' },
    count: (s.count || 0) + 1,
    used: pick ? [...(s.used || []), pick.id] : s.used || []
  })

  return lines.join('\n') + '\n'
}

/** 面板用：她的全部立场 + 最近一次表态 */
export function opinionInfo() {
  const s = loadState()
  const dynamic = loadDynamic()
  const usedSet = new Set(s.used || [])
  return {
    last: s.last,
    count: s.count,
    total: STANCES.length + dynamic.length,
    builtinCount: STANCES.length,
    // builtin=true 是天生就有的（面板上不给删），false 是她自己记的（可删）
    stances: allStances().map((x) => ({
      id: x.id,
      tags: x.tags,
      take: x.take,
      why: x.why || '',
      builtin: x.builtin,
      at: x.at || 0,
      src: x.src || '',
      used: usedSet.has(x.id)
    }))
  }
}

/** 重置表态记录（测试用）：内存和文件一起清 */
export function resetOpinions() {
  mem = blank()
  try {
    fs.unlinkSync(path.join(DATA_DIR, 'opinions.json'))
  } catch {
    /* 内存已清，文件删不掉也不影响 */
  }
}

/** 重置她自己记的立场（测试用） */
export function resetDynamic() {
  dynCache = { mtime: 0, items: [] }
  try {
    fs.unlinkSync(dynFile())
  } catch {
    /* 同上 */
  }
}
