import json, datetime, sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/fh.json"
d = json.load(open(path))
msgs = d.get("data", {}).get("messages", [])
print("total:", len(msgs))
for m in msgs:
    t = datetime.datetime.fromtimestamp(m.get("time", 0)).strftime("%H:%M:%S")
    who = "小号" if m.get("user_id") == m.get("self_id") else "我"
    txt = m.get("raw_message", "")
    if len(txt) > 70:
        txt = txt[:70] + "…"
    print(f"{t}  {who:>3}  {txt}")
