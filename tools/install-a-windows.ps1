# BuddyLink - A 端安装（Windows）
# 用法（PowerShell）： .\install-a-windows.ps1 -BuddyUrl "http://192.168.1.10:8765" -Token "xxxx"
param(
  [string]$BuddyUrl = "",
  [string]$Token = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\BuddyLink"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "请先安装 Node 18+（建议 22）：https://nodejs.org/" }
Write-Host "[1/4] node: $($node.Source)"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.buddy-link" | Out-Null
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\BuddyLink\artifacts" | Out-Null
Copy-Item -Force (Join-Path $here "buddy") $InstallDir
Copy-Item -Force (Join-Path $here "buddy.cmd") $InstallDir
Write-Host "[2/4] 已复制到 $InstallDir"

$envFile = "$env:USERPROFILE\.buddy-link\env.json"
if ($BuddyUrl -and $Token) {
  @{ url = $BuddyUrl; token = $Token } | ConvertTo-Json | Set-Content -Path $envFile -Encoding UTF8
  Write-Host "[3/4] 已写入 $envFile"
} else {
  Write-Host "[3/4] 未提供 -BuddyUrl/-Token，请手工编辑 $envFile"
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
  Write-Host "[4/4] 已把 $InstallDir 加入用户 PATH（重开终端生效）"
} else {
  Write-Host "[4/4] PATH 已包含 $InstallDir"
}
Write-Host ""
Write-Host "验证：buddy.cmd auto \"回复 OK\""
