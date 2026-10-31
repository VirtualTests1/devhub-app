//! Startup clean-up of crash residue (r33-D1).
//!
//! Two shapes of file outlive a killed process and are nobody's data:
//!
//!   * `write_atomic`'s sibling temp files (`<name>.tmp.<pid>.<seq>`), left when the
//!     process died between `File::create` and `rename`, and only when `<name>` is
//!     one of this app's own state files (`APP_ATOMIC_BASE_NAMES`) — the filename
//!     shape alone is not proof of ownership;
//!   * cover download temps (`<cover>.png.part`, `<cover>.png.headers`), left when
//!     curl was killed before its result was renamed into the cache;
//!   * a clone sentinel (`<landing>.devhub-cloning`) next to a landing directory
//!     whose download was interrupted. The sentinel is written before git starts
//!     and removed by a guard on every normal exit, so one that survives a day is
//!     proof the process died mid-clone.
//!
//! None of these is removed eagerly: the age threshold is 24 hours, because a
//! second copy of the app (a dev run beside the installed one) may legitimately be
//! mid-write, and a temp file that is one minute old is not residue.
//!
//! An interrupted **directory** is moved to the Recycle Bin, not deleted. It has no
//! `.devhub.json` marker - a successful clone writes one - so it is not a
//! repository this app knows, and the trash is still recoverable if the guess was
//! wrong. A directory that does carry a marker is a real clone: only its stale
//! sentinel is removed.
//!
//! The sweep runs on a worker thread from setup; the wall does not wait for it.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use walkdir::WalkDir;

/// Residue younger than this may belong to a live writer.
pub(crate) const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Temp files removed (atomic writes + cover parts).
    pub temps_removed: usize,
    /// Bytes freed by those temp files.
    pub bytes_freed: u64,
    /// Directories moved to the Recycle Bin.
    pub partials_trashed: usize,
    /// Stale sentinels removed (a success that did not clean its own sentinel).
    pub sentinels_removed: usize,
    /// Failures worth a log line, never a startup failure.
    pub errors: usize,
}

impl SweepReport {
    pub fn is_empty(&self) -> bool {
        self.temps_removed == 0
            && self.partials_trashed == 0
            && self.sentinels_removed == 0
            && self.errors == 0
    }
}

/// The sibling file that marks "a clone into this landing directory is running".
pub(crate) fn sentinel_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{name}.devhub-cloning"))
}

/// Removes the sentinel on every normal exit, including an early return.
///
/// `panic = "abort"` in release means a panic leaves the file behind on purpose:
/// that is exactly the residue the next startup's sweep is looking for.
pub(crate) struct CloneSentinel(PathBuf);

impl CloneSentinel {
    /// Create the sentinel beside `target`. Best-effort: failing to write it must
    /// not fail a download.
    pub(crate) fn start(target: &Path) -> Option<Self> {
        let path = sentinel_path(target);
        std::fs::write(&path, target.to_string_lossy().as_bytes()).ok()?;
        Some(Self(path))
    }
}

impl Drop for CloneSentinel {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.0) {
            // Not fatal, but not silent either: a sentinel that cannot be removed
            // becomes a false "interrupted clone" on the next start.
            eprintln!("[sweep] 无法删除克隆哨兵 {}: {e}", self.0.display());
        }
    }
}

/// Base names whose atomic temps this app owns.
///
/// The old sweep removed **any** `foo.tmp.1234.7` under a project root. That is
/// a shape other tools and users also produce, so a 24-hour-old user file with
/// the wrong name was deleted as "residue". Ownership has to be named, not
/// inferred from a filename shape.
const APP_ATOMIC_BASE_NAMES: &[&str] = &[
    ".devhub.json",
    ".devhub-index.json",
    "devhub-config.json",
    "devhub-config.json.bak",
    "devhub-activity.jsonl",
    "devhub-crash.json",
    "devhub-window.json",
];

/// The target name of an atomic temp, when `name` has the exact
/// `<base>.tmp.<digits>.<digits>` shape.
fn atomic_target_base(name: &str) -> Option<&str> {
    let (base, tail) = name.rsplit_once(".tmp.")?;
    let (pid, seq) = tail.split_once('.')?;
    if pid.is_empty()
        || seq.is_empty()
        || !pid.chars().all(|c| c.is_ascii_digit())
        || !seq.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some(base)
}

/// `foo.tmp.1234.7` - the shape `write_atomic` creates.
#[cfg(test)]
fn is_atomic_temp(name: &str) -> bool {
    atomic_target_base(name).is_some()
}

/// Only the temp files whose target is one of this app's own state files.
fn is_app_atomic_temp(name: &str) -> bool {
    atomic_target_base(name).is_some_and(|base| APP_ATOMIC_BASE_NAMES.contains(&base))
}

/// Cover downloads write `<cover>.png.part` / `.headers` directly in the cover
/// cache. The same suffix in a user's source tree is not ours to delete.
fn is_in_cover_cache(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root.join("cache").join("covers").as_path())
}

