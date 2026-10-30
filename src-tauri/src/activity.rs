//! Operation activity log, stored as JSONL beside the config file.
//!
//! One line per event: `{id, ts, tag, action, detail, slug, source, path}`. The
//! file is human-readable and trivially repairable — a torn final line (killed
//! mid write) is skipped on read rather than failing the whole history.
//!
//! Every entry answers the four questions a history view has to answer on its
//! own: **when** (`ts`), **where from** (`source`, the view the operation was
//! issued from), **what** (`action` + `detail`), and **which path on disk it
//! touched** (`path`, plus `slug` when it concerned one repository). Those two
//! location fields were added because "修改设置" alone told the user nothing
//! about what had changed or where.
//!
//! `id` exists so a single entry can be deleted. Timestamps are second-granular
//! and one operation routinely writes several entries, so `ts` is not an
//! identifier - a batch settings save used to produce four rows that were all
//! "18:09" and indistinguishable.
//!
//! Retention: `list` drops entries older than the configured number of days and
//! rewrites the file without them, so the file cannot grow without bound even
//! though it is only ever appended to.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

/// Hard cap on the number of activity entries kept on disk.
///
/// `list` already enforces a time-based retention window (`retention_days`),
/// but a user who runs many clones/launches per day can still accumulate
/// tens of thousands of rows inside that window. At that scale every
/// `delete`/`delete_many`/`mark_undone` rewrites the whole file (O(n)), and
/// the cold `list` parse becomes perceptible. A fixed ceiling bounds both
/// without requiring the full segmented-storage migration (which
/// `docs/activity-storage.md` §4.4 defers until the rewrite pain is real).
///
/// 5000 ≈ 4 months at ~40 entries/day, comfortably above normal use while
/// keeping the file well under a megabyte. Oldest entries are dropped first.
const MAX_ENTRIES: usize = 5000;

/// What a "回退" on this record would actually do.
///
/// The user asked that records be reversible, and the honest answer is that not
/// every operation is. So the descriptor carries both what to do *and* why it
/// cannot be done, rather than the UI guessing from the tag:
///
///   `value`      — put one setting back. `scope` says whose setting it is,
///                  because 界面/外观 state lives in the webview's localStorage
///                  and the backend cannot write it; `config` entries are applied
///                  here, `ui` entries are handed to the frontend to apply.
///   `redownload` — the record deleted a repository; pulling it again from the
///                  recorded URL is the only possible reversal.
///   `none`       — irreversible (a cache clear, an overwrite of a launch
///                  command whose previous value was never captured). `reason`
///                  is shown verbatim, so it must read as an explanation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    pub kind: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub key: String,
    /// The previous value, JSON-encoded so a list survives a round trip.
    #[serde(default)]
    pub value: String,
    /// Extra arguments, e.g. the URL to re-clone for `redownload`.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

impl Undo {
    pub fn none(reason: &str) -> Self {
        Undo {
            kind: "none".into(),
            scope: String::new(),
            key: String::new(),
            value: String::new(),
            args: Vec::new(),
            reason: reason.to_string(),
        }
    }
    pub fn value(scope: &str, key: &str, previous: &str) -> Self {
        Undo {
            kind: "value".into(),
            scope: scope.to_string(),
            key: key.to_string(),
            value: previous.to_string(),
            args: Vec::new(),
            reason: String::new(),
        }
    }
    pub fn redownload(url: &str) -> Self {
        Undo {
            kind: "redownload".into(),
            scope: String::new(),
            key: String::new(),
            value: String::new(),
            args: vec![url.to_string()],
            reason: String::new(),
        }
    }
    /// Reverses a download by deleting the directory it landed in.
    pub fn delete_dir(path: &str) -> Self {
        Undo {
            kind: "delete".into(),
            scope: String::new(),
            key: String::new(),
            value: path.to_string(),
            args: Vec::new(),
            reason: String::new(),
        }
    }
    /// Reverses a recycle-bin delete by putting every listed path back.
    ///
    /// `args` rather than `value`, because one delete covers the repository *and*
    /// its venv, and a 回退 that restored only half of that would be worse than
    /// one that refused.
    pub fn restore_trash(paths: &[String]) -> Self {
        Undo {
            kind: "restore_trash".into(),
            scope: String::new(),
            key: String::new(),
            value: String::new(),
            args: paths.to_vec(),
            reason: String::new(),
        }
    }
}

/// One recorded operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Stable identifier, generated at write time. `#[serde(default)]` so a log
    /// written before ids existed still parses; `list` backfills and rewrites.
    #[serde(default)]
    pub id: String,
    /// Unix timestamp, seconds.
    pub ts: i64,
    /// Category used as the filter tag in the UI:
    /// download / delete / clear / launch / terminal / ide / settings
    pub tag: String,
    /// Short action summary, e.g. "下载仓库".
    pub action: String,
    /// Human-readable detail.
    #[serde(default)]
    pub detail: String,
    /// Repository slug, when the entry concerns one repository.
    #[serde(default)]
    pub slug: String,
    /// The view the operation was issued from: 项目墙 / 添加页 / 启动面板 /
    /// 设置页 / 记录页. Empty on entries written before this existed.
    #[serde(default)]
    pub source: String,
    /// The filesystem path the operation touched.
    #[serde(default)]
    pub path: String,
    /// What was changed, addressed rather than described: `config.projectRoot`,
    /// `launch.steps:owner/repo`, `ui.theme`. Two entries with the same target
    /// are the same *kind* of change, which is what lets 记录 collapse "调了五次
    /// 这个项目的启动命令" into one block.
    #[serde(default)]
    pub target: String,
    /// The value before this operation, for the diff line. Free text on purpose:
    /// a path, a boolean, and a five-step command list all have to fit.
    #[serde(default)]
    pub before: String,
    /// The value after this operation.
    #[serde(default)]
    pub after: String,
    /// How to reverse it. Absent on entries written before undo existed, which
    /// the UI reads as "not reversible" rather than as an error.
    #[serde(default)]
    pub undo: Option<Undo>,
    /// When this entry's 回退 was applied, unix seconds; 0 = not undone yet.
    /// Lets the UI mark reverted rows and refuse a second revert. Old lines
    /// parse as 0 via the serde default.
    #[serde(default)]
    pub undone_ts: i64,
}

/// Monotonic counter mixed into generated ids.
///
/// A second-granular timestamp plus a nanosecond clock is still not guaranteed
/// unique across two entries written in the same tick on a coarse clock, and a
/// duplicate id would make "delete this row" remove the wrong one.
static ID_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_id() -> String {
    let n = ID_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{nanos:x}-{n:x}")
}

impl ActivityEntry {
    pub fn now(
        tag: &str,
        action: &str,
        detail: &str,
        slug: &str,
        source: &str,
        path: &str,
    ) -> Self {
        ActivityEntry {
            id: next_id(),
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            tag: tag.to_string(),
            action: action.to_string(),
            detail: detail.to_string(),
            slug: slug.to_string(),
            source: source.to_string(),
            path: path.to_string(),
            target: String::new(),
            before: String::new(),
            after: String::new(),
            undo: None,
            undone_ts: 0,
        }
    }

