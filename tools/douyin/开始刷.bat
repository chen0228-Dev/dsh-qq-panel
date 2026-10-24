@echo off
chcp 65001 >nul
title 她去刷抖音
REM 用绝对路径，这样这个 bat 放桌面也能跑
cd /d "D:/ccPrograms/WorkBuddy-workspace/2026-10-21-11-07-12/dsh-qqbot/tools/douyin"
echo ============================================
echo  开始刷一轮（跑完自动退出）
echo  想让它在后台一直跑，就改用: node collect.mjs --loop
echo ============================================
echo.
node collect.mjs
echo.
echo ===== 结束 =====
pause
