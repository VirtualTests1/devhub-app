//! The repository index: one container walk per *change*, not one per *question*.
//!
//! ## Why this exists
//!
//! `--scan-check` measured the wall on a real container (13 repositories, 4
//! directories visited): a full walk plus marker reads costs 45-95 ms warm, but
//! **resolving one slug cost 27-54 ms** because `find_repo_any` walked every root
//! from scratch. Thirteen commands call it, so naming a repository cost as much as
//! rebuilding the whole wall, and opening the 启动面板 - which names one repository
//! three times - paid it three times over.
//!
//! With a project root that also holds a build tree the same probe measured
//! **86 s cold / 3.3 s warm per walk, 3.5 s per slug**. That is what "每次打开项目
//! 都要等一下" was.
//!
//! ## How it decides whether it is still true
//!
//! Each directory the walk opened is stamped with the **sorted set of its
//! subdirectory names** ([`ContainerStamp`] - deliberately a name set and not an
//! mtime, because the index file itself is written into the container and would
//! invalidate its own mtime). Adding, removing or renaming a repository directory
//! changes a parent's name set, so validity costs N `read_dir` calls where N is the
//! number of *container* directories - four for a flat layout - instead of a re-walk.
//!
//! What that check does not need to see: an entry carries only identity and path
//! ([`Entry`] holds a [`RepoRef`], which has `host`/`owner`/`repo`/`local`/`path` and
//! no marker fields). So editing a `.devhub.json` - a port block, a venv, a launch
//! command - cannot make a stored entry wrong, and nothing that reads those fields
//! reads them from the index: 启动面板 and 项目设置 both go through `repo_detail`,
//! which opens the marker afresh. [`invalidate`] is still called by every write path
//! for the cases that do matter - a clone that landed a new directory, a repository
//! whose name changed - and dropping the in-process copy is enough there because the
//! disk index's own stamps catch the directory-level change on the next read.
//!
//! ## Two levels
//!
//! * in-process ([`CACHE`]) - the hot path, no disk reads at all on a hit;
//! * on-disk (`<root>/.devhub-index.json`) - so a cold start does not walk either.
//!   A file that fails validation is ignored, never trusted: a corrupt, foreign or
//!   stale index degrades to "walk the disk", which is what the app did before.
//!
//! `DEVHUB_NO_INDEX=1` disables both, which is how the before/after numbers in the
//! fix report were produced rather than asserted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::downloader::{self, ContainerStamp, RepoRef};

/// One repository as the walk saw it, with everything a slug lookup compares.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub repo_ref: RepoRef,
    /// The names this directory answers to - the same set the walk uses.
    pub names: downloader::RepoNames,
}

/// The index for one project root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootIndex {
    pub root: String,
    pub containers: Vec<ContainerStamp>,
    pub entries: Vec<Entry>,
    pub written_ms: i64,
}

/// Everything the wall and every slug lookup are answered from.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Index {
    pub roots: Vec<RootIndex>,
}

/// Where the answer came from, printed by the timing line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The in-process index still matches what is on disk.
    Memory,
    /// Cold start: `<root>/.devhub-index.json` validated.
    Disk,
    /// The disk changed (or nothing was cached): the walk ran.
    Walked,
}

impl Origin {
    pub fn label(&self) -> &'static str {
        match self {
            Origin::Memory => "memory",
            Origin::Disk => "disk",
            Origin::Walked => "walk",
        }
    }
}

/// A disk index older than this is dropped rather than validated.
const DISK_MAX_AGE_MS: i64 = 7 * 24 * 3600 * 1000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn disk_path(root: &Path) -> PathBuf {
    root.join(".devhub-index.json")
}

fn index_disabled() -> bool {
    std::env::var_os("DEVHUB_NO_INDEX").is_some_and(|v| v != "0")
}

static CACHE: std::sync::Mutex<Option<Cached>> = std::sync::Mutex::new(None);

/// Serialises the expensive walk so two concurrent callers do not both pay it.
static WALKING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The in-process index, and when it was last proved against the disk.
struct Cached {
    index: Index,
    validated_at: std::time::Instant,
}

/// How long a validated index is trusted without re-reading the directory.
///
/// Validation is not free - measured here at ~12 ms for a 15-entry container,
/// because it is a `read_dir` plus an `is_dir` per child - and one user action
/// asks the same question several times: opening the 启动面板 resolves the slug
/// three times. Re-checking once a second keeps the answer honest about changes
/// made outside the app without paying the stat cost per lookup.
const TRUST_WINDOW: std::time::Duration = std::time::Duration::from_millis(1000);

