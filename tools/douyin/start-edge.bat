@echo off
chcp 65001 >nul
title Douyin Edge (debug port 9222)

REM ============================================================
REM  Keep this file PURE ASCII. Windows cmd reads .bat in the
REM  system codepage (GBK on this machine); UTF-8 Chinese here
REM  gets parsed as commands and blows up with
REM  "'xxx' is not recognized as an internal command".
REM  2026-10-24: first version had Chinese comments + LF endings,
REM  which is exactly what happened. Do not "improve" this file.
REM ============================================================

set "EDGE=C:/Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:/Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [ERROR] Edge not found. Edit the EDGE path in this file.
  pause
  exit /b 1
)

echo Starting Douyin Edge (debug port 9222)...
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="D:/ccPrograms/EdgeDouyin" --no-first-run --no-default-browser-check --disable-features=msEdgeSidebarV2 "https://www.douyin.com/"

echo.
echo Done. If this is the first run, scan the QR code to sign in.
echo Keep this window's Edge open - the collector connects to it.
echo.
timeout /t 4 >nul
