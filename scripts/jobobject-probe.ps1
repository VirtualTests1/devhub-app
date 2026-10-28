# jobobject-probe.ps1 — the measured half of round 17's R3
# (Windows process-tree termination: Job Object vs `taskkill /T`).
#
# WHY
#   DevHub terminates a launched project's whole process tree with
#   `taskkill /T /F` (src-tauri/src/lib.rs, `kill_tree` and `stop_process_sync`;
#   src-tauri/src/launch.rs, the sequential-step deadline). The comment on the
#   exit sweep records the incident that motivated the ordering — with
#   `child.kill()` run *first*, the tracked shell died, `taskkill /T` then found
#   nothing at that pid, and `npm run dev`'s node child went on holding its port.
#
#   Two questions decide whether the app should migrate the tree kill to a
#   Job Object, and neither is answerable from prose:
#     1. With the root still alive, does `taskkill /T` actually reach a
#        grandchild two levels down? (control)
#     2. Once an ancestor has already exited — the root, or the intermediate —
#        does `taskkill /T` still reach the surviving grandchild? (the boundary)
#   The Job Object's claim is that membership is captured in the kernel at
#   `CreateProcess` time and depends on no ancestor staying alive and on no
#   parent-link walk at kill time. This script measures both claims.
#
# WHAT IT BUILDS
#   A real parent -> child -> grandchild chain of pwsh processes. Each level
#   writes its own PID into the scratch dir, so identities are exact rather than
#   inferred from ParentProcessId (a stale link or PID reuse would make the
#   inferred chain wrong). The grandchild is a long `Start-Sleep` — the
#   "workload that outlives its launcher shell" this round is about.
#
#   Four measured scenarios:
#     A1 taskkill/root-alive     — control: all three alive, then /T on the root
#     A2 taskkill/root-gone      — the root exited before the kill
#     A3 taskkill/mid-gone       — the intermediate exited, root still alive
#     B  jobobject/kill-on-close — the root is assigned to a job carrying
#        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE before it spawns its child, both
#        ancestors are then gone, and the last job handle is closed
#
# USAGE
#   pwsh -NoProfile -File scripts\jobobject-probe.ps1 [-LifetimeSec 300] [-Keep]
#
#   pwsh (7.x), not `powershell` (5.1): the repository's UTF-8 .ps1 files are
#   mis-parsed by Windows PowerShell 5.1 without a BOM (see scripts/clone-bench.ps1).
#
# SAFE BY CONSTRUCTION
#   Writes only under `<repo>/.jobprobe/<timestamp>/` (git-ignored), never the C:
#   drive. Every process it starts is recorded in that scratch dir and killed in
#   the `finally` sweep, so a failed run cannot leave an orphan behind. The Job
#   Object is created unnamed and its handle is closed on every exit path.

[CmdletBinding()]
param(
    # 'controller' runs the four scenarios; the other roles are re-entrant
    # helpers the controller launches to form the chain.
    [ValidateSet('controller', 'parent', 'child', 'grandchild')]
    [string]$Role = 'controller',
    [string]$Scratch = '',
    [int]$ExitAfterMs = -1,          # -1 = stay alive forever after spawning the next level
    [int]$ChildExitAfterMs = -1,     # parent forwards this to the child it spawns
    [int]$LifetimeSec = 300,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'

$self = $MyInvocation.MyCommand.Path
$pwshExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
if ($Scratch) {
    $scratch = $Scratch
} else {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $scratch = Join-Path (Join-Path $repoRoot '.jobprobe') (Get-Date -Format 'yyyyMMdd-HHmmss')
}

# ---------------------------------------------------------------------------
# Output: a machine-readable key=value stream (paste-able as a table).
# ---------------------------------------------------------------------------
$Results = [ordered]@{}
function Emit([string]$Key, $Value) {
    $Results[$Key] = $Value
    Write-Host ("{0}={1}" -f $Key, $Value)
}

function PidFile([string]$r) { Join-Path $scratch "pid-$r.txt" }
function GateFile { Join-Path $scratch 'gate.txt' }

function Test-PidAlive([int]$id) {
    if ($id -le 0) { return $false }
    return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
}
function CmdLineOf([int]$id) {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine
}
function Wait-ForFile([string]$path, [int]$TimeoutMs = 20000) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while (-not (Test-Path -LiteralPath $path)) {
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 50
    }
    return $true
}
function Wait-ForDeath([int]$id, [int]$TimeoutMs = 10000) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while (Test-PidAlive $id) {
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 100
    }
    return $true
}
# Reads a role's PID from its file, tolerating the write race: Set-Content
# creates the file before it has content, so an existence check alone can hand
# back an empty file and `.Trim()` then fails on $null (measured — that is how
# this script failed its first full run).
function Read-PidFile([string]$role, [int]$TimeoutMs = 20000) {
    $f = PidFile $role
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ($true) {
        $raw = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
        if ($raw) {
            $v = 0
            if ([int]::TryParse(([string]$raw).Trim(), [ref]$v) -and $v -gt 0) { return $v }
        }
        if ((Get-Date) -gt $deadline) { throw "pid file for '$role' was not readable within $TimeoutMs ms" }
        Start-Sleep -Milliseconds 50
    }
}

