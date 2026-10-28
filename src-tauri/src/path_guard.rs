//! Containment for every path the webview hands to a filesystem command.
//!
//! ## Why this module exists
//!
//! `write_text_file`, `read_text_file` and `export_activity` all accept an
//! absolute path from the page, and the check in front of them was
//! `path.contains("..")` - which accepts `C:\Users\<me>\AppData\...` outright.
//! Two consequences were reachable on a running app, not theoretical:
//! `read_text_file` could read `devhub-config.json` itself (which holds the
//! GitHub token in plaintext), and `write_text_file` could drop a `.lnk` into
//! `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`.
//!
//! So the rule is containment rather than pattern-matching: canonicalize first -
//! which is what resolves junctions, symlinks and any remaining `..` - and then
//! admit the path only when it sits inside a directory the app already works in.
//! The one command that already did this (`delete_downloaded`) kept its own copy
//! of the check; the point of putting the rule in a module is that the rest of the
//! filesystem surface can now share it instead of reimplementing it.
//!
//! ## What this module does NOT do
//!
//! It does not restrict the app's own writes (the downloader creates directories
//! by design), and the denylist is about DevHub's own files, not about user data.
//! The deny exists because the app's config directory is an allowed root - the
//! token file sits inside a directory the user is permitted to export into - so
//! containment alone would not protect it.

use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::{downloader, netpath};

/// Which side of the operation the path is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The target must already exist and canonicalize on its own.
    Read,
    /// The leaf may not exist yet: a save dialog hands back a fresh filename, and
    /// a download's landing directory is usually not created until git runs. The
    /// nearest existing ancestor is canonicalized instead.
    Write,
}

/// Why a path was refused.
///
/// Typed rather than a bare `String` because the code is what stays stable while
/// the wording is user-facing: a future caller that needs to branch on the reason
/// (or log it) has something to branch on, and the tests assert on the code
/// instead of on a sentence someone may rephrase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    /// A `..` path *segment* in a page-supplied path. Rejected before
    /// canonicalization so the answer does not depend on how the OS spells the
    /// parent of a root. A `..` inside a *name* (`..cache`, `a..b`) is not a
    /// segment and is not rejected here: the containment check that follows is
    /// the real boundary, and the substring form wrongly refused such names.
    Traversal,
    /// An empty or whitespace-only path.
    Empty,
    /// Canonicalized, but inside none of the allowed roots.
    Outside { shown: String, roots: usize },
    /// One of DevHub's own files, which stays refused even inside an allowed root.
    Denied { shown: String },
    /// Read of something that is not there (or not resolvable).
    Missing { shown: String },
}

impl GuardError {
    /// The stable machine-readable reason.
    pub fn code(&self) -> &'static str {
        match self {
            GuardError::Traversal => "traversal",
            GuardError::Empty => "empty",
            GuardError::Outside { .. } => "outside-roots",
            GuardError::Denied { .. } => "denied",
            GuardError::Missing { .. } => "missing",
        }
    }

    /// The sentence shown to the user. Names the path it rejected so a refusal is
    /// diagnosable without a devtools console.
    pub fn message(&self) -> String {
        match self {
            GuardError::Traversal => "路径包含非法字符".to_string(),
            GuardError::Empty => "路径为空".to_string(),
            GuardError::Outside { shown, roots } => format!(
                "拒绝访问：{shown} 不在 DevHub 允许的目录内（已检查 {roots} 个：项目目录及其附加/历史目录、应用配置目录、系统临时目录、桌面/文档/下载）",
            ),
            GuardError::Denied { shown } => format!(
                "拒绝访问：{shown} 是 DevHub 自己的配置文件，只能由设置页读写",
            ),
            GuardError::Missing { shown } => format!("路径不存在或无法解析：{shown}"),
        }
    }
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message(), self.code())
    }
}

/// DevHub's own files, by file name.
///
/// Matched on the name rather than the full path because `.devhub.json` markers
/// exist in every downloaded repository: the rule is "this file belongs to the
/// container's machinery", not "this one specific file".
fn is_denied_name(path: &Path) -> bool {
    path.file_name()
        .map(|n| n == "devhub-config.json" || n == ".devhub.json")
        .unwrap_or(false)
}

