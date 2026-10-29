//! Per-repository storage breakdown (r28-N4).
//!
//! The wall's metadata already shows one total size; this command splits it into
//! the three places a person can act on: the clone itself (including clearable
//! build artefacts), the external venv, and worktree copies. It is read-only and
//! walks the same directories the delete/clear verbs own, so the numbers cannot
//! describe a different set of files from the actions.

use super::*;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    pub total_bytes: u64,
    pub repo_bytes: u64,
    pub cache_bytes: u64,
    pub venv_bytes: u64,
    pub worktrees_bytes: u64,
}

/// The pure calculation, split from the command so a temp-directory test can
/// cover the four buckets without registering a repository in the wall index.
pub(crate) fn breakdown_for(repo: &Path, root: &Path) -> StorageBreakdown {
    let repo_bytes = launch::dir_size(repo);
    let cache_bytes = launch::scan_cache(repo).total_bytes;
    let venv_bytes = downloader::venv_expected_dir(root, repo)
        .map(|p| launch::dir_size(&p))
        .unwrap_or(0);
    let slug = downloader::read_marker(repo)
        .map(|m| m.slug)
        .filter(|s| !s.is_empty())
        .or_else(|| repo.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_default();
    let worktrees_bytes = crate::gitwt::worktree_copies_on_disk(root, &slug)
        .iter()
        .map(|p| launch::dir_size(p))
        .sum();
    StorageBreakdown {
        total_bytes: repo_bytes + venv_bytes + worktrees_bytes,
        repo_bytes,
        cache_bytes,
        venv_bytes,
        worktrees_bytes,
    }
}

#[tauri::command]
pub async fn repo_storage_breakdown(slug: String) -> Result<StorageBreakdown, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;
        Ok(breakdown_for(&repo, &project_root()))
    })
    .await
    .map_err(|e| format!("存储统计任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breakdown_splits_repo_venv_and_worktree_copies() {
        let root = std::env::temp_dir().join(format!("devhub-storage-{}", std::process::id()));
        let repo = root.join("repos").join("demo_owner");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(repo.join("node_modules")).unwrap();
        std::fs::write(repo.join("a.txt"), b"1234567890").unwrap();
        std::fs::write(repo.join("node_modules").join("x.js"), b"12345").unwrap();
        let venv = root.join("venvs").join("demo_owner");
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), b"abc").unwrap();
        let wt = root.join("_worktrees").join("demo_owner__feature");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("b.txt"), b"12").unwrap();

        let b = breakdown_for(&repo, &root);
        assert_eq!(b.repo_bytes, 15);
        assert_eq!(b.cache_bytes, 5);
        assert_eq!(b.venv_bytes, 3);
        assert_eq!(b.worktrees_bytes, 2);
        assert_eq!(b.total_bytes, 20);
        let _ = std::fs::remove_dir_all(&root);
    }
}
