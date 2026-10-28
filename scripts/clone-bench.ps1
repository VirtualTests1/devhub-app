# Clone-strategy benchmark — the measured half of round 16's R1.
#
# WHY
#   DevHub has always cloned with a plain `git clone <url> <target>` (downloader.rs,
#   the `clone --progress` site). Shallow and partial cloning are the two levers a
#   launcher could pull to make the first download of a large repository cheaper, but
#   each one changes what the *later* operations can do — and DevHub's 更新 is
#   `git pull --ff-only` (`downloader.rs`, `run_pull`), which is exactly the operation
#   a truncated history or a lazily-fetched blob could break.
#
#   Choosing a default from documentation alone would be guessing: git's own manpages
#   describe the flags but not the interaction we depend on. So this measures it — one
#   deterministic fixture repository, four strategies, and for each the three
#   questions DevHub actually asks afterwards: can it update, how much history does it
#   have, and can it still read an older revision.
#
# WHAT IS DETERMINISTIC
#   The fixture is generated here: N commits x K files x S bytes, with every byte
#   derived from SHA-256 in counter mode over (commit, file) — no clock, no RNG, no
#   network. Two runs produce byte-identical object stores, and the payload is
#   incompressible on purpose: a filler of repeated 'x' would delta-compress to
#   nothing and the comparison would measure the compressor rather than the strategy.
#
#   Nothing reaches the network unless you pass -Remote. -Daemon serves the fixture
#   over 127.0.0.1 with git's own daemon, which is the only way to give `--filter` a
#   real promisor remote without credentials or internet.
#
# USAGE
#   pwsh -NoProfile -File scripts\clone-bench.ps1 [-Commits 30] [-Files 5] [-Kb 64]
#                                                 [-Daemon] [-Remote <url>] [-Keep]
#
#   pwsh (7.x), not `powershell` (5.1): Windows PowerShell 5.1 mis-parses the UTF-8
#   .ps1 files in this repository without a BOM — a recorded machine fact, see the
#   header of scripts/port-guard.ps1 and the round-15 report.
#
# SAFE BY CONSTRUCTION
#   Writes only under `<repo>/.clonebench/<timestamp>/`, which is git-ignored. The
#   daemon phase serves a **bare copy** rather than a junction or symlink: a reparse
#   point inside a tree this script then deletes is exactly how round 15's
#   `node_modules` store got wiped, and no benchmark is worth that risk. The daemon
#   binds 127.0.0.1 only, with `--export-all` over a throwaway base path and
#   upload-pack (read-only) enabled — receive-pack is never started, so nothing can
#   push into the fixture.