/// Canonicalizes `target`, falling back to the nearest existing ancestor.
///
/// A path whose leaf does not exist yet cannot be canonicalized, so for a write
/// target the longest existing prefix is resolved and the remainder re-attached.
/// Resolving the prefix rather than the raw string is the point: a junction or a
/// symlink one level up is only visible once the OS has expanded it.
fn canonicalize_partial(target: &Path) -> Option<PathBuf> {
    if let Ok(canon) = target.canonicalize() {
        return Some(canon);
    }
    let mut ancestor = target.parent()?;
    loop {
        if let Ok(canon) = ancestor.canonicalize() {
            let rest = target.strip_prefix(ancestor).ok()?;
            return Some(canon.join(rest));
        }
        ancestor = ancestor.parent()?;
    }
}

/// The shared containment core: canonical root + canonical target, or why not.
///
/// Comparison happens in canonical (`\\?\`) form on both sides, exactly as the
/// delete check has always done it: `strip_verbatim` is for messages only, and
/// mixing the two spellings is how a check silently stops matching.
fn resolve_in_roots(
    roots: &[PathBuf],
    target: &Path,
    access: Access,
) -> Result<(PathBuf, PathBuf), GuardError> {
    let shown = netpath::strip_verbatim(target).display().to_string();
    if access == Access::Read && !target.exists() {
        return Err(GuardError::Missing { shown });
    }
    let canon = canonicalize_partial(target).ok_or_else(|| GuardError::Missing {
        shown: shown.clone(),
    })?;

    for root in roots {
        let Ok(root_canon) = root.canonicalize() else {
            continue;
        };
        if canon.starts_with(&root_canon) {
            return Ok((root_canon, canon));
        }
    }
    Err(GuardError::Outside {
        shown,
        roots: roots.len(),
    })
}

/// True when `..` is a whole path *segment* — the actual traversal — under
/// either separator. A `..` that is merely inside a name (`..cache`, `a..b`,
/// `C:\`) is not a segment: the old `trimmed.contains("..")` refused those too,
/// and the refusal was wrong because the containment check below is the real
/// boundary and a directory named `..cache` inside an allowed root is just a
/// directory.
fn contains_dotdot_segment(path: &str) -> bool {
    path.split(|c| c == '\\' || c == '/').any(|seg| seg == "..")
}

/// Checks one page-supplied path against `roots`.
///
/// Returns the canonical path, so the caller performs its I/O on exactly the
/// thing that was checked rather than on the string it was given.
///
/// Denied names are checked on both the raw and the canonical spelling: the raw
/// one catches `devhub-config.json` sitting in the temp dir, the canonical one
/// catches a junction that lands on it from an allowed directory.
pub fn check(roots: &[PathBuf], raw: &str, access: Access) -> Result<PathBuf, GuardError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GuardError::Empty);
    }
    if contains_dotdot_segment(trimmed) {
        return Err(GuardError::Traversal);
    }
    let target = Path::new(trimmed);
    let shown = || netpath::strip_verbatim(target).display().to_string();
    if is_denied_name(target) {
        return Err(GuardError::Denied { shown: shown() });
    }
    let (_root, canon) = resolve_in_roots(roots, target, access)?;
    if is_denied_name(&canon) {
        return Err(GuardError::Denied {
            shown: netpath::strip_verbatim(&canon).display().to_string(),
        });
    }
    Ok(canon)
}

