# DevHub build environment for Windows.
#
# WHY THIS EXISTS
#   On this machine `rustc` cannot link out of the box:
#     - `link.exe` is not on PATH.
#     - The VS `vcvars64.bat` is BROKEN here: "The specified configuration type
#       is missing." Verified 2026-01-15.
#     - There are several Visual Studio installs and the usual discovery tools
#       point at the wrong one: `vswhere -latest` can report an install that does
#       not carry the C++ tools at all.
#     - Manually setting INCLUDE/LIB/PATH makes rustc link successfully.
#
#   Therefore this script locates the toolchain by FINDING cl.exe on disk
#   (robust against wrong vswhere output and against the VS install layout),
#   then derives the toolset root from its path.
#
# USAGE
#   . .\env.ps1          # dot-source, then: cargo build / pnpm tauri dev
#
# Safe to run repeatedly; only modifies the current process environment.
#
# NOTE: paths containing '[' or ']' (e.g. "Program Files (x86)") are wildcards
# for many cmdlets, so -LiteralPath is used throughout.

$ErrorActionPreference = 'Stop'

# `${env:ProgramFiles(x86)}` (and, in some automation shells, ProgramFiles) can be
# absent even though the literal directory exists. Resolve both once: interpolating
# an empty variable produces a relative root like "\Windows Kits\10\Lib", which
# never resolves - a machine that can build being reported as one that cannot.
$programFiles = $env:ProgramFiles
if ([string]::IsNullOrWhiteSpace($programFiles)) { $programFiles = 'C:\Program Files' }
$programFilesX86 = ${env:ProgramFiles(x86)}
if ([string]::IsNullOrWhiteSpace($programFilesX86)) { $programFilesX86 = 'C:\Program Files (x86)' }

# Machine-local extra VS roots stay out of the repository: create env.local.ps1
# next to this file (it is git-ignored) with e.g.
#   $env:DEVHUB_VS_EXTRA_ROOT = '<path-to-visual-studio>'
$localEnv = Join-Path $PSScriptRoot 'env.local.ps1'
if (Test-Path -LiteralPath $localEnv) { . $localEnv }

function Get-DevHubMsvcToolset {
    $extraRoots = @($env:DEVHUB_VS_EXTRA_ROOT) | Where-Object { $_ }
    $searchRoots = @(
        (Join-Path $programFiles 'Microsoft Visual Studio'),
        (Join-Path $programFilesX86 'Microsoft Visual Studio')
    ) + $extraRoots | Where-Object { Test-Path -LiteralPath $_ }

    # find.exe honours -LiteralPath semantics (no globbing), so "(x86)" is safe.
    foreach ($root in $searchRoots) {
        # `where.exe` writes "file not found" to stderr, and with
        # $ErrorActionPreference='Stop' that becomes a terminating
        # NativeCommandError: one empty search root aborts the whole script
        # instead of moving on to the next. Observed on this machine, where the
        # same file worked twice and then failed with no source change at all.
        $hit = $null
        try { $hit = & where.exe /R "$root" cl.exe 2>$null | Select-Object -First 1 } catch { $hit = $null }
        if (-not $hit) { continue }
        # ...\VC\Tools\MSVC\<version>\bin\Hostx64\x64\cl.exe -> toolset root
        $m = [regex]::Match($hit, '^(.*\\VC\\Tools\\MSVC\\[^\\]+)\\', 'IgnoreCase')
        if (-not $m.Success) { continue }
        $toolsetRoot = $m.Groups[1].Value
        if (Test-Path -LiteralPath (Join-Path $toolsetRoot 'bin\Hostx64\x64\link.exe')) {
            return [pscustomobject]@{
                Root = $toolsetRoot
                Name = Split-Path $toolsetRoot -Leaf
                ClExe = $hit
            }
        }
    }
    return $null
}

