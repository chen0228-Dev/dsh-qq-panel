import pathlib, sys

p = pathlib.Path('/root/qq-workspace/AGENTS.md')
text = p.read_text(encoding='utf-8')
anchor = '- **读图里的字**：`qq-ocr <图片路径>` —— 把截图、照片里的文字提取出来。'
line = '- **画图**：`qq-draw "一句话描述"` —— 自己生成一张图并打印路径，再用 `qq_send_image` 发出去。想换尺寸加 `--size 1024x1536`（竖）或 `1536x1024`（横）。**只在对方真的要图、或者你觉得配一张图明显更好时才用**，生成要十几秒，别拿它当玩笑随手烧。'
if 'qq-draw' in text:
    print('already patched')
    sys.exit(0)
if anchor not in text:
    print('ANCHOR MISSING')
    sys.exit(1)
text = text.replace(anchor, anchor + '\n' + line, 1)
p.write_text(text, encoding='utf-8')
print('patched, len=', len(text))
