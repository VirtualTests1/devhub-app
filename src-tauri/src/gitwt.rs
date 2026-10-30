//! `git worktree` 产品化（第十六轮方向 N1）。
//!
//! Before this module the app knew *where* worktrees live but never made, listed
//! or removed one: [`crate::launch::trash_repo`] and [`crate::launch::delete_repo`]
//! each recomputed `<项目根>\_worktrees\<slug>` inline while sweeping a repository
//! away, and nothing else ever looked at that directory. Two copies of one
//! placement rule, and no way to see the result — which is what this file fixes:
//! the placement rule, the containment rule and the deletion now have exactly one
//! home, and the panel reads the same set the 删除项目 verb cleans.
//!
//! ## Why containment is the centre of this module
//!
//! [`crate::launch::check_venv_target`] states the reasoning for the venv, and it
//! applies here with more force: `<项目根>\_worktrees` holds **every working tree of
//! every repository on the wall**, so an off-by-one in a delete is unrecoverable in
//! a way a stray venv is not. This module therefore owns one guard
//! ([`check_worktree_target`]) with the same four refusals — empty, missing, the
//! container itself, anything that is not *exactly one level* inside a container —
//! and every destructive path here goes through it. The guard accepts both layouts
//! the cleanup reads (`_worktrees` and the legacy `code\_worktrees`) because both
//! are one level deep in their own container.
//!
//! ## What was measured, not assumed (git 2.51.0.windows.1, this machine)
//!
//!   - `git worktree list --porcelain` prints `worktree <path>` / `HEAD <sha>` /
//!     `branch refs/heads/<name>` / `detached` / `bare` /
//!     `prunable <reason>`, **no** `gitdir` line, and paths with forward slashes
//!     (`D:/…`). The main worktree is printed first. Unknown fields are ignored,
//!     because a future git that adds one must not invent a worktree.
//!   - `git worktree remove` on a dirty tree: exit 128,
//!     `fatal: '<path>' contains modified or untracked files, use --force to delete it`;
//!     `--force` succeeds silently. The dirty gate is therefore **git's own**, which
//!     is why this module does not pre-judge it from a probe: a probe that cannot
//!     answer must never be allowed to read as "clean" (the failure mode
//!     `src/lib/worktree-warning.ts` exists for).
//!   - `git worktree add [-b <branch>] <path>` creates **every missing parent
//!     directory**, so the placement check has to run *before* the call, not after.
//!   - `git worktree prune -v` prints one `Removing worktrees/<name>: <reason>`
//!     line per stale registration and nothing when there is nothing to do — that
//!     line count is what [`remove`] reports as `pruned`.
//!   - `git worktree remove` of a path git does not know: `fatal: '<path>' is not a
//!     working tree`; `git worktree add <path> <missing-ref>`:
//!     `fatal: invalid reference: <ref>`. Both are passed back verbatim (clipped).

use std::path::{Path, PathBuf};
use std::time::Duration;

/// `<项目根>\_worktrees`: the reserved container every worktree this app creates
/// lives in. Reserved in the scanner too (`crate::downloader` 的 `RESERVED_ROOT_DIRS`),
/// so a worktree is never listed as a project of its own.
pub const WORKTREES_DIR: &str = "_worktrees";

/// Deadline for `git worktree add`.
///
/// This is a **checkout**, not a probe: it writes every tracked file a second
/// time, so it belongs with [`crate::launch::VENV_TIMEOUT`] (the other operation
/// here that materialises a tree) rather than with `PROBE_TIMEOUT`. Measured cost
/// on a one-file repository is under a second; the deadline exists for the
/// multi-gigabyte ones and for a git that hangs on a credential prompt.
pub const WORKTREE_ADD_TIMEOUT: Duration = Duration::from_secs(180);

/// Deadline for `worktree list` / `remove` / `prune`: local `.git` admin work with
/// no network and no checkout, but still a deadline — every wait in this crate is
/// one (see [`crate::launch::SEQUENTIAL_STEP_TIMEOUT`]'s rationale).
pub const WORKTREE_OP_TIMEOUT: Duration = Duration::from_secs(60);

/// How much of git's own stderr reaches the UI. Same budget as the clone/pull
/// paths (`downloader::run_pull` clips at 400), because a `fatal:` line that names
/// the conflicting worktree is the whole answer and a wrapped stack is not.
const GIT_ERROR_CLIP: usize = 400;

// ---------------------------------------------------------------------------
// Types sent to the frontend
// ---------------------------------------------------------------------------

/// One entry of `git worktree list`, as git describes it plus what the disk says.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Absolute path, backslashes (`D:\…\_worktrees\alice__tool__dev`).
    pub path: String,
    /// The commit HEAD points at, as printed. Empty for an unborn worktree.
    pub head: String,
    /// Branch name. `None` when HEAD is detached — then [`head`](Self::head) is
    /// the only identity the row has, which is why it travels too.
    pub branch: Option<String>,
    /// git printed `detached`.
    pub detached: bool,
    /// git printed `bare`: this record is a bare repository, not a working tree.
    pub bare: bool,
    /// git printed `prunable`: the registration points at a directory that is
    /// already gone. `exists` is the same fact from the filesystem side.
    pub prunable: bool,
    /// git printed `locked`: git itself refuses to remove this one.
    pub locked: bool,
    /// The main checkout of the repository, not a linked worktree.
    pub is_main: bool,
    /// The directory is actually on disk. Stamped by [`list`], never by the
    /// parser — a stale registration is a real thing to show.
    pub exists: bool,
    /// Inside `<项目根>\_worktrees` exactly one level deep, so
    /// [`check_worktree_target`] would accept it and the 删除 button is honest.
    /// False for the main checkout and for a worktree the user made elsewhere by
    /// hand — those are listed but not deleted, and the row says why.
    pub managed: bool,
    /// What git says about *this* tree (dirty / untracked / ahead / branch), for
    /// the confirmation line. `None` when the directory is gone or git would not
    /// answer. Produced by [`crate::launch::worktree_status`], the same probe the
    /// delete confirmation uses, so both surfaces ask the same question the same way.
    pub status: Option<crate::launch::WorktreeStatus>,
}

/// Answer to `list_repo_worktrees`.
///
/// A bare `Vec` cannot tell "这个仓库还没有工作树" apart from "这个目录根本不是 git
/// 仓库" and from "问了但没答上来", and all three need different words in the panel.
/// `repo_worktree_status` already sets the precedent with `hasGit`
/// ([`crate::launch::WorktreeStatus`]), so this is that distinction carried one
/// level up rather than a new idea.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeList {
    /// The repository the question was asked of.
    pub repo: String,
    /// The directory has a `.git` at all. `false` means the empty `worktrees` is
    /// a statement about version control, not about worktrees.
    pub has_git: bool,
    /// Where a new worktree would land (`<项目根>\_worktrees`), so the panel can
    /// name the convention instead of the user guessing it.
    pub container: String,
    pub worktrees: Vec<WorktreeInfo>,
    /// git's own words when the listing failed, `None` on success. Distinct from
    /// `hasGit: false`: a git that refuses is not a repository without git.
    pub error: Option<String>,
}

