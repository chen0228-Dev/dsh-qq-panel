#!/usr/bin/env bash
# 隔离跑会写 config 的测试 —— 避免污染生产 /opt/qqbot/panel/data/config.json
#
# 用法（在服务器 /opt/qqbot 下）：
#   bash tests/run-isolated.sh pace-proactive-test.mjs
#   bash tests/run-isolated.sh sneak-test.mjs
#
# 原理：这些老测试直接 import store.js 的 loadConfig/saveConfig，而 DATA_DIR
# 由 process.env.PANEL_DATA 决定（import 时求值）。所以只要在进程启动前把
# PANEL_DATA 指到临时目录、并把生产 config 复制过去，测试就全程读写副本，
# 碰不到生产配置。跑完连目录一起删。
#
# 为什么必须复制生产 config：测试里 cfg0 = loadConfig() 要拿真实的 qq.adminQQ
# 等字段，空目录里的默认 config 没有这些值，断言会崩。

set -e
cd "$(dirname "$0")/.."          # 回到 /opt/qqbot

TARGET="$1"
[ -z "$TARGET" ] && { echo "用法: bash tests/run-isolated.sh <测试文件名>"; exit 1; }

TMP="$(mktemp -d)"
# 用 node 删临时目录，不用 rm：Windows（Git Bash）下 rm -rf 会被路径前缀检查拦掉，
# 报 "embedded drive prefix is not allowed"，目录就留下来了。
trap 'node -e "require(\"node:fs\").rmSync(process.argv[1],{recursive:true,force:true})" "$TMP" 2>/dev/null' EXIT

# 把生产 config 复制进隔离目录（测试读写都在这里）。
# 本地开发机没有 panel/data/config.json —— 那就放个空文件：
# loadConfig() 解析失败会回退到 DEFAULT_CONFIG，测试照样能跑，只是没有生产里的
# adminQQ 等字段。需要真实值的测试在服务器上跑。
if [ -f panel/data/config.json ]; then
  cp panel/data/config.json "$TMP/config.json"
else
  : > "$TMP/config.json"
fi

echo "=== 隔离跑 $TARGET（PANEL_DATA=$TMP）==="
PANEL_DATA="$TMP" node "tests/$TARGET"
