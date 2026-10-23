import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, loadConfig, saveConfig } from './store.js'
import { campusState } from './campus.js'
import { countStickers } from './stickers.js'

const STATE = path.join(DATA_DIR, 'proactive.json')
const TICK_MS = 30_000
const USED_MAX = 24

/**
 * 主动开口的话题池。
 *
 * 每条 hints 写的是**素材碎片**，不是句子指令 ——
 * 「电梯等了八分钟」比「抱怨一下今天的小倒霉事」更容易让它写出一句人话，
 * 连着几天也不会说成一模一样的话（旧版 4 类一共 14 句，几天就转一圈）。
 *
 * when：允许出现的小时区间，支持跨午夜（如 [22, 2]）。
 * net：这类话题可能需要联网查，受 hotDailyMax 额度限制。
 * solo：允许只发一张表情包、一个字都不说。
 */
const TOPICS = {
  complain: {
    label: '发牢骚',
    when: [7, 24],
    hints: [
      '电梯等了八分钟',
      '外卖送到已经凉了',
      '找半天钥匙，发现插在门上',
      '今天湿度大得头发全塌了',
      '电脑风扇吵得像要起飞',
      '半夜醒了三次',
      '脑子不好使，刚说的话转头就忘',
      '袜子找不到另一只',
      '充了一晚上电，结果没插上'
    ]
  },
  daily: {
    label: '讲日常',
    when: [7, 24],
    hints: [
      '刚吃了一碗很难吃的面',
      '在图书馆坐到腰疼',
      '洗完衣服忘了晾',
      '下午睡了一觉起来更困',
      '刚把桌面收拾干净',
      '今天走了两万步',
      '泡了杯茶放到凉',
      '拖了三天的地终于拖了'
    ]
  },
  ask: {
    label: '问你在干嘛',
    when: [8, 24],
    hints: [
      '这个点在忙还是摸鱼',
      '今天课多不多',
      '饭吃了吗',
      '在不在',
      '今晚打算几点睡',
      '周末有没有安排',
      '最近作业堆了多少'
    ]
  },
  share: {
    label: '分享心情',
    when: [9, 24],
    hints: [
      '突然觉得有点空',
      '今天心情莫名不错',
      '刚想到一个很蠢的问题',
      '有点想找人说话',
      '刚被一件小事戳到了',
      '突然很想吃某个东西'
    ]
  },
  hot: {
    label: '热点/梗',
    when: [9, 23],
    net: true,
    hints: ['今天网上在吵什么', '最近哪个梗在火', '热搜上有什么', '某个突然火起来的东西', '新出的游戏/剧/歌']
  },
  interest: {
    label: '聊你在意的',
    when: [9, 24],
    hints: [
      '他那台 ROV 上位机做到哪一步了',
      'Unity 那个项目最近有没有推进',
      '数据库实验做到哪了',
      '算法作业里卡住的那个点',
      'Android 打包那套工具链',
      '他最近在学的新东西',
      '他之前提过想学的技术'
    ]
  },
  recall: {
    label: '翻旧账',
    when: [9, 24],
    hints: [
      '他上次说要补的东西',
      '约好但还没做的那件事',
      '他提过在发愁的事',
      '上次没聊完的话题',
      '他说过想试试的东西'
    ]
  },
  bored: {
    label: '闲得慌',
    when: [10, 24],
    solo: true,
    hints: ['就是想戳一下他', '没事干随便发点什么', '丢张表情包就跑', '无聊到想找人说废话', '忽然想起来还有这么个人']
  },
  opinion: {
    label: '征求意见',
    when: [10, 23],
    hints: ['两件小事让他选', '问他觉得某个东西怎么样', '让他帮忙出个主意', '问问他有没有更好的办法']
  },
  /**
   * 续聊（2026-10-23 新增）。
   *
   * 平时权重给 0 —— 没有未结束的对话时，「接着刚才聊」无从谈起。
   * 只有当状态评估（assessConversation）判定「这段聊天还没聊完」时，
   * check() 才会把它的权重临时乘上 continueBoost，让它有大概率被抽中。
   * 其他话题倍率保持 1.0 —— 人的思维会发散，她也可能不接茬而扯别的。
   */
  continue: {
    label: '接着聊没聊完的',
    when: [7, 24],
    hints: [
      '接着刚才那茬继续说',
      '他刚才问的那个还没答完',
      '刚才的话题还有下文',
      '把刚才没说完的补上',
      '刚才聊到一半他 disappeared，提一嘴'
    ]
  }
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function inWindow(from, to, now = new Date()) {
  const a = toMin(from)
  const b = toMin(to)
  if (a === null || b === null) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  if (a === b) return true
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

/**
 * 一个时间窗有多长（毫秒），支持跨午夜（22:00-02:00 = 4 小时）。
 *
 * 用途：说说「每天最多几条」要算两次之间的最小间隔 —— 间隔 = 窗口 ÷ 条数。
 * 不这么算的话，max=3 时 tick 一到就会连着问三次。
 */
function windowLengthMs(from, to) {
  const a = toMin(from)
  const b = toMin(to)
  if (a === null || b === null || a === b) return 8 * 3600_000
  const mins = b > a ? b - a : b + 1440 - a
  return Math.max(30 * 60_000, mins * 60_000)
}

/** 小时区间判断，支持 [22, 2] 这种跨午夜写法 */
function inHours(range, hour) {
  if (!Array.isArray(range)) return true
  const [a, b] = range
  if (a === b) return true
  return a < b ? hour >= a && hour < b : hour >= a || hour < b
}

function loadState() {
  let s
  try {
    s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    s = {}
  }
  if (!Array.isArray(s.hours)) s.hours = new Array(24).fill(0)
  if (!Array.isArray(s.usedHints)) s.usedHints = []
  return { lastAt: 0, day: '', count: 0, hotUsed: 0, ...s }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
}

function shuffle(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 抽素材：优先挑没讲过的。
 *
 * 重复感的根源不是「话题选重了」，而是「同一件小事又讲了一遍」。
 * 所以这里记的是**用过的素材句子**，而不是话题标签。
 */
function drawHints(topic, state, n) {
  const all = []
  for (const [k, t] of Object.entries(TOPICS)) {
    for (const h of t.hints) all.push({ h, k })
  }
  const used = new Set(state.usedHints || [])
  const fresh = all.filter((x) => !used.has(x.h))
  // 全用过了就清零重来，不然会一直抽不到东西
  if (fresh.length < 6) {
    state.usedHints = []
    return drawHints(topic, state, n)
  }
  const own = shuffle(fresh.filter((x) => x.k === topic))
  const other = shuffle(fresh.filter((x) => x.k !== topic))
  // 2 条本类 + 1 条别类：留一点「思绪飘到别处」的混搭感，但主体还得是本类
  const picked = [...own.slice(0, 2)]
  if (picked.length < n) picked.push(...other.slice(0, n - picked.length))
  else if (other.length) picked.push(other[0])
  return picked.slice(0, n).map((x) => x.h)
}

/**
 * 权重兜底。
 *
 * 线上 config.json 里存的是旧版那 4 类的权重，deepMerge 只补顶层键、
 * 不会往 weights 里加新类 —— 不兜底的话新增的 5 类权重是 undefined，
 * 等于永远抽不到，「话题变多」这个改动完全没效果。
 */
const DEFAULT_WEIGHTS = {
  complain: 3,
  daily: 3,
  ask: 2,
  share: 2,
  hot: 2,
  interest: 2,
  recall: 2,
  bored: 1,
  opinion: 1
}

function mergedWeights(p) {
  const raw = (p && p.weights) || {}
  const out = {}
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    out[k] = k in raw ? Number(raw[k]) || 0 : DEFAULT_WEIGHTS[k]
  }
  return out
}

/** 按权重抽话题。连续两次同类的会被压低，避免「三天都在发牢骚」。
 * （导出是为了让 tests/proactive-test.mjs 能直接验证时段过滤和降权）
 */
export function pickTopic(weights, hour, lastTopics = []) {
  const entries = Object.entries(weights || {}).filter(([k, w]) => {
    if (!(Number(w) > 0)) return false
    const t = TOPICS[k]
    return t ? inHours(t.when, hour) : false
  })
  if (!entries.length) return 'ask'
  const scored = entries.map(([k, w]) => {
    let v = Number(w)
    // 上一条就是同类 → 压到 1/5；再往前两次内出现过 → 打六折。
    // 压到 1/5 是试出来的：0.35 在「抱怨 10 : 日常 2」这种极端配置下，
    // 同类仍然占 63%，等于没压。
    if (lastTopics[0] === k) v *= 0.2
    else if (lastTopics[1] === k || lastTopics[2] === k) v *= 0.6
    return [k, Math.max(0.01, v)]
  })
  const total = scored.reduce((a, [, w]) => a + w, 0)
  let r = Math.random() * total
  for (const [k, w] of scored) {
    r -= w
    if (r <= 0) return k
  }
  return scored[0][0]
}

/**
 * 主动开口时允许它顺手丢一张表情包。
 *
 * 按 `freq` 抽签，而不是每条都提示 —— 提示越多它越容易滥用，
 * 与其事后拦不如事前不说。
 */
function maybeStickerHint(cfg) {
  const s = cfg.stickers || {}
  if (s.enabled === false) return null
  const f = Number(s.freq) || 0
  if (f <= 0) return null
  try {
    // 库是空的就别提，提了它也没图可发
    if (countStickers() === 0) return null
  } catch {
    return null
  }
  return f >= 60 || Math.random() * 100 < f
    ? '如果想发，也可以顺手发一张表情包（`qq-sticker` 挑一张最贴现在心情的），但别把它当成主要内容 —— 开口说话才是重点。'
    : null
}

function nowLabel(now) {
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${wk} ${hh}:${mm}`
}

/**
 * 拼注入文本。
 *
 * 设计上的关键取舍：**不给它指定话题，只给素材**。
 * 旧版是「把话题往 complain 带：抱怨一下电梯」——它只能照做，像个提词器。
 * 现在给的是几片碎片 + 一句「你自己想」，它挑哪片、说不说、扯到哪儿去都由它。
 * 代价是内容更不可控，所以下面那些「别列清单/别提这条提示」的红线一条都没少。
 */
function buildPrompt(topic, cfg, state, opts = {}) {
  const t = TOPICS[topic] || TOPICS.ask
  const p = cfg.proactive || {}
  const now = opts.now || new Date()
  const hints = drawHints(topic, state, 2)

  const cs = campusState(cfg, now)
  // 续聊的开场白和常规搭话不同：不是「一阵子没说话」，而是「刚才聊到一半」
  const opener = opts.ongoing
    ? `（内部触发：现在 ${nowLabel(now)}，你们刚才聊到一半他没再回，你觉得可能还没聊完，想接上。）`
    : `（内部触发：现在 ${nowLabel(now)}，你有一阵子没跟他说话了，想主动开口。）`
  const lines = [
    opener,
    `你现在的状态：${cs.line}。开口前先想想这个状态合不合适说话。`,
    '',
    '**先自己想**：心里过一遍 —— 你们最近聊到哪儿了、他这两天在忙什么、你刚才突然想到什么。' +
      '想两三件，挑一件最想说的，再开口。**想的过程别写出来，直接说话。**',
    '',
    '素材（只是碎片，用来提醒你「可以说这类事」，不想用就无视，也可以用你自己的）：'
  ]
  for (const h of hints) lines.push(`  · ${h}`)

  lines.push(
    '',
    t.solo
      ? '要求：一到三句话，或者干脆只发张图也行，像平时发消息那样自然。别列清单，别问「有什么可以帮你」，' +
          '不要提到这条提示、也不要解释你为什么突然找他。'
      : '要求：一到三句话，像平时发消息那样自然。别列清单，别问「有什么可以帮你」，' +
          '不要提到这条提示、也不要解释你为什么突然找他。'
  )

  // 翻旧账：他选了「记得都可以提」，所以不设时间限制，只约束范围
  lines.push('- 如果你们有没聊完的事（他说过要做/答应过的、在发愁的），可以自然地追问一句，别硬追。')

  const recent = (state.usedHints || []).slice(-6)
  if (recent.length) {
    lines.push(`- 这几件事你最近已经提过了，别再说同一件：${recent.join('｜')}`)
  }

  // 联网额度：额度用完了就不再提示它查，免得它自己硬查
  if (t.net) {
    const cap = Number(p.hotDailyMax) || 0
    const left = cap > 0 ? Math.max(0, cap - (state.hotUsed || 0)) : 0
    if (left > 0 && !opts.noNet) {
      lines.push(
        `- 想知道今天到底在聊什么，可以先 \`qq-search "今天 热点"\` 或搜他可能感兴趣的词，查完再开口` +
          `（今天还能查 ${left} 次，别浪费）。`
      )
    } else {
      lines.push('- 这类话题今天不查网了，凭你已有的印象说，别编具体数字和日期。')
    }
  }

  // 只发图：他明确要了「闲得没事丢张图」，但不限次的话会变成刷图，
  // 所以这里仍然受「每天最多几条」的总闸约束
  if (t.solo && p.soloSticker !== false) {
    lines.push('- 实在没话说，只丢一张表情包也行，一个字都不用说（`qq-sticker` 挑一张就走）。')
  }

  if (p.allowVoice) {
    lines.push('如果这句话适合用语音说（比如吐槽、嘀咕），可以发一条语音；平时还是打字。')
  }
  const sticker = maybeStickerHint(cfg)
  if (sticker) lines.push(sticker)
  return lines.join('\n')
}

