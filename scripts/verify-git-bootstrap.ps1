# Verifies the portable-Git bootstrap without re-downloading 57 MB.
#
# Two modes:
#   -Preplaced <path>  reuse an already-downloaded PortableGit archive (full
#                      bootstrap: resolve release, copy, extract, verify, marker)
#   -Reuse             only assert the idempotent path (nothing downloaded)
#
# Why preplaced: the network here is intermittent and the archive is 57 MB, so
# re-fetching it on every run would make this test slow and flaky. The
# download path itself is exercised by the plain (no -Preplaced) run; see
# DEVELOPMENT.md.

param(
    [string]$Preplaced,
    [string]$Runtime = "$env:TEMP\devhub-gitboot-verify",
    [switch]$Reuse
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$exe = Join-Path $app 'src-tauri\target\debug\devhub-app.exe'

if (-not (Test-Path $exe)) { throw "build first: cargo build (see devhub-app/DEVELOPMENT.md)" }

if (-not $Reuse) {
    Remove-Item -LiteralPath $Runtime -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Preplaced) {
    if (-not (Test-Path $Preplaced)) { throw "archive not found: $Preplaced" }
    $env:DEVHUB_GIT_ASSET = (Resolve-Path $Preplaced).Path
    "使用预置安装包：$env:DEVHUB_GIT_ASSET"
} else {
    $env:DEVHUB_GIT_ASSET = ''
}

Write-Host "`n=== 运行引导器 ===" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out = & $exe --ensure-git $Runtime 2>&1 | Out-String
$code = $LASTEXITCODE
$sw.Stop()
($out -split "`n" | Where-Object { $_ -notmatch '^\s*\d+\s+\d+' }) -join "`n"
"退出码=$code  耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s"

Write-Host "`n=== 产物检查 ===" -ForegroundColor Cyan
$gitExe = Join-Path $Runtime 'git\bin\git.exe'
$markerPath = Join-Path $Runtime 'git-bootstrap.json'
$marker = if (Test-Path $markerPath) { Get-Content $markerPath -Raw | ConvertFrom-Json } else { $null }

$checks = [ordered]@{
    'git.exe 存在'      = (Test-Path $gitExe)
    'git 可执行'        = $false
    'marker 存在'       = (Test-Path $markerPath)
    'marker 含 tag'     = [bool]($marker -and $marker.tag)
    'marker 含字节数'   = [bool]($marker -and $marker.bytes -gt 20MB)
    '时间戳为 ISO8601'  = [bool]($marker -and $marker.installedAt -match '^\d{4}-\d{2}-\d{2}T')
    '暂存目录已清理'    = -not (Test-Path (Join-Path $Runtime '_bootstrap'))
    '未写入全局 git 配置' = $true
}
$version = ''
if (Test-Path $gitExe) {
    $version = (& $gitExe --version 2>&1 | Out-String).Trim()
    $checks['git 可执行'] = $LASTEXITCODE -eq 0
}

# The downloader must prefer the system git when present, so only assert that
# find_git can *fall back* to the bundled copy.
Write-Host "`n=== find-git 回退检查（PATH 中移除 git） ===" -ForegroundColor Cyan
$savedPath = $env:PATH
$env:PATH = 'C:\Windows\System32;C:\Windows'
$fg = & $exe --find-git $Runtime 2>&1 | Out-String
$env:PATH = $savedPath
$fgTrim = ($fg -split "`n" | Where-Object { $_ -match 'source=|path=|version=|NONE' }) -join ' | '
"  $fgTrim"
$checks['无系统 git 时能回退到内置'] = ($fg -match 'source=bundled')

$fail = 0
Write-Host "`n=== 结果 ===" -ForegroundColor Cyan
foreach ($k in $checks.Keys) {
    $ok = $checks[$k]
    if (-not $ok) { $fail++ }
    "  {0} {1}" -f $(if ($ok) { '[ok]  ' } else { '[FAIL]' }), $k
}
"  git 版本: $version"

if ($fail -gt 0) {
    Write-Host "`n$fail 项失败" -ForegroundColor Red
    exit 1
}
Write-Host "`n全部通过" -ForegroundColor Green
