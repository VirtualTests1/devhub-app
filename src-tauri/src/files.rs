//! Bounded, read-only repository file listing (r22-N2).
//!
//! The README dialog answers "what does this project say"; the grep dialog answers
//! "where does this string appear". Neither helps when the question is "what is in
//! this repository" — the file dialog's job. It walks the clone with the same
//! ignore table `searchgrep.rs` uses (so the two views cannot disagree about what
//! counts as source), never follows symlinks, and stops at both a depth and an
//! entry cap so a 200k-file checkout cannot freeze the webview.
//!
//! The walk is pure and tested against a scratch tree; the command only adds the
//! `path_guard` check and the blocking-pool hop.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::path_guard;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    /// Repository-relative, forward slashes regardless of the host separator.
    pub(crate) path: String,
    /// `file` | `dir`.
    pub(crate) kind: String,
    /// Bytes for files; `None` for directories.
    pub(crate) size: Option<u64>,
    pub(crate) depth: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoFiles {
    pub(crate) root: String,
    pub(crate) max_depth: usize,
    pub(crate) max_entries: usize,
    pub(crate) entries: Vec<FileEntry>,
    pub(crate) count: usize,
    pub(crate) truncated: bool,
    pub(crate) depth_limit_reached: bool,
    /// Directories that could not be read, with the OS reason.
    pub(crate) unreadable: Vec<String>,
    /// Ignored directory names actually encountered (so the UI can say what it hid).
    pub(crate) ignored: Vec<String>,
}

/// One walk. `max_depth` counts the root's direct children as depth 1. The entry
/// cap is checked before every push, so `entries.len() == max_entries` with
/// `truncated == true` means "there was at least one more".
pub(crate) fn walk(root: &Path, max_depth: usize, max_entries: usize) -> RepoFiles {
    let mut entries = Vec::new();
    let mut unreadable = Vec::new();
    let mut ignored = std::collections::BTreeSet::new();
    let mut truncated = false;
    let mut depth_limit_reached = false;

    fn visit(
        dir: &Path,
        rel: &str,
        depth: usize,
        max_depth: usize,
        max_entries: usize,
        entries: &mut Vec<FileEntry>,
        unreadable: &mut Vec<String>,
        ignored: &mut std::collections::BTreeSet<String>,
        truncated: &mut bool,
        depth_limit_reached: &mut bool,
    ) {
        if *truncated {
            return;
        }
        let mut names: Vec<String> = match std::fs::read_dir(dir) {
            Ok(rd) => {
                let mut v = Vec::new();
                for entry in rd.flatten() {
                    v.push(entry.file_name().to_string_lossy().to_string());
                }
                v
            }
            Err(e) => {
                unreadable.push(format!("{}: {e}", if rel.is_empty() { "." } else { rel }));
                return;
            }
        };
        names.sort();
        for name in names {
            if entries.len() >= max_entries {
                *truncated = true;
                return;
            }
            let path = dir.join(&name);
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    unreadable.push(format!("{rel_path}: {e}"));
                    continue;
                }
            };
            // A junction/symlink is not followed: its target may be outside the
            // repository, and listing it would leak another tree into this one.
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if crate::searchgrep::IGNORE_DIRS.contains(&name.as_str()) {
                    ignored.insert(name);
                    continue;
                }
                entries.push(FileEntry {
                    path: rel_path.clone(),
                    kind: "dir".to_string(),
                    size: None,
                    depth,
                });
                if depth < max_depth {
                    visit(
                        &path,
                        &rel_path,
                        depth + 1,
                        max_depth,
                        max_entries,
                        entries,
                        unreadable,
                        ignored,
                        truncated,
                        depth_limit_reached,
                    );
                } else {
                    *depth_limit_reached = true;
                }
            } else if meta.is_file() {
                entries.push(FileEntry {
                    path: rel_path,
                    kind: "file".to_string(),
                    size: Some(meta.len()),
                    depth,
                });
            }
        }
    }

    visit(
        root,
        "",
        1,
        max_depth,
        max_entries,
        &mut entries,
        &mut unreadable,
        &mut ignored,
        &mut truncated,
        &mut depth_limit_reached,
    );
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    RepoFiles {
        root: root.to_string_lossy().to_string(),
        max_depth,
        max_entries,
        count: entries.len(),
        entries,
        truncated,
        depth_limit_reached,
        unreadable,
        ignored: ignored.into_iter().collect(),
    }
}

