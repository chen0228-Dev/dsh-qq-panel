/**
 * 回复节奏引擎。
 *
 * 为什么要有这一层：现在的延迟天花板是「打字模拟」那 6 秒，
 * 因为回复必须在 OneBot 一个 action 的 30 秒超时内交出去。
 * 所以它永远秒回 —— 这是最强的一条机器人信号。
 *
 * 解法不是把发送推迟（那要改 ack 协议），而是**把交付推迟**：
 * 消息先在我们手里压一会儿，到点才交给模型，模型看完立刻回。
 * 你体感是「它过一会儿才回」，架构上却一点没动。
 *
 * 顺带解决两件事：
 * 1. 压着的这段时间里后续消息会一起攒着，到点合并成一条交给模型，
 *    让它自己判断哪几条值得回（真人就是这样看积压消息的）；
 * 2. 纯表情、单字、纯标点这类可以直接判成「不值得回」，
 *    连 token 都不花。
 */

/** 四档延迟。单位毫秒，取的是区间不是定值 —— 真人不会每次隔一样久 */
const BANDS = {
  instant: [0, 0],
  short: [20_000, 80_000],
  mid: [120_000, 360_000],
  long: [480_000, 1_500_000]
}

const DEFAULTS = {
  enabled: true,
  // instant 全秒回 / mix 按比例随机 / life 没在聊就一定拖
  mode: 'mix',
  // mix 模式下秒回的概率
  instantRate: 45,
  // 不秒回时，落到 short/mid/long 的比例
  mix: [0.6, 0.3, 0.1],
  // 深夜（0-6 点）额外变慢
  nightSlow: true,
  // 「不值得回」的消息直接不交给模型
  skipLowValue: true
}

function rand(a, b) {
  return a + Math.random() * (b - a)
}

function pickBand(probs) {
  const r = Math.random()
  if (r < probs[0]) return 'short'
  if (r < probs[0] + probs[1]) return 'mid'
  return 'long'
}

/**
 * 判断一条消息值不值得回。
 *
 * 只在**纯文本**上判断。图片、语音、文件一律当作有意义 ——
 * 图片里可能是一张截图、一段报错，我们这边断了它就等于瞎了。
 *
 * 保守到近乎刻薄也没关系：判错（该回没回）的代价是「它没理你」，
 * 这本来就是我们要的效果；判漏（废话回了）只是浪费一点 token。
 */
/** 这几个短句是「在找人」，不是废话，必须回 */
const ASK_WORDS = new Set(['在吗', '在不在', '在么', '人呢', '你好', '早安', '晚安', '有人吗', '喂喂'])

export function isLowValue(text) {
  const t = String(text || '').trim()
  if (!t) return true
  // 去空白和标点后还剩几个字
  const core = t.replace(/[\s\p{P}\p{S}]/gu, '')
  if (!core) return true
  if (core.length <= 1) return true
  // 纯语气词 / 笑声 / 复读
  if (/^[哈呵嘿嘻嗯哦噢喔啊呀诶欸额呃唔草靠]+$/u.test(core)) return true
  // 问句、打招呼一律算有内容。漏判的代价是「它不理你」，而这几种最容易被察觉
  if (ASK_WORDS.has(core)) return false
  if (/[吗嘛呢吧么]$/u.test(core)) return false
  // 纯数字多半是「666」这种捧场，或随便敲的；数字夹着字才是信息（「3点半」）
  if (/^\d+$/.test(core)) return true
  if (/\d|[A-Za-z]/.test(core)) return false
  // 短、又没有上面任何信号 → 当废话（「好的」「行」「666」这类收尾话）
  if (core.length <= 3) return true
  return false
}

/**
 * 算这条消息该压多久。
 *
 * ctx.chatting：3 分钟内刚有过来往 —— 正在聊，就该快，这时候拖 5 分钟很出戏
 * ctx.unanswered：之前连着判了几条「不值得回」（判满 3 条就强制回，免得真晾着）
 * ctx.hour：本地小时，深夜更慢
 */
export function planPace(cfg, ctx = {}) {
  const p = { ...DEFAULTS, ...((cfg && cfg.reply && cfg.reply.pace) || {}) }
  const hour = Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours()
  const night = hour >= 0 && hour < 7

  if (p.enabled === false) return { delayMs: 0, band: 'instant', skip: false }

  // 正在聊：只做打字级的微延迟，绝不能拖到分钟
  if (ctx.chatting) {
    return { delayMs: Math.round(rand(1200, 6000)), band: 'instant', skip: false }
  }

  let band = 'instant'
  if (p.mode === 'life') {
    band = pickBand(p.mix || DEFAULTS.mix)
  } else if (p.mode !== 'instant') {
    // mix：多数时候秒回，偶尔拖一下，才不会显得刻意
    const rate = Math.max(0, Math.min(100, Number(p.instantRate ?? DEFAULTS.instantRate)))
    band = Math.random() * 100 < rate ? 'instant' : pickBand(p.mix || DEFAULTS.mix)
  }

  // 深夜：秒回档直接抬到 mid，其余整体 ×1.5
  if (night && p.nightSlow !== false) {
    if (band === 'instant') band = 'mid'
    else if (band === 'short') band = 'mid'
  }

  // 她的状态：上课 / 自习 / 睡着了 —— 这几个档位不该秒回，哪怕抽到了 instant。
  // 注意只在「没在聊」时生效：正在聊的时候她已经在偷偷回你了，再拖就很假。
  const busy = Number(ctx.busy) || 0
  if (!ctx.chatting) {
    if (busy >= 3) {
      band = 'long' // 睡着了，最慢
    } else if (busy === 2) {
      if (band === 'instant' || band === 'short') band = 'mid'
    } else if (busy === 1) {
      if (band === 'instant' && Math.random() < 0.5) band = 'short'
    }
  }

  const [lo, hi] = BANDS[band] || BANDS.instant
  let delayMs = band === 'instant' ? 0 : Math.round(rand(lo, hi))
  if (night && p.nightSlow !== false && delayMs) delayMs = Math.round(delayMs * 1.5)

  // 连着判了 3 条不回，就别再拖了 —— 「已读不回」也要有下限
  const unanswered = Number(ctx.unanswered) || 0
  if (unanswered >= 3) return { delayMs: 0, band: 'instant', skip: false, forced: true }

  return { delayMs, band, skip: false }
}

export { BANDS, DEFAULTS }
