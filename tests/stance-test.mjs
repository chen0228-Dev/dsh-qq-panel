/**
 * 立场库测试：天生的 17 条 + 她自己记的那些。
 *
 * 重点在两件事：
 * 1. **她自己记的立场必须真的生效** —— 用 Python 工具写完文件，JS 这边要立刻能匹配上
 *    （两边是不同进程，靠 mtime 刷新缓存）；
 * 2. **面板能删、删完就真的不再用** —— 否则她记错了就没法纠正。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  opinionLine,
  matchStances,
  allStances,
  opinionInfo,
  deleteStance,
  loadDynamic,
  resetDynamic,
  resetOpinions
} from '../panel/lib/opinion.js'
import { STANCES } from '../panel/lib/stances-builtin.js'

let fail = 0
const pass = (id, name, ok, extra = '') => {
  if (!ok) fail++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${extra ? ' — ' + extra : ''}`)
}

const DATA = process.env.PANEL_DATA || './data'
const FILE = path.join(DATA, 'stances.json')

/** 模拟她用 qq-stance 写文件（Python 那边就是这么写的） */
const writeStances = (items) => {
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify({ items }, null, 1))
}

resetDynamic()
resetOpinions()

/* ---------- T1 基础：只有天生的那些 ---------- */
pass('T1', '天生立场在', STANCES.length >= 15, `${STANCES.length} 条`)
pass('T1b', '都标了 builtin', allStances().every((s) => s.builtin === true))

/* ---------- T2 自己记的能生效 ---------- */
writeStances([
  { id: 's_1', tags: ['熬夜', '作息'], take: '十二点前睡是自欺欺人', why: '躺下就开始刷手机', at: Date.now(), src: 'chat' }
])
const hit = matchStances('你熬夜吗')
pass('T2', '新记的立场能被匹配到', hit.length === 1 && hit[0].take.includes('十二点前睡'), JSON.stringify(hit.map((x) => x.take)))
pass('T2b', '标成不是内置', hit[0]?.builtin === false)
pass('T2c', '内置立场没被影响', matchStances('你吃香菜吗').some((x) => x.take.includes('灾难')))

/* ---------- T3 注入时用的是自己记的那条 ---------- */
resetOpinions()
const line = opinionLine({ reply: { opinion: { enabled: true, chance: 100 } } }, { text: '你觉得熬夜怎么样' })
pass('T3', '注入里出现了自己记的态度', /十二点前睡是自欺欺人/.test(line), (line.match(/\*\*.+?\*\*/) || [''])[0])
pass('T3b', '理由也带上了', /躺下就开始刷手机/.test(line))

/* ---------- T4 跨进程：文件改了要立刻读到 ---------- */
writeStances([
  { id: 's_2', tags: ['考研'], take: '考研不是唯一的出路', why: '先想清楚要干什么', at: Date.now(), src: 'search' }
])
const after = matchStances('你觉得考研值不值')
pass('T4', '文件变了缓存要失效', after.some((x) => x.take.includes('不是唯一的出路')), JSON.stringify(after.map((x) => x.take)))
pass('T4b', '旧的那条（熬夜）已经不在了', !matchStances('你熬夜吗').length)

/* ---------- T5 面板数据 ---------- */
const info = opinionInfo()
pass('T5', '分得清内置和自己记的', info.stances.filter((s) => s.builtin).length === STANCES.length && info.stances.filter((s) => !s.builtin).length === 1)
pass('T5b', '总数对得上', info.total === STANCES.length + 1, `${info.total}`)
pass('T5c', '带上了来源', info.stances.find((s) => !s.builtin)?.src === 'search')

/* ---------- T6 删除 ---------- */
const del = deleteStance('s_2')
pass('T6', '删得掉', del.ok === true && del.left === 0)
pass('T6b', '删完就不匹配了', matchStances('你觉得考研值不值').length === 0)
pass('T6c', '删不存在的返回失败', deleteStance('s_nope').ok === false)

/* ---------- T7 边界话题：自己记的也不许用 ---------- */
writeStances([{ id: 's_3', tags: ['两岸', '关系'], take: '这话题我不聊', why: '', at: Date.now(), src: 'chat' }])
pass('T7', '边界话题一律不匹配（哪怕自己记过）', matchStances('你怎么看两岸关系').length === 0)
pass('T7b', '边界话题不注入', opinionLine({ reply: { opinion: { enabled: true, chance: 100 } } }, { text: '你怎么看两岸关系' }) === '')

/* ---------- T8 脏数据不能让它崩 ---------- */
fs.writeFileSync(FILE, '{ 这不是 JSON')
pass('T8', '文件坏了当成没有', matchStances('你熬夜吗').length === 0 && allStances().length === STANCES.length)
fs.writeFileSync(FILE, JSON.stringify({ items: [{ id: '', tags: '不是数组', take: '' }, { id: 'ok', tags: ['x'], take: 'y' }] }))
pass('T8b', '缺字段的条目被过滤', loadDynamic().length === 1)

/* ---------- T9 工具写的格式（Python 那边）能被读 ---------- */
fs.writeFileSync(
  FILE,
  JSON.stringify({
    items: [
      { id: 's_9', tags: ['食堂', '阿姨'], take: '食堂阿姨手抖是本能', why: '多一勺像割她肉', at: 1792655000000, src: 'chat' }
    ]
  })
)
pass('T9', '能读工具写的格式', matchStances('食堂阿姨').length === 1, JSON.stringify(matchStances('食堂阿姨').map((x) => x.take)))

// 收尾
resetDynamic()
resetOpinions()
console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