/// Cap the page-supplied numbers. `0` is treated as "use the default" rather than
/// "return nothing": the UI sends `null` for default, and a zero that slipped
/// through should not look like an empty repository.
fn clamp(raw: Option<usize>, default: usize, min: usize, max: usize) -> usize {
    raw.filter(|n| *n >= min).unwrap_or(default).min(max)
}

#[tauri::command]
pub(crate) async fn repo_files(
    app: tauri::AppHandle,
    root: String,
    max_depth: Option<usize>,
    max_entries: Option<usize>,
) -> Result<RepoFiles, String> {
    let max_depth = clamp(max_depth, 4, 1, 8);
    let max_entries = clamp(max_entries, 300, 1, 500);
    let guarded: PathBuf = path_guard::guard(&app, &root, path_guard::Access::Read)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !guarded.is_dir() {
            return Err(format!("目录不存在：{}", guarded.display()));
        }
        Ok(walk(&guarded, max_depth, max_entries))
    })
    .await
    .map_err(|e| format!("文件清单任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("devhub-files-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_files_and_directories_with_relative_posix_paths() {
        let s = Scratch::new("basic");
        std::fs::create_dir_all(s.0.join("src/lib")).unwrap();
        std::fs::write(s.0.join("src/main.ts"), b"main").unwrap();
        std::fs::write(s.0.join("src/lib/util.ts"), b"util!").unwrap();
        std::fs::write(s.0.join("README.md"), b"hi").unwrap();
        let out = walk(&s.0, 4, 100);
        let paths: Vec<&str> = out.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/main.ts"));
        assert!(paths.contains(&"src/lib/util.ts"));
        assert!(paths.contains(&"README.md"));
        assert_eq!(out.count, out.entries.len());
        assert!(!out.truncated);
        assert!(!out.depth_limit_reached);
        let readme = out.entries.iter().find(|e| e.path == "README.md").unwrap();
        assert_eq!(readme.kind, "file");
        assert_eq!(readme.size, Some(2));
    }

    #[test]
    fn ignored_directories_are_not_listed_but_are_reported() {
        let s = Scratch::new("ignore");
        std::fs::create_dir_all(s.0.join("node_modules/pkg")).unwrap();
        std::fs::write(s.0.join("node_modules/pkg/index.js"), b"x").unwrap();
        std::fs::write(s.0.join("index.js"), b"y").unwrap();
        let out = walk(&s.0, 4, 100);
        assert!(out.entries.iter().all(|e| !e.path.starts_with("node_modules")));
        assert_eq!(out.ignored, vec!["node_modules".to_string()]);
        assert!(out.entries.iter().any(|e| e.path == "index.js"));
    }

    #[test]
    fn the_entry_cap_truncates_and_says_so() {
        let s = Scratch::new("cap");
        for i in 0..10 {
            std::fs::write(s.0.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let out = walk(&s.0, 4, 3);
        assert_eq!(out.count, 3);
        assert!(out.truncated);
    }

    #[test]
    fn the_depth_cap_stops_descent_without_losing_the_directory_entry() {
        let s = Scratch::new("depth");
        std::fs::create_dir_all(s.0.join("a/b/c")).unwrap();
        std::fs::write(s.0.join("a/b/c/leaf.txt"), b"x").unwrap();
        let shallow = walk(&s.0, 2, 100);
        assert!(shallow.entries.iter().any(|e| e.path == "a/b"));
        assert!(shallow.entries.iter().all(|e| e.path != "a/b/c/leaf.txt"));
        assert!(shallow.depth_limit_reached);
        let deep = walk(&s.0, 8, 100);
        assert!(deep.entries.iter().any(|e| e.path == "a/b/c/leaf.txt"));
    }

    #[test]
    fn clamp_keeps_ui_inputs_inside_the_documented_bounds() {
        assert_eq!(clamp(None, 4, 1, 8), 4);
        assert_eq!(clamp(Some(0), 4, 1, 8), 4, "0 means default, not empty");
        assert_eq!(clamp(Some(99), 4, 1, 8), 8);
        assert_eq!(clamp(Some(1), 300, 1, 500), 1);
    }
}
