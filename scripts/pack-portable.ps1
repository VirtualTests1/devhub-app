# Assembles the portable ZIP from a release build.
#
# Nothing here is invented: every file placed in the package is either built by
# cargo, authored in this repository, or a Microsoft-signed installer whose
# signature is verified before it is included. The script fails rather than
# shipping an unverified binary.
#
# Layout produced:
#   DevHub-<version>-portable\
#     devhub-app.exe                      the app
#     启动 DevHub.bat                      launcher (checks WebView2)
#     使用说明.md / README.txt            user documentation
#     MicrosoftEdgeWebview2Setup.exe      Microsoft-signed bootstrapper
#
# Note: git is NOT bundled. Tauri/DevHub bootstraps a portable git into
# runtime\git on first use (measured: 57 MB download, ~400 MB on disk), which
# keeps this package small and always current.
#
# USAGE
#   pwsh -NoProfile -File scripts/pack-portable.ps1                     # full package
#   pwsh -NoProfile -File scripts/pack-portable.ps1 -CheckProbeOnly     # guard only, exit 0/1
#
# Run it with pwsh (PowerShell 7), not Windows PowerShell 5.1: this file is UTF-8
# without a BOM and carries Chinese literals, and 5.1 decodes it as the ANSI code
# page, which breaks the tokenizer on line `Write-Host "  签名有效，签名者 $(…)"`
# (measured: ParserError "字符串缺少终止符" before any of the script runs). No
# scripts/*.ps1 in this repo carries a BOM, so pwsh is the supported interpreter.

param(
    # Defaults to the version in package.json rather than a literal. A hard-coded
    # '0.1.0' default meant forgetting -Version produced a correctly built 0.3.0
    # exe inside a folder named DevHub-0.1.0-portable - the same drift that made
    # the app introduce itself to GitHub as DevHub/0.1.
    [string]$Version = '',
    [switch]$SkipWebView2,
    # Run ONLY the verification-probe guard below and exit. The guard is the step
    # that must never be skipped, and until now it could only be exercised by
    # running a whole release packaging, which needs a cargo-built binary - so in
    # practice nobody ran it, which is exactly how it stayed decorative for a
    # round. `scripts/pack-portable.ps1 -CheckProbeOnly` is the checkable form.
    [switch]$CheckProbeOnly,
    # Skip the CycloneDX BOM step (3b). The BOM is generated from `pnpm-lock.yaml` +
    # `src-tauri/Cargo.lock` + `node_modules`, so a machine that has the binary but not an
    # installed dependency tree uses this. It is a warning path, never a silent one.
    [switch]$NoSbom
)

# An unrecognised -Switch is NOT rejected when a script is started with `-File`:
# measured on this machine, `pack-portable.ps1 -CheckProbeOnlyy` put the typo in
# `$args`, bound nothing, and carried on to run the REAL packaging path. A release
# script that silently ignores a mistyped flag is a release script that does the
# wrong thing with a clean console, so anything left over is an error.
if ($args.Count -gt 0) {
    throw ("unknown argument(s): {0}. Parameters are -Version, -SkipWebView2, -CheckProbeOnly, -NoSbom." -f ($args -join ' '))
}

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here

# --- Guard: never package a verification probe ------------------------------
#
# The acceptance checks work by temporarily replacing `src/main.tsx` with a probe
# that renders over the app (scripts/verify-ui.ps1:41-43), building, then restoring
# the real entry point. If a release build is produced while a probe is in place -
# or a swap that crashed and never restored - the probe gets packaged and the
# shipped "app" is a test harness. That happened once; this guard makes it
# impossible to repeat, and it checks both the frontend source and the built
# bundle. It runs before anything else, and before the version/build preconditions,
# because "is this even the real app" outranks "which version is it".
#
# Round 15 (d10): the markers are no longer hard-coded here. This guard used to grep
# a fixed list ('SKIN RESULT', 'ACCEPTANCE RESULT', 'RESULT PASS', 'data-case=') and
# ALL FOUR matched nothing - three probes were gone and the real verdict line is a
# template literal (`RESULT ${… ? "PASS" : "FAIL"}`), so the contiguous 'RESULT PASS'
# never exists in source or bundle. Measured hits: 0. A guard that detects nothing
# is worse than none: it reads as coverage.
#
# The fix is a registry (scripts/verify/probe-markers.json) AND a cross-check, and
# the cross-check is the part that keeps the registry from rotting the same way:
# every probe under scripts/verify/*.tsx must declare
#     const DEVHUB_PROBE_MARKER = "<literal>";
# and that literal must be present in the registry. So a new probe that nobody
# registered is a hard stop rather than an unguarded release, and a probe whose
# emitted literal was renamed under the registry's nose is a hard stop too. The
# markers themselves must be plain string literals that survive minification - a
# comment-only marker protects src/main.tsx but not dist/assets/*.js.
$mainTsx = Join-Path $app 'src\main.tsx'
$markerFile = Join-Path $here 'verify\probe-markers.json'
$verifyDir = Join-Path $here 'verify'

