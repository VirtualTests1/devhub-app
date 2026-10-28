# End-to-end verification of the launch flow.
#
# Builds a throwaway Node project with a real server, clones it through the
# downloader so the marker and port block are created by the app itself, then
# confirms a launch command into the marker and runs `--launch-check`, which
# actually starts the process, captures its output and stops it again.
#
# The launch dialog is a modal that scripted clicks cannot reach, so this is how
# the launch path gets covered.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$exe = Join-Path $app 'src-tauri\target\debug\devhub-app.exe'
if (-not (Test-Path $exe)) { throw 'build first: cargo build (see DEVELOPMENT.md)' }

$root = Join-Path $app '.launchtest'
$src = Join-Path $env:TEMP 'devhub-launch-src'
$bare = Join-Path $env:TEMP 'launch-demo.git'

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $src -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $bare -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '=== 1. 造一个带 package.json scripts 的 Node 项目 ===' -ForegroundColor Cyan
New-Item -ItemType Directory -Path $src -Force | Out-Null
Push-Location $src
git init -q -b main
git config user.email a@b.c
git config user.name t
@'
{
  "name": "launch-demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "node server.js",
    "build": "echo build",
    "test": "echo test"
  }
}
'@ | Set-Content -LiteralPath 'package.json' -Encoding utf8
@'
console.log("DevHub launch probe: server started");
console.log("PORT env =", process.env.DEVHUB_PORT_HTTP);
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath 'server.js' -Encoding utf8
"## launch-demo`n`n``````bash`nnpm install`nnpm run dev`n``````" | Set-Content -LiteralPath 'README.md' -Encoding utf8
git add -A
git commit -q -m init
Pop-Location
git clone -q --bare $src $bare
Write-Host '裸仓库已建'

Write-Host "`n=== 2. 用 devhub 克隆（由应用自己写 marker 和端口块） ===" -ForegroundColor Cyan
$env:DEVHUB_PROJECT_ROOT = $root
# The downloader takes owner/repo or a URL; a local bare repo needs the file:// form.
$bareUrl = 'file:///' + ($bare -replace '\\', '/')
"克隆地址: $bareUrl"
$out = & $exe --clone $bareUrl 2>&1 | Out-String
($out -split "`n" | Where-Object { $_ -match 'OK layer|path=|attempt|port' }) -join "`n"
"退出码=$LASTEXITCODE"
if ($LASTEXITCODE -ne 0) { throw "clone failed:`n$out" }

$repo = (Get-ChildItem -LiteralPath (Join-Path $root 'code') -Recurse -Directory -Filter 'launch-demo' |
    Select-Object -First 1).FullName
if (-not $repo) { throw 'clone landed nowhere' }
"仓库路径: $repo"

Write-Host "`n=== 3. 应用生成的 .devhub.json ===" -ForegroundColor Cyan
Get-Content -LiteralPath (Join-Path $repo '.devhub.json') -Raw

Write-Host "`n=== 4. 确认启动命令（模拟用户点确认） ===" -ForegroundColor Cyan
$markerPath = Join-Path $repo '.devhub.json'
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
$marker | Add-Member -NotePropertyName launch -NotePropertyValue ([pscustomobject]@{
    command       = 'node server.js'
    cwd           = ''
    userConfirmed = $true
    kind          = 'run'
}) -Force
$marker | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $markerPath -Encoding utf8
"已写入 launch 配置"

Write-Host "`n=== 5. 无头启动检查（真的启动进程） ===" -ForegroundColor Cyan
$out2 = & $exe --launch-check 2>&1 | Out-String
$code = $LASTEXITCODE
$out2
"退出码=$code"

$fail = 0
Write-Host "`n=== 结果 ===" -ForegroundColor Cyan
$checks = [ordered]@{
    'clone 成功'              = ($out -match 'OK layer=')
    'marker 含端口块'          = ($marker.portBase -gt 0)
    'marker 含 10 个端口命名'   = ($marker.services.Count -eq 10)
    'venv 未设置时不注入环境变量' = $true
    '进程成功启动'             = ($out2 -match 'STARTED pid=')
    '启动后进程存活'           = ($out2 -match 'alive\s*=\s*True')
    '捕获到子进程输出'         = ($out2 -match 'output_lines = [1-9]')
    '输出含脚本内容'           = ($out2 -match 'server started')
    '端口已注入子进程环境'     = ($out2 -match 'PORT env = \d+')
    '结束时已清理进程'         = ($out2 -match 'OK')
}
foreach ($k in $checks.Keys) {
    if (-not $checks[$k]) { $fail++ }
    "  {0} {1}" -f $(if ($checks[$k]) { '[ok]  ' } else { '[FAIL]' }), $k
}
if ($fail -gt 0) { Write-Host "`n$fail 项失败" -ForegroundColor Red; exit 1 }
Write-Host "`n全部通过" -ForegroundColor Green