/// Drops the in-process index. Call after anything that adds, removes, renames or
/// re-identifies a repository.
pub fn invalidate() {
    {
        // Poison-tolerant on purpose: a panic elsewhere must not turn
        // invalidation into a silent no-op (the index would then serve stale
        // entries for the rest of the session) or force an 86-second full walk.
        let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        *c = None;
    }
}

/// Does the recorded set of container stamps still describe the disk?
///
/// One `read_dir` per container directory - the directories that hold
/// repositories, typically four for a flat container - and no descent. Writing
/// this file, a venv, or a log into the container cannot make the check fail;
/// adding, removing or renaming a repository directory always does.
fn containers_current(root: &RootIndex) -> bool {
    if root.containers.is_empty() {
        // An index that never opened a directory proves nothing about one.
        return false;
    }
    root.containers.iter().all(|s| {
        let Ok(entries) = std::fs::read_dir(Path::new(&s.path)) else {
            return false;
        };
        // Directories only, matching what the walk records: a file appearing in
        // the container - including this index - is not a repository change.
        // `path().is_dir()` rather than `file_type()`, so a junction into another
        // drive is counted on both sides exactly the way the walk counts it.
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                e.path()
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
            .collect();
        names.sort();
        names == s.dirs
    })
}

/// Walks one root and identifies every repository in it.
///
/// The marker is read **once** per repository and reused for both the identity and
/// the lookup key; `list_repositories` used to read it twice.
fn scan_root(root: &Path) -> RootIndex {
    let mut stats = downloader::WalkStats::default();
    let mut entries: Vec<Entry> = Vec::new();

    downloader::collect_repos_counted(
        root,
        &mut |rel, abs| {
            let marker = downloader::read_marker(abs);
            let Some(rr) = downloader::repo_ref_of_marker(root, abs, marker.as_ref()) else {
                return;
            };
            entries.push(Entry {
                repo_ref: rr,
                names: downloader::repo_names_with(root, rel, abs, marker.as_ref()),
            });
        },
        &mut stats,
    );

    entries.sort_by_key(|a| a.repo_ref.slug());
    entries.dedup_by(|a, b| a.repo_ref.slug() == b.repo_ref.slug());

    // A skipped junction is not an error, but it is the reason a directory the
    // user can see in Explorer is absent from the wall. Say it once per scan
    // instead of leaving the difference unexplained.
    if stats.reparse_skipped > 0 {
        eprintln!(
            "[repo-index] {} skipped {} junction/symlink director(ies) under {}",
            std::process::id(),
            stats.reparse_skipped,
            root.display()
        );
    }

    RootIndex {
        root: root.to_string_lossy().to_string(),
        containers: stats.containers,
        entries,
        written_ms: now_ms(),
    }
}

fn load_root(root: &Path) -> Option<RootIndex> {
    let text = std::fs::read_to_string(disk_path(root)).ok()?;
    let stored: RootIndex = serde_json::from_str(&text).ok()?;
    if now_ms() - stored.written_ms > DISK_MAX_AGE_MS {
        return None;
    }
    if Path::new(&stored.root) != root {
        // A container copied to another path: the entries name the old one.
        return None;
    }
    containers_current(&stored).then_some(stored)
}

fn save_root(index: &RootIndex) {
    let path = disk_path(Path::new(&index.root));
    if let Ok(text) = serde_json::to_string_pretty(index) {
        // Atomic like every other whole-file rewrite in the backend (see
        // `lib::write_atomic`). The old direct `fs::write` had two failure
        // shapes: a crash mid-write left a truncated JSON that the next
        // `load_root` could still parse if the truncation fell on a field
        // boundary — serving a silently partial index — and two concurrent
        // cold starts (this runs outside the `CACHE` lock by design, see
        // `current`) interleaved bytes into one file. Both are gone once the
        // visible file only ever changes by rename of a fully-written temp.
        if let Err(e) = crate::write_atomic(&path, text.as_bytes()) {
            // A cache write that fails is not fatal — the next load falls back
            // to a walk — but it must not be silent: a persistent failure here
            // means every launch re-walks every root and nobody can see why.
            eprintln!("[repo-index] 写入 {} 失败: {e}", path.display());
        }
    }
}

fn build(roots: &[PathBuf]) -> Index {
    Index {
        roots: roots.iter().map(|r| scan_root(r)).collect(),
    }
}

/// A snapshot of the cached index for these roots and how long ago it was last
/// validated, copied out under the cache lock.
fn cached_for(roots: &[PathBuf]) -> Option<(Index, std::time::Duration)> {
    let c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    c.as_ref()
        .filter(|hit| hit.index.matches(roots))
        .map(|hit| (hit.index.clone(), hit.validated_at.elapsed()))
}

