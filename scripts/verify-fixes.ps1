# End-to-end verification of the reported fixes, against the running app.
#
# WHY THIS EXISTS
#   Screenshots were this project's only visual evidence and they were not
#   reliable (identical hashes for different builds, dropped regions, unsynthesised
#   frames). Each fix therefore has a scenario in scripts/scenarios/ that drives the
#   real WebView2 over the Chrome DevTools Protocol and asserts on real DOM state,
#   real timing and real filesystem results. See scripts/cdp.mjs.
#
# USAGE
#   # against an app already running with the debug port (see -Start for how)
#   pwsh -NoProfile -File scripts/verify-fixes.ps1
#
#   # start the app, run everything, tear it down
#   pwsh -NoProfile -File scripts/verify-fixes.ps1 -Start
#
# The app must be started with:
#   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
#   DEVHUB_PROJECT_ROOT=<repo>\.cdpfixtures
# `-Start` does both.

param(
    [switch]$Start,
    [string]$Port = '9222',
    [string]$Only,
    # Build the fixture root and stop. Useful when driving the app some other way (a
    # logged dev run, for instance) and still needing the same repositories the
    # scenarios expect - without this, preparing fixtures meant starting the whole
    # harness.
    [switch]$FixturesOnly,
    # Scenarios that clone from github.com. Reachability from this machine is
    # intermittent (measured during this round: `api.github.com` 200 in 0.4 s while
    # `github.com:443` timed out), so they are opt-in and the network-free
    # equivalent (`local-download`) runs by default.
    [switch]$Network,
    # Leave the container exactly as the previous scenario left it. Useful when
    # reproducing something by hand and you do not want the wall reset underneath.
    [switch]$NoFixtureReset,
    # How long `-Start` may take to bring the app up, in 3-second polls (default 400
    # = 20 minutes). A debug build of this crate measured 5–17 min on this machine
    # when several worktrees shared the build directory; 6 minutes was not enough, and
    # running the scenarios anyway is what turned "app not up" into 24 fake failures.
    [int]$DevWaitSeconds = 400
)

# Node writes UTF-8; the console on this machine defaults to codepage 936, and
# PowerShell decodes a child process's stdout with the *output* encoding. Every
# scenario whose report carries Chinese labels therefore arrived mangled — and a
# mangled string can swallow its own closing quote, so ConvertFrom-Json threw and
# the runner reported "UNPARSEABLE" for a scenario that had actually printed a
# verdict. Reading stdout as UTF-8 is the whole fix.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$fixtures = Join-Path $app '.cdpfixtures'
$scenarios = Join-Path $app 'scripts\scenarios'
$results = Join-Path $app '.shots'
New-Item -ItemType Directory -Path $results -Force | Out-Null

function Get-Fixtures {
    <#
      Fixture project root with BOTH layouts, because repositories already
      downloaded by 0.2.0 must keep working after the layout change:
        - <repo>_<owner>                      (current)
        - code/<host>/<owner>/<repo>           (legacy)
    #>
    $root = $fixtures
    if (Test-Path $root) { Remove-Item -Recurse -Force $root }
    $flat = Join-Path $root 'opus-video-prompts_joeseesun'
    New-Item -ItemType Directory -Force -Path (Join-Path $flat '.git') | Out-Null
    Set-Content -Path (Join-Path $flat 'README.md') -Value '# opus video prompts'
    '{"slug":"github.com/joeseesun/opus-video-prompts","url":"https://github.com/joeseesun/opus-video-prompts.git","clonedAt":"2026-10-04T10:35:09+08:00","portBase":20000,"services":[["http",20000],["api",20001]]}' |
        Set-Content -Path (Join-Path $flat '.devhub.json')

    $legacy = Join-Path $root 'code\github.com\alice\tool'
    New-Item -ItemType Directory -Force -Path (Join-Path $legacy '.git') | Out-Null
    '{"slug":"github.com/alice/tool","url":"https://github.com/alice/tool.git","clonedAt":"2026-10-03T19:40:00+08:00","portBase":20010,"services":[["http",20010]]}' |
        Set-Content -Path (Join-Path $legacy '.devhub.json')

    # A repository the 启动面板 can genuinely start: package.json with a dev script, a
    # server that binds the port DevHub injects, and its own marker. Six scenarios
    # click `testowner/zfixture` (`running-launch`, `running-controls`,
    # `running-float`, `stop-tree`, `drag-while-running`, `alias-typing` …) and
    # nothing used to create it - it was built by hand once, so after the next
    # `-Start` wiped `.cdpfixtures` those scenarios quietly had no fixture to find.
    $zfix = Join-Path $root 'testowner_zfixture'
    New-Item -ItemType Directory -Force -Path (Join-Path $zfix '.git') | Out-Null
    '{"name":"zfixture","private":true,"version":"1.0.0","scripts":{"dev":"node server.js"}}' |
        Set-Content -Path (Join-Path $zfix 'package.json')
    'const http = require("node:http");' + "`n" +
    'const port = Number(process.env.DEVHUB_PORT_HTTP || 20900);' + "`n" +
    'http.createServer((req, res) => { res.writeHead(200); res.end("zfixture\n"); })' + "`n" +
    '  .listen(port, () => console.log("zfixture listening on " + port));' |
        Set-Content -Path (Join-Path $zfix 'server.js')
    '{"slug":"github.com/testowner/zfixture","url":"https://github.com/testowner/zfixture.git","clonedAt":"2026-10-11T09:00:00+08:00","portBase":20900,"services":[["http",20900]]}' |
        Set-Content -Path (Join-Path $zfix '.devhub.json')

    # A venv-shaped directory for the 项目设置 → 虚拟环境 row: the row refuses anything
    # that does not look like an environment, so the accept path needs one that does.
    # `venvs/<repo>_<owner>` is the app's own layout, and `venvs` is a reserved name the
    # container walk never treats as a repository.
    $venv = Join-Path $root 'venvs\testowner_zfixture'
    New-Item -ItemType Directory -Force -Path $venv | Out-Null
    'home = D:\python' + "`n" + 'version = 3.11.4' | Set-Content -Path (Join-Path $venv 'pyvenv.cfg')

    Write-Host "固定夹具: $root" -ForegroundColor DarkGray
}