/**
 * 对话状态评估的注入文本（2026-10-23 新增）。
 *
 * 让她**自己**判断「这段聊天结束了没 + 什么情绪氛围」—— 不找关键词，
 * 中文表达千变万化，「我先去趟超市」和「我去忙了」算不算结束，只有模型说得清。
 *
 * 输出约定为一行 `[[对话状态]] {JSON}`，出站层（proxy.js）拦截解析后存进
 * proactive state，**绝不会发到聊天里** —— 和 qzone 的 `[不发]`、`[[跳过]]` 同一套机制。
 * 解析失败按 {ended:true, mood:'normal'} 兜底：宁可少追问，不要误追。
 */
function buildAssessPrompt() {
  return [
    '（内部任务，不要发任何聊天消息。）',
    '回顾你们最近的对话，判断两件事，然后**只输出一行**，格式严格如下：',
    '[[对话状态]] {"ended": true, "mood": "normal"}',
    '',
    'ended（true/false）：这段聊天是否已经自然结束 —— 比如有一方说了要去忙/休息/睡觉、',
    '话题明显收尾、互道了晚安之类。**由你自己综合判断，不要机械地找关键词**；拿不准就当还没结束。',
    'mood（六选一）：当前对话的情绪氛围 ——',
    '  angry = 刚吵完架还在气头上；sad = 一方在难过低落；cold = 对方回复冷淡敷衍；',
    '  normal = 平常聊天；happy = 聊得开心愉快；excited = 聊得特别热络起劲。',
    '',
    '再强调一次：只输出那一行 [[对话状态]] ...，别的什么都不写。'
  ].join('\n')
}

