# BuddyLink - B 端安装脚本（Windows 10/11）
# 用法（管理员 PowerShell）：
#   .\install-b.ps1 -Workdir "D:\buddy-workspace" -Port 8765
param(
  [string]$Workdir = "$env:USERPROFILE\buddy-workspace",
  [int]$Port = 8765,
  [string]$CliCommand = "codebuddy",
  [string]$PermissionMode = "acceptEdits"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $here "bridge.mjs"))) {
  throw "当前目录不是 b 子目录（$here）。请在包根目录执行 .\install.ps1，或先 cd b 再执行 .\install-b.ps1"
}
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "未找到 node。请先安装 Node.js 18+：https://nodejs.org/" }
Write-Host "[1/6] node: $($node.Source)  版本 $((& node -v).Trim())"

Write-Host "[2/6] 检查 CodeBuddy CLI ..."
$cli = Get-Command $CliCommand -ErrorAction SilentlyContinue
if (-not $cli) {
  Write-Warning "找不到 $CliCommand。请先安装 CodeBuddy CLI（npm i -g @tencent-ai/codebuddy-code 或官方安装包），装好后重跑本脚本。"
} else {
  Write-Host "      $($cli.Source)"
}

Write-Host "[3/6] 准备工作目录 $Workdir"
New-Item -ItemType Directory -Force -Path $Workdir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Workdir ".buddy\runs") | Out-Null

Write-Host "[4/6] 生成配置"
$token = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
$cfgPath = Join-Path $here "buddy-link.config.json"
$cfg = @{
  token          = $token
  host           = "0.0.0.0"
  port           = $Port
  workdir        = $Workdir
  cliCommand     = $CliCommand
  permissionMode = $PermissionMode
  promptVia      = "arg"
  maxRunMs       = 2700000
  allowReadRoots = @($Workdir)
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Host "      -> $cfgPath"

Write-Host "[5/6] 防火墙规则（TCP $Port）"
$ruleName = "BuddyLink Bridge $Port"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private,Domain | Out-Null
  Write-Host "      已添加"
} else {
  Write-Host "      已存在"
}

Write-Host "[6/6] 注册登录自启计划任务"
$taskName = "BuddyLink Bridge"
$bridge = Join-Path $here "bridge.mjs"
schtasks /Query /TN $taskName *> $null
if ($LASTEXITCODE -ne 0) {
  $action = '"' + $node.Source + '" "' + $bridge + '"'
  schtasks /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $action /F | Out-Null
  Write-Host "      已创建：$taskName"
} else {
  Write-Host "      已存在：$taskName"
}

Write-Host ""
Write-Host "=== 完成 ===" -ForegroundColor Green
Write-Host "token: $token"
Write-Host "配置: $cfgPath"
Write-Host "工作目录: $Workdir"
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if ($ts) {
  $tsip = (& tailscale ip -4 2>$null | Select-Object -First 1)
  if ($tsip) { Write-Host "Tailscale IP: $tsip"; Write-Host "A 端 BUDDY_URL = http://$($tsip):$Port" }
} else {
  Write-Host "未检测到 tailscale 命令；请安装并登录后再取虚拟 IP。"
}
Write-Host ""
Write-Host "启动桥接：Start-ScheduledTask -TaskName 'BuddyLink Bridge'"
Write-Host "手动前台运行：.\start.ps1"
Write-Host "健康检查：curl http://127.0.0.1:$Port/health"