/// What `remove_repo_worktree` did.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveReport {
    /// The path that was asked about, backslashes.
    pub path: String,
    /// The branch it held, read from the listing *before* the removal — after the
    /// fact git has forgotten it, and a record that cannot name what it deleted is
    /// a record nobody can audit.
    pub branch: Option<String>,
    /// A directory was actually deleted (git said so **and** it is gone).
    pub removed: bool,
    /// Whether `--force` was passed, i.e. whether uncommitted work was destroyed.
    pub force: bool,
    /// Stale registrations `git worktree prune -v` dropped, counted from its own
    /// output lines. Zero with `removed == true` is the normal clean case.
    pub pruned: usize,
    /// Why nothing was deleted even though nothing failed: the directory was
    /// already gone and only the registration remained.
    pub note: Option<String>,
    /// git's refusals, verbatim and clipped. Non-empty is a failed operation —
    /// notably the dirty-tree refusal, which is how the panel learns it must
    /// offer 强制 rather than having guessed from a probe.
    pub failed: Vec<String>,
}

// ---------------------------------------------------------------------------
// Placement — the one copy of "where does a worktree live"
// ---------------------------------------------------------------------------

/// The existing flattening rule: a slug (`host/owner/repo`) contains separators,
/// and a directory name may not. `trash_repo` and `delete_repo` have used exactly
/// this substitution since round 11, so `__` is the convention the cleanup already
/// implements — inventing a second one would have made the panel list files the
/// 删除项目 verb never cleans.
fn flatten_segs(s: &str) -> String {
    s.replace(['\\', '/'], "__")
}

/// `<项目根>\_worktrees`, the current container.
pub fn worktree_container(root: &Path) -> PathBuf {
    root.join(WORKTREES_DIR)
}

/// Both containers, current first: the legacy `code\_worktrees` is included for
/// the same reason the cleanup in [`crate::launch::delete_repo`] already includes
/// it — a repository cloned by 0.2.0 has its copies there, and the guard has to
/// accept those too or the panel cannot delete what the app itself created.
pub fn worktree_containers(root: &Path) -> Vec<PathBuf> {
    vec![
        worktree_container(root),
        root.join("code").join(WORKTREES_DIR),
    ]
}

/// The directory name one worktree of one slug gets: `<slug 扁平>__<分支或子目录名 扁平>`.
///
/// Two levels of `__` in one token are intentional: the slug's separators are
/// already flattened, so the separator between the slug and the tail is the same
/// one git names a branch with. [`worktree_copies_on_disk`] relies on it being a
/// boundary, not a substring — that is what keeps `alice__tool` from claiming
/// `alice__tool2`'s directories.
pub fn worktree_dir_name(slug: &str, tail: &str) -> String {
    format!("{}__{}", flatten_segs(slug.trim()), flatten_segs(tail.trim()))
}

/// Every worktree copy of this slug that is **on disk**, current and legacy layout.
///
/// This is the function that makes 回收一致性 true: it is what
/// [`crate::launch::trash_repo`] / [`crate::launch::delete_repo`] sweep and what the
/// panel offers to delete, computed from one rule instead of two. It matches
/// `<slug 扁平>` (the shape the cleanup has always removed, so nothing that exists
/// today stops being cleaned) and `<slug 扁平>__…` (the per-branch shape `add`
/// creates). The scan is one level deep by construction — it reads the container's
/// own entries — so the container itself can never be in the answer.
pub fn worktree_copies_on_disk(root: &Path, slug: &str) -> Vec<PathBuf> {
    let prefix = flatten_segs(slug.trim());
    if prefix.is_empty() {
        return Vec::new();
    }
    let branch_prefix = format!("{prefix}__");
    let mut out = Vec::new();
    for container in worktree_containers(root) {
        let Ok(read) = std::fs::read_dir(&container) else {
            continue; // no container yet: nothing of this slug can be in it
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != prefix && !name.starts_with(&branch_prefix) {
                continue;
            }
            // Directories only. A stray file wearing the name is not something this
            // app created, and `remove_dir_all` would fail on it while
            // `trash::delete` would not — neither is a worktree copy.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                out.push(entry.path());
            }
        }
    }
    out.sort();
    out
}

