//! DevHub - a launcher/container for GitHub projects.
//!
//! The frontend owns all presentation; Rust owns only what the webview cannot
//! safely do itself: locating git, downloading repositories, and spawning
//! processes. Keeping logic on the React side keeps iteration fast, because
//! Rust rebuilds take minutes on this machine while Vite hot-reloads instantly.

mod activity;
mod activity_cmd;
mod auth;
mod cache;
mod clone_hazards;
mod commits;
mod covers;
mod crash;
mod deps;
mod deeplink;
mod diagnostics;
mod disk; mod docker;
mod downloader;
mod downloads_cmd;
mod file_stream;
mod files; mod fonts;
mod fs_watch;
mod gitboot;
mod gitwt;
mod headless;
mod heat;
mod idescan;
mod launch;
mod launch_risk;
mod link;
mod metadata;
mod native_watch;
mod netpath;
mod netstatus;
mod ogimage;
mod path_guard;
mod preview;
mod proc;
mod process_events;
mod repo_index;
mod search;
mod search_cmd;
mod searchgrep;
mod settings_cmd;
mod update_check;
mod webview2;

// r21-o1-1: names moved into settings_cmd.rs keep resolving at the root.
use proc::ProcessState;
use settings_cmd::*;
// r21-o1-2: the search commands keep resolving at the root (tests + callers).
use search_cmd::*;
// r21-o1-2: main.rs calls devhub_app_lib::run_headless_* — keep those paths.
pub use headless::*;
// r21-o1-3: same contract for the `--cover-check` probe, now living in covers.rs.
pub use covers::run_headless_cover_check;
mod stars;
mod storage_cmd;
mod sweep;

use downloader::{
    discover_local_proxy, find_git, resolve_agreed_ip, DownloadOutcome, Downloader,
    DownloaderConfig, GitLocation, RepoRef,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// `[timing]` reporting.
///
/// The two lines that existed printed unconditionally, so the log spent its whole
/// budget re-confirming the operations that were already fast and said nothing
/// about the ones that were not. Now a line appears when the operation crossed the
/// threshold, and it says *where the answer came from* - which is the difference
/// between "95 ms" and "95 ms, and it walked the disk again".
///
/// `DEVHUB_TIMING`: unset = only at or above 50 ms, `all` = every line, `0` = none,
/// or a number to move the threshold.
mod timing {
    const DEFAULT_MS: u128 = 50;

    fn threshold() -> Option<u128> {
        match std::env::var("DEVHUB_TIMING") {
            Err(_) => Some(DEFAULT_MS),
            Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
                "" | "0" | "off" | "none" => None,
                "all" | "1" => Some(0),
                other => other.parse::<u128>().ok().or(Some(DEFAULT_MS)),
            },
        }
    }

    /// Reports `op` when it is slow enough to be worth a line.
    pub fn report(op: &str, ms: u128, detail: impl std::fmt::Display) {
        if let Some(limit) = threshold() {
            if ms >= limit {
                println!("[timing] {op} ms={ms} {detail}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// True when the executable sits in a cargo `target\<profile>` directory, i.e.
/// this is a development run rather than a portable install.
fn is_dev_layout(exe_dir: &std::path::Path) -> bool {
    let profile_ok = exe_dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("debug") || n.eq_ignore_ascii_case("release"))
        .unwrap_or(false);
    let under_target = exe_dir
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.eq_ignore_ascii_case("target"))
        .unwrap_or(false);
    profile_ok && under_target
}

/// `runtime\` next to the executable, where a bundled portable git lives.
///
/// The `CARGO_MANIFEST_DIR` fallback is used **only** for development runs.
/// Applying it unconditionally was a real bug: a portable copy of the release
/// binary, placed in a fresh folder, still resolved its runtime and config
/// location back to the development machine's crate directory.
fn bundled_runtime_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    if dir.join("runtime").is_dir() {
        return Some(dir.join("runtime"));
    }
    if is_dev_layout(&dir) {
        return Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"));
    }
    // Portable layout: the runtime directory does not exist yet, but this is
    // where a bootstrap would create it.
    Some(dir.join("runtime"))
}

/// Default project root.
///
/// Agreed layout: when the app is installed somewhere writable, e.g.
/// `D:\app\程序本体\devhub-app.exe`, repositories go to `D:\app\项目\`.
/// When the executable sits somewhere read-only (`Program Files`), we fall back
/// to `%LOCALAPPDATA%\DevHub\项目`, because "everything under the software
/// directory" is physically impossible there.
///
/// In development the executable lives in `target\debug`, where project data
/// must NOT go (cargo clean would delete it), so we use the crate folder.
fn default_project_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let in_target = exe_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("debug") || n.eq_ignore_ascii_case("release"))
                .unwrap_or(false);

            if in_target {
                return PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("项目");
            }
            let install_root = exe_dir.parent().unwrap_or(exe_dir);
            if can_write_dir(install_root) {
                return install_root.join("项目");
            }
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("DevHub").join("项目")
}

/// Probes writability by actually creating and removing a file.
fn can_write_dir(dir: &std::path::Path) -> bool {
    if !dir.exists() {
        return false;
    }
    let probe = dir.join(".devhub-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Resolves the project root.
///
/// Precedence: the `DEVHUB_PROJECT_ROOT` override (used by the headless probes
/// and by tests), then the saved setting, then the computed default.
pub(crate) fn project_root() -> PathBuf {
    if let Some(v) = std::env::var_os("DEVHUB_PROJECT_ROOT") {
        return PathBuf::from(v);
    }
    let saved = read_config().project_root;
    if !saved.trim().is_empty() {
        return PathBuf::from(saved);
    }
    default_project_root()
}

/// Every directory whose repositories should be listed: the main root plus the
/// configured extra roots. Non-existent extras are skipped silently — a root
/// on a removed drive must not break the whole project wall.
pub(crate) fn project_roots() -> Vec<PathBuf> {
    let mut out = vec![project_root()];
    let cfg = read_config();
    for extra in cfg.extra_roots {
        let p = PathBuf::from(extra.trim());
        if !p.as_os_str().is_empty() && p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Resolves a slug across all configured roots.
///
/// Answers from [`repo_index`] rather than walking again. This is the hot one:
/// thirteen commands call it, and each call used to be a full scan of every root -
/// measured at 27-54 ms on a 13-repository container, and 3.5 s on a root that also
/// holds a build tree.
pub(crate) fn find_repo_any(slug: &str) -> Option<PathBuf> {
    repo_index::find(&project_roots(), slug).0
}

/// 界面归属常量：记录里"这次操作是在哪个界面做的"。
///
/// Kept as named constants because every call site has to supply one, and a
/// typo in a bare string literal would silently produce an unfilterable row.
/// The 项目墙 is absent: downloads can be issued from there, and that view
/// passes its own label through `download_repo`'s `source` argument.
const SRC_ADD: &str = "添加页";
pub(crate) const SRC_LAUNCH: &str = "启动面板";
const SRC_SETTINGS: &str = "设置页";
const SRC_RECORDS: &str = "记录页";

/// One operation record: 类型 / 事情 / 细节 / 项目 / 界面 / 受影响路径.
///
/// A chained builder rather than six positional `&str`s: the two location
/// fields (界面 + 路径) are exactly what the 记录 view was reported as missing,
/// and a call site that reads `.source(SRC_LAUNCH).path(&p)` cannot quietly
/// omit them the way a sixth anonymous `""` argument could.
pub(crate) struct Log {
    tag: &'static str,
    action: String,
    detail: String,
    slug: String,
    source: String,
    path: String,
    target: String,
    before: String,
    after: String,
    undo: Option<activity::Undo>,
}

impl Log {
    fn new(tag: &'static str, action: &str, source: &str) -> Self {
        Log {
            tag,
            action: action.to_string(),
            detail: String::new(),
            slug: String::new(),
            source: source.to_string(),
            path: String::new(),
            target: String::new(),
            before: String::new(),
            after: String::new(),
            undo: None,
        }
    }
    pub(crate) fn detail(mut self, v: &str) -> Self {
        self.detail = v.to_string();
        self
    }
    pub(crate) fn slug(mut self, v: &str) -> Self {
        self.slug = v.to_string();
        self
    }
    pub(crate) fn path(mut self, v: &std::path::Path) -> Self {
        self.path = v.to_string_lossy().to_string();
        self
    }
    pub(crate) fn path_str(mut self, v: &str) -> Self {
        self.path = v.to_string();
        self
    }
    /// What was changed, addressed rather than described. This is also the
    /// 记录 grouping key, so "改了五次这个项目的启动命令" becomes one block.
    pub(crate) fn target(mut self, v: &str) -> Self {
        self.target = v.to_string();
        self
    }
    /// The before/after pair, for the diff line and for a value 回退.
    pub(crate) fn change(mut self, before: &str, after: &str) -> Self {
        self.before = before.to_string();
        self.after = after.to_string();
        self
    }
    pub(crate) fn undo(mut self, u: activity::Undo) -> Self {
        self.undo = Some(u);
        self
    }
}

/// Records one operation into the activity log. Never fails the caller.
pub(crate) fn record_activity(log: Log) {
    let mut entry = activity::ActivityEntry::now(
        log.tag,
        &log.action,
        &log.detail,
        &log.slug,
        &log.source,
        &log.path,
    );
    if !log.target.is_empty() {
        entry = entry.with_target(&log.target);
    }
    if !log.before.is_empty() || !log.after.is_empty() {
        entry = entry.with_change(&log.before, &log.after);
    }
    if let Some(u) = log.undo {
        entry = entry.with_undo(u);
    }
    if let Err(e) = activity::append(&activity_path(), &entry) {
        eprintln!("[activity] {e}");
    }
}

/// Records one named config change with its before/after pair and a value 回退.
///
/// Shared by every settings switch so a record written for 搜索链路 can be
/// reverted by exactly the same machinery as one for 项目目录 — the earlier
/// shape had each call site decide individually whether to bother, which is why
/// most settings records had nothing to roll back to.
fn record_config_change(
    notes: &mut Vec<String>,
    key: &str,
    label: &str,
    from: &str,
    to: &str,
) {
    if from == to {
        return;
    }
    notes.push(format!("{label}：{from} → {to}"));
    record_activity(
        Log::new("settings", &format!("修改{label}"), SRC_SETTINGS)
            .detail(&format!("{from} → {to}"))
            .target(&format!("config.{key}"))
            .change(from, to)
            .undo(activity::Undo::value("config", key, from)),
    );
}

/// `bypass` / `useHosts` as the user reads them.
fn route_phrase(route: &str) -> String {
    match route {
        "useHosts" => "沿用本地加速".to_string(),
        _ => "绕过（IP 直连）".to_string(),
    }
}

fn cleanup_phrase(mode: &str, keep_days: u32) -> String {
    let every = match mode {
        "daily" => "每天",
        "weekly" => "每周",
        "monthly" => "每月",
        _ => return "手动".to_string(),
    };
    format!("{every} · 保留 {}", retention_phrase(keep_days))
}

/// What a clone strategy means, in the words a history line needs.
///
/// Anything unrecognised reads 完整克隆 rather than echoing the stored value: a
/// hand-edited config is the only way to get an unknown here, and a history line that
/// prints 「克隆深度策略：banana」 invites the reader to believe such a mode existed.
fn clone_strategy_phrase(s: &str) -> String {
    match s.trim().to_ascii_lowercase().as_str() {
        "shallow" => "浅克隆（只取最近一个提交，读旧提交要先 git fetch --unshallow）".to_string(),
        "blobless" => "无 blob 克隆（文件内容按需取回，需要服务器支持过滤）".to_string(),
        _ => "完整克隆（默认）".to_string(),
    }
}

/// Byte counts as they read in a history line.
///
/// Mirrors `formatBytes` in `src/types.ts` deliberately: "释放 125829120 字节"
/// was one of the unclear records, and having the two sides disagree on units
/// is worse than either choice.
fn human_bytes(n: u64) -> String {
    const K: u64 = 1024;
    if n < K {
        format!("{n} B")
    } else if n < K * K {
        format!("{:.1} KB", n as f64 / K as f64)
    } else if n < K * K * K {
        format!("{:.1} MB", n as f64 / (K * K) as f64)
    } else {
        format!("{:.2} GB", n as f64 / (K * K * K) as f64)
    }
}

/// The activity log lives next to the config file, keeping the portable layout
/// self-contained.

// ---------------------------------------------------------------------------
// Agent / app state
// ---------------------------------------------------------------------------

/// The tracked-process table, shared between the commands, the launcher and the
/// `process://update` notifier. A named alias keeps those three from each spelling
/// out a `Mutex<HashMap<…>>` type (and keeps `check-invariants`' bounded-cache
/// heuristic from mistaking a registry for an unbounded cache).
type ProcTable = std::sync::Mutex<std::collections::HashMap<u32, Tracked>>;

#[derive(Default)]
struct Settings {
    mirror_enabled: std::sync::Mutex<bool>,
    ip_pin_enabled: std::sync::Mutex<bool>,
    /// Search result cache plus the local rate-limit history.
    ///
    /// Wrapped in an `Arc` so it can be cloned into a worker thread. A plain
    /// `Mutex` would force either a synchronous command on the UI thread or an
    /// `unsafe` pointer escape.
    search: std::sync::Arc<std::sync::Mutex<search::SearchCache>>,
    /// Processes the launcher started and the UI may still be watching.
    procs: std::sync::Arc<ProcTable>,
    /// Fingerprint of the last `process://update` payload, shared by every emitter
    /// so a snapshot that only let time pass is not pushed to the webview.
    process_events: std::sync::Arc<std::sync::Mutex<Option<u64>>>,
}

impl Settings {
    /// Seeds the in-memory flags from the saved configuration.
    ///
    /// This was a real bug: the state was created with `Settings::default()`, so
    /// `mirror_enabled` and `ip_pin_enabled` both started `false` on every launch
    /// no matter what the config file said. Effects observed on a fresh config:
    /// the UI showed "DNS 失败时钉死 IP" switched OFF even though the documented
    /// default is ON, the downloader therefore never used the IP-pinning layer,
    /// and the first save wrote that wrong value permanently. Turning the mirror
    /// on and restarting lost the setting the same way.
    fn from_config(cfg: &AppConfig) -> Self {
        Settings {
            mirror_enabled: std::sync::Mutex::new(cfg.mirror_enabled),
            ip_pin_enabled: std::sync::Mutex::new(cfg.ip_pin_enabled),
            search: std::sync::Arc::new(std::sync::Mutex::new(search::SearchCache::new())),
            procs: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
            process_events: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

/// One launched process, kept so its exit can be observed and it can be stopped.
struct Tracked {
    child: std::process::Child,
    label: String,
    slug: String,
    started: std::time::Instant,
    /// False until `try_wait` reports an exit.
    exited: bool,
    code: Option<i32>,
    /// Job Object handle, or `None` when assignment failed.
    ///
    /// When present, closing this handle terminates the whole process tree
    /// (KILL_ON_JOB_CLOSE). When absent, `kill_tree` falls back to
    /// `taskkill /T /F`. See `proc::create_kill_on_close_job`.
    job_handle: proc::JobHandle,
    /// **Frozen at the moment of exit.**
    ///
    /// This is the fix for "已退出（代码 1）· 运行了 5 分 15 秒" on a command that
    /// died instantly. `elapsed_ms` used to be computed as `started.elapsed()` on
    /// every poll, so the number kept growing for the whole `EXITED_TTL` window
    /// (30 minutes) after the process was already gone. The reading was not
    /// rounded wrong — it measured how long since we launched something, not how
    /// long it ran.
    ran_for: Option<std::time::Duration>,
    /// **When we first observed the exit**, not how long it ran.
    ///
    /// `EXITED_TTL` is a *retention* window, and it used to be measured with
    /// `ran_for`: a process that died after 5 s kept `ran_for = 5 s`, so
    /// `ran_for > 30 min` was never true and the entry stayed in the table — and
    /// in `process_states` output — for the rest of the session. Only processes
    /// that ran longer than the TTL were ever pruned.
    exited_at: Option<std::time::Instant>,
    /// Whether the last suspend/resume request succeeded.
    suspended: bool,
}

/// What the launch dialog polls for.

/// How long an exited process stays listed before the registry forgets it.
/// Long enough for the dialog to notice and show the exit code, short enough
/// that a long-running app does not accumulate dead entries.
const EXITED_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Builds the sink handed to the launcher: registers the child and reports it.
///
/// The notifier is called *after* the table guard is dropped: `publish` takes the
/// dedupe lock and then the table lock (see `process_events`), and this is the one
/// path where the mutation itself is holding the table lock.
fn make_spawn_sink(
    notifier: process_events::ProcessNotifier,
    slug: String,
) -> launch::SpawnSink {
    std::sync::Arc::new(move |child, label: String| {
        let pid = child.id();
        // Create a Job Object and assign the freshly-spawned child to it so the
        // whole tree dies when we close the handle. If either step fails we
        // store None and kill_tree falls back to taskkill /T /F.
        let job_handle = match proc::create_kill_on_close_job() {
            Some(job) if proc::assign_process_to_job(job, pid) => Some(job),
            Some(job) => {
                // Job created but assignment failed (process already exited, or
                // lacks rights). Close it so we don't leak the handle.
                proc::close_job_handle(job);
                None
            }
            None => None,
        };
        if let Ok(mut g) = notifier.procs.lock() {
            g.insert(
                pid,
                Tracked {
                    child,
                    label,
                    slug: slug.clone(),
                    started: std::time::Instant::now(),
                    exited: false,
                    code: None,
                    job_handle,
                    ran_for: None,
                    exited_at: None,
                    suspended: false,
                },
            );
        }
        notifier.publish();
    })
}

/// Reaps every tracked child once, freezing the run time at the moment it went.
///
/// Shared by the per-project poll and the global count so the two cannot
/// disagree about whether something is still alive.
fn reap(g: &mut std::collections::HashMap<u32, Tracked>) {
    for t in g.values_mut() {
        if t.exited {
            continue;
        }
        match t.child.try_wait() {
            Ok(Some(status)) => {
                t.exited = true;
                t.code = status.code();
                t.ran_for = Some(t.started.elapsed());
                t.exited_at = Some(std::time::Instant::now());
            }
            Ok(None) => {}
            // The handle is unusable (already reaped elsewhere); report
            // it as exited with an unknown code rather than lying.
            Err(_) => {
                t.exited = true;
                t.code = None;
                t.ran_for = Some(t.started.elapsed());
                t.exited_at = Some(std::time::Instant::now());
            }
        }
    }
}

/// Polls every tracked process for one project.
#[tauri::command(async)]
fn process_states(
    settings: tauri::State<'_, Settings>,
    slug: String,
) -> Result<Vec<ProcessState>, String> {
    let mut out = Vec::new();
    let mut stale = Vec::new();
    if let Ok(mut g) = settings.procs.lock() {
        reap(&mut g);
        for (pid, t) in g.iter_mut() {
            if t.slug != slug {
                continue;
            }
            // Retention counts from the moment the exit was observed. Measuring it
            // with `ran_for` (frozen at exit) made any process that ran shorter than
            // the TTL un-prunable, so the table and this list grew for the whole
            // session; see `Tracked::exited_at`.
            if t.exited && t.exited_at.map(|at| at.elapsed() > EXITED_TTL).unwrap_or(false) {
                stale.push(*pid);
            }
            out.push(summarise(*pid, t));
        }
        for pid in stale {
            g.remove(&pid);
        }
    }
    out.sort_by_key(|p| p.pid);
    Ok(out)
}

/// Reaps, drops rows past `EXITED_TTL`, and summarises the still-live ones.
///
/// Shared by the `live_processes` command and the `process://update` emitter so the
/// two can never answer with different tables: the push payload is exactly what a
/// poll at that instant would have returned. Exited rows are deliberately absent —
/// the strip and the wall only render running/suspended processes; the per-project
/// launch dialog uses `process_states`, which keeps the exit rows it needs.
fn snapshot_processes(procs: &ProcTable) -> Vec<ProcessState> {
    let mut out = Vec::new();
    if let Ok(mut g) = procs.lock() {
        reap(&mut g);
        // Drop dead entries past their TTL here too, or a closed dialog would
        // leave them in the map for half an hour and inflate the count.
        let stale: Vec<u32> = g
            .iter()
            .filter(|(_, t)| {
                t.exited
                    && t.exited_at
                        .map(|at| at.elapsed() > EXITED_TTL)
                        .unwrap_or(false)
            })
            .map(|(p, _)| *p)
            .collect();
        for pid in stale {
            g.remove(&pid);
        }
        for (pid, t) in g.iter() {
            if t.exited {
                continue;
            }
            out.push(summarise(*pid, t));
        }
    }
    out.sort_by_key(|p| p.pid);
    out
}

/// Every live process across every project.
///
/// The status strip needs a count the launch dialog used to be the only holder
/// of, and polling per slug would mean one invoke per repository on the wall.
#[tauri::command(async)]
fn live_processes(settings: tauri::State<'_, Settings>) -> Result<Vec<ProcessState>, String> {
    Ok(snapshot_processes(&settings.procs))
}

fn summarise(pid: u32, t: &Tracked) -> ProcessState {
    let elapsed = match t.ran_for {
        Some(d) => d,
        None => t.started.elapsed(),
    };
    // A reaped PID can be reused, so an exited row deliberately keeps its last
    // known "unknown" rather than querying whatever process inherited the number.
    let metrics = if t.exited { None } else { proc::metrics(pid) };
    ProcessState {
        pid,
        label: t.label.clone(),
        slug: t.slug.clone(),
        state: if t.exited {
            "exited".into()
        } else if t.suspended {
            "suspended".into()
        } else {
            "running".into()
        },
        exit_code: t.code,
        elapsed_ms: elapsed.as_millis() as u64,
        stoppable: !t.exited,
        suspendable: !t.exited,
        cpu_ms: metrics.map(|m| m.cpu_ms),
        working_set_bytes: metrics.map(|m| m.working_set_bytes),
        io_read_bytes: metrics.map(|m| m.read_bytes),
        io_write_bytes: metrics.map(|m| m.write_bytes),
    }
}

/// 挂起 / 恢复 a launched process and its whole child tree.
///
/// See `proc::nt_process_gate` for why this goes through an undocumented NT
/// entry point, and what the alternatives cost.
///
/// Async because freezing a tree means one `CreateToolhelp32Snapshot` of every
/// process on the machine plus an NT call per descendant; as a synchronous command
/// that ran on the main thread, which is how pressing 挂起 could stall the window it
/// was meant to freeze.
#[tauri::command]
async fn suspend_process(
    app: tauri::AppHandle,
    pid: u32,
    suspended: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Settings>();
        let notifier = process_events::ProcessNotifier::new(app.clone(), &settings);
        let result = suspend_process_sync(&settings, pid, suspended);
        if result.is_ok() {
            notifier.publish();
        }
        result
    })
    .await
    .map_err(|e| format!("挂起任务异常: {e}"))?
}

fn suspend_process_sync(settings: &Settings, pid: u32, suspended: bool) -> Result<(), String> {
    {
        let g = settings.procs.lock().map_err(|_| "进程表锁已损坏".to_string())?;
        if !g.contains_key(&pid) {
            return Err("这个进程已经不在监控列表里".to_string());
        }
    }
    let skipped = proc::set_tree_suspended(pid, suspended)?;
    if let Ok(mut g) = settings.procs.lock() {
        if let Some(t) = g.get_mut(&pid) {
            t.suspended = suspended;
        }
    }
    let detail = if skipped > 0 {
        format!("子进程 {skipped} 个已不存在，跳过")
    } else {
        String::new()
    };
    record_activity(
        Log::new(
            "launch",
            if suspended { "挂起进程" } else { "恢复进程" },
            SRC_LAUNCH,
        )
        .target(&format!("process:{pid}"))
        .detail(&detail),
    );
    Ok(())
}

/// Stops a launched process and its whole child tree.
///
/// `cmd /C <command>` means the tracked pid is usually a shell whose real
/// workload is a child, so killing only the pid would leave a dev server
/// listening. `taskkill /T` takes the tree - but only while the root is still
/// alive to be walked, which is why it runs *before* `child.kill()`.
#[tauri::command]
async fn stop_process(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Settings>();
        let notifier = process_events::ProcessNotifier::new(app.clone(), &settings);
        let result = stop_process_sync(&settings, pid);
        if result.is_ok() {
            notifier.publish();
        }
        result
    })
    .await
    .map_err(|e| format!("停止进程任务异常: {e}"))?
}

fn stop_process_sync(settings: &Settings, pid: u32) -> Result<(), String> {
    // Check whether the pid is tracked, whether it needs thawing, and grab its
    // Job Object handle (if any) under the lock. Taking the handle here means
    // the later `child.kill()` + bookkeeping section cannot double-close it.
    let (needs_thaw, job_handle) = {
        let mut guard = settings
            .procs
            .lock()
            .map_err(|_| "进程表锁已损坏".to_string())?;
        match guard.get_mut(&pid) {
            Some(t) => (t.suspended, t.job_handle.take()),
            None => return Err("这个进程已经不在监控列表里".to_string()),
        }
    };

    // Thaw the whole tree outside the lock: `suspend_process` froze the tree, and a
    // descendant left suspended cannot service the terminate request that
    // `taskkill /F` sends it.
    if needs_thaw {
        let _ = proc::set_tree_suspended(pid, false);
    }

    // Prefer the Job Object: closing its handle terminates the entire tree
    // atomically (no parent-exit race). Fall back to taskkill /T /F when no job
    // was assigned (assignment failed at spawn time).
    let tree_kill: Option<String> = if let Some(job) = job_handle {
        proc::close_job_handle(job);
        None
    } else {
        let mut taskkill = proc::silent("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        proc::output_timeout(&mut taskkill, proc::PROBE_TIMEOUT)
            .ok()
            .flatten()
            .and_then(|out| {
                if out.status.success() {
                    None
                } else {
                    let text = proc::decode_console(&out.stderr);
                    let text = text.trim();
                    Some(if text.is_empty() {
                        format!("退出码 {:?}", out.status.code())
                    } else {
                        text.chars().take(200).collect()
                    })
                }
            })
    };

    let killed = {
        let mut guard = settings
            .procs
            .lock()
            .map_err(|_| "进程表锁已损坏".to_string())?;
        match guard.get_mut(&pid) {
            Some(t) => {
                let _ = t.child.kill();
                let _ = t.child.wait();
                t.exited = true;
                t.code = None;
                t.ran_for = Some(t.started.elapsed());
                t.exited_at = Some(std::time::Instant::now());
                t.suspended = false;
                t.label.clone()
            }
            // The TTL sweep can take the entry away at any moment, and if it has,
            // the process it describes is already exited - which is what 停止 asked
            // for. Reporting that as a failure was the real defect: the button was
            // pressed, the tree was killed above, and the user got 「已经不在监控列表里」.
            None => {
                record_activity(
                    Log::new("launch", "停止运行中的进程", SRC_LAUNCH)
                        .detail(&format!("PID {pid} 已不在进程表中（此前已退出并被清理）")),
                );
                return Ok(());
            }
        }
    };
    let detail = match tree_kill {
        Some(reason) => format!(
            "{killed} (PID {pid}) · 子进程树未全部终止：{reason}，端口可能仍被占用"
        ),
        None => format!("{killed} (PID {pid})"),
    };
    record_activity(
        Log::new("launch", "停止运行中的进程", SRC_LAUNCH).detail(&detail),
    );
    Ok(())
}

/// Terminates every still-running process the launcher tracks.
///
/// `Tracked` owns a `std::process::Child`, and dropping a child detaches — it does
/// not terminate. Nothing in this app killed anything on exit, so quitting with
/// `npm run dev` in the table left node running and holding its allocated port,
/// while the next launch had no window that could stop it.
///
/// `taskkill /T /F` runs first for the same measured reason as `stop_process_sync`:
/// the tracked child is usually `cmd.exe`, and the thing actually serving the port is
/// its child. Then `kill()`+`wait()` on the handle we do own, so the entry is never
/// left reporting 运行中 after the process is gone.
///
/// **Runs entirely outside the `procs` lock.** The previous version was only ever
/// called as `procs.lock().map(|mut g| kill_tree(&mut g))`, so every `taskkill`
/// (a process-tree walk, tens to hundreds of ms) and every `child.wait()` ran
/// while the table was locked - `stop_process`, `poll_tracked` and `suspend` all
/// queue behind the whole exit sweep. The table lock now only guards the two
/// short critical sections (mark-suspended-then-collect, and mark-exited), the
/// same shape `stop_process_sync` already uses for a single pid. `&Mutex<HashMap>`
/// rather than `&mut HashMap` is what makes that possible; the exit hook passes
/// the `Arc<Mutex<...>>` it already clones.
///
/// Returns `(killed, failures)`. `taskkill` is bounded by `PROBE_TIMEOUT` and its
/// outcome is kept: this is the last thing that runs before the window is gone, so
/// a silent failure here is an orphan holding a port that nobody in the next
/// session can even see.
fn kill_tree(
    procs: &std::sync::Mutex<std::collections::HashMap<u32, Tracked>>,
) -> (usize, Vec<String>) {
    // Phase 1 (locked): thaw anything suspended and collect the live pids together
    // with the labels the failure lines need, plus the Job Object handle if one
    // was assigned. A suspended child cannot service a terminate request, so the
    // thaw is not optional - and it belongs here, not in phase 2, because
    // `set_tree_suspended` also walks the tree and both walks want the entry
    // still marked live.
    struct Target {
        pid: u32,
        label: String,
        job_handle: proc::JobHandle,
    }
    let targets: Vec<Target> = {
        let Ok(mut g) = procs.lock() else {
            return (0, Vec::new());
        };
        let mut ids = Vec::new();
        for (pid, t) in g.iter_mut() {
            if t.exited {
                continue;
            }
            if t.suspended {
                let _ = proc::set_tree_suspended(*pid, false);
                t.suspended = false;
            }
            ids.push(Target {
                pid: *pid,
                label: t.label.clone(),
                // Take the handle out of the entry: phase 3 must not close it a
                // second time. Leaving Some in place would leak the kill signal
                // on a process that had already exited between phases.
                job_handle: t.job_handle.take(),
            });
        }
        ids
    };

    // Phase 2 (unlocked): the slow part. When a Job Object was assigned, closing
    // its handle terminates the entire tree atomically (the kernel owns the
    // membership list, so there is no parent-exit race). Otherwise we fall back
    // to taskkill /T /F, which can leak grandchildren but is better than
    // nothing. taskkill is bounded by `PROBE_TIMEOUT`.
    let mut failures: Vec<String> = Vec::new();
    for t in &targets {
        if let Some(job) = t.job_handle {
            proc::close_job_handle(job);
            continue;
        }
        let pid = t.pid;
        let label = &t.label;
        let mut taskkill = proc::silent("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        match proc::output_timeout(&mut taskkill, proc::PROBE_TIMEOUT) {
            Ok(Some(out)) if out.status.success() => {}
            Ok(Some(out)) => {
                let text = proc::decode_console(&out.stderr);
                failures.push(format!(
                    "PID {pid}（{label}）：{}",
                    text.trim().chars().take(160).collect::<String>()
                ));
            }
            Ok(None) => failures.push(format!("PID {pid}（{label}）：taskkill 超时")),
            Err(e) => failures.push(format!("PID {pid}（{label}）：taskkill 无法运行（{e}）")),
        }
    }

    // Phase 3 (locked): reap our own handles and freeze the accounting. An entry
    // a concurrent `stop_process` already finished between phase 1 and now is
    // skipped, so a racing stop and the exit sweep cannot double-count.
    let mut killed = 0;
    let Ok(mut g) = procs.lock() else {
        return (killed, failures);
    };
    for t in &targets {
        if let Some(entry) = g.get_mut(&t.pid) {
            if entry.exited {
                continue;
            }
            if let Err(e) = entry.child.kill() {
                failures.push(format!("PID {} child.kill 失败: {e}", t.pid));
            }
            let _ = entry.child.wait();
            entry.exited = true;
            entry.code = None;
            entry.ran_for = Some(entry.started.elapsed());
            entry.exited_at = Some(std::time::Instant::now());
            killed += 1;
        }
    }
    (killed, failures)
}

/// Reads a boolean guarded by a mutex without holding the guard across a
/// temporary. `*m.lock().unwrap()` triggers a borrow error because the guard
/// temporary is dropped while still borrowed.
fn locked_bool(m: &std::sync::Mutex<bool>, default: bool) -> bool {
    match m.lock() {
        Ok(g) => *g,
        Err(_) => default,
    }
}

fn set_locked_bool(m: &std::sync::Mutex<bool>, value: bool) {
    if let Ok(mut g) = m.lock() {
        *g = value;
    }
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReport {
    project_root: String,
    git: Option<GitLocation>,
    /// Whether the default root came from the writable-vs-readonly fallback.
    root_is_fallback: bool,
    local_proxy: Option<String>,
    resolved_ip: Option<String>,
    mirror_enabled: bool,
    ip_pin_enabled: bool,
    /// True when this process itself is running elevated. DevHub never asks for
    /// that, so `true` means something outside the app granted it - the only way
    /// an elevation prompt can be attributed to DevHub from inside DevHub.
    elevated: bool,
    /// One-sentence diagnosis of the GitHub link path (from `link.rs`).
    link_advice: String,
    /// Short phrase for the status strip, derived from the same facts.
    link_label: String,
    #[serde(flatten)]
    link: netpath::LinkReport,
}

/// Collects the environment snapshot.
///
/// Takes plain values rather than `Settings` so it can be moved to a worker
/// thread - the state guard is not `Send`. It used to be the body of a
/// **synchronous** `#[tauri::command]`, which Tauri runs on the main thread, and
/// it probes ports and queries DNS, so every refresh froze the window. Measured:
/// ~2364 ms of serial port probing plus DNS, on the UI thread.
fn collect_environment(
    root: &std::path::Path,
    mirror_enabled: bool,
    ip_pin_enabled: bool,
    search_route: &str,
    download_route: &str,
    force: bool,
) -> EnvironmentReport {
    let fallback = std::env::var_os("DEVHUB_PROJECT_ROOT").is_none()
        && root.to_string_lossy().contains("DevHub");
    let link_status = link::status(force);
    let link_label = link::strip_label(&link_status).to_string();
    EnvironmentReport {
        project_root: root.to_string_lossy().to_string(),
        git: find_git(bundled_runtime_dir().as_deref()),
        root_is_fallback: fallback,
        // Probing and DNS are concurrent inside these calls.
        local_proxy: discover_local_proxy(&[]),
        resolved_ip: resolve_agreed_ip("github.com"),
        mirror_enabled,
        ip_pin_enabled,
        elevated: proc::is_elevated(),
        // One unified diagnosis; the 5 s cache inside keeps the double probe
        // (this + LinkReport::probe) cheap, and resolve_agreed_ip's own 30 s
        // DNS cache means the second DNS lookup is a hit.
        link_advice: link_status.advice,
        link_label,
        link: netpath::LinkReport::probe(search_route, download_route),
    }
}

/// Returns the environment snapshot **off the UI thread**, so probing a slow or
/// unreachable network cannot make the window unresponsive.
///
/// Timed and reported, because this is the one command whose cost is bounded by the
/// network rather than by the disk, and the client's 20 s TTL now decides whether it
/// runs at all. Without a `[timing] environment` line there is no way to tell a
/// working TTL from a refresh that never reached the backend - the client-side counter
/// cannot see it, because `@tauri-apps/api` binds the IPC entry point at module load.
///
/// `force` bypasses the 5 s link cache. The 20 s-TTL poll leaves it unset; the
/// 网络诊断 dialog's 重新诊断 button sets it, because a button that quietly
/// returns five-second-old facts is the "diagnose did nothing" report all over
/// again (r18 N2).
#[tauri::command]
async fn environment(
    settings: tauri::State<'_, Settings>,
    force: Option<bool>,
) -> Result<EnvironmentReport, String> {
    // Read the guarded values before spawning: the state guard is not Send.
    let mirror = locked_bool(&settings.mirror_enabled, false);
    let ip_pin = locked_bool(&settings.ip_pin_enabled, true);
    let root = project_root();
    // The two routing switches live in the config file rather than in the
    // guarded state because they are read once per probe, on a worker thread,
    // and never on the UI path.
    let cfg = read_config();
    let force = force.unwrap_or(false);
    let started = std::time::Instant::now();

    let out = tauri::async_runtime::spawn_blocking(move || {
        collect_environment(
            &root,
            mirror,
            ip_pin,
            &cfg.search_route,
            &cfg.download_route,
            force,
        )
    })
    .await
    .map_err(|e| format!("环境探测失败: {e}"))?;
    timing::report(
        "environment",
        started.elapsed().as_millis(),
        format_args!(
            "git={} proxy={} dns={} root={}",
            out.git.is_some(),
            out.local_proxy.is_some(),
            out.resolved_ip.is_some(),
            if out.root_is_fallback { "fallback" } else { "saved" }
        ),
    );
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RefPreview {
    slug: String,
    url: String,
    target: String,
    exists: bool,
}

/// Parses a ref and shows where it would land, without touching the network.
///
/// `target_dir` overrides the computed landing directory (the 高级选项 editor
/// in the add view); empty means "use the computed path". When it is set the path
/// is contained by `path_guard` first, so a preview never promises a landing spot
/// the download would later refuse.
///
/// Async even though it does no network: constructing a `Downloader` resolves git,
/// and the first resolution of a session walks `PATH` and runs `git --version` -
/// measured at 2.7 s, which as a synchronous command was 2.7 s of unresponsive
/// window the moment the add page tried to preview a ref.
#[tauri::command]
async fn preview_ref(
    app: tauri::AppHandle,
    input: String,
    target_dir: Option<String>,
) -> Result<RefPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r: RepoRef = downloader::parse_ref(&input).map_err(|e| e.to_string())?;
        let cfg = DownloaderConfig {
            project_root: project_root(),
            ..Default::default()
        };
        let dl = Downloader::new(cfg, bundled_runtime_dir()).map_err(|e| e.to_string())?;
        let target = match target_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            // Contained by the same guard the download itself uses, so the preview
            // can never report an occupancy verdict for a directory the download
            // would refuse to write into. The canonical path is then handed on with
            // the `\\?\` prefix stripped: git receives this as an argument, and a
            // verbatim path is not something it is expected to understand.
            Some(dir) => {
                let guarded = path_guard::guard(&app, dir, path_guard::Access::Write)?;
                netpath::strip_verbatim(&guarded)
            }
            None => dl.target_path(&r),
        };
        Ok(RefPreview {
            slug: r.slug(),
            url: r.https_url(),
            target: target.to_string_lossy().to_string(),
            // "Occupied", not "exists": an existing *empty* directory is where the
            // download will go, not something it will collide with.
            exists: downloader::is_occupied(&target),
        })
    })
    .await
    .map_err(|e| format!("预览任务异常: {e}"))?
}

/// 更新 one repository: `git pull --ff-only` through the download ladder
/// (round 11, 需求 8.1).
///
/// The wall's 更新 action and the launch dialog's button both land here. The
/// progress events go out on their own channel (`update://progress`) rather
/// than the download one, because an update is not a task in the download
/// queue and must never be counted by `downloadBusy`.
#[tauri::command]
async fn update_repo(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    slug: String,
) -> Result<downloader::UpdateOutcome, String> {
    let cfg = build_config(&settings);
    let runtime = bundled_runtime_dir();
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, message: &str| {
        let _ = app.emit(
            "update://progress",
            serde_json::json!({ "stage": stage, "message": message }),
        );
    });
    let slug_for_log = slug.clone();
    // The walk is blocking, so it happens on the worker next to the pull, not
    // on the async runtime's threads.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
        // Constructed on the worker: `Downloader::new` resolves git, and the first
        // resolution of a session walks `PATH` and runs `git --version`.
        let dl = Downloader::new(cfg, runtime).map_err(|e| e.to_string())?;
        dl.update(sink, &repo).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("更新任务异常: {e}"))?;

    // The freshness cache entry this slug holds now describes the *old* local
    // HEAD: the pull moved it. Purging it is this backend command's job — it is
    // what lets the launch panel's 检查新鲜度 stop reporting "与远程不一致"
    // about a repository that was just fast-forwarded.
    invalidate_freshness_after_update(result.is_ok(), &slug_for_log);

    match &result {
        Ok(o) => {
            // The first three subjects are what makes an update auditable later;
            // the full list lives in the panel, not in every activity row.
            let recent = if o.recent.is_empty() {
                String::new()
            } else {
                let shown = o
                    .recent
                    .iter()
                    .rev()
                    .take(3)
                    .map(|c| format!("{} {}", c.hash, c.subject))
                    .collect::<Vec<_>>()
                    .join("；");
                format!("；新提交：{shown}")
            };
            record_activity(
                Log::new("update", "更新仓库", "项目墙")
                    .detail(&format!(
                        "通过 {:?}，{} → {}{recent}",
                        o.layer, o.before, o.after
                    ))
                    .slug(&slug_for_log)
                    .target(&format!("repo:{slug_for_log}")),
            )
        }
        Err(e) => record_activity(
            Log::new("update", "更新失败", "项目墙")
                .detail(&e.to_string())
                .slug(&slug_for_log),
        ),
    }
    result.map_err(|e| e.to_string())
}

