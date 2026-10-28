# Wraps the Tauri CLI so the MSVC build environment is always set up.
#
# WHY
#   `pnpm tauri dev` / `pnpm tauri build` call cargo, and on this machine cargo
#   cannot link unless INCLUDE/LIB/PATH point at the MSVC toolset. See env.ps1
#   for why `vcvars64.bat` cannot be used here.
#
#   Forgetting to dot-source env.ps1 fails with the misleading
#       error: linker `link.exe` not found
#   which reads like a missing Visual Studio install rather than a missing
#   environment. So the setup moves into the command itself and cannot be
#   forgotten.
#
# USAGE
#   pnpm tauri dev      -- the `tauri` script in package.json points here
#   pnpm tauri build
#
# Any arguments are forwarded to the CLI unchanged.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# `dev` is the one subcommand that can waste a full Rust compile on a port that
# was never free: vite runs as the *beforeDevCommand*, so it fails after cargo has
# already built, leaving a window pointed at ERR_CONNECTION_REFUSED. Ask the
# question first, and answer it with the PID rather than with a rebuild log.
# Set DEVHUB_SKIP_PORT_GUARD=1 to opt out (a CI runner that owns the port check).
if ($args.Count -gt 0 -and $args[0] -eq 'dev' -and -not $env:DEVHUB_SKIP_PORT_GUARD) {
    $guard = Join-Path $PSScriptRoot 'port-guard.ps1'
    if (Test-Path -LiteralPath $guard) {
        # Same reason it is reset further down: a native command's stderr is a
        # terminating error under Stop, and the guard is a native command.
        $ErrorActionPreference = 'Continue'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $guard
        $guardExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($guardExit -eq 1) {
            Write-Output ''
            Write-Output 'dev aborted before compiling. Clear the port, or re-run with'
            Write-Output '  $env:DEVHUB_SKIP_PORT_GUARD=1'
            Write-Output 'if you are certain the holder is meant to be there.'
            exit $guardExit
        } elseif ($guardExit -ne 0) {
            # exit 2 = could not tell. That is NOT "free": proceeding would spend a
            # full cargo compile on a port whose state the guard never confirmed,
            # which is the exact failure this wrapper exists to prevent. Do not
            # assume; hand it back to the human (the guard printed how to check).
            Write-Output ''
            Write-Output 'dev aborted: the port guard could not determine whether the port is free.'
            Write-Output 'Verify it yourself (the messages above show how), then re-run, or set'
            Write-Output '  $env:DEVHUB_SKIP_PORT_GUARD=1'
            Write-Output 'only if you are certain the port is available.'
            exit $guardExit
        }
    }
}

# Non-Windows has no env.ps1 to source; hand straight over to the CLI.
if ($env:OS -ne 'Windows_NT') {
    & (Join-Path $root 'node_modules/.bin/tauri') @args
    exit $LASTEXITCODE
}

# Safe to call repeatedly: only mutates this process, and picks the toolset by
# finding cl.exe on disk rather than trusting vswhere.
. (Join-Path $root 'env.ps1')

# env.ps1 sets $ErrorActionPreference='Stop' for its own good reasons, but the
# Tauri CLI streams progress on stderr, and PowerShell turns a native command's
# stderr into a terminating NativeCommandError under Stop. Reset it here or
# `pnpm tauri build` dies in the middle of a compile that was going fine.
$ErrorActionPreference = 'Continue'

$cli = Join-Path $root 'node_modules/.bin/tauri.cmd'
if (-not (Test-Path -LiteralPath $cli)) {
    # Fall back to resolution through the package manager if the shim is gone.
    & pnpm exec tauri @args
    exit $LASTEXITCODE
}

& $cli @args
exit $LASTEXITCODE
