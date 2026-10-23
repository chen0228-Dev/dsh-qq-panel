#!/bin/bash
# 一次性的对比样音生成脚本：原声 8 秒 + 三个候选音色，拼成一个 mp3
set -e
cd /tmp
rm -f candA.mp3 candB.mp3 candC.mp3 sil.mp3 orig8.mp3 list.txt

TXT="想你也能成为嗜好，当你说今天的烦恼，当你说夜深你睡不着"

edge-tts --voice zh-CN-XiaoyiNeural   --rate=-10% --pitch=+0Hz --text "$TXT" --write-media candA.mp3
edge-tts --voice zh-CN-XiaoxiaoNeural --rate=-12% --pitch=+6Hz --text "$TXT" --write-media candB.mp3
edge-tts --voice zh-TW-HsiaoYuNeural  --rate=-10% --pitch=+2Hz --text "$TXT" --write-media candC.mp3
ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=24000:cl=mono -t 0.7 sil.mp3
ffmpeg -y -loglevel error -i /root/qq-workspace/voice/moyuji-original.mp3 -t 8 -ar 24000 -ac 1 orig8.mp3

echo "候选时长:"
for f in candA candB candC; do
  echo "  $f = $(ffprobe -v error -show_entries format=duration -of csv=p=0 $f.mp3) 秒"
done

printf "file 'orig8.mp3'\nfile 'sil.mp3'\nfile 'candA.mp3'\nfile 'sil.mp3'\nfile 'candB.mp3'\nfile 'sil.mp3'\nfile 'candC.mp3'\n" > list.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -ar 24000 -ac 1 -b:a 96k /opt/qqbot/panel/public/moyuji-compare.mp3
echo "合并结果: $(ffprobe -v error -show_entries format=duration -of csv=p=0 /opt/qqbot/panel/public/moyuji-compare.mp3) 秒"
ls -la /opt/qqbot/panel/public/moyuji-compare.mp3
