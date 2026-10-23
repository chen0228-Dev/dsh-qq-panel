#!/usr/bin/env python3
"""看百度移动版结果页的 DOM 结构，决定怎么抠。"""
import re
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
q = urllib.parse.quote("奶蛙 梗")

for site in ["https://m.baidu.com/s?word=", "https://www.baidu.com/s?wd="]:
    url = site + q
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception as e:
        print(site, "ERR", e)
        continue
    print("=" * 20)
    print(site, "len", len(body))
    # 常见的结果容器 class
    for pat in [r'class="(c-result[^"]*)"', r'class="(result[^"]*)"', r'class="(c-container[^"]*)"']:
        found = re.findall(pat, body)[:3]
        print(f"  {pat} -> {found}")
    # 找标题链接
    m = re.findall(r'<(h3|div)[^>]*class="[^"]*t[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', body, re.S)[:3]
    print("  标题样例:", [(u[:60], re.sub(r"<[^>]+>", "", t)[:30]) for _, u, t in m])
    # 看看有没有 data-log / mu 属性
    print("  含 mu= 的链接数:", len(re.findall(r'mu="http', body)))
    print("  片段:", body[:200].replace("\n", " "))
