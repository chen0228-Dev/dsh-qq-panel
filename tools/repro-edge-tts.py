"""复现面板「试听」在 Edge 模式下的报错，拿到完整错误文本。

preview 分支的 catch 只把错误返回给前端、不写日志，所以 journalctl 里查不到。
这里直接打接口。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')
v = cfg['voice']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]

print('配置里的 edge 参数:', {k: v.get(k) for k in ('voiceName', 'rate', 'pitch')})
print('provider:', v.get('provider'))

payload = {
    'text': '这是一条测试语音',
    'provider': 'edge',
    'voiceName': v.get('voiceName') or 'zh-CN-XiaoyiNeural',
    'rate': v.get('rate') or '+0%',
    'pitch': v.get('pitch') or '+0Hz',
}
print('请求参数:', payload)

req = urllib.request.Request(
    BASE + '/api/voice/preview',
    data=json.dumps(payload, ensure_ascii=False).encode(),
    headers={'Content-Type': 'application/json', 'Cookie': cookie},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        body = r.read()
        print('成功:', r.status, len(body), 'bytes')
except urllib.error.HTTPError as e:
    print('失败:', e.code)
    print(e.read().decode('utf-8', 'replace'))
