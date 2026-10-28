# Process-level idle footprint of the DevHub WebView2, over CDP port attribution (r21-O2-1).
#
# WHY THIS EXISTS
#   `scripts/render-perf.mjs` samples *inside* the renderer (heap/nodes/layout); the
#   r18 gap in `docs/r3-webview2-perf.md` is about the *process* cost of the three
#   switches. This is that instrument: it lists every msedgewebview2 process that
#   belongs to the DevHub instance listening on the given CDP port — matched via the
#   `--remote-debugging-port` argument on the browser process, then the process tree
#   under it — with working set and private bytes, timestamped.
#
# USAGE
#   pwsh -NoProfile -File scripts/idle-procs.ps1 -Port 9222
#
# Attribution note: WebView2 child processes (renderer/gpu/utility/crashpad) do NOT
# reliably inherit the port argument themselves — only the browser process is matched
# by command line, everything else is reached through ParentProcessId. Filtering
# *every* process on the port argument undercounts (measured 2026-10-19: caught 2 of
# the processes the tree walk finds), which is why the tree walk exists.
param([string]$Port = '9222')

$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")

$browsers = @($all | Where-Object {
    $_.CommandLine -like "*--remote-debugging-port=$Port*" -and $_.CommandLine -notlike '*--type=*'
})
if (-not $browsers) {
    Write-Host "no WebView2 browser process with --remote-debugging-port=$Port (app not up?)"
    exit 1
}

# Transitive closure: children may be parented to children (utility -> renderer …).
$mine = @($browsers)
$frontier = @($browsers | ForEach-Object { $_.ProcessId })
while ($frontier.Count -gt 0) {
    $kids = @($all | Where-Object { $_.ParentProcessId -in $frontier -and $_.ProcessId -notin $mine.ProcessId })
    $mine += $kids
    $frontier = @($kids | ForEach-Object { $_.ProcessId })
}

$rows = foreach ($proc in $mine) {
    $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $kind = if ($proc.CommandLine -notlike '*--type=*') { 'browser' }
        elseif ($proc.CommandLine -like '*--type=renderer*') { 'renderer' }
        elseif ($proc.CommandLine -like '*--type=gpu-process*') { 'gpu' }
        elseif ($proc.CommandLine -like '*--type=utility*') { 'utility' }
        elseif ($proc.CommandLine -like '*--type=crashpad*') { 'crashpad' }
        else { 'other' }
    [pscustomobject]@{
        Kind     = $kind
        PID      = $proc.ProcessId
        WS_MB    = [math]::Round($p.WorkingSet64 / 1MB, 1)
        Priv_MB  = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
        # Cumulative CPU seconds for this PID — running the script before and after a
        # sampling window and subtracting the TOTAL gives the window's CPU cost (r21-O2-2).
        CPU_s    = [math]::Round($p.TotalProcessorTime.TotalSeconds, 1)
    }
}

Write-Host ("snapshot at: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "  (port $Port, tree of browser PID $($browsers[0].ProcessId))")
$rows | Sort-Object Kind, PID | Format-Table -AutoSize
$ws = ($rows | Measure-Object -Property WS_MB -Sum).Sum
$pr = ($rows | Measure-Object -Property Priv_MB -Sum).Sum
$cpu = ($rows | Measure-Object -Property CPU_s -Sum).Sum
Write-Host ("TOTAL processes={0}  working set={1} MB  private={2} MB  cpu={3} s" -f $rows.Count, [math]::Round($ws, 1), [math]::Round($pr, 1), [math]::Round($cpu, 1))
$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("machine free/total physical MB: {0} / {1}   uptime since {2}" -f `
    [math]::Round($os.FreePhysicalMemory / 1KB), [math]::Round($os.TotalVisibleMemorySize / 1KB), $os.LastBootUpTime)