/// Is `candidate` exactly one level below one of this root's worktree containers?
///
/// The refusal order and the wording follow [`crate::launch::check_venv_target`],
/// deliberately: two containment rules that disagree in their messages or their
/// edge cases are worse than one coarse rule, because the next reader cannot tell
/// which one to trust. Unlike the venv guard, `venvs` is *outside* every
/// repository while `_worktrees` is a reserved sibling of them, so the containers
/// here are looked up rather than read from a marker — which is also why a missing
/// container is a refusal ("不在…里面") and never a silent pass.
pub fn check_worktree_target(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if candidate.as_os_str().is_empty() {
        return Err("没有指明工作树的位置".to_string());
    }
    let shown = crate::netpath::strip_verbatim(candidate).display().to_string();
    let canon = candidate
        .canonicalize()
        .map_err(|_| format!("工作树目录 {shown} 已不存在，磁盘上没有要删除的东西"))?;
    let containers = worktree_containers(root);
    let named: Vec<String> = containers
        .iter()
        .map(|c| c.display().to_string())
        .collect();
    let mut canonicalised: Vec<PathBuf> = Vec::new();
    for c in &containers {
        match c.canonicalize() {
            Ok(cc) => {
                if canon == cc {
                    return Err(format!(
                        "拒绝删除：{} 是所有工作树的容器本身，不是某一个工作树",
                        cc.display()
                    ));
                }
                canonicalised.push(cc);
            }
            // A container that does not exist cannot be the target, and cannot host
            // it either; the refusal below is the right answer for such a candidate.
            Err(_) => continue,
        }
    }
    for cc in &canonicalised {
        match canon.strip_prefix(cc) {
            Ok(rel) => {
                if rel.components().count() == 1 {
                    return Ok(canon.clone());
                }
                return Err(format!(
                    "拒绝删除：{} 不是 {} 的直接子目录，本应用只创建一层深的工作树",
                    crate::netpath::strip_verbatim(&canon).display(),
                    cc.display()
                ));
            }
            Err(_) => continue,
        }
    }
    Err(format!(
        "{} 不在 {} 里面，本命令只删除由本应用创建的工作树；别处的工作树请用 git worktree remove 自己处理",
        shown,
        named.join(" 或 ")
    ))
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/// Characters git's own `check-ref-format` refuses (as much of them as can appear
/// in what a user types). `\` is included although git tolerates it in a ref: this
/// name becomes a **directory** on Windows, where it is a separator.
const REF_FORBIDDEN: &[char] = &[' ', '~', '^', ':', '*', '?', '[', '\\'];

/// Characters a Windows path component cannot contain. They overlap the set above
/// on purpose — a branch name has to satisfy both, and the two messages say which
/// rule was hit rather than merging into one 「不合法」.
const WIN_FORBIDDEN: &[char] = &['<', '>', '|', '"', ':', '*', '?', '\\'];

/// A branch name this app is willing to put on a command line **and** into a path.
///
/// Both constraints at once is the reason this is not just `git check-ref-format`:
/// the name is passed as `git worktree add -b <name> <path>` (so a leading `-`
/// would be read as an option) and it also becomes the directory name (so Windows'
/// forbidden set applies). Every refusal names the rule rather than saying
/// 「不合法」, because the user typed it and cannot guess which rule they hit.
pub fn validate_branch(raw: &str) -> Result<String, String> {
    let b = raw.trim();
    if b.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    if b.chars().count() > 100 {
        return Err("分支名太长了（上限 100 个字符）".to_string());
    }
    if b.starts_with('-') {
        return Err("分支名不能以 - 开头：那会被 git 当成一个参数".to_string());
    }
    if b.starts_with('/') || b.ends_with('/') || b.contains("//") {
        return Err("分支名不能以 / 开头或结尾，也不能有连续的两个 /".to_string());
    }
    for (i, seg) in b.split('/').enumerate() {
        if seg.is_empty() {
            return Err(format!("分支名第 {} 段是空的", i + 1));
        }
        if seg == "." || seg == ".." {
            return Err("分支名里不能用 . 或 ..：它会变成路径而不是名字".to_string());
        }
        if seg.ends_with('.') {
            return Err(format!("分支段 {seg} 不能以小数点结尾"));
        }
        if seg.to_ascii_lowercase().ends_with(".lock") {
            return Err(format!("分支段 {seg} 不能以 .lock 结尾"));
        }
    }
    if b.contains("..") {
        return Err("分支名里不能有连续两个点".to_string());
    }
    if b == "@" || b.starts_with("@{") {
        return Err("@ 与 @{…} 是 git 的保留写法，不能用作分支名".to_string());
    }
    for c in b.chars() {
        let cp = c as u32;
        if cp < 0x20 || cp == 0x7f {
            return Err("分支名里不能有控制字符".to_string());
        }
        if REF_FORBIDDEN.contains(&c) {
            return Err(format!("分支名里不能有 {c}：git 的分支名不接受它"));
        }
        if WIN_FORBIDDEN.contains(&c) {
            return Err(format!("分支名里不能有 {c}：这个字符在 Windows 的路径里不合法"));
        }
    }
    Ok(b.to_string())
}

/// A short name the user picks instead of deriving the directory from the branch.
///
/// Stricter than a branch: it is *only* a path component, so the whole Windows
/// forbidden set applies, and `.` / `..` are refused by name because they would
/// otherwise turn the containment check into a walk up out of `_worktrees`.
pub fn validate_subdir_name(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("子目录名不能为空；留空就会用分支名".to_string());
    }
    if s.chars().count() > 60 {
        return Err("子目录名太长了（上限 60 个字符）".to_string());
    }
    if s == "." || s == ".." || s.contains("..") {
        return Err("子目录名不能用 . 或 ..：它必须是容器目录的直接子项".to_string());
    }
    for c in s.chars() {
        let cp = c as u32;
        if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            return Err(format!("子目录名里不能有 {c}：这个字符在 Windows 的路径里不合法"));
        }
        if cp < 0x20 || cp == 0x7f {
            return Err("子目录名里不能有控制字符".to_string());
        }
    }
    if s.ends_with('.') || s.ends_with(' ') || s.starts_with(' ') {
        return Err("子目录名不能以小数点或空格开头结尾（Windows 会把它去掉）".to_string());
    }
    Ok(s.to_string())
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

fn clip(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max).collect();
    format!("{cut}…（已截断）")
}

/// The path as the UI and the shell want it: no verbatim prefix, backslashes.
///
/// git prints `D:/a/b` even on Windows (measured), and a mixed `D:/a\b` string in a
/// confirmation dialog is both ugly and a worse thing to hand to
/// `reveal_path`/Explorer than a plain Win32 path.
fn shown(p: &Path) -> String {
    crate::netpath::strip_verbatim(p)
        .to_string_lossy()
        .replace('/', "\\")
}

/// For comparing two spellings of one path (case and separator only).
///
/// Deliberately not a canonicalization: the value from git may name a directory
/// that no longer exists, and the comparison still has to be meaningful then.
fn same_path(a: &str, b: &str) -> bool {
    a.replace('/', "\\").to_ascii_lowercase() == b.replace('/', "\\").to_ascii_lowercase()
}

fn git_exe() -> Option<PathBuf> {
    crate::downloader::find_git(None).map(|g| PathBuf::from(g.path))
}

fn osx(s: &str) -> std::ffi::OsString {
    std::ffi::OsString::from(s)
}

/// One bounded `git -C <repo> …` call, returning stdout.
///
/// [`crate::proc::output_timeout`] rather than `spawn` + `wait_with_output`: it
/// pipes **and** drains both handles, which round 15 learned is not decorative —
/// a caller that skipped the `Stdio::piped()` part captured nothing, forever, and
/// every one of those failures read as "the tool said nothing". The env pair is
/// the downloader's: a git that decides to ask for a credential must fail rather
/// than hold a blocking thread and a GUI modal with it.
fn git_run(
    git: &Path,
    repo: &Path,
    args: &[std::ffi::OsString],
    label: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = crate::proc::silent(git);
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "");
    let out = match crate::proc::output_timeout(&mut cmd, timeout) {
        Ok(Some(o)) => o,
        Ok(None) => {
            return Err(format!(
                "git {label} 超过 {} 秒未结束，已中止；仓库没有被改动过的那部分会保持原样",
                timeout.as_secs()
            ))
        }
        Err(e) => return Err(format!("无法启动 git: {e}")),
    };
    // `decode_console` because this is a git subprocess's text formatted by Windows
    // in the OEM codepage, and it lands in a confirmation dialog where mojibake
    // reads as "nothing to see" (the same reasoning as `launch::worktree_status`).
    let stderr = clip(&crate::proc::decode_console(&out.stderr), GIT_ERROR_CLIP);
    if !out.status.success() {
        return Err(if stderr.is_empty() {
            match out.status.code() {
                Some(code) => format!("git {label} 以退出码 {code} 结束，没有留下诊断"),
                None => format!("git {label} 被外力终止（可能是崩溃或被杀掉）"),
            }
        } else {
            stderr
        });
    }
    Ok(crate::proc::decode_console(&out.stdout))
}

// ---------------------------------------------------------------------------
// The porcelain parser
// ---------------------------------------------------------------------------

/// One record of `git worktree list --porcelain`, as git said it.
struct Record {
    raw_path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    prunable: bool,
    locked: bool,
}