[CmdletBinding()]
param(
    [int]$Commits = 30,
    [int]$Files = 5,
    [int]$Kb = 64,
    [switch]$Daemon,
    [int]$DaemonPort = 29717,
    [string]$Remote = '',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$run = Join-Path (Join-Path $repoRoot '.clonebench') (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force -Path $run | Out-Null

function Get-DirBytes([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = 0L
    Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $sum += $_.Length }
    return $sum
}

function Get-PseudoBytes([int]$Count, [int]$Seed) {
    # Counter-mode SHA-256(seed, n): deterministic across runs and platforms, and
    # incompressible, which is the whole point of the exercise.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $chunks = New-Object 'System.Collections.Generic.List[byte[]]'
    $total = 0
    $n = 0
    while ($total -lt $Count) {
        $block = New-Object byte[] 8
        [BitConverter]::GetBytes($Seed).CopyTo($block, 0)
        [BitConverter]::GetBytes($n).CopyTo($block, 4)
        $h = $sha.ComputeHash($block)
        $chunks.Add($h)
        $total += $h.Length
        $n++
    }
    $out = New-Object byte[] $Count
    $pos = 0
    foreach ($c in $chunks) {
        $take = [Math]::Min($c.Length, $Count - $pos)
        [Array]::Copy($c, 0, $out, $pos, $take)
        $pos += $take
        if ($pos -ge $Count) { break }
    }
    return $out
}

function Invoke-Git {
    # Every strategy is timed the same way, so the clock lives here rather than at
    # the call sites. stderr is folded in: git reports refusals there, and a
    # benchmark that cannot see the refusal cannot tell "unsupported" from "slow".
    param([string[]]$GitArgs, [string]$Cwd = $null)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = if ($Cwd) { & git -C $Cwd @GitArgs 2>&1 | ForEach-Object { "$_" } }
           else { & git @GitArgs 2>&1 | ForEach-Object { "$_" } }
    $code = $LASTEXITCODE
    $sw.Stop()
    $ErrorActionPreference = $prev
    [pscustomobject]@{ Code = $code; Out = ($out -join "`n"); Ms = [int]$sw.Elapsed.TotalMilliseconds }
}

Write-Host "== DevHub clone-strategy benchmark (round 16, R1-2) =="
Write-Host ("git   : {0}" -f (Invoke-Git @('--version')).Out)
Write-Host ("run   : {0}" -f $run)
Write-Host ("shape : {0} commits x {1} files x {2} KiB (incompressible)" -f $Commits, $Files, $Kb)
Write-Host ''

# ---------------------------------------------------------------------------
# 1. Deterministic fixture
# ---------------------------------------------------------------------------
$src = Join-Path $run 'upstream'
New-Item -ItemType Directory -Force -Path (Join-Path $src 'data') | Out-Null
Invoke-Git @('init', '-q', '--initial-branch=main', $src) | Out-Null
Invoke-Git @('-C', $src, 'config', 'user.email', 'bench@example.invalid') | Out-Null
Invoke-Git @('-C', $src, 'config', 'user.name', 'clone-bench') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $src 'README.md'), "clone-bench fixture`n")
Invoke-Git @('-C', $src, 'add', '.') | Out-Null
Invoke-Git @('-C', $src, 'commit', '-q', '-m', 'seed') | Out-Null

$bytes = $Kb * 1024
for ($i = 1; $i -le $Commits; $i++) {
    for ($f = 1; $f -le $Files; $f++) {
        [System.IO.File]::WriteAllBytes((Join-Path $src ("data\f{0:d2}.txt" -f $f)), (Get-PseudoBytes $bytes ($i * 100 + $f)))
    }
    Invoke-Git @('-C', $src, 'add', '-A') | Out-Null
    Invoke-Git @('-C', $src, 'commit', '-q', '-m', ("commit {0}" -f $i)) | Out-Null
}

$headBefore = (Invoke-Git @('-C', $src, 'rev-parse', 'HEAD')).Out.Trim()
# The *root* commit, not the previous tip. Probing the tip would read "ok" for a
# shallow clone and tell us nothing: what a truncated repository cannot do is reach
# back to the beginning, and that is the capability 回退 / blame depend on.
$seedCommit = (Invoke-Git @('-C', $src, 'rev-list', '--max-parents=0', 'HEAD')).Out.Trim().Split("`n")[0]
$srcGit = Get-DirBytes (Join-Path $src '.git')
Write-Host ("fixture: {0} commits, .git = {1:N0} bytes" -f ($Commits + 1), $srcGit)
Write-Host ''