if ($FixturesOnly) {
    Get-Fixtures
    exit 0
}

$started = $null
if ($Start) {
    Get-Fixtures
    Get-Process -Name 'devhub-app' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -like "$app*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $env:DEVHUB_PROJECT_ROOT = $fixtures
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    . (Join-Path $app 'env.ps1') | Out-Null
    Write-Host '启动 tauri dev（CDP 已开启）…' -ForegroundColor Cyan
    $started = Start-Process -FilePath 'pwsh' -PassThru -WindowStyle Hidden -ArgumentList `
        '-NoProfile', '-Command', "Set-Location '$app'; pnpm tauri dev"
    # Wait for the debug port to answer. This must be generous: `-Start` builds the app
    # with `pnpm tauri dev`, and a debug link of this crate measured 5–17 minutes on this
    # machine today (more while several worktrees shared the build directory).
    #
    # The old loop waited 120 × 3 s = 6 min and then ran the scenarios ANYWAY. Every
    # scenario then died in ~0.3 s with `connect ECONNREFUSED 127.0.0.1:9222`, and the
    # summary printed 24 rows of UNPARSEABLE — which reads as "24 fixes regressed"
    # when the truth is "the app never started". A harness that cannot tell those two
    # apart is worse than no harness: it manufactures the exact false failures this
    # file's header comment says it exists to eliminate.
    $ready = $false
    for ($i = 0; $i -lt $DevWaitSeconds; $i++) {
        Start-Sleep -Seconds 3
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 2 | Out-Null
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) {
        Write-Host "`n失败：$Port 上的 CDP 端点在 $($DevWaitSeconds * 3) 秒内没有应答。" -ForegroundColor Red
        Write-Host '场景一个都没有跑 —— 下面这份空表不是「改动坏了」，是应用没起来。' -ForegroundColor Red
        Write-Host ("排查顺序：pnpm tauri dev 是否还在编译（Get-Process rustc）、src-tauri\target 的构建锁" +
            "是否被其它 worktree 占住（env.ps1:116-142）、以及 http://127.0.0.1:$Port/json 现在能否手工打开。") -ForegroundColor DarkGray
        if ($started -and -not $started.HasExited) {
            # This is a hard-exit path (exit 2 happens BEFORE the try/finally below), and
            # killing only the wrapper leaves pnpm → tauri CLI → vite + rustc alive.
            # Measured 2026-10-17: after a wait-timeout fired here, vite still held 1420
            # and an orphaned rustc was still mid-compile with nobody reading its stdout —
            # exactly the leak the finally's comment below describes, on the other route
            # out. Same tree model: taskkill /T first, wrapper as the second pass.
            $ErrorActionPreference = 'Continue'
            taskkill /T /F /PID $started.Id 2>&1 | Out-Null
            Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
            $ErrorActionPreference = 'Stop'
            Write-Host '已关闭 dev 进程树（等待超时路径：taskkill /T /F + Stop-Process）' -ForegroundColor DarkGray
        }
        # Non-zero, and before any scenario runs: the point is that a missing app is
        # an infrastructure result, not a table full of per-fix failures.
        exit 2
    }
    Start-Sleep -Seconds 3
}