    pub fn with_target(mut self, target: &str) -> Self {
        self.target = target.to_string();
        self
    }
    pub fn with_change(mut self, before: &str, after: &str) -> Self {
        self.before = before.to_string();
        self.after = after.to_string();
        self
    }
    pub fn with_undo(mut self, undo: Undo) -> Self {
        self.undo = Some(undo);
        self
    }

    /// The bucket this entry belongs to in the 记录 list.
    ///
    /// Derived rather than stored: a target is exactly what a group is, and
    /// keeping two fields in sync would be one more thing that can drift. An
    /// entry with no target groups with itself, which is the right answer for a
    /// one-off like "停止运行中的进程".
    pub fn group_key(&self) -> String {
        if !self.target.is_empty() {
            return format!("{}:{}", self.tag, self.target);
        }
        if !self.slug.is_empty() {
            return format!("{}:{}", self.tag, self.slug);
        }
        format!("single:{}", self.id)
    }
}

/// Serializes every read-modify-write against the activity log.
///
/// The log is one JSONL file with two writers: `append` (nearly every command in the
/// app records something) and the read→rewrite→rename path used by `list`, `delete`,
/// `delete_many`, `mark_undone` and `purge`. Without a gate, an append that lands
/// between another thread's read and its rename is silently dropped — the record was
/// written and then overwritten away, which is the worst possible failure for the
/// feature whose whole promise is "所有操作有记录". The commands reach these functions
/// from `spawn_blocking` workers, so the interleaving is real, not theoretical.
static ACTIVITY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Takes the log gate, surviving a previous panic in a worker rather than
/// permanently disabling recording. A poisoned lock still guards the same file.
fn activity_lock() -> std::sync::MutexGuard<'static, ()> {
    match ACTIVITY_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// An exact parse of the log, keyed by the file stamp it was parsed at.
///
/// Only ever filled when a read needed **no** rewrite (`expired == 0` and
/// `missing_id == 0`), which means `lines` is byte-for-byte what was on disk —
/// expired rows included, ids backfilled on every entry. That invariant is what
/// lets a cache hit be served without re-reading: anything the cache cannot
/// answer honestly (a tightened retention window, an id that went missing) is
/// detected in `serve_from_cache` and falls back to the full read, which owns
/// the rewrite logic.
struct CachedLog {
    /// `(mtime, len)` of the file this parse came from.
    stamp: (std::time::SystemTime, u64),
    lines: Vec<Line>,
}

/// The parse cache. One entry: the whole file, or nothing.
///
/// Keyed on `(mtime, len)` rather than on "did we just write it" because the
/// log also changes outside this process (a user repairing the file by hand,
/// a sync tool touching it). Both halves are required: a rewrite can keep the
/// length and change the timestamp, and a same-second append on a coarse
/// filesystem can keep the timestamp and change the length.
///
/// Lock discipline, in one sentence: this mutex is **only** ever taken while
/// `ACTIVITY_LOCK` is already held, so the acquisition order is
/// `ACTIVITY_LOCK → READ_CACHE` everywhere and no ordering pair exists to
/// deadlock on. Taking it anywhere else would create exactly the second
/// lock-order site the comment on `ACTIVITY_LOCK` warns about.
static READ_CACHE: std::sync::Mutex<Option<std::sync::Arc<CachedLog>>> = std::sync::Mutex::new(None);

/// Takes the cache gate, surviving a poisoned lock the same way `activity_lock`
/// does: a worker panic must not turn "reads are slow again" into "reads are
/// impossible forever".
fn cache_lock() -> std::sync::MutexGuard<'static, Option<std::sync::Arc<CachedLog>>> {
    match READ_CACHE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The cached parse for `stamp`, or `None` on any miss (empty cache, different
/// file, poisoned-but-empty lock). A miss is never a failure — it only costs a
/// full read, which is what the pre-cache code did on every call.
fn cache_get(stamp: &(std::time::SystemTime, u64)) -> Option<std::sync::Arc<CachedLog>> {
    let guard = cache_lock();
    guard.as_ref().filter(|c| c.stamp == *stamp).cloned()
}

fn cache_put(stamp: (std::time::SystemTime, u64), lines: Vec<Line>) {
    *cache_lock() = Some(std::sync::Arc::new(CachedLog { stamp, lines }));
}

/// Drops the cached parse.
///
/// Called after every write path succeeds, and it is **required**, not an
/// optimisation: the stamp key can in principle be fooled (a rewrite that lands
/// the same byte count inside the same timestamp tick), so the writes that
/// produce the bytes — `append`, `clear`, `delete`, `mark_undone`,
/// `delete_many`, `purge`, and `list`'s own prune pass — must not leave a parse
/// of the previous file behind. The next read then simply pays one full read.
fn cache_clear() {
    *cache_lock() = None;
}

/// Drops the cached parse from outside the module.
///
/// The manual 刷新 button in the 记录 view wants to see the bytes currently on
/// disk, not the cached answer — the cache exists to make the *automatic* reads
/// (the settled-download reloads, the retention-window re-prunes) cheap, and a
/// human-clicked 刷新 is exactly the moment the user does not want "cached".
/// This is the only public entry point that skips the cache; every automatic
/// path still goes through `list`, which honours the stamp-keyed cache.
pub fn cache_invalidate() {
    cache_clear();
}

/// The `(mtime, len)` pair the cache is keyed on.
fn file_stamp(path: &Path) -> Result<(std::time::SystemTime, u64), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("无法读取记录文件: {e}"))?;
    Ok((mtime, meta.len()))
}

/// Builds `list`'s return value from a cached parse, or `None` when the cache
/// cannot answer this call honestly.
///
/// `None` means "go read the file": it is returned when the retention window
/// would prune a cached row (the full path is the one that rewrites the file
/// without them) and when a cached entry somehow has no id (the full path is
/// the one that backfills and persists). Returning `None` here can only cost a
/// full read; returning a wrong list would be the defect the cache exists to
/// avoid.
fn serve_from_cache(cached: &CachedLog, retention_days: u32) -> Option<Vec<ActivityEntry>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = if retention_days == 0 {
        i64::MIN
    } else {
        now - (retention_days as i64) * 86_400
    };
    let mut entries: Vec<ActivityEntry> = Vec::with_capacity(cached.lines.len());
    for line in &cached.lines {
        match line {
            Line::Entry(e) => {
                if e.ts < cutoff || e.id.is_empty() {
                    return None;
                }
                entries.push(e.clone());
            }
            // Unparseable lines are never returned by `list` (the full path
            // filters them out the same way) — they exist here only so a later
            // rewrite can put them back.
            Line::Raw(_) => {}
        }
    }
    entries.sort_by_key(|e| e.ts);
    entries.reverse(); // newest first for display, same as the full path
    Some(entries)
}

