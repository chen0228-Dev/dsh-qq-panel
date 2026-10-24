@echo off
chcp 65001 >nul
title Douyin collector - resident (loop)
cd /d "D://ccPrograms//WorkBuddy-workspace//2026-10-21-11-07-12//dsh-qqbot//tools//douyin"
echo ============================================================
echo  Resident mode. It asks the panel every 30 minutes whether
echo  it is allowed to scroll. Close this window to stop.
echo  Log: last-run.log in this folder
echo ============================================================
echo.
node collect.mjs --loop
echo.
echo ==== stopped ====
pause
