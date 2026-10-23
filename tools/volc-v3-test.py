#!/usr/bin/env python3
"""火山 V3 单向流式 TTS 探测：声音复刻音色在新体系里走 v3 + resource_id。

V3 返回的是一行一个 JSON（NDJSON），每行 data 是一小段 base64 音频，
拼起来才是完整 mp3。所以不能当普通 JSON 解析。
"""
import base64
import json
import sys
import uuid
import urllib.error
import urllib.request

APPID = "1246420582"
TOKEN = "uOVACRAXSNBGxzpIBkwclzm_GjVO0REg"
SPEAKER = "S_5eBLaJQi2"
TEXT = "在干嘛呢，我刚睡醒"
URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
OUT = "/root/qq-workspace/voice/volc-v3-test.mp3"


def call(headers, resource, label):
    body = {
        "user": {"uid": "qqbot"},
        "req_params": {
            "text": TEXT,
            "speaker": SPEAKER,
            "audio_params": {"format": "mp3", "sample_rate": 24000},
        },
    }
    h = {"Content-Type": "application/json", "X-Api-Resource-Id": resource}
    h.update(headers)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers=h)
    chunks = []
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    j = json.loads(line)
                except Exception:
                    print(f"[{label}] 非 JSON 行: {line[:120]}")
                    continue
                code = j.get("code")
                if j.get("data"):
                    chunks.append(base64.b64decode(j["data"]))
                if code not in (0, 20000000) and code is not None:
                    print(f"[{label}] code={code} message={str(j.get('message'))[:160]}")
                    return None
    except urllib.error.HTTPError as e:
        try:
            print(f"[{label}] HTTP {e.code}: {e.read().decode('utf-8','replace')[:300]}")
        except Exception:
            print(f"[{label}] HTTP {e.code}")
        return None
    except Exception as e:
        print(f"[{label}] 异常: {e}")
        return None
    if not chunks:
        print(f"[{label}] 没有拿到音频数据")
        return None
    data = b"".join(chunks)
    with open(OUT, "wb") as f:
        f.write(data)
    print(f"[{label}] 成功！{len(data)} 字节 → {OUT}")
    return OUT


def main():
    uid = str(uuid.uuid4())
    combos = [
        ({"X-Api-App-Id": APPID, "X-Api-Access-Key": TOKEN, "X-Api-App-Key": APPID, "X-Api-Request-Id": uid},
         "seed-icl-2.0", "appid+token / seed-icl-2.0"),
        ({"X-Api-App-Id": APPID, "X-Api-Access-Key": TOKEN, "X-Api-App-Key": APPID, "X-Api-Request-Id": uid},
         "seed-icl-1.0", "appid+token / seed-icl-1.0"),
        ({"X-Api-Key": TOKEN, "X-Api-Request-Id": uid}, "seed-icl-2.0", "api-key / seed-icl-2.0"),
        ({"X-Api-App-Id": APPID, "X-Api-Access-Key": TOKEN, "X-Api-App-Key": APPID, "X-Api-Request-Id": uid},
         "volc.megatts.default", "appid+token / megatts"),
    ]
    for headers, res, label in combos:
        got = call(headers, res, label)
        if got:
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
