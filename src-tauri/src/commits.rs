//! Read-only commit history for one repository (r32-N4).
//!
//! The wall already knows a project's identity and its most recent update; what
//! it could not answer was "what changed recently". This endpoint returns the
//! newest commits, bounded in count and time, and nothing else: no diff, no
//! checkout, no ref writes. Those are separate product decisions.
//!
//! ## Bounds
//!
//! 30 by default, 100 at most. `git log -n` stops git from producing an
//! unbounded stream, and `output_timeout` stops a locked repository or a stalled
//! child from holding an IPC call forever. The subject is read with `splitn(5)`
//! because a commit subject may itself contain a tab; splitting on every tab
//! would silently move part of the subject into the date field.
//!
//! ## An empty repository is not an error
//!
//! A freshly cloned empty repository has an unborn HEAD and `git log` exits 128.
//! `rev-parse --verify HEAD` is checked first so the dialog can say "没有提交"
//! instead of surfacing git's fatal line. The check is also locale-independent,
//! unlike matching the fatal message text.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

/// Default rows the dialog opens with.
const DEFAULT_LIMIT: usize = 30;
/// Hard ceiling: one IPC response is not a log archive.
const MAX_LIMIT: usize = 100;
/// A local log should answer in milliseconds; ten seconds is already a fault.
const LOG_TIMEOUT: Duration = Duration::from_secs(10);
/// `rev-parse` probes still touch the repository (and can sit on a network share
/// or a locked index); the bounded form is what keeps the dialog answerable.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// Full object id (40 hex for SHA-1 repositories, 64 for SHA-256).
    pub hash: String,
    /// Git's own abbreviation (`%h`).
    pub short: String,
    pub author: String,
    /// Author date, strict ISO 8601 (`%aI`).
    pub date: String,
    pub subject: String,
}

/// Parse `git log --format=%H%x09%h%x09%an%x09%aI%x09%s`.
///
/// Malformed lines are dropped, not guessed at: a line without five fields did
/// not come from this format string, and inventing an author or a date would be
/// worse than showing fewer rows.
pub fn parse_log(text: &str) -> Vec<CommitInfo> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\t');
            let hash = parts.next()?.trim();
            let short = parts.next()?.trim();
            let author = parts.next()?.trim();
            let date = parts.next()?.trim();
            let subject = parts.next()?.trim();
            if hash.is_empty() || short.is_empty() || date.is_empty() {
                return None;
            }
            Some(CommitInfo {
                hash: hash.to_string(),
                short: short.to_string(),
                author: author.to_string(),
                date: date.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// Read commits from one repository. Split from the command so the git shape is
/// testable without a project root.
pub(crate) fn read_commits(repo: &Path, git: &Path, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let mut head_cmd = crate::downloader::git_cmd(git);
    head_cmd
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "HEAD"])
        .env("GIT_TERMINAL_PROMPT", "0");
    let head = crate::proc::output_timeout(&mut head_cmd, PROBE_TIMEOUT)
        .map_err(|e| format!("无法运行 git: {e}"))?
        .ok_or_else(|| "读取 HEAD 超时".to_string())?;
    if !head.status.success() {
        // No HEAD is expected for an empty clone. A directory that is not a
        // repository at all must not be reported as "empty": one more probe
        // separates the two, and only the empty case is a successful answer.
        let mut repo_cmd = crate::downloader::git_cmd(git);
        repo_cmd
            .arg("-C")
            .arg(repo)
            .arg("rev-parse")
            .arg("--git-dir")
            .env("GIT_TERMINAL_PROMPT", "0");
        let in_repo = crate::proc::output_timeout(&mut repo_cmd, PROBE_TIMEOUT)
            .ok()
            .flatten()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !in_repo {
            return Err(format!("不是可读的 Git 仓库：{}", repo.display()));
        }
        return Ok(Vec::new());
    }

    let n = limit.to_string();
    let mut cmd = crate::downloader::git_cmd(git);
    cmd.arg("-C")
        .arg(repo)
        .args([
            "log",
            "--format=%H%x09%h%x09%an%x09%aI%x09%s",
            "-n",
            &n,
            "--",
        ])
        .env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::proc::output_timeout(&mut cmd, LOG_TIMEOUT)
        .map_err(|e| format!("读取提交历史失败: {e}"))?
        .ok_or_else(|| "读取提交历史超时".to_string())?;
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        let text = err.trim();
        return Err(if text.is_empty() {
            "git log 失败（没有诊断输出）".to_string()
        } else {
            text.to_string()
        });
    }
    Ok(parse_log(&crate::proc::decode_console(&out.stdout)))
}