/* ------------------------------------------------------------------
 * QQ 空间说说
 *
 * 和主动消息是两件事：说说是**写给自己看的**，不是发给某个人的消息。
 * 所以这里一条「你」都不许出现、不许提问、不许 @ 人。
 * 旧版是一句写死的指令（「20-40 字，随手发的日常感想」），
 * 结果每条都是同一个味道：既不生活，也不像她。
 * 现在改成三段式：先看今天值不值得记 → 再决定发不发 → 发的话配一段素材和一种口气。
 * ------------------------------------------------------------------ */

/** 三条口气，短中长都有。真人不会每条都一个长度 */
const QZONE_STYLES = [
  { key: 'one', hint: '一句话，8-18 字。随手一发的口吻，不解释、不升华、不总结' },
  { key: 'two', hint: '两三句，25-50 字。带一个具体的小细节（几点、在哪、谁说了什么、天气怎么样）' },
  { key: 'long', hint: '碎碎念，60-90 字。可以东一句西一句，想到哪写到哪，最后不用收尾' }
]

/** 素材池：学生日常里「值得记一句」的小事，不是聊天话题 */
const QZONE_IDEAS = [
  '早八的教室，前排永远空着',
  '食堂新开的那个窗口居然还挺好吃',
  '图书馆抢到的位置，一坐下就不想动',
  '小组作业，最后又是我一个人在做',
  '稿子改到第五版，越改越不知道自己写的是啥',
  '室友凌晨还在打电话，戴着耳机也挡不住',
  '今天这个天气，出门就是受罪',
  '路边的猫今天让摸了',
  '一首歌循环了一整天',
  '突然有点想家',
  '晚饭吃太饱，走两步就喘',
  '洗澡排了半小时队',
  '终于把那件事做完了',
  '莫名其妙就很开心，说不出为什么',
  '今天什么也没干，就这样过完了',
  '手机电量撑不到晚上，跟我的精神状态一样',
  '背书背到第三页，前面两页已经忘了',
  '下课后在走廊站了一会儿，风挺大的',
  '看到一片很好看的云，没拍下来',
  '今天没化妆，戴个口罩就出门了'
]