/// One repository's freshness: the local HEAD against the remote's.
///
/// The badge is the honest half of 更新 (需求 8.2): without it a user cannot
/// tell whether 更新 would do anything. It is a *separate* command from
/// `repo_metadata` on purpose - metadata is local-only and must never wait on
/// the network, while this one is network-bound and cached for five minutes
/// so a wall of 40 cards does not become 40 GitHub round trips.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub slug: String,
    /// `fresh` | `behind` | `unknown` | `no-git` | `missing`.
    pub state: String,
    pub local_head: Option<String>,
    pub remote_head: Option<String>,
    /// Unix ms when the answer was produced.
    pub checked_at: i64,
    /// Why `state` is `unknown`, when it is.
    pub error: Option<String>,
}

/// Five minutes: long enough that scrolling the wall is free, short enough
/// that a badge does not claim "已是最新" for a repository whose author pushed
/// this morning.
const FRESHNESS_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// The network ceiling for one `repo_freshness_many` call.
///
/// One `repo_freshness` is one `git ls-remote` subprocess plus one TLS session
/// (`downloader.rs:2023`). "One round trip per tile" is exactly the cold-wall
/// cost the wall's own comment refuses, so the batch answers cache hits for
/// free but starts no more than this many *fresh* subprocesses in a single
/// call. Slugs past it come back with no answer at all (`freshness: None`),
/// never a guessed "fresh". It matches the frontend's own hard cap
/// (`FRESHNESS_CAP`), so the shipped 检查更新 path — which asks for at most that
/// many — is fully answered, while a caller that names the whole wall gets an
/// honest partial.
const FRESHNESS_MANY_FRESH_LIMIT: usize = 30;

/// `max_parallel` when a caller passes 0 — the width the wall's 检查更新 uses.
const FRESHNESS_MANY_DEFAULT_PARALLEL: usize = 3;

fn freshness_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Freshness)>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Freshness)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The cache's read side: a non-expired answer for `slug`, or `None`.
///
/// Extracted so `repo_freshness` and `repo_freshness_many` share ONE definition
/// of "a cached hit" instead of two copies that can drift apart.
fn freshness_cached(slug: &str) -> Option<Freshness> {
    let g = freshness_cache().lock().ok()?;
    let (at, f) = g.get(slug)?;
    if at.elapsed() < FRESHNESS_TTL {
        Some(f.clone())
    } else {
        None
    }
}

/// The cache's write side. The only place an entry is created, and it is called
/// only after a *completed* check — never for a synthesised verdict.
fn freshness_store(f: &Freshness) {
    if let Ok(mut g) = freshness_cache().lock() {
        // r20-O2-1: this map used to grow for the life of the process. Every slug ever
        // checked stayed in it, and the TTL was only ever consulted on *read*, so the
        // expired majority was still occupying its keys. `heat.rs` (CAP 400, evict on
        // write, `heat.rs:175-187`) and `search.rs` (cap 200, `search.rs:205-213`) both
        // already bound themselves; this is the same rule, stated once below.
        cache::insert_bounded(
            &mut g,
            FRESHNESS_TTL,
            FRESHNESS_CAP,
            f.slug.clone(),
            f.clone(),
        );
    }
}

/// How many freshness verdicts the process may hold.
///
/// An entry is a slug string plus five small fields — a few hundred bytes — so 512 is
/// well under a megabyte of resident state, and it is more than the largest container
/// this app has measured (`--scan-check` walked 13 repositories; the 检查更新 path asks
/// for at most `FRESHNESS_CAP` slugs at a time). The number is a ceiling, not a
/// working set: reaching it means the wall has more repositories than anyone can look
/// at in five minutes.
const FRESHNESS_CAP: usize = 512;

/// The upper bound for the 60-second environment-probe cache.
///
/// Same reasoning as `FRESHNESS_CAP`, scaled to what the panels ask for: one entry per
/// repository whose 项目设置 was opened in the last minute, and the spawn cost of a
/// re-probe (python/node/docker) is what the cache exists to avoid — so dropping the
/// oldest entries is cheap, letting them accumulate is not. `Environments` holds three
/// `Option<String>` versions plus flags.
const ENV_CACHE_CAP: usize = 256;


/// The cache's eviction side: drop `slug`'s entry.
///
/// This is what `update_repo` owes the cache. A pull moved HEAD, so the verdict
/// stored for that slug compares the *old* local HEAD against the remote, and
/// the launch panel's 检查新鲜度 would otherwise report "与远程不一致" about a
/// repository that was just fast-forwarded.
fn freshness_evict(slug: &str) {
    if let Ok(mut g) = freshness_cache().lock() {
        g.remove(slug);
    }
}

/// `update_repo`'s half of the contract above: a *successful* pull moved HEAD,
/// so the slug's cached verdict must be dropped. A refused `--ff-only` pull
/// leaves HEAD in place (`downloader.rs:1953-1968`), so its cached verdict is
/// still about the live commit and is deliberately kept.
///
/// Split into its own function so the policy is unit-testable without a Tauri
/// app, a repository, or a network.
fn invalidate_freshness_after_update(updated: bool, slug: &str) {
    if updated {
        freshness_evict(slug);
    }
}

#[tauri::command]
async fn repo_freshness(
    settings: tauri::State<'_, Settings>,
    slug: String,
    force: Option<bool>,
) -> Result<Freshness, String> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some(f) = freshness_cached(&slug) {
            return Ok(f);
        }
    }
    let cfg = build_config(&settings);
    let runtime = bundled_runtime_dir();
    let slug2 = slug.clone();
    let f = tauri::async_runtime::spawn_blocking(move || repo_freshness_blocking(cfg, runtime, slug2))
        .await
        .map_err(|e| format!("新鲜度任务异常: {e}"))??;
    // The worker answers `Result<Freshness, String>`: the only `Err` is "no such
    // repository", which is a command failure rather than an unknown freshness, and
    // caching it would pin a failure into the freshness cache as if it were an answer.
    freshness_store(&f);
    Ok(f)
}

/// The freshness walk for one repository, run on the blocking pool.
///
/// Split out of `repo_freshness` so the batch command runs the *same* walk
/// rather than keeping a second copy of it. `Err` is reserved for "this slug
/// could not be located at all"; every network or git answer is an `Ok` that
/// carries its own `state`.
fn repo_freshness_blocking(
    cfg: downloader::DownloaderConfig,
    runtime: Option<PathBuf>,
    slug: String,
) -> Result<Freshness, String> {
    let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let local = downloader::local_head(&repo);
    // The remote identity: the marker's URL first (the URL the download
    // actually used, mirror rewrites excluded), the repository's own
    // origin second.
    let r = downloader::read_marker(&repo)
        .map(|m| m.url)
        .filter(|u| !u.is_empty())
        .and_then(|u| downloader::parse_ref(&u).ok())
        .or_else(|| downloader::repo_ref_of(&project_root(), &repo));
    let Some(r) = r else {
        return Ok(Freshness {
            slug,
            state: "unknown".into(),
            local_head: local,
            remote_head: None,
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: Some("找不到远程地址".into()),
        });
    };
    if !repo.join(".git").exists() {
        return Ok(Freshness {
            slug,
            state: "no-git".into(),
            local_head: None,
            remote_head: None,
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: Some("压缩包下载的仓库没有 git 历史".into()),
        });
    }
    // Git is needed for this one call and nothing above it, so it is resolved
    // here: the verdicts that return early (`no-git`, `missing`, an unknown
    // remote) no longer pay for a `git --version` subprocess, and the
    // resolution itself happens on the worker instead of the runtime thread.
    let dl = Downloader::new(cfg, runtime).map_err(|e| e.to_string())?;
    match dl.remote_head(&r) {
        Ok(Some(remote)) => Ok(Freshness {
            slug,
            state: if local.as_deref() == Some(remote.as_str()) {
                "fresh".into()
            } else {
                "behind".into()
            },
            local_head: local,
            remote_head: Some(remote),
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: None,
        }),
        Ok(None) => Ok(Freshness {
            slug,
            state: "unknown".into(),
            local_head: local,
            remote_head: None,
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: Some("暂时连不上远程，无法确认".into()),
        }),
        Err(downloader::DownloadError::RepoMissing(_)) => Ok(Freshness {
            slug,
            state: "missing".into(),
            local_head: local,
            remote_head: None,
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: Some("远程仓库不存在或已设为私有".into()),
        }),
        Err(e) => Ok(Freshness {
            slug,
            state: "unknown".into(),
            local_head: local,
            remote_head: None,
            checked_at: chrono::Utc::now().timestamp_millis(),
            error: Some(e.to_string()),
        }),
    }
}