/// Parses git's porcelain listing.
///
/// Pure, and record-order preserving: git prints the main worktree first, and the
/// caller depends on that only as a fallback (see [`stamp_is_main`]). Unknown
/// fields are skipped rather than guessed at — `orphan`, a future field, or a new
/// decoration must not be able to invent a worktree or rename one.
///
/// `exists` / `managed` / `status` stay at their defaults here on purpose: those
/// are facts about the **disk**, and a parser that also stats the filesystem
/// cannot be tested without one. [`list`] stamps them.
fn parse_porcelain(text: &str, repo: &Path) -> Vec<WorktreeInfo> {
    let mut current: Option<Record> = None;

    let flush = |current: &mut Option<Record>, out: &mut Vec<Record>| {
        if let Some(r) = current.take() {
            if !r.raw_path.is_empty() {
                out.push(r);
            }
        }
    };
    let mut flushed: Vec<Record> = Vec::new();

    for line in text.lines() {
        let l = line.trim_end_matches('\r');
        if let Some(rest) = l.strip_prefix("worktree ") {
            flush(&mut current, &mut flushed);
            current = Some(Record {
                raw_path: rest.trim().to_string(),
                head: String::new(),
                branch: None,
                detached: false,
                bare: false,
                prunable: false,
                locked: false,
            });
            continue;
        }
        if current.is_none() {
            continue; // preamble / a record we never opened
        }
        let Some(r) = current.as_mut() else { continue };
        if let Some(rest) = l.strip_prefix("HEAD ") {
            r.head = rest.trim().to_string();
        } else if let Some(rest) = l.strip_prefix("branch ") {
            r.branch = Some(rest.trim().to_string());
        } else if l == "detached" {
            r.detached = true;
        } else if l == "bare" {
            r.bare = true;
        } else if l.starts_with("prunable") {
            r.prunable = true;
        } else if l.starts_with("locked") {
            r.locked = true;
        }
        // Anything else (`orphan …`, a blank line between records, a future field)
        // is ignored, which is the only honest reading of a format we do not own.
    }
    flush(&mut current, &mut flushed);

    let mut out: Vec<WorktreeInfo> = flushed
        .into_iter()
        .map(|r| {
            // git may print a path relative to the repository (`worktree.useRelativePaths`
            // is a real config), so a relative spelling is resolved, not displayed raw.
            let p = {
                let candidate = PathBuf::from(&r.raw_path);
                if candidate.is_absolute() {
                    candidate
                } else {
                    repo.join(&r.raw_path)
                }
            };
            WorktreeInfo {
                path: shown(&p),
                head: r.head,
                // `refs/heads/main` → `main`. Any other namespace is kept whole: a
                // row that says `refs/remotes/origin/x` is honest, one that says
                // `x` is not — it is not a local branch and deleting it means
                // something different.
                branch: r.branch.as_ref().map(|b| {
                    b.strip_prefix("refs/heads/")
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| b.clone())
                }),
                detached: r.detached,
                bare: r.bare,
                prunable: r.prunable,
                locked: r.locked,
                is_main: false,
                exists: false,
                managed: false,
                status: None,
            }
        })
        .collect();
    stamp_is_main(&mut out, repo);
    out
}

/// Marks which record is the main checkout.
///
/// Matched by path against the repository the question was asked of; git prints
/// the main worktree first, but that is a printing order, not a promise, and a
/// repository whose `.git` was moved can disagree with it. The first record is the
/// fallback so the panel always names one.
fn stamp_is_main(rows: &mut [WorktreeInfo], repo: &Path) {
    let want = shown(repo);
    if let Some(row) = rows.iter_mut().find(|r| same_path(&r.path, &want)) {
        row.is_main = true;
        return;
    }
    if let Some(first) = rows.first_mut() {
        first.is_main = true;
    }
}

/// Adds the filesystem facts to one row.
fn stamp_disk(row: &mut WorktreeInfo, root: &Path) {
    let p = PathBuf::from(&row.path);
    row.exists = p.is_dir();
    row.managed = row.exists && check_worktree_target(root, &p).is_ok();
    row.status = if row.exists {
        // The same probe the delete confirmation runs, per tree: `dirty` /
        // `untracked` / `ahead` for *this* directory, not for the main one. Bounded
        // three times over inside (`launch::worktree_status`), so a wedged git
        // degrades to "would not say" rather than hanging the panel.
        Some(crate::launch::worktree_status(&p))
    } else {
        None
    };
}

// ---------------------------------------------------------------------------
// Commands' implementation
// ---------------------------------------------------------------------------

/// True when the directory has version control at all.
///
/// Not just "`.git` exists": an *unrecognized* `.git` (an empty directory left
/// behind by a half-finished operation) does not stop git's own discovery — git
/// keeps walking up and answers for the **parent** repository. Measured on this
/// machine: the fixture asked, git returned the harness repo's 86 worktrees, and
/// [`list`] then probed every existing row three times each with a 10s
/// [`crate::proc::PROBE_TIMEOUT`] — minutes of 「正在问 git…」 that no 60s deadline
/// covered, showing another repository's worktrees as this one's. So the gate is
/// git's own recognition rule, `HEAD`: a clone has `.git/HEAD`, a linked
/// worktree's `.git` is a file whose `gitdir:` target carries `HEAD`, and a
/// directory without either was never a repository git would claim.
fn has_git(repo: &Path) -> bool {
    let dot = repo.join(".git");
    if dot.is_dir() {
        return dot.join("HEAD").exists();
    }
    if dot.is_file() {
        let Ok(text) = std::fs::read_to_string(&dot) else {
            return false;
        };
        let Some(rest) = text.trim().strip_prefix("gitdir:") else {
            return false;
        };
        let target = Path::new(rest.trim());
        let dir = if target.is_absolute() {
            target.to_path_buf()
        } else {
            repo.join(target)
        };
        return dir.join("HEAD").exists();
    }
    false
}

/// `git worktree list --porcelain`, stamped with what the disk says.
pub fn list(repo: &Path, root: &Path) -> WorktreeList {
    let container = worktree_container(root);
    let mut out = WorktreeList {
        repo: shown(repo),
        has_git: has_git(repo),
        container: shown(&container),
        worktrees: Vec::new(),
        error: None,
    };
    if !out.has_git {
        return out;
    }
    let Some(git) = git_exe() else {
        out.error = Some("本机找不到 git，问不到工作树列表".to_string());
        return out;
    };
    match git_run(
        &git,
        repo,
        &[osx("worktree"), osx("list"), osx("--porcelain")],
        "worktree list",
        WORKTREE_OP_TIMEOUT,
    ) {
        Ok(text) => {
            for mut row in parse_porcelain(&text, repo) {
                stamp_disk(&mut row, root);
                out.worktrees.push(row);
            }
        }
        Err(e) => out.error = Some(e),
    }
    out
}

