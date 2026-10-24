@echo off
chcp 65001 >nul
title Douyin collector - self check
cd /d "D://ccPrograms//WorkBuddy-workspace//2026-10-21-11-07-12//dsh-qqbot//tools//douyin"
node doctor.mjs
echo.
pause