/// A verdict for a slug whose check could not run at all (its directory is
/// gone, or git is unavailable). Honest as `unknown`, and **never cached** —
/// caching a failure would pin it into the freshness cache as if it were an
/// answer, which is the mistake `repo_freshness`'s own comment warns about.
fn unknown_freshness(slug: String, error: String) -> Freshness {
    Freshness {
        slug,
        state: "unknown".into(),
        local_head: None,
        remote_head: None,
        checked_at: chrono::Utc::now().timestamp_millis(),
        error: Some(error),
    }
}

/// One row of `repo_freshness_many`: the batch's per-slug answer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshnessManyRow {
    pub slug: String,
    /// The verdict for this slug, or `None` when this call did not reach it.
    /// `None` is never a synthesised "fresh": a slug with no answer has no
    /// verdict, and the wall honestly shows nothing for it.
    pub freshness: Option<Freshness>,
}

/// Freshness for many repositories in ONE IPC (需求 8.2).
///
/// This is the batch the wall's comment asked for: cached hits are answered
/// immediately, the fresh misses run with **bounded** concurrency
/// (`max_parallel`; 0 means the default), and the fresh-work ceiling
/// (`FRESHNESS_MANY_FRESH_LIMIT`) keeps a cold wall from becoming N round trips
/// in one shot — the slugs it does not reach come back with **no answer**.
///
/// Per-repo failures are rows, not a failed call: one broken card must not erase
/// the other answers the user is waiting on.
#[tauri::command]
async fn repo_freshness_many(
    settings: tauri::State<'_, Settings>,
    slugs: Vec<String>,
    max_parallel: usize,
) -> Result<Vec<FreshnessManyRow>, String> {
    let mut rows: Vec<FreshnessManyRow> = slugs
        .into_iter()
        .map(|slug| FreshnessManyRow {
            slug,
            freshness: None,
        })
        .collect();

    // Cache hits cost nothing and are answered here, before any network work.
    let mut misses: Vec<usize> = Vec::new();
    for (i, row) in rows.iter_mut().enumerate() {
        match freshness_cached(&row.slug) {
            Some(f) => row.freshness = Some(f),
            None => misses.push(i),
        }
    }
    // The network ceiling (see the const's comment). Truncating by request order
    // keeps the answer deterministic.
    misses.truncate(FRESHNESS_MANY_FRESH_LIMIT);
    if misses.is_empty() {
        return Ok(rows);
    }

    let cfg = build_config(&settings);
    let runtime = bundled_runtime_dir();
    let planned: Vec<String> = misses.iter().map(|&i| rows[i].slug.clone()).collect();

    // Bounding `max_parallel` is not optional: an unbounded spawn here would turn
    // one IPC into exactly the burst the const exists to prevent. The workers pull
    // from a shared index, so a slow slug never blocks the ones behind it.
    let computed = tauri::async_runtime::spawn_blocking(move || {
        let width = if max_parallel == 0 {
            FRESHNESS_MANY_DEFAULT_PARALLEL
        } else {
            max_parallel
        }
        .min(planned.len());
        let results: std::sync::Mutex<Vec<Option<Result<Freshness, String>>>> =
            std::sync::Mutex::new((0..planned.len()).map(|_| None).collect());
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..width {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if i >= planned.len() {
                        break;
                    }
                    let r =
                        repo_freshness_blocking(cfg.clone(), runtime.clone(), planned[i].clone());
                    // Only completed answers are cached; a per-slug failure stays
                    // a row and is never pinned into the cache as if it were one.
                    if let Ok(f) = &r {
                        freshness_store(f);
                    }
                    if let Ok(mut slot) = results.lock() {
                        slot[i] = Some(r);
                    }
                });
            }
        });
        results.into_inner().unwrap_or_default()
    })
    .await
    .map_err(|e| format!("新鲜度批量任务异常: {e}"))?;

    // Every planned index is written before the scope closes, so `computed`
    // always carries one slot per miss.
    for (i, slot) in misses.iter().copied().zip(computed.into_iter()) {
        match slot {
            Some(Ok(f)) => rows[i].freshness = Some(f),
            Some(Err(e)) => {
                let slug = rows[i].slug.clone();
                rows[i].freshness = Some(unknown_freshness(slug, e));
            }
            // Cannot happen: the pool writes every index. Left explicit rather
            // than `unreachable!()` so a future refactor cannot turn a bug into
            // a panic on the user's wall.
            None => {}
        }
    }
    Ok(rows)
}

/// The working tree's git state, for the 清理/删除 confirmations (需求 8.3).
///
/// Runs three short `git` calls on a local repository; moved off the UI thread
/// so the modal dialog does not stall while the subprocesses complete. It
/// degrades to "git would not say" rather than failing - a status badge must
/// not be able to fail a delete.
#[tauri::command]
async fn repo_worktree_status(slug: String) -> Result<launch::WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
        Ok(launch::worktree_status(&repo))
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?
}

/// Every Python interpreter this machine offers (需求 8.5).
#[tauri::command]
async fn list_pythons() -> Vec<launch::PythonInstall> {
    tauri::async_runtime::spawn_blocking(|| launch::list_pythons())
        .await
        .unwrap_or_default()
}

/// Pins (or unpins, with an empty value) the interpreter one repository
/// launches with.
///
/// The choice is stored in `.devhub.json`, beside the venv and port fields, so
/// it travels with the repository rather than living in a global setting - the
/// same isolation model everything else here follows.
#[tauri::command]
async fn set_python_choice(slug: String, python: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
        let pin = python.trim().to_string();
        // The version is recorded beside the path. `Marker::python_version` was a
        // write-never field (`REQUIREMENTS.md` §3.6 names it), which is exactly why
        // 需求 8.5's version lock could be chosen but never verified afterwards; one
        // bounded probe makes the field real, and clearing the pin clears it too.
        let version = if pin.is_empty() {
            None
        } else {
            launch::interpreter_version(&pin)
        };
        let detail = if pin.is_empty() {
            "恢复默认（跟随虚拟环境/PATH）".to_string()
        } else {
            match &version {
                Some(v) => format!("{pin}（Python {v}）"),
                None => pin.clone(),
            }
        };
        downloader::update_marker(&repo, move |m| {
            m.python_choice = if pin.is_empty() { None } else { Some(pin) };
            m.python_version = version;
        })?;
        record_activity(
            Log::new("settings", "选择 Python 解释器", SRC_SETTINGS)
                .detail(&detail)
                .slug(&slug)
                .target(&format!("repo:{slug}")),
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?
}

/// Creates the repository's venv with the chosen interpreter (需求 8.6).
///
/// The venv lands in `项目\venvs\<slug>` - outside the repository, so
/// same-named repositories cannot collide - and the path is written into the
/// marker so every later launch finds it without re-deriving anything.
#[tauri::command]
async fn create_repo_venv(slug: String, python: String) -> Result<String, String> {
    let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
    // Validated before it can reach `Command::new`: this used to exec whatever string
    // the page sent, unchecked against the discovered interpreters and uncontained.
    let interpreter = launch::validate_interpreter(&python)?
        .to_string_lossy()
        .to_string();
    let venvs = project_root().join("venvs");
    let name = repo
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| slug.clone());
    let venv = venvs.join(&name);
    let slug_for_log = slug.clone();
    let venv_for_log = venv.clone();
    let result = tauri::async_runtime::spawn_blocking({
        let venv = venv.clone();
        let interpreter = interpreter.clone();
        move || launch::create_venv(&interpreter, &venv)
    })
    .await
    .map_err(|e| format!("创建任务异常: {e}"))?;
    match &result {
        Ok(()) => {
            // Record the version the environment actually runs, preferring the venv's
            // own interpreter and falling back to the one it was built from.
            let venv_python = venv.join("Scripts").join("python.exe");
            let version = launch::interpreter_version(&venv_python.to_string_lossy())
                .or_else(|| launch::interpreter_version(&interpreter));
            downloader::update_marker(&repo, |m| {
                m.venv_path = Some(venv.to_string_lossy().to_string());
                if version.is_some() {
                    m.python_version = version.clone();
                }
            })?;
            record_activity(
                Log::new("launch", "创建虚拟环境", SRC_LAUNCH)
                    .detail(&interpreter)
                    .slug(&slug_for_log)
                    .path(&venv_for_log),
            );
        }
        Err(e) => record_activity(
            Log::new("launch", "创建虚拟环境失败", SRC_LAUNCH)
                .detail(e)
                .slug(&slug_for_log),
        ),
    }
    result.map_err(|e| e.to_string())?;
    Ok(venv.to_string_lossy().to_string())
}

/// Forgets a `venv_path` the app did not create, without deleting it.
///
/// The environment is somebody else's directory — a conda env, a hand-made one, an
/// interpreter tree — and the only honest action is to stop pointing at it. This is
/// the branch that makes 「删除环境」 usable on a repository whose record drifted,
/// which is the state round 16's O1-3 is about.
fn forget_venv_record(repo: &std::path::Path, had_pin: bool) -> Result<launch::VenvReport, String> {
    downloader::update_marker(repo, move |m| {
        launch::clear_venv_record(m, had_pin);
    })?;
    Ok(launch::VenvReport {
        had_venv: false,
        removed_venv: false,
        record_only: true,
        freed_bytes: 0,
        to_bin: false,
        path: None,
        failed: Vec::new(),
    })
}

/// The opposite of [`create_repo_venv`] (round 16, O1-1).
///
/// `create_repo_venv` has existed since round 11 and its counterpart did not, so a
/// stale or half-built environment could only be got rid of in Explorer. That is
/// not a rare cosmetic case: `venv_for` filters on `looks_like_venv`, so a
/// directory whose `Scripts\python.exe` was moved away stops resolving for launch
/// while the marker still claims an environment exists — and the panel had no verb
/// for fixing the record, let alone the tree.
///
/// Containment is the whole safety story. [`launch::check_venv_target`] refuses
/// anything that is not exactly one level below `<root>\venvs`, so a marker
/// pointing at a conda environment or a system tree clears its record instead of
/// being deleted, and `<root>\venvs` itself can never be reached by an off-by-one.
///
/// Async: `dir_size` walks the whole tree and `remove_dir_all` on a venv (often
/// 300 MB of `site-packages`) is one of the longest filesystem operations here —
/// the same reason `delete_repo` had to move off the main thread.
#[tauri::command]
async fn remove_repo_venv(
    slug: String,
    mode: launch::VenvRemoval,
) -> Result<launch::VenvReport, String> {
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || remove_repo_venv_sync(slug, mode))
        .await
        .map_err(|e| format!("任务异常: {e}"))??;
    timing::report(
        "remove_repo_venv",
        started.elapsed().as_millis(),
        format_args!(
            "had={} removed={} record_only={} failed={}",
            out.had_venv,
            out.removed_venv,
            out.record_only,
            out.failed.len()
        ),
    );
    Ok(out)
}

fn remove_repo_venv_sync(
    slug: String,
    mode: launch::VenvRemoval,
) -> Result<launch::VenvReport, String> {
    let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let root = project_root();
    let marker = downloader::read_marker(&repo);
    let recorded = marker.as_ref().and_then(|m| m.venv_path.clone());
    let had_pin = marker
        .as_ref()
        .and_then(|m| m.python_choice.as_ref())
        .is_some();

    // `venv_for` is deliberately not consulted: it filters on `looks_like_venv`, and
    // a half-made environment is precisely the thing being cleaned up. Trusting it
    // here would report "nothing to do" for the one state the user is looking at.
    let candidate = recorded
        .as_deref()
        .map(std::path::Path::new)
        .map(|p| p.to_path_buf())
        .or_else(|| downloader::venv_dir_for(&root, &repo));

    let forget_only = matches!(mode, launch::VenvRemoval::ForgetRecord);
    let to_bin = matches!(mode, launch::VenvRemoval::ToBin);

    let report = match candidate {
        None => launch::VenvReport {
            had_venv: false,
            removed_venv: false,
            record_only: false,
            freed_bytes: 0,
            to_bin,
            path: None,
            failed: Vec::new(),
        },
        Some(path) if !path.exists() || forget_only => {
            // Either the directory is already gone (so the record is the only stale
            // thing left) or the user asked to keep the directory and drop the
            // pointer. Both clear the record and delete nothing.
            let mut r = forget_venv_record(&repo, had_pin)?;
            r.had_venv = path.exists();
            r.path = Some(crate::netpath::strip_verbatim(&path).to_string_lossy().to_string());
            r
        }
        Some(path) => {
            let target = launch::check_venv_target(&root, &path)?;
            let mut r = launch::remove_venv_dir(&target, to_bin);
            if r.removed_venv {
                downloader::update_marker(&repo, move |m| {
                    launch::clear_venv_record(m, had_pin);
                })?;
            } else if r.failed.is_empty() {
                // The shell said yes and the directory is still there. Keeping the
                // record and saying so beats clearing it: a marker that claims no
                // venv makes an environment that still exists invisible to every
                // later launch, which is the drift this command was built to fix.
                r.failed.push(format!(
                    "{} 删除命令返回成功但目录仍然存在，记录已保留",
                    target.display()
                ));
            }
            r
        }
    };

    let (title, detail) = if !report.failed.is_empty() {
        (
            "删除虚拟环境失败",
            format!("失败项：{}", report.failed.join("；")),
        )
    } else if report.removed_venv {
        (
            if to_bin {
                "删除虚拟环境（回收站）"
            } else {
                "删除虚拟环境"
            },
            format!(
                "释放 {}{}",
                human_bytes(report.freed_bytes),
                if to_bin { "（回退由 Windows 回收站负责）" } else { "" }
            ),
        )
    } else if report.record_only {
        (
            "清除虚拟环境记录",
            report
                .path
                .clone()
                .unwrap_or_else(|| "这条记录本来就没有指向任何环境".to_string()),
        )
    } else {
        (
            "虚拟环境本来不存在",
            "记录已清除，磁盘上没有可删除的目录".to_string(),
        )
    };
    record_activity(
        Log::new("delete", title, SRC_LAUNCH)
            .detail(&detail)
            .slug(&slug)
            .target(&format!("repo:{slug}"))
            .path(&repo)
            .undo(if report.removed_venv {
                activity::Undo::none(if to_bin {
                    "回收站里的还原由 Windows 负责；本应用只能重建一个空环境，已装的包不会回来"
                } else {
                    "永久删除的环境无法原样放回；「重建环境」会用同一个解释器新建空环境，依赖需要重装"
                })
            } else {
                activity::Undo::none(
                    "被清除的是记录里的环境路径；要恢复指向，请在项目设置里重新填写该路径",
                )
            }),
    );
    Ok(report)
}

/// Whether each of the repository's assigned ports answered (需求 8.9).
///
/// The launch dialog polls this after 一键启动: the output stream proves the
/// process started, and this proves it *served*. Both are needed, because
/// "started" and "usable" are different facts - a server that binds nothing
/// looks identical to a healthy one in the log.
#[tauri::command]
async fn repo_port_health(slug: String) -> Result<Vec<launch::PortHealth>, String> {
    // Async and off-thread: it resolves a repository directory (a walk), reads the
    // marker, and then blocks on TCP connects. As a synchronous command every one of
    // those happened on the window's thread while the launch dialog polled it.
    tauri::async_runtime::spawn_blocking(move || {
        let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
        let services = downloader::read_marker(&repo)
            .map(|m| m.services)
            .unwrap_or_default();
        Ok(launch::port_health(&services))
    })
    .await
    .map_err(|e| format!("端口健康任务异常: {e}"))?
}

/// Lists repositories already present under every configured project root.
///
/// Identity comes from each repository's `.devhub.json` marker, not from the
/// shape of its path: that is what lets the flat `<repo>_<owner>` layout, the
/// legacy `code/<host>/<owner>/<repo>` layout and a hand-copied directory all be
/// listed with their real owner and host.
///
/// Async, and that is the whole point of the timing line below: a **synchronous**
/// command runs on the main thread, so the reported "项目页卡顿、未响应" was this
/// walk blocking the window. It now runs through [`repo_index`], which means the
/// walk happens once per change rather than once per refresh - but it is still
/// async, because the first call after a change *does* walk.
///
/// `force` is the 刷新 button: it rewrites both levels of the index even when the
/// container stamps say nothing changed, which is the documented answer to a
/// repository whose `.devhub.json` was edited outside the app.
#[tauri::command]
async fn list_repositories(force: Option<bool>) -> Result<Vec<RepoRef>, String> {
    let started = std::time::Instant::now();
    let roots = project_roots();
    let force = force.unwrap_or(false);
    let (index, origin) = tauri::async_runtime::spawn_blocking(move || {
        let (index, origin) = repo_index::load(&roots, force);
        (index.repos(), origin)
    })
    .await
    .map_err(|e| format!("扫描仓库任务异常: {e}"))?;
    timing::report(
        "list_repositories",
        started.elapsed().as_millis(),
        format_args!("count={} source={}", index.len(), origin.label()),
    );
    Ok(index)
}

/// Removes a legacy GitHub token that older builds embedded in a clone's
/// `origin` URL, and returns how many repositories were rewritten.
///
/// The pre-r27 downloader cloned with `https://x-access-token:<token>@github.com/…`,
/// and `git clone` persists that URL verbatim in `.git/config`. New clones use a
/// per-invocation, scoped `Authorization` header instead, but existing clones keep
/// the credential on disk until this pass runs. It is idempotent and cheap (one
/// `git remote get-url` + one `set-url` only for repositories whose origin still
/// matches a credential DevHub could have written), so startup runs it in the
/// background and reports the count.
#[tauri::command]
async fn scrub_stored_credentials() -> Result<u32, String> {
    let roots = project_roots();
    let runtime = bundled_runtime_dir();
    tauri::async_runtime::spawn_blocking(move || -> u32 {
        let Some(git) = downloader::find_git(runtime.as_deref()) else {
            return 0;
        };
        let git_path = PathBuf::from(&git.path);
        let (index, _) = repo_index::load(&roots, false);
        let mut rewritten = 0u32;
        for repo in index.repos() {
            let Some(path) = repo.path.as_deref() else {
                continue;
            };
            let p = std::path::Path::new(path);
            if !p.join(".git").exists() {
                continue;
            }
            match downloader::scrub_origin_credentials(&git_path, p) {
                Ok(Some(_)) => {
                    rewritten += 1;
                    println!("[credentials] scrubbed origin in {path}");
                }
                Ok(None) => {}
                Err(e) => eprintln!("[credentials] {path}: {e}"),
            }
        }
        rewritten
    })
    .await
    .map_err(|e| format!("凭据清理任务异常: {e}"))
}

/// Locally-derived facts for every repository on the wall (round 9, 需求 1).
///
/// Deliberately **not** folded into `list_repositories`: a size walk is
/// I/O-bound and takes seconds on a container that also holds build trees, and
/// the wall must paint before it finishes. The frontend asks for this once the
/// tiles are up and fills the labels in as answers arrive; results are cached
/// in-process (see `metadata::cached`) and `force` - what 刷新 sends -
/// recomputes them.
#[tauri::command]
async fn repo_metadata(force: Option<bool>) -> Result<Vec<metadata::RepoMeta>, String> {
    let started = std::time::Instant::now();
    let force = force.unwrap_or(false);
    let roots = project_roots();
    let out = tauri::async_runtime::spawn_blocking(move || {
        // Never forced: this command must not be the reason a wall refresh
        // re-walks the container. The index has its own validity rules.
        let (index, _origin) = repo_index::load(&roots, false);
        index
            .repos()
            .iter()
            .map(|r| metadata::cached(&r.slug(), r.path.as_deref().map(std::path::Path::new), force))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("元数据计算任务异常: {e}"))?;
    timing::report(
        "repo_metadata",
        started.elapsed().as_millis(),
        format_args!("count={} force={}", out.len(), force),
    );
    Ok(out)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Headless smoke test: `devhub-app.exe --clone <owner/repo>` downloads for real,
/// prints which layer succeeded, and exits. Used to verify the four-layer
/// fallback without driving the GUI.
pub fn run_headless_clone(input: &str) -> i32 {
    let mut cfg = DownloaderConfig {
        project_root: project_root(),
        ..Default::default()
    };
    apply_env_overrides(&mut cfg);
    let dl = match Downloader::new(cfg, bundled_runtime_dir()) {
        Ok(d) => d,
        Err(e) => {
            println!("ERROR {e}");
            return 2;
        }
    };
    println!("project_root = {}", project_root().display());
    println!("git          = {} ({})", dl.git.version, dl.git.source);
    let printer: downloader::ProgressFn =
        std::sync::Arc::new(|stage: &str, msg: &str| println!("[{stage}] {msg}"));
    match dl.download(printer, input) {
        Ok(outcome) => {
            println!("OK layer={:?}", outcome.layer);
            println!("path={}", outcome.path);
            println!("via_third_party={}", outcome.via_third_party);
            println!("degraded={}", outcome.degraded);
            for a in &outcome.attempts {
                println!("  attempt {} ok={} {}ms {}", a.label, a.ok, a.ms, a.detail);
            }
            0
        }
        Err(e) => {
            println!("ERROR {e}");
            1
        }
    }
}

/// Ensures a usable git exists, bootstrapping a portable copy when needed.
///
/// This is long-running (measured: 14 s download + ~165 s extraction), so it
/// runs off the async worker threads and streams progress to the UI.
#[tauri::command]
async fn ensure_git(app: tauri::AppHandle) -> Result<gitboot::BootstrapOutcome, String> {
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, message: &str| {
        let _ = app.emit(
            "git-bootstrap://progress",
            serde_json::json!({ "stage": stage, "message": message }),
        );
    });
    let runtime = bundled_runtime_dir().ok_or("无法确定应用运行时目录")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        gitboot::ensure_portable_git(sink, &runtime, 900)
    })
    .await
    .map_err(|e| format!("内置 Git 安装任务异常: {e}"))?;

    // A git has just appeared. Without this the memoised "no git" answer from
    // before the install would survive for the rest of the session, and the app
    // would keep claiming git is missing right after installing it.
    downloader::reset_git_cache();
    result
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBootstrapStatus {
    /// A bundled git already exists at the runtime location.
    bundled: bool,
    bundled_path: String,
    runtime_dir: String,
    marker: Option<gitboot::GitBootstrapMarker>,
}

#[tauri::command]
fn git_bootstrap_status() -> GitBootstrapStatus {
    let runtime = bundled_runtime_dir().unwrap_or_default();
    GitBootstrapStatus {
        bundled: gitboot::is_bootstrapped(&runtime),
        bundled_path: gitboot::bundled_git_exe(&runtime)
            .to_string_lossy()
            .to_string(),
        runtime_dir: runtime.to_string_lossy().to_string(),
        marker: gitboot::read_marker(&runtime),
    }
}

