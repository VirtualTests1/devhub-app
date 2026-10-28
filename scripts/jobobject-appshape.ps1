# jobobject-appshape.ps1 - reproducible Job Object probe for the app's real spawn shape.
#
# docs/process-tree-termination.md verified a pwsh parent -> child -> grandchild chain.
# The app does not launch pwsh: it launches `cmd /c <user command>`, and that cmd may
# spawn node/python grandchildren. This script measures that shape:
#
#   cmd.exe (root, assigned before it starts node)
#     -> node worker (long-lived)
#        -> node grandchild (long-lived)
#
# Then it closes the only job handle. Expected: all three are gone, proving inheritance
# at CreateProcess time rather than a parent-link walk. It writes only under
# <repo>/.jobprobe/ and never touches the C: drive. Run with pwsh 7.x.
#
# Usage: pwsh -NoProfile -File scripts\jobobject-appshape.ps1 [-LifetimeSec 60]
[CmdletBinding()]
param([int]$LifetimeSec = 60, [switch]$Keep)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path (Join-Path $repoRoot '.jobprobe') ("appshape-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$results = [ordered]@{}
function Emit([string]$k, $v) { $results[$k] = $v; Write-Host ("{0}={1}" -f $k, $v) }
function Test-PidAlive([int]$id) { try { $null = Get-Process -Id $id -ErrorAction Stop; $true } catch { $false } }
function Wait-File([string]$path, [int]$timeoutMs = 15000) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while (-not (Test-Path -LiteralPath $path)) {
        if ((Get-Date) -gt $deadline) { return $false }
        Start-Sleep -Milliseconds 50
    }
    return $true
}
function Wait-Death([int]$id, [int]$timeoutMs = 8000) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PidAlive $id)) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return -not (Test-PidAlive $id)
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobProbe26 {
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
        public ulong ReadOperationCount; public ulong WriteOperationCount;
        public ulong OtherOperationCount; public ulong ReadTransferCount;
        public ulong WriteTransferCount; public ulong OtherTransferCount;
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
    public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len, out uint ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    public static int LastError() { return Marshal.GetLastWin32Error(); }
    public static int Size() { return Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); }
    public static int FlagsOffset() { return (int)Marshal.OffsetOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), "BasicLimitInformation") + (int)Marshal.OffsetOf(typeof(JOBOBJECT_BASIC_LIMIT_INFORMATION), "LimitFlags"); }
}
'@

$job = [JobProbe26]::CreateJobObject([IntPtr]::Zero, $null)
$jobHandle = [IntPtr]$job
$processHandles = [System.Collections.Generic.List[IntPtr]]::new()
$rootPid = 0; $nodePid = 0; $grandPid = 0
try {
    Emit 'job_created' ($jobHandle -ne [IntPtr]::Zero)
    if ($jobHandle -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([JobProbe26]::LastError())" }
    $size = [JobProbe26]::Size(); $offset = [JobProbe26]::FlagsOffset()
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
    try {
        for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
        [Runtime.InteropServices.Marshal]::WriteInt32($buf, $offset, [int][JobProbe26]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        Emit 'set_limit_ok' ([JobProbe26]::SetInformationJobObject($jobHandle, [JobProbe26]::JobObjectExtendedLimitInformation, $buf, [uint32]$size))
        $ret = 0
        $q = [JobProbe26]::QueryInformationJobObject($jobHandle, [JobProbe26]::JobObjectExtendedLimitInformation, $buf, [uint32]$size, [ref]$ret)
        Emit 'verified_flags' ('0x{0:X4}' -f [Runtime.InteropServices.Marshal]::ReadInt32($buf, $offset))
        Emit 'kill_on_close_verified' ($q -and (([Runtime.InteropServices.Marshal]::ReadInt32($buf, $offset)) -band [int][JobProbe26]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE))
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }

    $childJs = Join-Path $scratch 'worker.cjs'
    @'
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(dir, "node.pid"), String(process.pid));
fs.writeFileSync(path.join(dir, "grand.pid"), String(grand.pid));
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath $childJs -Encoding ascii
    $launch = Join-Path $scratch 'launch.cmd'
    # The 2 s ping gives this script time to assign the root to the job before node
    # exists. That is the same ordering the app has: the job is assigned right after
    # CreateProcess, before the shell runs the user's command.
    @"
@echo off
ping -n 3 127.0.0.1 >nul
node "$childJs"
"@ | Set-Content -LiteralPath $launch -Encoding ascii

    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $env:ComSpec
    [void]$psi.ArgumentList.Add('/c')
    [void]$psi.ArgumentList.Add($launch)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    Emit 'launch_script' $launch
    $root = [Diagnostics.Process]::Start($psi)
    $rootPid = $root.Id
    Emit 'root_pid' $rootPid
    $h = [JobProbe26]::OpenProcess(0x0100 -bor 0x0001, $false, [uint32]$rootPid)
    $processHandles.Add($h)
    Emit 'root_open_ok' ($h -ne [IntPtr]::Zero)
    $assigned = $false
    if ($h -ne [IntPtr]::Zero) { $assigned = [JobProbe26]::AssignProcessToJobObject($jobHandle, $h) }
    Emit 'root_assigned' $assigned

    $nodePidFile = Join-Path $scratch 'node.pid'
    $grandPidFile = Join-Path $scratch 'grand.pid'
    Emit 'node_pid_file' (Wait-File $nodePidFile)
    Emit 'grand_pid_file' (Wait-File $grandPidFile)
    if (Test-Path $nodePidFile) { $nodePid = [int](Get-Content $nodePidFile -Raw).Trim() }
    if (Test-Path $grandPidFile) { $grandPid = [int](Get-Content $grandPidFile -Raw).Trim() }
    Emit 'node_pid' $nodePid
    Emit 'grand_pid' $grandPid
    Emit 'root_alive_before_close' (Test-PidAlive $rootPid)
    Emit 'node_alive_before_close' (Test-PidAlive $nodePid)
    Emit 'grand_alive_before_close' (Test-PidAlive $grandPid)

    foreach ($procId in @($nodePid, $grandPid)) {
        if ($procId -le 0) { continue }
        $hp = [JobProbe26]::OpenProcess(0x0400, $false, [uint32]$procId)
        $processHandles.Add($hp)
        $inside = $false
        if ($hp -ne [IntPtr]::Zero) { [void][JobProbe26]::IsProcessInJob($hp, $jobHandle, [ref]$inside) }
        Emit ("pid_{0}_in_job" -f $procId) $inside
    }

    [void][JobProbe26]::CloseHandle($jobHandle)
    $jobHandle = [IntPtr]::Zero
    Emit 'root_dead_after_close' (Wait-Death $rootPid)
    Emit 'node_dead_after_close' (Wait-Death $nodePid)
    Emit 'grand_dead_after_close' (Wait-Death $grandPid)
} finally {
    if ($jobHandle -ne [IntPtr]::Zero) { [void][JobProbe26]::CloseHandle($jobHandle) }
    foreach ($h in $processHandles) { if ($h -ne [IntPtr]::Zero) { [void][JobProbe26]::CloseHandle($h) } }
    foreach ($procId in @($grandPid, $nodePid, $rootPid)) { if ($procId -gt 0) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } }
    if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue } else { Write-Host "kept $scratch" }
}
