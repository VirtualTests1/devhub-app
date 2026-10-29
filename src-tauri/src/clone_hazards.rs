//! Post-clone integrity warnings (r30-R1).
//!
//! A successful `git clone` is not always a complete working tree. Two shapes
//! are common and both look like success:
//!
//!   * **Git LFS**: the clone checks out the pointer file, not the object. That
//!     is correct if and only if a smudge filter fetched the object; without
//!     `git-lfs` the file on disk is a 130-byte pointer, and every later build
//!     reads nonsense.
//!   * **Submodules**: `git clone` does not initialise them. The directory is
//!     empty until `git submodule update --init`, which this app does not run.
//!
//! Running either fetch automatically is a separate decision with its own
//! network and credential costs; the app does not do it (see
//! `docs/research/lfs-submodules.md`). What it can do honestly is say what it
//! found. Detection is deliberately bounded: only repositories whose root
//! `.gitattributes` declares an LFS filter are scanned, at most 500 tracked
//! files are inspected for the pointer header, and a failure to list files is
//! reported as "unknown" rather than "no pointers".
//!
//! This is a warning layer, not a blocker: the repository is usable, and a
//! user who knows their project may not need either fetch.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneHazards {
    /// Tracked files whose first bytes are the Git LFS pointer header.
    pub lfs_pointers: u32,
    /// `.gitmodules` declares at least one submodule.
    pub submodules: bool,
    /// The LFS configuration exists but listing/inspection could not complete.
    /// The UI may say "not verified" but must not say "no pointers".
    pub lfs_unchecked: bool,
}

/// How many tracked files one clone may inspect. A pointer is ~130 bytes, so
/// 500 reads is a few milliseconds even on a slow volume; an LFS repository
/// with more files than this still gets a warning when any inspected file is a
/// pointer, and the bound keeps a 100k-file clone from turning a warning into a
/// second download.
const LFS_SCAN_LIMIT: usize = 500;

/// How many bytes of a file are enough to recognise the pointer header.
const POINTER_PREFIX_BYTES: usize = 160;

const POINTER_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1";

/// Does this `.gitattributes` text declare an LFS filter?
///
/// Matches the three spellings Git's own documentation uses (`filter=lfs`,
/// `diff=lfs`, `merge=lfs`). The file is untrusted repository content; a
/// false positive only costs a bounded scan.
pub fn declares_lfs(attributes: &str) -> bool {
    attributes.to_ascii_lowercase().contains("filter=lfs")
        || attributes.to_ascii_lowercase().contains("diff=lfs")
        || attributes.to_ascii_lowercase().contains("merge=lfs")
}

/// Does `.gitmodules` declare at least one submodule?
pub fn has_submodule_entries(text: &str) -> bool {
    text.lines().any(|line| {
        let one = line.trim_start().to_ascii_lowercase();
        one.starts_with("[submodule") && one.contains('"')
    })
}

pub fn is_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(POINTER_PREFIX)
}

fn read_prefix(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; POINTER_PREFIX_BYTES];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(buf)
}

/// A git-listed path must stay inside the repository. `git ls-files` reports
/// relative paths, but the output is still treated as input from the repository:
/// an absolute path or a `..` segment is refused before any read.
fn contained(repo: &Path, rel: &str) -> Option<PathBuf> {
    let path = Path::new(rel);
    if path.is_absolute() {
        return None;
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(repo.join(path))
}

/// Bounded `git ls-files -z`; `None` when git could not answer in time.
fn tracked_files(git: &Path, repo: &Path) -> Option<Vec<String>> {
    let mut cmd = crate::downloader::git_cmd(git);
    cmd.args(["-C"]).arg(repo).args(["ls-files", "-z"]);
    let output = match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(8)) {
        Ok(Some(output)) => output,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let bytes = output.stdout;
    let mut out = Vec::new();
    for chunk in bytes.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        match std::str::from_utf8(chunk) {
            Ok(text) => out.push(text.to_string()),
            Err(_) => return None,
        }
        if out.len() >= LFS_SCAN_LIMIT {
            break;
        }
    }
    Some(out)
}