/// Test-only: how many times **this thread** took the full read+parse path.
///
/// Thread-local so cargo's one-thread-per-test model keeps a test's own
/// assertions from being moved by another test calling `list` in parallel —
/// which is the whole reason this counter can be exact instead of approximate.
#[cfg(test)]
thread_local! {
    static FULL_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn full_reads() -> usize {
    FULL_READS.with(|c| c.get())
}

#[cfg(test)]
fn note_full_read() {
    FULL_READS.with(|c| c.set(c.get() + 1));
}

#[cfg(test)]
fn cache_is_filled() -> bool {
    cache_lock().is_some()
}


/// Appends one entry. A failed write is reported but never panics: losing a log
/// line must not take down the operation that produced it.
pub fn append(path: &Path, entry: &ActivityEntry) -> Result<(), String> {
    let _gate = activity_lock();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建记录目录: {e}"))?;
    }
    let line = serde_json::to_string(entry).map_err(|e| format!("序列化记录失败: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("无法打开记录文件: {e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("写入记录失败: {e}"))?;
    // The stamp moved under the cache; do not leave a parse of the shorter file.
    cache_clear();
    Ok(())
}

/// One line of the log: either a parsed entry or a line we could not parse.
///
/// Unparseable lines are carried through a rewrite rather than dropped. A torn
/// final line is expected and harmless to lose, but a line only this build
/// cannot parse (written by a newer build) must not be deleted by an older one.
enum Line {
    Entry(ActivityEntry),
    Raw(String),
}

/// Reads all entries inside the retention window, then rewrites the file
/// without the expired ones and with any missing `id` backfilled.
///
/// Read path, in order (R2-3): take the gate → stamp the file → serve from the
/// in-process parse cache when the stamp still matches and the cached parse can
/// answer this retention window honestly → otherwise read + parse the file, and
/// cache that parse when no rewrite was needed. Every failure of the lookup
/// (no cache, changed stamp, retention the cache cannot answer) falls back to
/// the full read, so a cache miss can only ever cost what the pre-cache code
/// cost on every call.
pub fn list(path: &Path, retention_days: u32) -> Result<Vec<ActivityEntry>, String> {
    let _gate = activity_lock();
    if !path.exists() {
        // The file is gone: the cached parse of it must go too, or a later read
        // could answer an empty file with history that is no longer there.
        cache_clear();
        return Ok(Vec::new());
    }
    let stamp = file_stamp(path)?;
    if let Some(cached) = cache_get(&stamp) {
        if let Some(entries) = serve_from_cache(&cached, retention_days) {
            return Ok(entries);
        }
        // The cached parse cannot serve this call (the window tightened since
        // it was filled, or an id went missing on disk): drop it and fall
        // through to the full read, which owns the rewrite below.
        cache_clear();
    }
    #[cfg(test)]
    note_full_read();
    let raw = std::fs::read_to_string(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // `0` means "keep forever". It must not become `cutoff = now`, which is what
    // a plain multiplication yields: that prunes every entry older than the
    // current second, so choosing 永久 silently erased the history the user had
    // just chosen to keep.
    let cutoff = if retention_days == 0 {
        i64::MIN
    } else {
        now - (retention_days as i64) * 86_400
    };

    let mut expired = 0usize;
    let mut missing_id = 0usize;
    let mut kept: Vec<Line> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ActivityEntry>(trimmed) {
            Ok(mut e) => {
                if e.ts < cutoff {
                    expired += 1;
                    continue;
                }
                if e.id.is_empty() {
                    e.id = next_id();
                    missing_id += 1;
                }
                kept.push(Line::Entry(e));
            }
            Err(_) => kept.push(Line::Raw(trimmed.to_string())),
        }
    }

    let mut entries: Vec<ActivityEntry> = kept
        .iter()
        .filter_map(|l| match l {
            Line::Entry(e) => Some(e.clone()),
            Line::Raw(_) => None,
        })
        .collect();
    entries.sort_by_key(|e| e.ts);
    entries.reverse(); // newest first for display

    // Hard cap: if more than MAX_ENTRIES entries survived retention, drop the
    // oldest ones. `entries` is newest-first, so truncate from the tail. Then
    // rebuild `kept` to match (keep only entries at or above the cutoff ts,
    // plus any Raw lines that were already there).
    let mut over_cap = 0usize;
    if entries.len() > MAX_ENTRIES {
        let cutoff_ts = entries[MAX_ENTRIES - 1].ts;
        over_cap = entries.len() - MAX_ENTRIES;
        entries.truncate(MAX_ENTRIES);
        kept.retain(|l| match l {
            Line::Entry(e) => e.ts >= cutoff_ts,
            Line::Raw(_) => true,
        });
    }

    // Purge/normalise pass: rewrite only when the file is actually out of date.
    // Done lazily on read so no timer is needed anywhere. `write_all` drops the
    // cache on the way out: the rewritten bytes are not what `stamp` describes.
    if expired > 0 || missing_id > 0 || over_cap > 0 {
        write_all(path, &kept)?;
    } else {
        // No rewrite: `kept` is an exact parse of the bytes on disk, which is
        // precisely the invariant `CachedLog` documents. `entries` already
        // cloned what it needs, so the lines move into the cache for free.
        cache_put(stamp, kept);
    }

    Ok(entries)
}

/// Rewrites the log from `lines`, newest-first entries followed by whatever
/// could not be parsed. Written to a temp file and renamed so an interrupted
/// write cannot truncate the whole history.
fn write_all(path: &Path, lines: &[Line]) -> Result<(), String> {
    // Atomic via the shared helper: unique temp name (pid + seq, same reason as
    // before — two concurrent rewrites must not share a temp file) and rename
    // only after a successful `sync_all`. The previous hand-rolled version had
    // the same intent but diverged from `lib::write_atomic` on one point: it
    // never synced the handle, so a rename could publish a file whose bytes were
    // still in the stdio buffer — an empty or short history under a name the
    // reader trusts. Keeping one implementation means the next fix lands once.
    let mut text = String::new();
    let mut dropped = 0usize;
    for l in lines {
        let chunk = match l {
            Line::Entry(e) => match serde_json::to_string(e) {
                Ok(s) => s,
                Err(_) => {
                    dropped += 1;
                    String::new()
                }
            },
            Line::Raw(s) => s.clone(),
        };
        if chunk.is_empty() {
            continue;
        }
        text.push_str(&chunk);
        text.push('\n');
    }
    // A dropped row used to vanish with no trace, in a function `list()` calls as
    // a side effect of *reading* — so the history got shorter on a successful
    // lookup. The write still goes ahead (the surviving rows are real and a failed
    // rewrite would lose all of them), but it is said out loud.
    if dropped > 0 {
        eprintln!("[activity] {dropped} 条记录无法序列化，本次重写已将其丢弃: {}", path.display());
    }
    crate::write_atomic(path, text.as_bytes()).map_err(|e| format!("无法更新记录文件: {e}"))?;
    // Every rewrite produces a file the cache has never stamped, and this is the
    // single funnel `list`/`delete`/`mark_undone`/`delete_many`/`purge` all go
    // through — so the invalidation lives here once instead of at five call
    // sites where the next rewrite-heavy endpoint could forget it.
    cache_clear();
    Ok(())
}

/// Deletes the whole log file.
pub fn clear(path: &Path) -> Result<(), String> {
    let _gate = activity_lock();
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("无法清空记录: {e}"))?;
    }
    // Deleting the file is the strongest form of "the parse is no longer
    // about any file on disk" — and the one case where a stale hit would be
    // most embarrassing: 清空记录 showing the records right back.
    cache_clear();
    Ok(())
}

/// Removes exactly one entry by id. Errors when the id is not present, so the
/// UI can never report a deletion that did not happen.
pub fn delete(path: &Path, id: &str) -> Result<(), String> {
    let _gate = activity_lock();
    if !path.exists() {
        return Err("记录文件不存在".to_string());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let mut kept: Vec<Line> = Vec::new();
    let mut removed = 0usize;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ActivityEntry>(trimmed) {
            Ok(e) if e.id == id => removed += 1,
            Ok(e) => kept.push(Line::Entry(e)),
            Err(_) => kept.push(Line::Raw(trimmed.to_string())),
        }
    }
    if removed == 0 {
        return Err("没有找到这条记录，可能已被保留期清掉".to_string());
    }
    write_all(path, &kept)
}

