# USN journal capability probe (r31-R3).
#
# This is a research tool, not part of the app. It answers three questions
# without changing the filesystem (unless -ProbeDir is supplied):
#   1. can this process query the volume's USN journal?
#   2. does the output format lend itself to a stable parser?
#   3. does a write advance the journal?
#
# USAGE
#   powershell -NoProfile -File scripts/usn-probe.ps1 [-Volume D:] [-ProbeDir <existing dir>]
#
# The query is read-only. -ProbeDir writes one tiny temp file and deletes it,
# so the before/after Next USN can be compared; point it at a throwaway folder.
#
# WHY THE APP DOES NOT USE THIS YET: see docs/research/usn-journal.md. The
# current watcher (ReadDirectoryChangesW + polling fallback) already delivers
# live events; USN's value would be backfill after the app was not running, and
# that needs a checked-in FFI reader, a persisted checkpoint, volume opt-in and
# a wrapping-journal policy. Parsing this localized console text is not that.

param(
    [string]$Volume = "D:",
    [string]$ProbeDir = ""
)

$ErrorActionPreference = "Stop"

function Query-Usn {
    param([string]$Vol)
    $out = & fsutil usn queryjournal $Vol 2>&1
    [pscustomobject]@{ Exit = $LASTEXITCODE; Text = ($out -join [Environment]::NewLine) }
}

Write-Output "volume = $Volume"
$before = Query-Usn -Vol $Volume
Write-Output "query_exit = $($before.Exit)"
Write-Output "--- queryjournal (before) ---"
Write-Output $before.Text
Write-Output "----------------------------"

if ($ProbeDir -ne "") {
    if (-not (Test-Path -LiteralPath $ProbeDir -PathType Container)) {
        Write-Output "probe_skipped = no such directory: $ProbeDir"
        exit 0
    }
    $probe = Join-Path $ProbeDir ("devhub-usn-probe-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        Set-Content -LiteralPath $probe -Value "probe" -NoNewline
        Remove-Item -LiteralPath $probe -Force
        Write-Output "probe_write = ok"
    } catch {
        Write-Output "probe_write = failed: $($_.Exception.Message)"
    }
    $after = Query-Usn -Vol $Volume
    Write-Output "--- queryjournal (after) ---"
    Write-Output $after.Text
    Write-Output "----------------------------"
    Write-Output "query_exit_after = $($after.Exit)"
    Write-Output "note = compare the Next USN values above; the labels are localized, so this probe does not parse them"
} else {
    Write-Output "probe_write = skipped (pass -ProbeDir <throwaway dir> to compare Next USN)"
}

# A full journal read can be very large and is deliberately opt-in via a manual
# command; this probe never dumps it. The research note records one manual read
# and its localized output.
