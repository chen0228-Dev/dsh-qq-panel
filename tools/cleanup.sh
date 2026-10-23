#!/usr/bin/env bash
# dsh + NapCat 缓存清理。跑在服务器上，由 qqbot-cleanup.timer 每天触发。
# 用法：cleanup.sh         正常清理
#       cleanup.sh --dry   只统计不删除
set -u

DRY=""
[ "${1:-}" = "--dry" ] && DRY=1

MEDIA_DAYS=30      # 图片/语音缓存保留天数
SESS_DAYS=60       # 会话备份保留天数
DOCKER_LOG_MB=50   # 容器日志超过这个大小就截断
BAK_KEEP=3         # 每个 .bak 只留最近几份

note() { echo "[cleanup] $*"; }

human() { awk -v b="${1:-0}" 'BEGIN{printf "%.1f MB", b/1048576}'; }

# 1) 图片 / 语音 / 附件缓存
for d in /root/.dsh/media /root/.dsh/attachments; do
  [ -d "$d" ] || continue
  bytes=$(find "$d" -type f -mtime +"$MEDIA_DAYS" -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
  count=$(find "$d" -type f -mtime +"$MEDIA_DAYS" 2>/dev/null | wc -l)
  if [ "$count" -gt 0 ]; then
    note "$d: $count 个文件超过 ${MEDIA_DAYS} 天，$(human "$bytes")"
    [ -z "$DRY" ] && find "$d" -type f -mtime +"$MEDIA_DAYS" -delete 2>/dev/null
  else
    note "$d: 没有需要清理的文件"
  fi
done

# 2) 联网能力的临时文件：抖音抽帧、下载的图片
for d in /root/qq-workspace/douyin /root/qq-workspace/downloads; do
  [ -d "$d" ] || continue
  bytes=$(find "$d" -type f -mtime +"$MEDIA_DAYS" -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
  count=$(find "$d" -type f -mtime +"$MEDIA_DAYS" 2>/dev/null | wc -l)
  if [ "$count" -gt 0 ]; then
    note "$d: $count 个文件超过 ${MEDIA_DAYS} 天，$(human "$bytes")"
    [ -z "$DRY" ] && find "$d" -type f -mtime +"$MEDIA_DAYS" -delete 2>/dev/null
  else
    note "$d: 没有需要清理的文件"
  fi
done

# 3) 旧的 .bak 备份（配置文件每次保存都会生成一份）
for f in /root/qq-workspace/AGENTS.md.bak \
         /root/.dsh/profiles/web/cordis.patch.yml.bak \
         /root/.dsh/profiles/web/cordis.yml.bak; do
  [ -f "$f" ] || continue
  age=$(( ( $(date +%s) - $(stat -c %Y "$f") ) / 86400 ))
  if [ "$age" -gt 7 ]; then
    note "$(basename "$f") 已 $age 天，删除"
    [ -z "$DRY" ] && rm -f "$f"
  fi
done

# 4) 会话日志备份
find /root/.dsh/sessions -name '*.bak' -mtime +"$SESS_DAYS" -print 2>/dev/null | while read -r f; do
  note "会话备份超过 ${SESS_DAYS} 天：$f"
  [ -z "$DRY" ] && rm -f "$f"
done

# 5) 容器日志截断（docker 默认不轮转，长时间运行会一直涨）
for c in napcat; do
  p=$(docker inspect -f '{{.LogPath}}' "$c" 2>/dev/null)
  [ -n "$p" ] && [ -f "$p" ] || continue
  size=$(stat -c %s "$p" 2>/dev/null || echo 0)
  if [ "$size" -gt $((DOCKER_LOG_MB * 1048576)) ]; then
    note "容器 $c 日志 $(human "$size")，截断"
    [ -z "$DRY" ] && truncate -s 0 "$p"
  fi
done

# 6) 系统 journal 只保留 7 天
if [ -z "$DRY" ]; then
  journalctl --vacuum-time=7d >/dev/null 2>&1 || true
fi

note "完成（$([ -n "$DRY" ] && echo '试运行，未删除' || echo '已清理')）"
free -m | awk 'NR==2{printf "[cleanup] 内存：已用 %s / 共 %s MB，可用 %s MB\n", $3, $2, $7}'