/// Headless bootstrap: `devhub-app.exe --ensure-git [runtime-dir]` installs a
/// portable git (or reuses one), prints the outcome, and exits.
pub fn run_headless_ensure_git(runtime_override: Option<String>) -> i32 {
    let runtime = match runtime_override {
        Some(p) => PathBuf::from(p),
        None => match bundled_runtime_dir() {
            Some(p) => p,
            None => {
                println!("ERROR 无法确定运行时目录");
                return 2;
            }
        },
    };
    println!("runtime = {}", runtime.display());
    let printer: downloader::ProgressFn =
        std::sync::Arc::new(|stage: &str, msg: &str| println!("[{stage}] {msg}"));
    match gitboot::ensure_portable_git(printer, &runtime, 900) {
        Ok(outcome) => {
            println!("OK reused={}", outcome.reused);
            println!("tag={}", outcome.tag);
            println!("version={}", outcome.version);
            println!("bytes={}", outcome.bytes);
            println!("via_mirror={:?}", outcome.via_mirror);
            println!("git_path={}", outcome.git_path);
            // Prove the result is actually usable, not just present.
            match proc::silent(&outcome.git_path).arg("--version").output() {
                Ok(o) => println!("probe={}", String::from_utf8_lossy(&o.stdout).trim()),
                Err(e) => println!("probe=FAILED {e}"),
            }
            0
        }
        Err(e) => {
            println!("ERROR {e}");
            1
        }
    }
}

/// Headless git discovery: `devhub-app.exe --find-git [runtime-dir]`.
/// Reports which git the downloader would actually use, and where it came from.
pub fn run_headless_find_git(runtime_override: Option<String>) -> i32 {
    let runtime = runtime_override
        .map(PathBuf::from)
        .or_else(bundled_runtime_dir);
    println!(
        "runtime = {:?}",
        runtime.as_ref().map(|p| p.display().to_string())
    );
    match find_git(runtime.as_deref()) {
        Some(g) => {
            println!("OK source={}", g.source);
            println!("path={}", g.path);
            println!("version={}", g.version);
            0
        }
        None => {
            println!("NONE 未找到任何可用 git");
            1
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Environments {
    python: Option<String>,
    node: Option<String>,
    docker: Option<String>,
    vscode: Option<String>,
}

/// Which external tools a detected repository would need, so the UI can say
/// "this project needs Node, which is not installed" instead of failing later.
///
/// A plain function, not a command: it is registered in `generate_handler!` by
/// nothing, and its only caller is [`repo_environments`], which runs it on a worker
/// thread. Making it `async` here would have been a change nothing could call.
fn detect_environments(path: String) -> Result<Environments, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let has = |names: &[&str]| names.iter().any(|n| dir.join(n).exists());

    Ok(Environments {
        python: if has(&[
            "requirements.txt",
            "pyproject.toml",
            "manage.py",
            "app.py",
            "uv.lock",
            "Pipfile",
            "poetry.lock",
        ]) {
            which_on_path("python")
        } else {
            None
        },
        node: if has(&["package.json"]) {
            which_on_path("node")
        } else {
            None
        },
        docker: if has(&["docker-compose.yml", "compose.yaml", "Dockerfile"]) {
            which_on_path("docker")
        } else {
            None
        },
        vscode: which_on_path("code"),
    })
}

/// Looks up an executable on PATH, returning its resolved location.
///
/// Delegates to [`launch::which_one`], which memoises: this is called up to four
/// times per 启动面板 open, and each call used to walk every `PATH` directory.
fn which_on_path(name: &str) -> Option<String> {
    let spelled: Vec<String> = ["", ".exe", ".cmd", ".bat"]
        .iter()
        .map(|ext| format!("{name}{ext}"))
        .collect();
    let refs: Vec<&str> = spelled.iter().map(|s| s.as_str()).collect();
    launch::which_one(&refs)
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/// A repository the UI can act on: its absolute path plus stored config.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoDetail {
    slug: String,
    path: String,
    launch: Option<launch::LaunchConfig>,
    /// What the 项目设置 panel shows and edits. Every one of these lives in the
    /// repository's own `.devhub.json`, so it travels with the clone and disappears
    /// when the clone does - which is the split the 设置 layer was designed around.
    url: String,
    port_base: u16,
    venv_path: Option<String>,
    stepwise: Option<bool>,
    terminal_choice: Option<String>,
    ide_choice: Option<String>,
    /// Which interpreter this repository pins (需求 8.5). Read back here so 项目设置
    /// can show the choice that `set_python_choice` wrote - a select that always
    /// renders "跟随默认" next to a marker that says otherwise is a lie of omission.
    python_choice: Option<String>,
    /// Whether that recorded path is *actually* an environment, or whether one is
    /// sitting unrecorded in `项目\venvs`. The panel used to render `venv_path` and
    /// nothing else, which made a moved-or-half-built environment look healthy —
    /// while `venv_for`, which filters on `looks_like_venv`, had already stopped
    /// using it for launch. Two surfaces, two different truths, no way to notice.
    venv_state: launch::VenvState,
    /// Where `create_repo_venv` would put a new environment for this repository.
    venv_dir: Option<String>,
    /// The branch the clone was asked to check out (r27-N1). `None` = the
    /// remote's default branch, including every marker written before r27.
    branch: Option<String>,
}

/// Resolves a repository's detail. Runs on a worker thread - see [`repo_detail`].
fn repo_detail_sync(slug: &str) -> Result<RepoDetail, String> {
    let repo = find_repo_any(slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let marker = downloader::read_marker(&repo);
    let root = project_root();
    let recorded = marker
        .as_ref()
        .and_then(|m| m.venv_path.clone())
        .map(std::path::PathBuf::from);
    let expected = downloader::venv_expected_dir(&root, &repo);
    Ok(RepoDetail {
        slug: repo
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| slug.to_string()),
        path: repo.to_string_lossy().to_string(),
        launch: marker.as_ref().and_then(|m| m.launch.clone()),
        url: marker.as_ref().map(|m| m.url.clone()).unwrap_or_default(),
        port_base: marker.as_ref().map(|m| m.port_base).unwrap_or(0),
        venv_path: recorded.as_ref().map(|p| p.to_string_lossy().to_string()),
        venv_state: launch::classify_venv(recorded.as_deref(), expected.as_deref()),
        venv_dir: expected
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        stepwise: marker.as_ref().and_then(|m| m.stepwise),
        terminal_choice: marker.as_ref().and_then(|m| m.terminal_choice.clone()),
        ide_choice: marker.as_ref().and_then(|m| m.ide_choice.clone()),
        python_choice: marker.as_ref().and_then(|m| m.python_choice.clone()),
        branch: marker.as_ref().and_then(|m| m.branch.clone()),
    })
}

/// The 启动面板 and 项目设置 both ask for this as their first call.
///
/// Async because `find_repo_any` answers from the index but re-walks the container
/// when the index is cold or has been rejected; as a synchronous command that walk
/// ran on the main thread, and the dialog could not paint while it did.
#[tauri::command]
async fn repo_detail(slug: String) -> Result<RepoDetail, String> {
    tauri::async_runtime::spawn_blocking(move || repo_detail_sync(&slug))
        .await
        .map_err(|e| format!("读取项目详情失败: {e}"))?
}

/// The per-repository launch defaults the 项目设置 panel writes.
///
/// `None` means "leave this field alone", which is what keeps a panel that only
/// changed the terminal from clearing the IDE override.
///
/// Two deliberate asymmetries:
///   - `port_base` has no "clear". A repository without a block cannot be handed a
///     port at launch, so the only honest offer is "move it to another free block".
///   - `venv_path` clears the *record*, never the directory. Deleting an environment
///     is 启动面板's 清理 venv action, and two places holding the same delete is how
///     somebody loses work they did not ask to lose.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoLaunchDefaults {
    stepwise: Option<Option<bool>>,
    terminal_choice: Option<Option<String>>,
    ide_choice: Option<Option<String>>,
    port_base: Option<u16>,
    venv_path: Option<Option<String>>,
}

/// Writes the per-repository launch defaults into that repository's marker.
///
/// Async for the same reason as [`repo_detail`], plus one of its own: a hand-picked
/// port block is checked against every repository's marker in every configured
/// root, which is a walk of its own.
#[tauri::command]
async fn set_repo_launch_defaults(
    slug: String,
    value: RepoLaunchDefaults,
) -> Result<RepoDetail, String> {
    tauri::async_runtime::spawn_blocking(move || set_repo_launch_defaults_sync(&slug, value))
        .await
        .map_err(|e| format!("项目设置写入任务异常: {e}"))?
}

fn set_repo_launch_defaults_sync(
    slug: &str,
    value: RepoLaunchDefaults,
) -> Result<RepoDetail, String> {
    let repo = find_repo_any(slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;

    // Resolved before anything is written: a rejected port block must not leave the
    // terminal override saved and the port unchanged, half-applied.
    let block = match value.port_base {
        Some(base) => Some(downloader::claim_port_block(
            &project_roots(),
            base,
            &repo,
        )?),
        None => None,
    };
    let venv = match value.venv_path {
        Some(Some(ref p)) => {
            let dir = PathBuf::from(p.trim());
            if dir.as_os_str().is_empty() {
                return Err("没有选择虚拟环境目录".to_string());
            }
            if !downloader::looks_like_venv(&dir) {
                return Err(format!(
                    "这里不像一个虚拟环境，找不到 pyvenv.cfg 或 python 解释器：{}",
                    dir.display()
                ));
            }
            Some(Some(dir.to_string_lossy().to_string()))
        }
        Some(None) => Some(None),
        None => None,
    };

    downloader::update_marker(&repo, |m| {
        // A hand-copied directory has no marker until someone opens 项目设置, and
        // `update_marker` starts from `Marker::default()`. Filling the identity keeps
        // the written file meaningful instead of a `.devhub.json` with nothing in it.
        if m.slug.is_empty() {
            m.slug = slug.to_string();
        }
        if let Some(v) = value.stepwise {
            m.stepwise = v;
        }
        if let Some(v) = value.terminal_choice {
            m.terminal_choice = v.filter(|s| !s.trim().is_empty());
        }
        if let Some(v) = value.ide_choice {
            m.ide_choice = v.filter(|s| !s.trim().is_empty());
        }
        if let Some(b) = &block {
            m.port_base = b.base;
            // The named assignments are derived from the block, so a moved block
            // rewrites them: leaving the old names pointing at the old numbers is
            // how `DEVHUB_PORT_HTTP` ends up being a port nobody reserved.
            m.services = b.services.clone();
        }
        if let Some(v) = venv {
            m.venv_path = v;
        }
    })
    .map_err(|e| format!("无法保存项目设置: {e}"))?;
    record_activity(
        Log::new("setting", "修改项目启动默认值", SRC_LAUNCH)
            .slug(slug)
            .target(&format!("repo:{slug}"))
            .path(&repo),
    );
    repo_detail_sync(slug)
}

/// Proposes launch commands with evidence. Never executes anything.
///
/// Async because it opens a dozen files inside the repository; as a synchronous
/// command that ran on the main thread, so the panel could not paint while it did.
/// Classifies user-editable launch commands without touching the disk.
///
/// `detect_launch` already attaches risks to its candidates; this command is for
/// the step editor and the pre-launch gate, where the commands are whatever the
/// user typed. Pure and synchronous on purpose: the classifier is regex over a
/// short string, and making the caller await an IPC round trip per keystroke
/// would be worse than not showing the warning live.
#[tauri::command]
fn assess_launch_commands(commands: Vec<String>) -> Vec<Vec<launch_risk::RiskHit>> {
    commands.iter().map(|c| launch_risk::classify(c)).collect()
}

#[tauri::command]
async fn detect_launch_commands(slug: String) -> Result<launch::DetectionReport, String> {
    let started = std::time::Instant::now();
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let out = tauri::async_runtime::spawn_blocking(move || launch::detect_launch(&repo))
        .await
        .map_err(|e| format!("启动命令检测任务异常: {e}"))?;
    timing::report(
        "detect_launch_commands",
        started.elapsed().as_millis(),
        format_args!(
            "candidates={} inspected={} notes={}",
            out.candidates.len(),
            out.inspected.len(),
            out.notes.len()
        ),
    );
    Ok(out)
}

/// Builds the 装依赖 step for one repository: the exact command plus the files
/// that justify it (需求 8.4).
///
/// It **only** plans. Running it stays on the existing confirmed-step path
/// (`confirm_launch_steps` then `launch_step`), because REQUIREMENTS §3.2 makes the
/// user's confirmation the correctness guarantee: an app that installed silently
/// would be guessing at a manifest it cannot verify, and a wrong `pip install` into
/// someone's environment is not a reversible mistake.
#[tauri::command]
async fn install_plan(slug: String) -> Result<Option<launch::InstallPlan>, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        // The environment the plan should install *into*, when there is one:
        // `venv_for` yields only a directory that really is an environment.
        let venv = venv_for(&repo);
        launch::install_plan_for(&repo, venv.as_deref())
    })
        .await
        .map_err(|e| format!("依赖检测任务异常: {e}"))
}

/// Persists the user-confirmed command (single-step form).
///
/// Async: it re-resolves the repository and rewrites its marker, which is disk work a
/// synchronous command did on the main thread while the panel was trying to paint.
#[tauri::command]
async fn confirm_launch(slug: String, command: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || confirm_launch_sync(slug, command, cwd))
        .await
        .map_err(|e| format!("保存启动配置任务异常: {e}"))?
}

fn confirm_launch_sync(slug: String, command: String, cwd: String) -> Result<(), String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    // Read the previous config *before* overwriting it: the record's diff line
    // and its 回退 both need the real 前值, the same reasoning as
    // `confirm_launch_steps`.
    let previous = downloader::read_marker(&repo)
        .and_then(|m| m.launch)
        .map(|l| (l.command.clone(), l.cwd.clone()));
    let cfg = launch::LaunchConfig {
        command,
        cwd,
        user_confirmed: true,
        kind: None,
        steps: Vec::new(),
    };
    let recorded = cfg.command.clone();
    downloader::update_marker(&repo, |m| m.launch = Some(cfg))
        .map_err(|e| format!("无法保存启动配置: {e}"))?;
    let undo = match &previous {
        None => activity::Undo::none("这是第一次确认启动命令，没有更早的版本可回退"),
        Some(prev) => activity::Undo::value(
            "launch",
            &slug,
            &serde_json::json!({ "command": prev.0, "cwd": prev.1 }).to_string(),
        ),
    };
    record_activity(
        Log::new("launch", "修改启动命令", SRC_LAUNCH)
            .detail(&recorded)
            .slug(&slug)
            .target(&format!("launch.command:{slug}"))
            .change(
                &previous.as_ref().map(|p| p.0.clone()).unwrap_or_else(|| "（首次确认）".to_string()),
                &recorded,
            )
            .undo(undo)
            .path(&repo),
    );
    Ok(())
}

/// Persists a multi-step launch configuration.
///
/// `command` is also written (as the first step's command) so a marker read by
/// an older build still shows something meaningful.
///
/// Async for the same reason as [`confirm_launch_sync`]: resolve, read, rewrite.
#[tauri::command]
async fn confirm_launch_steps(
    slug: String,
    steps: Vec<launch::LaunchStep>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || confirm_launch_steps_sync(slug, steps))
        .await
        .map_err(|e| format!("保存启动步骤任务异常: {e}"))?
}

fn confirm_launch_steps_sync(slug: String, steps: Vec<launch::LaunchStep>) -> Result<(), String> {
    if steps.is_empty() {
        return Err("至少需要一个启动步骤".to_string());
    }
    for s in &steps {
        if s.command.trim().is_empty() {
            return Err("启动步骤的命令不能为空".to_string());
        }
    }
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let first_cwd = steps[0].cwd.clone();
    let cfg = launch::LaunchConfig {
        command: steps[0].command.clone(),
        cwd: first_cwd,
        user_confirmed: true,
        kind: None,
        steps: steps.clone(),
    };
    let summary = steps
        .iter()
        .map(|s| {
            let mode = if s.parallel { "并行" } else { "顺序" };
            let name = if s.name.trim().is_empty() { &s.command } else { &s.name };
            format!("[{mode}] {name}")
        })
        .collect::<Vec<_>>()
        .join(" → ");
    // Read the previous list *before* overwriting it, so the record can carry a
    // real 前值. Without this the 回退 button on "修改启动步骤列表" would have
    // nothing to go back to, which is exactly what the report asked for.
    let previous_steps = downloader::read_marker(&repo)
        .and_then(|m| m.launch)
        .map(|l| serde_json::to_string(&l.steps).unwrap_or_default())
        .unwrap_or_default();
    downloader::update_marker(&repo, |m| m.launch = Some(cfg))
        .map_err(|e| format!("无法保存启动配置: {e}"))?;
    record_activity(
        Log::new("launch", "修改启动步骤列表", SRC_LAUNCH)
            .detail(&summary)
            .slug(&slug)
            .target(&format!("launch.steps:{slug}"))
            .change(
                &if previous_steps.is_empty() { "（首次确认）".to_string() } else { previous_steps.clone() },
                &summary,
            )
            .undo(if previous_steps.is_empty() {
                activity::Undo::none("这是第一次确认启动命令，没有更早的版本可回退")
            } else {
                activity::Undo::value("steps", &slug, &previous_steps)
            })
            .path(&repo),
    );
    Ok(())
}

/// Builds the isolation environment for a repo: its venv and its port block.
fn launch_env_for(repo: &std::path::Path) -> launch::LaunchEnv {
    let marker = downloader::read_marker(repo);
    let mut env = launch::LaunchEnv::default();

    // Venv lives outside the repo, named after the slug.
    if let Some(m) = &marker {
        if let Some(v) = &m.venv_path {
            let p = PathBuf::from(v);
            if p.is_dir() {
                env.venv = Some(p);
            }
        }
    }
    if env.venv.is_none() {
        // Fall back to deriving it from the repository's directory name - but only
        // when that derived directory actually looks like an environment. The
        // unguarded version reported `VIRTUAL_ENV=<a path that does not exist>` and
        // prepended a non-existent `Scripts` to PATH, so a project that never had a
        // venv launched claiming it was inside one (需求 8.5's whole point is that
        // the environment is explicit, and `looks_like_venv` already exists to say
        // whether one is there).
        let derived = downloader::venv_dir_for(&project_root(), repo);
        env.venv = derived.filter(|p| downloader::looks_like_venv(p));
    }
    // The pinned interpreter's directory (需求 8.5), resolved through its own
    // path rather than a bare name so a stale pin cannot silently resolve to a
    // different python than the one the user chose.
    if let Some(m) = &marker {
        env.ports = m.services.clone();
        if let Some(pin) = &m.python_choice {
            let p = PathBuf::from(pin);
            let dir = if p.is_file() {
                p.parent().map(std::path::Path::to_path_buf)
            } else if p.is_dir() {
                Some(p.clone())
            } else {
                None
            };
            env.python_dir = dir;
        }
    }
    env
}

#[tauri::command]
async fn launch_repo(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    slug: String,
) -> Result<launch::LaunchStarted, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let marker = downloader::read_marker(&repo);
    let cfg = marker
        .as_ref()
        .and_then(|m| m.launch.clone())
        .ok_or("该仓库还没有确认过启动命令")?;
    let env = launch_env_for(&repo);

    let notifier = process_events::ProcessNotifier::new(app.clone(), &settings);
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, message: &str| {
        let _ = app.emit(
            "launch://progress",
            serde_json::json!({ "stage": stage, "message": message }),
        );
    });

    let steps = cfg.effective_steps();
    let spawn_sink = make_spawn_sink(notifier, slug.clone());
    if steps.len() <= 1 {
        let started = launch::launch_run(sink, &repo, &cfg, &env, &spawn_sink)?;
        record_activity(
            Log::new("launch", "一键启动", SRC_LAUNCH)
                .detail(&started.command)
                .slug(&slug)
                .path(&repo),
        );
        return Ok(started);
    }

    // Multi-step: sequential steps wait on each other, so run the whole list on
    // a blocking worker and report through the same progress stream.
    let repo2 = repo.clone();
    let sink2 = sink.clone();
    let step_count = steps.len();
    let report = tauri::async_runtime::spawn_blocking(move || {
        launch::launch_steps_all(sink2, &repo2, &steps, &env, &spawn_sink)
    })
    .await
    .map_err(|e| format!("启动任务异常: {e}"))?;

    let detail = format!(
        "{} 步：启动 {} 步，失败 {} 步",
        step_count,
        report.started.len(),
        report.failed.len()
    );
    record_activity(
        Log::new("launch", "一键启动（多步）", SRC_LAUNCH)
            .detail(&detail)
            .slug(&slug)
            .path(&repo),
    );

    // The first started step gives the UI something concrete to show.
    Ok(launch::LaunchStarted {
        pid: 0,
        command: report
            .started
            .first()
            .cloned()
            .unwrap_or_else(|| "（无已启动步骤）".to_string()),
        cwd: repo.to_string_lossy().to_string(),
    })
}

/// Runs one step of the configured list, on its own.
///
/// Async: it resolves the repository on disk and spawns a process, and a
/// synchronous command runs that on the main thread.
#[tauri::command]
async fn launch_step(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    slug: String,
    index: u32,
) -> Result<launch::LaunchStarted, String> {
    // Blocking work on a worker thread, same reason as `launch_steps_all` below:
    // `find_repo_any` can cold-start a repo-index walk, `read_marker` and
    // `record_activity` are file I/O, and `launch_single_step` spawns a process.
    // None of that belongs on an async-runtime worker; the UI's modal 步骤
    // dialog waited on all of it.
    let notifier = process_events::ProcessNotifier::new(app.clone(), &settings);
    tauri::async_runtime::spawn_blocking(move || -> Result<launch::LaunchStarted, String> {
        let repo = find_repo_any(&slug)
            .ok_or_else(|| format!("未找到仓库: {slug}"))?;
        let marker = downloader::read_marker(&repo);
        let cfg = marker
            .as_ref()
            .and_then(|m| m.launch.clone())
            .ok_or("该仓库还没有确认过启动命令")?;
        let steps = cfg.effective_steps();
        let step = steps
            .get(index as usize)
            .ok_or_else(|| format!("步骤序号超出范围: {index}（共 {} 步）", steps.len()))?;
        let env = launch_env_for(&repo);

        let sink: downloader::ProgressFn =
            std::sync::Arc::new(move |stage: &str, message: &str| {
                let _ = app.emit(
                    "launch://progress",
                    serde_json::json!({ "stage": stage, "message": message }),
                );
            });
        let spawn_sink = make_spawn_sink(notifier, slug.clone());
        let started = launch::launch_single_step(sink, &repo, step, &env, &spawn_sink)?;
        record_activity(
            Log::new("launch", "执行单个启动步骤", SRC_LAUNCH)
                .detail(&format!("第 {} 步：{}", index + 1, step.command))
                .slug(&slug)
                .path(&repo),
        );
        Ok(started)
    })
    .await
    .map_err(|e| format!("启动步骤任务异常: {e}"))?
}

/// Runs the whole step list without requiring a confirmed marker write first —
/// used by the edit preview so unsaved steps can be tried.
#[tauri::command]
async fn launch_steps_all(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    slug: String,
    steps: Vec<launch::LaunchStep>,
) -> Result<launch::StepsRunReport, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let env = launch_env_for(&repo);
    let notifier = process_events::ProcessNotifier::new(app.clone(), &settings);
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, message: &str| {
        let _ = app.emit(
            "launch://progress",
            serde_json::json!({ "stage": stage, "message": message }),
        );
    });
    // Captured before the move: `repo` goes into the blocking worker.
    let repo_path = repo.to_string_lossy().to_string();
    let step_count = steps.len();
    let spawn_sink = make_spawn_sink(notifier, slug.clone());
    let report = tauri::async_runtime::spawn_blocking(move || {
        launch::launch_steps_all(sink, &repo, &steps, &env, &spawn_sink)
    })
    .await
    .map_err(|e| format!("启动任务异常: {e}"))?;
    record_activity(
        Log::new("launch", "执行全部启动步骤", SRC_LAUNCH)
            .detail(&format!(
                "{} 步：启动 {} 步，失败 {} 步",
                step_count,
                report.started.len(),
                report.failed.len()
            ))
            .slug(&slug)
            .path_str(&repo_path),
    );
    Ok(report)
}

fn empty_launch_cfg() -> launch::LaunchConfig {
    launch::LaunchConfig {
        command: String::new(),
        cwd: String::new(),
        user_confirmed: false,
        kind: None,
        steps: Vec::new(),
    }
}

#[tauri::command]
async fn open_terminal_with(slug: String, kind: String) -> Result<launch::LaunchStarted, String> {
    tauri::async_runtime::spawn_blocking(move || open_terminal_with_sync(slug, kind))
        .await
        .map_err(|e| format!("打开终端任务异常: {e}"))?
}

