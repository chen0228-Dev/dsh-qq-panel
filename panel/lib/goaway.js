/**
 * 从她发出的话里认出「我现在要去做什么」。
 *
 * 【为什么需要这个】
 * 人格里早就写了「说了要去干嘛就 `qq-routine add` 记一笔」。上线到今天，
 * 她一次都没调用过 —— `campus-plan.json` 从头到尾没被创建过。
 *
 * 结果就是用户看到的那一幕：
 *   20:54  她说「你先忙设计吧 我这边慢慢磨」
 *   20:58  她岔题「路上那只橘猫今天居然让我摸了」   ← 状态机还以为她在闲逛
 *   20:59  她才补一句「行 那我先去写作业了」
 *
 * 中间那四分钟里，状态机对她的认知一直是「闲着」（busy=0），
 * 所以跳题概率按闲着算，自然就岔出去了。
 *
 * 提示管不住的事，就由代码兜一层：出站时认一句「我先去…了」，替她把状态改掉。
 *
 * 【原则：宁可漏，不要错】
 * 认错一条的代价是「接下来一小时她莫名说自己有事」；
 * 漏掉的代价只是这一次没改状态（和现在一样）。所以规则写得很窄：
 *   · 必须是「我」或「那（我）」开头，别人去做事不算
 *   · 必须有「去」或「这边慢慢」这类明确要走的动作
 *   · 前面不能有否定（不想/别/没）
 *   · 不能是过去时（刚去/刚才去/去过）
 */

const pad2 = (n) => String(n).padStart(2, '0')
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/** 把「现在 + n 分钟」转成 HH:MM；跨零点就截到 23:59（跨天由 date 字段处理） */
function plusMinutes(now, min) {
  const t = new Date(now.getTime() + min * 60_000)
  if (t.getDate() !== now.getDate()) return '23:59'
  return hhmm(t)
}

/** 明确的宾语：她去做一件具体的事 */
const EXPLICIT = [
  // 学习/工作类 —— 一般要耗一阵
  { re: /(?:我|那)(?:这|就)?(?:先)?去(写作业|做作业|赶作业|写稿|写东西|写代码|剪视频|画图|做实验|做设计|复习|背书|背单词|看书|加班|干活|收拾|打扫|做饭|洗衣服)(?:了|吧|啊)?/, min: 60 },
  // 短的日常 —— 半小时上下
  { re: /(?:我|那)(?:这|就)?(?:先)?去(洗澡|洗个澡|吃饭|吃口饭|打球|健身|跑步|游泳|上课|上班|开会|出门|买菜|接人|取快递|倒垃圾)(?:了|吧|啊)?/, min: 40 }
]

/** 模糊的「我这边慢慢…」，认不出具体做什么 */
const VAGUE = [
  { re: /我这边(?:慢慢|先)?(?:磨|弄|赶|写|做|看|背|收)/, min: 45, label: '手头的事' },
  // 「那我先去写了」这种省略宾语的说法。必须有「先」——
  // 没有「先」的「我去看了」是过去时，不能算。
  { re: /(?:我|那)(?:这|就)?先去(?:写|弄|赶|做|看|背|收|忙)(?:了|吧)/, min: 45, label: '手头的事' }
]

/** 睡觉单独处理：标签和 busy 都不一样 */
const SLEEP = /(?:我|那)(?:这|就)?(?:先)?(?:去)?睡(?:觉|午觉|回笼觉)?(?:了|吧|啊)/

/** 否定 / 过去时 —— 命中就不算「现在要去」 */
const NEG_BEFORE = /(?:不|别|甭|没)(?:想|要|用|必|去|空|会)?\s*$/
const PAST_BEFORE = /(?:刚|刚才|已经|之前|昨天|上次)(?:才)?\s*$/

/**
 * 剥掉会被误判的装饰。
 *
 * 最关键的是引用行：`[[引用 1]]去吧 别磨蹭了` 这一行是**对方说过的话**，
 * 她引用它不代表那是她的自述。所以含引用标记的整行直接丢掉，只留她自己的话。
 */
function clean(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/\[\[引用\s*\d+\]\]/.test(line))
    .join('\n')
    .replace(/\[face:\d+\]/g, ' ')
    .replace(/\[表情:[^\]]*\]/g, ' ')
    .replace(/\[超级表情[^\]]*\]/g, ' ')
    .replace(/\[表情包[^\]]*\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
}

/**
 * 判断某处匹配是否被否定/过去时否定掉。
 * 只看匹配位置前面 8 个字，够用了。
 */
function blocked(text, idx) {
  const before = text.slice(Math.max(0, idx - 8), idx)
  return NEG_BEFORE.test(before) || PAST_BEFORE.test(before)
}