if (-not (Test-Path -LiteralPath $markerFile)) {
    throw "probe-marker registry missing at scripts/verify/probe-markers.json - the packager cannot tell a verification probe from the real app. Refusing to package."
}
$registry = $null
try {
    $registry = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
} catch {
    throw "probe-marker registry scripts/verify/probe-markers.json is not valid JSON: $($_.Exception.Message)"
}
$markers = @($registry.markers)
if ($null -eq $registry.markers) {
    throw "probe-marker registry has no 'markers' array - refusing to package."
}
if (-not $markers -or $markers.Count -eq 0) {
    throw "probe-marker registry is empty - every verification probe must register a marker there before a release is packaged. Refusing to package."
}

# Cross-check the probes against the registry (unregistered probe == no guard).
$probeFiles = @(Get-ChildItem -LiteralPath $verifyDir -Filter '*.tsx' -ErrorAction SilentlyContinue)
foreach ($p in $probeFiles) {
    $body = Get-Content -LiteralPath $p.FullName -Raw
    $decl = [regex]::Match($body, 'DEVHUB_PROBE_MARKER\s*=\s*[''"]([^''"]+)[''"]')
    if (-not $decl.Success) {
        throw "scripts/verify/$($p.Name) is a verification probe but declares no DEVHUB_PROBE_MARKER literal, so the packager cannot detect it. Register it before packaging."
    }
    if ($markers -notcontains $decl.Groups[1].Value) {
        throw "scripts/verify/$($p.Name) emits marker '$($decl.Groups[1].Value)' which is NOT in scripts/verify/probe-markers.json - a release built with that probe in place would pass this guard. Add it to the registry."
    }
}

# Scan the entry point and the built bundle for any registered marker.
$distJs = @(Get-ChildItem -LiteralPath (Join-Path $app 'dist\assets') -Filter '*.js' -ErrorAction SilentlyContinue)
$hits = @()
foreach ($probe in $markers) {
    if ([string]::IsNullOrWhiteSpace($probe)) {
        throw "probe-marker registry contains an empty marker - refusing to package on a marker that matches everything."
    }
    if ((Test-Path $mainTsx) -and (Select-String -LiteralPath $mainTsx -SimpleMatch $probe -Quiet)) {
        throw "src\main.tsx looks like a verification probe (contains '$probe'). Restore the real entry point before building a release."
    }
    foreach ($f in $distJs) {
        if (Select-String -LiteralPath $f.FullName -SimpleMatch $probe -Quiet) {
            throw "Built bundle $($f.Name) contains the verification probe '$probe'. Run a clean 'pnpm build' before packaging."
        }
    }
}
$backup = Join-Path $app 'src\main.acceptance-backup.tsx'
if (Test-Path -LiteralPath $backup) {
    throw "src\main.acceptance-backup.tsx exists: a probe swap (scripts/verify-ui.ps1) did not finish restoring src\main.tsx. Restore it before packaging."
}

