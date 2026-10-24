@echo off
chcp 65001 >nul
title 抖音专用 Edge（她刷抖音用的那个）
REM ============================================================
REM  这个 Edge 和你日常用的完全隔离：
REM   - 独立配置目录 D:/ccPrograms/EdgeDouyin
REM   - 不碰你的书签、密码、登录态
REM   - 带了调试端口 9222，采集脚本靠它接管
REM  第一次打开要扫码登录抖音，之后就不用再登了。
REM ============================================================

set "EDGE=C:/Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:/Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [错误] 找不到 Edge，请手动改这个文件里的 EDGE 路径
  pause
  exit /b 1
)

echo 正在启动抖音专用 Edge...
start "" "%EDGE%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="D:/ccPrograms/EdgeDouyin" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=msEdgeSidebarV2 ^
  "https://www.douyin.com/"

echo.
echo 已启动。如果这是第一次：
echo   1) 在打开的窗口里扫码登录抖音
echo   2) 登录后这个窗口**不要关**（关了采集脚本就接管不到了）
echo.
timeout /t 3 >nul