function Get-DevHubWindowsSdk {
    # The root was resolved once at script scope (see $programFilesX86): an empty
    # variable would yield the relative root "\Windows Kits\10\Lib", which never
    # resolves and reads as "no SDK installed".
    $libRoot = Join-Path $programFilesX86 'Windows Kits\10\Lib'
    if (-not (Test-Path -LiteralPath $libRoot)) { return $null }
    $versions = Get-ChildItem -LiteralPath $libRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\x64\ucrt.lib') }
    if ($versions.Count -eq 0) { return $null }
    return ($versions | Sort-Object Name -Descending | Select-Object -First 1)
}

$msvc = Get-DevHubMsvcToolset
$sdk = Get-DevHubWindowsSdk

if (-not $msvc) {
    throw "No MSVC toolset with link.exe found. Install 'Desktop development with C++' via the Visual Studio Installer."
}
if (-not $sdk) {
    throw "No usable Windows SDK found (needs Lib\<ver>\ucrt\x64\ucrt.lib). Install the Windows SDK."
}

# Derive the root from the directory actually found. Re-reading the environment
# variable here is what made the fallback above cosmetic: the SDK was found under
# C:\Program Files (x86) while INCLUDE/LIB pointed at "\Windows Kits\10".
$sdkRoot = $sdk.Parent.Parent.FullName
$sdkVer = $sdk.Name
$binHost = Join-Path $msvc.Root 'bin\Hostx64\x64'
$sdkBin = Join-Path $sdkRoot "bin\$sdkVer\x64"
$sdkInc = Join-Path $sdkRoot "Include\$sdkVer"
$sdkLib = Join-Path $sdkRoot "Lib\$sdkVer"

$env:VCToolsInstallDir = $msvc.Root + '\'
$env:WindowsSdkDir = $sdkRoot + '\'
$env:WindowsSDKVersion = "$sdkVer\"

# Prepend, preserving existing PATH entries.
$env:PATH = @($binHost, $sdkBin, $env:PATH) -join ';'

$env:INCLUDE = @(
    (Join-Path $msvc.Root 'include'),
    (Join-Path $sdkInc 'ucrt'),
    (Join-Path $sdkInc 'um'),
    (Join-Path $sdkInc 'shared'),
    (Join-Path $sdkInc 'winrt')
) -join ';'

$libs = @(
    (Join-Path $msvc.Root 'lib\x64'),
    (Join-Path $sdkLib 'ucrt\x64'),
    (Join-Path $sdkLib 'um\x64')
) -join ';'
$env:LIB = $libs
$env:LIBPATH = $libs

Write-Host 'DevHub build env ready' -ForegroundColor Green
Write-Host "  MSVC toolset : $($msvc.Name)  ($($msvc.Root))" -ForegroundColor DarkGray
Write-Host "  Windows SDK  : $sdkVer" -ForegroundColor DarkGray
Write-Host "  link.exe     : $(Join-Path $binHost 'link.exe')" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# sccache (R1 build-cache): keep the compile cache inside the repo, never on C:
# ---------------------------------------------------------------------------
# sccache's default cache lives in %LOCALAPPDATA%\Mozilla\sccache (C:). Pin it
# to the repo so all build state stays project-local. The rustc-wrapper is set
# in `src-tauri/.cargo/config.toml`.
if ($PSScriptRoot) {
    $env:SCCACHE_DIR = Join-Path $PSScriptRoot 'src-tauri\.sccache-cache'
}

