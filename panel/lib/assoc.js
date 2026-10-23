/**
 * 跳题联想：让她接话时顺手想到自己的一件小事。
 *
 * 为什么需要：她最像机器人的地方不是「只回当前问题」，而是**每句话都精准落在主题上**。
 * 真人聊天经常从 A 跳到 B（「说到这个我想起…」），这才是松弛感。
 *
 * 三条设计原则：
 *
 * 1. **只追加，不替代**。提示里写死「先说正事，再岔」，联想是分条的第 2、3 条。
 *    「答非所问」在结构上就不可能发生 —— 这是这个机制最容易翻车的地方，从结构上堵掉。
 * 2. **概率注入，不是人格常驻**。人格里写「可以岔开话题」，模型会每条都岔（它爱展示能力）。
 *    改成按概率给「许可 + 素材」，可调、可测、可关。
 * 3. **素材来自她自己的生活，不让模型自由编**。她的设定是 20 岁大三、住宿舍、有室友有课表。
 *    自由编的话，三天内就会出现「我表姐」「我家狗」这种前后矛盾的设定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './store.js'

/**
 * 素材池：她生活里的碎片，不是「话题」。
 *
 * 每条都带 tags —— 对方说到这些词时，这条素材就成了「有由头」的联想，
 * 命中标签比随机抽自然得多（「他说累」→「我也累」是共鸣；随机抽一张就成了跑题）。
 *
 * 写法上刻意避免：提问句（她抛问题对方必须答，节奏就乱了）、完整故事（一句就够）。
 *
 * **标签只准用 2 字以上的词。**
 * 第一版写了单字标签（`天`、`课`、`看`、`写`），结果「今天好累」里的「天」
 * 命中了「看云」那条 —— 由头匹配直接跑偏。单字在中文里几乎处处命中，不能用。
 */