# A local *path* clone takes git's hard-link fast path, which copies the whole object
# store and cannot honour a filter at all. Measuring `--filter` against a path would
# therefore measure the transport shortcut rather than the feature — so each strategy
# is run against a path (what a mirror/backup restore looks like) and against
# `file://` (the ordinary fetch protocol).
function New-CloneSet([string]$Label, [string]$SourceUrl) {
    $rows = @()
    $plans = [ordered]@{
        'full'              = @()
        'shallow'           = @('--depth', '1')
        'blobless'          = @('--filter=blob:none')
        'blobless+sparse'   = @('--filter=blob:none', '--sparse')
    }
    foreach ($name in $plans.Keys) {
        $dst = Join-Path $run ("c-{0}-{1}" -f $Label, ($name -replace '\+', '_'))
        $r = Invoke-Git (@('clone', '-q') + $plans[$name] + @($SourceUrl, $dst))
        $gitBytes = Get-DirBytes (Join-Path $dst '.git')
        $allBytes = Get-DirBytes $dst
        $filter = (Invoke-Git @('-C', $dst, 'config', '--get', 'remote.origin.partialclonefilter')).Out.Trim()
        $promisor = (Invoke-Git @('-C', $dst, 'config', '--get', 'remote.origin.promisor')).Out.Trim()
        # Warnings are collected even on a SUCCESSFUL clone, because that is the whole
        # trap this phase exists to find: `git clone --filter=...` against a server
        # that does not advertise the filter capability does not fail. It prints
        # "warning: filtering not recognized by server, ignoring", downloads
        # everything, and still writes `promisor = true` plus
        # `partialclonefilter = blob:none` into .git/config. A strategy that silently
        # became "full" is indistinguishable from one that worked unless you read the
        # warning, so a benchmark that only looked at exit codes would miss it.
        $warn = ((($r.Out -split "`n") | Where-Object { $_ -match 'warning|fatal|ignoring' }) -join ' | ')
        $rows += [pscustomobject]@{
            Strategy   = $name
            CloneMs    = $r.Ms
            ExitCode   = $r.Code
            GitBytes   = $gitBytes
            TotalBytes = $allBytes
            FilterCfg  = $filter
            Promisor   = $promisor
            Warning    = $warn
            Note       = if ($r.Code -ne 0) { (($r.Out -split "`n") | Where-Object { $_ } | Select-Object -First 1) } else { '' }
            Path       = $dst
            SourceUrl  = $SourceUrl
        }
    }
    return $rows
}

function Report-Rows([string]$Title, $Rows) {
    Write-Host "== $Title =="
    $Rows | Format-Table -AutoSize Strategy, CloneMs, ExitCode,
        @{n = 'GitKiB'; e = { [math]::Round($_.GitBytes / 1KB, 1) } },
        @{n = 'TotalKiB'; e = { [math]::Round($_.TotalBytes / 1KB, 1) } },
        FilterCfg, Promisor |
        Out-String -Width 200 | Write-Host
    foreach ($r in $Rows) {
        if ($r.Note) { Write-Host ("  {0} exit: {1}" -f $r.Strategy, $r.Note) }
        if ($r.Warning) { Write-Host ("  {0} warn: {1}" -f $r.Strategy, $r.Warning) }
    }
    Write-Host ''
}

# ---------------------------------------------------------------------------
# 2. What DevHub does afterwards: `git pull --ff-only`, plus the two probes that
#    say whether the clone can still answer for history.
# ---------------------------------------------------------------------------
function Probe-Clone($Row) {
    $p = $Row.Path
    if (-not (Test-Path -LiteralPath $p)) {
        return [pscustomobject]@{ Strategy = $Row.Strategy; Pull = 'absent'; PullNote = ''; Depth = '-'; Shallow = '-'; OldBlob = '-'; OldNote = ''; Unshallow = '-'; Rows = $Row }
    }
    $pull = Invoke-Git @('-C', $p, 'pull', '-q', '--ff-only')
    $depth = Invoke-Git @('-C', $p, 'rev-list', '--count', 'HEAD')
    # The *root* commit, deliberately: the previous tip answers "ok" for a shallow
    # clone too, because after the pull that commit is present. Reaching back to the
    # beginning is what a truncated history cannot do, and it is exactly what 回退 /
    # blame / "when did this file start" need.
    $old = Invoke-Git @('-C', $p, 'show', ("{0}:README.md" -f $seedCommit))
    $shallowFile = Invoke-Git @('-C', $p, 'rev-parse', '--is-shallow-repository')
    [pscustomobject]@{
        Strategy  = $Row.Strategy
        Pull      = if ($pull.Code -eq 0) { 'ok' } else { 'FAILED' }
        PullNote  = if ($pull.Code -eq 0) { '' } else { (($pull.Out -split "`n") | Where-Object { $_ } | Select-Object -First 1) }
        Depth     = if ($depth.Code -eq 0) { $depth.Out.Trim() } else { 'err' }
        Shallow   = $shallowFile.Out.Trim()
        OldBlob   = if ($old.Code -eq 0) { 'ok' } else { 'FAILED' }
        OldNote   = if ($old.Code -eq 0) { '' } else { (($old.Out -split "`n") | Where-Object { $_ } | Select-Object -First 1) }
        Rows      = $Row
    }
}

