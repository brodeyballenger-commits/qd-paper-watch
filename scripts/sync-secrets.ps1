# scripts/sync-secrets.ps1
#
# 把本机 .env 里的密钥同步到 GitHub 仓库的 Actions Secrets。
# 以后想补 DeepSeek / Semantic Scholar / SerpApi / OpenAlex 的 key，只要改 .env 再跑一次这个脚本，
# 不用去网页里一个个点。
#
# 用法：
#   pwsh -File scripts/sync-secrets.ps1                    # 预览：只说会同步哪几个名字
#   pwsh -File scripts/sync-secrets.ps1 -Apply             # 真的写入仓库 Secrets
#   pwsh -File scripts/sync-secrets.ps1 -Apply -Repo owner/name
#
# 说明：脚本只打印密钥名字和长度，绝不回显密钥内容（Actions 日志与终端都不留痕）。
#       gh 走 api.github.com，本机直连即可；只有 git push 才需要连 VPN。

param(
  [string]$Repo = 'brodeyballenger-commits/qd-paper-watch',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

if (-not (Test-Path $envFile)) {
  Write-Host "✗ 找不到 $envFile —— 先把它从 .env.example 复制过来并填入你的密钥。" -ForegroundColor Red
  exit 1
}

# .env 里可能有空行/注释/引号，逐个解析成 hashtable。
# 注意：必须显式按 UTF-8 读，且不要用 Get-Content——Windows PowerShell 5.1 的
# Get-Content 默认按系统 ANSI 解码，遇到中文注释会把多行粘成一行，密钥就被吞掉。
$vars = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
  $t = $line.Trim().TrimStart([char]0xFEFF)
  if (-not $t -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -lt 1) { continue }
  $name = $t.Substring(0, $i).Trim()
  $value = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
  if ($value) { $vars[$name] = $value }
}

# 允许同步到仓库的密钥白名单（绝不会把其它变量推上去）
$allowed = @('DEEPSEEK_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY', 'SERPAPI_KEY', 'OPENALEX_API_KEY')

$targets = $allowed | Where-Object { $vars.ContainsKey($_) }
if (-not $targets) {
  Write-Host "✗ .env 里没有可同步的密钥（可同步：$($allowed -join '、')）。" -ForegroundColor Red
  Write-Host "  想启用 Google 学术源，就去 https://serpapi.com/manage-api-key 申请一个，写进 .env 的 SERPAPI_KEY=。"
  exit 1
}

Write-Host "将同步到 $Repo 的 Secrets："
foreach ($name in $targets) {
  Write-Host ("  · {0}（{1} 个字符）" -f $name, $vars[$name].Length)
}

if (-not $Apply) {
  Write-Host ''
  Write-Host '（预览模式：没有写入任何东西。加 -Apply 才会真正同步）'
  exit 0
}

# gh 需要令牌：优先用已有的 GH_TOKEN，否则从 Windows 凭据管理器里取
if (-not $env:GH_TOKEN) {
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  $cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  $token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
  if (-not $token) {
    Write-Host '✗ 拿不到 GitHub 令牌：请先设置 $env:GH_TOKEN，或在凭据管理器里存好 GitHub 凭据。' -ForegroundColor Red
    exit 1
  }
  $env:GH_TOKEN = $token
}

foreach ($name in $targets) {
  gh secret set $name --repo $Repo --body $vars[$name]
  if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ $name 同步失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
    exit 1
  }
  Write-Host "✓ $name 已同步"
}

Write-Host ''
Write-Host '仓库当前 Secrets：'
gh secret list --repo $Repo