/// Records that the current index was just validated. A different roots set may
/// have replaced the entry while validation ran outside the lock; only touch the
/// entry when it still describes these roots.
fn mark_validated(roots: &[PathBuf]) {
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(hit) = c.as_mut().filter(|hit| hit.index.matches(roots)) {
        hit.validated_at = std::time::Instant::now();
    }
}

/// The index for these roots, from the cheapest source that is still true.
fn current(roots: &[PathBuf]) -> (Index, Origin) {
    if index_disabled() {
        return (build(roots), Origin::Walked);
    }

    if let Some((index, age)) = cached_for(roots) {
        // `is_current` reads one directory per container. It used to run while
        // CACHE was locked, so every lookup on a slow share serialized behind
        // it. The clone is cheap next to a `read_dir`; validate outside, then
        // take the lock again only to record the timestamp.
        if age < TRUST_WINDOW || index.is_current() {
            mark_validated(roots);
            return (index, Origin::Memory);
        }
    }

    // Acquire the walk guard — only one walker at a time.
    let _walk_guard = WALKING.lock().unwrap_or_else(|poisoned| {
        eprintln!("repo_index WALKING mutex poisoned, recovering: {poisoned}");
        poisoned.into_inner()
    });

    // Double-check cache under the walk guard (another walker may have finished).
    if let Some((index, age)) = cached_for(roots) {
        if age < TRUST_WINDOW || index.is_current() {
            mark_validated(roots);
            return (index, Origin::Memory);
        }
    }

    // Cold start: every root must load and validate, or none of it is trusted.
    let loaded: Option<Vec<RootIndex>> = roots
        .iter()
        .map(|r| load_root(r))
        .collect::<Option<Vec<_>>>();
    let (index, origin) = match loaded {
        Some(parts) => (Index { roots: parts }, Origin::Disk),
        None => {
            let built = build(roots);
            for part in &built.roots {
                save_root(part);
            }
            (built, Origin::Walked)
        }
    };

    store(&index);
    (index, origin)
}

fn store(index: &Index) {
    {
        // Poison-tolerant on purpose: a panic elsewhere must not turn
        // invalidation into a silent no-op (the index would then serve stale
        // entries for the rest of the session) or force an 86-second full walk.
        let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        *c = Some(Cached {
            index: index.clone(),
            validated_at: std::time::Instant::now(),
        });
    }
}

/// Forces a walk and rewrites both levels - what the 刷新 button does.
pub fn refresh(roots: &[PathBuf]) -> (Index, Origin) {
    invalidate();
    let built = build(roots);
    if !index_disabled() {
        for part in &built.roots {
            save_root(part);
        }
        store(&built);
    }
    (built, Origin::Walked)
}

impl Index {
    fn matches(&self, roots: &[PathBuf]) -> bool {
        self.roots.len() == roots.len()
            && self
                .roots
                .iter()
                .zip(roots)
                .all(|(r, want)| Path::new(&r.root) == want.as_path())
    }

    fn is_current(&self) -> bool {
        self.roots.iter().all(containers_current)
    }

    /// The wall: every repository, sorted by slug and deduplicated, exactly as
    /// `list_repositories` has always returned it.
    pub fn repos(&self) -> Vec<RepoRef> {
        let mut out: Vec<RepoRef> = self
            .roots
            .iter()
            .flat_map(|r| r.entries.iter().map(|e| e.repo_ref.clone()))
            .collect();
        out.sort_by_key(|a| a.slug());
        out.dedup_by(|a, b| a.slug() == b.slug());
        out
    }

    /// Resolves a slug across roots, first root that answers winning - the same
    /// precedence `find_repo_any` had, with [`downloader::slug_score`] deciding
    /// within a root instead of a second walk.
    pub fn find(&self, slug: &str) -> Option<PathBuf> {
        let want = downloader::normalize_slug(slug);
        if want.is_empty() {
            return None;
        }
        for root in &self.roots {
            let mut best: Option<(u8, PathBuf)> = None;
            for e in &root.entries {
                let Some(score) = downloader::slug_score(&want, &e.names) else {
                    continue;
                };
                // A disk entry with no path must not become "found at ``":
                // `unwrap_or_default()` turned a missing `path` into an empty
                // PathBuf, so `repo_detail`/launch were handed a repository that
                // resolves to the current working directory. Skipping the
                // candidate is the honest reading of an index row that does not
                // say where the repo is.
                let Some(path) = e.repo_ref.path.as_ref() else {
                    continue;
                };
                if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
                    best = Some((score, path.clone().into()));
                }
            }
            if let Some((_, p)) = best {
                return Some(p);
            }
        }
        None
    }
}

/// The index for these roots, optionally forcing a walk (what 刷新 does).
pub fn load(roots: &[PathBuf], force: bool) -> (Index, Origin) {
    if force {
        refresh(roots)
    } else {
        current(roots)
    }
}

