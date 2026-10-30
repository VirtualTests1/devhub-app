//! Local repository health overview (r34-D5).
//!
//! The per-repository 诊断 dialog asks many probes (network freshness, ports,
//! dependencies) and is the right tool for one repository. This module answers the
//! collection-level question: **which of my clones are unhealthy right now**, using
//! only local facts - marker state, `.git` presence, working-tree dirt, detached
//! HEAD, upstream, recorded venv, README and a confirmed launch command.
//!
//! No network, no process spawn beyond one bounded `git status --porcelain=v2` per
//! repository. The batch is capped at [`MAX_HEALTH_REPOS`] and every cap is
//! reported; a repository that could not be read is a row with an error issue, not
//! a silent omission.
//!
//! The git command is read-only. `--porcelain=v2 --branch` returns the branch,
//! upstream and dirty entries in one process, which is why this does not run
//! `status`, `symbolic-ref` and `rev-parse` separately.

use serde::Serialize;
use std::path::Path;

const MAX_HEALTH_REPOS: usize = 200;
const GIT_STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthIssue {
    /// Stable machine code (`marker`, `no-git`, `dirty`, ...). The UI maps it.
    pub code: String,
    /// `error` | `warn` | `info`.
    pub severity: String,
    /// A short human detail where the code alone is not enough.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthRow {
    pub slug: String,
    pub path: String,
    pub marker_state: String,
    pub has_git: bool,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub dirty: usize,
    pub has_readme: bool,
    pub has_launch: bool,
    pub venv_state: String,
    pub issues: Vec<HealthIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthOverview {
    pub rows: Vec<HealthRow>,
    pub scanned: usize,
    pub capped: bool,
    pub elapsed_ms: u128,
}

fn issue(code: &str, severity: &str, detail: Option<String>) -> HealthIssue {
    HealthIssue {
        code: code.to_string(),
        severity: severity.to_string(),
        detail,
    }
}

/// What `git status --porcelain=v2 --branch` says, parsed in one pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusFacts {
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    /// Number of changed/untracked entries (header lines are not entries).
    pub dirty: usize,
}

pub fn parse_status_v2(text: &str) -> StatusFacts {
    let mut facts = StatusFacts::default();
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            if head.trim() == "(detached)" {
                facts.detached = true;
            } else if !head.trim().is_empty() {
                facts.branch = Some(head.trim().to_string());
            }
            continue;
        }
        if let Some(up) = line.strip_prefix("# branch.upstream ") {
            if !up.trim().is_empty() {
                facts.upstream = Some(up.trim().to_string());
            }
            continue;
        }
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        facts.dirty += 1;
    }
    facts
}

fn git_status(git: &str, dir: &Path) -> Result<StatusFacts, String> {
    let mut cmd = crate::proc::silent(git);
    cmd.arg("-C").arg(dir).args(["status", "--porcelain=v2", "--branch"]);
    let out = crate::proc::output_timeout(&mut cmd, GIT_STATUS_TIMEOUT)
        .map_err(|e| format!("无法启动 git status: {e}"))?
        .ok_or_else(|| "git status 超时".to_string())?;
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        return Err(format!("git status 失败: {}", err.trim()));
    }
    Ok(parse_status_v2(&crate::proc::decode_console(&out.stdout)))
}

fn has_readme(dir: &Path) -> bool {
    ["README.md", "readme.md", "README.markdown", "README"]
        .iter()
        .any(|name| dir.join(name).is_file())
}

fn venv_state(marker: Option<&crate::downloader::Marker>, _dir: &Path) -> String {
    let Some(path) = marker.and_then(|m| m.venv_path.as_deref()).map(Path::new) else {
        return "none".to_string();
    };
    if !path.is_dir() {
        return "missing".to_string();
    }
    let looks = path.join("Scripts").join("python.exe").is_file()
        || path.join("bin").join("python").is_file();
    if looks { "ready" } else { "not-a-venv" }.to_string()
}

