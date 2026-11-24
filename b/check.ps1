# BuddyLink - B 端能力自检（Windows）
# 用法：powershell -ExecutionPolicy Bypass -File .\check.ps1
$ErrorActionPreference = "Continue"
Write-Host "=== BuddyLink 自检 ===" -ForegroundColor Cyan

$n = Get-Command node -ErrorAction SilentlyContinue
if ($n) { Write-Host "[OK]   node $((& node -v).Trim())" } else { Write-Host "[FAIL] 未安装 Node.js 18+" }

$c = Get-Command codebuddy -ErrorAction SilentlyContinue
if ($c) { Write-Host "[OK]   codebuddy: $($c.Source)" } else { Write-Host "[FAIL] 未找到 codebuddy" }

$sess = (query session 2>$null) -split [Environment]::NewLine | Where-Object { $_ -match "Active" }
if ($sess) { Write-Host "[OK]   交互会话: $($sess -join ' ')" } else { Write-Host "[WARN] 没有 Active 会话（锁屏或 RDP 断开），GUI 任务会失败" }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $out = Join-Path $env:TEMP "buddy-cap.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "[OK]   截图 $($b.Width)x$($b.Height) -> $out"
} catch { Write-Host "[FAIL] 截图失败：$($_.Exception.Message)" }

try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 5
  Write-Host "[OK]   bridge 在线: $($h.host) $($h.platform) workdir=$($h.workdir)"
} catch { Write-Host "[WARN] bridge 未启动（先跑 start.ps1 或计划任务）" }

$t = Get-Command tailscale -ErrorAction SilentlyContinue
if ($t) { $ip = (& tailscale ip -4 2>$null | Select-Object -First 1); Write-Host "[OK]   Tailscale IP: $ip" } else { Write-Host "[WARN] 未安装 tailscale" }

Write-Host "=== 结束 ===" -ForegroundColor Cyan
