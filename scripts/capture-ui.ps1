# Reliable screenshot capture for the DevHub window.
#
# WHY THIS EXISTS
#   An earlier attempt launched `target\debug\devhub-app.exe` directly and got a
#   blank white window. The cause was NOT the CSP (that was a wrong diagnosis):
#   running the exe by hand does not give the app a dev URL, so the webview loaded
#   nothing. `tauri dev` is what injects it. This script therefore always drives
#   the app through `tauri dev`, and it owns the whole lifecycle: start the dev
#   server, wait for the window, screenshot, then tear both down.
#
# It also never leaves a dev server or a window behind, which is what made earlier
# attempts confusing - a stale `pnpm dev` on port 1420 silently served an old
# bundle while a second instance kept failing.
#
# The window is left at the size the app chooses (it fits itself to the monitor's
# work area). Resizing it here used to push the bottom off-screen and make
# `PrintWindow` return a frame with unsynthesised regions.

param(
    [string]$Name = 'shots',
    # Extra settle time after the window appears, for cover images and layout.
    [int]$SettleSeconds = 8,
    # Set when the caller already runs `tauri dev` and only wants a screenshot.
    [switch]$CaptureOnly
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$exe = Join-Path $app 'src-tauri\target\debug\devhub-app.exe'
$shotDir = Join-Path $app '.shots'
New-Item -ItemType Directory -Path $shotDir -Force | Out-Null

function Stop-DevHub {
    Get-Process -Name 'devhub-app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

function Capture-Window([string]$outFile) {
    Add-Type -AssemblyName System.Drawing.Common -ErrorAction SilentlyContinue
    $sig = @'
using System; using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,Rt,B; }
  public static int[] Rect(IntPtr h){ RECT r; GetWindowRect(h, out r); return new int[]{ r.L,r.T,r.Rt,r.B }; }
}
'@
    if (-not ('Shot' -as [type])) {
        Add-Type -TypeDefinition $sig -ReferencedAssemblies ([System.Drawing.Bitmap].Assembly.Location)
    }
    $proc = Get-Process -Name 'devhub-app' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $proc) { throw 'no DevHub window found' }
    $h = $proc.MainWindowHandle

    # Move the window to a known origin but DO NOT resize it.
    #
    # Resizing was the cause of a long debugging detour: this script used to force
    # the window to -Width/-Height, and at 1200x860 on a 1536x864 screen (816 px of
    # work area) the bottom of the window landed off-screen. `PrintWindow` then
    # returned a frame with that region unsynthesised, which looked like the app was
    # clipping its own content and produced three wrong diagnoses.
    #
    # The app now sizes itself from the monitor's work area, so the correct thing is
    # to leave its size alone and read back what it chose.
    $r = [Shot]::Rect($h)
    $curW = $r[2] - $r[0]; $curH = $r[3] - $r[1]
    [Shot]::MoveWindow($h, 8, 8, $curW, $curH, $true) | Out-Null
    Start-Sleep -Seconds 2
    $r = [Shot]::Rect($h)
    $w = $r[2] - $r[0]; $ht = $r[3] - $r[1]

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $overflows = ($r[3] -gt $screen.Bottom) -or ($r[2] -gt $screen.Right)
    if ($overflows) {
        Write-Warning ("窗口 $w x $ht 超出可用区域 $($screen.Width) x $($screen.Height)；截图底部可能缺失")
    }
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [Shot]::PrintWindow($h, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    # A blank capture is the failure mode this script exists to prevent, so say so
    # instead of writing a useless PNG and reporting success.
    $distinct = @{}
    for ($x = 0; $x -lt $w; $x += 24) {
        for ($y = 0; $y -lt $ht; $y += 24) { $distinct[$bmp.GetPixel($x, $y).ToArgb()] = 1 }
    }
    $g.Dispose(); $bmp.Dispose()
    return [pscustomobject]@{
        Path = $outFile; Width = $w; Height = $ht
        DistinctColors = $distinct.Count; Overflows = $overflows
    }
}

if (-not $CaptureOnly) {
    Stop-DevHub
    Start-Sleep -Seconds 1

    $env:DEVHUB_PROJECT_ROOT = Join-Path $app '.cardshow'
    . (Join-Path $app 'env.ps1') | Out-Null

    Write-Host '启动 tauri dev（CLI 负责注入 devUrl）…' -ForegroundColor Cyan
    Start-Process -FilePath 'pwsh' `
        -ArgumentList '-NoProfile', '-Command', "Set-Location '$app'; pnpm tauri dev" `
        -WindowStyle Hidden | Out-Null

    # Wait for the window, not just the port: the port comes up before the app does.
    $found = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        if (Get-Process -Name 'devhub-app' -ErrorAction SilentlyContinue) { $found = $true; break }
    }
    if (-not $found) { Stop-DevHub; throw 'DevHub window never appeared' }
    Start-Sleep -Seconds $SettleSeconds
}

$outFile = Join-Path $shotDir "$Name.png"
$info = Capture-Window $outFile
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Write-Host ("截图: {0}  {1}x{2}  采样色数={3}  屏幕可用={4}x{5}" -f `
    $info.Path, $info.Width, $info.Height, $info.DistinctColors, $screen.Width, $screen.Height) -ForegroundColor Green
if ($info.Overflows) {
    Write-Warning '窗口高于可用区域，截图底部不可信'
}
if ($info.DistinctColors -le 3) {
    Write-Warning '采样色数过少，可能是空白窗口——不要把它当作有效验收图'
}

if (-not $CaptureOnly) { Stop-DevHub; Write-Host '已关闭 dev 进程' -ForegroundColor DarkGray }