const HINTS = [
  // 累 / 睡
  { tags: ['好累', '累死', '困', '熬夜', '早八', '起不来'], text: '早八上完直接趴桌上睡了一节' },
  { tags: ['好累', '累死', '熬夜', '改稿', '作业'], text: '昨晚改稿改到两点 今天脑子一直是糊的' },
  { tags: ['好累', '午休', '趴着', '趴桌', '睡醒'], text: '中午趴桌上睡 醒来手麻得半天没知觉' },
  { tags: ['困', '咖啡', '提神', '喝茶'], text: '今天第三杯咖啡了 还是困' },

  // 吃 / 食堂 / 外卖
  { tags: ['食堂', '吃饭', '打饭', '饿'], text: '食堂三楼那个阿姨给的量特别大 每次吃不完' },
  { tags: ['外卖', '点了', '饿', '等餐'], text: '点了外卖等了四十分钟 到手都凉了' },
  { tags: ['夜宵', '薯片', '零食', '馋'], text: '刚吃了包薯片 现在就有点后悔' },
  { tags: ['奶茶', '咖啡', '太甜', '喝'], text: '下午那杯奶茶太甜了 喝一半就扔了' },

  // 作业 / 课 / 考试
  { tags: ['作业', 'ddl', '小组', '组队', '报告'], text: '小组作业最后又变成我一个人在做' },
  { tags: ['改稿', '写稿', '稿子', '改到', '推翻'], text: '稿子改到第五版 越改越不知道自己写的是啥' },
  { tags: ['上课', '老师', '听课', '讲课'], text: '今天那节课老师讲了两个小时 我一句没记住' },
  { tags: ['点名', '回答问题', '站起来', '提问'], text: '上课被点名回答问题 我站起来愣了三秒' },
  { tags: ['考试', '复习', '背书', '期末'], text: '背书背到第三页 前面两页已经忘了' },

  // 宿舍 / 室友
  { tags: ['室友', '半夜', '打电话', '吵'], text: '室友半夜还在打电话 我戴着耳机都听得见' },
  { tags: ['室友', '空调', '太冷', '开得'], text: '室友把空调开到十六度 我裹着被子打字' },
  { tags: ['洗澡', '排队', '热水'], text: '洗澡排了半小时队 进去水还是温的' },
  { tags: ['快递', '驿站', '取件'], text: '快递在驿站放了两天 一直懒得去拿' },

  // 路上 / 天气
  { tags: ['下课', '走廊', '人挤人'], text: '下课走廊人挤人 走了十分钟才出来' },
  { tags: ['刮风', '风大', '下雨', '天气', '伞'], text: '今天风特别大 伞差点被吹翻' },
  { tags: ['橘猫', '小猫', '摸猫', '路上'], text: '路上那只橘猫今天居然让我摸了' },
  { tags: ['好热', '太阳', '晒', '出汗'], text: '中午出去一趟 回来整个人是汗' },

  // 手机 / 电子产品
  { tags: ['手机', '电量', '没电', '充电'], text: '手机电量撑不到晚上 跟我的精神状态一样' },
  { tags: ['充电线', '找不到', '充电'], text: '充电线又不知道扔哪了 找了十分钟' },
  { tags: ['耳机', '没声', '听歌'], text: '耳机一只没声了 只能单耳听 怪怪的' },

  // 情绪 / 状态
  { tags: ['开心', '高兴', '心情好'], text: '今天莫名其妙就挺开心 也说不上为什么' },
  { tags: ['无聊', '没事干', '闲着', '没意思'], text: '今天什么也没干 就这样过完了' },
  { tags: ['好烦', '烦躁', '说不上来', '心里堵'], text: '也没什么事 就是有点烦 说不上来' },
  { tags: ['想家', '我妈', '我妈说', '家里'], text: '刚我妈发消息问我吃饭没 我说吃了' },

  // 娱乐
  { tags: ['追剧', '看剧', '电视剧', '一集'], text: '昨天开始追一部剧 一口气看了四集' },
  { tags: ['循环', '单曲', '听歌', '脑子里'], text: '有首歌我循环了一整天 现在还在脑子里转' },
  { tags: ['游戏', '打游戏', '输了', '排位'], text: '昨晚打游戏输了五把 越想越气' },
  { tags: ['刷视频', '抖音', '短视频', '刷了'], text: '本来只想刷五分钟 一抬头一小时过去了' },

  // 杂
  { tags: ['生活费', '没钱', '穷', '这个月'], text: '这个月生活费又快见底了 才二十二号' },
  { tags: ['晾衣服', '洗衣服', '没干', '太潮'], text: '衣服晾了三天还没干 这天太潮了' },
  { tags: ['头发', '理发', '剪头'], text: '头发长了遮眼睛 一直说去剪 一直没去' },
  { tags: ['拍照', '云', '晚霞', '天空'], text: '今天看到一片云挺好看 等我掏手机就散了' },
  { tags: ['早八', '课表', '明天', '不想动'], text: '明天又是早八 我已经开始不想动了' },
  { tags: ['收拾', '桌子', '堆了'], text: '桌上堆了一片 一直说要收拾 一直没动' },
  { tags: ['喝水', '嘴唇', '口渴'], text: '一天没喝几口水 嘴唇都干了' },
  { tags: ['图书馆', '借书', '续借', '看书'], text: '借的书到期了 一页没看 又续了一次' }
]

/** 联想「该收敛」的信号：对方在说正事/难受，这时候岔开就是没心没肺 */
const FOCUS_WORDS = [
  '崩溃',
  '分手',
  '吵架',
  '生病',
  '发烧',
  '住院',
  '家里',
  '爸妈',
  '面试',
  '挂科',
  '难过',
  '哭',
  '焦虑',
  '救命',
  '怎么办',
  '帮我',
  '出事了'
]

/** 明显在问正事的问句 */
const QUESTION_RE = /(怎么|为什么|为啥|如何|能不能|可不可以|该不该|哪个|多少钱|是什么|有没有)/
const HELP_RE = /(帮我|教我|给我|看下|看一下|查一下|怎么办|咋办)/

function assocFile() {
  return path.join(DATA_DIR, 'assoc.json')
}

/**
 * 进程内状态。
 *
 * 不只为省 I/O —— 踩过的坑：测试里要反复「重置再来一次」，
 * 而 Windows 下 unlink 偶尔会失败（文件被扫毒/索引短暂占用），异常被 catch 吞掉，
 * 于是下一次读到的还是旧内容：素材不复位、streak 越攒越大（实测攒到 69），
 * 表现就是「明明重置了却还在这几条里打转」。
 *
 * 所以权威状态放在内存，文件只是持久化副本；启动时读一次，之后不再回读。
 */
let mem = null

function blank() {
  return { used: [], streak: 0, lastAt: 0, last: null }
}