function Probe-Unshallow($Row) {
    # The documented way back out of a shallow clone. A separate function because it
    # deepens the repository and so invalidates `Depth`; it has to run last.
    $p = $Row.Path
    if (-not (Test-Path -LiteralPath $p)) { return 'absent' }
    $unsh = Invoke-Git @('-C', $p, 'fetch', '-q', '--unshallow')
    if ($unsh.Code -eq 0) { return 'ok' }
    return ("FAILED: {0}" -f (($unsh.Out -split "`n") | Where-Object { $_ } | Select-Object -First 1))
}

$pathRows = New-CloneSet 'path' $src
Report-Rows 'A. clone against a plain filesystem path (git local fast path)' $pathRows

$fileSrc = 'file:///' + ($src -replace '\\', '/')
$fileRows = New-CloneSet 'file' $fileSrc
Report-Rows 'B. clone against file:// (ordinary fetch protocol)' $fileRows

# upstream moves on
[System.IO.File]::WriteAllBytes((Join-Path $src 'data\f01.txt'), (Get-PseudoBytes $bytes 9999))
Invoke-Git @('-C', $src, 'commit', '-q', '-am', 'later upstream commit') | Out-Null
$headAfter = (Invoke-Git @('-C', $src, 'rev-parse', 'HEAD')).Out.Trim()
Write-Host ("upstream advanced: {0} -> {1}" -f $headBefore.Substring(0, 7), $headAfter.Substring(0, 7))
Write-Host ''

$pathProbes = @($pathRows | ForEach-Object { Probe-Clone $_ })
$fileProbes = @($fileRows | ForEach-Object { Probe-Clone $_ })

Write-Host '== C. after the upstream moved on =='
foreach ($set in @(@('path', $pathProbes), @('file', $fileProbes))) {
    Write-Host ("--- {0} clones ---" -f $set[0])
    $set[1] | Format-Table -AutoSize Strategy, Shallow, Depth, Pull, OldBlob | Out-String -Width 200 | Write-Host
    foreach ($pr in $set[1]) {
        if ($pr.PullNote) { Write-Host ("  {0} pull: {1}" -f $pr.Strategy, $pr.PullNote) }
        if ($pr.OldNote) { Write-Host ("  {0} old blob: {1}" -f $pr.Strategy, $pr.OldNote) }
    }
}
Write-Host ''

# Last, because it changes the answer to `Depth`: the documented way back out of a
# shallow clone. Worth measuring — if `fetch --unshallow` did not work over these
# transports, a shallow clone would be a one-way door, and that would change the default.
Write-Host '== C2. fetch --unshallow (the way back out of a shallow clone) =='
foreach ($pr in @($pathProbes + $fileProbes)) {
    $u = Probe-Unshallow $pr.Rows
    $pr | Add-Member -NotePropertyName Unshallow -NotePropertyValue $u -Force
    Write-Host ("  {0,-16} {1}" -f $pr.Strategy, $u)
}
Write-Host ''