# ===========================================================================
# ROLE MODES — re-entrant helpers, launched by the controller.
# ===========================================================================
if ($Role -ne 'controller') {
    if (-not $scratch) { throw 'role mode requires -Scratch' }
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    Set-Content -LiteralPath (PidFile $Role) -Value $PID -Encoding ascii

    if ($Role -eq 'grandchild') {
        Start-Sleep -Seconds $LifetimeSec
        exit 0
    }

    # parent / child: wait for the gate, spawn the next level, then optionally exit.
    while (-not (Test-Path -LiteralPath (GateFile))) { Start-Sleep -Milliseconds 50 }
    $nextRole = if ($Role -eq 'parent') { 'child' } else { 'grandchild' }
    $nextExit = if ($Role -eq 'parent') { $ChildExitAfterMs } else { -1 }
    $a = @('-NoProfile', '-File', $self, '-Role', $nextRole, '-Scratch', $scratch,
        '-LifetimeSec', "$LifetimeSec", '-ExitAfterMs', "$nextExit")
    Start-Process -FilePath $pwshExe -ArgumentList ($a -join ' ') -WindowStyle Hidden | Out-Null
    Wait-ForFile (PidFile $nextRole) 20000 | Out-Null

    if ($ExitAfterMs -ge 0) {
        Start-Sleep -Milliseconds $ExitAfterMs
        exit 0
    }
    while ($true) { Start-Sleep -Seconds 1 }
}

# ===========================================================================
# CONTROLLER
# ===========================================================================
New-Item -ItemType Directory -Force -Path $scratch | Out-Null

# Inline C# — the four P/Invoke calls the Job Object path needs. All four are
# exported by Kernel32.dll per the Microsoft Learn "Requirements" tables.
$cs = @'
using System;
using System.Runtime.InteropServices;

public static class DevHubJob {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
        IntPtr hJob, int infoClass, IntPtr lpJobObjectInformation, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(
        IntPtr hJob, int infoClass, IntPtr lpJobObjectInformation, uint cbInfoLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    public static int LastError() { return Marshal.GetLastWin32Error(); }

    // Size and field offset computed in C# so PowerShell never has to resolve
    // Marshal.SizeOf/OffsetOf overloads against a RuntimeType (which it binds
    // wrongly — measured: "Type 'System.RuntimeType' cannot be marshaled").
    public static int ExtendedLimitSize() {
        return Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    }
    public static int LimitFlagsOffset() {
        return Marshal.OffsetOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "BasicLimitInformation").ToInt32()
             + Marshal.OffsetOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "LimitFlags").ToInt32();
    }
}
'@

$JobSupported = $true
$JobLoadError = ''
try { Add-Type -TypeDefinition $cs -ErrorAction Stop }
catch { $JobSupported = $false; $JobLoadError = $_.Exception.Message -replace '[\r\n]+', ' ' }