# ...but the *binary* is gitignored (machine-local build tooling), while the
# `rustc-wrapper` line that points at it lives in the tracked
# `src-tauri/.cargo/config.toml`. A linked worktree - or a fresh clone - therefore has
# the config and not the exe, and every cargo run dies before compiling anything:
#   error: could not execute process "...vendor/sccache/bin/sccache.exe ... -vV" (never executed)
# Measured 2026-10-18 in .worktrees/r18-r1-watch, where `cargo test --lib` could not run at
# all. Clearing the environment variable is NOT the fix - measured here too: with
# RUSTC_WRAPPER='' cargo still executed the wrapper from the config file, because cargo
# treats an empty value as absent rather than as an override. What works is making the
# path exist: in a linked worktree, point it at the main checkout's vendored copy with a
# junction, the same mechanism node_modules already uses for the shared store. A fresh
# clone has neither, and that case belongs to whoever owns the sccache feature - the
# message below says so instead of dying inside cargo with an os error 3.
if ($PSScriptRoot) {
    $localSccache = Join-Path $PSScriptRoot 'vendor\sccache'
    $localBin = Join-Path $localSccache 'bin\sccache.exe'
    if (-not (Test-Path -LiteralPath $localBin)) {
        # A linked worktree can share the main checkout's vendored binary through
        # the same junction mechanism node_modules uses. A fresh clone has neither;
        # it simply runs unwrapped instead of failing before the first compile.
        $dotGitHere = Join-Path $PSScriptRoot '.git'
        if (Test-Path -LiteralPath $dotGitHere -PathType Leaf) {
            $rawHere = (Get-Content -LiteralPath $dotGitHere -Raw) -replace '^gitdir:\s*', ''
            $adminHere = $rawHere.Trim()
            $mainHere = Split-Path -Path (Split-Path -Path (Split-Path -Path $adminHere -Parent) -Parent) -Parent
            $mainBin = Join-Path $mainHere 'vendor/sccache/bin/sccache.exe'
            if (Test-Path -LiteralPath $mainBin) {
                if (-not (Test-Path -LiteralPath $localSccache)) {
                    New-Item -ItemType Directory -Path (Split-Path -Path $localSccache -Parent) -Force | Out-Null
                    New-Item -ItemType Junction -Path $localSccache -Target (Join-Path $mainHere 'vendor\sccache') | Out-Null
                }
            }
        }
    }
    if (Test-Path -LiteralPath $localBin) {
        $env:RUSTC_WRAPPER = $localBin
        Write-Host "  sccache      : $localBin" -ForegroundColor DarkGray
    } else {
        Remove-Item Env:RUSTC_WRAPPER -ErrorAction SilentlyContinue
        Write-Host '  sccache      : disabled (no vendored binary); cargo runs unwrapped. Install with cargo install sccache --root vendor/sccache to enable.' -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------------------
# Linked git worktrees: share the main checkout's build cache WITHOUT a junction
# ---------------------------------------------------------------------------
# This used to be a `src-tauri\target` junction, and the junction caused two
# separate failures that were both expensive to diagnose:
#
#   1. `tauri dev` watches `src-tauri` for source changes. Through the junction it
#      saw `src-tauri\target\debug` change and announced "File ... changed.
#      Rebuilding application..." - a rebuild triggered by the previous rebuild.
#   2. Two overlapping cargo runs in that one directory collided inside link.exe
#      ("error finalizing incremental compilation session directory: access
#      denied", then "link.exe returned an unexpected error").
#
# Setting CARGO_TARGET_DIR keeps the same cache sharing (nothing recompiles) while
# `src-tauri` contains no build output for the watcher to trip over.
if ($PSScriptRoot) {
    $dotGit = Join-Path $PSScriptRoot '.git'
    # `.git` is a FILE only in a linked worktree; in the main checkout it is a directory.
    if (Test-Path -LiteralPath $dotGit -PathType Leaf) {
        $raw = (Get-Content -LiteralPath $dotGit -Raw) -replace '^gitdir:\s*', ''
        $admin = $raw.Trim().Replace('/', '\').TrimEnd('\')
        # <main>\.git\worktrees\<name> -> up three levels is <main>
        $mainRoot = Split-Path -Path (Split-Path -Path (Split-Path -Path $admin -Parent) -Parent) -Parent
        $shared = Join-Path $mainRoot 'src-tauri\target'
        if ((Test-Path -LiteralPath $shared) -and [string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
            $env:CARGO_TARGET_DIR = $shared
            Write-Host "  CARGO_TARGET_DIR : $shared (linked worktree, shared cache, no junction)" -ForegroundColor DarkGray
        }
    }
}