function pickStyle() {
  return QZONE_STYLES[Math.floor(Math.random() * QZONE_STYLES.length)]
}

function qzoneLogFile() {
  return path.join(DATA_DIR, 'qzone.json')
}

function loadQzoneLog() {
  try {
    const d = JSON.parse(fs.readFileSync(qzoneLogFile(), 'utf8'))
    return { posts: Array.isArray(d.posts) ? d.posts : [] }
  } catch {
    return { posts: [] }
  }
}

function saveQzoneLog(d) {
  try {
    fs.writeFileSync(qzoneLogFile(), JSON.stringify(d, null, 2))
  } catch {
    /* ignore */
  }
}

/** 从表情库里挑一张当配图候选。不用最近发过的，免得一周三张同一个脸 */
/** 这次要不要配图（按面板概率抽一次） */
function wantZoneImage(cfg) {
  const pct = Number(cfg.qzone?.imageChance ?? 30)
  return pct > 0 && Math.random() * 100 < pct
}

/** 从表情库里挑一张候选（不决定用不用，只是给她一个现成选项） */
function pickZoneImage(cfg, log) {
  try {
    const dir = cfg.paths?.stickers
    if (!dir) return null
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    const used = new Set((log.posts || []).map((p) => p.img).filter(Boolean))
    const names = Object.keys(idx).filter((n) => !used.has(n))
    if (!names.length) return null
    // 优先没用过的；都发过了就随便挑一张
    const name = names[Math.floor(Math.random() * names.length)]
    const meta = idx[name] || {}
    const tags = Array.isArray(meta.tags) ? meta.tags.slice(0, 3).join('、') : ''
    return { name, path: path.join(dir, name), tags }
  } catch {
    return null
  }
}

/**
 * 忙里偷闲时主动说一句。
 *
 * 这个和正常主动搭话不是一回事：她只有几分钟，说完就得回去。
 * 所以提示词要强调「短」「别开新话题」「别问需要马上回的问题」——
 * 否则她会抛个问题出去，然后自己消失，比不发还伤人。
 */
function buildSneakPrompt(cfg, cs, at) {
  const now = at || new Date()
  const left = Math.max(1, Number(cs.minutesLeft) || 3)
  // 「她本来在干嘛」。原来这里是 `cs.label === '图书馆摸鱼' ? '图书馆' : '上课'`，
  // 只对学生成立 —— 上班族开会偷闲会被说成「你正在上课」，小朋友兴趣班也同理。
  // 现在优先用活动名（活动里的偷闲带 event），其次用状态机给的忙碌说法。
  const where = cs.event || cs.busyLabel || '忙自己的事'
  return [
    `（内部触发：现在 ${nowLabel(now)}，你正在${where}，` +
      `刚好偷到 ${left} 分钟空当，想跟他说一句。）`,
    `你现在的状态：${cs.line}。`,
    '',
    '就这几分钟：说一两句，短的。可以是突然想他了、吐槽手头这件事、刚看到的一个小东西 —— 什么都行。',
    '要求：',
    '- 别报备「我只有几分钟」这种话，除非你平时就会这么说。',
    '- 别开新话题、别问需要他马上回的问题 —— 你发完就要回去忙了。',
    '- 别解释这条提示，也别提你是在「偷闲」。',
    '- 一到两句话，像平时发消息那样。'
  ].join('\n')
}

