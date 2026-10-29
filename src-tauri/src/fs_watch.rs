//! r17-r3 / r18-R1: 仓库目录变更的监听核心，以及把它接起来的那条链路。
//!
//! 调研结论（本轮重新核对，见 `docs/fs-watch.md`）：跨平台监听最成熟的是
//! [notify](https://crates.io/crates/notify)（Windows 用 ReadDirectoryChangesW，跨平台统一
//! API）。但 notify 是一个后台线程 + OS 句柄，不好单测；真正项目特定的难点是**爆发式写入
//! 要合并成一次「仓库可能变了」通知**——IDE 保存、git checkout、npm install 都会一次改几百个
//! 文件，逐个 event 会把 UI 刷爆。
//!
//! 所以这里把「合并」这层抽成纯函数 `DebouncedBatch`，不持有任何 OS 句柄，可在 `cargo test`
//! 里完整覆盖。r18-R1 在它前面补上 `ChangeDetector`：一次扫描只读「目录里有多少条目 + 最新
//! mtime」这个量级的信息，不递归，因此一轮扫描的成本与仓库大小近似无关（递归走一遍才是贵的，
//! 那是 `metadata.rs` 的账）。
//!
//! ## 为什么这一版仍然不是 ReadDirectoryChangesW
//!
//! 两条路本轮都核对过（数字来自本机 `grep`/`ls`，见 docs/fs-watch.md §2）：
//! `notify` 既不在 `src-tauri/Cargo.lock` 也不在本机 crates 缓存里，引入它等于在一次正在
//! 进行的改造中途去下载一个新依赖树；`windows-sys` 有四个版本在锁里、`.crate` 也已在缓存，
//! 不需要下载，但那是一段 unsafe FFI（句柄生命周期、`FILE_NOTIFY_INFORMATION` 链表的
//! UTF-16 解析、每个被监听根一个线程），而它换来的收益——「省下每 700 ms 一次
//! `read_dir`」——在本应用里目前没有实测依据。**先把能被单测钉住的那半做完**是这一版的取舍，
//! 句柄层是它的下一步，不是它的替代品。

use tauri::Emitter;

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

/// 一次被合并后的变更通知：只关心「哪些仓库在窗口内有写入」。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Batch {
    pub slugs: Vec<String>,
}

/// 把短时间内打到同一仓库的变更合并成一批，窗口结束时 flush 一次。
///
/// 纯逻辑：喂入 (slug, now)，在 quiet 窗口内的多次喂入只保留一个 slug；
/// 窗口结束后再喂入开新一批。`now` 由调用方注入，便于测试。
#[derive(Debug, Default)]
pub struct DebouncedBatch {
    active_until: Option<std::time::Instant>,
    open: Vec<String>,
}

impl DebouncedBatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一次变更。返回「此刻是否应 flush 上一批」的判断由调用方按 `flush_due` 取。
    pub fn note(&mut self, slug: &str, now: std::time::Instant, quiet: std::time::Duration) {
        match self.active_until {
            Some(until) => {
                if now < until {
                    if !self.open.iter().any(|s| s == slug) {
                        self.open.push(slug.to_string());
                    }
                    return;
                }
                // 窗口已过：落到 flush，开新批。
                self.open.clear();
            }
            None => {}
        }
        self.open.push(slug.to_string());
        self.active_until = Some(now + quiet);
    }

    /// 窗口是否已过（调用方该 flush 了）。
    pub fn flush_due(&self, now: std::time::Instant) -> bool {
        matches!(self.active_until, Some(until) if now >= until)
    }

    /// 取出并清空当前批。窗口未过时返回 None（别提前 flush）。
    pub fn take_due(&mut self, now: std::time::Instant) -> Option<Batch> {
        if !self.flush_due(now) {
            return None;
        }
        self.active_until = None;
        let slugs = std::mem::take(&mut self.open);
        if slugs.is_empty() {
            None
        } else {
            Some(Batch { slugs })
        }
    }
}