/// Every directory the container lists repositories from: the main root, the
/// extra roots, and the roots the user has switched away from.
///
/// `recent_roots` is included deliberately: 设置 → 项目目录 offers "switch back"
/// with a path that is not in `extra_roots`, and refusing a download into the
/// directory the picker just named would read as a bug, not as a protection.
pub fn container_roots() -> Vec<PathBuf> {
    let mut out = crate::project_roots();
    let cfg = crate::read_config();
    for extra in cfg.recent_roots {
        let p = PathBuf::from(extra.trim());
        if !p.as_os_str().is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Roots DevHub owns outright, resolved through Tauri so they follow the OS's
/// own answer rather than an environment variable a caller can set.
pub fn app_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Where `devhub-config.json` and the activity log actually live: beside the
    // executable, which is why the denylist in `check` exists at all.
    let config = crate::config_path();
    if let Some(dir) = config.parent() {
        out.push(dir.to_path_buf());
    }
    let path = app.path();
    for dir in [
        path.app_config_dir(),
        path.app_data_dir(),
        path.temp_dir(),
        path.desktop_dir(),
        path.document_dir(),
        path.download_dir(),
    ] {
        if let Ok(p) = dir {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// The guard the three text endpoints call: assembles the live roots and checks.
///
/// The error keeps its machine-readable `code()` (`Display` = `message (code)`),
/// because `code()` exists precisely so a caller can tell *which* containment rule
/// refused. Flattening it to `message()` threw the code away at the one boundary the
/// frontend ever sees, leaving string-matching on Chinese prose as the only way to
/// distinguish "outside the container" from "the path does not exist".
pub fn guard(app: &tauri::AppHandle, raw: &str, access: Access) -> Result<PathBuf, String> {
    let mut roots = container_roots();
    roots.extend(app_roots(app));
    check(&roots, raw, access).map_err(|e| e.to_string())
}

/// Which repository a download record is allowed to delete, resolved from disk
/// rather than trusted from the record.
///
/// This is the same containment `check` performs, with one requirement added on
/// top: the directory must also be one the container lists as a project. It lives
/// here rather than beside its only caller so the download commands and the
/// delete command answer "is this inside the container?" with one implementation.
///
/// ## The rule is the container's own
///
/// The target must be a directory the app itself would call a project: one that
/// `downloader::collect_repos` reports under a configured root (a git repository
/// that is not inside DevHub's own `venvs`/`cache`/`runtime`/`_worktrees`/
/// `_bootstrap` directories), **or** one carrying this app's `.devhub.json`
/// marker — an archive download has no `.git`, so the walk alone would not see
/// the directory the downloader just created.
///
/// Depth arithmetic was the first attempt here, and the test for it caught the
/// hole: `venvs/<name>` is exactly two components deep, so "at least two levels
/// inside the root" would have let a 回退 delete another project's environment,
/// while the legacy layout `code/<host>/<owner>/<repo>` is four. The reserved
/// list and the repository walk are what actually distinguish a project from
/// DevHub's own files.
///
/// Both returned paths stay in canonical (`\\?\`) form on purpose: `delete_repo`
/// compares the repository's parent against the root when it prunes an emptied
/// owner directory, and mixing normal forms would silently disable that cleanup.
/// Canonical is also the spelling that survives paths past `MAX_PATH`, which a
/// checked-out `node_modules` routinely reaches. Error messages strip the prefix.
enum Refusal {
    /// The record named a project root itself.
    RootItself,
    /// Inside a root, but under one of DevHub's own directories.
    Reserved,
    /// Inside a root, but not a directory the container lists as a project.
    NotAProject,
}

pub fn check_delete_target(
    roots: &[PathBuf],
    target: &std::path::Path,
) -> Result<(PathBuf, PathBuf), String> {
    if target.as_os_str().is_empty() {
        return Err("这条记录没有记下下载位置，无法回退".to_string());
    }
    let canon = target.canonicalize().map_err(|_| {
        format!(
            "下载目录 {} 已不存在，可能已被手动删除，无需回退",
            netpath::strip_verbatim(target).display()
        )
    })?;
    let shown = netpath::strip_verbatim(&canon).display().to_string();

    // A directory can sit inside more than one configured root when the user
    // points the container at nested directories, so the first root that raises
    // an objection must not decide the answer before the others are asked.
    let mut objection: Option<(Refusal, PathBuf)> = None;
    for root in roots {
        let Ok(root_canon) = root.canonicalize() else {
            continue;
        };
        let rel = match canon.strip_prefix(&root_canon) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            objection.get_or_insert((Refusal::RootItself, netpath::strip_verbatim(&root_canon)));
            continue;
        }
        let first = rel
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_default();
        if downloader::is_reserved_dir(&first) {
            objection.get_or_insert((Refusal::Reserved, netpath::strip_verbatim(&root_canon)));
            continue;
        }

        let want = rel_key(&rel);
        let mut listed = false;
        downloader::collect_repos(&root_canon, &mut |r, _| {
            if rel_key(r) == want {
                listed = true;
            }
        });
        if listed || downloader::read_marker(&canon).is_some() {
            return Ok((root_canon, canon));
        }
        objection.get_or_insert((Refusal::NotAProject, netpath::strip_verbatim(&root_canon)));
    }

    match objection {
        Some((Refusal::RootItself, root)) => Err(format!(
            "拒绝删除：{shown} 就是项目根目录 {root} 本身，回退只能删除其中一个项目",
            root = root.display()
        )),
        Some((Refusal::Reserved, root)) => Err(format!(
            "拒绝删除：{shown} 位于 {root} 下 DevHub 自己的目录里（venvs、cache、runtime、_worktrees、_bootstrap），回退不能碰",
            root = root.display()
        )),
        Some((Refusal::NotAProject, root)) => Err(format!(
            "拒绝删除：{shown} 不是 {root} 下列出的项目目录（既没有 .git 也没有 .devhub.json），回退只删除下载产生的仓库本体，不删仓库内部的子目录",
            root = root.display()
        )),
        None => Err(format!(
            "拒绝删除：{shown} 不在任何项目根目录内（已检查 {} 个）",
            roots.len()
        )),
    }
}

/// A relative path in the form the container's own walk can be compared against:
/// separators unified and case folded, because `canonicalize` does not promise
/// the spelling `read_dir` reported and Windows names are case-insensitive.
fn rel_key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch tree under the OS temp dir, removed on drop.
    ///
    /// Not `temp_dir().join("devhub-guard-test")` shared between tests: `cargo test`
    /// runs cases in parallel, and two of them creating or deleting the same
    /// directory turns a real pass into a flaky one.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let mut root = std::env::temp_dir();
            root.push(format!(
                "devhub-guard-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("scratch root");
            Scratch { root }
        }
        fn join(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn admits_a_path_inside_the_project_root() {
        let scratch = Scratch::new("inside");
        let file = scratch.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let roots = vec![scratch.root.clone()];
        let got = check(&roots, &s(&file), Access::Read).expect("inside the root");
        assert_eq!(
            netpath::strip_verbatim(&got),
            netpath::strip_verbatim(&file.canonicalize().unwrap())
        );
    }

    #[test]
    fn admits_a_new_write_target_whose_parent_is_inside_a_root() {
        let scratch = Scratch::new("newfile");
        let file = scratch.join("export/report.md");
        let roots = vec![scratch.root.clone()];
        // The leaf and one whole directory level above it do not exist yet, which
        // is what a save dialog hands back.
        let got = check(&roots, &s(&file), Access::Write).expect("fresh name in an allowed dir");
        assert!(got.to_string_lossy().ends_with("report.md"), "got {got:?}");
    }

    #[test]
    fn rejects_dot_dot_traversal() {
        let scratch = Scratch::new("traversal");
        let sneaky = format!("{}\\..\\escape.txt", s(&scratch.root));
        let roots = vec![scratch.root.clone()];
        let err = check(&roots, &sneaky, Access::Write).unwrap_err();
        assert_eq!(err.code(), "traversal");
        // The wording the old check used is kept, so a toast nobody relearns.
        assert_eq!(err.message(), "路径包含非法字符");
    }

    #[test]
    fn dot_dot_inside_a_name_is_not_traversal() {
        let scratch = Scratch::new("dotname");
        // `..` as a *substring* of a filename is not a `..` segment: the old
        // `contains("..")` refused this, but the containment check is the real
        // boundary, and `a..b.txt` inside the root is just a file.
        let file = scratch.root.join("a..b.txt");
        std::fs::write(&file, "x").unwrap();
        let roots = vec![scratch.root.clone()];
        let got = check(&roots, &s(&file), Access::Read)
            .expect("a .. substring in a name is not traversal");
        assert_eq!(got, file.canonicalize().unwrap());
    }

    #[test]
    fn contains_dotdot_segment_is_segment_based() {
        // Real traversal segments are caught.
        assert!(contains_dotdot_segment(r"C:\root\..\x"));
        assert!(contains_dotdot_segment("a/../b"));
        assert!(contains_dotdot_segment(".."));
        // `..` inside a name is not a segment.
        assert!(!contains_dotdot_segment(r"C:\root\..cache\x"));
        assert!(!contains_dotdot_segment(r"C:\root\a..b\x"));
        assert!(!contains_dotdot_segment("C:\\"));
    }

    #[test]
    fn rejects_an_absolute_path_outside_every_root() {
        let scratch = Scratch::new("outside");
        let roots = vec![scratch.root.clone()];
        // Named in the report: the exact Start Menu startup-folder drop the old
        // `contains("..")` check accepted, plus two more it also accepted.
        for probe in [
            r"C:\Users\victim\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\evil.lnk",
            r"C:\Windows\System32\drivers\etc\hosts",
            r"D:\somebody-elses-project\secret.txt",
        ] {
            let err = check(&roots, probe, Access::Write).unwrap_err();
            assert_eq!(err.code(), "outside-roots", "{probe} : {err:?}");
            // The sentence has to name the path it refused, or the toast is useless.
            assert!(err.message().contains(probe), "{probe} : {}", err.message());
        }
    }

    #[test]
    fn rejects_a_read_of_a_path_that_is_not_there() {
        let scratch = Scratch::new("missing");
        let roots = vec![scratch.root.clone()];
        let err = check(&roots, &s(&scratch.join("nope.txt")), Access::Read).unwrap_err();
        assert_eq!(err.code(), "missing");
    }

    #[test]
    fn denies_the_app_config_file_and_the_repo_marker() {
        let scratch = Scratch::new("deny");
        // Both live *inside* an allowed root: the deny has to win over containment.
        let config = scratch.join("devhub-config.json");
        let marker = scratch.join("repo/.devhub.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&config, "{\"githubToken\":\"ghp_secret\"}").unwrap();
        std::fs::write(&marker, "{}").unwrap();

        let roots = vec![scratch.root.clone()];
        for probe in [&config, &marker] {
            let err = check(&roots, &s(probe), Access::Read).unwrap_err();
            assert_eq!(err.code(), "denied", "{probe:?} : {err:?}");
        }
        // The same two names reached through a different spelling still deny.
        assert!(is_denied_name(Path::new(
            r"\\?\C:\Users\me\AppData\Roaming\devhub-config.json"
        )));
        assert!(is_denied_name(Path::new("/tmp/repo/.devhub.json")));
        // And an ordinary repository file is not denied.
        assert!(!is_denied_name(Path::new("/tmp/repo/README.md")));
    }

    /// Creates a directory junction, which is the escape that needs no elevation on
    /// Windows (`symlink_dir` does, so it silently does not run on most machines).
    /// Returns false when the machine refuses both kinds of link.
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> bool {
        let made_by_cmd = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.as_os_str())
            .arg(target.as_os_str())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        made_by_cmd || std::os::windows::fs::symlink_dir(target, link).is_ok()
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_root_does_not_widen_it() {
        // The escape this guard exists for: an allowed directory that *contains* a
        // link to somewhere else. `canonicalize` resolves the link, so containment
        // is decided on the real target rather than on the spelling the page used.
        let scratch = Scratch::new("junction");
        let inside = scratch.join("inside");
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "ghp_leaked").unwrap();

        let link = inside.join("link");
        if !link_dir(&outside, &link) {
            // Reported, not hidden: a skipped test must not read as a pass.
            eprintln!("SKIPPED a_junction: this machine refuses link creation");
            return;
        }
        let roots = vec![inside.clone()];
        let err = check(&roots, &s(&link.join("secret.txt")), Access::Read)
            .expect_err("the canonical target is outside `inside`");
        assert_eq!(err.code(), "outside-roots", "{err:?}");
    }

    #[test]
    fn a_download_landing_directory_is_contained_by_the_same_rule() {
        // `download_repo` / `preview_ref` take the landing directory as free text
        // from 高级选项. Same helper, same answer: inside the container is fine even
        // when the directory does not exist yet, anywhere else is refused.
        let scratch = Scratch::new("landing");
        let roots = vec![scratch.root.clone()];
        let inside = scratch.join("myrepo_octocat");
        assert!(check(&roots, &s(&inside), Access::Write).is_ok());

        for probe in [
            r"C:\Users\victim\source\repos\myrepo_octocat",
            r"D:\somebody-elses-project\myrepo_octocat",
        ] {
            let err = check(&roots, probe, Access::Write).unwrap_err();
            assert_eq!(err.code(), "outside-roots", "{probe} : {err:?}");
        }
    }

    #[test]
    fn the_verbatim_prefix_does_not_change_the_answer() {
        // `canonicalize` hands back `\\?\C:\...`; a path written that way must not
        // be treated as a different, unresolvable location.
        let scratch = Scratch::new("verbatim");
        let file = scratch.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let roots = vec![scratch.root.clone()];
        let plain = check(&roots, &s(&file), Access::Read).unwrap();
        // Built from the stripped spelling, because a doubled `\\?\` is a path that
        // genuinely does not exist and the guard would be right to refuse it.
        let verbatim = format!(
            "\\\\?\\{}",
            s(&netpath::strip_verbatim(&file.canonicalize().unwrap()))
        );
        let again = check(&roots, &verbatim, Access::Read)
            .unwrap_or_else(|e| panic!("{verbatim} : {e}"));
        assert_eq!(plain, again);
    }
}