# ---------------------------------------------------------------------------
# 3. Optional: a real promisor remote over git daemon (127.0.0.1 only).
# ---------------------------------------------------------------------------
$daemonRows = $null
$daemonProbes = $null
# A stale daemon on the same port is not hypothetical — the first run of this
# phase on this machine produced `fatal: read error: Invalid argument` for all
# four strategies because an earlier daemon from a previous run was still
# listening, holding a base-path that had already been deleted. Worse: a healthy
# leftover daemon answers `ls-remote` just fine while serving ANOTHER run's
# fixture. Windows lets a second `git daemon --reuseaddr` bind the same port, the
# OS may hand connections to either listener, and the clones then come back
# complete and correctly shaped (right byte count, depth 32, pull ok) but with
# the wrong commits — every `git show <this run's seed commit>` probe fails while
# everything else looks healthy. Run 20261017-130952 reproduced run
# 20261016-185430's signature exactly that way (daemon full/blobless/blobless+sparse
# old_blob=FAILED, path/file rows ok). The leftover came from `Stop-Process`
# killing only the launched PID: `git daemon` re-execs into a child tree whose
# last member is the one holding the port, which survives past "daemon stopped"
# (measured after 20261017-120505). Therefore the port is refused BEFORE
# binding — a held port may be a live concurrent run, so it is reported, not
# killed — the readiness probe verifies that the answering daemon serves this
# run's export, and teardown kills the whole tree.
$daemonPortOwner = $null
if ($Daemon) {
    $daemonPortOwner = Get-NetTCPConnection -LocalPort $DaemonPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($daemonPortOwner) {
        $ownerPid = $daemonPortOwner.OwningProcess
        $ownerCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue).CommandLine
        Write-Host ("port {0} already held by PID {1}: {2}" -f $DaemonPort, $ownerPid, $ownerCmd)
        Write-Host ('skipping the promisor phase — clones served by a leftover daemon measure a different repository; stop it first (Stop-Process -Id {0} -Force) unless it is a live run' -f $ownerPid)
    }
}
if ($Daemon -and -not $daemonPortOwner) {
    $port = $DaemonPort
    $export = Join-Path $run 'export'
    New-Item -ItemType Directory -Force -Path $export | Out-Null
    # A bare COPY, never a link into the fixture: see the header note on reparse points.
    $bare = Invoke-Git @('clone', '-q', '--bare', $src, (Join-Path $export 'upstream.git'))
    if ($bare.Code -ne 0) {
        Write-Host ("could not build the bare export: {0}" -f $bare.Out)
    } else {
        # `--listen`, not `--host`: re-measured on git 2.51.0.windows.1, `--host=` is
        # not a daemon option and the whole invocation dies on the usage screen.
        $daemonArgs = @('daemon', '--reuseaddr', '--export-all', '--enable=upload-pack',
            ('--base-path={0}' -f $export), '--listen=127.0.0.1', ('--port={0}' -f $port))
        $proc = Start-Process -FilePath 'git' -ArgumentList $daemonArgs -PassThru -WindowStyle Hidden `
            -RedirectStandardError (Join-Path $run 'daemon.log')
        Start-Sleep -Milliseconds 900
        try {
            $url = "git://127.0.0.1:{0}/upstream.git" -f $port
            # ls-remote proves only that A daemon answers; it must be THIS run's
            # export, otherwise a leftover daemon looks perfectly ready. HEAD of
            # the bare copy is the identity every fixture run re-seeds.
            $wantHead = (Invoke-Git @('-C', (Join-Path $export 'upstream.git'), 'rev-parse', 'HEAD')).Out.Trim()
            $ready = $false
            for ($try = 0; $try -lt 8 -and -not $ready; $try++) {
                if ($proc.HasExited) { break }
                $probe = Invoke-Git @('ls-remote', '--heads', $url)
                if ($probe.Code -eq 0 -and $probe.Out.Trim().StartsWith($wantHead)) { $ready = $true } else { Start-Sleep -Milliseconds 600 }
            }
            if (-not $ready) {
                Write-Host ("daemon not usable on {0} (exited={1}, or a foreign daemon answered with a different HEAD); skipping the promisor phase — a transport failure is not a clone result" -f $port, $proc.HasExited)
            } else {
                $daemonRows = New-CloneSet 'daemon' $url
                Report-Rows 'D. clone against git daemon on 127.0.0.1 (a real filter-capable remote)' $daemonRows
                $daemonProbes = @($daemonRows | ForEach-Object { Probe-Clone $_ })
                Write-Host '== E. update + history against daemon =='
                $daemonProbes | Format-Table -AutoSize Strategy, Shallow, Depth, Pull, OldBlob | Out-String -Width 200 | Write-Host
                foreach ($pr in $daemonProbes) {
                    if ($pr.PullNote) { Write-Host ("  {0} pull: {1}" -f $pr.Strategy, $pr.PullNote) }
                    if ($pr.OldNote) { Write-Host ("  {0} old blob: {1}" -f $pr.Strategy, $pr.OldNote) }
                }
                Write-Host '== E2. fetch --unshallow against daemon =='
                foreach ($pr in $daemonProbes) {
                    $u = Probe-Unshallow $pr.Rows
                    $pr | Add-Member -NotePropertyName Unshallow -NotePropertyValue $u -Force
                    Write-Host ("  {0,-16} {1}" -f $pr.Strategy, $u)
                }
                Write-Host ''
            }
        } finally {
            # Stop-Process on the launched PID alone leaks: `git daemon` re-execs
            # into cmd\git.exe -> git.exe -> git-daemon, and the last member holds
            # the port. Kill everything descending from the launched PID (their
            # ParentProcessId chains still name it after it is gone), then confirm
            # the port is actually free — stopping only a listener that serves
            # THIS run's export, so a concurrent run's daemon is never touched.
            $owned = [System.Collections.Generic.HashSet[int]]::new()
            [void]$owned.Add($proc.Id)
            $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
            $grew = $true
            while ($grew) {
                $grew = $false
                foreach ($p in $all) {
                    if ($owned.Contains([int]$p.ParentProcessId) -and $owned.Add([int]$p.ProcessId)) { $grew = $true }
                }
            }
            foreach ($id in $owned) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 300
            $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($still) {
                $stillCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($still.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine
                if ($stillCmd -and $stillCmd.Contains("--base-path=$export")) {
                    Stop-Process -Id $still.OwningProcess -Force -ErrorAction SilentlyContinue
                    Write-Host ("daemon child PID {0} survived the tree kill; stopped" -f $still.OwningProcess)
                } else {
                    Write-Host ("port {0} still held by PID {1} after teardown — not this run's daemon, left alone" -f $port, $still.OwningProcess)
                }
            }
            Write-Host 'daemon stopped'
        }
    }
}

if ($Remote) {
    Write-Host "== F. optional real-remote comparison: $Remote =="
    foreach ($name in @('full', 'shallow', 'blobless')) {
        $dst = Join-Path $run ("r-{0}" -f $name)
        $extra = switch ($name) {
            'shallow' { @('--depth', '1') }
            'blobless' { @('--filter=blob:none') }
            default { @() }
        }
        $r = Invoke-Git (@('clone', '-q') + $extra + @($Remote, $dst))
        $gb = Get-DirBytes (Join-Path $dst '.git')
        Write-Host ("  {0,-9} exit={1} ms={2} git={3:N0} B {4}" -f $name, $r.Code, $r.Ms, $gb,
            $(if ($r.Code) { (($r.Out -split "`n") | Where-Object { $_ } | Select-Object -First 1) } else { '' }))
    }
    Write-Host ''
}

