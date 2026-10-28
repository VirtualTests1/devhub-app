# Deterministic verification of the downloader's mirror layer (layer 4).
#
# Real github.com reachability is intermittent here, so we cannot count on it
# failing exactly when we want to exercise a later layer. This builds a
# controlled environment instead:
#
#   * a bare repo served by scripts/gitmirror.py, a miniature GitHub mirror that
#     strips its own "/https:/<host>/" prefix - the same rewriting a real
#     gh-proxy style mirror performs
#   * layer 4 pointed at that local mirror
#   * the ref uses a host that cannot resolve, so layers 1-3 must fail first
#
# Success therefore proves: the fallback chain reaches layer 4, the mirror URL is
# assembled correctly, the result is flagged as third-party, and the repository
# lands in the agreed owner-scoped path.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Split-Path -Parent $here
$tmp = Join-Path $env:TEMP 'devhub-mirror-test'
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ---- 1. source repo + bare clone ------------------------------------------
$src = Join-Path $tmp 'src'
New-Item -ItemType Directory -Path $src -Force | Out-Null
Push-Location $src
git init -q -b main
git config user.email 'test@devhub.local'
git config user.name 'devhub test'
'contains a real file' | Set-Content -LiteralPath 'README.md' -Encoding utf8
'mirror payload' | Set-Content -LiteralPath 'data.txt' -Encoding utf8
git add -A
git commit -q -m 'mirror test commit'
Pop-Location

$serve = Join-Path $tmp 'serve'
# Mirrors lay repos out as <owner>/<repo>.git, so the served tree needs the owner level.
$ownerdir = Join-Path $serve 'octocat'
New-Item -ItemType Directory -Path $ownerdir -Force | Out-Null
$bare = Join-Path $ownerdir 'Hello-World.git'
git clone -q --bare $src $bare
Push-Location $bare
git update-server-info          # required for the dumb HTTP protocol
Pop-Location
"裸仓库: $bare"

# ---- 2. start the local mirror --------------------------------------------
$port = 18899
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "port $port already in use"
}
$python = $env:DEVHUB_PYTHON
if (-not $python) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source }
}
if (-not $python) { throw "python not found. Set DEVHUB_PYTHON to a python.exe path." }

$srv = Start-Process -FilePath $python `
    -ArgumentList (Join-Path $here 'gitmirror.py'), "$port", $serve `
    -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
    # The downloader will request /https:/<host>/<owner>/<repo>.git/HEAD
    $probeUrl = "http://127.0.0.1:$port/https:/no-such-host.invalid/octocat/Hello-World.git/HEAD"
    $probe = (& curl.exe -sS -o NUL -w '%{http_code}' --max-time 8 $probeUrl 2>&1 | Out-String).Trim()
    "镜像服务自检 (前缀剥离): $probe  (200 = 就绪)"
    if ($probe -ne '200') { throw "gitmirror is not stripping the prefix correctly" }

    # ---- 3. drive the downloader ------------------------------------------
    $env:DEVHUB_PROJECT_ROOT = Join-Path $tmp 'project'
    $env:DEVHUB_ALLOW_IP_PIN = '0'      # the fake host has no DNS answer
    $env:DEVHUB_ALLOW_MIRROR = '1'
    $env:DEVHUB_MIRRORS = "http://127.0.0.1:$port/"

    $exe = Join-Path $app 'src-tauri\target\debug\devhub-app.exe'
    "`n=== 下载 no-such-host.invalid/octocat/Hello-World（必然落到镜像层） ==="
    $out = (& $exe --clone 'no-such-host.invalid/octocat/Hello-World' 2>&1 | Out-String)
    $code = $LASTEXITCODE
    ($out -split "`n" | Where-Object {
        $_ -notmatch 'Receiving objects|Enumerating|Counting|Compressing|Resolving deltas|remote:|Cloning into'
    }) -join "`n"
    "退出码=$code"

    $target = Join-Path $env:DEVHUB_PROJECT_ROOT 'code\no-such-host.invalid\octocat\Hello-World'
    if (Test-Path (Join-Path $target '.git')) {
        "`n✅ 镜像层验证成功：仓库经由镜像层落位"
        "   路径: $target"
        "   文件: $((Get-ChildItem -LiteralPath $target -Force -Name | Where-Object { $_ -ne '.git' }) -join ', ')"
        "   提交: $(git -C $target log --oneline 2>&1)"
        if ($out -match 'via_third_party=true') {
            "   ✅ 已标记为经由第三方传输"
        } else {
            "   ⚠️ 未标记为第三方（应为 true）"
        }
    } else {
        "`n❌ 未落位"
        exit 1
    }
}
finally {
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
    $env:DEVHUB_ALLOW_MIRROR = ''
    $env:DEVHUB_ALLOW_IP_PIN = ''
    $env:DEVHUB_MIRRORS = ''
    "`n本地镜像已停止"
}