fn open_terminal_with_sync(slug: String, kind: String) -> Result<launch::LaunchStarted, String> {
    // The pick itself is the preference: choosing once from the dropdown makes
    // that terminal the default for the plain button everywhere else. A failed
    // write is ignored, as it always was — opening a terminal must not depend on
    // being able to write the config — but it is now one gated span, so the
    // stamped choice cannot land on top of a concurrent settings save.
    let _ = update_config_if_changed(|cfg| {
        if cfg.terminal_choice == kind {
            false
        } else {
            cfg.terminal_choice = kind.clone();
            true
        }
    });
    open_terminal_kind(&slug, &kind)
}

#[tauri::command]
async fn open_ide_with(slug: String, id: String) -> Result<launch::LaunchStarted, String> {
    tauri::async_runtime::spawn_blocking(move || open_ide_with_sync(slug, id))
        .await
    .map_err(|e| format!("打开 IDE 任务异常: {e}"))?
}

fn open_ide_with_sync(slug: String, id: String) -> Result<launch::LaunchStarted, String> {
    // Same as `open_terminal_with_sync`: the pick is the preference, written as
    // one gated read-modify-write and never fatal to the launch itself.
    let _ = update_config_if_changed(|cfg| {
        if cfg.ide_choice == id {
            false
        } else {
            cfg.ide_choice = id.clone();
            true
        }
    });
    open_ide_id(&slug, &id)
}

fn open_terminal_kind(slug: &str, kind: &str) -> Result<launch::LaunchStarted, String> {
    let repo = find_repo_any(slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let marker = downloader::read_marker(&repo);
    let cfg = marker
        .as_ref()
        .and_then(|m| m.launch.clone())
        .unwrap_or_else(empty_launch_cfg);
    let env = launch_env_for(&repo);
    let effective = kind.trim().is_empty().then_some("pwsh").unwrap_or(kind);
    let started = launch::launch_terminal_with(&repo, &cfg, &env, effective)?;
    record_activity(
        Log::new("terminal", "打开终端", SRC_LAUNCH)
            .detail(effective)
            .slug(slug)
            .path(&repo),
    );
    Ok(started)
}

fn open_ide_id(slug: &str, id: &str) -> Result<launch::LaunchStarted, String> {
    let repo = find_repo_any(slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let id = if id.trim().is_empty() { "vscode" } else { id };
    let tools = ides_now();
    let tool = tools
        .iter()
        .find(|t| t.id == id)
        .or_else(|| tools.first())
        .ok_or("没有检测到可用的 IDE。可在「设置 → 编辑器与 IDE」里手动指定一个可执行文件。")?;
    let started = launch::launch_ide_with(&repo, tool)?;
    record_activity(
        Log::new("ide", "打开 IDE", SRC_LAUNCH)
            .detail(&match &tool.path {
                Some(p) => format!("{}（{}）", tool.label, p),
                None => tool.label.clone(),
            })
            .slug(slug)
            .path(&repo),
    );
    Ok(started)
}

/// Memoised terminal inventory; same reasoning as [`IDE_CACHE`].
static TERMINAL_CACHE: std::sync::Mutex<Option<Vec<launch::ToolInfo>>> =
    std::sync::Mutex::new(None);

/// Serialises the enumeration so four callers arriving together pay one `wsl`
/// subprocess instead of four.
static TERMINAL_DETECT: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn cached_terminals() -> Option<Vec<launch::ToolInfo>> {
    TERMINAL_CACHE.lock().ok()?.clone()
}

/// Terminals actually present on this machine, for the dropdown.
///
/// Async deliberately: detection spawns `wsl -l -q`, which is blocking. A
/// synchronous command runs on the main thread and freezes the window - the
/// documented lesson from the environment probe.
///
/// Memoised like [`list_ides`]. The PATH lookups inside it were already cached, but
/// the WSL enumeration behind them is a subprocess, so every 启动面板 open, 设置 open
/// and 项目设置 open paid a fresh `wsl -l -q` - while the panel's own comment claimed
/// this command was memoised. A machine fact that only changes when something is
/// installed does not need to be re-asked three times a session; `refresh` is the
/// explicit override.
#[tauri::command]
async fn list_terminals(refresh: Option<bool>) -> Result<Vec<launch::ToolInfo>, String> {
    let started = std::time::Instant::now();
    let force = refresh.unwrap_or(false);
    if !force {
        if let Some(hit) = cached_terminals() {
            timing::report(
                "list_terminals",
                started.elapsed().as_millis(),
                format_args!("count={} source=cache", hit.len()),
            );
            return Ok(hit);
        }
    }
    let out = tauri::async_runtime::spawn_blocking(move || {
        let _detect_guard = TERMINAL_DETECT.lock().ok();
        if let Some(hit) = cached_terminals() {
            timing::report(
                "list_terminals",
                started.elapsed().as_millis(),
                format_args!("count={} source=cache-waited", hit.len()),
            );
            return hit;
        }
        let found = launch::detect_terminals();
        let n = found.len();
        if let Ok(mut c) = TERMINAL_CACHE.lock() {
            *c = Some(found.clone());
        }
        timing::report(
            "list_terminals",
            started.elapsed().as_millis(),
            format_args!("count={n} source=detect"),
        );
        found
    })
    .await
    .map_err(|e| format!("检测终端失败: {e}"))?;
    Ok(out)
}

/// Where extracted IDE icons are cached.
///
/// Under the config directory rather than the project root: the project root is
/// itself a user-editable setting, and icons are app metadata, not user data.
fn ide_icon_cache_dir() -> PathBuf {
    config_path()
        .parent()
        .unwrap_or(&std::env::temp_dir())
        .join("cache")
        .join("ide-icons")
}

/// The manually specified IDE executables.
pub(crate) fn custom_ides() -> Vec<String> {
    read_config().custom_ides
}

/// Memoised IDE inventory. Same reasoning as `GIT_CACHE` in `downloader`: an
/// answer that took a registry walk plus a PowerShell subprocess is not asked for
/// twice in one session unless something changed it.
static IDE_CACHE: std::sync::Mutex<Option<Vec<launch::ToolInfo>>> =
    std::sync::Mutex::new(None);

/// Serialises the detection itself.
///
/// A cache that is only written at the *end* of a 3 s scan does not help four
/// callers that start together: measured here, opening 设置 in a dev build logged
/// `list_ides ms=3466 / 2954 / 3466 / 2984 source=detect` — four full registry
/// walks, because `StrictMode` double-invokes effects and both 设置 and the launch
/// panel ask. Whoever arrives second now waits on this lock and then reads the
/// answer the first one stored.
static IDE_DETECT: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn cached_ides() -> Option<Vec<launch::ToolInfo>> {
    IDE_CACHE.lock().ok()?.clone()
}

/// Drops the memoised IDE inventory. Called wherever the answer can change: the
/// manual add/remove commands, a settings save, and the 设置 page's rescan.
fn invalidate_ides() {
    if let Ok(mut c) = IDE_CACHE.lock() {
        *c = None;
    }
}

/// The inventory, from the cache when there is one.
///
/// Used by the paths that need an answer *now* for one action - "open this
/// repository in VS Code" walked three registry hives every time it was asked.
fn ides_now() -> Vec<launch::ToolInfo> {
    cached_ides().unwrap_or_else(idescan::detect)
}

/// Re-detects and makes the result the new cache, returning it.
///
/// For the commands that *changed* the inventory: their caller wants the list
/// after the change, and so does everything after them.
fn rescan_ides() -> Vec<launch::ToolInfo> {
    invalidate_ides();
    let fresh = idescan::detect();
    if let Ok(mut c) = IDE_CACHE.lock() {
        *c = Some(fresh.clone());
    }
    fresh
}

/// IDEs actually present on this machine, for the dropdown.
///
/// Async and on a worker thread: this reads three registry hives, walks
/// candidate install directories, and on a cache miss spawns PowerShell once to
/// extract the icons. None of that belongs on the main thread.
///
/// Memoised because it is a *machine* fact that the 启动面板 used to re-ask for on
/// every open - one of the reasons "打开项目" felt slow. It changes when something
/// is installed or the manual list is edited, and both of those paths call
/// [`invalidate_ides`]; `refresh` is the explicit override.
#[tauri::command]
async fn list_ides(refresh: Option<bool>) -> Result<Vec<launch::ToolInfo>, String> {
    let cache = ide_icon_cache_dir();
    let started = std::time::Instant::now();
    let force = refresh.unwrap_or(false);
    if !force {
        if let Some(cached) = cached_ides() {
            timing::report(
                "list_ides",
                started.elapsed().as_millis(),
                format_args!("count={} source=cache", cached.len()),
            );
            return Ok(cached);
        }
    }

    let out = tauri::async_runtime::spawn_blocking(move || {
        // Held for the whole scan: a second caller blocks here and then finds the
        // cache filled rather than starting its own walk.
        let _detect_guard = IDE_DETECT.lock().ok();
        if let Some(hit) = cached_ides() {
            timing::report(
                "list_ides",
                started.elapsed().as_millis(),
                format_args!("count={} source=cache-waited", hit.len()),
            );
            return hit;
        }
        let found = idescan::detect();
        let n = found.len();
        let with = idescan::with_icons(found, &cache);
        if let Ok(mut c) = IDE_CACHE.lock() {
            *c = Some(with.clone());
        }
        timing::report(
            "list_ides",
            started.elapsed().as_millis(),
            format_args!("count={n} source=detect"),
        );
        with
    })
    .await
    .map_err(|e| format!("检测 IDE 失败: {e}"))?;
    Ok(out)
}

/// Adds an executable the locators could not find.
///
/// The file must exist and look like an executable: accepting an arbitrary
/// string would put a broken entry into a menu the user then cannot launch.
#[tauri::command]
async fn add_custom_ide(path: String) -> Result<Vec<launch::ToolInfo>, String> {
    // Worker thread like the rest of the file-touching commands: `is_file`
    // probes disk, `update_config` rewrites the config, `record_activity`
    // appends, and `rescan_ides` on the tail reads registry hives and walks
    // install directories — that last one is the same work `list_ides` already
    // moves off the main thread for.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<launch::ToolInfo>, String> {
        let p = path.trim().to_string();
        let file = PathBuf::from(&p);
        if !file.is_file() {
            return Err("该路径不是一个存在的文件".to_string());
        }
        let is_exe = file
            .extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !is_exe {
            return Err("请选择 .exe 可执行文件".to_string());
        }
        update_config(|cfg| {
            if cfg.custom_ides.iter().any(|c| c.eq_ignore_ascii_case(&p)) {
                return Err("这个 IDE 已经在列表里".to_string());
            }
            cfg.custom_ides.push(p.clone());
            Ok(())
        })?;
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        record_activity(
            Log::new("ide", "手动添加 IDE", SRC_SETTINGS)
                .detail(&stem)
                .path_str(&p),
        );
        Ok(rescan_ides())
    })
    .await
    .map_err(|e| format!("添加 IDE 任务异常: {e}"))?
}

#[tauri::command]
async fn remove_custom_ide(path: String) -> Result<Vec<launch::ToolInfo>, String> {
    // Same reason as `add_custom_ide`: gated config write + activity append +
    // registry rescan do not belong on an async-runtime worker.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<launch::ToolInfo>, String> {
        let p = path.trim().to_string();
        update_config(|cfg| {
            let before = cfg.custom_ides.len();
            cfg.custom_ides.retain(|c| !c.eq_ignore_ascii_case(&p));
            if cfg.custom_ides.len() == before {
                return Err("这个 IDE 不在手动列表里".to_string());
            }
            Ok(())
        })?;
        record_activity(
            Log::new("ide", "移除手动添加的 IDE", SRC_SETTINGS).path_str(&p),
        );
        Ok(rescan_ides())
    })
    .await
    .map_err(|e| format!("移除 IDE 任务异常: {e}"))?
}

/// Persists the terminal/IDE choice without opening anything.
#[tauri::command]
async fn save_tool_choice(kind: String, id: String) -> Result<(), String> {
    // Gated: this used to be a bare read_config … write_config, which is the
    // exact lost-update shape `CONFIG_WRITE` exists to prevent (a concurrent
    // `apply_settings_update` or `open_terminal_with_sync` would have its write
    // clobbered by this whole-file rewrite of a pre-save snapshot).
    tauri::async_runtime::spawn_blocking(move || {
        update_config(|cfg| {
            match kind.as_str() {
                "terminal" => cfg.terminal_choice = id,
                "ide" => cfg.ide_choice = id,
                other => return Err(format!("未知的工具类型: {other}")),
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?
}

/// Opens a path in Windows Explorer. Selects the file when it exists, opens the
/// directory otherwise.
///
/// Contained by `path_guard` with `Access::Read`: the old `contains("..")`
/// substring check accepted any absolute path (`C:\Windows\...`,
/// `D:\someone-else\...`) and then ran the existence probes and the Explorer
/// launch on the *un-canonicalized* string — a junction or symlink swapped in
/// between the probe and the launch redirected the shell. The check now
/// canonicalizes, admits only container-internal paths, and the probes and the
/// launch both run on the path the guard verified. `\\?\` spellings are
/// stripped before reaching the shell, which does not accept them.
#[tauri::command]
async fn open_in_explorer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target = path_guard::guard(&app, &trimmed, path_guard::Access::Read)?;
        let target = netpath::strip_verbatim(&target);
        if target.is_file() {
            crate::proc::silent("explorer")
                .arg(format!("/select,{}", target.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {e}"))?;
        } else {
            crate::proc::silent("explorer")
                .arg(target.to_string_lossy().to_string())
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?
}

/// The nearest ancestor of `path` that actually exists, `path` included.
///
/// `reveal_item_in_dir` needs something that is on disk, and the whole point of
/// the add view's 落位 row is a path that usually is not there yet — the landing
/// directory is created *by* the download. Walking up is what lets one control
/// serve both: an existing path reveals itself, a not-yet-existing one reveals
/// the folder it will appear in.
fn nearest_existing(path: &std::path::Path) -> Option<PathBuf> {
    let mut cur = Some(path);
    while let Some(c) = cur {
        if c.exists() {
            return Some(c.to_path_buf());
        }
        cur = c.parent();
    }
    None
}

/// This is the 落位路径 click on the add view.
///
/// It deliberately does **not** create the directory. It used to, on the reading
/// that "the download would create it anyway", and that was the bug behind "点一
/// 下落位，下载就跑到别的地方去了": once `<repo>_<owner>` existed, `target_path`
/// stopped choosing it and appended the host, so the clone landed in
/// `<repo>_<owner>_github.com` while the preview still showed the shorter path.
///
/// Revealing the nearest existing ancestor gives the user the folder to look at
/// without changing any later decision. For every other caller — a finished
/// download, a repository on disk, a project's directory — that ancestor is the
/// path itself, so behaviour there is unchanged.
///
/// Contained by `path_guard` with `Access::Write` (the 落位 leaf may be a fresh
/// directory), so the page cannot point Explorer at a path outside the
/// container; the canonical target is verbatim-stripped before it reaches the
/// shell API, which does not accept `\\?\` spellings.
#[tauri::command]
async fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target = path_guard::guard(&app, &trimmed, path_guard::Access::Write)?;
        let target = netpath::strip_verbatim(&target);
        let target = nearest_existing(&target)
            .ok_or_else(|| format!("路径尚不存在，且找不到可打开的上级目录：{}", target.display()))?;
        tauri_plugin_opener::reveal_item_in_dir(&target)
            .map_err(|e| format!("无法打开资源管理器: {e}"))
    })
    .await
    .map_err(|e| format!("打开目录任务异常: {e}"))?
}

/// Writes one config key back, for a `value` 回退.
///
/// Deliberately narrow: it accepts a known key and a plain JSON string, not an
/// arbitrary patch document. A general "set any field" endpoint reachable from
/// the webview would let any injected script rewrite `projectRoot` or clear the
/// token, and the only caller here is a button that already knows which of the
/// handful of undoable keys it is restoring.
#[tauri::command]
fn apply_config_value(
    settings: tauri::State<'_, Settings>,
    key: String,
    value: String,
) -> Result<SettingsView, String> {
    // One gated transaction rather than a bare read/write pair: the 回退 button and a
    // concurrent 保存 hit the same file.
    update_config(|cfg| restore_config_value(cfg, &key, &value))?;
    let cfg = read_config();
    // The managed copy is what `build_config` reads on the next download, and
    // `save_settings` already refreshes these two flags. This path did not, so a 回退
    // of `mirrorEnabled` reported success in the UI and then kept downloading through
    // the mirror the user had just turned off - two writers of the same setting,
    // agreeing with each other only by accident.
    set_locked_bool(&settings.mirror_enabled, cfg.mirror_enabled);
    set_locked_bool(&settings.ip_pin_enabled, cfg.ip_pin_enabled);
    Ok(settings_view(&Settings::from_config(&cfg)))
}

/// Put one named config key back to a previous value.
///
/// Split out from the command so the mapping is testable: the command has to
/// touch `devhub-config.json`, and a unit test that rewrote the real config
/// would be worse than no test at all.
///
/// The key list is exactly the set of settings that record an undoable
/// `value` descriptor. Anything not listed errors rather than being ignored —
/// a 回退 button that silently did nothing is the failure this guards against.
fn restore_config_value(cfg: &mut AppConfig, key: &str, value: &str) -> Result<(), String> {
    let mut changed = false;
    macro_rules! set_str {
        ($field:ident, $k:expr) => {
            if key == $k {
                cfg.$field = value.to_string();
                changed = true;
            }
        };
    }
    set_str!(project_root, "projectRoot");
    set_str!(search_route, "searchRoute");
    set_str!(download_route, "downloadRoute");
    set_str!(terminal_choice, "terminalChoice");
    set_str!(ide_choice, "ideChoice");
    set_str!(cleanup_mode, "cleanupMode");
    set_str!(clone_strategy, "cloneStrategy");
    if key == "mirrorEnabled" {
        cfg.mirror_enabled = value == "true";
        changed = true;
    }
    if key == "ipPinEnabled" {
        cfg.ip_pin_enabled = value == "true";
        changed = true;
    }
    if key == "activityRetentionDays" {
        cfg.activity_retention_days = value.parse().map_err(|e| format!("保留时长无效: {e}"))?;
        changed = true;
    }
    if key == "cleanupKeepDays" {
        cfg.cleanup_keep_days = value.parse().map_err(|e| format!("保留天数无效: {e}"))?;
        changed = true;
    }
    if key == "searchDebounceMs" {
        cfg.search_debounce_ms = value.parse().map_err(|e| format!("停顿时间无效: {e}"))?;
        changed = true;
    }
    if key == "parallelDownloads" {
        cfg.parallel_downloads = value.parse().map_err(|e| format!("并行数无效: {e}"))?;
        changed = true;
    }
    if !changed {
        return Err(format!("不支持回退的设置项：{key}"));
    }
    Ok(())
}

/// Runs the scheduled clean-up if one is due.
///
/// Lazy rather than timer-driven, matching how retention already works: the
/// check happens on launch and on demand, so the app never needs a background
/// thread that could fire while the window is closed, and a missed day simply
/// runs the next time it is opened.
#[tauri::command]
async fn run_due_cleanup() -> Result<usize, String> {
    // Blocking like every other file-touching command (see d2-4): the purge
    // rewrites the whole activity JSONL and the gated config write follows it.
    tauri::async_runtime::spawn_blocking(apply_due_cleanup)
        .await
        .map_err(|e| format!("清理任务异常: {e}"))
}

/// The clean-up body, shared by the command and the startup hook.
///
/// Returns how many entries were removed; `0` also covers "not due yet", which
/// is why the startup path logs the mode it read.
fn apply_due_cleanup() -> usize {
    // Gated end-to-end: the previous version did an ungated read_config …
    // write_config, so a settings save racing this lazy clean-up could have its
    // whole-file write clobbered by the stale `lastCleanupTs` snapshot (the exact
    // shape `CONFIG_WRITE` documents). The purge itself runs inside the gate
    // because it is bounded by `keep_days` on a local file — cheap enough that
    // serialising it against a save is not a latency problem, and holding the
    // gate only around the final write would still leave the read side stale.
    let _gate = lock_config();
    // Strict read: `read_config` answers with defaults when the file is only
    // momentarily unreadable, and this function writes that snapshot back — the
    // whole config (token, mirrors, roots, retention) would go to defaults on a
    // locked file. Skipping one clean-up pass is the cheaper failure.
    let mut cfg = match read_config_for_write() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cleanup] {e}");
            return 0;
        }
    };
    if cfg.cleanup_mode == "manual" {
        return 0;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let interval = match cfg.cleanup_mode.as_str() {
        "daily" => 86_400,
        "weekly" => 7 * 86_400,
        "monthly" => 30 * 86_400,
        _ => return 0,
    };
    if cfg.last_cleanup_ts > 0 && now - cfg.last_cleanup_ts < interval {
        return 0;
    }
    let path = activity_path();
    let removed = activity::purge(&path, cfg.cleanup_keep_days).unwrap_or(0);
    cfg.last_cleanup_ts = now;
    // A failed persistence here used to be dropped with `let _ =`. That turned a
    // full disk or a locked config into "clean-up silently re-runs every launch",
    // with nothing in the log. Keep going — the purge already happened — but say
    // so on stderr, matching how the startup hook reports `removed > 0`.
    if let Err(e) = write_config(&cfg) {
        eprintln!("[cleanup] lastCleanupTs 写回失败: {e}");
    }
    if removed > 0 {
        record_activity(
            Log::new("clear", "按计划清理操作记录", SRC_RECORDS)
                .detail(&format!(
                    "{}清理一次，删除 {} 条（保留 {}）",
                    match cfg.cleanup_mode.as_str() {
                        "daily" => "每天",
                        "weekly" => "每周",
                        "monthly" => "每月",
                        _ => "",
                    },
                    removed,
                    retention_phrase(cfg.cleanup_keep_days)
                ))
                .target("activity.cleanup")
                .path(&path)
                .undo(activity::Undo::none("被清理掉的记录已经删除，无法恢复")),
        );
    }
    removed
}

///
/// The webview has no filesystem access and the `fs` plugin is not installed, so
/// the two exports that live entirely in the frontend (界面布局) need one narrow
/// write endpoint. It is text-only, size-capped, and the path comes from the
/// user through the native dialog — not from a string the page invented.
///
/// The path goes through [`path_guard`]: canonicalized, then admitted only when it
/// sits inside a directory the container already works in. The previous check was
/// `path.contains("..")`, which an absolute path walks straight past — this endpoint
/// would have created `.lnk` files in the Startup folder without a single dot-dot.
#[tauri::command]
async fn write_text_file(app: tauri::AppHandle, path: String, text: String) -> Result<(), String> {
    if text.len() > 4_000_000 {
        return Err("内容过大，拒绝写入".to_string());
    }
    // Containment in the same blocking task as the write: `guard` canonicalizes
    // the roots (real fs work) that must not run on an async runtime thread.
    // Writing to the canonical path is still the point: a link swapped in
    // afterwards cannot redirect the bytes somewhere the guard never looked at.
    tauri::async_runtime::spawn_blocking({
        let app2 = app.clone();
        move || {
            let target = path_guard::guard(&app2, &path, path_guard::Access::Write)?;
            if let Some(dir) = target.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            write_atomic(&target, text.as_bytes()).map_err(|e| format!("写入失败: {e}"))
        }
    })
    .await
    .map_err(|e| format!("写入任务异常: {e}"))?
}

/// Reads a UTF-8 text file the user chose in an open dialog.
///
/// Guarded like the write endpoint, for a sharper reason: unguarded, this could
/// point at `devhub-config.json` and lift the GitHub token straight out of it.
#[tauri::command]
async fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    // Containment in the same blocking task as the read: `guard` canonicalizes
    // the roots (real fs work) that must not run on an async runtime thread.
    let bytes = tauri::async_runtime::spawn_blocking({
        let app2 = app.clone();
        move || {
            let target = path_guard::guard(&app2, &path, path_guard::Access::Read)?;
            // Size is checked *before* the read. `std::fs::read` pulled the whole file
            // into memory and only then got compared against the cap, so picking a large
            // file in the open dialog allocated it first and failed afterwards;
            // `write_text_file` above already checks its cap up front, and the two were
            // asymmetric about the same limit.
            let len = std::fs::metadata(&target)
                .map_err(|e| format!("读取失败: {e}"))?
                .len();
            if len > 4_000_000 {
                return Err("文件过大".to_string());
            }
            std::fs::read(&target).map_err(|e| format!("读取失败: {e}"))
        }
    })
    .await
    .map_err(|e| format!("读取任务异常: {e}"))??;
    String::from_utf8(bytes).map_err(|_| "文件不是 UTF-8 文本".to_string())
}

/// Reports, for one repository, which external tools are present.
///
/// Async: it stats a dozen marker files and, before `which_one` was memoised,
/// walked `PATH` up to four times - on the main thread, while the panel was open.
#[tauri::command]
async fn repo_environments(slug: String) -> Result<Environments, String> {
    // r17-o2-env-cache: 环境检测要 spawn python/node/docker 子进程，开一次项目面板就
    // 把这一整套探测重跑一遍是浪费。按 slug 缓存 60 秒——够覆盖连续切几个项目的打开
    // 抖动，又短到用户真的装/卸了某个工具后不会看太久旧值。
    {
        if let Ok(guard) = ENV_CACHE.lock() {
            if let Some(map) = guard.as_ref() {
                if let Some((at, env)) = map.get(&slug) {
                    if at.elapsed() < ENV_CACHE_TTL {
                        return Ok(env.clone());
                    }
                }
            }
        }
    }
    let started = std::time::Instant::now();
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        detect_environments(repo.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("环境检测任务异常: {e}"))??;
    timing::report(
        "repo_environments",
        started.elapsed().as_millis(),
        format_args!(
            "python={} node={} docker={}",
            out.python.is_some(),
            out.node.is_some(),
            out.docker.is_some()
        ),
    );
    if let Ok(mut guard) = ENV_CACHE.lock() {
        let map = guard.get_or_insert_with(Default::default);
        // r20-O2-2: bounded, and stale-on-write. A wall of 300 projects opened one panel
        // at a time used to accumulate 300 live-plus-dead entries for the session,
        // because the 60 s TTL was only ever consulted on a hit.
        cache::insert_bounded(map, ENV_CACHE_TTL, ENV_CACHE_CAP, slug, out.clone());
    }
    Ok(out)
}

/// r17-o2-env-cache: 环境变了（刚建/删了 venv）就主动失效，不必等 60s TTL。
#[tauri::command]
fn clear_env_cache() {
    if let Ok(mut guard) = ENV_CACHE.lock() {
        *guard = None;
    }
}

/// Headless launch probe: `devhub-app.exe --launch-check`.
///
/// Actually starts the confirmed command of the first repository that has one,
/// waits for output, then stops it. This is how the launch path gets verified
/// without driving the GUI, since the launch dialog is a modal that scripts
/// cannot click.
pub fn run_headless_launch_check() -> i32 {
    let root = project_root();
    let mut found: Option<(String, PathBuf, launch::LaunchConfig)> = None;

    downloader::collect_repos(&root, &mut |rel, abs| {
        if found.is_some() {
            return;
        }
        if let Some(m) = downloader::read_marker(abs) {
            if let Some(cfg) = m.launch {
                if cfg.user_confirmed && !cfg.command.trim().is_empty() {
                    found = Some((rel.to_string_lossy().replace('\\', "/"), abs.to_path_buf(), cfg));
                }
            }
        }
    });

    let (slug, repo, cfg) = match found {
        Some(v) => v,
        None => {
            println!("NONE 没有任何仓库带已确认的启动命令（需要先在界面里确认一条）");
            return 1;
        }
    };

    println!("slug    = {slug}");
    println!("repo    = {}", repo.display());
    println!("command = {}", cfg.command);

    let env = launch_env_for(&repo);
    println!(
        "venv    = {:?}",
        env.venv.as_ref().map(|p| p.display().to_string())
    );
    println!("ports   = {:?}", env.ports);

    let collected: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_for_thread = collected.clone();
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, msg: &str| {
        let line = format!("[{stage}] {msg}");
        println!("{line}");
        if let Ok(mut g) = sink_for_thread.lock() {
            g.push(line);
        }
    });

    match launch::launch_run(sink, &repo, &cfg, &env, &launch::null_spawn_sink()) {
        Ok(started) => {
            println!("STARTED pid={} cwd={}", started.pid, started.cwd);
            // Give the child a moment to produce output before we stop it.
            std::thread::sleep(std::time::Duration::from_secs(4));
            let alive = proc::silent("tasklist")
                .args(["/FI", &format!("PID eq {}", started.pid), "/NH"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains(&started.pid.to_string()))
                .unwrap_or(false);
            println!("alive   = {alive}");
            let lines = collected.lock().map(|g| g.len()).unwrap_or(0);
            println!("output_lines = {lines}");

            // Stop it; the point was to prove it starts, not to keep it running.
            let _ = proc::silent("taskkill")
                .args(["/PID", &started.pid.to_string(), "/T", "/F"])
                .output();
            println!("OK");
            0
        }
        Err(e) => {
            println!("ERROR {e}");
            1
        }
    }
}

/// Finds the venv for a repository. It lives outside the repo, so deleting the
/// repo alone would leave it orphaned.
fn venv_for(repo: &std::path::Path) -> Option<PathBuf> {
    if let Some(m) = downloader::read_marker(repo) {
        if let Some(v) = &m.venv_path {
            let p = PathBuf::from(v);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    // Derive it the same way the python-env screen does, and only accept a
    // directory that really is an environment - see the `child_env` fallback.
    downloader::venv_dir_for(&project_root(), repo).filter(|p| downloader::looks_like_venv(p))
}

/// Lists what "clear cache" would remove, without removing anything.
///
/// Async because the listing is a walk of the repository's build output - which for
/// a real project is tens of thousands of entries, and on the main thread that is a
/// window that stops answering while the dialog thinks about it.
#[tauri::command]
async fn scan_cache(slug: String) -> Result<launch::ClearReport, String> {
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let repo = find_repo_any(&slug)
            .ok_or_else(|| format!("未找到仓库: {slug}"))?;
        Ok::<_, String>(launch::scan_cache(&repo))
    })
    .await
    .map_err(|e| format!("缓存扫描任务异常: {e}"))??;
    timing::report(
        "scan_cache",
        started.elapsed().as_millis(),
        format_args!("items={} bytes={}", out.items.len(), out.total_bytes),
    );
    Ok(out)
}

/// Removes exactly the listed artefacts. The UI must have shown them first.
#[tauri::command]
async fn clear_cache(slug: String, rels: Vec<String>) -> Result<launch::ClearReport, String> {
    let started = std::time::Instant::now();
    let asked = rels.len();
    let out = tauri::async_runtime::spawn_blocking(move || clear_cache_sync(slug, rels))
        .await
        .map_err(|e| format!("缓存清理任务异常: {e}"))??;
    timing::report(
        "clear_cache",
        started.elapsed().as_millis(),
        format_args!(
            "asked={} removed={} failed={} freed={}",
            asked,
            out.removed.len(),
            out.failed.len(),
            out.freed_bytes
        ),
    );
    Ok(out)
}

fn clear_cache_sync(slug: String, rels: Vec<String>) -> Result<launch::ClearReport, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    for rel in &rels {
        if rel.contains("..") {
            return Err(format!("清理路径包含非法字符: {rel}"));
        }
        if std::path::Path::new(rel).is_absolute() {
            return Err(format!("清理路径不能是绝对路径: {rel}"));
        }
    }
    let report = launch::clear_cache(&repo, &rels);
    record_activity(
        Log::new("clear", "清理缓存", SRC_LAUNCH)
            .detail(&format!(
                "清理 {} 项，释放 {}",
                report.removed.len(),
                human_bytes(report.freed_bytes)
            ))
            .slug(&slug)
            .target(&format!("cache:{slug}"))
            // Honestly not reversible: build output regenerates itself, but it
            // cannot be put *back*, and pretending otherwise would make the
            // 回退 button a lie.
            .undo(activity::Undo::none("缓存内容会随下次构建重新生成，无法原样放回"))
            .path(&repo),
    );
    Ok(report)
}