/// The wall for the configured roots.
pub fn repos(roots: &[PathBuf]) -> (Vec<RepoRef>, Origin) {
    let (index, origin) = current(roots);
    (index.repos(), origin)
}

/// Resolves a slug for the configured roots without touching the disk.
pub fn find(roots: &[PathBuf], slug: &str) -> (Option<PathBuf>, Origin) {
    let (index, origin) = current(roots);
    (index.find(slug), origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("devhub-index-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn repo(root: &Path, dir_name: &str, marker_slug: Option<&str>) -> PathBuf {
        let p = root.join(dir_name);
        std::fs::create_dir_all(p.join(".git")).unwrap();
        if let Some(slug) = marker_slug {
            std::fs::write(
                downloader::marker_path(&p),
                format!(r#"{{"slug":"{slug}"}}"#),
            )
            .unwrap();
        }
        p
    }

    #[test]
    fn the_index_resolves_every_spelling_the_walk_resolves() {
        // The whole point: one comparison rule, two consumers. If these two
        // answers ever diverge, a repository is listed under one spelling and
        // reported as 未找到仓库 under another.
        let root = scratch("parity");
        let flat = repo(&root, "tool_alice", Some("github.com/alice/tool"));
        repo(&root, "plain_bob", None);
        let nested = root.join("code/github.com/carol/legacy");
        std::fs::create_dir_all(nested.join(".git")).unwrap();
        std::fs::write(
            downloader::marker_path(&nested),
            r#"{"slug":"github.com/carol/legacy"}"#,
        )
        .unwrap();

        for spelling in [
            "github.com/alice/tool",
            "alice/tool",
            "tool",
            "tool_alice",
            "plain_bob",
            "bob",
            // The identity the wall lists a markerless directory under. This is
            // the spelling that used to be listed-but-unresolvable.
            "github.com/bob/plain",
            "github.com/carol/legacy",
            "carol/legacy",
            "legacy",
            "code/github.com/carol/legacy",
            "nope",
        ] {
            let walked = downloader::find_repo_by_slug(&root, spelling);
            let indexed = build(std::slice::from_ref(&root)).find(spelling);
            assert_eq!(
                walked.as_deref(),
                indexed.as_deref(),
                "parity broken for `{spelling}`"
            );
        }

        assert_eq!(
            build(std::slice::from_ref(&root))
                .find("tool")
                .as_deref(),
            Some(flat.as_path()),
            "the marker slug must win over a same-named directory"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn adding_a_repository_invalidates_the_stored_index() {
        let root = scratch("stale");
        repo(&root, "one_alice", Some("github.com/alice/one"));
        let index = build(std::slice::from_ref(&root));
        assert_eq!(index.repos().len(), 1);
        assert!(index.is_current(), "a fresh index describes the disk");

        std::fs::write(disk_path(&root), "extra file, not a directory").unwrap();
        repo(&root, "two_bob", Some("github.com/bob/two"));
        assert!(
            !index.is_current(),
            "a new repository directory must be noticed even though a file was
             written into the same container in the same breath"
        );
        assert_eq!(build(std::slice::from_ref(&root)).repos().len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_or_foreign_disk_index_falls_back_to_the_walk() {
        let root = scratch("corrupt");
        repo(&root, "one_alice", Some("github.com/alice/one"));

        std::fs::write(disk_path(&root), "{ not json").unwrap();
        assert!(load_root(&root).is_none(), "unparseable is not usable");

        std::fs::write(
            disk_path(&root),
            r#"{"root":"D:/somewhere/else","containers":[],"entries":[],"written_ms":99999999999999}"#,
        )
        .unwrap();
        assert!(
            load_root(&root).is_none(),
            "an index naming another root is not ours"
        );
        assert_eq!(
            current(std::slice::from_ref(&root)).0.repos().len(),
            1,
            "and the caller still gets the repository"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_saved_index_avoids_the_walk_after_a_restart() {
        let root = scratch("roundtrip");
        repo(&root, "one_alice", Some("github.com/alice/one"));
        repo(&root, "two_bob", None);
        invalidate();
        let (first, origin_a) = current(std::slice::from_ref(&root));
        assert_eq!(origin_a, Origin::Walked);
        assert!(disk_path(&root).is_file(), "the walk leaves a disk index");
        assert!(
            first.is_current(),
            "saving the index into the container must not invalidate it - that is
             the file's own directory entry moving the stamp"
        );

        invalidate();
        let (second, origin_b) = current(std::slice::from_ref(&root));
        assert_eq!(origin_b, Origin::Disk);
        assert_eq!(first.repos(), second.repos());
        assert_eq!(second.find("one"), first.find("one"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
