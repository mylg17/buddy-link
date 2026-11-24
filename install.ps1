# BuddyLink - 一键安装（在包根目录执行）
# 用法（管理员 PowerShell）：
#   .\install.ps1 -Workdir "D:\buddy-workspace" -Port 8765
param(
  [string]$Workdir = "$env:USERPROFILE\buddy-workspace",
  [int]$Port = 8765,
  [string]$CliCommand = "codebuddy",
  [string]$PermissionMode = "acceptEdits"
)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root "b\install-b.ps1"
if (-not (Test-Path $target)) {
  throw "包结构不完整：找不到 b\install-b.ps1（当前目录：$root）"
}
Write-Host "解除下载文件的执行封锁 ..."
Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.Extension -eq ".ps1" -or $_.Extension -eq ".mjs" } | Unblock-File -ErrorAction SilentlyContinue
& $target -Workdir $Workdir -Port $Port -CliCommand $CliCommand -PermissionMode $PermissionMode
