//! Per-repository local metadata for the 项目墙 (round 9, 需求 1).
//!
//! The wall used to answer "what is this repository" from five identity fields
//! (`host/owner/repo/local/path`) and nothing else, so a card could not say how
//! big a project is, when it landed, what language it is written in, or whether
//! it carries build artefacts. Those four facts are all derivable from the clone
//! itself, which is what this module computes - **locally, with no network
//! call**, because a wall of 40 cards issuing 40 GitHub requests to label
//! themselves is both slow and rate-limited.
//!
//! ## Why a separate command from `list_repositories`
//!
//! A size walk is I/O-bound and takes seconds on a container that also holds
//! build trees (the same measurement `repo_index` documents: 86 s cold for a
//! full walk). The wall must paint before that finishes, so `list_repositories`
//! stays cheap and the frontend asks for metadata afterwards, tile by tile as
//! the answers arrive.
//!
//! ## Why an in-process cache, and what it is honest about
//!
//! Re-walking every repository on every ask is the cost this cache exists to
//! avoid. It is keyed on each repository directory's **own mtime** plus a
//! ten-minute age, and `force` (the 刷新 path) recomputes everything. What that
//! means in practice: editing a file *inside* a subdirectory does not move the
//! root's mtime, so a size can be up to ten minutes stale - or until a refresh.
//! That is a deliberate trade: the alternative (a full walk per read) is what
//! made the pre-index app feel slow, and a wrong-by-ten-minutes size is a
//! smaller lie than a wall that takes a second to appear.
//!
//! ## Language and category
//!
//! Both come from marker files, in one fixed priority order
//! ([`MARKERS`]). A repository that matches two ecosystems (a Tauri app has
//! both `Cargo.toml` and `package.json`) is labelled by the higher-priority
//! marker and says so nowhere - the card shows one language, not a taxonomy.
//! This is the honest ceiling of local derivation; a per-file line count would
//! be a different, much more expensive answer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// One repository's locally-derived facts, mirrored in `src/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMeta {
    /// Canonical `host/owner/repo`, the key the frontend joins on.
    pub slug: String,
    /// Directory creation time in unix milliseconds; 0 when the filesystem
    /// will not say (some network mounts refuse `created()`).
    pub installed_at: i64,
    /// Recursive size in bytes. Symlinks and junctions are not followed, so a
    /// link loop cannot hang the walk and a linked tree is counted once.
    pub size_bytes: u64,
    /// Primary language when a marker names one, e.g. `Rust`.
    pub language: Option<String>,
    /// Project type id, one of the [`MARKERS`] ids or `unknown`.
    pub category: String,
    /// Whether clearable artefacts exist - the same set 缓存清理 measures,
    /// answered by [`crate::launch::has_cache`] so the two cannot drift.
    pub has_cache: bool,
}

impl RepoMeta {
    /// What a repository that is not on disk (a parsed-only ref) reports.
    fn unknown(slug: &str) -> Self {
        RepoMeta {
            slug: slug.to_string(),
            installed_at: 0,
            size_bytes: 0,
            language: None,
            category: "unknown".to_string(),
            has_cache: false,
        }
    }
}

/// Marker files in priority order: the first one present decides.
///
/// `category` is the id the frontend maps to a label; `language` is what the
/// card shows. They differ only where one ecosystem has two common languages
/// (node) or no language at all (static).
const MARKERS: &[(&str, &str, &str)] = &[
    // (marker file, category id, language)
    ("Cargo.toml", "rust", "Rust"),
    ("go.mod", "go", "Go"),
    ("pyproject.toml", "python", "Python"),
    ("setup.py", "python", "Python"),
    ("requirements.txt", "python", "Python"),
    ("pom.xml", "java", "Java"),
    ("build.gradle", "java", "Java"),
    ("build.gradle.kts", "java", "Java"),
    ("settings.gradle", "java", "Java"),
    ("settings.gradle.kts", "java", "Java"),
    ("pubspec.yaml", "dart", "Dart"),
    ("composer.json", "php", "PHP"),
    ("Gemfile", "ruby", "Ruby"),
    ("package.json", "node", "JavaScript"),
    ("index.html", "static", "HTML"),
];

/// The two marker files `package.json` alone cannot answer: a `tsconfig.json`
/// beside it means TypeScript, its absence means plain JavaScript.
const TS_MARKER: &str = "tsconfig.json";

