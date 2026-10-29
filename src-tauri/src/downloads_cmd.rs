//! The download command and its cancellation registry (r27-O2/O1).
//!
//! Extracted from `lib.rs` when the r27 additions pushed that file past its
//! line ceiling. The move is mechanical: the command body, the state type and
//! the `TASK_COUNTER` are unchanged; `use super::*` keeps every helper and
//! private constant resolving exactly as before.

use super::*;
use tauri::Emitter;

/// Cancellation flags for in-flight downloads, keyed by the frontend task id.
///
/// The registry is Tauri-managed state because a cancel request arrives on a
/// different IPC call while `download_repo` is parked in `spawn_blocking`. An
/// entry lives only for the duration of that call; `download_repo` removes it on
/// every exit path, including a panic in the join handle.
#[derive(Default)]
pub(crate) struct DownloadCancels(std::sync::Mutex<std::collections::HashMap<String, downloader::CancelToken>>);

impl DownloadCancels {
    fn insert(&self, task: &str, token: downloader::CancelToken) {
        if let Ok(mut g) = self.0.lock() {
            g.insert(task.to_string(), token);
        }
    }

    /// Marks the task, if it is still running. A cancel that arrives after the
    /// worker removed its entry is a no-op and returns false.
    fn cancel(&self, task: &str) -> bool {
        let token = self.0.lock().ok().and_then(|g| g.get(task).cloned());
        match token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    fn remove(&self, task: &str) {
        if let Ok(mut g) = self.0.lock() {
            g.remove(task);
        }
    }
}

/// Cancels one running download. Returns false when the task is unknown (it
/// already finished, or the id came from a different session).
#[tauri::command]
pub(crate) fn cancel_download(cancels: tauri::State<'_, DownloadCancels>, task: String) -> bool {
    cancels.cancel(&task)
}

#[tauri::command]
pub(crate) async fn download_repo(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Settings>,
    cancels: tauri::State<'_, DownloadCancels>,
    input: String,
    // Which view issued it. The command is reachable from both the 项目墙 empty
    // state and the 添加页, and the record is supposed to say where.
    source: Option<String>,
    // Identifies *which* download a progress event belongs to.
    //
    // Concurrent downloads were blocked by the frontend, not the backend: each
    // call already built its own `Downloader` and ran on `spawn_blocking`, but
    // there was one `log`/`stages`/`outcome` triple and one `downloadBusy`
    // boolean, so a second clone would have overwritten the first one's
    // progress. Tagging the events is the only backend change that takes.
    task: Option<String>,
    // Overrides the computed landing directory for this one download (the add
    // view's 高级选项 editor). None/empty = the usual `<root>/<repo>_<owner>`.
    target_dir: Option<String>,
    // Branch to check out. `None`/empty means the remote's default branch;
    // validated and stored in the marker by the downloader.
    branch: Option<String>,
    // Re-download over an occupied landing directory (round 11, 需求 8.7). The
    // frontend only sends this after the user confirmed what would be replaced;
    // the port block survives the overwrite.
    overwrite: Option<bool>,
) -> Result<DownloadOutcome, String> {
    let source = source.as_deref().unwrap_or(SRC_ADD);
    let cfg = build_config(&settings);
    let runtime = bundled_runtime_dir();
    let max_parallel = read_config().parallel_downloads;

    // The add view's 高级选项 field is free text, so this is the one place a
    // download can be pointed outside the container. Contained by `path_guard` like
    // every other page-supplied path, and replaced by the canonical path it approved
    // so git writes exactly where the check looked - the `\\?\` prefix is stripped
    // again here because this string reaches an external program.
    //
    // Checked before the progress sink is built, because that closure takes the app
    // handle and the guard needs it too.
    let target_override = match target_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => {
            let guarded = path_guard::guard(&app, dir, path_guard::Access::Write)?;
            Some(netpath::strip_verbatim(&guarded).to_string_lossy().to_string())
        }
        None => None,
    };

