#!/usr/bin/env python3
"""试试各个搜索源能不能搜到「奶蛙」这种新梗。"""
import json
import re
import urllib.parse
import urllib.request

UA_M = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
UA_D = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
Q = "奶蛙 梗"


def get(url, ua=UA_D, extra=None, timeout=20):
    h = {"User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9"}
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:
        return getattr(e, "code", 0), f"ERR {e}"


def report(name, status, body, needle="奶蛙"):
    hit = body.count(needle)
    print(f"{name}: HTTP {status} len={len(body)} 命中「{needle}」x{hit}")
    return hit


q = urllib.parse.quote(Q)
print("=== 查询:", Q, "===\n")

s, b = get(f"https://cn.bing.com/search?q={q}&setlang=zh-CN")
report("Bing(桌面)", s, b)
if s == 200 and "奶蛙" not in b:
    # 看看 Bing 到底返回了什么
    titles = re.findall(r"<h2[^>]*>(.*?)</h2>", b, re.S)[:3]
    print("   Bing 前几个标题:", [re.sub(r"<[^>]+>", "", t)[:40] for t in titles])

s, b = get(f"https://www.baidu.com/s?wd={q}&ie=utf-8", UA_M)
report("百度(移动)", s, b)

s, b = get(f"https://www.sogou.com/web?query={q}")
report("搜狗", s, b)

s, b = get(f"https://www.so.com/s?q={q}")
report("360", s, b)

# 萌娘百科：梗类条目最全
s, b = get(
    "https://zh.moegirl.org.cn/api.php?action=query&list=search&srsearch=" + urllib.parse.quote("奶蛙") + "&format=json&srlimit=5"
)
print(f"萌娘百科 API: HTTP {s} len={len(b)}")
if s == 200:
    try:
        d = json.loads(b)
        hits = d.get("query", {}).get("search", [])
        print("   结果:", [(h.get("title"), h.get("snippet", "")[:40]) for h in hits])
    except Exception as e:
        print("   解析失败:", e, b[:120])
