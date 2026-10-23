"""统计会话里所有 [[引用 变体的形态：是否有空格、是否在段首。"""
import json
import re

p = '/root/.dsh/storages/session_projcache/sessions/onebot-private-10001.json'
data = json.load(open(p, encoding='utf-8'))


def walk(node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'response' and isinstance(v, str) and '引用' in v:
                out.append(v)
            else:
                walk(v, out)
    elif isinstance(node, list):
        for v in node:
            walk(v, out)


res = []
walk(data, res)
print('含「引用」的 response 条数:', len(res))

pat = re.compile(r'\[\[\s*引用\s*(\d{1,2})\s*\]\]')
head = mid = 0
samples = []
for r in res:
    for m in pat.finditer(r):
        if m.start() == 0:
            head += 1
        else:
            mid += 1
            if len(samples) < 6:
                samples.append(r[max(0, m.start() - 30):m.start() + 25])
print('段首（index 0）:', head, '| 非段首:', mid)
print('--- 非段首样例 ---')
for s in samples:
    print(repr(s))