/// Irreversibly removes a repository, its venv and its worktree copies.
///
/// Async: a `remove_dir_all` of a real repository and its venv is the single longest
/// filesystem operation in the app, and it used to run on the main thread.
#[tauri::command]
async fn delete_repo(slug: String) -> Result<launch::DeleteReport, String> {
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || delete_repo_sync(slug))
        .await
        .map_err(|e| format!("删除任务异常: {e}"))??;
    timing::report(
        "delete_repo",
        started.elapsed().as_millis(),
        format_args!(
            "repo={} venv={} failed={} freed={}",
            out.removed_repo,
            out.removed_venv,
            out.failed.len(),
            out.freed_bytes
        ),
    );
    Ok(out)
}

fn delete_repo_sync(slug: String) -> Result<launch::DeleteReport, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let venv = venv_for(&repo);
    let report = launch::delete_repo(&project_root(), &slug, &repo, venv.as_deref());
    if report.failed.is_empty() {
        // The reversal of a delete is a re-clone from the same URL, which is
        // only possible because the slug carries the owner and repo name.
        let url = downloader::parse_ref(&slug)
            .map(|r| r.https_url())
            .unwrap_or_default();
        record_activity(
            Log::new("delete", "删除项目", SRC_LAUNCH)
                .detail(&format!("已删除，释放 {}", human_bytes(report.freed_bytes)))
                .slug(&slug)
                .target(&format!("repo:{slug}"))
                .change(&repo.to_string_lossy(), "")
                .undo(if url.is_empty() {
                    activity::Undo::none("无法从这条记录还原仓库地址，需要手动重新下载")
                } else {
                    activity::Undo::redownload(&url)
                })
                .path(&repo),
        );
    } else {
        record_activity(
            Log::new("delete", "删除项目（部分失败）", SRC_LAUNCH)
                .detail(&format!("失败项：{}", report.failed.join("；")))
                .slug(&slug)
                .target(&format!("repo:{slug}"))
                .path(&repo),
        );
    }
    Ok(report)
}

/// Moves a repository to the Windows Recycle Bin - the middle level of the
/// three-way delete the 项目墙 context menu offers (隐藏 / 回收站 / 永久删除).
///
/// Async and on a worker thread: measuring what is being freed walks the whole
/// repository, and the shell call itself can block on a large tree - neither
/// belongs on the main thread.
///
/// The record says plainly that the operating system owns the restore. This app
/// can put a *re-cloned* repository back (that is `delete_repo`'s undo), but a bin
/// item's original-path restore is a shell operation, and pretending the app could
/// do it would make the 回退 button a lie.
#[tauri::command]
async fn trash_repo(slug: String) -> Result<launch::DeleteReport, String> {
    let repo = find_repo_any(&slug)
        .ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let venv = venv_for(&repo);
    let root = project_root();
    let (slug_for_job, repo_for_job, venv_for_job) = (slug.clone(), repo.clone(), venv.clone());
    let report = tauri::async_runtime::spawn_blocking(move || {
        launch::trash_repo(
            &root,
            &slug_for_job,
            &repo_for_job,
            venv_for_job.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("回收站任务异常: {e}"))?;

    // What the 回退 button has to put back. The venv is included because it went
    // into the bin in the same action, and a half-restored project is worse than
    // an honest failure message.
    let mut restore_paths = vec![repo.to_string_lossy().to_string()];
    if let Some(v) = &venv {
        restore_paths.push(v.to_string_lossy().to_string());
    }

    let detail = if report.failed.is_empty() {
        format!(
            "已移入回收站，释放 {}（回退可原位还原）",
            human_bytes(report.freed_bytes)
        )
    } else {
        format!("失败项：{}", report.failed.join("；"))
    };
    record_activity(
        Log::new(
            "delete",
            if report.failed.is_empty() {
                "删除项目（回收站）"
            } else {
                "删除项目（回收站，部分失败）"
            },
            SRC_LAUNCH,
        )
        .detail(&detail)
        .slug(&slug)
        .target(&format!("repo:{slug}"))
        .change(&repo.to_string_lossy(), "Windows 回收站")
        .undo(if report.failed.is_empty() {
            activity::Undo::restore_trash(&restore_paths)
        } else {
            activity::Undo::none("部分项目未能移入回收站，还原请逐项确认")
        })
        .path(&repo),
    );
    Ok(report)
}

/// Every restore target must be inside the container the app itself works in.
///
/// `launch::restore_from_bin` searches the WHOLE Recycle Bin, matching on
/// `original_path`, and that bin holds files other applications deleted. The
/// command used to pass through whatever path the page sent, so a corrupt 回退
/// record or a forged one could pull an unrelated document back to a location no
/// one in DevHub ever chose. The check is containment, but the path is handed on in
/// its original spelling: the shell reports plain paths, and a canonical `\\?\`
/// form would simply never match an entry.
///
/// Roots arrive as a parameter so the rule is testable without a live Recycle Bin,
/// and the refusal list comes back instead of an error string so this function
/// stays pure — writing the audit record is the command's job.
fn restore_targets(paths: &[String], roots: &[std::path::PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|raw| path_guard::check(roots, raw, path_guard::Access::Write).is_err())
        .map(|raw| raw.trim().to_string())
        .collect()
}

/// Puts back what a recycle-bin delete took, from the shell's own item list.
#[tauri::command]
async fn restore_from_trash(paths: Vec<String>) -> Result<RestoreReport, String> {
    let refused = restore_targets(&paths, &path_guard::container_roots());
    if !refused.is_empty() {
        // The attempt is recorded even though nothing was restored: a refused
        // restore is evidence of a bad 回退 record, and returning an error alone
        // loses the only trace that anyone tried.
        record_activity(
            Log::new("delete", "拒绝从回收站还原", SRC_RECORDS)
                .detail(&format!("{} 个路径不在项目目录之内：{}", refused.len(), refused.join("、"))),
        );
        return Err(format!(
            "这些路径不在项目目录之内，已拒绝从回收站还原：{}",
            refused.join("、")
        ));
    }
    let report = tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
        let owned: Vec<&std::path::Path> = refs.iter().map(|p| p.as_path()).collect();
        let (restored, missing) = launch::restore_from_bin(&owned)?;
        Ok::<_, String>(RestoreReport { restored, missing })
    })
    .await
    .map_err(|e| format!("还原任务异常: {e}"))??;

    record_activity(
        Log::new(
            "delete",
            "从回收站还原项目",
            SRC_RECORDS,
        )
        .detail(&format!(
            "已还原 {} 项{}",
            report.restored.len(),
            if report.missing.is_empty() {
                String::new()
            } else {
                format!("，回收站里找不到 {} 项", report.missing.len())
            }
        ))
        .undo(activity::Undo::none("还原是一次真实的文件移动，再撤销等于重新删除")),
    );
    // The container gained directories back.
    repo_index::invalidate();
    Ok(report)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreReport {
    restored: Vec<String>,
    missing: Vec<String>,
}

/// Removes a directory that a download record says this app created, for that
/// record's 回退.
///
/// ## Why this is a separate command from `delete_repo`
///
/// `delete_repo` takes a **slug** and resolves it by listing the container, so a
/// wrong slug can only ever name a repository. A download record instead stores
/// the **absolute path** it wrote to, and a path arriving from the webview is not
/// a path that came off the disk: it could have been edited, or be a leftover
/// from a build where the root was somewhere else. So this command re-derives the
/// trust from the filesystem instead of assuming it — see
/// `path_guard::check_delete_target`, which is where the rule lives.
#[tauri::command]
async fn delete_downloaded(path: String) -> Result<launch::DeleteReport, String> {
    let (report, slug, url, target, had_venv) =
        tauri::async_runtime::spawn_blocking(move || {
            let roots = project_roots();
            let (root, target) =
                path_guard::check_delete_target(&roots, std::path::Path::new(&path))?;
            // The identity comes from the same resolver the 项目墙 uses. Guessing it
            // from the directory name would be wrong: the current layout is
            // `<repo>_<owner>` flat under the root, not `owner/repo`.
            let href = downloader::repo_ref_of(&root, &target);
            let slug = href
                .as_ref()
                .map(|r| r.slug())
                .unwrap_or_else(|| {
                    target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
            // Prefer the address the marker recorded over one rebuilt from the
            // slug: a clone that came from a mirror, an ssh URL, or a local
            // repository all re-download from what actually worked.
            let url = downloader::read_marker(&target)
                .map(|m| m.url)
                .filter(|u| !u.is_empty())
                .or_else(|| href.as_ref().map(|r| r.https_url()))
                .unwrap_or_default();
            // A download does not create a venv, but launching it afterwards
            // does; deleting the repo and orphaning its environment is the
            // failure `delete_repo` already guards against elsewhere.
            let venv = downloader::read_marker(&target)
                .and_then(|m| m.venv_path)
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .or_else(|| downloader::venv_dir_for(&root, &target));
            let had_venv = venv.is_some();
            let report = launch::delete_repo(&root, &slug, &target, venv.as_deref());
            Ok::<_, String>((report, slug, url, target, had_venv))
        })
        .await
        .map_err(|e| format!("回退任务异常: {e}"))??;

    let shown = strip_verbatim(&target);

    if !report.failed.is_empty() {
        // A partial failure is still something that happened: the 记录 page has
        // to show that the 回退 removed part of the directory and left the rest.
        // The `undo: none` reason matters too — the UI reads an absent descriptor
        // as "written before 回退 existed", which would be a lie about a record it
        // just wrote.
        record_activity(
            Log::new("delete", "回退：删除已下载的仓库（部分失败）", SRC_RECORDS)
                .detail(&format!(
                    "失败项：{}；已释放 {}",
                    report.failed.join("；"),
                    human_bytes(report.freed_bytes)
                ))
                .slug(&slug)
                .target(&format!("repo:{slug}"))
                .undo(activity::Undo::none("部分删除失败，剩下的内容需要手动清理"))
                .path_str(&shown.to_string_lossy()),
        );
        return Err(format!("部分删除失败：{}", report.failed.join("；")));
    }

    // The reversal of this reversal is a re-clone, which is exactly what the
    // 删除项目 record advertises — so the two delete paths stay symmetrical and
    // a 回退 of a 回退 is offered rather than silently dropped.
    let mut detail = format!(
        "回退「下载仓库」这条记录，释放 {}",
        human_bytes(report.freed_bytes)
    );
    if had_venv {
        detail.push_str("，并清理了它的 venv");
    }
    record_activity(
        Log::new("delete", "回退：删除已下载的仓库", SRC_RECORDS)
            .detail(&detail)
            .slug(&slug)
            .target(&format!("repo:{slug}"))
            .change(&shown.to_string_lossy(), "")
            .undo(if url.is_empty() {
                activity::Undo::none("这条记录的目录里没有留下地址，无法自动重新下载")
            } else {
                activity::Undo::redownload(&url)
            })
            .path_str(&shown.to_string_lossy()),
    );
    Ok(report)
}

/// Windows `\\?\` prefixes are real in the paths `canonicalize` returns and ugly
/// in a message shown to a user; comparison is unaffected, so strip them last.
fn strip_verbatim(p: &std::path::Path) -> PathBuf {
    crate::netpath::strip_verbatim(p)
}

/// Headless clear probe: `devhub-app.exe --clear-check <slug>`.
///
/// Scans, reports what would be freed, then clears exactly that list and reports
/// the result. Used to verify the cleanup path without the GUI.
pub fn run_headless_clear_check(slug: &str) -> i32 {
    let root = project_root();
    let repo = match downloader::find_repo_by_slug(&root, slug) {
        Some(r) => r,
        None => {
            println!("NONE 未找到仓库 {slug}");
            return 1;
        }
    };
    println!("slug = {slug}");
    println!("repo = {}", repo.display());

    let scan = launch::scan_cache(&repo);
    println!("would_free_bytes = {}", scan.total_bytes);
    println!("items = {}", scan.items.len());
    for i in &scan.items {
        println!("  {}\t{}\t{} 字节", i.rel, i.label, i.bytes);
    }

    let rels: Vec<String> = scan.items.iter().map(|i| i.rel.clone()).collect();
    let report = launch::clear_cache(&repo, &rels);
    println!("freed_bytes = {}", report.freed_bytes);
    println!("removed = {}", report.removed.len());
    for r in &report.removed {
        println!("  removed {r}");
    }
    for f in &report.failed {
        println!("  FAILED {f}");
    }

    // The repository itself must be intact afterwards.
    let git_ok = repo.join(".git").exists();
    println!("git_intact = {git_ok}");
    let remaining = launch::scan_cache(&repo);
    println!("remaining_bytes = {}", remaining.total_bytes);

    if !report.failed.is_empty() || !git_ok {
        println!("ERROR 清理失败或破坏了仓库");
        return 1;
    }
    println!("OK");
    0
}

/// Headless delete probe: `devhub-app.exe --delete-check <slug>`.
/// Headless recycle-bin round trip: `devhub-app.exe --trash-check`.
///
/// The middle level of the 项目墙's delete menu promises 可还原. That promise is
/// only true if `trash` really hands the item to the Windows Recycle Bin rather
/// than deleting it, and if `restore_from_bin` can find it again by its original
/// path. Both halves are checked here against a scratch directory the probe
/// creates and removes itself, so none of the user's repositories are at stake.
pub fn run_headless_trash_check() -> i32 {
    let dir = std::env::temp_dir().join("devhub-trash-check");
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(dir.join("inner")) {
        println!("ERROR 无法建临时目录: {e}");
        return 1;
    }
    // A failure here is a fact about the machine (read-only temp, antivirus, a
    // leftover scratch directory), not a bug in the probe, and `panic = "abort"`
    // in release means an `unwrap` would kill the process mid-report. The probe is
    // run by a script, so it has to print which step did not run and leave a
    // non-zero code rather than disappear.
    if let Err(e) = std::fs::write(dir.join("marker.txt"), b"still here") {
        println!("ERROR 无法写入探针标记文件: {e}");
        return 1;
    }
    println!("scratch = {}", dir.display());

    if let Err(e) = trash::delete(&dir) {
        println!("ERROR 移入回收站失败: {e}");
        return 1;
    }
    let gone = !dir.exists();
    println!("gone_after_trash = {gone}");
    if !gone {
        println!("ERROR 目录还在，trash 没有动它");
        return 1;
    }

    // What the bin itself says, independent of the restore path below.
    match trash::os_limited::list() {
        Ok(items) => {
            let wanted = dir.to_string_lossy().to_string();
            let found = items
                .iter()
                .filter(|i| {
                    i.original_path()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&wanted)
                })
                .count();
            println!("bin_entries_for_original_path = {found}");
        }
        Err(e) => println!("note: 无法枚举回收站（{e}），下面的还原结果才是判据"),
    }

    // The same function the 记录 page's 回退 button calls.
    let (restored, missing) = match launch::restore_from_bin(&[dir.as_path()]) {
        Ok(v) => v,
        Err(e) => {
            println!("ERROR 还原失败: {e}");
            return 1;
        }
    };
    println!("restored = {} missing = {}", restored.len(), missing.len());

    let intact = std::fs::read(dir.join("marker.txt"))
        .map(|b| b == b"still here")
        .unwrap_or(false);
    println!("file_back_with_content = {intact}");
    let _ = std::fs::remove_dir_all(&dir);

    if restored.len() == 1 && intact {
        println!("OK");
        0
    } else {
        println!("ERROR 回收站往返不完整：restored={} intact={intact}", restored.len());
        1
    }
}

pub fn run_headless_delete_check(slug: &str) -> i32 {
    let root = project_root();
    let repo = match downloader::find_repo_by_slug(&root, slug) {
        Some(r) => r,
        None => {
            println!("NONE 未找到仓库 {slug}");
            return 1;
        }
    };
    let venv = venv_for(&repo);
    println!("repo = {}", repo.display());
    println!(
        "venv = {:?}",
        venv.as_ref().map(|p| p.display().to_string())
    );

    let report = launch::delete_repo(&root, slug, &repo, venv.as_deref());
    println!("removed_repo = {}", report.removed_repo);
    println!("removed_venv = {}", report.removed_venv);
    println!("freed_bytes = {}", report.freed_bytes);
    for f in &report.failed {
        println!("  FAILED {f}");
    }
    let still_listed = downloader::find_repo_by_slug(&root, slug).is_some();
    println!("still_listed = {still_listed}");

    if !report.failed.is_empty() || still_listed {
        println!("ERROR 删除不完整");
        return 1;
    }
    println!("OK");
    0
}


/// Resizes the main window so it always fits on screen.
///
/// The configured 1200x820 was larger than the available work area on a 1536x864
/// display (816 px after the taskbar), so the bottom of the window - which holds
/// the sidebar's style switcher and the status strip - was permanently off screen.
/// A fixed size cannot be right on every monitor, so the window is sized from the
/// monitor instead of a constant.
///
/// Two Windows details this has to account for:
///   * `work_area()` returns the full monitor rect here (1536x864), i.e. it does
///     NOT subtract the taskbar, so the taskbar has to be budgeted explicitly;
///   * `Window::set_size` sets the CLIENT size, and the title bar and borders add
///     roughly 30-40 px on top. Asking for 820 produced a 838 px window, which was
///     again taller than the 816 px the taskbar left available.
/// The window's minimum client size, in logical pixels.
///
/// One constant on purpose: "start at the minimum" is only adaptive if the
/// startup size and the resize floor come from the same number, otherwise
/// changing one silently reintroduces the other.
const MIN_W: f64 = 940.0;
const MIN_H: f64 = 560.0;

/// How long the app waits for the page to say it has painted before showing the
/// window anyway.
///
/// The page signal is the precise answer, and it can also never arrive: IPC does not
/// initialise, the inline script throws, or in `tauri dev` the dev server is still
/// building the module graph. Revealing at the deadline is what makes "the window is
/// shown by the page" safe — the worst case is the behaviour this replaces, not an
/// application that is running but invisible.
const BOOT_REVEAL_DEADLINE_MS: u64 = 6_000;

/// Whether the main window has been made visible yet.
static WINDOW_REVEALED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Shows and focuses the main window, once, from whichever thread asked.
///
/// Window operations belong on the main thread, and the two paths that can reveal
/// the window are not on it: the page signal arrives on an IPC worker, the deadline
/// runs on its own thread. `via` is printed because *which* path revealed the window
/// is the whole diagnosis of a startup that looked wrong — a `deadline` line means
/// the page never told the app it had painted.
fn reveal_window(app: &tauri::AppHandle, via: &'static str) {
    use std::sync::atomic::Ordering;
    if WINDOW_REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = handle.get_webview_window("main") else {
            println!("[window] revealed via={via} but there is no main window to show");
            return;
        };
        let _ = win.show();
        let _ = win.set_focus();
        println!("[window] revealed via={via}");
    });
}