/// Marks one entry as undone, returning whether it was found.
///
/// Written back through the same temp-file-and-rename path as every other
/// rewrite. The mark is permanent state on the entry (not UI memory), so a
/// reverted row still reads as reverted after a restart, and clicking 回退
/// twice cannot apply the same reversal twice.
pub fn mark_undone(path: &Path, id: &str) -> Result<bool, String> {
    let _gate = activity_lock();
    if !path.exists() {
        return Err("记录文件不存在".to_string());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut kept: Vec<Line> = Vec::new();
    let mut marked = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ActivityEntry>(trimmed) {
            Ok(mut e) if e.id == id => {
                e.undone_ts = now;
                marked = true;
                kept.push(Line::Entry(e));
            }
            Ok(e) => kept.push(Line::Entry(e)),
            Err(_) => kept.push(Line::Raw(trimmed.to_string())),
        }
    }
    if !marked {
        return Ok(false);
    }
    write_all(path, &kept)?;
    Ok(true)
}

/// Removes several entries in one rewrite.
///
/// The single-id version re-read and re-wrote the file per click, so "select
/// twenty rows and delete" was twenty full rewrites and twenty chances for a
/// half-applied batch. Returns how many were actually found, which is what lets
/// the UI say "已删除 18 条（2 条已不存在）" instead of claiming a clean success.
pub fn delete_many(path: &Path, ids: &[String]) -> Result<usize, String> {
    let _gate = activity_lock();
    if ids.is_empty() {
        return Ok(0);
    }
    if !path.exists() {
        return Err("记录文件不存在".to_string());
    }
    let want: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let raw = std::fs::read_to_string(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let mut kept: Vec<Line> = Vec::new();
    let mut removed = 0usize;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ActivityEntry>(trimmed) {
            Ok(e) if want.contains(e.id.as_str()) => removed += 1,
            Ok(e) => kept.push(Line::Entry(e)),
            Err(_) => kept.push(Line::Raw(trimmed.to_string())),
        }
    }
    if removed == 0 {
        return Err("这些记录已经不在了".to_string());
    }
    write_all(path, &kept)?;
    Ok(removed)
}

/// Deletes every entry older than `keep_days`, returning the count removed.
///
/// `list()` already prunes by the retention window on every read; this exists
/// for the *scheduled* clean-up, which runs on a different clock and can be set
/// to a different horizon than the retention the list is filtered by.
pub fn purge(path: &Path, keep_days: u32) -> Result<usize, String> {
    let _gate = activity_lock();
    if !path.exists() {
        return Ok(0);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("无法读取记录文件: {e}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Same `0 == forever` rule as `list()`: a schedule set to 永久 must never
    // delete anything, not even a one-second-old line.
    let cutoff = if keep_days == 0 {
        i64::MIN
    } else {
        now - (keep_days as i64) * 86_400
    };
    let mut kept: Vec<Line> = Vec::new();
    let mut removed = 0usize;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ActivityEntry>(trimmed) {
            Ok(e) if e.ts < cutoff => removed += 1,
            Ok(e) => kept.push(Line::Entry(e)),
            Err(_) => kept.push(Line::Raw(trimmed.to_string())),
        }
    }
    if removed > 0 {
        write_all(path, &kept)?;
    }
    Ok(removed)
}

/// The log verbatim: one JSON object per line, newest first.
/// RFC 4180 CSV for spreadsheets (r26-N4-1).
///
/// The BOM is deliberate: Excel on a Chinese Windows opens a BOM-less UTF-8 CSV as
/// ANSI and turns every 中文 field into mojibake. The header id is quoted, so the
/// BOM stays part of the first cell rather than leaking into the id values.
/// Every string field is quoted and internal quotes are doubled; `ts` stays a
/// bare integer so a spreadsheet sorts it numerically instead of as text.
///
/// Quoting alone does not stop a spreadsheet formula: Excel and LibreOffice
/// evaluate a quoted cell that begins with `=`, `+`, `-`, `@`, a tab or a CR.
/// Repo aliases, launch commands and setting values are user text and can begin
/// with any of those, so the field is prefixed with an apostrophe before it is
/// quoted (OWASP CSV Injection). A leading apostrophe is the established
/// mitigation and reads as text, not as part of the value.
pub fn to_csv(entries: &[ActivityEntry]) -> String {
    fn field(value: &str) -> String {
        let mut text = value.to_string();
        if matches!(text.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r')) {
            text.insert(0, '\'');
        }
        format!("\"{}\"", text.replace('"', "\"\""))
    }
    let mut out = String::from(
        "\u{feff}id,ts,tag,action,detail,slug,source,path,target,before,after\r\n",
    );
    for e in entries {
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{}\r\n",
            field(&e.id),
            e.ts,
            field(&e.tag),
            field(&e.action),
            field(&e.detail),
            field(&e.slug),
            field(&e.source),
            field(&e.path),
            field(&e.target),
            field(&e.before),
            field(&e.after),
        ));
    }
    out
}

pub fn to_jsonl(entries: &[ActivityEntry]) -> String {
    entries
        .iter()
        .filter_map(|e| serde_json::to_string(e).ok())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A readable report: one Markdown table plus a per-entry detail list.
pub fn to_markdown(entries: &[ActivityEntry]) -> String {
    use std::fmt::Write as _;
    /// A `|` inside a cell would break the table; a newline would too.
    fn cell(s: &str) -> String {
        let t = s.replace('|', "\\|").replace("\r", " ").replace('\n', " ");
        if t.trim().is_empty() {
            "-".to_string()
        } else {
            t
        }
    }
    let mut out = String::new();
    let _ = writeln!(out, "# DevHub 操作记录");
    let _ = writeln!(
        out,
        "\n导出时间：{}\n\n共 {} 条。",
        now_string(),
        entries.len()
    );
    let _ = writeln!(out, "\n| 时间 | 类型 | 界面 | 操作 | 项目 | 路径 | 详情 |");
    let _ = writeln!(out, "| --- | --- | --- | --- | --- | --- | --- |");
    for e in entries {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {} | {} |",
            ts_string(e.ts),
            cell(&e.tag),
            cell(&e.source),
            cell(&e.action),
            cell(&e.slug),
            cell(&e.path),
            cell(&e.detail),
        );
    }
    out
}

