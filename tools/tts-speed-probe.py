#!/usr/bin/env python3
"""测火山 V3 的语速参数到底放哪、有没有效。同一句话换参数位置/取值，比时长。"""
import base64
import json
import subprocess
import sys
import urllib.request
import uuid

APPID = "1246420582"
KEY = "uOVACRAXSNBGxzpIBkwclzm_GjVO0REg"
SPK = "S_5eBLaJQi2"
TXT = "今天下午那个会开得我脑壳疼，讲了两小时啥也没定，领导在那绕来绕去。"
URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"


def synth(req_params, out):
    body = {"user": {"uid": "probe"}, "req_params": req_params}
    req = urllib.request.Request(
        URL,
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={
            "X-Api-App-Id": APPID,
            "X-Api-App-Key": APPID,
            "X-Api-Access-Key": KEY,
            "X-Api-Resource-Id": "seed-icl-2.0",
            "X-Api-Request-Id": str(uuid.uuid4()),
            "Content-Type": "application/json",
        },
    )
    chunks, err = [], ""
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                if j.get("data"):
                    chunks.append(base64.b64decode(j["data"]))
                c = j.get("code")
                if c not in (None, 0, 20000000):
                    err = f"code={c} {str(j.get('message'))[:70]}"
    except Exception as e:
        err = str(e)[:80]
    if not chunks:
        print(f"   失败: {err or '无音频'}")
        return None
    open(out, "wb").write(b"".join(chunks))
    d = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
        capture_output=True, text=True,
    ).stdout.strip()
    return d


def base(extra_audio=None, extra_req=None):
    audio = {"format": "mp3", "sample_rate": 24000}
    if extra_audio:
        audio.update(extra_audio)
    rp = {"text": TXT, "speaker": SPK, "audio_params": audio}
    if extra_req:
        rp.update(extra_req)
    return rp


cases = [
    ("基准（不传语速）", base()),
    ("req_params.speech_rate=-50", base(extra_req={"speech_rate": -50})),
    ("req_params.speech_rate=100", base(extra_req={"speech_rate": 100})),
    ("audio_params.speech_rate=-50", base(extra_audio={"speech_rate": -50})),
    ("audio_params.speech_rate=100", base(extra_audio={"speech_rate": 100})),
    ("audio_params.speed_ratio=0.7", base(extra_audio={"speed_ratio": 0.7})),
    ("req_params.speed_ratio=0.7", base(extra_req={"speed_ratio": 0.7})),
]

print("原文:", TXT, f"（{len(TXT)} 字）\n")
for i, (label, rp) in enumerate(cases):
    out = f"/tmp/tts_speed_{i}.mp3"
    print(f"{label}:")
    d = synth(rp, out)
    if d:
        print(f"   时长 {float(d):.2f} 秒  → {out}")