/// `*.sln` / `*.csproj` cannot be named literally - the file carries the
/// project's name - so they are matched by extension over the root directory.
const DOTNET_EXTS: &[&str] = &["sln", "csproj", "fsproj"];

/// Reads one marker decision off a repository root.
fn detect(path: &Path) -> (Option<String>, String) {
    for (marker, category, language) in MARKERS {
        if path.join(marker).is_file() {
            // node is the one ecosystem whose language the marker cannot name.
            if *marker == "package.json" && path.join(TS_MARKER).is_file() {
                return (Some("TypeScript".to_string()), "node".to_string());
            }
            return (Some((*language).to_string()), (*category).to_string());
        }
    }
    if has_dotnet_project(path) {
        return (Some("C#".to_string()), "dotnet".to_string());
    }
    (None, "unknown".to_string())
}

fn has_dotnet_project(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .map(|x| DOTNET_EXTS.iter().any(|want| x.eq_ignore_ascii_case(want)))
            .unwrap_or(false)
    })
}

/// Directory creation time in unix ms, falling back to mtime.
///
/// `created()` is not implemented everywhere (it returns an error on some
/// network filesystems), and a repository cloned by copying a directory keeps
/// the copy's mtime - so 0 means "unknown", never "the epoch".
fn installed_at(path: &Path) -> i64 {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    let stamp = meta.created().ok().or_else(|| meta.modified().ok());
    match stamp.and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
        Some(d) => d.as_millis() as i64,
        None => 0,
    }
}