/// A grouped report: one section per `group_key`, most recently touched first.
///
/// The flat table answers "what happened, in order". This answers the question
/// the 记录 view was actually reported as unable to answer — "how many times did
/// I change this one thing, and what was it before" — by folding every entry
/// that shares a target into one block.
pub fn to_markdown_grouped(entries: &[ActivityEntry]) -> String {
    use std::fmt::Write as _;
    let mut groups: std::collections::BTreeMap<String, Vec<&ActivityEntry>> = Default::default();
    for e in entries {
        groups.entry(e.group_key()).or_default().push(e);
    }
    let mut ordered: Vec<(String, Vec<&ActivityEntry>)> = groups.into_iter().collect();
    ordered.sort_by_key(|(_, es)| std::cmp::Reverse(es.iter().map(|e| e.ts).max().unwrap_or(0)));

    let mut out = String::new();
    let _ = writeln!(out, "# DevHub 操作记录（按对象归并）");
    let _ = writeln!(out, "\n导出时间：{}", now_string());
    for (key, mut es) in ordered {
        es.sort_by_key(|e| std::cmp::Reverse(e.ts));
        let _ = writeln!(out, "\n## {} · {} 次", key, es.len());
        for e in es {
            let change = if e.before.is_empty() && e.after.is_empty() {
                String::new()
            } else {
                format!("：{} → {}", e.before, e.after)
            };
            let detail = if e.detail.is_empty() {
                String::new()
            } else {
                format!("（{}）", e.detail)
            };
            let _ = writeln!(out, "- {} {}{}{}", ts_string(e.ts), e.action, change, detail);
        }
    }
    out
}

fn now_string() -> String {
    ts_string(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    )
}

