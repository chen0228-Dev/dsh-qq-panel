"""群聊功能端到端验证。

会真的开关群聊两次 → 触发两次 dsh 重启（各约 10 秒，QQ 不掉线）。
用测试群号 999999999，验证完立即关闭并清空白名单。
"""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')
PATCH = '/root/.dsh/profiles/web/cordis.patch.yml'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]


def call(path, data=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method='POST' if data is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def patch_lines():
    txt = open(PATCH, encoding='utf-8').read()
    return [l.strip() for l in txt.splitlines() if 'groupPolicy' in l or 'groupAllowFrom' in l or 'requireMention' in l]


print('1) 初始状态')
st, r = call('/api/groups')
print('   GET /api/groups ->', st, r)

print('2) 开启群聊 + 加白名单群（会重启 dsh）')
st, r = call('/api/groups', {
    'enabled': True,
    'requireMention': True,
    'entries': [{'groupId': '999999999', 'name': '_测试群', 'enabled': True, 'overrides': {}}],
})
print('   POST ->', st, '| applied:', (r.get('applied') if isinstance(r, dict) else r))
print('   patch:', patch_lines())

print('3) 配置落盘')
c = json.load(open('/opt/qqbot/panel/data/config.json'))
print('   groups:', {k: v for k, v in (c.get('groups') or {}).items() if k != 'entries'})
print('   entries:', [(e.get('groupId'), e.get('name'), e.get('enabled')) for e in (c['groups'].get('entries') or [])])

print('4) 关掉群聊（再重启一次）')
st, r = call('/api/groups', {'enabled': False, 'requireMention': True, 'entries': []})
print('   POST ->', st, '| applied:', (r.get('applied') if isinstance(r, dict) else r))
print('   patch:', patch_lines())

print('5) 收尾确认')
st, r = call('/api/groups')
print('   groups ->', r.get('groups'))
print('   白名单已清空:', len((r.get('groups') or {}).get('entries') or []) == 0)
