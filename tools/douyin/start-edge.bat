@echo off
REM 抖音专用 Edge —— 带调试口，能被采集脚本接管。
REM 和你日常用的 Edge 完全隔离（独立配置目录），不碰书签和密码。
REM 第一次要扫码登录一次，之后长期记住。

set EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
if not exist %EDGE% set EDGE="C:/Program Files/Microsoft/Edge/Application/msedge.exe"

start "" %EDGE% ^
  --remote-debugging-port=9222 ^
  --user-data-dir="D:/ccPrograms/EdgeDouyin" ^
  --no-first-run ^
  --no-default-browser-check ^
  https://www.douyin.com/

echo Edge 已启动（调试口 9222）。第一次请扫码登录抖音，登录后关掉这个窗口也行 —— 
echo 只要这个 Edge 还开着，采集脚本就能接管它。
