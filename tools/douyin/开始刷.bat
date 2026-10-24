@echo off
chcp 65001 >nul
title Douyin collector - one round
cd /d "D://ccPrograms//WorkBuddy-workspace//2026-10-21-11-07-12//dsh-qqbot//tools//douyin"
node collect.mjs
echo.
pause