function loadState() {
  if (mem) return { ...mem, used: [...mem.used] }
  try {
    const d = JSON.parse(fs.readFileSync(assocFile(), 'utf8'))
    mem = {
      used: Array.isArray(d.used) ? d.used : [],
      // 连续联想了几条。连着岔两三次就变话痨了，得强制断一下
      streak: Number(d.streak) || 0,
      lastAt: Number(d.lastAt) || 0,
      last: d.last && typeof d.last === 'object' ? d.last : null
    }
  } catch {
    mem = blank()
  }
  return { ...mem, used: [...mem.used] }
}

function saveState(s) {
  // 「用过」的记忆要覆盖整个池子，否则用到第 30 条时最早那条被挤出去，
  // 紧接着又被抽回来 —— 前面刚说过的话原封不动再来一遍，比不复读更假。
  const keep = (s.used || []).slice(-Math.max(30, HINTS.length))
  mem = { used: [...keep], streak: Number(s.streak) || 0, lastAt: Number(s.lastAt) || 0, last: s.last || null }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(assocFile(), JSON.stringify({ ...s, used: keep }, null, 1))
  } catch {
    /* 落盘失败不影响本次聊天，内存里是对的 */
  }
}

/** 这条消息是不是「需要专心」的场合（正事、求助、难受） */
export function needsFocus(text) {
  const t = String(text || '')
  if (!t.trim()) return true
  if (FOCUS_WORDS.some((w) => t.includes(w))) return true
  // 带问号 + 求教类词，说明在问一个具体问题，这时候岔开就是没听人说话
  if (/[?？]/.test(t) && (QUESTION_RE.test(t) || HELP_RE.test(t))) return true
  if (HELP_RE.test(t)) return true
  return false
}

function hitTags(text) {
  const t = String(text || '')
  return HINTS.filter((h) => h.tags.some((tag) => t.includes(tag)))
}

/**
 * 抽素材：一条「有由头」的 + 一条别处的。
 *
 * 有由头的那条不写进文案里当解释（「他说累所以我想到…」太机械），
 * 只作为素材递给她，让她自己决定怎么用。
 *
 * 第二条要求**标签不重叠**：两条都说「宿舍」会显得她只有一件事可说。
 */
function drawHints(text, used) {
  const usedSet = new Set(used || [])
  const pool = HINTS.filter((h) => !usedSet.has(h.text))
  const usable = pool.length ? pool : HINTS

  const matched = usable.filter((h) => h.tags.some((tag) => String(text || '').includes(tag)))
  const pickFrom = (list) => list[Math.floor(Math.random() * list.length)]
  const out = []
  if (matched.length) out.push(pickFrom(matched))

  // 补到两条，且新的一条要和已选的**主题不重叠**（都说宿舍会显得她只有一件事可说）
  while (out.length < 2) {
    const free = usable.filter((h) => !out.includes(h))
    const distinct = free.filter((h) => !out.some((o) => o.tags.some((t) => h.tags.includes(t))))
    const cands = distinct.length ? distinct : free
    if (!cands.length) break
    out.push(pickFrom(cands))
  }
  return out
}

/**
 * 各状态对「跳题概率」的倍率。用户设的 chance 是基准（闲着时 ×1），实际概率 = chance × 倍率。
 *
 * 为什么要分状态：真人说话岔不岔，跟他这会儿在干嘛直接相关。
 * 躺着刷手机的人最爱扯；赶 DDL 的人你说三句他回一句，绝不可能主动岔到「路上有只猫」。
 * 原来只有三档（busy>=2 不岔、偷闲减半、其它原值），粒度太粗 ——
 * 结果她一边说「我这边慢慢磨作业」，一边四分钟后开始聊橘猫。
 *
 * 数值怎么定的：
 *  0     —— 根本不可能岔（睡着、午休、正忙）
 *  0.3-0.4 —— 手上有事、时间不够（偷闲、赶时间、赶 DDL、关灯后）
 *  0.6-0.8 —— 有点忙，但能聊（临时计划里、吃饭、刚起）
 *  1     —— 正常（闲着、固定日程）
 *  1.2-1.3 —— 最放松，最爱岔（宿舍躺着、晚上、刚忙完）
 */