# --- UAC / console-window watch ---------------------------------------------
# Item 5 asked for no UAC elevation and no terminal windows. `consent.exe` running
# is the only in-band evidence that an elevation prompt appeared; the UAC event log
# records creations that *failed* with ERROR_ELEVATION_REQUIRED.
$script:consentSeen = @()
$script:uacEventsBefore = @()
try {
    $script:uacEventsBefore = @(Get-WinEvent -LogName 'Microsoft-Windows-UAC/Operational' -MaxEvents 5 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty TimeCreated)
} catch { }

# --- everything from the watcher onward is inside a try/finally ---------------
# Teardown has to be on EVERY path, not just the happy one. The Start-Job watcher
# and, under `-Start`, the `pnpm tauri dev` process tree both outlive the script if
# a scenario throws under `$ErrorActionPreference = 'Stop'`; the finally below is
# what makes that impossible. (Rationale repeated at the finally.)
$watch = $null
try {
$watch = Start-Job -ScriptBlock {
    $sightings = @()
    for ($i = 0; $i -lt 900; $i++) {
        $p = Get-Process -Name 'consent' -ErrorAction SilentlyContinue
        if ($p) { $sightings += (Get-Date).ToString('HH:mm:ss') }
        Start-Sleep -Milliseconds 500
    }
    $sightings
}

$scenarioFiles = Get-ChildItem -Path $scenarios -Filter '*.mjs' | Where-Object {
    $_.BaseName -notlike 'debug-*' -and $_.BaseName -ne 'smoke'
} | Sort-Object Name
if (-not $Network) {
    $scenarioFiles = $scenarioFiles | Where-Object { $_.BaseName -notin @('download', 'download-wait') }
}
if ($Only) {
    # Comma-separated: re-checking one stale scenario usually means re-checking the
    # handful that share the navigation or the setting it measures, and each of those
    # costs a full app start otherwise.
    $wanted = $Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $available = ($scenarioFiles.BaseName)
    $scenarioFiles = $scenarioFiles | Where-Object { $wanted -contains $_.BaseName }
    $missing = $wanted | Where-Object { $scenarioFiles.BaseName -notcontains $_ }
    if ($missing) {
        # A typo'd -Only used to only WARN, then run the (now empty) set and print
        # "通过 0 / 未通过 0 / 共 0" and exit 0 — a green "everything passed" for a run
        # that verified nothing. A name that matches no scenario is a caller error, so
        # stop here with the list that WAS available rather than a false all-clear.
        Write-Host ("错误：-Only 指定的场景不存在：" + ($missing -join ', ')) -ForegroundColor Red
        Write-Host ("可用场景：" + (($available | Sort-Object) -join ', ')) -ForegroundColor DarkGray
        exit 1
    }
}

# Download targets must not exist, or DevHub refuses the download as a conflict —
# and the tile index must not carry a repository left behind by an earlier scenario.
# Both are per-scenario, not per-run: `local-download` recreates these directories,
# and every later scenario that counts positions would then be off by one.
function Clear-DownloadTargets {
    foreach ($stale in 'RuiC-motion-reel_HRuiCcc', 'Hello-World_octocat') {
        $p = Join-Path $fixtures $stale
        if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
    }
}

$settle = Join-Path $app 'scripts\scenarios\debug-settle-wall.mjs'

$summary = @()
$runStart = Get-Date
foreach ($f in $scenarioFiles) {
    Write-Host "`n=== $($f.BaseName) ===" -ForegroundColor Cyan
    if (-not $NoFixtureReset) {
        Clear-DownloadTargets
        # Wait for the wall to match the disk before measuring anything, so a
        # scenario never runs against a half-scanned container.
        & node (Join-Path $app 'scripts\cdp.mjs') $settle --port $Port *> (Join-Path $results 'settle.log')
    }
    $log = Join-Path $results "cdp-$($f.BaseName).log"
    $json = Join-Path $results "cdp-$($f.BaseName).json"
    # The page is reloaded first: frontend edits under a long-running dev server are
    # otherwise not guaranteed to be in the bundle being driven.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & node (Join-Path $app 'scripts\cdp.mjs') $f.FullName --port $Port --reload *> $log
    $code = $LASTEXITCODE
    $sw.Stop()
    $ms = [int]$sw.Elapsed.TotalMilliseconds
    $raw = Get-Content -Raw $log -ErrorAction SilentlyContinue
    $body = ($raw -split "`n" | Where-Object { $_ -notmatch '^\[cdp\]' }) -join "`n"
    try {
        $parsed = $body | ConvertFrom-Json
        $body | Set-Content -Path $json
        # A scenario that returns evidence without a verdict used to print an
        # empty cell, which reads the same as "not run". Say which one it is.
        $verdict = if ($null -ne $parsed.PSObject.Properties['verdict']) { $parsed.verdict } else { 'NO-VERDICT' }
        $summary += [pscustomobject]@{ Scenario = $f.BaseName; Verdict = $verdict; Exit = $code; Ms = $ms }
        $color = if ($verdict -eq 'PASS') { 'Green' } else { 'Yellow' }
        Write-Host "verdict: $verdict ($([math]::Round($ms / 1000, 1))s)" -ForegroundColor $color
        $body
    } catch {
        $summary += [pscustomobject]@{ Scenario = $f.BaseName; Verdict = 'UNPARSEABLE'; Exit = $code; Ms = $ms }
        Write-Warning "无法解析结果（$([math]::Round($ms / 1000, 1))s），原始输出："
        $raw
    }
}

Stop-Job $watch -ErrorAction SilentlyContinue
$consent = Receive-Job $watch -ErrorAction SilentlyContinue
Remove-Job $watch -Force -ErrorAction SilentlyContinue
# Cleared so the finally's guard skips the job path on the normal route (it only
# has to clean up when the run threw BEFORE reaching these lines).
$watch = $null

Write-Host "`n=== UAC 观察 ===" -ForegroundColor Cyan
Write-Host ("consent.exe 出现次数: {0}" -f (@($consent).Count))
$uacAfter = @()
try {
    $uacAfter = @(Get-WinEvent -LogName 'Microsoft-Windows-UAC/Operational' -MaxEvents 5 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty TimeCreated)
} catch { }
$newUac = @($uacAfter | Where-Object { $_ -notin $script:uacEventsBefore })
Write-Host ("新增 UAC 事件（子进程需要提权但失败）: {0}" -f $newUac.Count)
$newUac | ForEach-Object { Write-Host "  $_" }

# --- filesystem result of the real download ---------------------------------
Write-Host "`n=== 落位（真实下载结果）===" -ForegroundColor Cyan
$downloaded = Join-Path $fixtures 'Hello-World_octocat'
Write-Host ("{0} exists = {1}" -f $downloaded, (Test-Path $downloaded))
if (Test-Path $downloaded) {
    Write-Host ("marker: " + ((Get-Content (Join-Path $downloaded '.devhub.json') -Raw) -replace '\s+', ' '))
}
$legacyLeftover = Test-Path (Join-Path $fixtures 'code\github.com\octocat')

Write-Host "`n=== 汇总 ===" -ForegroundColor Cyan
$summary | Format-Table -AutoSize

# Timing totals: with ~30 scenarios and a reload each, "which one ate the run"
# used to be guesswork. Sorted slowest-first so the top of the list is the lever.
$totalRun = (Get-Date) - $runStart
$pass = @($summary | Where-Object Verdict -eq 'PASS').Count
$fail = @($summary | Where-Object { $_.Verdict -ne 'PASS' }).Count
$scenarioSecs = [math]::Round(($summary | Measure-Object -Property Ms -Sum).Sum / 1000, 1)
Write-Host ("通过 {0} / 未通过 {1} / 共 {2}；场景累计 {3}s，整轮墙钟 {4}s" -f `
    $pass, $fail, $summary.Count, $scenarioSecs, [math]::Round($totalRun.TotalSeconds, 1)) -ForegroundColor Cyan
if ($summary.Count) {
    Write-Host '最慢场景：' -ForegroundColor DarkGray
    $summary | Sort-Object Ms -Descending | Select-Object -First 5 |
        ForEach-Object { Write-Host ("  {0,-28} {1,6}s  {2}" -f $_.Scenario, [math]::Round($_.Ms / 1000, 1), $_.Verdict) -ForegroundColor DarkGray }
}

} finally {
    # Teardown, on EVERY path: normal finish, an `exit` reached in the block after
    # this finally, or a throw from any scenario. It used to be a linear block at the
    # very end of the script, so a throw (or the `-Only`-typo / empty-set `exit`)
    # before it skipped cleanup entirely.
    #
    # The gap it closes: the old teardown stopped only the `devhub-app` image and the
    # `pwsh` wrapper PID. But `-Start` launches `pnpm tauri dev`, whose tree is
    # pwsh → node(pnpm) → the Tauri CLI → vite (the beforeDevCommand) + rustc +
    # devhub-app. Killing the wrapper left the vite/node chain alive holding port 1420
    # — the exact port scripts/tauri.ps1's port-guard refuses on the next
    # `pnpm tauri dev` (tauri.ps1:29), so a single aborted run poisoned the next
    # developer. The model is the crate's own `proc::kill_tree`, i.e.
    # `taskkill /T /F`, which takes the whole descendant chain.
    #
    # taskkill is a native command: its stderr is a terminating error under Stop, so
    # drop to Continue for the teardown (the same dance the file does elsewhere and
    # scripts/tauri.ps1 documents).
    $ErrorActionPreference = 'Continue'
    if ($started) {
        taskkill /T /F /PID $started.Id 2>&1 | Out-Null
        # devhub-app can detach from the job object, so stop it by path too, exactly
        # as the old block did — a second pass, not the only one.
        Get-Process -Name 'devhub-app' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "$app*" } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
        Write-Host '已关闭 dev 进程树（taskkill /T /F + 按路径清 devhub-app）' -ForegroundColor DarkGray
    }
    if ($watch) {
        # Only fires if the run threw before the in-try Stop/Remove ran (that path
        # sets $watch = $null, so the normal route skips this).
        Stop-Job $watch -ErrorAction SilentlyContinue
        Remove-Job $watch -Force -ErrorAction SilentlyContinue
    }
    $ErrorActionPreference = 'Stop'
}

# --- propagate the verdict through the process exit code --------------------
# This used to be the file's whole failure story: `$fail` was computed for the
# summary line but the script's LAST statement was a `Write-Host`, so pwsh exited 0
# no matter how many scenarios came back FAIL / UNPARSEABLE / NO-VERDICT. Only the
# two early guards (`exit 2` for "app never came up", `-Start` build failures) set a
# code; a completed run that verified nothing correct still looked green to `&&`,
# to CI, and to whoever re-ran it. A run is a pass only when every scenario that
# was selected came back PASS.
if ($summary.Count -eq 0) {
    Write-Host '未运行任何场景（-Only 过滤到空，或没有匹配的夹具）—— 不视为通过。' -ForegroundColor Yellow
    exit 1
}
# Three different things are being counted here, and conflating them is how a
# harness becomes wallpaper. `NO-VERDICT` is not a regression: it means the
# scenario returned its evidence object with **no `verdict` key at all** — i.e. it
# asserts nothing (verified 2026-10-16: `scripts/scenarios/stop-tree.mjs` ends in
# `return out;` while `wall-reset.mjs` ends in `verdict: … ? 'PASS' : 'FAIL'`).
# Twelve of the 24 scenarios are in that class, so a bare "14 个未通过" reads as
# fourteen regressions when it is one FAIL, one INCONCLUSIVE and twelve fixtures
# that never had assertions. Report the split, and keep failing: a scenario that
# asserts nothing is a defect, just a different one.
$noVerdict = @($summary | Where-Object { $_.Verdict -eq 'NO-VERDICT' })
$unparseable = @($summary | Where-Object { $_.Verdict -eq 'UNPARSEABLE' })
$realFail = @($summary | Where-Object { $_.Verdict -ne 'PASS' -and $_.Verdict -ne 'NO-VERDICT' })
if ($fail -gt 0) {
    Write-Host ("未通过 {0} 个 = 断言失败 {1} · 无结论/解析失败 {2} · 没有断言（返回证据但无 verdict）{3}" -f `
        $fail, $realFail.Count, $unparseable.Count, $noVerdict.Count) -ForegroundColor Red
    if ($realFail.Count -eq 0 -and $unparseable.Count -eq 0) {
        Write-Host '本轮没有任何场景真的判负 —— 但上面那些场景不产生结论，验证覆盖比 24 这个数字小得多。' -ForegroundColor Yellow
    }
    Write-Host ('涉及的场景：' + (($summary | Where-Object { $_.Verdict -ne 'PASS' } | ForEach-Object { "$($_.Scenario)=$($_.Verdict)" }) -join '、')) -ForegroundColor DarkGray
    exit 1
}
Write-Host '全部场景通过。' -ForegroundColor Green
exit 0