/** 按她此刻的状态给两个搜图关键词 —— 她自己也会改，这只是个起点 */
const PIC_HINTS = {
  sleep: ['深夜 台灯', '窗外 夜色'],
  rush: ['清晨 校园', '早晨 教学楼'],
  class: ['校园 窗边', '课桌 阳光'],
  break: ['校园 小路', '秋天 树叶'],
  'after-class': ['走廊 光', '傍晚 教学楼'],
  lunch: ['食堂 餐盘', '街边 小店'],
  dinner: ['傍晚 天空', '路灯 街道'],
  nap: ['午后 阳光 桌角', '窗帘 光影'],
  lib: ['图书馆 书桌', '台灯 笔记本'],
  evening: ['傍晚 天空', '夜晚 城市 灯火'],
  dorm: ['夜晚 台灯', '被子 手机 光'],
  lightsout: ['深夜 手机 光', '黑暗 窗户'],
  ddl: ['电脑 桌面 咖啡', '深夜 屏幕'],
  'weekend-wake': ['周末 阳光 床', '早餐 桌'],
  weekend: ['周末 慵懒 阳光', '公园 长椅'],
  'weekend-lunch': ['外卖 餐盒', '午后 街道'],
  'weekend-night': ['夜晚 电影 屏幕', '夜宵 灯'],
  afternoon: ['下午 阳光 窗', '书 咖啡 桌']
}

/**
 * 拼说说提示词。
 * 关键改动：**允许她决定不发** —— 「今天没什么想说的」是最真实的一种状态，
 * 每天都发一条反而像打卡。
 */
