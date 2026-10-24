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

  /*
   * 状态机关闭 = 「随时在线」。
   *
   * 这时候她不该有任何「在忙 / 在睡 / 刚醒」的概念，所以整套分档逻辑
   * （instantRate / mix / nightSlow / busy 抬档）一律不参与 ——
   * 尤其 nightSlow 是唯一还在**按钟点**变慢的地方，关掉状态机后它必须失效，
   * 否则会出现「面板说没有状态，凌晨却还是拖 6 分钟」这种自相矛盾。
   *
   * 但也不能真的 0 延迟（那是机器人特征）。改成一个「打字延迟」：
   * 按字数估，80ms 一个字，夹在 800ms ~ 3s 之间，再加一点抖动。
   * 短句不秒出，长句也不会拖到让人以为掉线。
   *
   * 注意顺序：这一步在 p.enabled 判断**之后** ——
   * 「生活节奏」总开关仍然是最高优先级，关掉它就是 0 延迟，尊重那个语义。
   */
  if (cfg?.campus?.enabled === false) {
    const n = Math.max(0, Number(ctx.chars) || 0)
    const base = Math.min(3000, Math.max(800, n * 80))
    return { delayMs: Math.max(300, Math.round(base + rand(-150, 400))), band: 'typing', skip: false }
  }

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

/* ---------------- 连发合并：smart 模式 ---------------- */

/*
 * 为什么是个启发式，而不是「让大模型判断说完没」：
 *
 * 模型是 reasoningEffort=high（全局配置，不能按请求降），判断一次就要 3~5 秒，
 * 再把 5 秒上限一套，几乎所有消息都会被拖到 5 秒 —— 比原来的固定窗口还慢，
 * 而且每轮多一次带完整上下文的调用，成本翻倍。
 *
 * 所以先用零成本的启发式：看句尾。它不完美，但满足核心诉求
 * 「别再靠固定时间猜」，而且慢不了、贵不了。
 * 真觉得判不准，再考虑上模型（那就得先把判断的推理强度降下来）。
 */

/** 结尾是这些词，话明显没落地（"我今天去…" 的下一句还没来） */
const TAIL_CONNECTORS =
  /(然后|但是|不过|因为|所以|如果|而且|还有|以及|或者|就是说|那个|这个|感觉|觉得|我们|你们|他们|她们|自己)$/u

/** 悬空的虚词结尾。只在句子整体不长时才算「没说完」，否则「我知道的」会被误判 */
const TAIL_DANGLING = /(的|了|在|是|和|跟|把|被|给|对|从|到|着|过|又|还|也|都|就|才|刚|正)$/u

/** 短、但是**完整**的应答。这些必须算「说完了」，否则每一句"好的"都要等 5 秒 */
const SHORT_COMPLETE =
  /^(好|好的|好哒|好嘞|行|行吧|嗯|嗯嗯|嗯呢|哦|噢|喔|啊|呀|哈|哈哈|哈哈哈|对|对的|是|是的|可以|没事|算了|知道了|收到|明白|了解|ok|okay|666)$/iu

/**
 * 这条消息**看起来**说完了没。
 *
 * 返回 true = 明显没说完（该等后续），false = 当作说完了（可以回）。
 *
 * 判断原则是**保守**：默认说完了，只有抓到明确证据才说没说完。
 * 因为判错的代价不对称 ——
 *   · 把「没说完」判成「说完了」→ 她抢话，很尴尬
 *   · 把「说完了」判成「没说完」→ 多等几秒，还有 5 秒上限兜着，不致命
 * 所以规则都往"别抢话"那边偏一点点，但绝不能让常见短句（好的/嗯）掉进等待里。
 */
export function looksIncomplete(text) {
  const t = String(text || '').trim()
  // 空消息（纯图片/表情/语音）没什么"说完没"可言，直接放行
  if (!t) return false

  // 1) 句末标点 → 明确说完了
  if (/[。！？!?…~～)）」』"'\]]$/u.test(t)) return false

  // 2) 逗号、顿号、分号、破折号结尾 → 话说一半
  if (/[，,、；;：:—-]$/u.test(t)) return true

  // 3) 常见短应答 → 算说完（必须排在"极短就没说完"前面）
  if (SHORT_COMPLETE.test(t)) return false

  // 4) 连接词/悬空词结尾 → 话没落地
  if (TAIL_CONNECTORS.test(t)) return true

  // 5) 去掉空白与标点后还剩几个字
  const core = t.replace(/[\s\p{P}\p{S}]/gu, '')

  // 6) 只剩一两个字、又没句末标点 → 多半是打到一半（"我刚" "然后"）
  if (core.length <= 2) return true

  // 7) 虚词结尾且整句很短（「我觉得」3 字 → 等；「这个我知道的」6 字 → 放行）
  //
  // 阈值定 5 不是拍脑袋：6 字的句子已经能表达完整意思了（「这个我知道的」），
  // 再往大放就会把正常短句全拖进 5 秒等待。
  if (TAIL_DANGLING.test(t) && core.length <= 5) return true

  return false
}

/**
 * smart 模式下这条消息该压多久（毫秒）。
 *
 * 说完 → coalesceSmartMinMs（默认 800ms，留一点打字缓冲，别抢话）
 * 没说完 → coalesceSmartMaxMs（默认 5000ms；期间来新消息会重新计时）
 */
export function smartWindowMs(cfg, text) {
  const r = cfg?.reply || {}
  const minMs = Math.max(100, Number(r.coalesceSmartMinMs ?? 800))
  const maxMs = Math.max(minMs, Number(r.coalesceSmartMaxMs ?? 5000))
  return looksIncomplete(text) ? maxMs : minMs
}

export { BANDS, DEFAULTS }
