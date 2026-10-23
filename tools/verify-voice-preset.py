"""验证「音色下拉选不选」能存住。

模拟前端行为：
1. 读 /api/state 拿到当前 voice（老配置里没有 preset）；
2. POST /api/config，带上 preset:''（等同用户选了「不选，用手填的 ID」）；
3. 再读 /api/state，确认 preset 落盘为 ''，speakerId / speed 等其他字段没被牵连。

只把 preset 写成 ''，不改变实际发声参数。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
    raise SystemExit('没被重定向，异常')
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]


def api(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method='POST' if data is not None else 'GET',
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


state = api('/api/state')
before = state['config']['voice']
print('保存前 volc:', {k: before['volc'].get(k) for k in ('speakerId', 'speed', 'resourceId', 'preset')})

voice = json.loads(json.dumps(before))
voice['volc']['preset'] = ''      # 用户在下拉里选了「不选」
r = api('/api/config', {'voice': voice})
print('POST /api/config ->', r.get('applied'))

after = api('/api/state')['config']['voice']
print('保存后 volc:', {k: after['volc'].get(k) for k in ('speakerId', 'speed', 'resourceId', 'preset')})
print('preset 落盘为 \"\":', after['volc'].get('preset') == '')
print('speakerId 未受影响:', after['volc'].get('speakerId') == before['volc'].get('speakerId'))
print('speed 未受影响:', after['volc'].get('speed') == before['volc'].get('speed'))
print('provider 未受影响:', after.get('provider') == before.get('provider'))
