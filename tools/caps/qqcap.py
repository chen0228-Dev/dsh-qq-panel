#!/usr/bin/env python3
"""qqcap —— QQ 机器人联网能力的公共层。

所有 qq-* 命令启动时都先过 need()：能力没开就立刻退出，
这样面板上的开关对「它自己想用」和「别人让它用」都有效。
"""
import json
import os
import sys

CAP_FILE = os.environ.get("QQCAP_FILE", "/root/qq-workspace/.capabilities.json")
CONFIG_FILE = os.environ.get("QCAP_CONF", "/opt/qqbot/panel/data/config.json")


def config():
    """读面板的 config.json。读不到就返回空 dict，调用方自己兜底。"""
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def search_cred():
    """
    搜索走哪家。
    返回 ("deepseek", api_key) 或 ("free", "")。
    面板里选了 deepseek 又填了 key 才走官方接口，否则退回多引擎抓取。
    """
    conf = config().get("search") or {}
    key = (conf.get("apiKey") or "").strip()
    if conf.get("provider") == "deepseek" and key:
        return "deepseek", key
    return "free", ""


# 默认全开：面板还没写过配置文件时也能用
DEFAULTS = {
    "search": True,
    "music": True,
    "hear": True,
    "douyin": True,
    "ocr": True,
    "download": True,
    "face": True,
    "avatar": True,
    # qq-stance 记 / 删自己的立场
    "stances": True,
    # qq-routine 改自己的当前日程（「我去打球了」要算数）
    "routine": True,
    # qq-event 往自己的活动池里加事（「最近想学吉他」会变成某天的真实安排）
    "events": True,
    # 表情包那条线（qq-sticker / qq-save-sticker / qq-react）。
    # 开关不在「能力」页，在「表情包」页，面板保存时会写到这个文件里。
    "sticker": True,
}

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def caps():
    try:
        with open(CAP_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    out = dict(DEFAULTS)
    for k, v in data.items():
        if k in DEFAULTS:
            out[k] = bool(v)
    return out


def need(name):
    """能力关闭时打印原因并以 2 退出。"""
    if not caps().get(name, True):
        print(f"[能力已关闭：{name}] 需要先在控制面板的「能力」页打开。")
        sys.exit(2)


def clip(text, n):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n] + "…"


def die(msg, code=1):
    print(f"[错误] {msg}")
    sys.exit(code)


def http_get(url, headers=None, timeout=20, retries=2):
    """带重试的 GET，返回 (status, text)。不抛异常，调用方自己判断。"""
    import urllib.request
    import urllib.error

    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                enc = r.headers.get_content_charset() or "utf-8"
                try:
                    return r.status, raw.decode(enc, "replace")
                except LookupError:
                    return r.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except Exception as e:  # 网络抖动、超时
            last = e
    die(f"请求失败：{last}")