export function buildQzonePrompt(cfg, log, img) {
  const now = new Date()
  const st = campusState(cfg, now)
  const style = pickStyle()
  const ideas = []
  const pool = QZONE_IDEAS.slice()
  for (let i = 0; i < 2 && pool.length; i++) {
    ideas.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  const recent = (log.posts || []).slice(-3).map((p) => String(p.text || '').slice(0, 18)).filter(Boolean)
  const picHints = PIC_HINTS[st.key] || ['秋天 落叶', '天空 云']

  const lines = [
    `（内部触发：现在 ${nowLabel(now)}。你在想今天要不要发条说说。）`,
    '',
    '**先想，再决定发不发**：回头看看今天 —— 你们聊过什么、你自己这一天过得怎么样。',
    '- 要是有哪件小事想记下来，就写成一条说说发出去。',
    '- 要是今天很平，没什么非说不可的，就干脆不发。这不奇怪，不用勉强凑一条。',
    '',
    `如果发，就用这种口气：${style.hint}。`
  ]

  lines.push('', '可以写的方向（只是提醒，不该写就换别的）：')
  for (const i of ideas) lines.push(`  · ${i}`)

  lines.push(
    '',
    `现在：${st.line}。`,
    '',
    '**发说说的规矩（和发消息完全不一样）：**',
    '- 这是写给自己看的，不是跟谁说话：不要出现「你」，不要提问，不要 @ 任何人，别用平时称呼他的词。',
    '- 不要每句都感悟、升华、鸡汤。多数时候就是记一件小事，写完就完了。',
    '- 别用书面语和排比句，别配颜文字大礼包。'
  )

  if (recent.length) {
    lines.push(`- 最近发过这些，别写重复的意思：${recent.join('｜')}`)
  }

  // 配图：两种都可以 —— 自己上网搜一张贴合的，或者用表情库里现成那张。
  // 以前只给表情包，等于把「配图」限定成「发表情」，说说的味道就偏了。
  const wantImg = Boolean(img && img.want)
  const sticker = img && img.sticker
  if (wantImg) {
    lines.push('', '**配图（可选，不配也完全没问题）**：')
    lines.push(
      '- 想配一张「今天的感觉」，自己搜：`qq-pic "关键词"`。它会下好图并打印 `[配图] <路径>`，' +
        '把那个路径填进 `--image`。'
    )
    lines.push(`  关键词按此刻的心情挑，比如「${picHints[0]}」「${picHints[1]}」。`)
    lines.push('- 搜图别搜人（人像、自拍、明星都不行）—— 说说配一张陌生人正脸很怪。')
    if (sticker) {
      lines.push(`- 也可以直接发表情库这张（更随意、更像随手发的）：${sticker.path}`)
    }
    lines.push('- 文案和配图对不上，比不配更难看。搭不上就别配。')
  }

  lines.push(
    '',
    '做法：在终端执行 `qq-zone "正文"`' + (wantImg ? '（配图再加 `--image <图片路径>`）' : ''),
    '发完只回我一行：`[已发] 正文`。',
    '决定不发就只回我 `[不发]`，什么都不用解释。',
    '不管发不发，都不要再往聊天里发别的话。'
  )

  return lines.join('\n')
}

export function createProactive(proxy, logger, opts = {}) {
  const log = logger || (() => {})
  // 时钟做成可注入的：测试要能把时间停在某个偷闲窗口里验行为，
  // 线上永远走 new Date()，不会有别的后果。
  const clock = typeof opts.now === 'function' ? opts.now : () => new Date()
  let timer = null
  let nextGap = null
  // 这次说说是配的哪张图 —— 发出去后要记进账本，免得下周还是同一张
  let pendingZoneImage = null

  const randGap = (cfg) => {
    const a = Math.max(5, Number(cfg.proactive.minGap) || 90)
    const b = Math.max(a + 5, Number(cfg.proactive.maxGap) || 240)
    return (a + Math.random() * (b - a)) * 60_000
  }

  /**
   * 你平时哪个点最常回消息。
   *
   * 数据不够时（样本 < 40）直接返回 1，不参与调整 —— 不然头两天它会
   * 照着两三条消息猜你的作息，反而更怪。
   */
  function activityFactor(cfg, st, now) {
    if (cfg.proactive?.learnHours === false) return 1
    const hours = st.hours || []
    const total = hours.reduce((a, b) => a + b, 0)
    if (total < 40) return 1
    const max = Math.max(...hours)
    if (!max) return 1
    const cur = hours[now.getHours()] || 0
    // 你活跃的时段它更积极一点，冷清时段拉长间隔
    return cur >= max * 0.6 ? 0.75 : 1.2
  }

  function checkQzone(cfg, st, now) {
    const q = cfg.qzone || {}
    if (!q.enabled || !q.autoEnabled) return false

    // 说说跟随「主动消息」总开关。
    // 原来它俩完全独立：用户把主动搭话关了，说说照样每天冒出来 —— 关掉"别来打扰我"
    // 却还在被推内容，这个体感是矛盾的。想单独发说说就先开主动消息。
    if (!cfg.proactive?.enabled) return false

    if (!inWindow(q.autoFrom, q.autoTo, now)) return false

    const day = todayKey(now)
    try {
      const qlog = loadQzoneLog()

      // 每天最多几条。原来只看 `q.lastDay === day`，等于硬性一天一条 ——
      // 面板上那个「每天最多几条说说」改了完全没效果（死配置）。
      const max = Math.max(1, Math.min(5, Number(q.autoDailyMax) || 1))
      const postedToday = (qlog.posts || []).filter((p) => {
        const t = Number(p.at) || 0
        return t > 0 && todayKey(new Date(t)) === day
      }).length
      if (postedToday >= max) return false

      // 两次之间要隔开，否则 tick 一到就连续问三次（max>1 时）。
      // 间隔 = 活跃窗口 ÷ 每天条数，最少一小时。
      const gapMs = Math.max(60 * 60_000, Math.floor(windowLengthMs(q.autoFrom, q.autoTo) / max))
      if (q.lastAt && now.getTime() - Number(q.lastAt) < gapMs) return false

      // 先抽「这次要不要配图」，再给两个选项：自己上网搜，或者用表情库这张
      const wantImg = wantZoneImage(cfg)
      const img = wantImg ? pickZoneImage(cfg, qlog) : null
      pendingZoneImage = img ? img.name : null
      proxy.injectPrivateMessage(buildQzonePrompt(cfg, qlog, { want: wantImg, sticker: img }), {
        selfId: st.botQQ || cfg.qq.botQQ
      })
      saveConfig({ qzone: { lastAt: Date.now(), lastDay: day } })
      log(`已问她今天要不要发说说（今天第 ${postedToday + 1}/${max} 次，她可以决定不发）`)
      return true
    } catch (e) {
      log(`自动说说失败: ${e.message}`)
      return false
    }
  }

  function check() {
    const cfg = loadConfig()
    if (!cfg.qq.adminQQ) return

    const st = proxy.status()
    if (!st.napcat || !st.dsh) return

    const now = clock()

    // 免打扰时段：对方的消息不进模型，她也别主动开口（说说也算主动）。
    // 原来 AGENTS.md 里写了「这个时间段你也不主动发」，但代码完全没检查 ——
    // 提示管不住的事就得代码兜：半夜三点她突然发条「睡了吗」是最破坏体感的。
    if (cfg.reply?.quiet?.enabled && inWindow(cfg.reply.quiet.from, cfg.reply.quiet.to, now)) return

    // 说说（要说在主动消息之前判断：它有自己的时间和条数限制）
    if (checkQzone(cfg, st, now)) return

    const p = cfg.proactive || {}
    if (!p.enabled) return
    if (!inWindow(p.activeFrom, p.activeTo, now)) return

    // 状态机也管主动搭话：上课、自习、睡着了的时候不主动起话。
    // 她自己刚说过「在上课呢」，一分钟后又主动找你聊天 —— 这种矛盾比秒回慢更假。
    const cs = campusState(cfg, now)
    if (cs.busy >= 2) return

    const day = todayKey(now)
    let s = loadState()
    if (s.day !== day) {
      s = { ...s, day, count: 0, hotUsed: 0, sneakCount: 0, sneakWin: '' }
      saveState(s)
    }
    if (s.count >= (Number(p.dailyMax) || 6)) return

    // 忙里偷闲：上课/图书馆的空档里主动说一句。
    //
    // 这一条故意放在「间隔」判断之前 —— 空档只有 2-5 分钟，
    // 用 90 分钟的常规间隔去卡，永远卡不上，等于没这功能。
    // 但同一个窗口只发一次（sneakWin 记住窗口 id），免得她在这几分钟里刷屏。
    if (cs.sneak && p.sneakEnabled !== false) {
      const cap = Number(p.sneakDailyMax ?? 2)
      const chance = Number(p.sneakChance ?? 60)
      const fresh = s.sneakWin !== cs.windowId
      if (fresh && (s.sneakCount || 0) < cap && Math.random() * 100 < chance) {
        try {
          proxy.injectPrivateMessage(buildSneakPrompt(cfg, cs, now), { selfId: st.botQQ || cfg.qq.botQQ })
          s.sneakWin = cs.windowId
          s.sneakCount = (s.sneakCount || 0) + 1
          s.count = (s.count || 0) + 1
          s.lastAt = Date.now()
          s.day = day
          saveState(s)
          log(`课间偷闲，主动说了一句（今日第 ${s.sneakCount} 次）`)
          nextGap = randGap(cfg)
          return
        } catch (e) {
          log(`偷闲消息失败: ${e.message}`)
        }
      }
    }

    // ---- 未结束对话的提前追问（2026-10-23 新增）----
    //
    // 现有机制只知道「用户沉默多久了」（idleMinutes），不知道「聊天结束了没」——
    // 聊到一半对方消失，她也会傻等到点再从池子挑个新话题，接不上刚才的茬。
    //
    // 这里让**大模型自己**判断（不找关键词）：沉默超过 continueThreshold 分钟时
    // 注入一次内部评估，她输出 [[对话状态]] {ended, mood}（出站层拦截，不外发）。
    // 判定「还没聊完」→ 不等 idleMinutes，直接用「续聊」话题接上；
    // mood 同时作为间隔倍率（在气头上就晚点开口）。
    //
    // 状态机 busy>=2、免打扰、时段窗口、每日上限都在本函数开头挡过了 —— 这里天然继承。
    const adminLastTs = typeof proxy.lastUserAtFor === 'function' ? proxy.lastUserAtFor(cfg.qq.adminQQ) : proxy.lastUserAt
    const thrMs = Math.max(1, Number(p.continueThreshold) || 5) * 60_000
    const silence = adminLastTs ? Date.now() - adminLastTs : Infinity

    // 每轮（以最后一条用户消息的时间戳为界）只评估一次
    if (adminLastTs && silence >= thrMs && s.lastAssessFor !== adminLastTs) {
      try {
        proxy.injectPrivateMessage(buildAssessPrompt(), { selfId: st.botQQ || cfg.qq.botQQ })
        s.lastAssessFor = adminLastTs
        saveState(s)
        log('已让她评估当前对话状态（是否结束/情绪氛围）')
      } catch (e) {
        log(`对话状态评估失败: ${e.message}`)
      }
    }

    // 评估结果「还没聊完」→ 立即接上（每轮只追一次，防话痨）。
    // conv.for 必须等于当前这轮的 adminLastTs —— 用户一旦回了新消息，旧评估自动作废。
    const conv = s.convState
    const convFresh = conv && Date.now() - (conv.at || 0) < 6 * 3600_000
    if (convFresh && conv.ended === false && conv.for === adminLastTs && !conv.followedUp) {
      try {
        const text = buildPrompt('continue', cfg, s, { now, ongoing: true })
        proxy.injectPrivateMessage(text, { selfId: st.botQQ || cfg.qq.botQQ })
        conv.followedUp = true
        s.lastAt = Date.now()
        s.count = (s.count || 0) + 1
        s.day = day
        s.lastTopics = ['continue', ...(s.lastTopics || []).slice(0, 2)]
        saveState(s)
        nextGap = randGap(cfg)
        log(`聊天还没聊完，她接着说了（今日第 ${s.count} 条）`)
        return
      } catch (e) {
        log(`续聊失败: ${e.message}`)
      }
    }

    // 用户刚说过话就别打扰。
    // 只看「跟主号的这个会话」—— 用全局 lastUserAt 的话，访客随便说一句
    // 就会把发给你的主动消息压掉，这个 bug 一直藏着。
    const adminLast = adminLastTs
    const idleMs = (Number(p.idleMinutes) || 40) * 60_000
    if (adminLast && Date.now() - adminLast < idleMs) return

    if (!nextGap) nextGap = randGap(cfg)
    const base = Math.max(s.lastAt || 0, adminLast || 0, p.enabledAt || 0)
    // 情绪间隔倍率：评估出「还在气头上」就 ×1.5 晚点开口，「热络」就 ×0.7 更活跃。
    // 和活跃时段倍率（activityFactor）乘法叠加，都是对基础间隔的调节。
    const moodGap = (p.moodGaps || {})[(convFresh && conv.mood) || 'normal']
    const moodFactor = Number.isFinite(Number(moodGap)) && Number(moodGap) > 0 ? Number(moodGap) : 1
    if (Date.now() - base < nextGap * activityFactor(cfg, s, now) * moodFactor) return

    const lastTopics = (s.lastTopics || []).slice(0, 3)
    // 话题倍率：评估说「还没聊完」→ 续聊话题权重拉到 continueBoost（默认 7，
    // 明显高于其他话题的 1~3），但其他话题权重一个不动 —— 思维会发散，
    // 她仍可能不接茬而去说别的。已结束/过期/追问过 → 续聊权重归零，回到原池子。
    const w = mergedWeights(p)
    if (convFresh && conv.ended === false && !conv.followedUp) {
      w.continue = Math.max(w.continue || 0, Number(p.continueBoost) || 7)
    } else {
      w.continue = 0
    }
    const topic = pickTopic(w, now.getHours(), lastTopics)
    const netLeft = (Number(p.hotDailyMax) || 0) - (s.hotUsed || 0)
    const text = buildPrompt(topic, cfg, s, { noNet: TOPICS[topic]?.net && netLeft <= 0, now })

    try {
      proxy.injectPrivateMessage(text, { selfId: st.botQQ || cfg.qq.botQQ })
      s.lastAt = Date.now()
      s.count = (s.count || 0) + 1
      s.day = day
      s.lastTopics = [topic, ...lastTopics].slice(0, 3)
      if (TOPICS[topic]?.net && netLeft > 0) s.hotUsed = (s.hotUsed || 0) + 1
      // 记下这次用过的素材，下次不再说同一件小事
      const usedNow = (text.match(/^ {2}· (.+)$/gm) || []).map((x) => x.replace(/^ {2}· /, ''))
      s.usedHints = [...(s.usedHints || []), ...usedNow].slice(-USED_MAX)
      saveState(s)
      nextGap = randGap(cfg)
      log(`主动消息已触发（${TOPICS[topic]?.label || topic}，今日第 ${s.count} 条）`)
    } catch (e) {
      log(`主动消息失败: ${e.message}`)
    }
  }

  return {
    start() {
      if (timer) return
      // 统计你的活跃时段：收到消息就记一笔到当前小时
      if (typeof proxy.setUserActivityHook === 'function') {
        proxy.setUserActivityHook(() => {
          try {
            const s = loadState()
            const h = new Date().getHours()
            s.hours[h] = (s.hours[h] || 0) + 1
            saveState(s)
          } catch {
            /* ignore */
          }
        })
      }
      // 说说发出去之后记一笔：下次选题时避开最近写过的
      if (typeof proxy.setQzoneHook === 'function') {
        proxy.setQzoneHook(({ text }) => {
          try {
            const d = loadQzoneLog()
            d.posts = [...(d.posts || []), { text: String(text || '').slice(0, 80), img: pendingZoneImage, at: Date.now() }]
            d.posts = d.posts.slice(-12)
            saveQzoneLog(d)
            pendingZoneImage = null
          } catch {
            /* ignore */
          }
        })
      }
      // 她评估完的对话状态（[[对话状态]] {ended, mood}，proxy 层拦截解析）写进 state。
      // for 记的是「这轮评估对应哪条用户消息」—— 用户一旦回新消息，旧评估自动作废。
      if (typeof proxy.setConvStateHook === 'function') {
        proxy.setConvStateHook((cs) => {
          try {
            const s = loadState()
            s.convState = {
              ended: cs.ended === true,
              mood: ['angry', 'sad', 'cold', 'normal', 'happy', 'excited'].includes(cs.mood) ? cs.mood : 'normal',
              at: Date.now(),
              for: s.lastAssessFor || 0,
              followedUp: false
            }
            saveState(s)
            log(`对话状态评估完成：ended=${s.convState.ended} mood=${s.convState.mood}`)
          } catch {
            /* ignore */
          }
        })
      }
      timer = setInterval(() => {
        try {
          check()
        } catch (e) {
          log(`主动消息检查异常: ${e.message}`)
        }
      }, TICK_MS)
      log('主动消息调度器已启动')
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    /** 手动跑一次调度判定（测试/排查用：看现在到底会不会触发） */
    checkNow() {
      check()
    },
    /** 面板上「立即试一次」用的手动触发 */
    triggerNow(topic) {
      const cfg = loadConfig()
      const st = proxy.status()
      if (!st.napcat || !st.dsh) throw new Error('NapCat 或 dsh 未连接')
      const s = loadState()
      const t = TOPICS[topic] ? topic : pickTopic(mergedWeights(cfg.proactive), new Date().getHours(), s.lastTopics || [])
      const text = buildPrompt(t, cfg, s, { noNet: false })
      // 手动试不算条数、不扣联网额度（方便反复看效果），
      // 但**要记素材**：不然连点五次「试一次」可能抽到同一件事，看着像没生效
      const usedNow = (text.match(/^ {2}· (.+)$/gm) || []).map((x) => x.replace(/^ {2}· /, ''))
      s.usedHints = [...(s.usedHints || []), ...usedNow].slice(-USED_MAX)
      proxy.injectPrivateMessage(text, { selfId: st.botQQ || cfg.qq.botQQ })
      s.lastAt = Date.now()
      saveState(s)
      return { topic: t, label: TOPICS[t].label }
    },
    info() {
      const cfg = loadConfig()
      const s = loadState()
      const day = todayKey()
      return {
        state: s.day === day ? s : { ...s, count: 0, hotUsed: 0, day },
        nextGapMinutes: nextGap ? Math.round(nextGap / 60_000) : null,
        topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, v.label])),
        config: cfg.proactive
      }
    }
  }
}
