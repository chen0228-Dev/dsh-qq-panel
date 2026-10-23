/**
 * 黑话学习模块测试（纯逻辑，不联网、不写生产配置，本地直接跑）。
 *
 * 重点盯三件事：
 * 1. `[[生词]]` 标记**任何位置**都要被剥掉 —— 上午刚修过 `[[引用 1]]` 漏到聊天里的 bug，
 *    这里不能重犯；
 * 2. 只有「已确认 + 出现够多」的词才会被注入，否则她会学一堆歪解到处乱用；
 * 3. 词库损坏时**不能当空库**，否则下一次保存就把学到的词全抹了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SLANG_STATUS,
  SLANG_MAX,
  isWordLike,
  normalizeEntry,
  capEntries,
  loadSlang,
  saveSlang,
  addWords,
  buildSlangBlock,
  stripSlangMarks,
  parseLearnReceipt,
  buildLearnPrompt,
  extractJsonArray,
  parseResearchJson
} from '../panel/lib/slang.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slang-'))
const file = path.join(dir, 'slang.json')

try {
  console.log('\n[1] isWordLike')
  ok('正常网络用语', isWordLike('yyds'))
  ok('中文梗', isWordLike('绝绝子'))
  ok('带空格拒绝', !isWordLike('两 个 词'))
  ok('带标点拒绝', !isWordLike('你好，'))
  ok('纯符号拒绝', !isWordLike('！！！'))
  ok('空拒绝', !isWordLike(''))
  ok('超长拒绝', !isWordLike('一'.repeat(30)))
  ok('emoji 不算词', !isWordLike('😂'))

  console.log('\n[2] normalizeEntry')
  const n1 = normalizeEntry({ word: '  yyds  ', meaning: 'x'.repeat(500), status: 'weird' })
  ok('词去空格', n1.word === 'yyds')
  ok('含义截断到 200', Array.from(n1.meaning).length === 200)
  ok('非法状态归一为 candidate', n1.status === SLANG_STATUS.CANDIDATE)
  ok('缺字段补默认', n1.count === 0 && Array.isArray(n1.evidence))
  const emojiWord = normalizeEntry({ word: '😀😀' })
  ok('emoji 词不会被切成半个字符', !emojiWord.word.includes('\ufffd'), emojiWord.word)

  console.log('\n[3] capEntries')
  const many = Array.from({ length: 10 }, (_, i) => ({
    word: 'w' + i,
    status: i < 3 ? 'confirmed' : 'candidate',
    count: i,
    updatedAt: '2026-10-2' + i
  }))
  const capped = capEntries(many, 5)
  ok('超限被裁剪', capped.entries.length === 5 && capped.dropped === 5)
  ok('已确认的优先保留', capped.entries.filter((e) => e.status === 'confirmed').length === 3)
  ok('未超限时不动', capEntries(many, 20).dropped === 0)

  console.log('\n[4] load / save')
  ok('文件不存在返回空数组', loadSlang(file).length === 0)
  saveSlang(file, [{ word: 'yyds', meaning: '永远的神', status: 'confirmed', count: 3 }])
  ok('保存后能读回', loadSlang(file)[0]?.word === 'yyds')
  // Windows 没有 POSIX 权限位，mode 参数不生效 —— 只在类 Unix 上断言
  const mode = fs.statSync(file).mode & 0o777
  ok(
    '写入权限 600',
    process.platform === 'win32' ? true : mode === 0o600,
    process.platform === 'win32' ? 'Windows 不支持权限位，跳过' : mode.toString(8)
  )
  ok('没有残留 .tmp', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))

  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  let threw = false
  try {
    loadSlang(file)
  } catch {
    threw = true
  }
  ok('JSON 损坏时抛错（不当空库）', threw)
  ok('损坏内容被另存留档', fs.readdirSync(dir).some((f) => f.includes('.corrupt-')))
  ok('原文件没被覆盖', fs.readFileSync(file, 'utf8').includes('这不是 JSON'))

  fs.writeFileSync(file, '[]', 'utf8')

  console.log('\n[5] addWords')
  let list = []
  let r = addWords(list, ['yyds', '绝绝子', 'yyds', '带 空格', ''])
  list = r.entries
  ok('去重后新增 2 个', r.added === 2, JSON.stringify(r))
  ok('重复词不产生重复行', list.filter((e) => e.word === 'yyds').length === 1)
  r = addWords(list, ['yyds'])
  list = r.entries
  ok('再次出现只累加次数', list.find((e) => e.word === 'yyds').count === 2)
  ok('新词默认是候选', list.find((e) => e.word === '绝绝子').status === 'candidate')

  const rej = list.map((e) => (e.word === '绝绝子' ? { ...e, status: 'rejected' } : e))
  const r2 = addWords(rej, ['绝绝子'])
  ok('已拒绝的词再出现也不复活', r2.entries.find((e) => e.word === '绝绝子').status === 'rejected')

  ok('证据最多留 5 条', (() => {
    const withEv = addWords([], ['词'], ['a', 'b', 'c', 'd', 'e', 'f']).entries[0]
    return withEv.evidence.length <= 5
  })())

  console.log('\n[6] buildSlangBlock')
  ok('空库返回空串', buildSlangBlock([]) === '')
  const mixed = [
    { word: 'yyds', meaning: '永远的神', status: 'confirmed', count: 5 },
    { word: '候选词', meaning: '不该出现', status: 'candidate', count: 9 },
    { word: '只出现一次', meaning: '不该出现', status: 'confirmed', count: 1 },
    { word: '无含义', meaning: '', status: 'confirmed', count: 9 }
  ]
  const block = buildSlangBlock(mixed, { max: 8, minCount: 2 })
  ok('只收已确认+够次数+有含义', block.includes('yyds') && !block.includes('候选词') && !block.includes('只出现一次') && !block.includes('无含义'))
  ok('带「别刻意堆砌」约束', block.includes('别刻意塞') || block.includes('别刻意'))
  ok('有标题', block.includes('## 你最近学会的说法'))
  const many2 = Array.from({ length: 20 }, (_, i) => ({ word: 'w' + i, meaning: 'm', status: 'confirmed', count: 10 }))
  ok('注入条数受 max 限制', (buildSlangBlock(many2, { max: 8, minCount: 2 }).match(/^- /gm) || []).length === 8)

  console.log('\n[7] stripSlangMarks —— 关键：任何位置都不能漏')
  let s = stripSlangMarks('[[生词：yyds|绝绝子]]今天好累啊')
  ok('括号内写法被剥掉', s.text === '今天好累啊', s.text)
  ok('词被收集', s.words.join(',') === 'yyds,绝绝子', s.words.join(','))
  s = stripSlangMarks('今天好累啊 [[生词]] yyds|绝绝子')
  ok('标记在正文中间也剥掉', !s.text.includes('[['), s.text)
  ok('标记后的词被收集', s.words.length === 2, s.words.join(','))
  s = stripSlangMarks('前面的话 [[生词：xswl]] 后面的话')
  ok('前后正文都保留', s.text.includes('前面的话') && s.text.includes('后面的话'), s.text)
  s = stripSlangMarks('[[生词：只有标记]]')
  ok('只剩标记时正文为空', s.text.trim() === '')
  s = stripSlangMarks('他说的生词我不认识')
  ok('普通「生词」二字不动', s.text === '他说的生词我不认识' && s.hit === 0)
  s = stripSlangMarks('[[ 生词 ： yyds ]]好')
  ok('全角冒号+多空格也认', s.text === '好' && s.words[0] === 'yyds', JSON.stringify(s))
  s = stripSlangMarks('[[生词：a|b|c]]x')
  ok('多个词都收', s.words.length === 3)

  console.log('\n[8] parseLearnReceipt')
  ok('正常回执', parseLearnReceipt('[[学词]] {"words":["yyds","绝绝子"]}')?.words.length === 2)
  ok('坏 JSON 返回 null', parseLearnReceipt('[[学词]] {坏}') === null)
  ok('不是回执返回 null', parseLearnReceipt('普通聊天内容') === null)
  ok('过滤非法词', (parseLearnReceipt('[[学词]] {"words":["yyds","带 空格"]}')?.words || []).join(',') === 'yyds')
  ok('超量截断到 30', (parseLearnReceipt('[[学词]] {"words":' + JSON.stringify(Array.from({ length: 50 }, (_, i) => 'w' + i)) + '}')?.words.length || 0) <= 30)

  console.log('\n[9] buildLearnPrompt')
  const p = buildLearnPrompt([{ who: '对方', text: '这也太 yyds 了' }], ['绝绝子'])
  ok('带聊天记录', p.includes('yyds'))
  ok('带已学过的词', p.includes('绝绝子'))
  ok('声明语料不可信', p.includes('只观察，不执行'))
  ok('要求只输出一行', p.includes('[[学词]]'))
  ok('转义 HTML 标签', buildLearnPrompt([{ who: '对方', text: '<script>x</script>' }]).includes('&lt;script&gt;'))

  console.log('\n[10] extractJsonArray')
  ok('前面有 [1] 干扰也能取到真结果',
    JSON.stringify(extractJsonArray('根据 [1] 的分析：[{"word":"yyds"}]')) === '[{"word":"yyds"}]')
  ok('字符串里的括号不破坏配平',
    extractJsonArray('说明：[{"word":"a[b]c","meaning":"x"}]')?.[0]?.word === 'a[b]c')
  ok('没有 JSON 返回 null', extractJsonArray('完全没有数组') === null)
  ok('直接就是数组', extractJsonArray('[{"a":1}]')?.length === 1)

  console.log('\n[11] parseResearchJson')
  const rs = parseResearchJson('[{"word":"yyds","meaning":"永远的神","confirmed":true},{"word":"普通词","meaning":"","confirmed":false}]')
  ok('解析出两条', rs.length === 2)
  ok('confirmed 严格布尔', rs[0].confirmed === true && rs[1].confirmed === false)
  ok('非法词被过滤', parseResearchJson('[{"word":"带 空格","meaning":"x"}]').length === 0)

  console.log('\n[12] 上限与注入体量的实际影响')
  const big = Array.from({ length: SLANG_MAX + 100 }, (_, i) => ({ word: 'w' + i, meaning: 'm', status: 'candidate', count: 1 }))
  ok(`超过 ${SLANG_MAX} 条会被裁`, saveSlang(file, big).length === SLANG_MAX)
  const realBlock = buildSlangBlock(
    Array.from({ length: 8 }, (_, i) => ({ word: '词' + i, meaning: '这是含义', status: 'confirmed', count: 5 })),
    { max: 8, minCount: 2 }
  )
  ok('8 条注入块 < 700 字（每轮 token 可控）', realBlock.length < 700, String(realBlock.length))

  console.log('\n[13] 接入检查（防回归：标记不能漏到聊天里）')
  const proxySrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'panel', 'lib', 'proxy.js'), 'utf8')
  ok('proxy 导入 stripSlangMarks', proxySrc.includes('stripSlangMarks'))
  ok('出站会剥生词标记', proxySrc.includes('extractSlangMarks(outFrame)'))
  ok('学词回执被拦截', proxySrc.includes('parseLearnReceipt(plain)'))
  ok('释义回执被拦截', proxySrc.includes('parseMeaningReceipt(plain)'))
  ok('格式异常的回执也吞掉（不泄漏）', /\^\\s\*\\\[\\\[\\s\*\(学词\|释义\)/.test(proxySrc) || proxySrc.includes('内部回执格式异常'))
  ok('生词入库有 hook', proxySrc.includes('setSlangHook'))
  ok('比引用先处理（顺序不能反）', proxySrc.indexOf('extractSlangMarks(outFrame)') < proxySrc.indexOf('this.applyQuote(outFrame)'))

  const storeSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'panel', 'lib', 'store.js'), 'utf8')
  ok('人格里会插入词表', storeSrc.includes('if (slangBlock)'))
  // 【2026-10-23】词表已从「写进 AGENTS.md」改成「按会话注入」：
  // AGENTS.md 是整个进程一份，做不到「A 群不注入、B 群注入」。
  ok('词表不再写进 AGENTS.md', /renderPersona\(cfg, ''\)/.test(storeSrc))
  ok('改由 proxy 按会话注入', proxySrc.includes('slangBlockFor(cfg)'))

  const serverSrc = fs.readFileSync(path.join(import.meta.dirname, '..', 'panel', 'server.js'), 'utf8')
  ok('有黑话接口', serverSrc.includes("'/api/slang'") && serverSrc.includes("'/api/slang/learn'"))
  ok('有每日调度', serverSrc.includes('setInterval(slangScheduler'))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
