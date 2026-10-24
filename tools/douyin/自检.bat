@echo off
chcp 65001 >nul
title 抖音采集端 - 自检
cd /d "D:/ccPrograms/WorkBuddy-workspace/2026-10-21-11-07-12/dsh-qqbot/tools/douyin"
echo 检查环境齐不齐（只读，不会点任何按钮）...
echo.
node doctor.mjs
echo.
pause