# Every registered marker must be emitted by some probe in this tree, or it is a
# marker that guards nothing (the old four-string failure, one layer down). Dead
# entries are reported, not fatal: they cost no coverage the probes still declare.
$dead = @($markers | Where-Object {
    $m = [string]$_
    -not ($probeFiles | Where-Object { (Get-Content -LiteralPath $_.FullName -Raw) -like "*`"$m`"*" })
})

if ($CheckProbeOnly) {
    Write-Output "PROBE GUARD  markers   = $($markers.Count) registered ($($markers -join ', '))"
    Write-Output "PROBE GUARD  probes    = $(@($probeFiles | ForEach-Object { $_.Name }) -join ', ')"
    Write-Output "PROBE GUARD  main.tsx  = $(if (Test-Path $mainTsx) { 'scanned, no marker' } else { 'ABSENT - not scanned' })"
    Write-Output "PROBE GUARD  bundle    = $($distJs.Count) dist/assets/*.js scanned, no marker"
    if ($distJs.Count -eq 0) {
        Write-Output "PROBE GUARD  NOTE      no built bundle present; only src\main.tsx was verified."
    }
    if ($dead.Count -gt 0) {
        Write-Output "PROBE GUARD  NOTE      $($dead.Count) registered marker(s) are not emitted by any probe under scripts\verify: $($dead -join ', ')"
    }
    Write-Output 'PROBE GUARD  PASS'
    exit 0
}
Write-Output "PROBE GUARD  OK: $($markers.Count) marker(s) scanned against src\main.tsx and $($distJs.Count) bundle file(s)."
if ($dead.Count -gt 0) {
    Write-Output "PROBE GUARD  NOTE  marker(s) not emitted by any probe in scripts\verify: $($dead -join ', ')"
}

if (-not $Version) {
    $pkg = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
    $Version = $pkg.version
    if (-not $Version) { throw 'package.json has no version to fall back on; pass -Version explicitly.' }
    Write-Output "VERSION  = $Version (from package.json)"
}
# Launcher, docs and the vendored WebView2 installer live under portable\.
$portable = Join-Path $app 'portable'
$bin = Join-Path $app 'src-tauri\target\release\devhub-app.exe'

if (-not (Test-Path $bin)) {
    throw "release binary not found. Build it first:`n  . .\env.ps1`n  pnpm tauri build --no-bundle"
}

$name = "DevHub-$Version-portable"
$stage = Join-Path $app '.pack'
$out = Join-Path $stage $name
# Clean only this build's own outputs. Wiping the whole `.pack` staged directory
# deleted every other package in it - so building the design-preview ZIP silently
# removed the normal release ZIP.
Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $stage "$name.zip") -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $out -Force | Out-Null

Write-Host '=== 1. 复制程序本体 ===' -ForegroundColor Cyan
Copy-Item $bin (Join-Path $out 'devhub-app.exe')
$exeSize = [math]::Round((Get-Item (Join-Path $out 'devhub-app.exe')).Length / 1MB, 2)
Write-Host "  devhub-app.exe  $exeSize MB"

Write-Host '=== 2. 复制启动脚本与文档 ===' -ForegroundColor Cyan
Copy-Item (Join-Path $portable '启动 DevHub.bat') $out
Copy-Item (Join-Path $portable '使用说明.md') $out
# A .txt copy so the README is readable even without a Markdown viewer.
$doc = Get-Content -LiteralPath (Join-Path $portable '使用说明.md') -Raw
Set-Content -LiteralPath (Join-Path $out 'README.txt') -Value $doc -Encoding utf8

Write-Host '=== 3. 校验并附带 WebView2 安装程序 ===' -ForegroundColor Cyan
$boot = Join-Path $portable 'MicrosoftEdgeWebview2Setup.exe'
if ($SkipWebView2) {
    Write-Warning '  已跳过（-SkipWebView2）：目标机器必须自带 WebView2 运行时'
} elseif (-not (Test-Path $boot)) {
    Write-Warning '  未找到 MicrosoftEdgeWebview2Setup.exe；目标机器必须自带 WebView2'
    Write-Warning '  获取方式见 使用说明.md'
} else {
    $sig = Get-AuthenticodeSignature $boot
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
        throw "WebView2 安装程序签名无效（状态=$($sig.Status)，签名者=$($sig.SignerCertificate.Subject)）。拒绝打包。"
    }
    Copy-Item $boot $out
    Write-Host "  签名有效，签名者 $($sig.SignerCertificate.Subject -replace '^CN=([^,]+).*','$1')"
    Write-Host "  MicrosoftEdgeWebview2Setup.exe  $([math]::Round((Get-Item $boot).Length/1KB,0)) KB"
}

Write-Host '=== 3b. 生成 CycloneDX 物料清单 ===' -ForegroundColor Cyan
# bom.json lands in $out, and step 4 zips (Join-Path $out '*') — so the BOM ships without any
# change to the archive logic. Failure is a warning, not an abort: the machine doing the
# packaging must be able to finish even when node_modules is not in the shape the generator
# reads (round 12's store-wipe is the precedent). The ZIP then has no BOM, and the line below
# says so out loud instead of pretending it does.
if ($NoSbom) {
    Write-Warning '  已跳过（-NoSbom）：本 ZIP 不含 bom.json'
} else {
    Push-Location $app
    try {
        & node (Join-Path $app 'scripts/sbom.mjs') --check --out (Join-Path $out 'bom.json')
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  bom.json  $([math]::Round((Get-Item (Join-Path $out 'bom.json')).Length/1KB,0)) KB（CycloneDX 1.6，见 docs/sbom.md）"
        } else {
            Write-Warning "  SBOM 生成退出码 $LASTEXITCODE — 本 ZIP 不含 bom.json（0=通过 1=不合规 2=无法判定）"
        }
    } catch {
        Write-Warning "  SBOM 生成无法执行：$_ — 本 ZIP 不含 bom.json"
    } finally {
        Pop-Location
    }
}

Write-Host '=== 4. 打包 ZIP ===' -ForegroundColor Cyan
$zip = Join-Path $stage "$name.zip"
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -CompressionLevel Optimal
$zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 2)

Write-Host ''
Write-Host "打包完成: $zip" -ForegroundColor Green
Write-Host "  压缩包 $zipSize MB"
Write-Host "  解压后 $([math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum/1MB,2)) MB"
Write-Host ''
Write-Host '包内文件:' -ForegroundColor Cyan
Get-ChildItem $out -File | ForEach-Object {
    Write-Host ("  {0,9:N2} MB  {1}" -f ($_.Length / 1MB), $_.Name)
}
Write-Host ''
Write-Host "提示：首次运行若下载内置 Git，会额外占用约 400 MB。"
Write-Host "提示：项目默认放在解压位置的 项目\ 下，删除文件夹前请先移走。"

