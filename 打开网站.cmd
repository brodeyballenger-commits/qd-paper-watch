@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动本地预览服务...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $up = (Get-NetTCPConnection -State Listen -LocalPort 5173); if (-not $up) { Start-Process -FilePath node -ArgumentList 'scripts/serve.mjs' -WindowStyle Hidden; Start-Sleep -Seconds 2 }; Start-Process 'http://127.0.0.1:5173/'"
echo 已打开 http://127.0.0.1:5173/
echo 关掉这个窗口不会停止服务；要停服务请在任务管理器结束 node.exe。
timeout /t 3 >nul