/// Creates one worktree at `<项目根>\_worktrees\<slug>__<分支或子目录名>`.
///
/// Placement is decided here, in full, **before** git is asked: git happily creates
/// every missing parent directory of its target (measured), so a name that could
/// escape the container would have escaped it before any check could object. The
/// path is therefore built from a validated tail, and then re-checked against the
/// container the way [`check_worktree_target`] will check it once it exists.
pub fn add(
    repo: &Path,
    root: &Path,
    slug: &str,
    branch: &str,
    create_new: bool,
    subdir: Option<&str>,
) -> Result<WorktreeInfo, String> {
    if !has_git(repo) {
        return Err(format!(
            "{} 没有 git 历史（压缩包下载或手工复制），没有仓库可以挂工作树",
            shown(repo)
        ));
    }
    let git = git_exe().ok_or_else(|| "本机找不到 git，无法创建工作树".to_string())?;
    let branch = validate_branch(branch)?;
    // The tail is what the directory is named after: the branch by default, or a
    // short name the user chose when the branch is long or full of slashes.
    let tail = match subdir {
        Some(s) if !s.trim().is_empty() => validate_subdir_name(s)?,
        _ => branch.clone(),
    };
    let dir_name = worktree_dir_name(slug, &tail);
    if dir_name.contains('/') || dir_name.contains('\\') || dir_name == "." || dir_name == ".." {
        // Unreachable through the validators above; kept because it is the one
        // thing standing between a future edit to `flatten_segs` and a path that
        // leaves the container, and because the failure it prevents is unrecoverable.
        return Err(format!("工作树目录名不合法：{dir_name}"));
    }
    let container = worktree_container(root);
    let target = container.join(&dir_name);
    if target.parent().map(|p| p != container).unwrap_or(true) {
        return Err(format!("落位校验失败：{} 不是 {} 的直接子项", shown(&target), shown(&container)));
    }
    // Windows rejects a long path with a bare "找不到文件" further down the line, in
    // a dialog where that reads as "the worktree is missing". Say it here, and say
    // what to do about it (the 子目录名 field exists for exactly this).
    if shown(&target).chars().count() > 240 {
        return Err(format!(
            "落位路径太长（{} 个字符），Windows 会在 260 处拒绝。用一个短的子目录名，或把项目根移近盘符根。",
            shown(&target).chars().count()
        ));
    }
    if target.exists() {
        return Err(format!(
            "{} 已经存在。git 不会往一个已存在的目录里放工作树——换个子目录名，或先删掉它。",
            shown(&target)
        ));
    }

    let branch_os = osx(&branch);
    let target_os = osx(&target.to_string_lossy());
    let args: Vec<std::ffi::OsString> = if create_new {
        vec![
            osx("worktree"),
            osx("add"),
            osx("-b"),
            branch_os,
            target_os,
        ]
    } else {
        vec![osx("worktree"), osx("add"), target_os, branch_os]
    };
    let label = if create_new {
        format!("worktree add -b {branch}")
    } else {
        format!("worktree add {branch}")
    };
    // `-c core.quotepath=false` belongs to the *listing*, not to this call: nothing
    // here prints a path back to us that we parse. The add's stdout is discarded —
    // the re-list below is the authoritative record of what exists.
    git_run(&git, repo, &args, &label, WORKTREE_ADD_TIMEOUT)?;

    // Re-read rather than describe: the sha, the branch git actually created, and
    // whether it is already prunable all come from git's own answer, so the row the
    // panel appends is the row git would print.
    let re_list = git_run(
        &git,
        repo,
        &[osx("worktree"), osx("list"), osx("--porcelain")],
        "worktree list",
        WORKTREE_OP_TIMEOUT,
    )
    .map_err(|e| format!("工作树已创建，但紧接着读列表失败：{e}"))?;
    let want = shown(&target);
    for mut row in parse_porcelain(&re_list, repo) {
        if same_path(&row.path, &want) {
            stamp_disk(&mut row, root);
            return Ok(row);
        }
    }
    Err(format!(
        "git 说创建成功，但工作树列表里没有 {want}。请刷新一次确认；不要重复创建。"
    ))
}

/// Removes one worktree, then prunes stale registrations.
///
/// Two refusals are **not** implemented here, and both are deliberate:
///
///   - The dirty tree is git's call, not ours. `git worktree remove` refuses it
///     with its own sentence and `--force` is git's own switch (measured); a
///     pre-flight probe would have to decide what "could not ask git" means, and
///     round 15's `src/lib/worktree-warning.ts` exists because that guess went
///     wrong here once already. So the probe is only ever shown, never obeyed.
///   - Nothing goes to the Recycle Bin. `trash::delete` + `prune` would keep the
///     *files* recoverable but would destroy the protection that matters more:
///     git's dirty gate, which is the only thing here that stands between a wrong
///     click and unrecoverable uncommitted work — and it cannot be re-implemented
///     honestly on top of a bin. The repository-level verbs (
///     [`crate::launch::trash_repo`]) keep their bin: there the parent `.git`
///     leaves too, so no registration is ever orphaned. See `docs/worktrees.md`.
pub fn remove(repo: &Path, root: &Path, path: &Path, force: bool) -> Result<RemoveReport, String> {
    let shown_path = shown(path);
    let mut report = RemoveReport {
        path: shown_path.clone(),
        branch: None,
        removed: false,
        force,
        pruned: 0,
        note: None,
        failed: Vec::new(),
    };
    if !has_git(repo) {
        return Err(format!(
            "{} 没有 git 历史，这里没有工作树登记可以删除",
            shown(repo)
        ));
    }
    let git = git_exe().ok_or_else(|| "本机找不到 git，无法删除工作树".to_string())?;

    // Containment first, and only when there is a directory to contain: the guard
    // canonicalizes, so a path git still registers but the disk has lost is refused
    // by it — and that case is not a failure, it is exactly what `prune` is for.
    let target = if path.is_dir() {
        Some(check_worktree_target(root, path)?)
    } else {
        report.note = Some(
            "这个工作树的目录已经不在了，剩下的只有 git 的登记；下面只做登记清理。"
                .to_string(),
        );
        None
    };

    // The branch, read before the removal — afterwards git no longer knows.
    if let Ok(text) = git_run(
        &git,
        repo,
        &[osx("worktree"), osx("list"), osx("--porcelain")],
        "worktree list",
        WORKTREE_OP_TIMEOUT,
    ) {
        report.branch = parse_porcelain(&text, repo)
            .into_iter()
            .find(|r| same_path(&r.path, &shown_path))
            .and_then(|r| r.branch);
    }

    if let Some(dir) = target {
        let dir_text = dir.to_string_lossy().to_string();
        let mut args: Vec<std::ffi::OsString> = vec![osx("worktree"), osx("remove")];
        if force {
            args.push(osx("--force"));
        }
        args.push(osx(&dir_text));
        let label = if force { "worktree remove --force" } else { "worktree remove" };
        match git_run(&git, repo, &args, label, WORKTREE_OP_TIMEOUT) {
            Ok(_) => {
                // Success is the directory being gone, not git's exit code: a
                // removal that reported 0 and left the tree standing is a failure
                // that must not be recorded as a deletion.
                report.removed = !dir.exists();
                if !report.removed {
                    report.failed.push(format!(
                        "{} 仍然在原处：git 报告删除成功但目录还在，登记与磁盘至少有一处没动",
                        shown(&dir)
                    ));
                }
            }
            Err(e) => report.failed.push(e),
        }
    }

    // Always prune: this call is also the app's only way to make a listing that
    // says `prunable` honest again, and it cannot delete a directory that is
    // already gone (git forgets the registration, the files were never ours to
    // touch). `-v` is what makes `pruned` a count rather than a claim.
    match git_run(
        &git,
        repo,
        &[osx("worktree"), osx("prune"), osx("-v")],
        "worktree prune",
        WORKTREE_OP_TIMEOUT,
    ) {
        Ok(text) => {
            // Measured: one `Removing worktrees/<name>: <reason>` line per stale
            // registration, and no output at all when there is nothing to prune.
            report.pruned = text.lines().filter(|l| !l.trim().is_empty()).count();
        }
        Err(e) => report.failed.push(format!("清理陈旧登记失败：{e}")),
    }
    Ok(report)
}

