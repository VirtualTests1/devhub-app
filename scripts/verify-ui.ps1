# UI acceptance verification for DevHub.
#
# WHY THIS EXISTS
#   Screenshots alone were not a reliable acceptance signal in this project:
#     - two captures of *different* builds came out with identical hashes;
#     - `PrintWindow` dropped regions (the download button was laid out correctly
#       but absent from the image), which twice produced a wrong "it is broken"
#       conclusion.
#   So this script drives the real app and asserts on the **DOM**, and only then
#   captures a screenshot for the human. A failure is reported as a failure.
#
# WHAT IT CHECKS
#   Per view: the required controls exist, the download button is inside the
#   viewport, there is no horizontal overflow, and no text renders below 11px.
#
# USAGE
#   pwsh -NoProfile -File scripts/verify-ui.ps1 [-SettleSeconds 14]
#
# The window is left at the size the app picks for the monitor; resizing it here
# previously pushed the bottom off-screen and produced misleading captures.

param(
    [int]$SettleSeconds = 14
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$probe = Join-Path $app 'scripts\verify\MainAcceptance.tsx'
$main = Join-Path $app 'src\main.tsx'
$backup = Join-Path $app 'src\main.acceptance-backup.tsx'

if (-not (Test-Path $probe)) { throw "missing probe: $probe" }

function Restore-Main {
    if (Test-Path $backup) {
        Move-Item $backup $main -Force
    }
}
trap { Restore-Main; break }

# Swap in the probe, run, then always restore the real entry point.
Copy-Item $main $backup -Force
Copy-Item $probe $main -Force
try {
    Push-Location $app
    & pnpm build | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
    Pop-Location

    & pwsh -NoProfile -File (Join-Path $app 'scripts\capture-ui.ps1') `
        -Name 'acceptance' -SettleSeconds $SettleSeconds

    Write-Host ''
    Write-Host "验收图: $(Join-Path $app '.shots\acceptance.png')" -ForegroundColor Cyan
    Write-Host '读图判断 RESULT 行：PASS = 全部通过。' -ForegroundColor Cyan
}
finally {
    Restore-Main
    Write-Host '已恢复 src/main.tsx' -ForegroundColor DarkGray
}