fn assess(
    slug: &str,
    dir: &Path,
    marker: Option<&crate::downloader::Marker>,
    marker_state: &str,
    status: Option<&StatusFacts>,
    status_error: Option<&str>,
) -> HealthRow {
    let has_git = dir.join(".git").exists();
    let facts = status.cloned().unwrap_or_default();
    let mut issues = Vec::new();

    if marker_state != "valid" {
        issues.push(issue(
            "marker",
            "error",
            Some(format!(".devhub.json 状态为 {marker_state}")),
        ));
    }
    if !has_git {
        issues.push(issue("no-git", "warn", Some("目录里没有 .git".to_string())));
    }
    if let Some(err) = status_error {
        issues.push(issue("git-status", "warn", Some(err.to_string())));
    }
    if facts.dirty > 0 {
        issues.push(issue(
            "dirty",
            "warn",
            Some(format!("工作树有 {} 个未提交/未跟踪条目", facts.dirty)),
        ));
    }
    if facts.detached {
        issues.push(issue("detached", "warn", Some("HEAD 处于 detached 状态".to_string())));
    }
    if facts.branch.is_some() && facts.upstream.is_none() {
        issues.push(issue("no-upstream", "info", Some("当前分支没有上游".to_string())));
    }
    let venv = venv_state(marker, dir);
    if venv == "missing" {
        issues.push(issue(
            "venv-missing",
            "warn",
            marker
                .and_then(|m| m.venv_path.clone())
                .map(|p| format!("记录的 venv 不存在：{p}")),
        ));
    } else if venv == "not-a-venv" {
        issues.push(issue("venv-invalid", "warn", Some("记录的路径不是虚拟环境".to_string())));
    }
    if !has_readme(dir) {
        issues.push(issue("no-readme", "info", Some("没有 README".to_string())));
    }
    if marker.and_then(|m| m.launch.as_ref()).is_none() {
        issues.push(issue("no-launch", "info", Some("没有已确认的启动配置".to_string())));
    }

    HealthRow {
        slug: slug.to_string(),
        path: dir.to_string_lossy().to_string(),
        marker_state: marker_state.to_string(),
        has_git,
        branch: facts.branch,
        detached: facts.detached,
        upstream: facts.upstream,
        dirty: facts.dirty,
        has_readme: has_readme(dir),
        has_launch: marker.and_then(|m| m.launch.as_ref()).is_some(),
        venv_state: venv,
        issues,
    }
}

fn overview_blocking() -> HealthOverview {
    let start = std::time::Instant::now();
    let roots = crate::project_roots();
    let (repos, _) = crate::repo_index::repos(&roots);
    let capped = repos.len() > MAX_HEALTH_REPOS;
    let git = crate::downloader::find_git(crate::bundled_runtime_dir().as_deref())
        .map(|g| g.path);
    let rows = repos
        .iter()
        .take(MAX_HEALTH_REPOS)
        .filter_map(|repo| {
            let dir = Path::new(repo.path.as_deref()?);
            let marker_file = crate::downloader::read_marker_strict(dir).ok();
            let (marker, state) = match marker_file {
                Some(crate::downloader::MarkerFile::Valid(m)) => (Some(m), "valid"),
                Some(crate::downloader::MarkerFile::Absent) => (None, "absent"),
                Some(crate::downloader::MarkerFile::Unreadable(_)) => (None, "unreadable"),
                Some(crate::downloader::MarkerFile::Corrupt) => (None, "corrupt"),
                None => (None, "unreadable"),
            };
            let slug = repo.slug();
            let (status, status_error) = if dir.join(".git").exists() {
                match git.as_deref() {
                    Some(git) => match git_status(git, dir) {
                        Ok(s) => (Some(s), None),
                        Err(e) => (None, Some(e)),
                    },
                    None => (None, Some("找不到 git".to_string())),
                }
            } else {
                (None, None)
            };
            Some(assess(
                &slug,
                dir,
                marker.as_ref(),
                state,
                status.as_ref(),
                status_error.as_deref(),
            ))
        })
        .collect::<Vec<_>>();
    HealthOverview {
        scanned: rows.len(),
        rows,
        capped,
        elapsed_ms: start.elapsed().as_millis(),
    }
}

#[tauri::command]
pub async fn repo_health_overview() -> Result<HealthOverview, String> {
    tauri::async_runtime::spawn_blocking(overview_blocking)
        .await
        .map_err(|e| format!("健康扫描任务异常: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2_parses_branch_upstream_and_dirty_entries() {
        let text = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n1 .M N... 100644 100644 100644 abc abc src/a.rs\n? new.txt\n";
        let f = parse_status_v2(text);
        assert_eq!(f.branch.as_deref(), Some("main"));
        assert!(!f.detached);
        assert_eq!(f.upstream.as_deref(), Some("origin/main"));
        assert_eq!(f.dirty, 2, "header lines are not entries");
    }

    #[test]
    fn detached_head_is_named_not_guessed_as_a_branch() {
        let f = parse_status_v2("# branch.head (detached)\n");
        assert!(f.detached);
        assert_eq!(f.branch, None);
    }

    #[test]
    fn a_markerless_no_git_directory_is_explained_by_issue_codes() {
        let dir = std::env::temp_dir().join(format!("devhub-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let row = assess("o/r", &dir, None, "absent", None, None);
        let codes: Vec<&str> = row.issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"marker"));
        assert!(codes.contains(&"no-git"));
        assert!(codes.contains(&"no-readme"));
        assert!(codes.contains(&"no-launch"));
        assert_eq!(row.venv_state, "none");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_recorded_missing_venv_is_a_warning_not_a_silent_none() {
        let dir = std::env::temp_dir().join(format!("devhub-health-venv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut marker = crate::downloader::Marker::default();
        marker.venv_path = Some(dir.join("gone").to_string_lossy().to_string());
        std::fs::write(dir.join("README.md"), "x").unwrap();
        let row = assess("o/r", &dir, Some(&marker), "valid", None, None);
        assert_eq!(row.venv_state, "missing");
        assert!(row.issues.iter().any(|i| i.code == "venv-missing"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
