#!/usr/bin/env python3
"""打印某个 dsh 会话最近几条消息（调试用）。"""
import datetime
import json
import subprocess
import sys

def main():
    path = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    raw = subprocess.run(["zstd", "-dc", path], capture_output=True).stdout
    rows = []
    for line in raw.splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("type")
        if t not in ("user/message", "assistant/message"):
            continue
        data = d.get("data") or {}
        msg = data.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        txt = "".join(b.get("text", "") for b in content if isinstance(b, dict))
        ts = datetime.datetime.fromtimestamp(d.get("time", 0) / 1000).strftime("%H:%M:%S")
        rows.append((ts, t, txt.replace("\n", " ")[:80]))
    for r in rows[-n:]:
        print(r[0], r[1][:9].ljust(9), "|", r[2])


if __name__ == "__main__":
    main()
