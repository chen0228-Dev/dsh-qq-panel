"""模拟面板「发到 QQ」按钮：带上一份和前端一模一样的表单值（token 是掩码）。

验证两件事：
1. 掩码 token 能被换成真值（否则火山会 401）；
2. 合成用的音色与面板配置一致，不是回退的 Edge。
会真的发一条语音给 adminQQ —— 这正是要验证的端到端路径。
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
print('cookie:', cookie[:16] + '...')

# 先取 /api/state，拿到前端看到的 voice（token 已脱敏成掩码）
req = urllib.request.Request(BASE + '/api/state', headers={'Cookie': cookie})
with urllib.request.urlopen(req, timeout=20) as r:
    state = json.loads(r.read().decode())
print('表单里的 token 形态:', repr(state['config']['voice']['volc']['accessToken']))

body = {
    'text': '这条是用面板里调好的音色发的，你听听和试听是不是一个声音',
    # 直接拿 /api/state 里的 voice 当表单值 —— 这正是前端输入框里回填的内容
    # （含掩码 token），比自己手写掩码更贴近真实点击行为。
    'voice': state['config']['voice'],
}

req = urllib.request.Request(
    BASE + '/api/voice',
    data=json.dumps(body, ensure_ascii=False).encode(),
    headers={'Content-Type': 'application/json', 'Cookie': cookie},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=90) as r:
        print('POST /api/voice ->', r.status, json.loads(r.read().decode()))
except urllib.error.HTTPError as e:
    print('POST /api/voice ->', e.code, e.read().decode()[:300])