/**
 * 从她的话里认出「她想做的一件新事」。
 *
 * 【为什么需要这个】
 * 她的活动池原来只有模板那十来条，一年到头翻来覆去就那几件，久了像循环录音。
 * 用户希望她能自己往里放东西 —— 前提是她真的会调 `qq-event`。
 * 但 `qq-routine` 的教训还热着：人格里写得好好的，她一次都没调用过。
 * 所以这里也兜一层：她说「我想学吉他」「下次想去爬山」，就把这件事放进池子。
 *
 * 【和 detectGoAway 的区别】
 * - goaway 是「我现在就要去做」（改今天的状态，45-60 分钟）
 * - wish 是「以后想干这件事」（加进活动池，哪天可能抽到）
 * 两者可以同时命中：她说「我去健身房了，最近想练练」→ 状态变忙 + 池子里多一个「健身」。
 *
 * 【保守到什么程度】
 * 只认「我 + 想/打算/准备 + 具体做什么」，且排除日常琐事（洗澡吃饭睡觉上班）。
 * 认错一条的代价是池子里多一个无厘头活动（不一定抽得到），比漏掉轻。
 */

/** 日常琐事不是「活动」，进了池子会很怪 */
const WISH_BLOCK = /洗澡|洗漱|刷牙|洗脸|吃饭|吃口|睡|上班|上课|下班|回家|上厕所|买菜|买东西|倒垃圾|取快递|拿快递|发呆|刷手机/

const WISH_PATTERNS = [
  // 我想学吉他 / 我打算去爬山 / 我最近想试试陶艺 / 最近想练练
  // 「我」是可选的：中文常说「最近想练练」，主语省掉了。
  // 动词也是可选的：「想弹琴」「想练练」都没有「去/学」。
  /(?:我)?(?:最近|这阵子|这段时间|改天|下次|以后|也|还)?(?:想|打算|准备|计划)((?:去|学|试试|玩|开始|报个)?[^，。！？\s]{2,8})/,
  // 改天想去海边 / 下次去露营 / 找个时间去看展
  /(?:改天|下次|以后|有空|找个时间)(?:想|要)?去([^，。！？\s]{2,8})/
]

/** 捕获到的内容不能是这些 —— 「想吃什么」不是想学什么 */
const WISH_NOT_ACT = /^(吃|喝|干嘛|干什么|什么|啥|怎么样|如何|不想|知道|你|他|她|它|说|问)/

/**
 * 认一句「她想去做什么」。
 *
 * @param {string} text
 * @returns {{label:string}|null}
 */
export function detectWish(text) {
  const s = clean(text)
  if (!s.trim()) return null
  // 只看她自己说的话（引用行已被 clean 剥掉）
  for (const re of WISH_PATTERNS) {
    const m = re.exec(s)
    if (!m) continue
    // 主语不是她：「你今天想吃什么」里的「想」不算她想学什么
    const before = s.slice(Math.max(0, m.index - 1), m.index)
    if (/[你他她它]/.test(before)) continue
    const label = String(m[1] || '').trim()
    if (label.length < 2 || label.length > 10) continue
    if (WISH_BLOCK.test(label)) continue
    if (WISH_NOT_ACT.test(label)) continue
    return { label }
  }
  return null
}

/**
 * 认一句「我现在要去做什么」（改今天的状态）。
 *
 * @param {string} text  她这条要发出去的纯文本（可以多行）
 * @param {Date}   now
 * @returns {{from:string,to:string,label:string,busy:number,line:string,min:number}|null}
 */
export function detectGoAway(text, now = new Date()) {
  const s = clean(text)
  if (!s.trim()) return null

  // 只看最后两行：自述「我要去干嘛」几乎都在收尾处。
  // 整段扫容易把中间的假设句（「要是再去打球就好了」）也吃进来。
  const lines = s.split('\n').filter((x) => x.trim())
  const tail = lines.slice(-2).join('\n')

  // 1) 睡觉
  {
    const m = SLEEP.exec(tail)
    if (m && !blocked(tail, m.index)) {
      // 睡到 23:59（真正的起床时间由 lightsOut / riseAt 管，这里只表示「我睡了」）
      const to = plusMinutes(now, 8 * 60)
      return {
        from: hhmm(now),
        to,
        label: '睡觉',
        busy: 3,
        line: '你说要去睡了，人已经躺下了',
        min: 8 * 60
      }
    }
  }

  // 2) 明确的事
  for (const r of EXPLICIT) {
    const m = r.re.exec(tail)
    if (!m) continue
    if (blocked(tail, m.index)) continue
    const label = m[1]
    return {
      from: hhmm(now),
      to: plusMinutes(now, r.min),
      label,
      busy: 1,
      line: `你在${label}，手上正忙着，手机搁在旁边偶尔看一眼`,
      min: r.min
    }
  }

  // 3) 模糊的「我这边慢慢…」
  for (const r of VAGUE) {
    const m = r.re.exec(tail)
    if (!m) continue
    if (blocked(tail, m.index)) continue
    return {
      from: hhmm(now),
      to: plusMinutes(now, r.min),
      label: r.label,
      busy: 1,
      line: '你这边还有一堆要慢慢磨，正对着它耗着，偶尔摸一下手机',
      min: r.min
    }
  }

  return null
}
