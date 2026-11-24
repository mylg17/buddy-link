# BuddyLink - 一键自检（在包根目录执行）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root "b\check.ps1"
if (-not (Test-Path $target)) { throw "包结构不完整：找不到 b\check.ps1（当前目录：$root）" }
Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.Extension -eq ".ps1" -or $_.Extension -eq ".mjs" } | Unblock-File -ErrorAction SilentlyContinue
& $target
