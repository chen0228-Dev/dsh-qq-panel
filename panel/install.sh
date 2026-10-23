#!/usr/bin/env bash
# QQ 助手控制面板安装脚本
set -euo pipefail

PANEL_DIR=/opt/qqbot/panel
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 1/4 复制程序到 ${PANEL_DIR}"
mkdir -p "${PANEL_DIR}"
cp -r "${SRC_DIR}/." "${PANEL_DIR}/"
rm -f "${PANEL_DIR}/install.sh" "${PANEL_DIR}/package-lock.json"

echo "==> 2/4 安装依赖（仅 ws）"
cd "${PANEL_DIR}"
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

echo "==> 3/4 注册 systemd 服务"
cp "${PANEL_DIR}/qqbot-panel.service" /etc/systemd/system/qqbot-panel.service
systemctl daemon-reload
systemctl enable qqbot-panel >/dev/null

echo "==> 4/4 完成"
echo "启动命令：systemctl start qqbot-panel"
echo "查看日志：journalctl -u qqbot-panel -f"