/// `YYYY-MM-DD HH:MM` in local time.
///
/// chrono is already a dependency (used for the bootstrap marker timestamp), so
/// the export uses it instead of hand-rolling a timezone conversion - which is
/// exactly the kind of code that silently drifts by an hour on the wrong
/// machine.
fn ts_string(ts: i64) -> String {
    // Out-of-range timestamps print as the epoch instead of routing through
    // `from_timestamp(0, 0).unwrap()`: this runs while rendering and exporting the
    // 记录 page, and `panic = "abort"` in release turns any panic there into the
    // whole app going down. A hand-edited or truncated JSONL line can carry any
    // `ts` at all, so the range check is not hypothetical.
    match chrono::DateTime::from_timestamp(ts, 0) {
        Some(d) => d.naive_local().format("%Y-%m-%d %H:%M").to_string(),
        None => "1970-01-01 00:00".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: i64, tag: &str, action: &str, slug: &str) -> ActivityEntry {
        // The `ts` argument must survive: the retention and purge tests are
        // about old entries, and `now()` would stamp every fixture as current.
        ActivityEntry {
            ts,
            ..ActivityEntry::now(tag, action, "detail | with pipe", slug, "启动面板", "D:\\app\\项目\\repo_owner")
        }
    }

    /// The new fields must round-trip, and an old line that lacks them must
    /// still parse: `#[serde(default)]` is the only thing standing between a
    /// schema change and "所有历史记录消失了".
    #[test]
    fn change_and_undo_fields_round_trip() {
        let e = entry(now_ts(), "settings", "修改项目目录", "")
            .with_target("config.projectRoot")
            .with_change("D:\\old", "D:\\new")
            .with_undo(Undo::value("config", "projectRoot", "\"D:\\\\old\""));
        let line = serde_json::to_string(&e).unwrap();
        let back: ActivityEntry = serde_json::from_str(&line).unwrap();
        assert_eq!(back.target, "config.projectRoot");
        assert_eq!(back.before, "D:\\old");
        assert_eq!(back.after, "D:\\new");
        assert_eq!(back.undo.as_ref().unwrap().kind, "value");
        assert_eq!(back.group_key(), "settings:config.projectRoot");
    }

    #[test]
    fn a_pre_undo_line_still_parses_as_not_reversible() {
        let raw = "{\"id\":\"x1\",\"ts\":1700000000,\"tag\":\"launch\",\"action\":\"启动\",\"detail\":\"\",\"slug\":\"\",\"source\":\"\",\"path\":\"\"}";
        let e: ActivityEntry = serde_json::from_str(raw).unwrap();
        assert!(e.undo.is_none());
        assert!(e.target.is_empty());
        // No target and no slug means it groups alone rather than merging with
        // every other launch record.
        assert_eq!(e.group_key(), "single:x1");
    }

    #[test]
    fn delete_many_removes_exactly_the_listed_ids() {
        let path = tmp("delete-many");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        let mut ids = Vec::new();
        for i in 0..5 {
            let e = entry(ts, "launch", &format!("第{i}条"), "");
            ids.push(e.id.clone());
            append(&path, &e).unwrap();
        }
        let removed = delete_many(&path, &ids[0..3]).unwrap();
        assert_eq!(removed, 3);
        assert_eq!(list(&path, 0).unwrap().len(), 2);
        // Deleting ids that are already gone must fail rather than report 0 as
        // a success.
        assert!(delete_many(&path, &ids[0..3]).is_err());
    }

    /// The race the log gate exists for: `append` is what every command does, and the
    /// read→rewrite→rename path is what `list`/`delete`/`mark_undone`/`purge` do. An
    /// append landing between another thread's read and its rename was overwritten
    /// away — a record written and then silently un-written, on the feature whose
    /// promise is that everything is recorded.
    #[test]
    fn concurrent_appends_survive_a_rewriting_reader() {
        let path = tmp("append-vs-rewrite");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        for i in 0..8 {
            append(&path, &entry(ts, "download", &format!("种子{i}"), "")).unwrap();
        }

        const WRITERS: usize = 6;
        const PER_WRITER: usize = 5;
        std::thread::scope(|scope| {
            for w in 0..WRITERS {
                let path = path.clone();
                scope.spawn(move || {
                    for i in 0..PER_WRITER {
                        append(
                            &path,
                            &entry(ts, "launch", &format!("线程{w}第{i}条"), ""),
                        )
                        .unwrap();
                    }
                });
            }
            // Readers that also rewrite, at the same time.
            for _ in 0..4 {
                let path = path.clone();
                scope.spawn(move || {
                    let _ = list(&path, 0);
                    let _ = purge(&path, 3650);
                });
            }
        });

        let total = list(&path, 0).unwrap().len();
        assert_eq!(
            total,
            8 + WRITERS * PER_WRITER,
            "every append must survive the concurrent rewrites"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn purge_honours_forever_and_a_horizon() {
        let path = tmp("purge");
        let _ = std::fs::remove_file(&path);
        let now = now_ts();
        append(&path, &entry(now, "download", "新", "")).unwrap();
        append(&path, &entry(now - 10 * 86_400, "download", "旧", "")).unwrap();
        assert_eq!(purge(&path, 0).unwrap(), 0, "永久 deletes nothing");
        assert_eq!(purge(&path, 5).unwrap(), 1);
        assert_eq!(list(&path, 0).unwrap().len(), 1);
    }

    #[test]
    fn mark_undone_stamps_the_entry_and_survives_a_reread() {
        let path = tmp("mark-undone");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        let a = entry(ts, "settings", "第一条", "");
        let b = entry(ts, "settings", "第二条", "");
        append(&path, &a).unwrap();
        append(&path, &b).unwrap();

        assert!(mark_undone(&path, &a.id).unwrap(), "existing id marks");
        assert!(!mark_undone(&path, "no-such-id").unwrap(), "unknown id reports not-found");
        let read = list(&path, 0).unwrap();
        let ra = read.iter().find(|e| e.id == a.id).unwrap();
        let rb = read.iter().find(|e| e.id == b.id).unwrap();
        assert!(ra.undone_ts > 0, "the undone entry carries its stamp");
        assert_eq!(rb.undone_ts, 0, "sibling entries stay unmarked");
        // The stamp must be on disk, not just in the returned list.
        let again = list(&path, 0).unwrap();
        assert!(again.iter().find(|e| e.id == a.id).unwrap().undone_ts > 0);
    }

    /// Fixture timestamps must be recent: `list()` prunes by retention window,
    /// so a hardcoded 2023 date would be filtered out before it can be asserted
    /// on.
    fn now_ts() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// A unique temp path per test: these tests all exercise the same file
    /// operations, and a shared name makes them interfere when cargo runs them
    /// in parallel.
    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("devhub-activity-{name}"));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(format!("{name}.jsonl"))
    }

    #[test]
    fn jsonl_round_trips_through_a_file() {
        let path = tmp("jsonl");
        let _ = std::fs::remove_file(&path);

        let ts = now_ts();
        let out = [entry(ts, "download", "下载仓库", "github.com/a/b")];
        for e in &out {
            append(&path, e).unwrap();
        }
        let read = list(&path, 30).unwrap();
        assert_eq!(read.len(), 1, "one entry must survive the round trip");
        assert_eq!(read[0].action, "下载仓库");
        assert_eq!(read[0].slug, "github.com/a/b");
        assert_eq!(read[0].source, "启动面板", "界面归属必须原样读回");
        assert_eq!(read[0].path, "D:\\app\\项目\\repo_owner", "路径必须原样读回");

        let text = to_jsonl(&read);
        let back: ActivityEntry = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(back.ts, ts);
    }

    #[test]
    fn markdown_export_has_a_row_per_entry_and_escapes_pipes() {
        let out = [
            entry(1_700_000_000, "download", "下载仓库", "github.com/a/b"),
            entry(1_700_000_100, "settings", "修改项目目录", ""),
        ];
        let md = to_markdown(&out);
        assert!(
            md.contains("| 时间 | 类型 | 界面 | 操作 | 项目 | 路径 | 详情 |"),
            "header missing"
        );
        assert_eq!(md.matches("| download |").count(), 1);
        assert_eq!(md.matches("| settings |").count(), 1);
        // A `|` inside a detail cell would break the table if left unescaped.
        assert!(md.contains("detail \\| with pipe"), "pipe must be escaped");
        // An empty cell renders as `-` so the column count stays valid.
        assert!(md.contains("| - |"), "empty cells must not collapse the row");
    }

    #[test]
    fn retention_prunes_old_entries_on_read() {
        let path = tmp("retention");
        let _ = std::fs::remove_file(&path);

        let now = now_ts();
        append(&path, &entry(now, "download", "新", "")).unwrap();
        append(&path, &entry(now - 40 * 86_400, "download", "旧", "")).unwrap();

        let kept = list(&path, 30).unwrap();
        assert_eq!(kept.len(), 1, "a 40-day-old entry must be pruned at 30 days");
        assert_eq!(kept[0].action, "新");
        // And it must be gone from disk too, not just from the returned list.
        let after = list(&path, 30).unwrap();
        assert_eq!(after.len(), 1, "pruning must rewrite the file");
    }

    #[test]
    fn zero_retention_keeps_everything() {
        let path = tmp("forever");
        let _ = std::fs::remove_file(&path);

        let now = now_ts();
        append(&path, &entry(now, "download", "刚写的", "")).unwrap();
        // Three seconds old: under `cutoff = now` this is what disappeared.
        append(&path, &entry(now - 3, "download", "几秒前", "")).unwrap();
        append(&path, &entry(now - 5 * 365 * 86_400, "download", "五年前", "")).unwrap();

        let kept = list(&path, 0).unwrap();
        assert_eq!(kept.len(), 3, "永久 must never prune, not even a 3-second-old entry");
        // And nothing may have been rewritten away on disk either.
        assert_eq!(list(&path, 0).unwrap().len(), 3, "永久 must not rewrite the file");
    }

    #[test]
    fn ids_are_unique_within_a_second() {
        // Four writes inside the same second are exactly what a batch settings
        // save does; the id still has to tell them apart.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            assert!(seen.insert(next_id()), "duplicate id generated");
        }
    }

    #[test]
    fn a_legacy_line_without_an_id_is_backfilled_and_persisted() {
        let path = tmp("backfill");
        let _ = std::fs::remove_file(&path);
        // Verbatim pre-`id` format: five fields, no id / source / path.
        std::fs::write(
            &path,
            "{\"ts\":1700000000,\"tag\":\"settings\",\"action\":\"修改设置\",\"detail\":\"\",\"slug\":\"\"}\n",
        )
        .unwrap();

        let read = list(&path, 0).unwrap();
        assert_eq!(read.len(), 1, "an old line must still parse");
        assert_eq!(read[0].action, "修改设置");
        assert!(read[0].source.is_empty(), "missing 界面 reads as unknown");
        assert!(!read[0].id.is_empty(), "an id must have been assigned");

        // The second read must see the SAME id: the backfill has to be on disk,
        // otherwise deleting one row could never address it.
        let again = list(&path, 0).unwrap();
        assert_eq!(again[0].id, read[0].id, "backfill must be persisted");
    }

    #[test]
    fn delete_removes_one_entry_and_leaves_the_rest() {
        let path = tmp("delete");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        let a = entry(ts, "download", "第一条", "");
        let b = entry(ts, "download", "第二条", "");
        append(&path, &a).unwrap();
        append(&path, &b).unwrap();

        delete(&path, &a.id).unwrap();
        let left = list(&path, 30).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].action, "第二条");

        // A second delete of the same id must fail loudly rather than pretend.
        assert!(delete(&path, &a.id).is_err(), "deleting a gone entry must error");
    }

    #[test]
    fn an_unparseable_line_survives_a_rewrite() {
        let path = tmp("torn");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        append(&path, &entry(ts, "download", "好", "")).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(b"{\"ts\":1700000000,\"tag\":\n"))
            .unwrap();

        // Force the rewrite pass with a retention of 0 days... which keeps
        // everything, so use an old entry instead to trigger the purge.
        append(&path, &entry(ts - 40 * 86_400, "download", "过期", "")).unwrap();
        let kept = list(&path, 30).unwrap();
        assert_eq!(kept.len(), 1);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("{\"ts\":1700000000,\"tag\":"),
            "a line this build cannot parse must not be deleted by a rewrite"
        );
    }

    /// `ts_string` is the one place a foreign `ts` reaches formatted output, and
    /// it used to route an out-of-range value through an `unwrap()`. With
    /// `panic = "abort"` in release that is a whole-app exit triggered by one
    /// bad row in `devhub-activity.jsonl`.
    #[test]
    fn ts_string_never_panics_on_an_out_of_range_timestamp() {
        // In range: `YYYY-MM-DD HH:MM`, local time.
        let s = ts_string(1_700_000_000);
        assert_eq!(s.len(), 16, "{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
        assert_eq!(&s[10..11], " ");
        // Epoch prints as the epoch (whatever the local offset makes of it), and
        // the two extremes of `i64` print the documented fallback instead.
        assert_eq!(ts_string(0).len(), 16);
        assert_eq!(ts_string(i64::MAX), "1970-01-01 00:00");
        assert_eq!(ts_string(i64::MIN), "1970-01-01 00:00");
    }

    /// R2-2 可复现基准：1k / 10k / 100k 条夹具上的冷读、热读、触发重写的读。
    ///
    /// 刻意 `#[ignore]`：100k 条在 debug 构建下要秒级，塞进日常 `cargo test --lib`
    /// 会把每次门禁拖慢，而基线只需要在做存储决策时跑。要复现数字：
    ///
    ///     . .\env.ps1
    ///     $env:CARGO_TARGET_DIR = "<worktree>\src-tauri\target-r2"
    ///     Set-Location src-tauri
    ///     cargo test --lib -- --ignored --nocapture
    ///
    /// 输出是单行 key=value（`ACTIVITY_BENCH n=… kind=… bytes=… us=…`），没有浮点、
    /// 没有本地化格式，方便 grep 出来直接贴进 docs/activity-storage.md。
    /// 三种 kind：`cold` = 文件写好后的第一次 `list`；`warm` = 同一份文件立刻再
    /// `list` 一次（保留窗口内、id 齐全，所以不该触发重写）；`rewrite` = 夹具里
    /// 一成条目故意过期，`list(path, 30)` 必然走完 读→解析→整篇重写。
    #[test]
    #[ignore]
    fn bench_list_cold_warm_and_rewrite_at_three_sizes() {
        for n in [1_000usize, 10_000, 100_000] {
            let path = tmp(&format!("bench-read-{n}"));
            let _ = std::fs::remove_file(&path);
            write_fixture(&path, n, 0);
            let bytes = std::fs::metadata(&path).unwrap().len();

            let t0 = std::time::Instant::now();
            let cold = list(&path, 0).unwrap();
            let cold_us = t0.elapsed().as_micros();
            assert_eq!(cold.len(), n, "冷读必须返回全部 {n} 条");
            report_bench(n, "cold", bytes, cold_us);

            let t0 = std::time::Instant::now();
            let warm = list(&path, 0).unwrap();
            let warm_us = t0.elapsed().as_micros();
            assert_eq!(warm.len(), n, "热读必须返回全部 {n} 条");
            report_bench(n, "warm", bytes, warm_us);

            // 基准不能拿「少读了一半」当快：热读必须和冷读逐条同 id 同序。
            assert_eq!(
                warm.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                cold.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                "热读与冷读的条目与顺序必须一致"
            );
            drop(cold);
            drop(warm);
            let _ = std::fs::remove_file(&path);

            let path = tmp(&format!("bench-rewrite-{n}"));
            let _ = std::fs::remove_file(&path);
            write_fixture(&path, n, n / 10);
            let bytes = std::fs::metadata(&path).unwrap().len();
            let t0 = std::time::Instant::now();
            let kept = list(&path, 30).unwrap();
            let rewrite_us = t0.elapsed().as_micros();
            assert_eq!(kept.len(), n - n / 10, "过期的 {n}/10 必须被裁掉");
            report_bench(n, "rewrite", bytes, rewrite_us);
            let _ = std::fs::remove_file(&path);
        }
    }

    /// 夹具：一次性写盘，字节形状与 `append` 逐条追加出来的文件一致（同一个
    /// 结构体、同一个序列化器）。前 `expired` 条比 30 天还老，用来逼出 `list`
    /// 的懒重写；其余都是"现在"，保证热读路径不被保留期干扰。
    fn write_fixture(path: &std::path::Path, n: usize, expired: usize) {
        let now = now_ts();
        let mut text = String::with_capacity(n * 380);
        for i in 0..n {
            let ts = if i < expired {
                now - 40 * 86_400
            } else {
                now
            };
            let e = entry(
                ts,
                "download",
                &format!("下载仓库 #{i}"),
                &format!("github.com/owner/repo{i}"),
            );
            text.push_str(&serde_json::to_string(&e).unwrap());
            text.push('\n');
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    fn report_bench(n: usize, kind: &str, bytes: u64, us: u128) {
        println!("ACTIVITY_BENCH n={n} kind={kind} bytes={bytes} us={us}");
    }

    /// R2-3：命中与未命中。
    ///
    /// 用"这一线程走过几次全量读"来断言，而不是靠耗时：缓存是否生效是**行为**
    /// （读没读盘），不是性能感觉，计数是确定的、可断言的。
    #[test]
    fn read_cache_serves_an_unchanged_file_and_refills_after_a_write() {
        let path = tmp("cache-hit");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        append(&path, &entry(ts, "download", "第一条", "")).unwrap();

        let before = full_reads();
        let first = list(&path, 0).unwrap();
        assert_eq!(full_reads(), before + 1, "第一次读必须真读盘");
        assert!(cache_is_filled(), "读完要留下缓存");
        assert_eq!(first.len(), 1);

        // 文件没变：同一份数据第二次给，但一次盘都不该读。
        let second = list(&path, 0).unwrap();
        assert_eq!(full_reads(), before + 1, "未变更的文件必须走缓存");
        assert_eq!(second.len(), first.len());
        assert_eq!(second[0].id, first[0].id);
        assert_eq!(second[0].action, first[0].action);

        // append 改了文件（也主动清了缓存）：下一次必须重新读盘并看到新行。
        append(&path, &entry(ts, "download", "第二条", "")).unwrap();
        assert!(!cache_is_filled(), "append 之后不许还留着旧解析");
        let third = list(&path, 0).unwrap();
        assert_eq!(full_reads(), before + 2, "文件变了必须重新读盘");
        assert_eq!(third.len(), 2, "新追加的那条必须被读出来");
        let _ = std::fs::remove_file(&path);
    }

    /// R2-3：每一个写路径都要把缓存打掉。
    ///
    /// 断言的是"缓存空了"而不是"下次读对了"，因为失效是**写路径的义务**：
    /// 只测结果的话，一次碰巧同长度+同 mtime 的重写就能在不改行为测试的情况下
    /// 把缓存喂成脏数据。
    #[test]
    fn read_cache_is_dropped_by_every_write_path() {
        let path = tmp("cache-invalidate");
        let _ = std::fs::remove_file(&path);
        let now = now_ts();
        append(&path, &entry(now, "download", "新", "")).unwrap();
        append(&path, &entry(now - 40 * 86_400, "download", "旧", "")).unwrap();

        assert_eq!(list(&path, 0).unwrap().len(), 2);
        assert!(cache_is_filled(), "读完要留下缓存");

        // purge：有条目被删 → 重写 → 失效。
        assert_eq!(purge(&path, 30).unwrap(), 1);
        assert!(!cache_is_filled(), "purge 之后不许还留着旧解析");
        let after_purge = list(&path, 0).unwrap();
        assert_eq!(after_purge.len(), 1);
        assert!(cache_is_filled());

        // mark_undone：改一行也要整篇重写 → 失效；undo 标记必须读得回来。
        let id = after_purge[0].id.clone();
        assert!(mark_undone(&path, &id).unwrap());
        assert!(!cache_is_filled(), "mark_undone 之后不许还留着旧解析");
        let after_mark = list(&path, 0).unwrap();
        assert!(after_mark[0].undone_ts > 0, "缓存命中也不能把 undo 标记读丢");
        assert!(cache_is_filled());

        // delete_many：批量删一次重写 → 失效。
        assert_eq!(delete_many(&path, &[id.clone()]).unwrap(), 1);
        assert!(!cache_is_filled(), "delete_many 之后不许还留着旧解析");
        assert!(list(&path, 0).unwrap().is_empty());

        // delete：单删一次重写 → 失效。
        let e = entry(now_ts(), "download", "再来一条", "");
        append(&path, &e).unwrap();
        let _ = list(&path, 0).unwrap();
        assert!(cache_is_filled());
        delete(&path, &e.id).unwrap();
        assert!(!cache_is_filled(), "delete 之后不许还留着旧解析");
        assert!(list(&path, 0).unwrap().is_empty());

        // clear：文件都没了 → 失效，并且下一次读必须是空，不是缓存里的旧记录。
        append(&path, &entry(now_ts(), "download", "最后一条", "")).unwrap();
        let _ = list(&path, 0).unwrap();
        assert!(cache_is_filled());
        clear(&path).unwrap();
        assert!(!cache_is_filled(), "clear 之后不许还留着旧解析");
        assert!(list(&path, 0).unwrap().is_empty(), "文件没了就必须是空，不许回缓存");
        let _ = std::fs::remove_file(&path);
    }

    /// R2-3：读坏了 / 没了的文件绝不拿缓存糊过去。
    ///
    /// "任何一次查证失败都退回全量读"里最容易写错的两件事：文件被删（缓存还在）
    /// 和文件读不进去（非法 UTF-8）。两者都必须是空或报错，**不能**是上一次的
    /// 内容——那正是"永远不返回陈旧数据"的字面要求。
    #[test]
    fn a_broken_or_missing_file_never_comes_back_from_the_cache() {
        let path = tmp("cache-corrupt");
        let _ = std::fs::remove_file(&path);
        append(&path, &entry(now_ts(), "download", "好", "")).unwrap();
        assert_eq!(list(&path, 0).unwrap().len(), 1);
        assert!(cache_is_filled());

        // (a) 文件被删掉。
        std::fs::remove_file(&path).unwrap();
        assert!(list(&path, 0).unwrap().is_empty(), "文件没了必须返回空，不是缓存里的那条");

        // (b) 文件在，但读不进去（非法 UTF-8）：必须报错，而不是回缓存。
        std::fs::write(&path, b"\xff\xfe not utf-8 at all\n").unwrap();
        assert!(list(&path, 0).is_err(), "读不进去必须报错，不是回缓存");
        let _ = std::fs::remove_file(&path);
    }

    /// R2-3：缓存答不了的问题，必须退回全量读（并由全量路径负责重写）。
    ///
    /// 缓存是在"宽松窗口"下填的，随后配置把保留期收紧：缓存里有过期行，而裁剪
    /// 与落盘是全量路径的职责。退回不能只是"这次少返回几条"，文件也必须真的被
    /// 改写，否则下一次宽松窗口又会把过期行放出来。
    #[test]
    fn a_tightened_retention_falls_back_to_a_full_read_and_rewrites() {
        let path = tmp("cache-retention");
        let _ = std::fs::remove_file(&path);
        let now = now_ts();
        append(&path, &entry(now, "download", "新", "")).unwrap();
        append(&path, &entry(now - 40 * 86_400, "download", "旧", "")).unwrap();

        assert_eq!(list(&path, 0).unwrap().len(), 2, "宽松窗口两条都在");
        assert!(cache_is_filled());

        let kept = list(&path, 30).unwrap();
        assert_eq!(kept.len(), 1, "收紧窗口后过期行必须不再返回");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("旧"), "裁剪必须落盘，不只是这一次不返回");
        assert_eq!(list(&path, 0).unwrap().len(), 1, "落盘后连宽松窗口也只剩一条");
        let _ = std::fs::remove_file(&path);
    }

    /// R2-3：两把锁在 worker panic 之后都必须还能用。
    ///
    /// `activity_lock` 一直有"中毒也继续"的承诺，新加的缓存锁必须遵守同一条，
    /// 否则一次 panic 就把"读变慢"升级成"读永久不可用"。这里连缓存锁一起毒化：
    /// 它和日志锁是一对，坏一半等于全坏。
    #[test]
    fn a_poisoned_gate_still_reads_and_writes() {
        let path = tmp("cache-poison");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        append(&path, &entry(ts, "download", "第一条", "")).unwrap();
        assert_eq!(list(&path, 0).unwrap().len(), 1);

        let poisoner = std::thread::spawn(|| {
            let _gate = super::activity_lock();
            let _cache = super::cache_lock();
            panic!("故意毒化两把锁");
        });
        assert!(poisoner.join().is_err(), "夹具线程必须以 panic 结束");

        append(&path, &entry(ts, "download", "第二条", "")).unwrap();
        let all = list(&path, 0).unwrap();
        assert_eq!(all.len(), 2, "毒化之后追加与读取都必须照常");
        let _ = std::fs::remove_file(&path);
    }

    /// B1: `cache_invalidate` is the public entry the manual 刷新 button uses.
    /// It must drop the cached parse so the next `list` reads the bytes on disk.
    #[test]
    fn cache_invalidate_drops_the_cached_parse() {
        let path = tmp("invalidate");
        let _ = std::fs::remove_file(&path);
        let ts = now_ts();
        append(&path, &entry(ts, "download", "第一", "")).unwrap();

        assert_eq!(list(&path, 0).unwrap().len(), 1);
        assert!(cache_is_filled(), "read fills the cache");

        // Simulate the manual 刷新: bypass the cache, then rewrite the file
        // underneath so the cache's stamp no longer matches.
        cache_invalidate();
        append(&path, &entry(ts, "download", "第二", "")).unwrap();
        let entries = list(&path, 0).unwrap();
        assert_eq!(entries.len(), 2, "invalidation + new append must be visible");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn csv_quotes_commas_quotes_and_newlines() {
        let mut e = entry(0, "download", "含,逗号", "");
        e.detail = "第一行\n第二行\"引号\"".into();
        e.id = "a\"b".into();
        e.slug = "o/r".into();
        let text = super::to_csv(&[e]);
        assert!(text.starts_with("\u{feff}id,ts,tag,"), "BOM + header");
        assert!(text.contains("\"含,逗号\""), "a comma stays inside one quoted cell");
        assert!(
            text.contains("\"第一行\n第二行\"\"引号\"\""),
            "newline kept, quote doubled: {text:?}"
        );
        assert!(text.contains("\"a\"\"b\""), "id quote doubled");
        assert!(text.ends_with("\r\n"), "RFC 4180 row terminator");
    }

    #[test]
    fn csv_neutralises_formula_prefixes_before_quoting() {
        let mut e = entry(0, "download", "=HYPERLINK(\"http://example.invalid\")", "");
        e.detail = "+1+1".into();
        e.slug = "-2+3".into();
        e.path = "@SUM(A1)".into();
        e.target = "\t=cmd".into();
        e.source = "\r=cmd".into();
        // A value that merely contains a formula later is not a formula cell.
        e.before = "ok =cmd".into();
        let text = super::to_csv(&[e]);
        assert!(text.contains("\"'=HYPERLINK(\"\"http://example.invalid\"\")\""), "{text}");
        assert!(text.contains("\"'+1+1\""), "{text}");
        assert!(text.contains("\"'-2+3\""), "{text}");
        assert!(text.contains("\"'@SUM(A1)\""), "{text}");
        assert!(text.contains("\"'\t=cmd\""), "a leading tab is also a formula path: {text}");
        assert!(text.contains("\"'\r=cmd\""), "a leading CR is also a formula path: {text}");
        assert!(text.contains("\"ok =cmd\""), "only the first character decides: {text}");
    }
}
