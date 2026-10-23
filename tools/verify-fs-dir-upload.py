"""线上验证文件夹上传：写一个带子目录的文件，确认结构建对，再删掉。

用真实的 workspace 根，但只碰自己建的 `_上传测试` 目录，跑完清干净。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')
ws = cfg['paths']['workspace']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]


def post(path, body=None, raw=None):
    data = raw if raw is not None else json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


import os

rel = '_上传测试/子目录/说明.txt'
status, r = post('/api/fs/upload?path=&name=' + urllib.parse.quote(rel), raw='这是文件夹上传测试'.encode())
print('上传 ->', status, r)
print('落盘结构 ->', os.path.exists(os.path.join(ws, '_上传测试', '子目录', '说明.txt')))

def get(path):
    req = urllib.request.Request(BASE + path, headers={'Cookie': cookie})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


status, r = get('/api/fs/list?path=' + urllib.parse.quote('_上传测试/子目录'))
print('列子目录 ->', status, [i.get('name') for i in (r.get('items') if isinstance(r, dict) else [])])

status, r = post('/api/fs/delete', {'path': '_上传测试'})
print('清理 ->', status, r)
print('已清理 ->', not os.path.exists(os.path.join(ws, '_上传测试')))

# 越界仍然要拒（线上再确认一次）
status, r = post('/api/fs/upload?path=&name=' + urllib.parse.quote('../../tmp/evil.txt'), raw=b'x')
print('穿越被拒 ->', status, r if status != 200 else '!!! 没拦住')
