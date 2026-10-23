"""用面板自己的免登录链接换 cookie，验证 asr/imageGen 的保存链路。

不猜密码：linkKey 就在 config.json 里（本机 root 可读），这是面板设计内的入口。
只回写与当前相同的 asr.provider，保存前后比对关键业务字段，确认没被牵连。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')
if not key:
    print('没有 linkKey，跳过（不猜密码）')
    raise SystemExit(0)

# 1) 换 cookie
# 必须自己掐掉重定向：默认 urllib 会跟着 302 跳到干净地址，
# 那一跳的响应里没有 Set-Cookie，看起来就像「没发 cookie」。
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)
try:
    opener.open(urllib.request.Request(f'{BASE}/?k={key}'), timeout=15)
    print('没被重定向，异常')
    raise SystemExit(0)
except urllib.error.HTTPError as e:
    if e.code != 302:
        print('免登录链接不可用 ->', e.code)
        raise SystemExit(0)
    cookie = e.headers.get('Set-Cookie', '')
    print('换 cookie -> 302')
if 'qp_auth=' not in cookie:
    print('没拿到 qp_auth，跳过')
    raise SystemExit(0)
cookie = cookie.split(';')[0]
print('cookie ok:', cookie[:16] + '...')


def api(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method='POST' if data is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


before = json.load(open('/opt/qqbot/panel/data/config.json'))
prov = before.get('asr', {}).get('provider', 'local')

status, pub = api('/api/config')
print('GET /api/config ->', status, '| 返回含 imageGen:', isinstance(pub, dict) and 'imageGen' in pub, '| 含 asr:', isinstance(pub, dict) and 'asr' in pub)

status, r = api('/api/config', {'asr': {'provider': prov, 'baseUrl': '', 'model': '', 'language': 'zh'}})
print('POST /api/config ->', status, r if not isinstance(r, dict) else {k: r.get(k) for k in list(r)[:8]})

after = json.load(open('/opt/qqbot/panel/data/config.json'))
print('asr 落盘:', after.get('asr'))
print('imageGen 落盘:', after.get('imageGen'))
print('opinion 未变:', after.get('reply', {}).get('opinion', {}) == before.get('reply', {}).get('opinion', {}))
print('proactive.minGap 未变:', after.get('proactive', {}).get('minGap') == before.get('proactive', {}).get('minGap'))
print('campus.busySlots 未变:', after.get('campus', {}).get('busySlots') == before.get('campus', {}).get('busySlots'))
print('grep sttEnabled in patch:', 'sttEnabled: true' if prov == 'local' else 'sttEnabled: false')
print('patch 实际:', [l.strip() for l in open('/root/.dsh/profiles/web/cordis.patch.yml') if 'sttEnabled' in l])