/// Inspect a freshly cloned repository. Never fails: an unreadable config is
/// "nothing detected", and an LFS scan that cannot list files is `lfs_unchecked`.
pub fn detect(git: &Path, repo: &Path) -> CloneHazards {
    let attributes = std::fs::read_to_string(repo.join(".gitattributes")).unwrap_or_default();
    let configured = declares_lfs(&attributes);
    let submodules = std::fs::read_to_string(repo.join(".gitmodules"))
        .map(|text| has_submodule_entries(&text))
        .unwrap_or(false);

    let mut hazards = CloneHazards {
        lfs_pointers: 0,
        submodules,
        lfs_unchecked: false,
    };
    if !configured {
        return hazards;
    }
    let Some(files) = tracked_files(git, repo) else {
        hazards.lfs_unchecked = true;
        return hazards;
    };
    for rel in files {
        let Some(path) = contained(repo, &rel) else {
            hazards.lfs_unchecked = true;
            continue;
        };
        if read_prefix(&path).is_some_and(|bytes| is_lfs_pointer(&bytes)) {
            hazards.lfs_pointers = hazards.lfs_pointers.saturating_add(1);
        }
    }
    hazards
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lfs_declarations_are_recognised_case_insensitively() {
        assert!(declares_lfs("*.bin filter=lfs diff=lfs merge=lfs -text"));
        assert!(declares_lfs("*.png FILTER=LFS"));
        assert!(declares_lfs("*.zip diff=LFS"));
        assert!(!declares_lfs("*.md text eol=lf"));
        assert!(!declares_lfs(""));
    }

    #[test]
    fn submodule_entries_need_the_section_and_a_name() {
        assert!(has_submodule_entries("[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n"));
        assert!(!has_submodule_entries(""));
        assert!(!has_submodule_entries("[core]\n\trepositoryformatversion = 0\n"));
        assert!(!has_submodule_entries("[submodule]\n"));
    }

    #[test]
    fn only_the_pointer_header_counts() {
        assert!(is_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n"
        ));
        assert!(!is_lfs_pointer(b"version 1.2.3\n"));
        assert!(!is_lfs_pointer(b""));
    }

    #[test]
    fn a_relative_path_outside_the_repository_is_refused() {
        let root = Path::new("C:\\projects\\repo");
        assert!(contained(root, "src/main.rs").is_some());
        assert!(contained(root, "../escape").is_none());
        assert!(contained(root, "C:\\Windows\\win.ini").is_none());
    }

    #[test]
    fn a_missing_repository_reports_nothing_instead_of_panicking() {
        let hazards = detect(Path::new("git"), Path::new("Q:\\devhub-r30-missing"));
        assert_eq!(
            hazards,
            CloneHazards {
                lfs_pointers: 0,
                submodules: false,
                lfs_unchecked: false,
            }
        );
    }

    #[test]
    fn a_fixture_repository_reports_pointer_files_and_submodules() {
        let Some(gh) = crate::downloader::find_git(None) else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("devhub-hazards-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("fixture repo");
        let git = Path::new(&gh.path);
        let init = crate::proc::silent(git)
            .args(["-C"])
            .arg(&repo)
            .args(["init", "-q"])
            .status()
            .expect("git init");
        assert!(init.success(), "git init failed");
        std::fs::write(repo.join(".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
            .expect("attributes");
        std::fs::write(
            repo.join("blob.bin"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 12\n",
        )
        .expect("pointer");
        std::fs::write(
            repo.join(".gitmodules"),
            "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = https://example.invalid/lib.git\n",
        )
        .expect("gitmodules");
        let add = crate::proc::silent(git)
            .args(["-C"])
            .arg(&repo)
            .args(["add", "-A"])
            .status()
            .expect("git add");
        assert!(add.success(), "git add failed");

        let hazards = detect(git, &repo);
        assert_eq!(hazards.lfs_pointers, 1);
        assert!(hazards.submodules);
        assert!(!hazards.lfs_unchecked);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
