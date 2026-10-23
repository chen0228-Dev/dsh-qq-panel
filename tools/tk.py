import re, json, urllib.request, sys

txt = open("/root/.dsh/.credentials.yaml").read()
lines = txt.splitlines()
tok = None
for i, ln in enumerate(lines):
    s = ln.strip()
    if s.startswith("token:"):
        tok = s.split("token:", 1)[1].strip().strip('"').strip("'")
        break

print("token:", (tok[:10] + "..." + tok[-6:]) if tok else None, "len:", len(tok) if tok else 0)

if not tok:
    sys.exit(1)

body = json.dumps({
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "回复两个字：在的"}],
    "max_tokens": 20
}).encode()

req = urllib.request.Request(
    "https://api.deepseek.com/v1/chat/completions",
    data=body,
    headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
)
try:
    r = json.load(urllib.request.urlopen(req, timeout=30))
    print("CHAT_OK:", r["choices"][0]["message"]["content"][:60])
    print("usage:", r.get("usage"))
except Exception as e:
    print("CHAT_ERR:", type(e).__name__, str(e)[:300])