fn is_cover_temp(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png.part") || lower.ends_with(".png.headers")
}

fn is_sentinel(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".devhub-cloning")
}

/// Whether `modified` is old enough to be residue rather than a live write.
fn is_stale(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .map(|age| age >= STALE_AFTER)
        .unwrap_or(false)
}

/// Skip directories that cannot hold a landing directory or a marker temp.
fn skip_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    if crate::disk::is_reparse_point(entry.path()) {
        return true;
    }
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    crate::searchgrep::IGNORE_DIRS.contains(&name)
        || matches!(name, ".pack" | ".worktrees")
        || name.starts_with('.')
}

/// Start the startup sweep on its own thread.
///
/// One line at the setup site: resolving the roots reads the config, and the
/// walk itself must not delay the first frame.
pub(crate) fn spawn_startup_sweep() {
    let roots = crate::project_roots();
    let config_dir = crate::settings_cmd::config_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    std::thread::spawn(move || {
        let report = sweep(&roots, &config_dir);
        if !report.is_empty() {
            println!(
                "[sweep] temps={} bytes={} partials={} sentinels={} errors={}",
                report.temps_removed,
                report.bytes_freed,
                report.partials_trashed,
                report.sentinels_removed,
                report.errors
            );
        }
    });
}

/// Run the sweep over every project root plus the config directory.
pub(crate) fn sweep(roots: &[PathBuf], config_dir: &Path) -> SweepReport {
    sweep_with(roots, config_dir, SystemTime::now(), &mut |path| {
        trash::delete(path).map_err(|e| e.to_string())
    })
}

/// The testable core: `trash_dir` is injected so a unit test never touches the
/// user's Recycle Bin.
fn sweep_with(
    roots: &[PathBuf],
    config_dir: &Path,
    now: SystemTime,
    trash_dir: &mut dyn FnMut(&Path) -> Result<(), String>,
) -> SweepReport {
    let mut report = SweepReport::default();

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let walk = WalkDir::new(root)
            .max_depth(6)
            .into_iter()
            .filter_entry(|e| !skip_dir(e));
        for entry in walk.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                report.errors += 1;
                continue;
            };
            if !is_stale(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), now) {
                continue;
            }
            if is_sentinel(name) {
                sweep_sentinel(path, root, trash_dir, &mut report);
                continue;
            }
            let cover_residue = is_cover_temp(name) && is_in_cover_cache(root, path);
            if is_app_atomic_temp(name) || cover_residue {
                match std::fs::remove_file(path) {
                    Ok(()) => {
                        report.temps_removed += 1;
                        report.bytes_freed += meta.len();
                    }
                    Err(_) => report.errors += 1,
                }
            }
        }
    }

    // The config directory is usually outside every project root (the install
    // directory in portable builds). Its atomic temps are the same shape.
    if let Ok(entries) = std::fs::read_dir(config_dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if is_app_atomic_temp(&name) && is_stale(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), now) {
                match std::fs::remove_file(entry.path()) {
                    Ok(()) => {
                        report.temps_removed += 1;
                        report.bytes_freed += meta.len();
                    }
                    Err(_) => report.errors += 1,
                }
            }
        }
    }

    report
}