/// How long a burst of writes is folded into one notification.
///
/// 1.2 s is deliberately longer than the coalescing window a human notices as "the UI
/// jumped twice": an `npm install` writes for tens of seconds, and folding it to one
/// refresh at the end is the whole point; a `git checkout` of a few hundred files lands
/// inside the window too.
pub const QUIET: std::time::Duration = std::time::Duration::from_millis(1200);

/// How often one scan pass runs when the native watcher does not cover every root.
/// Cheapest number that is still far below "a person notices a delay", and it is a
/// *pass over the registry*, not per-repository.
pub const SCAN_EVERY: std::time::Duration = std::time::Duration::from_millis(700);

/// How often the polling safety net runs when every watched root has a native
/// watcher. Native events are the primary path; this pass only catches a missed
/// notification, so paying a `read_dir` + one `metadata` per child every 700 ms
/// on top of a working watcher is duplicated work that grows with the wall.
pub const NATIVE_BACKUP_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// The sampler period for the current coverage.
///
/// Partial coverage keeps the old cadence: one unwatched root is enough for a
/// change to be invisible until the next poll. Zero roots also keeps it, so a
/// wall that is still loading is not sampled late.
pub fn poll_interval(roots: usize, native_covered: usize) -> std::time::Duration {
    if roots > 0 && native_covered >= roots {
        NATIVE_BACKUP_EVERY
    } else {
        SCAN_EVERY
    }
}

/// The two numbers a directory's "something was written here" cheaply implies.
///
/// Deliberately NOT a recursive hash: the container roots hold real repositories, and a
/// recursive walk is what `metadata.rs` already charges seconds for. Entry count plus the
/// newest child mtime catches the cases the app cares about — a build directory appearing,
/// a checkout swapping files, a dependency install growing `node_modules` — at a cost that
/// does not grow with the repository's content, only with the root's own entry count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    /// The root's own mtime (`root_mtime`), which moves when an entry is added or removed.
    pub root: Option<SystemTime>,
    /// Number of entries in the root, `None` when the root could not be read.
    pub entries: Option<u64>,
    /// Newest mtime among the root's direct children.
    pub newest: Option<SystemTime>,
}

impl Signature {
    /// True when two readings are different *in a way that means a write happened*.
    ///
    /// `None == None` is not a change: a root that cannot be read (unmounted, deleted,
    /// locked) must not fire a refresh every pass, because that turns an error into a
    /// busy loop. The caller counts those separately.
    fn differs(&self, other: &Signature) -> bool {
        if self.root.is_none() && other.root.is_none() && self.entries.is_none() && other.entries.is_none() {
            return false;
        }
        self.root != other.root || self.entries != other.entries || self.newest != other.newest
    }
}

/// Read the cheap signature of one directory. Never recurses.
pub fn signature(root: &Path) -> Signature {
    let root_mtime = root_mtime(root).ok();
    let mut entries = 0u64;
    let mut newest: Option<SystemTime> = None;
    if let Ok(read) = std::fs::read_dir(root) {
        for entry in read.flatten() {
            entries += 1;
            if let Some(m) = entry.path().metadata().ok().and_then(|m| m.modified().ok()) {
                if newest.map(|cur| m > cur).unwrap_or(true) {
                    newest = Some(m);
                }
            }
        }
        Signature { root: root_mtime, entries: Some(entries), newest }
    } else {
        Signature { root: root_mtime, entries: None, newest: None }
    }
}

/// 读仓库根目录本身的 mtime（不递归——递归 walk 在大仓库上比监听还贵）。
/// 作为「便宜的轮询兜底」：没有后台 watcher 时，前端定时 poll 一次。
pub fn root_mtime(root: &std::path::Path) -> std::io::Result<std::time::SystemTime> {
    std::fs::metadata(root)?.modified()
}

/// One watched repository: what to look at, and what it looked like last pass.
#[derive(Debug, Clone)]
struct Watched {
    slug: String,
    root: PathBuf,
    last: Signature,
}