/// Recursive byte count. Symlinks are skipped rather than followed.
fn dir_size(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            // `file_type()` from read_dir does not follow the link, which is
            // what keeps a junction cycle from looping forever.
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            // A Windows junction is `is_dir()` but not `is_symlink()`; without
            // this guard a repository that links a shared node_modules (or an
            // ancestor) would count another tree's bytes or loop forever.
            if crate::disk::is_reparse_point(&e.path()) {
                continue;
            }
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// A computed answer, and the two things that decide whether to trust it.
struct Cached {
    meta: RepoMeta,
    computed_at: Instant,
    /// The root directory's mtime when this was computed.
    root_mtime: Option<SystemTime>,
}

/// How long a computed answer is trusted even if nothing changed on disk.
const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

/// How many repositories' metadata the process may hold (r20-O2-4).
///
/// Found by the `rust-cache-bounds` row, not by a bug report: this map had a 600-second
/// `MAX_AGE` that was only ever consulted on read, so a session that walked a large
/// container kept every `RepoMeta` it had ever computed — including a `dir_size` walk
/// result per entry — until the process exited. 512 is more repositories than the wall
/// has ever been measured with here (13 in `--scan-check`), and one entry is a handful
/// of strings, so the bound costs nothing and stops an unbounded growth path.
const CACHE_CAP: usize = 512;

static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Cached>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn root_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

/// The metadata for one repository, from cache when the cache is still true.
///
/// `path` is `None` for a ref that was only parsed (never on disk); that gets
/// [`RepoMeta::unknown`] rather than a zero that reads as "empty repository".
pub fn cached(slug: &str, path: Option<&Path>, force: bool) -> RepoMeta {
    let Some(path) = path else {
        return RepoMeta::unknown(slug);
    };
    let path: PathBuf = path.to_path_buf();

    if !force {
        let mtime = root_mtime(&path);
        if let Ok(c) = CACHE.lock() {
            if let Some(hit) = c.get(slug) {
                let fresh = hit.computed_at.elapsed() < MAX_AGE;
                let same_dir = match (&hit.root_mtime, &mtime) {
                    (Some(a), Some(b)) => a == b,
                    // An unreadable mtime is not evidence of change, but it is
                    // not evidence of sameness either - recompute.
                    _ => false,
                };
                if fresh && same_dir {
                    return hit.meta.clone();
                }
            }
        }
    }

    let (language, category) = detect(&path);
    let meta = RepoMeta {
        slug: slug.to_string(),
        installed_at: installed_at(&path),
        size_bytes: dir_size(&path),
        language,
        category,
        has_cache: crate::launch::has_cache(&path),
    };
    if let Ok(mut c) = CACHE.lock() {
        // Expired entries leave on write, not on read — the rule `cache.rs` states for
        // the two maps in `lib.rs`, applied here against `MAX_AGE`.
        c.retain(|_, cached| cached.computed_at.elapsed() < MAX_AGE);
        if c.len() >= CACHE_CAP {
            let mut ordered: Vec<(Instant, String)> =
                c.iter().map(|(k, v)| (v.computed_at, k.clone())).collect();
            ordered.sort_by_key(|(at, _)| *at);
            for (_, k) in ordered.into_iter().take(c.len() - CACHE_CAP + 1) {
                c.remove(&k);
            }
        }
        c.insert(
            slug.to_string(),
            Cached {
                meta: meta.clone(),
                computed_at: Instant::now(),
                root_mtime: root_mtime(&path),
            },
        );
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("devhub-meta-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn markers_name_language_and_category() {
        let d = scratch("markers");
        std::fs::write(d.join("Cargo.toml"), "[package]\n").unwrap();
        assert_eq!(detect(&d), (Some("Rust".to_string()), "rust".to_string()));

        let ts = scratch("markers-ts");
        std::fs::write(ts.join("package.json"), "{}").unwrap();
        std::fs::write(ts.join("tsconfig.json"), "{}").unwrap();
        assert_eq!(
            detect(&ts),
            (Some("TypeScript".to_string()), "node".to_string())
        );

        let js = scratch("markers-js");
        std::fs::write(js.join("package.json"), "{}").unwrap();
        assert_eq!(
            detect(&js),
            (Some("JavaScript".to_string()), "node".to_string())
        );

        let py = scratch("markers-py");
        std::fs::write(py.join("pyproject.toml"), "").unwrap();
        assert_eq!(
            detect(&py),
            (Some("Python".to_string()), "python".to_string())
        );

        let none = scratch("markers-none");
        std::fs::write(none.join("README.md"), "hi").unwrap();
        assert_eq!(detect(&none), (None, "unknown".to_string()));

        for d in [&d, &ts, &js, &py, &none] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn dotnet_projects_are_matched_by_extension() {
        let d = scratch("dotnet");
        std::fs::write(d.join("App.csproj"), "<Project/>").unwrap();
        assert_eq!(
            detect(&d),
            (Some("C#".to_string()), "dotnet".to_string())
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_higher_priority_marker_wins_a_multi_ecosystem_repo() {
        // A Tauri app has both; the card says Rust and that is the documented
        // ceiling of local derivation, not a bug.
        let d = scratch("multi");
        std::fs::write(d.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(d.join("package.json"), "{}").unwrap();
        assert_eq!(detect(&d), (Some("Rust".to_string()), "rust".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn size_counts_files_and_skips_symlinks() {
        let d = scratch("size");
        std::fs::write(d.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size(&d), 150);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.join("a.bin"), d.join("link")).unwrap();
            assert_eq!(dir_size(&d), 150, "a symlink must not be followed");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn installed_at_is_a_real_timestamp_for_a_real_directory() {
        let d = scratch("installed");
        let at = installed_at(&d);
        assert!(at > 1_700_000_000_000, "got {at}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_ref_without_a_path_is_unknown_not_empty() {
        let m = cached("github.com/a/b", None, false);
        assert_eq!(m.category, "unknown");
        assert_eq!(m.size_bytes, 0);
        assert!(m.language.is_none());
        assert_eq!(m.slug, "github.com/a/b");
    }

    #[test]
    fn the_cache_recomputes_after_the_directory_changes() {
        let d = scratch("cache");
        // Cargo.toml is 10 bytes and counts: `dir_size` measures the whole
        // directory, marker files included.
        std::fs::write(d.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(d.join("a.bin"), vec![0u8; 10]).unwrap();
        let slug = "github.com/a/b";

        let first = cached(slug, Some(&d), false);
        assert_eq!(first.size_bytes, 20);
        let again = cached(slug, Some(&d), false);
        assert_eq!(again.size_bytes, 20, "an unchanged directory is a cache hit");

        // Writing into the directory moves its own mtime, which is the signal.
        // Windows/CI can stamp the directory twice inside one clock tick, so wait
        // past the coarsest observed granularity; otherwise this is a race.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(d.join("b.bin"), vec![0u8; 5]).unwrap();
        let after = cached(slug, Some(&d), false);
        assert_eq!(after.size_bytes, 25, "a changed directory recomputes");

        let forced = cached(slug, Some(&d), true);
        assert_eq!(forced.size_bytes, 25);
        let _ = std::fs::remove_dir_all(&d);
    }
}
