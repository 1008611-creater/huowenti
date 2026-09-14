@echo off
chcp 65001 >nul
title 活问题 · 守护进程（请保持这个窗口开着）
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

:loop
node "活问题守护.mjs"
echo.
echo   [%date% %time%] 守护进程意外退出，3 秒后自动重新启动...
timeout /t 3 >nul
goto loop