const STATE_FACTORS = {
  // 不可能岔
  sleep: 0,
  nap: 0,
  // 手上有事 / 时间不够
  sneak: 0.35,
  rush: 0.3,
  crunch: 0.4,
  lightsout: 0.35,
  // 有点忙但能聊
  plan: 0.6,
  wake: 0.7,
  lunch: 0.8,
  dinner: 0.8,
  homework: 0.8,
  commute: 0.6,
  bedtime: 0.5,
  // 正常
  idle: 1,
  slot: 1,
  event: 1,
  rest: 1,
  // 最放松
  dorm: 1.3,
  evening: 1.25,
  break: 1.1,
  'after-busy': 1.2
}

/** 表里没有的状态，按忙闲兜底 */
function fallbackByBusy(busy) {
  if (busy >= 2) return 0
  if (busy === 1) return 0.6
  return 1
}

/**
 * 算某个状态的倍率。
 * 允许面板/配置覆盖：`reply.assoc.stateFactors = { dorm: 1.6 }`。
 * 偷闲优先（它本质是「正忙里偷出来的几分钟」，不管 key 叫什么）。
 */
export function stateFactor(cfg, key, busy, sneak) {
  const custom = cfg?.reply?.assoc?.stateFactors
  const table = custom && typeof custom === 'object' ? { ...STATE_FACTORS, ...custom } : STATE_FACTORS
  const pick = (k, d) => {
    const v = table[k]
    return Number.isFinite(Number(v)) ? Number(v) : d
  }
  if (sneak) return Math.max(0, pick('sneak', 0.35))
  if (key && Object.prototype.hasOwnProperty.call(table, key)) return Math.max(0, pick(key, 1))
  return fallbackByBusy(Number(busy) || 0)
}

/**
 * 生成注入文本。返回 '' 表示这条不给她联想的许可。
 *
 * @param {object} cfg  config
 * @param {object} opts { text, busy, sneak, stateKey, now }
 */
export function assocLine(cfg, opts = {}) {
  const a = cfg?.reply?.assoc || {}
  if (a.enabled === false) return ''

  const text = String(opts.text || '')
  if (!text.trim()) return ''

  // 对方在说正事、求助、难受的时候，岔开就是没心没肺
  if (needsFocus(text)) return ''

  // 按当前状态算实际概率。倍率 0（睡着/正忙）时直接不岔，
  // 而且要早于 streak 检查返回 —— 否则「在忙」也会白白消耗一次断轮机会。
  const busy = Number(opts.busy) || 0
  const factor = stateFactor(cfg, opts.stateKey, busy, opts.sneak === true)
  let chance = Math.max(0, Math.min(100, Number(a.chance ?? 30)))
  chance *= factor
  if (chance <= 0) return ''

  const s = loadState()

  // 连着岔了两条就停一轮，否则整段聊天都是她在讲自己的事
  const maxStreak = Math.max(1, Number(a.maxStreak) || 2)
  if (s.streak >= maxStreak) {
    // 断一轮：清掉 streak，下次重新开始
    saveState({ ...s, streak: 0 })
    return ''
  }

  if (Math.random() * 100 >= chance) return ''

  const picks = drawHints(text, s.used)
  if (!picks.length) return ''

  const lines = [
    '【这条可以不只接话（内部提示，别向对方解释这句）】',
    '除了回他，你可以顺手想起自己的一件小事，补在后面：',
    '- 他说的东西刚好戳到你，就讲你自己的类似经历（他说累，你也累）；也可以完全没由头地想起一件小事。',
    '- 素材（只是提醒，别照抄，用你自己的说法）：'
  ]
  for (const h of picks) lines.push(`  · ${h.text}`)
  lines.push(
    '- **先答他说的，再岔**。别让联想把要回的话挤掉，也别一次岔两件。',
    '- 这条要是本来一句就能说完，硬凑一件小事反而假 —— 那就别岔。',
    '- 岔开了，可以自己发现「哎我扯远了」再拉回来，也可以不拉，看你当时想不想。'
  )

  saveState({
    used: [...(s.used || []), ...picks.map((h) => h.text)],
    streak: s.streak + 1,
    lastAt: Date.now(),
    last: { from: text.slice(0, 20), to: picks[0].text }
  })

  return lines.join('\n') + '\n'
}

/** 面板/日志用：最近一次联想是什么 */
export function assocInfo() {
  return loadState()
}

/** 重置记录（测试用）：内存和文件一起清，之后不会读到旧状态 */
export function resetAssoc() {
  mem = blank()
  try {
    fs.unlinkSync(assocFile())
  } catch {
    /* 文件本来就没了，或者删不掉 —— 内存已经清了，不影响 */
  }
}
