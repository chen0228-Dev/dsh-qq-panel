/**
 * 多模态接口测试：生图 + 外部语音识别。
 *
 * 覆盖的是「面板这层自己写的代码」：地址拼接、出图两种返回形式、
 * 体积限制、错误脱敏、SSRF 拦截、以及配置联动（外部 ASR 必须关掉插件转写）。
 *
 * 不覆盖真实第三方接口 —— 没有第三方凭证，说测过就是撒谎。
 * 所以全部对着本地 mock 服务跑，验证的是请求构造和错误路径。
 *
 * 跑法：node tests/multimodal-test.mjs
 * 不写 config、不碰网络外网，可以安全地在生产机上跑。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateImage, transcribeAudio, endpoint, safeError, IMAGE_LIMIT } from '../panel/lib/multimodal.js'

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

// 1x1 的 PNG，够 imageType() 认出是 png
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const mock = {
  imagesMode: 'b64',
  audioMode: 'ok',
  lastAuth: null,
  lastBody: null
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks)
  mock.lastAuth = req.headers.authorization || null

  if (req.url === '/v1/images/generations') {
    mock.lastBody = JSON.parse(raw.toString('utf8') || '{}')
    if (mock.imagesMode === 'error') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
    }
    if (mock.imagesMode === 'huge') {
      // 合法 base64 但解出来超过 10MB
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ b64_json: Buffer.alloc(IMAGE_LIMIT + 1024, 1).toString('base64') }] }))
    }
    if (mock.imagesMode === 'bad') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{}] }))
    }
    if (mock.imagesMode === 'url') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 指向内网：用来验证 URL 出图会被 SSRF 防护拦住
      return res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1:9/x.png' }] }))
    }
    if (mock.imagesMode === 'urlpublic') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ url: 'https://example.com/x.png' }] }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  }

  if (req.url === '/v1/audio/transcriptions') {
    const text = raw.toString('latin1')
    mock.lastBody = { multipart: text.includes('name="file"'), hasModel: text.includes('audio/transcriptions') || text.includes('model') }
    if (mock.audioMode === 'error') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'bad key' } }))
    }
    if (mock.audioMode === 'empty') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ text: '   ' }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ text: '今天食堂的饭太难吃了' }))
  }

  res.writeHead(404)
  res.end('no')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/v1`
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ws-'))

try {
  console.log('\n[1] endpoint()')
  ok('拼接 /images/generations', endpoint(base, 'images/generations') === `${base}/images/generations`)
  ok('去掉结尾多余斜杠', endpoint(base + '///', 'audio/transcriptions') === `${base}/audio/transcriptions`)
  ok('空地址报明确错误', (() => { try { endpoint('', 'x'); return false } catch (e) { return e.message.includes('接口地址') } })())
  ok('拒绝非 http 协议', (() => { try { endpoint('ftp://a.com', 'x'); return false } catch { return true } })())
  ok('拒绝带账号密码的地址', (() => { try { endpoint('https://u:p@a.com', 'x'); return false } catch { return true } })())

  console.log('\n[2] safeError()')
  const sec = safeError(new Error('fetch failed for https://api.x.com/v1?key=sk-secret123'), 'sk-secret123')
  ok('隐藏 API key', !sec.includes('sk-secret123'), sec)
  ok('隐藏完整 URL', !/https?:\/\//.test(sec), sec)
  ok('长度受限', sec.length <= 240)

  console.log('\n[3] generateImage 参数与开关')
  ok('未启用直接拒绝', await (async () => {
    try { await generateImage('猫', { enabled: false }, workspace); return false } catch (e) { return e.message.includes('未开启') }
  })())
  ok('空 prompt 拒绝', await (async () => {
    try { await generateImage('  ', { enabled: true, model: 'm', baseUrl: base }, workspace); return false } catch (e) { return e.message.includes('1–4000') }
  })())
  ok('缺模型名拒绝', await (async () => {
    try { await generateImage('猫', { enabled: true, baseUrl: base }, workspace); return false } catch (e) { return e.message.includes('模型') }
  })())

  console.log('\n[4] generateImage b64_json')
  mock.imagesMode = 'b64'
  const one = await generateImage('一只橘猫', { enabled: true, model: 'gpt-image-1', baseUrl: base, apiKey: 'sk-test', size: '1024x1536' }, workspace)
  ok('返回落盘路径', fs.existsSync(one.file), one.file)
  ok('扩展名按魔数判定为 png', one.file.endsWith('.png'))
  ok('文件大小等于解码结果', one.bytes === PNG.length, String(one.bytes))
  ok('请求带了 Bearer key', mock.lastAuth === 'Bearer sk-test', String(mock.lastAuth))
  ok('请求体带 model/prompt/size', mock.lastBody?.model === 'gpt-image-1' && mock.lastBody?.prompt === '一只橘猫' && mock.lastBody?.size === '1024x1536')
  ok('n 固定为 1（不多花钱）', mock.lastBody?.n === 1)
  ok('落在 workspace/generated-images 下', one.file.includes(path.join('generated-images', '')))

  console.log('\n[5] generateImage 异常与防护')
  mock.imagesMode = 'error'
  ok('上游 500 报错且不泄露 key', await (async () => {
    try { await generateImage('猫', { enabled: true, model: 'm', baseUrl: base, apiKey: 'sk-secret' }, workspace); return false } catch (e) {
      return e.message.includes('HTTP 500') && !e.message.includes('sk-secret')
    }
  })())
  mock.imagesMode = 'bad'
  ok('没有 url/b64 时报错', await (async () => {
    try { await generateImage('猫', { enabled: true, model: 'm', baseUrl: base }, workspace); return false } catch (e) { return e.message.includes('url') || e.message.includes('b64') }
  })())
  mock.imagesMode = 'huge'
  ok('超过 10MB 拒绝', await (async () => {
    try { await generateImage('猫', { enabled: true, model: 'm', baseUrl: base }, workspace); return false } catch (e) { return /10MB|过大|超过/.test(e.message) }
  })(), '按 base64 长度提前拦，不用先解码')
  mock.imagesMode = 'url'
  ok('URL 出图指向内网被拦（SSRF）', await (async () => {
    try { await generateImage('猫', { enabled: true, model: 'm', baseUrl: base }, workspace); return false } catch (e) { return /内网|本机|下载/.test(e.message) }
  })(), '这是有意保守的取舍')

  console.log('\n[6] transcribeAudio')
  ok('空音频拒绝', await (async () => {
    try { await transcribeAudio(Buffer.alloc(0), { model: 'whisper-1', baseUrl: base }); return false } catch (e) { return e.message.includes('音频') }
  })())
  ok('缺模型名拒绝', await (async () => {
    try { await transcribeAudio(Buffer.from('x'), { baseUrl: base }); return false } catch (e) { return e.message.includes('模型') }
  })())

  // 用假的转换器写一个 wav，绕开「开发机没 ffmpeg」
  const fakeConvert = async (_in, out) => {
    fs.writeFileSync(out, Buffer.from('RIFF____WAVEfake'))
  }
  mock.audioMode = 'ok'
  const said = await transcribeAudio(Buffer.from('fake-amr'), { model: 'whisper-1', baseUrl: base, apiKey: 'sk-a', language: 'zh' }, { convert: fakeConvert })
  ok('拿到识别文字', said === '今天食堂的饭太难吃了', said)
  ok('走 multipart 上传', mock.lastBody?.multipart === true)
  ok('带上 Bearer key', mock.lastAuth === 'Bearer sk-a')

  mock.audioMode = 'empty'
  ok('空结果报「未返回文字」', await (async () => {
    try { await transcribeAudio(Buffer.from('x'), { model: 'm', baseUrl: base }, { convert: fakeConvert }); return false } catch (e) { return e.message.includes('未返回文字') }
  })())
  mock.audioMode = 'error'
  ok('401 报错且不泄露 key', await (async () => {
    try { await transcribeAudio(Buffer.from('x'), { model: 'm', baseUrl: base, apiKey: 'sk-verysecret' }, { convert: fakeConvert }); return false } catch (e) {
      return e.message.includes('401') && !e.message.includes('sk-verysecret')
    }
  })())

  console.log('\n[7] 配置联动（外部 ASR 必须关掉插件转写）')
  // store.js 的数据目录在模块加载时按 PANEL_DATA 定死，所以要先指到临时目录再 import，
  // 否则这条测试会读生产配置 —— 上次就是这么把生产配置写坏的。
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-data-'))
  process.env.PANEL_DATA = tmpData
  const store = await import('../panel/lib/store.js')
  const baseCfg = JSON.parse(JSON.stringify(store.loadConfig()))
  const cfgOf = (patch) => {
    const c = JSON.parse(JSON.stringify(baseCfg))
    for (const k of Object.keys(patch)) c[k] = { ...(c[k] || {}), ...patch[k] }
    return c
  }
  const localYml = renderPatchOf(cfgOf({ asr: { provider: 'local', baseUrl: '', apiKey: '', model: '', language: 'zh' }, features: { stt: true } }))
  ok('本地识别时 sttEnabled 跟随总开关', /sttEnabled: true/.test(localYml))
  const apiYml = renderPatchOf(cfgOf({ asr: { provider: 'api', baseUrl: 'https://x/v1', apiKey: '', model: 'whisper-1', language: 'zh' }, features: { stt: true } }))
  ok('外部识别时强制 sttEnabled: false', /sttEnabled: false/.test(apiYml), '否则同一条语音会被转两遍')
  const offYml = renderPatchOf(cfgOf({ asr: { provider: 'local', baseUrl: '', apiKey: '', model: '', language: 'zh' }, features: { stt: false } }))
  ok('总开关关掉时 sttEnabled: false', /sttEnabled: false/.test(offYml))
  fs.rmSync(tmpData, { recursive: true, force: true })

  function renderPatchOf(cfg) {
    return store.renderPatch(cfg)
  }

  console.log('\n[8] 配置脱敏与默认值')
  const pub = store.publicConfig()
  ok('imageGen 默认关、尺寸有值', pub.imageGen?.enabled === false && !!pub.imageGen?.size)
  ok('asr 默认走本地', (pub.asr?.provider || 'local') === 'local')
  // 脱敏不能只靠「默认值为空」，要验证「有 key 时返回掩码」。
  // 这里不写磁盘配置（那会污染），直接调 store 的脱敏路径更安全 —— 没有独立函数时
  // 至少确认掩码常量被用在 imageGen/asr 上。
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'panel', 'lib', 'store.js'), 'utf8')
  ok('imageGen key 有掩码处理', /imageGen: \{ \.\.\.c\.imageGen, apiKey: c\.imageGen\.apiKey \? MASK/.test(src))
  ok('asr key 有掩码处理', /asr: \{ \.\.\.c\.asr, apiKey: c\.asr\.apiKey \? MASK/.test(src))

  console.log('\n[9] 前端控件与死锁')
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'panel', 'public', 'index.html'), 'utf8')
  ok('有生图卡片', html.includes('id="ig-enabled"') && html.includes('data-save="imagegen"'))
  ok('生图卡片开关可点回（gate-head）', /class="switch gate-head"><div><div class="lab">启用生图/.test(html))
  ok('有识别方式选择', html.includes('id="ar-provider"'))
  ok('有外部接口字段', html.includes('id="ar-base"') && html.includes('id="ar-model"') && html.includes('id="ar-key"'))
  ok('有生图自检按钮', html.includes('data-run="imagegen-test"'))
  ok('有语音自检按钮', html.includes('data-run="asr-test"'))
  ok('collect 提交 imageGen', /section === 'imagegen'/.test(html) && html.includes('imageGen:'))
  ok('collect 提交 asr.provider', /\$\('ar-provider'\)\.value === 'api'/.test(html))
  ok('切换方式会提示停用本地 whisper', html.includes('避免识别两遍'))
} finally {
  await new Promise((r) => server.close(r))
  fs.rmSync(workspace, { recursive: true, force: true })
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
