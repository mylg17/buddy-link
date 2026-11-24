# 前台启动桥接（调试用）
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "启动 BuddyLink bridge（Ctrl+C 结束）..."
& node (Join-Path $here "bridge.mjs")
