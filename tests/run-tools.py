#!/usr/bin/env python3
"""工具级测试跑批：逐条执行，打印 结果/耗时/输出摘要。"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

OUT = "/tmp/tool-test-results.json"
results = []


def run(cid, desc, cmd, timeout=120, expect=None):
    t0 = time.time()
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or "") + (("\n[stderr]\n" + r.stderr) if r.stderr.strip() else "")
        rc = r.returncode
    except subprocess.TimeoutExpired:
        out, rc = "TIMEOUT", -1
    dt = time.time() - t0
    ok = rc == 0 and bool(out.strip())
    if ok and expect:
        # tesseract 输出中文时会在字之间塞空格（「会 议 室」），
        # 直接比字符串会假失败，所以再拿「去掉所有空白」的版本比一次
        ok = expect in out or expect in re.sub(r"\s+", "", out)
    snippet = " ".join(out.strip().splitlines()[:3])[:180]
    results.append({"id": cid, "desc": desc, "ok": ok, "rc": rc, "sec": round(dt, 1), "snippet": snippet})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {desc}  rc={rc} {dt:.1f}s")
    print(f"        {snippet}")
    return out


# 准备素材
STICKER_DIR = "/root/qq-workspace/stickers"
STICKERS = sorted(os.listdir(STICKER_DIR))
STICKERS = [s for s in STICKERS if s.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))]
src = os.path.join(STICKER_DIR, STICKERS[0]) if STICKERS else ""
os.makedirs("/tmp/tfix", exist_ok=True)
if src:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", "hflip", "/tmp/tfix/new1.png"])
    shutil.copy(src, "/tmp/tfix/dup_src.png")

# OCR 素材：现场渲染一张有字的图。
# 原来 A12 直接拿抖音图集的图去认，那张本来就没字，识别不出来也算 PASS ——
# 等于这个用例从来没真正测过 OCR。这里自己造图，并且断言必须认出「会议室」。
OCR_IMG = "/tmp/tfix/ocr-case.png"
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
if os.path.exists(FONT):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x1c1c1e:s=760x300",
         "-vf",
         f"drawtext=fontfile={FONT}:text='会议改到下午四点半 地点在三楼会议室':fontcolor=0xdcdfe4:fontsize=22:x=36:y=60,"
         f"drawtext=fontfile={FONT}:text='记得带上周的测试报告':fontcolor=0xdcdfe4:fontsize=22:x=36:y=120",
         "-frames:v", "1", OCR_IMG],
    )

print("=" * 20, "A. 工具级", "=" * 20)
run("A1", "qq-search 官方", 'qq-search "奶蛙 梗" -n 3', expect="奶蛙")
run("A2", "qq-search 免费兜底", 'curl -s -H "Cookie: qp_auth=$(node -e "import(\'/opt/qqbot/panel/lib/store.js\').then(m=>console.log(m.signSession(1)))" -C /opt/qqbot/panel)" '
    '-X POST http://127.0.0.1:18080/api/config -H "Content-Type: application/json" -d \'{"search":{"provider":"free"}}\' >/dev/null; '
    'qq-search "奶蛙 梗" -n 2; '
    'curl -s -H "Cookie: qp_auth=$(node -e "import(\'/opt/qqbot/panel/lib/store.js\').then(m=>console.log(m.signSession(1)))" -C /opt/qqbot/panel)" '
    '-X POST http://127.0.0.1:18080/api/config -H "Content-Type: application/json" -d \'{"search":{"provider":"deepseek"}}\' >/dev/null')
run("A3", "qq-browse 百科", 'qq-browse "https://baike.baidu.com/item/%E7%89%9B%E6%9D%A5" --chars 300')
run("A5", "qq-douyin 图文", 'qq-douyin "https://v.douyin.com/0c0Mx3mX8-Y/" 2>&1 | head -12')
run("A6", "qq-douyin 视频", 'qq-douyin "https://v.douyin.com/M28k_Va-6dQ" 2>&1 | head -14')
run("A7", "qq-music 搜歌", 'qq-music "晴天" -n 3')
run("A8", "qq-music --story", 'qq-music "晴天" --story 2>&1 | tail -8')
run("A9", "qq-sticker 列表", 'qq-sticker -n 5')
run("A10", "qq-save-sticker 存图", 'qq-save-sticker /tmp/tfix/new1.png --tags "测试,临时" --desc "测试用图" 2>&1 | head -4')
run("A11", "qq-save-sticker 去重", 'qq-save-sticker /tmp/tfix/new1.png --tags "测试,重复" 2>&1 | head -4')
IMG = "/root/qq-workspace/douyin/7698704515197878779/img-01.jpg"
run("A12", "qq-ocr 识图", f'qq-ocr "{OCR_IMG}" 2>&1 | head -6', expect="会议室")
run("A13", "qq-hear 转写", 'f=$(tts "今天天气不错，我们出去走走吧" | grep -o "/root[^ ]*\\.mp3" | head -1); echo "音频: $f"; qq-hear "$f" 2>&1 | head -6')
run("A14", "qq-react 别名/列表", 'qq-react --list 2>&1 | head -3')
run("A15", "qq-face 列表", 'qq-face --list 2>&1 | head -3')
run("A16", "qq-grab 下载", 'qq-grab "https://www.baidu.com/img/flexible/logo/pc/result.png" 2>&1 | head -4')

print("=" * 20, "B. TTS", "=" * 20)
run("B1", "Edge 合成", 'edge-tts --voice zh-CN-XiaoyiNeural --text "测试一下" --write-media /tmp/tfix/e.mp3 && ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/tfix/e.mp3')

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print("\n写入", OUT, "共", len(results), "条")
