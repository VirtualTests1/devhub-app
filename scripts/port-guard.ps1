# Fails fast, and legibly, when the dev server port is already taken.
#
# WHY
#   `vite.config.ts` sets `strictPort: true` because `tauri.conf.json` hard-codes
#   `devUrl: http://localhost:1420`. With strictPort, a stale listener makes Vite
#   *abort* rather than move to 1421 - and because Vite is the `beforeDevCommand`,
#   the reported failure looked like a Tauri bug: "Rust compiled, the exe started,
#   the window showed ERR_CONNECTION_REFUSED". The build had already cost minutes
#   before the dev server refused to start.
#
#   So this runs BEFORE cargo: name the process that holds the port, say whether it
#   is a leftover Vite from this same working copy, and print the one command that
#   clears it. It never kills anything by itself - a port can be held by a process
#   the user is attached to in another terminal.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port-guard.ps1 [port]
#   exit 0 = free, 1 = occupied (details printed), 2 = could not tell
#
# Output is ASCII on purpose: Windows PowerShell 5.1 mis-parses UTF-8 without a BOM,
# which is why scripts/pack-portable.ps1 must run under pwsh.

param([int]$Port = 1420)

$ErrorActionPreference = 'Continue'

# Three outcomes, exactly the three documented exit codes:
#   0 = the port is free   (query ran, matched no listener)
#   1 = the port is busy   (query ran, named owners below)
#   2 = COULD NOT TELL     (the enumeration itself failed)
#
# The bug this closes: the old code returned `@()` for BOTH "no listener" and
# "Get-NetTCPConnection failed", so a failed enumeration printed "PORT 1420 FREE"
# and exited 0, and scripts/tauri.ps1:38 walked straight into a full cargo compile
# on a port we never actually checked. `Get-NetTCPConnection` raises a *terminating*
# `CmdletizationQuery_NotFound` (CimJobException) for a genuinely free port on this
# machine (measured) — that is an empty result, NOT a failure — while a missing
# cmdlet / provider / access error is the real "could not tell". Splitting those two
# apart is the whole point.
$owners = @()
$couldTell = $true
$unknownReason = ''
try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    $owners = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') {
        # Free: the CIM query executed and found no matching instance.
        $owners = @()
    } else {
        # The cmdlet is absent (CommandNotFoundException), the NetTCPIP provider
        # errored, or access was denied — we genuinely cannot tell. Do NOT report
        # FREE on this path.
        $couldTell = $false
        $unknownReason = $_.Exception.Message
    }
}

if (-not $couldTell) {
    Write-Output "PORT $Port UNKNOWN - the guard could not determine whether it is free."
    Write-Output "    why: $unknownReason"
    Write-Output "    This is exit 2 = could not tell. It is NOT a green light: the port may"
    Write-Output "    be held by a leftover Vite whose state this environment cannot read."
    Write-Output "    Check it yourself before a compile, e.g.:"
    Write-Output "        Get-NetTCPConnection -LocalPort $Port -State Listen"
    Write-Output "        netstat -ano | findstr :$Port"
    Write-Output "    The caller (scripts/tauri.ps1) must ASK rather than proceed on this code."
    exit 2
}

if ($owners.Count -eq 0) {
    Write-Output "PORT $Port FREE"
    exit 0
}

Write-Output "PORT $Port BUSY - a dev launch would now fail with:"
Write-Output "    Error: Port $Port is already in use   (vite, strictPort)"
Write-Output "and Tauri would still open a window pointing at it."
Write-Output ""

$repoRoot = Split-Path -Parent $PSScriptRoot

foreach ($ownerPid in $owners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Output "  PID $ownerPid  (process already gone, the socket may still be in TIME_WAIT)"
        continue
    }
    $cmd = $proc.CommandLine
    if (-not $cmd) { $cmd = '(unavailable - not your process, or access denied)' }
    $started = $proc.CreationDate
    $alive = ''
    if ($started) {
        $span = (Get-Date) - $started
        $alive = "  up {0:d0}:{1:d2}:{2:d2}" -f [int]$span.TotalHours, $span.Minutes, $span.Seconds
    }

    Write-Output "  PID $ownerPid  $($proc.Name)  started $started$alive"
    Write-Output "    cmd: $cmd"

    # The common case, and the only one where killing is obviously safe to suggest.
    $isOurVite = ($cmd -match 'vite') -and ($cmd -match [regex]::Escape($repoRoot) -or $cmd -match 'node_modules')
    if ($isOurVite) {
        Write-Output "    looks like a Vite left running from an interrupted 'pnpm tauri dev' in this working copy."
    }
    Write-Output "    clear it with:  Stop-Process -Id $ownerPid -Force"
}

Write-Output ""
Write-Output "Nothing was killed. If the port is held by something you want to keep,"
Write-Output "change the dev port instead: edit vite.config.ts (server.port) and the"
Write-Output "matching build.devUrl in src-tauri/tauri.conf.json - they must agree."
exit 1