# ---------------------------------------------------------------------------
# Machine-readable tail — docs/clone-strategy.md quotes this block.
# ---------------------------------------------------------------------------
Write-Host '== BLOCK (machine-readable, tab separated) =='
Write-Host ("git_version`t{0}" -f (Invoke-Git @('--version')).Out)
Write-Host ("shape`t{0}x{1}x{2}KiB" -f $Commits, $Files, $Kb)
Write-Host ("fixture_git_bytes`t{0}" -f $srcGit)
$sets = @(@('path', $pathRows, $pathProbes), @('file', $fileRows, $fileProbes))
if ($daemonRows) {
    # The leading comma wraps the triple as ONE element: without it PowerShell splices
    # the three items into $sets individually and the tail below prints a hashtable
    # dump instead of daemon rows — which is exactly what the first version of this
    # script did, and it looked like data rather than like a bug.
    $sets += ,@(@('daemon', $daemonRows, $daemonProbes))
}
foreach ($set in $sets) {
    foreach ($r in $set[1]) {
        $pr = $set[2] | Where-Object { $_.Strategy -eq $r.Strategy }
        Write-Host ("{0}`t{1}`tclone_ms={2}`tgit_bytes={3}`ttotal_bytes={4}`tclone_exit={5}`tfilter_cfg={6}`tpromisor={7}`tshallow={8}`tdepth={9}`tpull_ff_only={10}`told_blob={11}`tunshallow={12}`twarn={13}" -f `
            $set[0], $r.Strategy, $r.CloneMs, $r.GitBytes, $r.TotalBytes, $r.ExitCode, $r.FilterCfg, $r.Promisor,
            $pr.Shallow, $pr.Depth, $pr.Pull, $pr.OldBlob, $pr.Unshallow, $r.Warning)
    }
}

if (-not $Keep) {
    Write-Host ''
    Write-Host ("removed {0} (pass -Keep to inspect the clones)" -f $run)
    Remove-Item -LiteralPath $run -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host ''
    Write-Host ("kept: {0}" -f $run)
}
exit 0
