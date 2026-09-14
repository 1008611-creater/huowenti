@echo off
chcp 65001 >nul
title 活问题 · 启动器
cd /d "%~dp0"

echo.
echo   活问题 · 一个会主动寻找回答者的问题
echo   ----------------------------------------
echo.

if not exist "logs" mkdir "logs"

powershell -NoProfile -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0}catch{exit 1}"
if %errorlevel%==0 goto ready

echo   [..] 正在启动服务，请稍等...
start "" /min cmd /c "node server.js >> logs\server-run.log 2>&1"

powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){Start-Sleep -Milliseconds 700; try{Invoke-WebRequest -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0}catch{}}; exit 1"
if %errorlevel%==0 goto ready

echo   [XX] 启动失败。
echo        请把 logs\server-run.log 这个文件发给 Codex。
echo.
pause
exit /b 1

:ready
echo   [OK] 服务正常
start "" "http://127.0.0.1:4173/"
echo   [OK] 已打开网页
echo.
echo   接下来请双击「活问题守护.cmd」，它会自动保持网页和公网地址一直可用。
echo.
timeout /t 6 >nul
