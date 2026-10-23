import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const dir = '/root/.dsh/sessions/--root-qq-workspace--'
const subs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()) : []

for (const s of subs) {
  const f = path.join(dir, s, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(f)) continue
  let text = ''
  try {
    text = execFileSync('zstd', ['-dc', '--quiet', f], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  } catch (e) {
    text = (e.stdout || '').toString('utf8')
  }
  const lines = text.split('\n').filter(Boolean)
  console.log(`\n===== ${s} (${lines.length} 行) =====`)

  let hits = { agents: 0, local: 0, runtime: 0, memory: 0 }
  let lastTs = 0
  for (const l of lines) {
    if (l.includes('你现在的运行方式')) hits.runtime++
    if (l.includes('长期记忆')) hits.memory++
    if (l.includes('AGENTS.local.md')) hits.local++
    if (l.includes('聊天身份（由控制面板自动生成')) hits.agents++
    try {
      const o = JSON.parse(l)
      if (o.time) lastTs = Math.max(lastTs, o.time)
    } catch {}
  }
  console.log('包含「你是什么/聊天身份」的行:', hits.agents)
  console.log('包含「你现在的运行方式」的行:', hits.runtime)
  console.log('包含「长期记忆」的行:', hits.memory)
  console.log('包含「AGENTS.local.md」的行:', hits.local)
  console.log('最后活动:', lastTs ? new Date(lastTs).toLocaleString('zh-CN') : '-')

  // 找一条 request/context 或 system/message，看 system prompt 片段
  for (const l of lines.slice().reverse()) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (o.type === 'system/message' || o.type === 'request/context' || o.type === 'request/header') {
      const s = JSON.stringify(o.data || o).slice(0, 400)
      console.log(`[${o.type}]`, s.replace(/\\n/g, ' ').slice(0, 300))
      break
    }
  }
}
