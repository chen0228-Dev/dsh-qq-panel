#!/usr/bin/env python3
"""探测抖音 share 页里 _ROUTER_DATA 的结构，找出图文/视频的真实字段。"""
import json
import re
import sys

html = open('/tmp/note.html', encoding='utf-8', errors='replace').read()
m = re.search(r'window\._ROUTER_DATA\s*=\s*(\{.*?\});?\s*</script>', html, re.S)
print('found _ROUTER_DATA:', bool(m))
if not m:
    # 换个匹配方式看看页面里到底有什么
    for kw in ['_ROUTER_DATA', 'RENDER_DATA', '__INITIAL_STATE__', 'aweme_detail']:
        print(f'  {kw}:', html.count(kw))
    sys.exit(1)

data = json.loads(m.group(1))
print('top keys:', list(data.keys()))


def walk(o, path='', depth=0):
    if depth > 6:
        return
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ('images', 'imageList', 'desc', 'nickname', 'aweme_id', 'video', 'url_list', 'music'):
                info = str(v)[:140].replace('\n', ' ')
                print(f'HIT {path}/{k} ({type(v).__name__}): {info}')
            walk(v, path + '/' + k, depth + 1)
    elif isinstance(o, list) and o:
        walk(o[0], path + '[0]', depth + 1)


walk(data)

# 找 loaderData 里的条目
ld = data.get('loaderData', {})
print('\nloaderData keys:', list(ld.keys()))
for k, v in ld.items():
    if isinstance(v, dict):
        print(f'  {k} ->', list(v.keys())[:8])
