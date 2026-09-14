@echo off
chcp 65001 >nul
title 活问题 · 重新启动
cd /d "%~dp0"

echo.
echo   活问题 · 重新启动
echo   ----------------------------------------
echo   正在重新启动，请稍等十几秒...
echo.

if not exist "logs" mkdir "logs"

rem 只结束占用 4173 端口的旧进程，不影响电脑上其他程序
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }"

powershell -NoProfile -Command "for($i=0;$i -lt 20;$i++){ if(-not (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)){ exit 0 }; Start-Sleep -Milliseconds 300 }; exit 0"

start "" /min cmd /c "node server.js >> logs\server-run.log 2>&1"

powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ Start-Sleep -Milliseconds 700; try{ Invoke-WebRequest -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 }catch{} }; exit 1"
if %errorlevel%==0 goto ready

echo   [XX] 重新启动没有成功。
echo        请把 logs\server-run.log 这个文件发给 Codex。
echo.
pause
exit /b 1

:ready
echo   [OK] 新版本已经生效
start "" "http://127.0.0.1:4173/"
echo   [OK] 已打开网页
echo.
echo   这个窗口可以直接关掉。
timeout /t 6 >nul
