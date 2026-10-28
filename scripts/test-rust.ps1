# Honest local entry point for the Rust test suite.
#
# WHY THIS EXISTS
#   CI runs `cargo test --lib` directly (.github/workflows/ci.yml, native job,
#   right after it builds ../dist). Locally that same command fails in the two
#   ways tauri.ps1 already documented:
#     - cargo is often absent from a plain shell's PATH, and the failure mode is
#       PowerShell's "not recognized as the name of a cmdlet" — a message about
#       PowerShell, not about a missing toolchain;
#     - on Windows cargo LINKS against MSVC, which needs env.ps1's
#       INCLUDE/LIB/PATH; forgetting the dot-source fails with the misleading
#       `linker 'link.exe' not found`, which reads like a missing Visual Studio
#       install rather than a missing environment.
#   Both get folded into one `pnpm test:rust`, mirroring how the `tauri` script
#   folds them for `pnpm tauri dev|build`.
#
# DELIBERATELY NOT IN `pnpm gate`
#   The gate must stay runnable on a machine with no Rust toolchain at all — it
#   is the fast JS/docs/lint loop. What the gate pins is the suite SIZE, and
#   statically: check-invariants.mjs's `rust-test-floor` row counts #[test]
#   attributes in src-tauri/src without compiling anything (a drop below the
#   floor is deleted tests, which no amount of "it still compiles" excuses).
#   Only this script — and the CI native job — actually EXECUTE the suite.
#   Adding cargo to the gate would trade "cannot run the fast loop at all" for
#   "cannot run the fast loop", which is the wrong trade.
#
# USAGE
#   pnpm test:rust                    -- cargo test --lib
#   pnpm test:rust -- --nocapture     -- extra arguments reach cargo unchanged
#
# Windows-first, exactly like the `tauri` script in package.json (it also
# invokes powershell -File on every platform; non-Windows here just skips the
# env.ps1 step inside, since MSVC is not in the picture there).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# Checked BEFORE anything else: a missing toolchain is the cheapest, most
# common local failure, and it deserves a message about cargo rather than one
# about PowerShell.
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Output 'test:rust: cargo not found on PATH.'
    Write-Output 'Install the Rust toolchain (https://rustup.rs), open a new shell,'
    Write-Output 'and retry. Nothing in `pnpm gate` needs cargo - this is the only step that does.'
    exit 1
}

# Same environment dance as tauri.ps1: env.ps1 mutates only this process and
# finds the toolset by locating cl.exe on disk (vcvars64.bat is broken on this
# machine; see env.ps1's header for the full evidence trail).
if ($env:OS -eq 'Windows_NT') {
    try {
        . (Join-Path $root 'env.ps1')
    } catch {
        # env.ps1 throws when the MSVC toolset or the Windows SDK is absent.
        # Under `powershell -File` a bare throw would surface as a raw script
        # stack trace; name the failure and the fix instead.
        Write-Output "test:rust: MSVC environment unavailable - $($_.Exception.Message)"
        Write-Output 'The Rust suite cannot link without it. See env.ps1 for how the'
        Write-Output 'toolset and SDK are discovered (it deliberately does not trust vswhere).'
        exit 1
    }
}

# env.ps1 leaves $ErrorActionPreference='Stop' set for its own good reasons, but
# cargo test streams compile progress on stderr, and PowerShell turns a native
# command's stderr into a terminating NativeCommandError under Stop - the same
# reset tauri.ps1 applies before the Tauri CLI, for the same reason.
$ErrorActionPreference = 'Continue'

# Run from src-tauri like a human would: cargo picks up the workspace manifest
# there without a --manifest-path flag that could silently drift from the real
# one. The exit code is captured and Pop-Location is guaranteed, so a failing
# suite still leaves the shell in the caller's directory.
$code = 0
Push-Location (Join-Path $root 'src-tauri')
try {
    cargo test --lib @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $code