/// The page's boot surface has had a frame.
///
/// `index.html` invokes this as soon as the boot markup has painted, which is the
/// earliest moment at which there is something worth showing. The window used to be
/// shown in `setup`, so the first thing anyone saw was an empty dark rectangle for as
/// long as the document took to arrive.
#[tauri::command]
fn note_boot_painted(app: tauri::AppHandle) {
    reveal_window(&app, "boot-paint");
}

// ---------------------------------------------------------------------------
// 窗口状态记忆（r17-n3-1）
// ---------------------------------------------------------------------------
//
// 关闭时记下窗口的位置与尺寸，下次启动原样还原——而不是每次都回到
// `fit_window_to_monitor` 决定的最小居中尺寸。独立 sidecar（devhub-window.json），
// 不进 AppConfig：那个 struct 是闭合的 typed 字段（见 i18n.ts 头注释），加字段要动
// serde 定义；窗口状态是一次性、可丢弃的视图偏好，坏了退回最小居中即可。

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct WindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
    /// 写入时所在显示器的逻辑尺寸，用来判断「上次那块屏还在不在」。
    monitor_w: f64,
    monitor_h: f64,
}

fn window_state_path() -> PathBuf {
    config_path().with_file_name("devhub-window.json")
}

/// 关闭时抓一次当前边界写盘。只在 CloseRequested 抓，不跟每次 resize 写——
/// 用户拖拽中途崩溃不该留下一个半拉尺寸。
fn save_window_state(win: &tauri::Window) {
    let Ok(outer) = win.outer_position() else { return };
    let Ok(size) = win.outer_size() else { return };
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let Ok(scale) = win.scale_factor() else { return };
    let logical_size = size.to_logical::<f64>(scale);
    let logical_pos = outer.to_logical::<f64>(scale);
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    let state = WindowState {
        x: logical_pos.x,
        y: logical_pos.y,
        width: logical_size.width,
        height: logical_size.height,
        maximized: win.is_maximized().unwrap_or(false),
        monitor_w: area.width,
        monitor_h: area.height,
    };
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = write_atomic(&window_state_path(), json.as_bytes());
    }
}

/// 启动时若有上次的窗口状态且仍落在一块可用屏内，还原它；否则走最小居中。
///
/// 「落在可用屏内」的判断：保存时的显示器尺寸和当前主显示器工作区尺寸差太多
/// （拔掉副屏、缩放改变），上次坐标可能在屏幕外——那种情况退回 `fit_window_to_monitor`，
/// 不要把窗口放到一个看不见的位置上。
/// 上次窗口状态在当前主显示器工作区下是否还能用。纯函数，可单测。
///
/// 两条否决线：显示器尺寸漂移过大（换屏/缩放），或窗口至少一角落在工作区外。
fn window_state_usable(st: &WindowState, area_w: f64, area_h: f64) -> bool {
    if st.width < MIN_W || st.height < MIN_H {
        return false;
    }
    let size_drift = (area_w - st.monitor_w).abs() / st.monitor_w.max(1.0)
        + (area_h - st.monitor_h).abs() / st.monitor_h.max(1.0);
    if size_drift > 0.4 {
        return false;
    }
    st.x < area_w - 80.0 && st.y < area_h - 80.0 && st.x + st.width > 0.0 && st.y + st.height > 0.0
}

fn restore_or_fit_window(win: &tauri::WebviewWindow) {
    let path = window_state_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => {
            fit_window_to_monitor(win);
            return;
        }
    };
    let st: WindowState = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(_) => {
            fit_window_to_monitor(win);
            return;
        }
    };
    let (Ok(Some(monitor)), Ok(scale)) = (win.current_monitor(), win.scale_factor()) else {
        fit_window_to_monitor(win);
        return;
    };
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    if !window_state_usable(&st, area.width, area.height) {
        fit_window_to_monitor(win);
        return;
    }
    let _ = win.set_min_size(Some(tauri::LogicalSize::new(MIN_W, MIN_H)));
    let _ = win.set_size(tauri::LogicalSize::new(st.width, st.height));
    let _ = win.set_position(tauri::LogicalPosition::new(st.x, st.y));
    if st.maximized {
        let _ = win.maximize();
    }
    println!(
        "[window] restored {}x{}@{}x{} maximized={}",
        st.width as u32, st.height as u32, st.x as i32, st.y as i32, st.maximized,
    );
}

fn fit_window_to_monitor(win: &tauri::WebviewWindow) {
    let (Ok(Some(monitor)), Ok(scale)) = (win.current_monitor(), win.scale_factor()) else {
        return;
    };
    let area = monitor.work_area();
    let logical = area.size.to_logical::<f64>(scale);

    // Budget for window chrome and a small margin.
    //
    // This dropped from 72 to 12 when the window became `decorations: false`:
    // the 72 was the title bar plus borders, and reserving it on a frameless
    // window just wastes 60 px of height that the status strip then loses. The
    // remainder covers the shadow Windows still draws around an undecorated
    // resizable window.
    const CHROME_H: f64 = 12.0;
    const MARGIN_W: f64 = 24.0;

    // A minimum that does not fit the screen is useless, so the floor is also
    // the clamp's floor.
    let max_w = (logical.width - MARGIN_W).max(MIN_W);
    let max_h = (logical.height - CHROME_H).max(MIN_H);

    // Open at the minimum. The previous behaviour opened at 1200x820, which the
    // report asked to change to "初始化即为最小尺寸", derived from the display
    // rather than hard-coded so a different scaling factor stays correct.
    let want_w = MIN_W.min(max_w);
    let want_h = MIN_H.min(max_h);

    let _ = win.set_min_size(Some(tauri::LogicalSize::new(MIN_W, MIN_H)));
    let _ = win.set_size(tauri::LogicalSize::new(want_w, want_h));
    let _ = win.center();

    // Report the decision once, so a wrong size is visible in the console instead
    // of silently cropping the UI again. `outer` is physical pixels including the
    // title bar, which is what a screen-measuring tool reports.
    let outer = win
        .outer_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|_| "?".to_string());
    println!(
        "[window] scale={scale} work_area={:.0}x{:.0} client={:.0}x{:.0} outer={outer} min={MIN_W}x{MIN_H}",
        logical.width, logical.height, want_w, want_h,
    );
}

// ---------------------------------------------------------------------------
// git worktree（第十六轮方向 N1）
// ---------------------------------------------------------------------------
//
// Thin shells only, on purpose: `lib.rs` has carried the whole command surface for
// fifteen rounds and round 15's report recorded that nothing had been extracted
// from it yet. The behaviour — the porcelain parser, the placement rule, the
// containment guard, the git calls — is in `gitwt.rs`; what is left here is the
// `#[tauri::command]` boundary, the slug resolution, and the 记录 write, which are
// this file's business because they are what every other command here already does.

/// One repository and the project root it actually sits under.
///
/// `project_root()` alone would be wrong: `project_roots()` can hold several
/// containers, `_worktrees` belongs to the one the clone lives in, and a worktree
/// created for a repository on an extra root would otherwise land in the main
/// root's container — invisible to the 删除项目 sweep of the root it was made for.
pub(crate) fn repo_and_root(slug: &str) -> Result<(PathBuf, PathBuf), String> {
    let repo = find_repo_any(slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
    let root = project_roots()
        .into_iter()
        .find(|r| repo.starts_with(r))
        .unwrap_or_else(project_root);
    Ok((repo, root))
}

// The three command shells (`list_repo_worktrees` / `add_repo_worktree` /
// `remove_repo_worktree`) moved to `gitwt.rs` in r20-O3-2. `repo_and_root` stays:
// eleven other commands in this file resolve a slug through it.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = match tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch must not start a second window: both would share
            // 项目/ and race on .devhub.json + the activity log. Instead pull
            // the existing window to the front.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            // N3: 第二次启动时 argv 里可能有 devhub:// URL，解析并转发给前端。
            if let Some(url) = argv.iter().find(|a| a.starts_with("devhub://")) {
                match deeplink::parse(url) {
                    Ok(deeplink::DeepLink { action }) => {
                        if let Err(e) = action.emit(app) {
                            eprintln!("[deeplink] second-instance emit 失败：{e}");
                        }
                    }
                    Err(e) => eprintln!("[deeplink] 解析失败：{e}"),
                }
            }
        }))
        .manage(Settings::from_config(&read_config()))
        .manage(downloads_cmd::DownloadCancels::default())
        .setup(|app| {
            // First, so a panic during the rest of setup is also recorded. The
            // hook runs before `panic = "abort"` terminates the process and only
            // writes a local file; see docs/research/crash-observability.md.
            crash::install(crash::crash_path());
            // One reaping/push loop for the process table: a crash is pushed within
            // `WATCH_EVERY` instead of waiting for the webview's 2 s poll, which
            // stays in place as the authoritative fallback.
            process_events::start_monitor(app.handle().clone());
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title("DevHub");
                // The reported sequence was: a large white window, then it shrinks,
                // then a long "正在加载" before anything appeared. The first two are
                // handled here — the config starts the window hidden, and this sizes it
                // to its final shape before anyone can see it. The third is the page's
                // job: `index.html` paints an animated boot surface with an elapsed
                // clock, and only then does `note_boot_painted` reveal the window.
                // Nothing is shown before there is something to show.
                restore_or_fit_window(&win);
            }
            // The deadline. It is not a fallback for a slow page so much as a
            // guarantee that a page which never signals cannot hide the app.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(
                    BOOT_REVEAL_DEADLINE_MS,
                ));
                reveal_window(&handle, "deadline");
            });
            // The scheduled clean-up runs here rather than on a timer: the app is
            // a launcher that is closed between uses, so a timer would mostly
            // fire while it was shut down. Lazy-on-open is the same result with
            // one fewer thread.
            settings_cmd::migrate_token_storage_on_startup();
            let removed = apply_due_cleanup();
            if removed > 0 {
                println!("[cleanup] 计划清理删除 {removed} 条记录");
            }

            // r33-D1: crash residue (stale atomic temps, cover parts, interrupted
            // clones) is swept off the startup thread; see `sweep.rs`.
            sweep::spawn_startup_sweep();

            // N3: Deep Link 处理——克隆走搜索+下载，open 交给前端打开本地项目。
            let Some(action) = deeplink::extract_action() else {
                return Ok(());
            };
            println!("[deeplink] 收到请求：{action:?}");
            if let Err(e) = action.emit(app.handle()) {
                eprintln!("[deeplink] setup emit 失败：{e}");
            }
            Ok(())
        })
        // r17-n3-1: 关闭时把窗口边界写进 sidecar，下次启动还原。只在 CloseRequested
        // 抓一次，不跟 resize 流写盘（拖拽中途崩溃不留半拉尺寸）。
        .on_window_event(|win, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_window_state(win);
            }
        })
        .invoke_handler(tauri::generate_handler![
            environment,
            netstatus::net_status,
            preview_ref, preview::preview_remote,
            downloads_cmd::download_preflight,
            downloads_cmd::download_repo,
            downloads_cmd::cancel_download,
            update_repo,
            repo_freshness,
            repo_freshness_many,
            searchgrep::repo_grep,
            files::repo_files,
            deps::check_dependencies,
            docker::docker_status,
            docker::project_has_compose,
            deeplink::register_deeplink,
            repo_worktree_status,
            commits::repo_commits,
            list_pythons,
            set_python_choice,
            create_repo_venv,
            remove_repo_venv,
            gitwt::list_repo_worktrees,
            gitwt::add_repo_worktree,
            gitwt::remove_repo_worktree,
            repo_port_health,
            list_repositories,
            repo_metadata,
            scrub_stored_credentials,
            storage_cmd::repo_storage_breakdown,
            update_check::check_app_update,
            update_check::app_version,
            crash::last_crash,
            crash::clear_crash,
            webview2::webview2_info,
            ensure_git,
            git_bootstrap_status,
            repo_detail,
            detect_launch_commands,
            assess_launch_commands,
            install_plan,
            confirm_launch,
            confirm_launch_steps,
            launch_repo,
            launch_step,
            launch_steps_all,
            process_states,
            live_processes,
            stop_process,
            suspend_process,
            open_terminal_with,
            open_ide_with,
            open_in_explorer,
            reveal_path,
            list_terminals,
            list_ides,
            fonts::list_system_fonts,
            add_custom_ide,
            remove_custom_ide,
            save_tool_choice,
            activity_cmd::list_activity,
            activity_cmd::clear_activity,
            activity_cmd::delete_activity,
            activity_cmd::delete_activity_many,
            activity_cmd::log_activity,
            activity_cmd::undo_plan,
            activity_cmd::mark_activity_undone,
            apply_config_value,
            delete_downloaded,
            run_due_cleanup,
            write_text_file,
            read_text_file,
            file_stream::read_text_file_stream,
            activity_cmd::export_activity,
            diagnostics::export_diagnostics,
            repo_environments,
            clear_env_cache,
            scan_cache,
            clear_cache,
            delete_repo,
            trash_repo,
            restore_from_trash,
            set_repo_launch_defaults,
            settings_cmd::get_settings,
            settings_cmd::save_settings,
            settings_cmd::forget_recent_root,
            settings_cmd::validate_project_root,
            search_cmd::search_repositories,
            search_cmd::verify_github_token,
            search_cmd::repo_heat_many,
            fs_watch::watch_repositories,
            search_cmd::repo_readme,
            search_cmd::search_status,
            search_cmd::clear_search_cache,
            search_cmd::list_starred_repos,
            covers::fetch_cover,
            covers::custom_cover,
            note_boot_painted,
            covers::cover_cache_size,
            covers::clear_cover_cache
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            // 生产代码里最后一条 panic 通道，r18-o2 清掉：`panic = "abort"` 下
            // `.expect()` 只会中止进程、连原因都留不下。一条 match 臂把构建错误
            // 打到 stderr 并以非零码退出，shell 与 CI 都看得见。
            eprintln!("DevHub failed to start: {err}");
            std::process::exit(1);
        }
    };
    app.run(|app_handle, event| {
        // The last hook that still runs inside this process. Until now there was
        // no exit policy at all: `Tracked` owns a `std::process::Child`, dropping
        // a child detaches instead of terminating, so quitting with a dev server
        // running left it alive and holding its allocated port with no window
        // anywhere that could stop it.
        if let tauri::RunEvent::Exit = event {
            fs_watch::stop_native_watchers();
            let procs = app_handle.state::<Settings>().procs.clone();
            // `kill_tree` takes the mutex itself now (see its doc): the
            // taskkill sweep no longer holds the table lock.
            let (killed, failures) = kill_tree(&procs);
            if killed > 0 || !failures.is_empty() {
                let mut detail = format!("{killed} 个仍在运行的进程");
                if !failures.is_empty() {
                    detail.push_str(&format!(
                        " · {} 个子进程树未能终止，端口可能被占用：{}",
                        failures.len(),
                        failures.join("；")
                    ));
                    eprintln!("[exit] 孤儿进程风险: {detail}");
                }
                record_activity(
                    Log::new("launch", "退出时终止子进程", SRC_LAUNCH).detail(&detail),
                );
            }
        }
    });
}