fn sweep_sentinel(
    sentinel: &Path,
    root: &Path,
    trash_dir: &mut dyn FnMut(&Path) -> Result<(), String>,
    report: &mut SweepReport,
) {
    let target = std::fs::read_to_string(sentinel)
        .ok()
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| {
            sentinel
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".devhub-cloning"))
                .map(|n| sentinel.with_file_name(n))
        });
    let Some(target) = target else {
        report.errors += 1;
        return;
    };

    // Only ever reclaim a directory the sweep itself found under a configured
    // root; a sentinel is a text file, and a hand-edited one must not name
    // `C:\Windows`.
    let inside_root = target
        .canonicalize()
        .ok()
        .and_then(|t| root.canonicalize().ok().map(|r| t.starts_with(r)))
        .unwrap_or(false);

    if target.is_dir() && inside_root && !target.join(".devhub.json").is_file() {
        match trash_dir(&target) {
            Ok(()) => report.partials_trashed += 1,
            Err(_) => {
                // The sentinel stays, so the next startup tries again.
                report.errors += 1;
                return;
            }
        }
    } else if target.is_dir() {
        // A marked clone is a real repository; only the stale sentinel goes.
        report.sentinels_removed += 1;
    } else {
        report.sentinels_removed += 1;
    }
    if std::fs::remove_file(sentinel).is_err() {
        report.errors += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "devhub-sweep-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn age(path: &Path, secs: u64) {
        let when = SystemTime::now() - Duration::from_secs(secs);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn temp_names_are_matched_precisely() {
        assert!(is_atomic_temp("devhub-config.json.tmp.1234.7"));
        assert!(is_atomic_temp(".devhub.json.tmp.1.0"));
        assert!(!is_atomic_temp("notes.tmp.txt"));
        assert!(!is_atomic_temp("notes.tmp.1"));
        assert!(!is_atomic_temp("notes.tmp.x.1"));
        assert!(is_app_atomic_temp(".devhub-index.json.tmp.1234.7"));
        assert!(is_app_atomic_temp("devhub-activity.jsonl.tmp.1.0"));
        assert!(!is_app_atomic_temp("notes.tmp.1234.7"), "a user file with the same shape is not ours");
        assert!(is_cover_temp("owner_repo.png.part"));
        assert!(is_cover_temp("owner_repo.PNG.HEADERS"));
        assert!(!is_cover_temp("owner_repo.png"));
        assert!(is_sentinel("repo.devhub-cloning"));
    }

    #[test]
    fn staleness_has_one_boundary() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!is_stale(now - STALE_AFTER + Duration::from_secs(1), now));
        assert!(is_stale(now - STALE_AFTER, now));
    }

    #[test]
    fn old_app_temp_files_go_and_fresh_or_user_ones_stay() {
        let root = scratch("temps");
        let old = root.join(".devhub-index.json.tmp.1.2");
        let fresh = root.join(".devhub-index.json.tmp.3.4");
        let user_old = root.join("notes.tmp.5.6");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"y").unwrap();
        std::fs::write(&user_old, b"user data").unwrap();
        age(&old, 48 * 3600);
        age(&user_old, 48 * 3600);

        let report = sweep_with(&[root.clone()], &root, SystemTime::now(), &mut |_| Ok(()));
        assert_eq!(report.temps_removed, 1);
        assert!(!old.exists(), "an old app-owned atomic temp is residue");
        assert!(fresh.exists(), "a temp file inside the age window may be live");
        assert!(user_old.exists(), "a user file with the temp shape is not residue");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cover_residue_is_only_swept_inside_the_cover_cache() {
        let root = scratch("covers");
        let cover_dir = root.join("cache").join("covers");
        std::fs::create_dir_all(&cover_dir).unwrap();
        let app_cover = cover_dir.join("owner_repo.png.part");
        let user_part = root.join("notes.png.part");
        std::fs::write(&app_cover, b"x").unwrap();
        std::fs::write(&user_part, b"y").unwrap();
        age(&app_cover, 48 * 3600);
        age(&user_part, 48 * 3600);

        let report = sweep_with(&[root.clone()], &root, SystemTime::now(), &mut |_| Ok(()));
        assert_eq!(report.temps_removed, 1);
        assert!(!app_cover.exists());
        assert!(user_part.exists(), "a .png.part outside cache/covers is not ours");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unmarked_interrupted_landing_dir_is_trashed_but_a_marked_one_is_not() {
        let root = scratch("partials");
        let unmarked = root.join("owner").join("half_clone");
        let marked = root.join("owner").join("real_repo");
        std::fs::create_dir_all(unmarked.join(".git")).unwrap();
        std::fs::create_dir_all(&marked).unwrap();
        std::fs::write(marked.join(".devhub.json"), b"{}").unwrap();
        let sentinel_a = sentinel_path(&unmarked);
        let sentinel_b = sentinel_path(&marked);
        std::fs::write(&sentinel_a, unmarked.to_string_lossy().as_bytes()).unwrap();
        std::fs::write(&sentinel_b, marked.to_string_lossy().as_bytes()).unwrap();
        age(&sentinel_a, 48 * 3600);
        age(&sentinel_b, 48 * 3600);

        let mut trashed: Vec<PathBuf> = Vec::new();
        let report = sweep_with(&[root.clone()], &root, SystemTime::now(), &mut |p| {
            trashed.push(p.to_path_buf());
            std::fs::remove_dir_all(p).map_err(|e| e.to_string())
        });
        assert_eq!(report.partials_trashed, 1);
        assert_eq!(trashed, vec![unmarked.clone()]);
        assert!(!unmarked.exists());
        assert!(marked.is_dir(), "a real clone is never removed");
        assert!(report.sentinels_removed >= 1);
        assert!(!sentinel_a.exists());
        assert!(!sentinel_b.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sentinel_pointing_outside_the_root_does_not_trash_anything() {
        let root = scratch("outside");
        let victim = scratch("victim");
        let sentinel = root.join("escape.devhub-cloning");
        std::fs::write(&sentinel, victim.to_string_lossy().as_bytes()).unwrap();
        age(&sentinel, 48 * 3600);

        let report = sweep_with(&[root.clone()], &root, SystemTime::now(), &mut |_| {
            panic!("a sentinel outside the root must never reach the trash callback")
        });
        assert_eq!(report.partials_trashed, 0);
        assert!(victim.is_dir());
        assert!(!sentinel.exists(), "the unconsumable sentinel is still cleared");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&victim);
    }

    #[test]
    fn the_guard_removes_its_sentinel_on_drop() {
        let root = scratch("guard");
        let target = root.join("repo_owner");
        {
            let _guard = CloneSentinel::start(&target).expect("sentinel");
            assert!(sentinel_path(&target).is_file());
        }
        assert!(!sentinel_path(&target).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