    // Forward downloader progress to the UI as it happens.
    //
    // When the frontend omits `task`, two concurrent downloads of the same
    // repo would share the whole input string as their channel tag, and their
    // progress lines would interleave: the `maxParallel` config above is the
    // concurrency mechanism, and the tag is how the UI distinguishes one
    // download from another. A deterministic per-process counter makes every
    // default download distinguishable, so `maxParallel` stops silently
    // defeating itself.
    static TASK_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let task_id = match task {
        Some(t) => t,
        None => {
            let n = TASK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            format!("{input}-{n}")
        }
    };
    let cancel_key = task_id.clone();
    let sink: downloader::ProgressFn = std::sync::Arc::new(move |stage: &str, message: &str| {
        app.emit(
            "download://progress",
            serde_json::json!({
                "stage": stage,
                "message": message,
                "task": task_id.as_str(),
                "maxParallel": max_parallel,
            }),
        )
        .ok();
    });

    // Registered before the worker starts, so a cancel that arrives between the
    // click and the first git spawn is not lost.
    let cancel_token = downloader::CancelToken::default();
    cancels.insert(&cancel_key, cancel_token.clone());

    // git is blocking; keep it off the async runtime's worker threads.
    let input_for_log = input.clone();
    // `target_override` was already resolved above through `path_guard` — the
    // feature branch carried the pre-guard line, so only the new flag lands here.
    let overwrite = overwrite.unwrap_or(false);
    let branch = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    let joined = tauri::async_runtime::spawn_blocking(move || {
        // Git resolution belongs inside the worker. The first resolution of a
        // session walks `PATH` and runs `git --version`, measured at 2.7 s by
        // `preview_ref`'s comment; doing it here instead meant 2.7 s of runtime
        // thread spent before a clone had even begun, and every concurrent
        // download's `Downloader::new` paid it too.
        let dl = Downloader::new(cfg, runtime)?.with_cancel(cancel_token);
        dl.download_to(
            sink,
            &input,
            target_override.as_deref(),
            overwrite,
            branch.as_deref(),
        )
    })
    .await;
    // Before the activity record and before `?`: a task id that outlives its
    // worker would make a late cancel look like it reached a live clone.
    cancels.remove(&cancel_key);
    let result = joined.map_err(|e| format!("下载任务异常: {e}"))?;

    match &result {
        Ok(outcome) => record_activity(
            Log::new("download", "下载仓库", source)
                .detail(&format!("通过 {:?}", outcome.layer))
                .slug(&input_for_log)
                .target(&format!("repo:{}", input_for_log))
                .change("", &outcome.path)
                // Reversible: the undo of a download is deleting what it created.
                .undo(activity::Undo::delete_dir(&outcome.path))
                .path_str(&outcome.path),
        ),
        Err(downloader::DownloadError::Cancelled) => record_activity(
            Log::new("download", "取消下载", source)
                .detail("用户取消，已清理半成品目录")
                .slug(&input_for_log),
        ),
        Err(e) => record_activity(
            Log::new("download", "下载失败", source)
                .detail(&e.to_string())
                .slug(&input_for_log),
        ),
    }

    result.map_err(|e| e.to_string())
}

/// Facts the download queue checks before it starts git (r31-O2).
///
/// No network and no git resolution: the path is computed by the same pure
/// `target_path_for` the downloader uses, then the filesystem answers occupancy
/// and free space. The queue turns these facts into a refusal before spawning a
/// clone that the backend would reject after its first git call.
#[tauri::command]
pub(crate) async fn download_preflight(
    app: tauri::AppHandle,
    input: String,
    target_dir: Option<String>,
) -> Result<downloader::DownloadPreflight, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r: RepoRef = downloader::parse_ref(&input).map_err(|e| e.to_string())?;
        let target = match target_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(dir) => {
                // The same Write guard the download uses; a preflight that said
                // "fine" for a path the download later refuses would be worse than
                // no preflight.
                let guarded = path_guard::guard(&app, dir, path_guard::Access::Write)?;
                netpath::strip_verbatim(&guarded)
            }
            None => downloader::target_path_for(&project_root(), &r),
        };
        Ok(downloader::preflight_for(&target))
    })
    .await
    .map_err(|e| format!("下载预检任务异常: {e}"))?
}