/// Headless console-window probe:
/// `devhub-app.exe --spawn-check [--visible] -- <program> [args...]`
///
/// Spawns one child exactly the way the app spawns its helpers and waits for it.
/// With `--visible` the `CREATE_NO_WINDOW` flag is deliberately omitted, so the
/// difference is directly observable - and that is the point: "no terminal windows"
/// is otherwise a claim nobody can check. A console window can only appear from a
/// **release** build (the debug build has a console subsystem, so children inherit
/// its console instead of allocating one), which is also the build users run.
///
/// Example (release build, one shell running it, another watching for windows):
///   devhub-app.exe --spawn-check --visible -- cmd /c ping -n 6 127.0.0.1
///   devhub-app.exe --spawn-check           -- cmd /c ping -n 6 127.0.0.1
pub fn run_headless_spawn_check(args: &[String]) -> i32 {
    let visible = args.iter().any(|a| a == "--visible");
    let rest: Vec<&String> = match args.iter().position(|a| a == "--") {
        Some(pos) => args[pos + 1..].iter().collect(),
        None => {
            eprintln!("usage: devhub-app --spawn-check [--visible] -- <program> [args...]");
            return 2;
        }
    };
    if rest.is_empty() {
        eprintln!("usage: devhub-app --spawn-check [--visible] -- <program> [args...]");
        return 2;
    }

    let mut cmd = if visible {
        std::process::Command::new(rest[0])
    } else {
        proc::silent(rest[0])
    };
    cmd.args(&rest[1..]);
    println!("spawn-check: program={} create_no_window={}", rest[0], !visible);

    match cmd.spawn() {
        Ok(mut child) => {
            println!("pid={}", child.id());
            match child.wait() {
                Ok(status) => println!("exited={status}"),
                Err(e) => {
                    println!("ERROR 等待子进程失败: {e}");
                    return 1;
                }
            }
            0
        }
        Err(e) => {
            println!("ERROR 无法启动: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `update_repo` owes the freshness cache an eviction: after a pull moves
    /// HEAD, the slug's cached verdict describes a commit no longer checked out.
    /// This pins both halves of the policy — a *successful* update drops that
    /// slug's entry, a refused `--ff-only` pull keeps it, and the eviction is
    /// scoped to the slug that was updated.
    #[test]
    fn a_successful_update_evicts_only_that_slugs_freshness_entry() {
        let verdict = |slug: &str, state: &str| Freshness {
            slug: slug.to_string(),
            state: state.to_string(),
            local_head: None,
            remote_head: None,
            checked_at: 0,
            error: None,
        };
        freshness_store(&verdict("r17-updated", "behind"));
        freshness_store(&verdict("r17-untouched", "fresh"));

        invalidate_freshness_after_update(false, "r17-updated");
        assert!(
            freshness_cached("r17-updated").is_some(),
            "a refused pull leaves HEAD in place, so the cached verdict is still valid",
        );

        invalidate_freshness_after_update(true, "r17-updated");
        assert!(
            freshness_cached("r17-updated").is_none(),
            "after a successful update the slug's cache entry must no longer exist",
        );
        assert_eq!(
            freshness_cached("r17-untouched").map(|f| f.state),
            Some("fresh".to_string()),
            "eviction must be scoped to the slug that was updated",
        );

        // The cache is a process-wide singleton; leave it as we found it.
        freshness_evict("r17-untouched");
    }

    #[test]
    fn env_cache_stores_and_clears() {
        {
            let mut g = ENV_CACHE.lock().unwrap();
            let map = g.get_or_insert_with(Default::default);
            map.insert(
                "demo-slug".to_string(),
                (std::time::Instant::now(), Environments { python: Some("py".into()), node: None, docker: None, vscode: None }),
            );
        }
        {
            let g = ENV_CACHE.lock().unwrap();
            let env = g.as_ref().unwrap().get("demo-slug").unwrap().1.clone();
            assert_eq!(env.python.as_deref(), Some("py"));
        }
        clear_env_cache();
        let g = ENV_CACHE.lock().unwrap();
        assert!(g.as_ref().map(|m| m.is_empty()).unwrap_or(true));
    }

    /// The units in a history line have to read the same as the wall's own
    /// `formatBytes`, and the thresholds are where a hand-written ladder drifts:
    /// 1023 B stays bytes, 1024 becomes KB, and the GB step is the only one with
    /// two decimals. Pinned because `human_bytes` and `src/lib/format.ts` are two
    /// implementations of one contract with nothing between them but a comment.
    #[test]
    fn human_bytes_uses_the_binary_ladder() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(1024 * 1024 - 1), "1024.0 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(human_bytes(125_829_120), "120.0 MB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(human_bytes(1_610_612_736), "1.50 GB");
    }

    #[test]
    fn window_state_usable_rejects_off_screen_and_swapped_monitors() {
        // 同一台屏、窗口完全在工作区内 → 可用。
        let same_monitor = WindowState {
            x: 100.0, y: 80.0, width: 1200.0, height: 800.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(window_state_usable(&same_monitor, 1920.0, 1040.0));
        // 显示器换了尺寸（副屏拔掉/缩放变了）→ 不信任旧坐标。
        assert!(!window_state_usable(&same_monitor, 1366.0, 768.0));
        // 窗口跑到工作区右边外面去了 → 退回居中。
        let offscreen = WindowState {
            x: 2000.0, y: 80.0, width: 1200.0, height: 800.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(!window_state_usable(&offscreen, 1920.0, 1040.0));
        // 比最小还小的记录是坏数据，退回最小居中。
        let too_small = WindowState {
            x: 100.0, y: 80.0, width: 400.0, height: 300.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(!window_state_usable(&too_small, 1920.0, 1040.0));
    }

    #[test]
    fn phrase_helpers_answer_every_input_shape() {
        // An unknown mode must read 手动, not 每天 with an empty tail.
        assert_eq!(cleanup_phrase("manual", 30), "手动");
        assert_eq!(cleanup_phrase("", 30), "手动");
        assert_eq!(cleanup_phrase("daily", 0), "每天 · 保留 永久");
        assert_eq!(cleanup_phrase("weekly", 30), "每周 · 保留 30 天");
        assert_eq!(cleanup_phrase("monthly", 7), "每月 · 保留 7 天");
        assert_eq!(route_phrase("useHosts"), "沿用本地加速");
        assert_eq!(route_phrase("bypass"), "绕过（IP 直连）");
        assert_eq!(route_phrase("nonsense"), "绕过（IP 直连）");
        assert_eq!(retention_phrase(0), "永久");
        assert_eq!(retention_phrase(1), "1 天");
    }

    /// `reap` freezes `ran_for` at the exit moment, so retention measured with it
    /// never expired for a short-lived process. `exited_at` is the clock that must
    /// drive the TTL, and every path that marks a child exited has to set it.
    #[test]
    fn an_exit_stamps_the_retention_clock() {
        let child = proc::silent("cmd")
            .args(["/C", "exit"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd /C exit");
        let pid = child.id();
        let mut g = std::collections::HashMap::new();
        g.insert(
            pid,
            Tracked {
                child,
                label: "x".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );
        // Polled rather than slept-and-asserted: `cmd /C exit` is instantaneous in
        // theory, but on a machine running six other checkouts' typechecks it is
        // not, and a fixed 120 ms sleep made this test fail for load, not for
        // behaviour. The deadline only bounds how long we wait to observe it.
        for _ in 0..100 {
            reap(&mut g);
            if g.get(&pid).map(|t| t.exited).unwrap_or(false) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let t = g.get(&pid).expect("entry");
        assert!(t.exited, "the dead child must read as exited");
        assert!(
            t.exited_at.is_some(),
            "and the TTL clock must start; without it the entry is un-prunable"
        );
        assert!(t.ran_for.is_some(), "run duration stays frozen");
    }

    /// The exit policy has to take the child down, not merely relabel it. Spawning a
    /// real 30-ping child is the only way to ask that question here; `proc::silent`
    /// keeps it from flashing a console window during the test run.
    #[test]
    fn kill_tree_terminates_a_tracked_child_and_counts_it_once() {
        let child = proc::silent("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a long-running child");
        let pid = child.id();
        let procs = std::sync::Mutex::new(std::collections::HashMap::from([(
            pid,
            Tracked {
                child,
                label: "ping".into(),
                slug: "t/t".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        )]));

        let (killed, failures) = kill_tree(&procs);
        assert_eq!(killed, 1, "one running process, one kill");
        // `failures` is *allowed* to be non-empty here: this test runs on a machine
        // that may be building six worktrees at once, and the tree kill is bounded by
        // `PROBE_TIMEOUT`, so a starved `taskkill` can legitimately time out. What
        // must never happen is a silent one — see the deterministic case below, which
        // asserts the reporting path itself instead of the machine's composure.
        for f in &failures {
            assert!(
                f.contains("taskkill 超时") || f.contains("无法运行") || f.contains("PID"),
                "a reported tree-kill failure has to name its pid and reason: {f}"
            );
        }
        {
            let g = procs.lock().expect("table lock");
            let t = g.get(&pid).expect("the entry stays in the table");
            assert!(t.exited, "and it must read as exited afterwards");
            assert!(t.ran_for.is_some(), "with its run time frozen at the kill");
            assert!(
                t.exited_at.is_some(),
                "and the retention clock starts here, not at `ran_for`"
            );
        }
        assert_eq!(
            kill_tree(&procs).0,
            0,
            "a second pass must not re-count or re-kill what already went"
        );
    }

    /// The reporting path itself, without depending on the machine being idle.
    ///
    /// `kill_tree` used to drop every `taskkill` outcome, so an orphan holding a
    /// port after quit was invisible. A pid that cannot exist is the deterministic
    /// way to prove the failure is now surfaced and named.
    #[test]
    fn an_unkillable_pid_is_reported_instead_of_swallowed() {
        use std::collections::HashMap;
        let mut child = proc::silent("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a long-running child");
        let real = child.id();
        // A pid the OS will not find: `taskkill` fails fast on this, while the
        // real child keeps the entry live so the accounting path is exercised too.
        let ghost = if real == u32::MAX { real - 1 } else { u32::MAX };
        let procs = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        {
            let mut g = procs.lock().expect("table");
            g.insert(
                real,
                Tracked {
                    child,
                    label: "ping".into(),
                    slug: "t/t".into(),
                    started: std::time::Instant::now(),
                    exited: false,
                    code: None,
                    job_handle: None,
                    ran_for: None,
                    exited_at: None,
                    suspended: false,
                },
            );
        }
        let reaped = procs.lock().unwrap().remove(&real);
        if let Some(mut t) = reaped {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
        let mut g = procs.lock().unwrap();
        g.insert(
            ghost,
            Tracked {
                child: proc::silent("cmd")
                    .args(["/C", "ping", "-n", "30", "127.0.0.1"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .expect("spawn the second child"),
                label: "ghost".into(),
                slug: "t/t".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );
        drop(g);
        let (killed, failures) = kill_tree(&procs);
        assert_eq!(killed, 1, "the ghost entry is still counted as taken down");
        // Measured, not assumed: `taskkill /PID <nonexistent>` *starts fine* and
        // exits non-zero with 「没有找到进程」, so what must reach the caller is the
        // pid and that reason — the pre-fix code dropped both.
        assert!(
            failures.iter().any(|f| f.contains(&ghost.to_string()) && f.contains("ghost")),
            "the reported failure has to name the pid and the label it belongs to, got {failures:?}"
        );
        assert!(
            failures.iter().any(|f| {
                let s = f.to_lowercase();
                s.contains("没有找到进程") || s.contains("退出码") || s.contains("not found") || s.contains("exit code")
            }),
            "the OS reason must survive into the report, got {failures:?}"
        );
    }

    /// The failure mode the write lock exists for, made deterministic.
    ///
    /// Two transactions that each touch a *different* field lose one of them when
    /// both read before either writes: the second write is built on the pre-first
    /// read and reverts the first field on disk. A single field cannot show this
    /// (last-writer-wins is indistinguishable from a lost update), so the probe uses
    /// `terminal_choice` and `ide_choice`.
    ///
    /// Driven on plain values rather than against the real `devhub-config.json`: a
    /// test that rewrote the developer's own config would be worse than no test, which
    /// is the same reason `transact` takes the read/write pair as arguments.
    /// `reap` is what the process panel's 运行中/已退出 answer is built from, and it
    /// is the function that freezes `ran_for`. Nothing tested it: `proc.rs` tests the
    /// syscalls, not the registry the UI reads.
    #[test]
    fn reap_freezes_an_exited_child_once() {
        let mut child = proc::silent("cmd")
            .args(["/C", "exit", "3"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd /C exit 3");
        // Waited for here so the `try_wait` inside `reap` already has an answer: the
        // test is about what `reap` does with it, not about timing.
        let status = child.wait().expect("the child is gone");
        let pid = child.id();
        let mut g = std::collections::HashMap::new();
        g.insert(
            pid,
            Tracked {
                child,
                label: "npm run dev".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );

        reap(&mut g);
        let t = g.get(&pid).unwrap();
        assert!(t.exited, "an exited child must be marked exited");
        assert_eq!(t.code, status.code(), "and its exit code recorded");
        let first = t.ran_for.expect("frozen at the moment it went");

        reap(&mut g);
        assert_eq!(
            g.get(&pid).unwrap().ran_for,
            Some(first),
            "a second pass must not let the number keep growing - that was the old bug"
        );
    }

    /// The three states and the two affordance flags, because the frontend offers
    /// 停止/挂起 from `stoppable`/`suspendable` alone.
    #[test]
    fn summarise_reports_state_and_affordances() {
        fn tracked(exited: bool, suspended: bool, code: Option<i32>) -> Tracked {
            let child = proc::silent("cmd")
                .args(["/C", "exit"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn cmd /C exit");
            Tracked {
                child,
                label: "dev".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited,
                code,
                job_handle: None,
                ran_for: Some(std::time::Duration::from_millis(1500)),
                exited_at: if exited { Some(std::time::Instant::now()) } else { None },
                suspended,
            }
        }

        let mut g = std::collections::HashMap::new();
        g.insert(1, tracked(false, false, None));
        g.insert(2, tracked(false, true, None));
        g.insert(3, tracked(true, false, Some(7)));

        let mut rows: Vec<(u32, String, bool, bool, Option<i32>, u64)> = g
            .iter()
            .map(|(pid, t)| {
                let s = summarise(*pid, t);
                (
                    s.pid,
                    s.state,
                    s.stoppable,
                    s.suspendable,
                    s.exit_code,
                    s.elapsed_ms,
                )
            })
            .collect();
        rows.sort();

        assert_eq!(rows[0].1, "running", "neither exited nor suspended");
        assert!(rows[0].2 && rows[0].3, "running is stoppable and suspendable");
        assert_eq!(rows[1].1, "suspended");
        assert_eq!(rows[2].1, "exited");
        assert_eq!(rows[2].4, Some(7), "the exit code reaches the panel");
        assert!(
            !rows[2].2 && !rows[2].3,
            "an exited process must not offer 停止 or 挂起"
        );
        for row in rows.iter() {
            assert_eq!(row.5, 1500, "ran_for is what the elapsed number reports");
        }
        for t in g.values_mut() {
            let _ = t.child.wait();
        }
    }

    #[test]
    fn an_interleaved_read_modify_write_reverts_the_other_field() {
        // Not driven with threads on purpose: forcing "both read before either writes"
        // needs a barrier inside the read, and the gated run then deadlocks on that
        // barrier by construction. `gated_transactions_never_lose_an_increment` covers
        // the concurrent half; this one pins the *arithmetic* of the failure.
        let base = AppConfig::default();

        // Ungated: both transactions start from the same old value.
        let a = {
            let mut c = base.clone();
            c.terminal_choice = "pwsh".into();
            c
        };
        let b = {
            let mut c = base.clone();
            c.ide_choice = "code".into();
            c
        };
        // The point of the shape: `b` was built from `base`, so writing it after `a`
        // reverts `a`'s field.
        // A writes, then B — still holding a pre-A snapshot — writes over it. Both
        // bindings are used on purpose: naming them is what keeps the lost update
        // readable, and `let _ = a` would let the compiler drop the first write.
        let after_a = a;
        let disk = {
            let _ = &after_a;
            b
        };
        assert_eq!(disk.ide_choice, "code");
        assert_ne!(
            disk.terminal_choice, "pwsh",
            "A's choice was reverted by B's stale write — that is the lost update"
        );

        // Gated: B reads what A left behind, so both land.
        let mut disk = base;
        {
            let mut c = disk.clone();
            c.terminal_choice = "pwsh".into();
            disk = c;
        }
        {
            let mut c = disk.clone();
            c.ide_choice = "code".into();
            disk = c;
        }
        assert_eq!(disk.terminal_choice, "pwsh");
        assert_eq!(disk.ide_choice, "code");
    }

    /// The concurrent half, and the reason the gate spans the whole read→edit→write
    /// sequence: 24 gated transactions against one field all land.
    #[test]
    fn gated_transactions_never_lose_an_increment() {
        use std::sync::{Arc, Mutex};
        const N: usize = 24;
        let stored = Arc::new(Mutex::new(AppConfig::default()));
        let gate = Arc::new(Mutex::new(()));
        // `AppConfig::default().parallel_downloads` is not zero (it is the shipped
        // default), so the assertion is about the delta, not the absolute number.
        let before = stored.lock().unwrap().parallel_downloads;

        std::thread::scope(|scope| {
            for _ in 0..N {
                let stored = Arc::clone(&stored);
                let gate = Arc::clone(&gate);
                scope.spawn(move || {
                    // Taken here rather than passed to `transact` because production's
                    // gate is a `&'static Mutex` (`CONFIG_WRITE`) while this store lives
                    // on the test's stack; the span under test is identical.
                    let _guard = gate.lock().unwrap();
                    let read = {
                        let stored = Arc::clone(&stored);
                        move || Ok(stored.lock().unwrap().clone())
                    };
                    let write = {
                        let stored = Arc::clone(&stored);
                        move |c: &AppConfig| {
                            *stored.lock().unwrap() = c.clone();
                            Ok(())
                        }
                    };
                    if transact(None, read, write, |cfg| {
                        cfg.parallel_downloads += 1;
                        Ok(())
                    })
                    .is_err()
                    {
                        panic!("the in-memory store never fails to write");
                    }
                });
            }
        });

        assert_eq!(
            stored.lock().unwrap().parallel_downloads as usize,
            before as usize + N,
            "every gated increment must be present; fewer is the lost update"
        );
    }

    /// What `transact` guarantees, and what the validating callers depend on: an edit
    /// that returns `Err` persists nothing — not even the fields it already mutated in
    /// place. (`update_config_if_changed`'s "unchanged means no write" rule lives in
    /// that helper rather than here, so this pins the failure path only.)
    #[test]
    fn a_rejected_edit_writes_nothing() {
        use std::sync::{Arc, Mutex};
        let stored = Arc::new(Mutex::new(AppConfig::default()));
        let writes = Arc::new(Mutex::new(0usize));
        let before = stored.lock().unwrap().clone();
        let read = {
            let stored = Arc::clone(&stored);
            move || Ok(stored.lock().unwrap().clone())
        };
        let write = {
            let stored = Arc::clone(&stored);
            let writes = Arc::clone(&writes);
            move |c: &AppConfig| {
                *stored.lock().unwrap() = c.clone();
                *writes.lock().unwrap() += 1;
                Ok(())
            }
        };
        let err = transact(None, read, write, |cfg| {
            cfg.terminal_choice = "cmd".into();
            // Annotated because this edit only ever fails, so `T` has no other
            // occurrence to be inferred from.
            Err::<(), _>("拒绝：这个选择不合法".to_string())
        })
        .unwrap_err();
        assert_eq!(err, "拒绝：这个选择不合法");
        assert_eq!(*writes.lock().unwrap(), 0, "a rejected edit must not persist");
        assert_eq!(
            stored.lock().unwrap().terminal_choice, before.terminal_choice,
            "and the mutation it made in memory must not have reached the store"
        );
    }

    /// undoable `value` descriptor must be reversible by the same key it was
    /// recorded under. If a setting starts recording an undo that
    /// `restore_config_value` does not know, the button appears and does nothing
    /// — which is worse than not offering it, so this test is the guard.
    #[test]
    fn every_recorded_undo_key_is_reversible() {
        let cases: &[(&str, &str)] = &[
            ("projectRoot", "D:\\somewhere\\else"),
            ("searchRoute", "useHosts"),
            ("downloadRoute", "bypass"),
            ("terminalChoice", "pwsh"),
            ("ideChoice", "vscode"),
            ("cleanupMode", "weekly"),
            ("mirrorEnabled", "false"),
            ("ipPinEnabled", "true"),
            ("activityRetentionDays", "90"),
            ("cleanupKeepDays", "7"),
            ("searchDebounceMs", "1200"),
            ("parallelDownloads", "5"),
        ];
        for (key, value) in cases {
            let mut cfg = AppConfig::default();
            restore_config_value(&mut cfg, key, value)
                .unwrap_or_else(|e| panic!("{key} is recorded as undoable but failed: {e}"));
        }
    }

    #[test]
    fn restoring_a_value_actually_changes_that_field_only() {
        let mut cfg = AppConfig::default();
        let before = (cfg.ip_pin_enabled, cfg.mirror_enabled, cfg.project_root.clone());
        restore_config_value(&mut cfg, "searchDebounceMs", "300").unwrap();
        assert_eq!(cfg.search_debounce_ms, 300);
        // The whole point of a per-field 回退 is that it does not also move
        // unrelated settings back to their defaults.
        assert_eq!(
            (cfg.ip_pin_enabled, cfg.mirror_enabled, cfg.project_root.clone()),
            before,
            "回退 one key must not disturb the others"
        );
    }

    #[test]
    fn a_recent_root_can_be_forgotten() {
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\old".into(), "D:\\older".into()];
        assert!(remove_recent_root(&mut cfg, "D:\\old").unwrap());
        assert_eq!(cfg.recent_roots, vec!["D:\\older".to_string()]);
        assert_eq!(cfg.project_root, "D:\\now", "删除历史不应动当前主目录");
    }

    #[test]
    fn the_live_main_root_is_never_erasable_from_history() {
        // 需求3 把它合并进同一张列表后，这条路径才真正可达：以前历史目录是
        // 只读的，用户碰不到「移除」；合并后如果这里放行，主目录会被自己
        // 抹掉，合并列表随即多出一条同路径的重复项。
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\now".into()];
        assert!(remove_recent_root(&mut cfg, "d:\\NOW").is_err());
        assert_eq!(cfg.recent_roots, vec!["D:\\now".to_string()]);
    }

    #[test]
    fn restore_refuses_bin_entries_that_belong_to_someone_else() {
        // 回收站里不止有 DevHub 删掉的东西：`restore_from_bin` 按 original_path 匹配
        // 整个回收站，所以「页面发来一个路径」并不等于「这个路径属于本项目」。
        // 不加约束时，一条被改坏的 回退 记录就能把别的程序删掉的文件还原到
        // 谁都没选过的位置。
        let container = std::env::temp_dir().join("devhub-restore-container");
        let elsewhere = std::env::temp_dir().join("devhub-restore-elsewhere");
        let _ = std::fs::remove_dir_all(&container);
        let _ = std::fs::remove_dir_all(&elsewhere);
        std::fs::create_dir_all(&container).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        let inside = container.join("tool_alice").to_string_lossy().to_string();
        let foreign = elsewhere.join("report.docx").to_string_lossy().to_string();

        assert!(
            restore_targets(&[inside.clone()], &[container.clone()]).is_empty(),
            "仓库目录内的还原目标不该被拦"
        );
        assert_eq!(
            restore_targets(&[foreign.clone()], &[container.clone()]),
            vec![foreign.clone()],
            "容器之外的路径必须被拒绝，哪怕它真实存在"
        );
        // 一批里混进一条外部路径，拒的就是那一条；命令按「有拒绝就整批不做」处理，
        // 而不是悄悄还原其余的。
        assert_eq!(
            restore_targets(&[inside, foreign], &[container.clone()]).len(),
            1
        );
        let _ = std::fs::remove_dir_all(&container);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn forgetting_something_already_gone_is_a_no_op_not_an_error() {
        // 用户可以两个窗口各点一次，或手工改过配置。重复删除应当安静成功，
        // 否则第二次点击会弹一个无法解释的失败。
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\old".into()];
        assert!(!remove_recent_root(&mut cfg, "D:\\never-there").unwrap());
        assert_eq!(cfg.recent_roots, vec!["D:\\old".to_string()]);
        assert!(remove_recent_root(&mut cfg, "   ").is_err());
    }

    #[test]
    fn an_unrecorded_key_errors_rather_than_silently_succeeding() {
        let mut cfg = AppConfig::default();
        assert!(restore_config_value(&mut cfg, "githubToken", "x").is_err());
        // A value that cannot parse must surface, not leave the old number in
        // place while the UI reports 已回退.
        assert!(restore_config_value(&mut cfg, "parallelDownloads", "many").is_err());
    }

    #[test]
    fn a_fresh_config_enables_ip_pinning() {
        // `default_true` on AppConfig is the documented default; the UI states it
        // and the downloader's layer 2 depends on it.
        let cfg = AppConfig::default();
        assert!(
            cfg.ip_pin_enabled,
            "IP pinning must default to enabled; using derive(Default) here would silently disable layer 2"
        );
        assert!(!cfg.mirror_enabled, "third-party mirrors stay opt-in");
    }

    #[test]
    fn settings_state_is_seeded_from_the_saved_config() {
        let cfg = AppConfig {
            mirror_enabled: true,
            ip_pin_enabled: false,
            ..Default::default()
        };
        let settings = Settings::from_config(&cfg);
        assert!(locked_bool(&settings.mirror_enabled, false));
        assert!(!locked_bool(&settings.ip_pin_enabled, true));

        // And the seeder must not invert the default for a config that has never
        // been written: `AppConfig::default()` keeps pinning on.
        let fresh = Settings::from_config(&AppConfig::default());
        assert!(locked_bool(&fresh.ip_pin_enabled, true));
    }

    /// A scratch container laid out the way the real one is allowed to be:
    /// the current flat `<repo>_<owner>` form, the legacy
    /// `code/<host>/<owner>/<repo>` form, DevHub's own bookkeeping directories,
    /// a marked-but-not-cloned directory (an archive download has no `.git`),
    /// and a plain directory that is nothing at all.
    ///
    /// Named per test: these run in parallel in one process, and a container
    /// shared between them would be wiped by whichever finished first.
    fn guard_fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("devhub-delguard-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "tool_alice/.git",
            "code/github.com/bob/legacy/.git",
            "venvs/tool_alice",
            "cache/covers",
            "_worktrees/alice__tool",
            "not_a_project",
            "marked_only",
            "tool_alice/subdir",
            ".hidden/repo/.git",
        ] {
            std::fs::create_dir_all(root.join(dir)).expect("fixture");
        }
        // The archive-download case: no git history, only what the downloader
        // wrote. This is what makes the marker half of the rule necessary.
        std::fs::write(
            downloader::marker_path(&root.join("marked_only")),
            r#"{"slug":"github.com/carol/marked_only","url":"https://github.com/carol/marked_only.git","clonedAt":"","portBase":0,"services":[]}"#,
        )
        .expect("marker");
        root
    }

    #[test]
    fn the_delete_guard_allows_the_directories_the_container_lists_as_projects() {
        let root = guard_fixture("allows");
        let roots = [root.clone()];

        for rel in ["tool_alice", "code/github.com/bob/legacy"] {
            let (r, t) = path_guard::check_delete_target(&roots, &root.join(rel))
                .unwrap_or_else(|e| panic!("{rel} was refused: {e}"));
            let href = downloader::repo_ref_of(&r, &t)
                .unwrap_or_else(|| panic!("{rel} should resolve to a repository"));
            // The pair must be self-consistent: `delete_repo` compares the
            // repository's parent against this root when pruning an emptied
            // directory, so returning the two in different normal forms would
            // silently disable that cleanup.
            assert!(t.starts_with(&r), "{rel}: {t:?} is not under {r:?}");
            assert!(!href.slug().is_empty());
        }

        // An archive download carries only the marker, and a 回退 of it has to
        // work as well as a clone's.
        let marked = root.join("marked_only");
        let (_r, t) = path_guard::check_delete_target(&roots, &marked).expect("marked allowed");
        assert_eq!(
            downloader::read_marker(&t).map(|m| m.url),
            Some("https://github.com/carol/marked_only.git".to_string())
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_delete_guard_refuses_devhubs_own_directories_and_the_root() {
        let root = guard_fixture("refuses");
        let roots = [root.clone()];

        // Each of these is a directory the app cares about, none is a project:
        // the venv of another repository, the cover cache, a worktree copy, the
        // container itself, and a dot directory that the walk skips.
        for (rel, want) in [
            ("", "就是项目根目录"),
            ("venvs", "DevHub 自己的目录"),
            ("venvs/tool_alice", "DevHub 自己的目录"),
            ("cache", "DevHub 自己的目录"),
            ("_worktrees", "DevHub 自己的目录"),
            (".hidden", "DevHub 自己的目录"),
            (".hidden/repo", "DevHub 自己的目录"),
            ("not_a_project", "不是"),
            ("tool_alice/subdir", "不是"),
        ] {
            let p = if rel.is_empty() {
                root.clone()
            } else {
                root.join(rel)
            };
            let err = path_guard::check_delete_target(&roots, &p)
                .expect_err(&format!("{rel} must be refused"));
            assert!(
                err.contains(want),
                "{rel} was refused for the wrong reason: {err}"
            );
        }

        // Refusing has to mean refusing: the guard runs before anything is
        // removed, so everything it turned down must still be on disk.
        assert!(root.join("venvs/tool_alice").exists(), "refusing deleted");
        assert!(root.join("tool_alice/.git").exists());
        assert!(root.join("_worktrees/alice__tool").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_delete_guard_refuses_a_path_outside_every_root() {
        let root = guard_fixture("outside");
        let other =
            std::env::temp_dir().join(format!("devhub-delguard-other-{}", std::process::id()));
        std::fs::create_dir_all(other.join("stranger/repo/.git")).expect("fixture");
        let err = path_guard::check_delete_target(&[root.clone()], &other.join("stranger/repo"))
            .expect_err("must refuse");
        assert!(err.contains("不在任何项目根目录内"), "{err}");

        // A nested container is why one root's objection must not end the search.
        // `inside_repo_container/` sits *within* a repository as far as the first
        // root is concerned — the walk reports the repository and never descends
        // into it — while the second root was pointed at it directly, and there
        // it is an ordinary project. That is not hypothetical: the worktree
        // feature puts clones inside a repository.
        let nested = root.join("tool_alice/inside_repo_container");
        let inside = nested.join("repo/.git");
        std::fs::create_dir_all(inside).expect("fixture");
        let roots = [root.clone(), nested.clone()];
        let (r, t) = path_guard::check_delete_target(&roots, &nested.join("repo"))
            .unwrap_or_else(|e| panic!("the second root should have allowed it: {e}"));
        assert!(t.starts_with(&r));
        assert_eq!(
            r.file_name().and_then(|n| n.to_str()),
            Some("inside_repo_container")
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn the_delete_guard_says_so_for_a_directory_that_is_already_gone() {
        let root = guard_fixture("gone");
        let err = path_guard::check_delete_target(&[root.clone()], &root.join("alice/not-cloned"))
            .expect_err("missing");
        assert!(err.contains("已不存在"), "{err}");

        let err = path_guard::check_delete_target(&[root.clone()], std::path::Path::new(""))
            .expect_err("empty");
        assert!(err.contains("没有记下下载位置"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

}

