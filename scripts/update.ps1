# scripts/update.ps1 —— 本机更新入口（供 Windows 计划任务调用，也可手动运行）
#
# 用法：
#   pwsh -File scripts\update.ps1                 # 抓取 14 天并生成站点
#   pwsh -File scripts\update.ps1 -Days 90        # 回填 90 天
#   pwsh -File scripts\update.ps1 -Push           # 完成后把 docs/ 提交并推送
#
# 注意：抓取必须走 Node（PowerShell 在本机沙箱下无法建立 TLS 连接），此脚本只做调度与日志。

[CmdletBinding()]
param(
  [int]$Days = 14,
  [switch]$NoLlm,
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("update-{0:yyyyMM}.log" -f (Get-Date))

function Write-Log([string]$Message) {
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Push-Location $root
try {
  Write-Log "=== 开始更新（Days=$Days, NoLlm=$($NoLlm.IsPresent)）==="

  $nodeArgs = @('src/build.mjs', "--days=$Days")
  if ($NoLlm) { $nodeArgs += '--no-llm' }

  & node @nodeArgs 2>&1 | Tee-Object -FilePath $logFile -Append
  if ($LASTEXITCODE -ne 0) { throw "构建失败，退出码 $LASTEXITCODE" }

  if ($Push) {
    if (-not (Test-Path (Join-Path $root '.git'))) { throw '当前目录不是 git 仓库，无法推送' }
    & git add docs/ | Out-Null
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Log '数据无变化，跳过提交。'
    } else {
      & git commit -m ("chore: 更新论文数据 {0:yyyy-MM-dd}" -f (Get-Date)) | Out-Null
      & git push
      Write-Log '已提交并推送 docs/。'
    }
  }

  Write-Log '=== 更新完成 ==='
}
catch {
  Write-Log "更新失败：$($_.Exception.Message)"
  exit 1
}
finally {
  Pop-Location
}