/// Where the next worktree of this slug would go, for the panel to name up front.
///
/// Goes through the same rules as [`add`], so a preview cannot promise a path the
/// create button will then refuse (the promise being the point: the panel shows
/// this *before* the branch field has been submitted).
pub fn preview_path(root: &Path, slug: &str, branch: &str, subdir: Option<&str>) -> String {
    let tail = subdir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| branch.trim().to_string());
    shown(&worktree_container(root).join(worktree_dir_name(slug, &tail)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim `git worktree list --porcelain` from git 2.51.0.windows.1 on this
    /// machine (main + one detached + one linked branch), so the parser is pinned
    /// to the format rather than to a remembered one.
    const SAMPLE: &str = "worktree D:/tmp/probe/main
HEAD 8cc522c4ab834819fc821f8ee7058df3c7693da7
branch refs/heads/main

worktree D:/tmp/probe/container/main__det
HEAD 8cc522c4ab834819fc821f8ee7058df3c7693da7
detached

worktree D:/tmp/probe/container/main__feat__x
HEAD 8cc522c4ab834819fc821f8ee7058df3c7693da7
branch refs/heads/feat/x
";

    fn rows(text: &str) -> Vec<WorktreeInfo> {
        parse_porcelain(text, std::path::Path::new("D:\\tmp\\probe\\main"))
    }

    #[test]
    fn a_real_porcelain_listing_parses_into_three_trees_with_the_main_one_first() {
        let got = rows(SAMPLE);
        assert_eq!(got.len(), 3, "one record per `worktree` line");
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(got[0].is_main, "matched against the repository the question was asked of");
        assert!(!got[1].is_main);
        assert_eq!(got[1].branch, None, "detached has no branch");
        assert!(got[1].detached);
        assert_eq!(got[1].head, "8cc522c4ab834819fc821f8ee7058df3c7693da7");
        assert_eq!(got[2].branch.as_deref(), Some("feat/x"), "refs/heads/ is stripped");
        assert!(!got[2].prunable);
        assert_eq!(got[2].path, "D:\\tmp\\probe\\container\\main__feat__x", "backslashes, as git spells them on Windows");
    }

    #[test]
    fn prunable_bare_and_unknown_fields_are_read_as_git_prints_them() {
        let text = "worktree D:/tmp/probe/main
HEAD 8cc522c4ab834819fc821f8ee7058df3c7693da7
branch refs/heads/main
prunable gitdir file points to non-existent location
orphan refs/heads/some-new-decorator

worktree D:/tmp/probe/bare.git
HEAD 
bare
";
        let got = rows(text);
        assert_eq!(got.len(), 2);
        assert!(got[0].prunable);
        assert!(got[1].bare);
        assert_eq!(got[1].head, "", "an unborn/bare record prints no sha");
        assert_eq!(got[0].branch.as_deref(), Some("main"), "the unknown `orphan` line must not rename it");
    }

    #[test]
    fn a_listing_that_names_nothing_main_still_marks_the_first_row_main() {
        let text = "worktree E:/elsewhere/wt1
HEAD 1111111111111111111111111111111111111111
branch refs/heads/a
";
        let got = rows(text);
        assert_eq!(got.len(), 1);
        assert!(got[0].is_main, "git prints the main worktree first; the fallback keeps the panel from claiming there is none");
    }

    #[test]
    fn a_relative_path_from_git_is_resolved_against_the_repository() {
        let text = "worktree ../sibling
HEAD 2222222222222222222222222222222222222222
";
        let got = parse_porcelain(text, std::path::Path::new("D:\\repo\\main"));
        assert_eq!(
            got[0].path,
            "D:\\repo\\main\\..\\sibling",
            "a relative spelling is resolved against the repository, then printed with backslashes"
        );
    }

    #[test]
    fn an_empty_or_foreign_output_produces_no_worktree() {
        assert!(rows("").is_empty());
        assert!(rows("\n\n").is_empty());
        assert!(rows("usage: git worktree list [-v | --porcelain]\n").is_empty());
    }

    /// Placement is the whole safety story, so each refusal is its own assert —
    /// the same discipline `check_venv_target`'s test applies for the same reason.
    #[test]
    fn a_worktree_may_only_be_deleted_one_level_below_the_worktrees_directory() {
        let root = temp_fixture("guard");
        let container = root.join(WORKTREES_DIR);
        std::fs::create_dir_all(container.join("alice__tool__dev")).unwrap();
        std::fs::create_dir_all(container.join("nested").join("deeper")).unwrap();
        std::fs::create_dir_all(root.join("code").join(WORKTREES_DIR).join("alice__tool")).unwrap();

        assert!(
            check_worktree_target(&root, &container.join("alice__tool__dev")).is_ok(),
            "current layout, one level"
        );
        assert!(
            check_worktree_target(&root, &root.join("code").join(WORKTREES_DIR).join("alice__tool")).is_ok(),
            "legacy layout is what the cleanup already sweeps"
        );
        assert!(
            check_worktree_target(&root, &container.join("nested").join("deeper")).is_err(),
            "two levels deep is not something this app created"
        );
        assert!(
            check_worktree_target(&root, &container).is_err(),
            "the container itself must never be a target"
        );
        assert!(check_worktree_target(&root, &root).is_err(), "the project root itself");
        assert!(check_worktree_target(&root, std::path::Path::new("")).is_err(), "an empty path");
        assert!(
            check_worktree_target(&root, &container.join("not-there")).is_err(),
            "a path that is gone has no directory to delete"
        );
        assert!(
            check_worktree_target(&root, &root.join("elsewhere")).is_err(),
            "a directory outside both containers"
        );
        let err = check_worktree_target(&root, &container.join("nested").join("deeper"))
            .err()
            .unwrap_or_default();
        assert!(err.contains("直接子目录"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The scan is what makes 回收一致性 (N1-3) true, so the boundary rules are
    /// each asserted: this is the set the 删除项目 verb sweeps **and** the set the
    /// panel lists, from one function.
    #[test]
    fn the_copy_scan_matches_the_slug_boundary_not_a_substring() {
        let root = temp_fixture("copies");
        let container = root.join(WORKTREES_DIR);
        let legacy = root.join("code").join(WORKTREES_DIR);
        for name in [
            "alice__tool",
            "alice__tool__dev",
            "alice__tool__feat__x",
            "alice__tool2",
            "alice__tool2__dev",
            "bob__tool__dev",
        ] {
            std::fs::create_dir_all(container.join(name)).unwrap();
        }
        std::fs::create_dir_all(legacy.join("alice__tool")).unwrap();
        std::fs::write(container.join("alice__tool__readme"), b"x").unwrap();

        let names: Vec<String> = worktree_copies_on_disk(&root, "alice/tool")
            .iter()
            .map(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            })
            .collect();
        assert!(names.contains(&"alice__tool".to_string()), "the shape the cleanup has always removed");
        assert!(names.contains(&"alice__tool__dev".to_string()), "the shape add creates");
        assert!(names.contains(&"alice__tool__feat__x".to_string()));
        assert_eq!(
            names.iter().filter(|n| n.as_str() == "alice__tool").count(),
            2,
            "current and legacy layout, each once"
        );
        assert!(
            !names.iter().any(|n| n.starts_with("alice__tool2")),
            "the `__` boundary is what keeps another slug's copies out"
        );
        assert!(!names.iter().any(|n| n.starts_with("bob")), "somebody else's worktree stays theirs");
        assert!(
            !names.iter().any(|n| n.ends_with("readme")),
            "a file wearing the name is not a worktree copy"
        );
        assert_eq!(names.len(), 4, "3 in the current container + 1 legacy");
        assert_eq!(
            worktree_copies_on_disk(&root, ""),
            Vec::<std::path::PathBuf>::new(),
            "an empty slug matches nothing"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_detached_head_row_keeps_the_sha_it_was_given() {
        let text = "worktree D:/tmp/probe/wt
HEAD 3333333333333333333333333333333333333333
detached
";
        let got = rows(text);
        assert_eq!(got[0].branch, None);
        assert_eq!(got[0].head.len(), 40, "the sha is the only identity the row has");
        assert!(got[0].detached);
    }

    #[test]
    fn a_branch_name_is_measured_against_git_and_against_the_filesystem() {
        assert_eq!(validate_branch(" main ").ok(), Some("main".to_string()));
        assert_eq!(validate_branch("feat/x").ok(), Some("feat/x".to_string()));
        for bad in [
            "", " ", "--force", "a..b", "a/", "/a", "a//b", "a.lock", "@", "@{1}", "a b", "a:b",
            "a*b", "a?b", "a[b", "a\\b", "a\nb", "a.",
        ] {
            assert!(validate_branch(bad).is_err(), "{bad:?} must be refused");
        }
        assert!(validate_branch(&"x".repeat(101)).is_err(), "length cap");
    }

    #[test]
    fn a_subdir_name_must_be_one_plain_windows_component() {
        assert_eq!(validate_subdir_name(" dev ").ok(), Some("dev".to_string()));
        assert!(validate_subdir_name(".").is_err());
        assert!(validate_subdir_name("..").is_err());
        assert!(validate_subdir_name("a/b").is_err());
        assert!(validate_subdir_name("a\\b").is_err());
        assert!(validate_subdir_name("a:b").is_err());
        assert!(validate_subdir_name("a.").is_err());
        assert!(validate_subdir_name("").is_err());
        assert!(validate_subdir_name(&"x".repeat(61)).is_err());
    }

    #[test]
    fn the_directory_name_reuses_the_rule_the_cleanup_already_implemented() {
        // `trash_repo` flattens the slug's separators to `__`; the panel's path is
        // that same rule with the branch appended, so both sides name one thing.
        assert_eq!(
            worktree_dir_name("github.com/alice/tool", "feat/login"),
            "github.com__alice__tool__feat__login"
        );
        assert_eq!(worktree_dir_name("alice/tool", "dev"), "alice__tool__dev");
    }

    #[test]
    fn a_container_is_reported_under_both_layouts_and_never_invented() {
        let root = std::path::Path::new("D:\\Projects");
        assert_eq!(worktree_container(root), PathBuf::from("D:\\Projects\\_worktrees"));
        assert_eq!(
            worktree_containers(root),
            vec![
                PathBuf::from("D:\\Projects\\_worktrees"),
                PathBuf::from("D:\\Projects\\code\\_worktrees"),
            ]
        );
    }

    #[test]
    fn a_preview_path_is_the_path_the_create_button_will_use() {
        let root = std::path::Path::new("D:\\Projects");
        assert_eq!(
            preview_path(root, "alice/tool", "dev", None),
            "D:\\Projects\\_worktrees\\alice__tool__dev"
        );
        assert_eq!(
            preview_path(root, "alice/tool", "feat/long/name", Some("login")),
            "D:\\Projects\\_worktrees\\alice__tool__login"
        );
    }

    #[test]
    fn a_listing_of_a_directory_without_git_says_so_instead_of_saying_none() {
        // The distinction the panel needs: 「还没有工作树」 and 「这不是 git 仓库」
        // are different sentences about different facts.
        let dir = temp_fixture("nogit");
        let out = list(&dir, &dir);
        assert!(!out.has_git);
        assert!(out.worktrees.is_empty());
        assert_eq!(out.error, None, "no git failure: git was never asked");
        assert_eq!(out.container, shown(&dir.join(WORKTREES_DIR)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_git_directory_is_not_a_repository_and_git_is_never_asked() {
        // The escape this gate exists for: git's discovery skips an unrecognized
        // `.git` and answers for the parent — measured 86 foreign worktrees and
        // minutes of probes. An empty `.git` must short-circuit before any call.
        let dir = temp_fixture("emptygit");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let out = list(&dir, &dir);
        assert!(!out.has_git, "no HEAD, no repository — whatever the parent holds");
        assert!(out.worktrees.is_empty());
        assert_eq!(out.error, None, "git was never asked, so git never failed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_gitfile_counts_as_git_only_when_its_target_carries_head() {
        let dir = temp_fixture("gitfile");
        // A linked worktree's `.git` is a file; relative targets resolve against
        // the directory holding the file (git's own rule).
        let real = dir.join("common");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(dir.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert!(!has_git(&dir), "HEAD not there yet");
        std::fs::write(real.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(has_git(&dir), "gitfile → gitdir → HEAD is the chain git itself walks");

        std::fs::write(dir.join(".git"), "gitdir: nowhere-under-temp\n").unwrap();
        assert!(!has_git(&dir), "a gitfile pointing at nothing is not a repository");

        std::fs::write(dir.join(".git"), "not a gitfile\n").unwrap();
        assert!(!has_git(&dir), "a file that is not a gitfile is not a repository");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_clipped_git_error_still_says_it_was_clipped() {
        let long = "fatal: ".to_string() + &"x".repeat(1000);
        let c = clip(&long, 40);
        assert_eq!(c.chars().count(), 40 + "…（已截断）".chars().count());
        assert!(c.ends_with("（已截断）"));
        assert_eq!(clip("  short  ", 400), "short");
    }

    fn temp_fixture(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "devhub-gitwt-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::remove_dir_all(&p).ok();
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}

// ---------------------------------------------------------------------------
// Command shells (r20-O3-2, moved out of lib.rs)
// ---------------------------------------------------------------------------
//
// These three are the IPC boundary only: slug resolution, spawn_blocking, and the
// 记录 write. Every decision about git itself stayed in the functions above, so
// what is here cannot change what git is asked to do.

/// Lists one repository's git worktrees (第十六轮 N1-1).
///
/// Async and off-thread: one `git worktree list` plus three bounded probes per
/// tree (`crate::gitwt::list` calls `launch::worktree_status`, the same probe the delete
/// confirmation runs). Synchronous, that would be a frozen 项目设置 dialog for as
/// many trees as the repository has.
///
/// The activity record may look like over-recording for a read, and it is
/// deliberate: this read spawns a dozen subprocesses, and 记录 is where a person
/// goes when the panel felt slow — the row says which repository was asked, and
/// what answer it got.
#[tauri::command]
pub async fn list_repo_worktrees(slug: String) -> Result<crate::gitwt::WorktreeList, String> {
    let asked = slug.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (repo, root) = crate::repo_and_root(&slug)?;
        Ok::<crate::gitwt::WorktreeList, String>(crate::gitwt::list(&repo, &root))
    })
    .await
    .map_err(|e| format!("工作树列表任务异常: {e}"))??;
    crate::record_activity(
        crate::Log::new("launch", "查看工作树列表", crate::SRC_LAUNCH)
            .detail(&format!(
                "{} 个工作树；{}{}",
                out.worktrees.len(),
                if out.has_git {
                    "容器 ".to_string() + &out.container
                } else {
                    "这个目录没有 git 历史".to_string()
                },
                out.error
                    .as_ref()
                    .map(|e| format!("；git 的回答：{e}"))
                    .unwrap_or_default()
            ))
            .slug(&asked)
            .target(&format!("repo:{asked}")),
    );
    Ok(out)
}

/// Creates a worktree of one repository at the app's placement rule (N1-1).
///
/// `<项目根>\_worktrees\<slug>__<分支或子目录名>`, the rule
/// [`launch::trash_repo`] has been cleaning since round 11 and that
/// [`crate::gitwt::worktree_copies_on_disk`] now owns. Validation and containment happen
/// inside `crate::gitwt::add` **before** git is asked, because git creates every missing
/// parent directory of its target.
#[tauri::command]
pub async fn add_repo_worktree(
    slug: String,
    branch: String,
    create_new: bool,
    subdir_name: Option<String>,
) -> Result<crate::gitwt::WorktreeInfo, String> {
    let started = std::time::Instant::now();
    let args = (slug.clone(), branch.clone(), create_new, subdir_name.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (repo, root) = crate::repo_and_root(&args.0)?;
        crate::gitwt::add(
            &repo,
            &root,
            &args.0,
            &args.1,
            args.2,
            args.3.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("创建工作树任务异常: {e}"))?;
    let seconds = started.elapsed().as_secs();
    match out {
        Ok(info) => {
            crate::record_activity(
                crate::Log::new("launch", "创建工作树", crate::SRC_LAUNCH)
                    .detail(&format!(
                        "分支 {}{}，耗时 {seconds} 秒",
                        info.branch.clone().unwrap_or_else(|| format!("（分离头指针 {}）", info.head)),
                        if create_new { "（新建）" } else { "" }
                    ))
                    .slug(&slug)
                    .target(&format!("repo:{slug}"))
                    .path_str(&info.path)
                    // Honest, and not because the reversal is hard: `git worktree
                    // add` registers the tree inside the repository's `.git`, so a
                    // 回退 that only deleted the directory would leave a
                    // registration pointing at nothing — the state the panel then
                    // has to prune. `delete_downloaded` (the only path-kind 回退 the
                    // records page can issue) is refused by `path_guard` inside
                    // `_worktrees` anyway. The reversal that is correct is the one
                    // the row's own 删除 button runs, `git worktree remove` + prune.
                    .undo(crate::activity::Undo::none(
                        "这一条不通过「回退」撤销：删掉目录不会清掉 git 里的登记，登记会留在原地。请在项目设置的「工作树」一节对这一行点「删除」，它跑的是 git worktree remove，目录与登记一起清。",
                    )),
            );
            Ok(info)
        }
        Err(e) => {
            crate::record_activity(
                crate::Log::new("launch", "创建工作树失败", crate::SRC_LAUNCH)
                    .detail(&format!("分支 {branch}：{e}"))
                    .slug(&slug)
                    .target(&format!("repo:{slug}")),
            );
            Err(e)
        }
    }
}

/// Removes one worktree of one repository, then prunes stale registrations (N1-1).
///
/// The path arrives from the renderer, so it is the *caller's* string: this is the
/// only command in the app that deletes a directory it was handed rather than one
/// it derived, which is why [`crate::gitwt::check_worktree_target`] — one level inside
/// `<项目根>\_worktrees`, the mirror of [`launch::check_venv_target`] — runs before
/// anything touches git.
#[tauri::command]
pub async fn remove_repo_worktree(
    slug: String,
    path: String,
    force: bool,
) -> Result<crate::gitwt::RemoveReport, String> {
    // Cloned *into* the worker rather than moved: the activity record below needs the
    // caller's own `slug`/`path` strings to say what was asked for, including on the
    // failure path where the only useful thing to report is the path that was refused.
    let slug_job = slug.clone();
    let path_job = path.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (repo, root) = crate::repo_and_root(&slug_job)?;
        crate::gitwt::remove(&repo, &root, std::path::Path::new(&path_job), force)
    })
    .await
    .map_err(|e| format!("删除工作树任务异常: {e}"))?;
    match &out {
        Ok(report) => crate::record_activity(
            crate::Log::new(
                "delete",
                if report.removed {
                    if force {
                        "删除工作树（强制，含未提交内容）"
                    } else {
                        "删除工作树"
                    }
                } else {
                    "删除工作树未完成"
                },
                crate::SRC_LAUNCH,
            )
            .detail(&format!(
                "{}；{}清理了 {} 条陈旧登记{}",
                report
                    .branch
                    .as_ref()
                    .map(|b| format!("分支 {b}，"))
                    .unwrap_or_default(),
                if report.removed { "" } else { "没有删除目录，" },
                report.pruned,
                report
                    .failed
                    .first()
                    .map(|f| format!("；git 的回答：{f}"))
                    .unwrap_or_default()
            ))
            .slug(&slug)
            .target(&format!("repo:{slug}"))
            .path_str(&report.path)
            // The asymmetry the round-16 matrix asked to be spelled out: creating a
            // worktree can be undone by removing it, removing one cannot be undone
            // by anything in this app. `git worktree remove` deletes the tree with
            // git's own `rm -rf`, and a `git checkout <sha>` afterwards would
            // restore commits — never the uncommitted work `--force` destroyed.
            .undo(crate::activity::Undo::none(if report.removed {
                "工作树目录是 git 自己删的，不进回收站也不留副本；它上面的分支还在仓库里，用 git checkout 可以再把目录建出来，但没有提交的内容找不回来"
            } else {
                "没有删除任何目录，所以没有需要撤销的动作；git 的登记已经按上面说的清理过"
            })),
        ),
        Err(e) => crate::record_activity(
            crate::Log::new("delete", "删除工作树失败", crate::SRC_LAUNCH)
                .detail(e)
                .slug(&slug)
                .target(&format!("repo:{slug}"))
                .path_str(&path),
        ),
    }
    out
}