$jobHandle = [IntPtr]::Zero
$openedHandles = New-Object System.Collections.Generic.List[IntPtr]

function Sweep {
    if ($jobHandle -ne [IntPtr]::Zero) {
        try { [void][DevHubJob]::CloseHandle($jobHandle) } catch {}
        $jobHandle = [IntPtr]::Zero
    }
    foreach ($h in $openedHandles) { try { [void][DevHubJob]::CloseHandle($h) } catch {} }
    $openedHandles.Clear()
    foreach ($r in 'parent', 'child', 'grandchild') {
        $f = PidFile $r
        if (Test-Path -LiteralPath $f) {
            $id = 0
            $raw = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
            if ($raw) { [void][int]::TryParse(([string]$raw).Trim(), [ref]$id) }
            if ($id -gt 0 -and (Test-PidAlive $id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Start-ChainRoot([int]$RootExitAfterMs, [int]$ChildExitAfterMs) {
    Remove-Item -LiteralPath (GateFile) -ErrorAction SilentlyContinue
    foreach ($r in 'parent', 'child', 'grandchild') { Remove-Item -LiteralPath (PidFile $r) -ErrorAction SilentlyContinue }
    $a = @('-NoProfile', '-File', $self, '-Role', 'parent', '-Scratch', $scratch,
        '-LifetimeSec', "$LifetimeSec", '-ExitAfterMs', "$RootExitAfterMs",
        '-ChildExitAfterMs', "$ChildExitAfterMs")
    Start-Process -FilePath $pwshExe -ArgumentList ($a -join ' ') -WindowStyle Hidden | Out-Null
    return Read-PidFile 'parent'
}

function Open-Gate { Set-Content -LiteralPath (GateFile) -Value 'go' -Encoding ascii }

function Read-Chain() {
    return @{
        Parent = Read-PidFile 'parent'
        Child  = Read-PidFile 'child'
        Grand  = Read-PidFile 'grandchild'
    }
}

function Wait-ChainPids([int]$TimeoutMs = 20000) {
    return Read-Chain
}

function Report-Chain([string]$prefix, $chain) {
    foreach ($k in 'Parent', 'Child', 'Grand') {
        $id = $chain[$k]
        $tag = $k.ToLower()
        Emit "$prefix.pid_$tag" $id
        Emit "$prefix.cmdline_$tag" ((CmdLineOf $id) -replace '[\r\n]+', ' ')
        Emit "$prefix.alive_$tag" (Test-PidAlive $id)
    }
}

function Verdict([int]$grandPid) {
    if (Test-PidAlive $grandPid) { return 'grandchild_SURVIVED' } else { return 'grandchild_reclaimed' }
}

try {
    Emit 'probe.pwsh_version' $PSVersionTable.PSVersion.ToString()
    Emit 'probe.scratch' $scratch
    Emit 'probe.lifetime_sec' $LifetimeSec

    # --- A1: control — root alive, taskkill /T on the root -------------------
    Write-Host "`n[A1] taskkill /T with the root still alive (control)"
    [void](Start-ChainRoot -1 -1)
    Open-Gate
    $a1 = Wait-ChainPids
    Report-Chain 'A1.before' $a1
    $out = & taskkill /PID $a1.Parent /T /F 2>&1
    Emit 'A1.taskkill_exitcode' $LASTEXITCODE
    Emit 'A1.taskkill_output' (($out | Out-String).Trim() -replace '[\r\n]+', ' ')
    [void](Wait-ForDeath $a1.Grand 8000)
    Emit 'A1.after.alive_parent' (Test-PidAlive $a1.Parent)
    Emit 'A1.after.alive_child' (Test-PidAlive $a1.Child)
    Emit 'A1.after.alive_grandchild' (Test-PidAlive $a1.Grand)
    Emit 'A1.verdict' (Verdict $a1.Grand)
    Sweep

    # --- A2: the root has already exited (the measured DevHub incident) ------
    Write-Host "`n[A2] taskkill /T after the root has already exited"
    [void](Start-ChainRoot 600 -1)   # root exits ~600 ms after spawning the child
    Open-Gate
    $a2 = Wait-ChainPids
    [void](Wait-ForDeath $a2.Parent 10000)
    Emit 'A2.root_exited_before_kill' (-not (Test-PidAlive $a2.Parent))
    Emit 'A2.child_alive_before_kill' (Test-PidAlive $a2.Child)
    Emit 'A2.grandchild_alive_before_kill' (Test-PidAlive $a2.Grand)
    $out = & taskkill /PID $a2.Parent /T /F 2>&1
    Emit 'A2.taskkill_exitcode' $LASTEXITCODE
    Emit 'A2.taskkill_output' (($out | Out-String).Trim() -replace '[\r\n]+', ' ')
    [void](Wait-ForDeath $a2.Grand 8000)
    Emit 'A2.after.alive_grandchild' (Test-PidAlive $a2.Grand)
    Emit 'A2.verdict' (Verdict $a2.Grand)
    Sweep

    # --- A3: the intermediate has exited, the root still alive ---------------
    Write-Host "`n[A3] taskkill /T when the intermediate parent has exited"
    [void](Start-ChainRoot -1 600)   # root stays; child exits ~600 ms after spawning the grandchild
    Open-Gate
    $a3 = Wait-ChainPids
    [void](Wait-ForDeath $a3.Child 10000)
    Report-Chain 'A3.before' $a3
    Emit 'A3.intermediate_exited_before_kill' (-not (Test-PidAlive $a3.Child))
    Emit 'A3.root_alive_before_kill' (Test-PidAlive $a3.Parent)
    Emit 'A3.grandchild_alive_before_kill' (Test-PidAlive $a3.Grand)
    $out = & taskkill /PID $a3.Parent /T /F 2>&1
    Emit 'A3.taskkill_exitcode' $LASTEXITCODE
    Emit 'A3.taskkill_output' (($out | Out-String).Trim() -replace '[\r\n]+', ' ')
    [void](Wait-ForDeath $a3.Grand 8000)
    Emit 'A3.after.alive_grandchild' (Test-PidAlive $a3.Grand)
    Emit 'A3.verdict' (Verdict $a3.Grand)
    Sweep

    # --- B: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ---------------
    Write-Host "`n[B] Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"
    Emit 'B.addtype_supported' $JobSupported
    if (-not $JobSupported) {
        Emit 'B.load_error' $JobLoadError
        Emit 'B.verdict' 'skipped_addtype_failed'
    } else {
        $jobHandle = [DevHubJob]::CreateJobObject([IntPtr]::Zero, $null)
        if ($jobHandle -eq [IntPtr]::Zero) {
            Emit 'B.create_jobobject_error' ([DevHubJob]::LastError())
            Emit 'B.verdict' 'skipped_create_jobobject_failed'
        } else {
            # The flag must be written into an UNMANAGED buffer, not a PowerShell
            # struct variable: `$info.BasicLimitInformation.LimitFlags = X` mutates a
            # nested value-type COPY and leaves $info unchanged (measured — the first
            # run of this script "set" the flag, SetInformationJobObject returned True,
            # and nothing was ever killed). The offset is derived from the documented
            # struct layout, and read back afterwards so the evidence is a verified
            # flag rather than a return code.
            $size = [DevHubJob]::ExtendedLimitSize()
            $limitOffset = [DevHubJob]::LimitFlagsOffset()
            Emit 'B.extended_limit_size_bytes' $size
            Emit 'B.limit_flags_offset' $limitOffset

            $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
            try {
                for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
                [Runtime.InteropServices.Marshal]::WriteInt32($buf, $limitOffset, [int][DevHubJob]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
                $ok = [DevHubJob]::SetInformationJobObject($jobHandle, [DevHubJob]::JobObjectExtendedLimitInformation, $buf, [uint32]$size)
                Emit 'B.set_kill_on_close' $ok
                if (-not $ok) { Emit 'B.set_limit_error' ([DevHubJob]::LastError()) }

                $retLen = 0
                $qok = [DevHubJob]::QueryInformationJobObject($jobHandle, [DevHubJob]::JobObjectExtendedLimitInformation, $buf, [uint32]$size, [ref]$retLen)
                $flags = [Runtime.InteropServices.Marshal]::ReadInt32($buf, $limitOffset)
                Emit 'B.query_ok' $qok
                Emit 'B.verified_limit_flags' ('0x{0:X4}' -f $flags)
                Emit 'B.kill_on_close_verified' ($qok -and ($flags -band [int][DevHubJob]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE))
            } finally {
                [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
            }

            # Assign the ROOT before it may spawn the child: the child and the
            # grandchild inherit the job at CreateProcess time.
            [void](Start-ChainRoot 800 -1)
            $p = Read-PidFile 'parent'
            $h = [DevHubJob]::OpenProcess(0x0100 -bor 0x0001 -bor 0x0400, $false, [uint32]$p)
            $openedHandles.Add($h) | Out-Null
            Emit 'B.open_process_ok' ($h -ne [IntPtr]::Zero)
            $assigned = $false
            if ($h -ne [IntPtr]::Zero) {
                $assigned = [DevHubJob]::AssignProcessToJobObject($jobHandle, $h)
                if (-not $assigned) { Emit 'B.assign_error' ([DevHubJob]::LastError()) }
            }
            Emit 'B.assign_parent_ok' $assigned

            # Confirm the ROOT is really in the job (a failed assign would make
            # the whole scenario meaningless rather than "the job did not work").
            $inParent = $false
            if ($h -ne [IntPtr]::Zero) { [void][DevHubJob]::IsProcessInJob($h, $jobHandle, [ref]$inParent) }
            Emit 'B.parent_in_job' $inParent

            Open-Gate
            $b = Wait-ChainPids
            # Does the grandchild actually carry the job membership? This is the
            # claim under test: children inherit the parent's job at CreateProcess.
            $hg = [DevHubJob]::OpenProcess(0x0400, $false, [uint32]$b.Grand)
            $openedHandles.Add($hg) | Out-Null
            $inGrand = $false
            if ($hg -ne [IntPtr]::Zero) { [void][DevHubJob]::IsProcessInJob($hg, $jobHandle, [ref]$inGrand) }
            Emit 'B.grandchild_in_job' $inGrand
            # Leave ONLY the grandchild alive: the root exits on its own (800 ms)
            # and the child is stopped here.
            if (Test-PidAlive $b.Child) { Stop-Process -Id $b.Child -Force -ErrorAction SilentlyContinue }
            [void](Wait-ForDeath $b.Parent 10000)
            [void](Wait-ForDeath $b.Child 10000)

            Report-Chain 'B.before_close' $b
            Emit 'B.ancestors_gone_before_close' ((-not (Test-PidAlive $b.Parent)) -and (-not (Test-PidAlive $b.Child)))
            Emit 'B.grandchild_alive_before_close' (Test-PidAlive $b.Grand)

            # Closing the last handle triggers JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
            $closed = [DevHubJob]::CloseHandle($jobHandle)
            $jobHandle = [IntPtr]::Zero
            Emit 'B.close_handle_result' $closed
            [void](Wait-ForDeath $b.Grand 10000)
            Emit 'B.after.alive_grandchild' (Test-PidAlive $b.Grand)
            Emit 'B.verdict' (Verdict $b.Grand)
        }
    }
} catch {
    Emit 'probe.error' ($_.Exception.Message -replace '[\r\n]+', ' ')
    Emit 'probe.error_at' ($_.InvocationInfo.PositionMessage -replace '[\r\n]+', ' ')
    throw
} finally {
    Sweep
}

# --- machine-readable verdict table -----------------------------------------
Write-Host "`n--- verdict (paste-able) ---"
Write-Host "scenario,a1_taskkill_root_alive,a2_taskkill_root_gone,a3_taskkill_mid_gone,b_jobobject_kill_on_close"
Write-Host ("verdict,{0},{1},{2},{3}" -f $Results['A1.verdict'], $Results['A2.verdict'], $Results['A3.verdict'], $Results['B.verdict'])

if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "kept scratch: $scratch" }
