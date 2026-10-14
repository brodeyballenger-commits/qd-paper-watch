# scripts/register-task.ps1 —— 注册/卸载 Windows 计划任务（本机每天自动更新）
#
#   pwsh -File scripts\register-task.ps1                  # 每天 06:00 更新（不推送）
#   pwsh -File scripts\register-task.ps1 -Time 08:30 -Push
#   pwsh -File scripts\register-task.ps1 -Unregister
#
# 该任务以当前用户身份运行，不需要管理员权限；要求机器处于开机状态。

[CmdletBinding()]
param(
  [string]$TaskName = 'QD-Paper-Watch',
  [string]$Time = '06:00',
  [int]$Days = 14,
  [switch]$Push,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已删除计划任务：$TaskName"
  } else {
    Write-Host "未找到计划任务：$TaskName"
  }
  return
}

$scriptPath = Join-Path $root 'scripts\update.ps1'
if (-not (Test-Path $scriptPath)) { throw "找不到 $scriptPath" }

$args = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Days $Days"
if ($Push) { $args += ' -Push' }

$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }

$action = New-ScheduledTaskAction -Execute $pwsh -Argument $args -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '每天抓取量子点器件新论文并更新站点（qd-paper-watch）' -Force | Out-Null

Write-Host "已注册计划任务：$TaskName"
Write-Host "  执行时间：每天 $Time"
Write-Host "  命令    ：$pwsh $args"
Write-Host "  提示    ：需要机器处于开机状态；日志在 .tmp\update-*.log"
