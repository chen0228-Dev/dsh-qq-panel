#!/usr/bin/env python3
"""用火山 V1 HTTP 接口试合成一句，验证 APP ID / Token / 声音ID 三者是否对得上。"""
import base64
import json
import subprocess
import sys
import uuid
import urllib.request

APPID = "1246420582"
TOKEN = "uOVACRAXSNBGxzpIBkwclzm_GjVO0REg"
SPEAKER = "S_5eBLaJQi2"
TEXT = "在干嘛呢，我刚睡醒"
URL = "https://openspeech.bytedance.com/api/v1/tts"

OUT = "/root/qq-workspace/voice/volc-test.mp3"


def try_cluster(cluster):
    body = {
        "app": {"appid": APPID, "token": TOKEN, "cluster": cluster},
        "user": {"uid": "qqbot-test"},
        "audio": {"voice_type": SPEAKER, "encoding": "mp3", "speed_ratio": 1.0},
        "request": {"reqid": str(uuid.uuid4()), "text": TEXT, "operation": "query"},
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer;" + TOKEN},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        print(f"[{cluster}] HTTP {e.code}: {body[:400]}")
        return None
    except Exception as e:
        print(f"[{cluster}] 请求异常: {e}")
        return None
    try:
        j = json.loads(raw)
    except Exception:
        print(f"[{cluster}] 返回不是 JSON: {raw[:200]}")
        return None
    code = j.get("code")
    print(f"[{cluster}] code={code} message={str(j.get('message'))[:120]}")
    if code == 3000 and j.get("data"):
        data = base64.b64decode(j["data"])
        with open(OUT, "wb") as f:
            f.write(data)
        print(f"[{cluster}] 合成成功: {OUT} ({len(data)} 字节)")
        return OUT
    return None


if __name__ == "__main__":
    for cluster in ("volcano_icl", "volcano_mega"):
        got = try_cluster(cluster)
        if got:
            info = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-show_entries", "stream=sample_rate,channels", "-of", "default=nw=1", got],
                capture_output=True, text=True,
            ).stdout.strip().replace("\n", " ")
            print("音频信息:", info)
            sys.exit(0)
    print("两个集群都没成功 —— 看上面的 code / message")
    sys.exit(1)
