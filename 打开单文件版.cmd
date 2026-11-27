@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 打开单文件版（数据已内联，双击即可离线看，不需要启动服务）
start "" "docs\standalone.html"
