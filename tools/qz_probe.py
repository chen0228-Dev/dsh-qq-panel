import subprocess, re

src = subprocess.run(
    ["docker", "exec", "napcat", "cat", "/app/napcat/napcat.mjs"],
    capture_output=True, text=True, errors="ignore"
).stdout

print("source length:", len(src))

for kw in ["SendQzoneMsg", "DeleteQzoneMsg", "GetQzoneMsgList"]:
    idxs = [m.start() for m in re.finditer(kw, src)]
    print(f"\n=== {kw}: {len(idxs)} hits ===")
    for i in idxs[:6]:
        print("   ...", src[max(0, i - 80):i + 120].replace("\n", " "))

# 看 action 名到 handler 的注册表
m = re.search(r'actionName\s*=\s*\w+\.SendQzoneMsg', src)
print("\nhas class handler for SendQzoneMsg:", bool(m))
if m:
    print(src[max(0, m.start() - 400):m.start() + 700].replace("\n", " "))
