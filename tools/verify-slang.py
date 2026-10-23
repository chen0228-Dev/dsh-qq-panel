"""黑话功能端到端验证。

1. 手动加词 → 确认 → 看 AGENTS.md 是否**不该**注入（count=1 < minCount=2）
2. 把 count 改成 2 → 再触发一次写人格 → 应该注入
3. 清理测试词，确认人格文件恢复原样
"""
import json
import os
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18080'
cfg = json.load(open('/opt/qqbot/panel/data/config.json'))
key = cfg.get('auth', {}).get('linkKey')
ws = cfg['paths']['workspace']
agents = os.path.join(ws, 'AGENTS.md')
slang_file = '/opt/qqbot/panel/data/slang.json'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


try:
    urllib.request.build_opener(NoRedirect).open(f'{BASE}/?k={key}', timeout=15)
except urllib.error.HTTPError as e:
    cookie = e.headers.get('Set-Cookie', '').split(';')[0]


def call(path, data=None, method=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json', 'Cookie': cookie},
        method=method or ('POST' if data is not None else 'GET'),
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


WORD = '_测试词_yyds'

print('1) 初始状态')
st, r = call('/api/slang')
print('   GET /api/slang ->', st, r.get('counts') if isinstance(r, dict) else r)

print('2) 手动加词')
st, r = call('/api/slang/save', {'word': WORD, 'meaning': '永远的神', 'status': 'confirmed'})
print('   save ->', st, r)

print('3) count=1 时不该注入到人格文件')
body = open(agents, encoding='utf-8').read()
print('   AGENTS.md 含测试词:', WORD in body, '（应为 False）')

print('4) 把 count 改成 2，再触发写人格')
entries = json.load(open(slang_file, encoding='utf-8'))
for e in entries:
    if e['word'] == WORD:
        e['count'] = 2
json.dump(entries, open(slang_file, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
st, r = call('/api/slang/status', {'id': next(e['id'] for e in entries if e['word'] == WORD), 'status': 'confirmed'})
print('   status ->', st, r)
body = open(agents, encoding='utf-8').read()
print('   AGENTS.md 含测试词:', WORD in body, '（应为 True）')
print('   含「你最近学会的说法」:', '你最近学会的说法' in body)

print('5) 清理')
st, r = call('/api/slang/delete', {'id': next(e['id'] for e in entries if e['word'] == WORD)})
print('   delete ->', st, r)
body = open(agents, encoding='utf-8').read()
print('   AGENTS.md 已不含测试词:', WORD not in body)
print('   空词表时不留空标题:', '你最近学会的说法' not in body)

print('6) 拒绝状态的词永不注入')
st, r = call('/api/slang/save', {'word': WORD, 'meaning': 'x', 'status': 'confirmed'})
entries = json.load(open(slang_file, encoding='utf-8'))
tid = next(e['id'] for e in entries if e['word'] == WORD)
call('/api/slang/status', {'id': tid, 'status': 'rejected'})
print('   拒绝后 AGENTS.md 含测试词:', WORD in open(agents, encoding='utf-8').read(), '（应为 False）')
call('/api/slang/delete', {'id': tid})
print('   清理完成:', WORD not in open(slang_file, encoding='utf-8').read())