/// Newest commits in one repository, bounded by [`MAX_LIMIT`].
#[tauri::command]
pub async fn repo_commits(slug: String, limit: Option<usize>) -> Result<Vec<CommitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = crate::find_repo_any(&slug).ok_or_else(|| format!("找不到仓库：{slug}"))?;
        let git = crate::downloader::find_git(None).ok_or_else(|| "未找到 Git".to_string())?;
        read_commits(&repo, Path::new(&git.path), clamp_limit(limit))
    })
    .await
    .map_err(|e| format!("提交历史任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_and_keeps_tabs_inside_the_subject() {
        let text = "abc\tabc1234\tAlice\t2026-10-29T10:00:00+08:00\tfix: a\tb\n\
                    def\tdef5678\tBob\t2026-10-28T09:00:00+08:00\tplain\n";
        let rows = parse_log(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].hash, "abc");
        assert_eq!(rows[0].author, "Alice");
        assert_eq!(rows[0].subject, "fix: a\tb");
        assert_eq!(rows[1].short, "def5678");
    }

    #[test]
    fn malformed_lines_are_dropped_not_invented() {
        let text = "a\tb\tc\td\n\
                    \th\tAlice\t2026-10-29T10:00:00+08:00\tsubject\n\
                    h\th\tAlice\t2026-10-29T10:00:00+08:00\tsubject\n";
        assert_eq!(parse_log(text).len(), 1);
        assert_eq!(parse_log("").len(), 0);
    }

    #[test]
    fn limits_are_bounded() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(1_000)), MAX_LIMIT);
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("devhub-commits-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_empty_repository_has_no_commits_and_is_not_an_error() {
        let Some(git) = crate::downloader::find_git(None) else { return };
        let dir = scratch("empty");
        let ok = crate::downloader::git_cmd(Path::new(&git.path))
            .args(["init", "-q", &dir.to_string_lossy()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let rows = read_commits(&dir, Path::new(&git.path), 10).expect("empty repo");
        assert!(rows.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_an_error() {
        let Some(git) = crate::downloader::find_git(None) else { return };
        let dir = scratch("not-a-repo");
        let err = read_commits(&dir, Path::new(&git.path), 10).expect_err("must not look like an empty repository");
        assert!(err.contains("不是可读的 Git 仓库"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_real_repository_lists_newest_first() {
        let Some(git) = crate::downloader::find_git(None) else { return };
        let dir = scratch("real");
        let repo = dir.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            crate::downloader::git_cmd(Path::new(&git.path))
                .args(args)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        if !run(&["init", "-q", &repo]) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        if !run(&["-C", &repo, "add", "."])
            || !run(&["-C", &repo, "-c", "user.name=A", "-c", "user.email=a@example.invalid", "commit", "-qm", "first"])
        {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        std::fs::write(dir.join("a.txt"), b"b").unwrap();
        if !run(&["-C", &repo, "add", "."])
            || !run(&["-C", &repo, "-c", "user.name=B", "-c", "user.email=b@example.invalid", "commit", "-qm", "second"])
        {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let rows = read_commits(&dir, Path::new(&git.path), 10).expect("log");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].subject, "second");
        assert_eq!(rows[1].subject, "first");
        assert_eq!(rows[0].hash.len(), 40, "a SHA-1 repository is still 40 hex chars");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