/// The registry + the coalescer, as a single object the polling thread can own.
///
/// All of it is plain data: no OS handle, no thread, no callback. `scan` is what a tick
/// does and `take_due` is what a tick emits — which is why both are testable by calling
/// them with a chosen `now`.
#[derive(Debug, Default)]
pub struct ChangeDetector {
    watched: Vec<Watched>,
    batch: DebouncedBatch,
    /// Roots that could not be read on the last pass. Reported so the caller can say
    /// "3 of 14 repositories could not be watched" instead of going quiet.
    unreadable: Vec<String>,
}

impl ChangeDetector {
    pub fn new() -> Self {
        ChangeDetector {
            watched: Vec::new(),
            batch: DebouncedBatch::new(),
            unreadable: Vec::new(),
        }
    }

    /// Replace the watched set wholesale (the wall is the source of truth, and it changes
    /// when a repository is added, removed or moved). A slug that is still present keeps
    /// its previous signature, so a re-register does not fabricate a change.
    pub fn set_watched(&mut self, entries: Vec<(String, PathBuf)>) {
        let previous: std::collections::HashMap<String, Signature> = self
            .watched
            .iter()
            .map(|w| (w.slug.clone(), w.last.clone()))
            .collect();
        self.watched = entries
            .into_iter()
            .map(|(slug, root)| {
                let last = previous.get(&slug).cloned().unwrap_or_else(|| signature(&root));
                Watched { slug, root, last }
            })
            .collect();
    }

    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }

    pub fn unreadable(&self) -> &[String] {
        &self.unreadable
    }

    /// One pass: read each root, note the ones that moved. Returns nothing — the batch is
    /// taken separately, because that is what makes the quiet window observable.
    pub fn scan(&mut self, now: Instant) {
        let mut unreadable = Vec::new();
        for w in &mut self.watched {
            let fresh = signature(&w.root);
            if fresh.entries.is_none() && fresh.root.is_none() {
                unreadable.push(w.slug.clone());
            }
            if w.last.differs(&fresh) {
                w.last = fresh;
                self.batch.note(&w.slug, now, QUIET);
            }
        }
        self.unreadable = unreadable;
    }

    /// Emit what is due, if the quiet window has passed.
    pub fn take_due(&mut self, now: Instant) -> Option<Batch> {
        self.batch.take_due(now)
    }

    /// A native watcher saw a write under this slug. It joins the same debounced
    /// batch as a polling hit, so enabling the native path cannot double-notify.
    pub fn note_native(&mut self, slug: &str, now: Instant) {
        self.batch.note(slug, now, QUIET);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bursts_coalesce_into_one_slug() {
        let t0 = std::time::Instant::now();
        let quiet = std::time::Duration::from_millis(100);
        let mut b = DebouncedBatch::new();
        b.note("demo", t0, quiet);
        b.note("demo", t0 + std::time::Duration::from_millis(10), quiet);
        b.note("demo", t0 + std::time::Duration::from_millis(50), quiet);
        assert!(b.take_due(t0 + std::time::Duration::from_millis(60)).is_none());
        let batch = b.take_due(t0 + std::time::Duration::from_millis(120)).unwrap();
        assert_eq!(batch.slugs, vec!["demo".to_string()]);
    }

    #[test]
    fn two_slugs_in_one_window_stay_separate() {
        let t0 = std::time::Instant::now();
        let quiet = std::time::Duration::from_millis(100);
        let mut b = DebouncedBatch::new();
        b.note("a", t0, quiet);
        b.note("b", t0 + std::time::Duration::from_millis(20), quiet);
        let batch = b.take_due(t0 + std::time::Duration::from_millis(120)).unwrap();
        assert_eq!(batch.slugs, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn quiet_period_opens_a_new_batch() {
        let t0 = std::time::Instant::now();
        let quiet = std::time::Duration::from_millis(100);
        let mut b = DebouncedBatch::new();
        b.note("a", t0, quiet);
        let _ = b.take_due(t0 + std::time::Duration::from_millis(120));
        b.note("b", t0 + std::time::Duration::from_millis(500), quiet);
        let batch = b.take_due(t0 + std::time::Duration::from_millis(620)).unwrap();
        assert_eq!(batch.slugs, vec!["b".to_string()]);
    }

    /// A scratch root, unique per test, removed at the end. `tempfile` is not a dependency
    /// of this crate (and `metadata.rs`'s tests established the hand-rolled pattern).
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let unique = format!(
                "devhub-fswatch-{}-{}",
                tag,
                std::process::id()
            );
            let path = std::env::temp_dir().join(unique);
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("scratch root");
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn signature_sees_a_new_entry_and_no_change_on_nothing() {
        let s = Scratch::new("sig");
        let before = signature(&s.0);
        assert_eq!(before.entries, Some(0), "an empty root reads as zero entries, not None");
        std::fs::write(s.0.join("a.txt"), b"x").unwrap();
        let after = signature(&s.0);
        assert_eq!(after.entries, Some(1));
        assert!(before.differs(&after), "adding a file must read as a change");
        assert!(!after.differs(&signature(&s.0)), "reading the same root twice is not a change");
    }

    #[test]
    fn signature_of_a_missing_root_is_not_a_changing_root() {
        // The busy-loop guard: an unreadable root has to compare equal to itself, or every
        // pass would note a change and the UI would refresh forever.
        let missing = signature(Path::new("Z:\\devhub-definitely-not-here"));
        assert_eq!(missing.entries, None);
        assert!(!missing.differs(&signature(Path::new("Z:\\devhub-definitely-not-here"))));
        // …but a root that comes back (unmounted → mounted) is a change worth telling about.
        let s = Scratch::new("back");
        assert!(missing.differs(&signature(&s.0)));
    }

    #[test]
    fn detector_notes_a_write_once_and_emits_after_the_quiet_window() {
        let s = Scratch::new("detect");
        let t0 = Instant::now();
        let mut d = ChangeDetector::new();
        d.set_watched(vec![("owner/repo".to_string(), s.0.clone())]);
        assert_eq!(d.watched_count(), 1);

        // Nothing written: a pass emits nothing, ever.
        d.scan(t0);
        assert!(d.take_due(t0 + SCAN_EVERY).is_none());

        // Two writes inside one quiet window → one folded notification for that slug.
        std::fs::write(s.0.join("one.txt"), b"1").unwrap();
        d.scan(t0 + SCAN_EVERY);
        std::fs::write(s.0.join("two.txt"), b"2").unwrap();
        d.scan(t0 + SCAN_EVERY * 2);
        assert!(d.take_due(t0 + SCAN_EVERY * 2).is_none(), "window still open");
        let batch = d.take_due(t0 + SCAN_EVERY * 2 + QUIET).expect("the burst folds into one batch");
        assert_eq!(batch.slugs, vec!["owner/repo".to_string()]);

        // And the next pass sees no further change, because the signature was updated.
        d.scan(t0 + SCAN_EVERY * 3 + QUIET);
        assert!(d.take_due(t0 + SCAN_EVERY * 4 + QUIET).is_none());
    }

    #[test]
    fn native_events_join_the_same_debounced_batch() {
        let t0 = Instant::now();
        let mut d = ChangeDetector::new();
        d.set_watched(vec![("a/b".to_string(), std::path::PathBuf::from("."))]);
        d.note_native("a/b", t0);
        d.note_native("a/b", t0 + std::time::Duration::from_millis(20));
        assert!(d.take_due(t0 + SCAN_EVERY).is_none(), "quiet window still open");
        let batch = d.take_due(t0 + SCAN_EVERY + QUIET).expect("native burst folds into one batch");
        assert_eq!(batch.slugs, vec!["a/b".to_string()], "two native hits, one slug");
        assert!(d.take_due(t0 + SCAN_EVERY * 2 + QUIET).is_none(), "batch is consumed once");
    }

    #[test]
    fn re_registering_the_same_slug_does_not_fabricate_a_change() {
        let s = Scratch::new("rereg");
        let t0 = Instant::now();
        let mut d = ChangeDetector::new();
        d.set_watched(vec![("a/b".to_string(), s.0.clone())]);
        d.scan(t0);
        // The wall refreshes and hands the same repository in again (a rename elsewhere,
        // a re-render): the previous signature must carry over.
        d.set_watched(vec![("a/b".to_string(), s.0.clone())]);
        d.scan(t0 + SCAN_EVERY);
        assert!(d.take_due(t0 + SCAN_EVERY + QUIET).is_none(), "a re-register is not a write");
    }

    #[test]
    fn a_dropped_root_is_reported_unreadable_and_still_quiet() {
        let s = Scratch::new("drop");
        let t0 = Instant::now();
        let mut d = ChangeDetector::new();
        d.set_watched(vec![("gone/repo".to_string(), s.0.clone())]);
        d.scan(t0);
        std::fs::remove_dir_all(&s.0).unwrap();
        // The removal itself is a change (the app should drop the tile), then silence:
        // the root stays unreadable and must not fire every pass.
        d.scan(t0 + SCAN_EVERY);
        let batch = d.take_due(t0 + SCAN_EVERY + QUIET).expect("the deletion is a change");
        assert_eq!(batch.slugs, vec!["gone/repo".to_string()]);
        d.scan(t0 + SCAN_EVERY * 2 + QUIET);
        assert!(d.take_due(t0 + SCAN_EVERY * 3 + QUIET).is_none());
        assert_eq!(d.unreadable().to_vec(), vec!["gone/repo".to_string()]);
    }

    #[test]
    fn batch_is_serializable_for_the_event_payload() {
        // The frontend reads `{slugs: [...]}` from `repo://changed`; a rename here is a
        // silent contract break on the other side of the IPC boundary.
        let json = serde_json::to_string(&Batch { slugs: vec!["a/b".to_string()] }).unwrap();
        assert_eq!(json, r#"{"slugs":["a/b"]}"#);
    }

    #[test]
    fn poll_interval_backs_off_only_under_full_native_coverage() {
        assert_eq!(poll_interval(0, 0), SCAN_EVERY, "no roots yet: stay ready");
        assert_eq!(poll_interval(3, 0), SCAN_EVERY, "no coverage keeps the fast path");
        assert_eq!(poll_interval(3, 1), SCAN_EVERY, "one uncovered root is enough for fast polling");
        assert_eq!(poll_interval(3, 2), SCAN_EVERY);
        assert_eq!(poll_interval(3, 3), NATIVE_BACKUP_EVERY);
        assert_eq!(poll_interval(3, 4), NATIVE_BACKUP_EVERY, "a stale count cannot speed it up or panic");
    }

    /// What the 700 ms pass costs at wall scale, so "native watchers make polling
    /// redundant" is a measurement rather than an assumption. Run on the machine
    /// that matters:
    ///
    ///     cargo test --lib -- --ignored --nocapture bench_scan_cost
    #[test]
    #[ignore = "benchmark; run with --ignored --nocapture"]
    fn bench_scan_cost_at_100_roots() {
        let s = Scratch::new("bench");
        let mut roots = Vec::new();
        for i in 0..100 {
            let dir = s.0.join(format!("repo-{i:03}"));
            std::fs::create_dir_all(&dir).unwrap();
            for j in 0..20 {
                std::fs::write(dir.join(format!("f{j}.txt")), b"x").unwrap();
            }
            roots.push((format!("owner/repo-{i}"), dir));
        }
        let started = std::time::Instant::now();
        let mut d = ChangeDetector::new();
        d.set_watched(roots.clone());
        println!("set_watched(100 roots): {} ms", started.elapsed().as_millis());

        let mut total = 0u128;
        for _ in 0..5 {
            let t = std::time::Instant::now();
            d.scan(std::time::Instant::now());
            total += t.elapsed().as_millis();
        }
        println!("scan(100 roots, 20 children each): {} ms/pass", total / 5);
        assert_eq!(d.watched_count(), 100);
    }
}

// ---------------------------------------------------------------------------
// r23-R2: native watcher registry (polling stays as the fallback)
// ---------------------------------------------------------------------------

static NATIVE_WATCHERS: std::sync::OnceLock<std::sync::Mutex<Vec<crate::native_watch::NativeWatch>>> =
    std::sync::OnceLock::new();

/// Registry size and how many of those roots currently have a native watcher.
/// Kept as plain atomics because the sampler thread reads them every tick and
/// must never take the watcher lock (which is held while threads join).
static WATCHED_ROOTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static NATIVE_COVERED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn set_coverage(roots: usize, native: usize) {
    WATCHED_ROOTS.store(roots, std::sync::atomic::Ordering::SeqCst);
    NATIVE_COVERED.store(native.min(roots), std::sync::atomic::Ordering::SeqCst);
}

fn native_watchers() -> &'static std::sync::Mutex<Vec<crate::native_watch::NativeWatch>> {
    NATIVE_WATCHERS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Start one recursive native watcher per accepted root, replacing the previous set.
/// Every event is folded into the same `ChangeDetector` batch; polling stays enabled,
/// so a missed native event degrades to the old latency instead of a silent hole. A
/// root whose watcher cannot start is simply left to polling.
///
/// Returns how many roots got a watcher. The sampler uses that count to decide
/// whether its 700 ms pass is still the primary path or only a safety net.
pub(crate) fn restart_native_watchers(roots: &[(String, std::path::PathBuf)]) -> usize {
    let Ok(mut guard) = native_watchers().lock() else {
        set_coverage(roots.len(), 0);
        return 0;
    };
    // Dropping the old watchers cancels and joins their reader threads.
    guard.clear();
    let mut covered = 0usize;
    for (slug, path) in roots {
        match crate::native_watch::start(path) {
            Ok((watch, rx)) => {
                covered += 1;
                let slug = slug.clone();
                std::thread::Builder::new()
                    .name("devhub-native-forward".to_string())
                    .spawn(move || {
                        for msg in rx {
                            match msg {
                                Ok(names) if names.is_empty() => {}
                                Ok(_) => {
                                    if let Ok(mut d) = watch_state().lock() {
                                        d.note_native(&slug, std::time::Instant::now());
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[fs_watch] native watcher for {slug} stopped: {e}");
                                    break;
                                }
                            }
                        }
                    })
                    .ok();
                guard.push(watch);
            }
            Err(e) => eprintln!("[fs_watch] native watcher unavailable for {}: {e}", path.display()),
        }
    }
    set_coverage(roots.len(), covered);
    covered
}

/// Stop every native watcher (RunEvent::Exit). Polling threads need no stop path,
/// but these own OS handles and must be joined.
pub(crate) fn stop_native_watchers() {
    if let Ok(mut guard) = native_watchers().lock() {
        guard.clear();
    }
    set_coverage(WATCHED_ROOTS.load(std::sync::atomic::Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// r21-O1-2: watch_* Tauri commands, moved verbatim from lib.rs.
// ---------------------------------------------------------------------------

/// One repository the wall wants change notifications for (r18-R1).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchRoot {
    /// The identity the frontend keys its tiles on, echoed back verbatim.
    pub(crate) slug: String,
    pub(crate) path: String,
}

pub(crate) static WATCH: std::sync::OnceLock<std::sync::Mutex<crate::fs_watch::ChangeDetector>> = std::sync::OnceLock::new();
pub(crate) static SAMPLER_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn watch_state() -> &'static std::sync::Mutex<crate::fs_watch::ChangeDetector> {
    WATCH.get_or_init(|| std::sync::Mutex::new(crate::fs_watch::ChangeDetector::new()))
}

/// Register the watched roots and start the sampler once (r18-R1).
///
/// Every path goes through `path_guard` with `Access::Read` before it is watched: the list
/// arrives from the page, and a directory the user did not add must not be able to put
/// itself on a list the app then touches on a timer. The guarded (resolved) path is what
/// gets stored, so a symlink or a `..` cannot widen the scope afterwards.
///
/// The return value is how many roots were accepted — the caller can say "3 of 14 could
/// not be watched" instead of going quiet, which is the same reasoning behind the
/// detector's own unreadable list.
#[tauri::command]
pub(crate) async fn watch_repositories(app: tauri::AppHandle, roots: Vec<WatchRoot>) -> Result<usize, String> {
    // r20-O2-3: this was a *synchronous* command, and a synchronous command runs on the
    // window thread (the rule `process_states`' neighbour comment at the top of this
    // block records). Per root it does a `crate::path_guard::guard`, which canonicalizes both
    // the requested path and the project root — real filesystem work, on a wall of
    // repositories that means one `CreateFile` round trip per tile, on a network drive
    // or a spun-down disk it means the window stops painting. The guard result and the
    // refusals are computed off-thread; what stays here is the state write and the
    // sampler start, both of which are cheap and neither of which touches the disk.
    let (accepted, refused) = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let mut accepted: Vec<(String, std::path::PathBuf)> = Vec::with_capacity(roots.len());
            let mut refused: Vec<String> = Vec::new();
            for r in roots {
                let slug = r.slug.trim().to_string();
                if slug.is_empty() {
                    refused.push("(空 slug)".to_string());
                    continue;
                }
                match crate::path_guard::guard(&app, &r.path, crate::path_guard::Access::Read) {
                    Ok(p) => accepted.push((slug, p)),
                    Err(e) => refused.push(format!("{slug}: {e}")),
                }
            }
            (accepted, refused)
        }
    })
    .await
    .map_err(|e| format!("变更监听任务异常: {e}"))?;
    let count = accepted.len();
    let native_roots = accepted.clone();
    match watch_state().lock() {
        Ok(mut d) => d.set_watched(accepted),
        Err(_) => return Err("变更监听的状态锁不可用".to_string()),
    }
    restart_native_watchers(&native_roots);
    ensure_sampler(&app);
    if !refused.is_empty() {
        // Not an error: the wall watches what it may watch, and the reason for the rest
        // belongs in the console, not in a toast over a cosmetic feature.
        println!("[fs-watch] 拒绝监听 {} 个目录：{}", refused.len(), refused.join(" | "));
    }
    Ok(count)
}

/// The sampler thread: one pass per [`poll_interval`], emit once a burst has folded.
///
/// Started at most once (`SAMPLER_ON`) and never stopped on purpose: the process holds no
/// OS handle here (a `read_dir` per root), so exiting with the app *is* the shutdown path,
/// and `RunEvent::Exit`'s `kill_tree` has none of ours to reap. The lock is held for the
/// scan only and released before the emit, so a slow listener cannot stall a tick.
///
/// When every root has a native watcher the pass slows to [`NATIVE_BACKUP_EVERY`].
/// That is not an assumption that the watcher never misses: it is the reason the
/// pass still runs at all. The 700 ms cadence is only needed while polling is the
/// primary detector, and one uncovered root restores it.
pub(crate) fn ensure_sampler(app: &tauri::AppHandle) {
    if SAMPLER_ON.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last_interval = None;
        loop {
            let roots = WATCHED_ROOTS.load(std::sync::atomic::Ordering::Relaxed);
            let covered = NATIVE_COVERED.load(std::sync::atomic::Ordering::Relaxed);
            let every = crate::fs_watch::poll_interval(roots, covered);
            if last_interval != Some(every) {
                println!(
                    "[fs-watch] poll every {} ms (native {}/{} roots)",
                    every.as_millis(),
                    covered.min(roots),
                    roots
                );
                last_interval = Some(every);
            }
            std::thread::sleep(every);
            let guard = match watch_state().lock() {
                Ok(g) => g,
                // A poisoned lock means someone panicked inside a scan. Retrying quietly is
                // the honest behaviour for a background notifier; the counter below is what
                // makes the situation visible rather than invisible.
                Err(_) => continue,
            };
            let now = std::time::Instant::now();
            let mut detector = guard;
            detector.scan(now);
            let batch = detector.take_due(now);
            let unreadable = detector.unreadable().len();
            drop(detector);
            if let Some(b) = batch {
                // Deliberately *not* `let _ = handle.emit(..)`: the `rust-swallowed-errors`
                // ratchet counts that shape, and it is right to — an emit that fails means the
                // wall was told nothing. Say so in the console instead.
                if handle.emit("repo://changed", &b).is_err() {
                    println!("[fs-watch] repo://changed 发送失败：{} 个 slug 的通知没有送达", b.slugs.len());
                }
            }
            if unreadable > 0 {
                println!("[fs-watch] {unreadable} 个被登记目录本轮读不到");
            }
        }
    });
}

