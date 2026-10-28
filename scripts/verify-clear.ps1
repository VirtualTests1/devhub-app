# End-to-end verification of cache clearing and repository deletion.
#
# Creates a repository with realistic artefacts (node_modules, target, dist,
# __pycache__), clones it through the app so the marker and port block are real,
# then exercises the headless clear and delete probes against actual files.
#
# The cleanup UI lives inside the launch dialog, which is a modal that scripted
# clicks cannot reach, so this covers the commands behind it.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$exe = Join-Path $app 'src-tauri\target\debug\devhub-app.exe'
if (-not (Test-Path $exe)) { throw 'build first: cargo build (see DEVELOPMENT.md)' }

$root = Join-Path $app '.cleartest'
$src = Join-Path $env:TEMP 'devhub-clear-src'
$bare = Join-Path $env:TEMP 'clear-demo.git'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $src -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $bare -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '=== 1. 建一个带真实源码的仓库 ===' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $src -Force | Out-Null
Push-Location $src
git init -q -b main
git config user.email a@b.c
git config user.name t
Set-Content -LiteralPath 'README.md' -Value '# clear-demo' -Encoding utf8
New-Item -ItemType Directory -Path 'src' -Force | Out-Null
Set-Content -LiteralPath 'src/main.rs' -Value 'fn main() {}' -Encoding utf8
Set-Content -LiteralPath 'package.json' -Value '{"scripts":{"dev":"node x.js"}}' -Encoding utf8
git add -A
git commit -q -m init
Pop-Location
git clone -q --bare $src $bare

Write-Host '=== 2. 克隆（由应用写 marker 与端口块） ===' -ForegroundColor Cyan
$env:DEVHUB_PROJECT_ROOT = $root
$bareUrl = 'file:///' + ($bare -replace '\\', '/')
$out = & $exe --clone $bareUrl 2>&1 | Out-String
"退出码=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { throw "clone failed:`n$out" }

$repo = (Get-ChildItem -LiteralPath (Join-Path $root 'code') -Recurse -Directory -Filter 'clear-demo' |
    Select-Object -First 1).FullName
if (-not $repo) { throw 'repository not found after clone' }
# The slug is the path relative to <root>/code, e.g. "local/temp/clear-demo".
$slug = $repo.Substring((Join-Path $root 'code').Length).TrimStart('\', '/') -replace '\\', '/'
"仓库: $repo"
"slug: $slug"

Write-Host "`n=== 3. 造出各类缓存产物（用真实字节数） ===" -ForegroundColor Cyan
# Sizes chosen to be distinctive so the arithmetic can be checked.
$layout = @(
    @{ rel = 'node_modules/pkg/index.js'; bytes = 2MB; label = 'Node 依赖' },
    @{ rel = 'target/debug/app.exe';      bytes = 3MB; label = 'Rust 构建产物' },
    @{ rel = 'dist/bundle.js';            bytes = 1MB; label = '构建输出' },
    @{ rel = '__pycache__/x.pyc';         bytes = 512KB; label = 'Python 字节码' }
)
foreach ($item in $layout) {
    $p = Join-Path $repo $item.rel
    New-Item -ItemType Directory -Path (Split-Path $p -Parent) -Force | Out-Null
    $fs = [System.IO.File]::Create($p)
    $fs.SetLength($item.bytes)
    $fs.Close()
}
$expectedFree = ($layout | Measure-Object -Property bytes -Sum).Sum
"预期可释放: $([math]::Round($expectedFree/1MB,2)) MB"

Write-Host "`n=== 4. 扫描 + 清理（headless clear-check） ===" -ForegroundColor Cyan
$clear = & $exe --clear-check $slug 2>&1 | Out-String
$clearCode = $LASTEXITCODE
$clear
"退出码=$clearCode"

Write-Host "=== 5. 删除（headless delete-check） ===" -ForegroundColor Cyan
$del = & $exe --delete-check $slug 2>&1 | Out-String
$delCode = $LASTEXITCODE
$del
"退出码=$delCode"

$fail = 0
Write-Host '=== 结果 ===' -ForegroundColor Cyan
$checks = [ordered]@{
    '克隆成功'                  = ($out -match 'OK layer=')
    '扫描识别出 4 类产物'        = (($clear -split "`n" | Where-Object { $_ -match '^items = ' }) -join '') -match 'items = 4'
    '释放字节数准确'             = ($clear -match "freed_bytes = $expectedFree")
    'node_modules 已删除'       = -not (Test-Path (Join-Path $repo 'node_modules'))
    'target 已删除'             = -not (Test-Path (Join-Path $repo 'target'))
    'dist 已删除'               = -not (Test-Path (Join-Path $repo 'dist'))
    '__pycache__ 已删除'        = -not (Test-Path (Join-Path $repo '__pycache__'))
    '.git 未被破坏'             = ($clear -match 'git_intact = true')
    '清理后无残留缓存'           = ($clear -match 'remaining_bytes = 0')
    '清理未报失败'               = -not ($clear -match 'FAILED')
    '删除成功'                  = ($del -match 'removed_repo = true')
    '删除后不再被列出'           = ($del -match 'still_listed = false')
    '仓库目录已消失'             = -not (Test-Path $repo)
    '删除退出码为 0'             = ($delCode -eq 0)
}
foreach ($k in $checks.Keys) {
    if (-not $checks[$k]) { $fail++ }
    "  {0} {1}" -f $(if ($checks[$k]) { '[ok]  ' } else { '[FAIL]' }), $k
}
if ($fail -gt 0) { Write-Host "`n$fail 项失败" -ForegroundColor Red; exit 1 }
Write-Host "`n全部通过" -ForegroundColor Green
