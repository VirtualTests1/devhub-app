//! 仓库内容全文搜索（N2）。
//!
//! 这是一个轻量的文件内容 grep——按目录递归读取文件、正则匹配、返回命中行。
//! 当前实现不依赖 Tantivy（见 R1 方向），用 Rust 标准库 walkdir 替代，
//! 单仓库小目录（几千文件以内）上毫秒级返回。
//!
//! 返回格式：每条命中一条 `{file, line_number, line_content}`，
//! 前端收到后可按文件分组、高亮显示。

use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use walkdir::WalkDir;

#[derive(serde::Serialize, Debug)]
pub struct GrepHit {
    pub file: String,
    pub line: usize,
    pub content: String,
}

#[derive(serde::Serialize, Debug)]
pub struct GrepResult {
    pub pattern: String,
    pub root: String,
    pub files_scanned: usize,
    /// Files deliberately not scanned: above [`MAX_FILE_BYTES`], or carrying a
    /// NUL byte in their first [`BINARY_SNIFF_BYTES`] bytes (a text editor's
    /// "binary" heuristic). Read failures are *not* counted here — they are not
    /// a policy decision, and the existing contract treats them as "attempted".
    pub files_skipped: usize,
    pub hits: Vec<GrepHit>,
    pub elapsed_ms: u128,
    pub error: Option<String>,
    /// `limit` stopped the scan (the hits are a prefix, not the whole answer).
    pub truncated: bool,
    /// The single-repository deadline expired before every candidate was read.
    pub timed_out: bool,
}

/// 默认忽略的目录名（git/构建产物/依赖）。
/// `pub(crate)`：r3-1 基准（tantivy_idx.rs 的 bench）复用这两张表做同口径对照，
/// 保证基准扫的文件集与生产 `repo_grep` 完全一致，而不是另抄一份然后悄悄漂移。
pub(crate) const IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
    ".worktrees",
];

/// 默认只搜索这些扩展名（复用方同上：r3-1 基准的文件清单口径）。
pub(crate) const INCLUDE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "json", "toml", "md", "py", "html", "css",
    "scss", "yml", "yaml", "xml", "txt", "go", "java", "c", "cpp", "h", "sh",
];

/// Upper bound on one candidate file's bytes.
///
/// The extension whitelist admits `json`, `txt` and generated bundles, not just
/// source; a 2 GB text file would otherwise be read into memory in full on a
/// grep keystroke. 1 MiB is larger than every hand-written source file in this
/// repo and small enough that four parallel chunk scans stay bounded.
pub(crate) const MAX_FILE_BYTES: u64 = 1_048_576;

/// How much of a file is sniffed for NUL before reading the rest.
///
/// Same size Git uses for its binary heuristic (8 KiB). A UTF-16 file starts
/// with NUL bytes in this window and is skipped rather than decoded as lossy
/// UTF-8, which would produce hits whose reported text is not the file's.
pub(crate) const BINARY_SNIFF_BYTES: usize = 8192;

/// Rust 后端命令：在一个目录（通常是某个克隆的仓库根）里搜索 pattern。
#[tauri::command(async)]
pub fn repo_grep(
    slug: String,
    pattern: String,
    case_insensitive: Option<bool>,
    limit: Option<usize>,
) -> GrepResult {
    let roots = crate::project_roots();
    let root = crate::repo_index::find(&roots, &slug).0;
    let Some(root) = root else {
        return GrepResult {
            pattern,
            root: slug.clone(),
            files_scanned: 0,
            files_skipped: 0,
            hits: Vec::new(),
            elapsed_ms: 0,
            error: Some(format!("未找到仓库：{slug}")),
            truncated: false,
            timed_out: false,
        };
    };
    // The page names a repository, never a filesystem path: `repo_index` resolves
    // it to one the container owns, so a compromised webview cannot ask this
    // command to read `C:\Users\...\devhub-config.json` (the old `root` argument
    // did exactly that). The deadline and the clamped limit bound one scan even
    // when the repository is huge or lives on a slow share.
    grep_root(
        &root,
        &root.to_string_lossy(),
        &pattern,
        case_insensitive.unwrap_or(false),
        limit.unwrap_or(SINGLE_LIMIT_DEFAULT).clamp(1, SINGLE_LIMIT_MAX),
        Some(Instant::now() + SINGLE_DEADLINE),
    )
}

/// Default hit cap for one repository (also the UI's explicit `GREP_LIMIT`).
const SINGLE_LIMIT_DEFAULT: usize = 500;
/// Hard ceiling even if a page asks for more; the IPC payload is one dialog.
const SINGLE_LIMIT_MAX: usize = 2_000;
/// One repository's scan budget. The batch path has its own 15 s deadline; this
/// gives the single dialog the same "partial results, labelled as partial" shape.
const SINGLE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// One repository's scan, shared by the single-root command and the batch one.
///
/// `deadline` is checked before each file; the batch path uses it so one huge
/// repository cannot hold the whole request, while the single-root command keeps
/// its original "scan what the user named" semantics (`None`).
pub(crate) fn grep_root(
    root_path: &Path,
    root_label: &str,
    pattern: &str,
    ci: bool,
    limit: usize,
    deadline: Option<Instant>,
) -> GrepResult {
    let start = Instant::now();
    let re = match compile_pattern(pattern, ci) {
        Ok(re) => re,
        Err(e) => {
            return GrepResult {
                pattern: pattern.to_string(),
                root: root_label.to_string(),
                files_scanned: 0,
                files_skipped: 0,
                hits: vec![],
                elapsed_ms: start.elapsed().as_millis(),
                error: Some(e),
                truncated: false,
                timed_out: false,
            };
        }
    };

    if !root_path.is_dir() {
        return GrepResult {
            pattern: pattern.to_string(),
            root: root_label.to_string(),
            files_scanned: 0,
            files_skipped: 0,
            hits: vec![],
            elapsed_ms: start.elapsed().as_millis(),
            error: Some(format!("目录不存在：{root_label}")),
            truncated: false,
            timed_out: false,
        };
    }

    // 收集候选文件路径——WalkDir + 过滤目录 + 过滤扩展名。
    //
    // `filter_entry`, not `filter`: the old `filter` dropped an ignored
    // directory's own entry but still walked into it, so `node_modules/**/*.js`
    // and `.git/**` were candidates and got read. The only thing that kept the
    // reported numbers small was `max_depth(8)`. `filter_entry` is the WalkDir
    // API that actually prunes the subtree. Non-files are excluded after the
    // walk: directories are not candidates, and symlinks are not followed (a
    // repository can point one at anything the user can read).
    let candidates: Vec<PathBuf> = WalkDir::new(root_path)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !e.file_type().is_dir()
                || !IGNORE_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            let path = e.path();
            e.file_type().is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| INCLUDE_EXTS.contains(&ext.to_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .map(|e| e.into_path())
        .collect();

    let outcome = scan_candidates(candidates, &re, root_path, limit, deadline);

    GrepResult {
        pattern: pattern.to_string(),
        root: root_label.to_string(),
        files_scanned: outcome.scanned,
        files_skipped: outcome.skipped,
        hits: outcome.hits,
        elapsed_ms: start.elapsed().as_millis(),
        error: None,
        truncated: outcome.truncated,
        timed_out: outcome.timed_out,
    }
}

/// Compile once per request, with the case flag carried by the pattern.
fn compile_pattern(pattern: &str, ci: bool) -> Result<Regex, String> {
    Regex::new(&if ci {
        format!("(?i){pattern}")
    } else {
        pattern.to_string()
    })
    .map_err(|e| format!("正则编译失败：{e}"))
}

/// Bounds for the cross-repository command. Every one of these is a number the
/// UI can explain when it truncates; none is a silent clamp.
pub(crate) const BATCH_MAX_REPOS: usize = 200;
pub(crate) const BATCH_PER_REPO_HITS: usize = 50;
pub(crate) const BATCH_TOTAL_HITS: usize = 1000;
const BATCH_DEADLINE_MS: u64 = 15_000;

#[derive(serde::Serialize, Debug)]
pub struct GrepGroup {
    pub slug: String,
    pub root: String,
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub hits: Vec<GrepHit>,
    pub error: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct GrepBatchResult {
    pub pattern: String,
    pub groups: Vec<GrepGroup>,
    pub total_hits: usize,
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub elapsed_ms: u128,
    /// One of the caps stopped the scan; the groups still say what was found.
    pub truncated: bool,
    /// The deadline expired before every repository was reached.
    pub timed_out: bool,
    /// The caller asked to stop; groups already collected are still returned.
    pub cancelled: bool,
    pub repositories_skipped: usize,
    pub error: Option<String>,
}

/// Cancellation tokens for in-flight cross-repository searches, keyed by the
/// frontend's task id. Same shape as `DownloadCancels`: the worker flips it
/// between repositories, and a request that is already gone is a no-op.
#[derive(Default)]
pub(crate) struct GrepCancels(Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>);

impl GrepCancels {
    fn insert(&self, task: &str, token: Arc<AtomicBool>) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(task.to_string(), token);
        }
    }

    fn cancel(&self, task: &str) -> bool {
        let token = self.0.lock().ok().and_then(|map| map.get(task).cloned());
        match token {
            Some(token) => {
                token.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    fn remove(&self, task: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(task);
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_repo_grep(cancels: tauri::State<'_, GrepCancels>, task: String) -> bool {
    cancels.cancel(&task)
}

/// Cross-repository search with a per-request budget.
///
/// Deliberately **not** the search-relevance path: this returns every matching
/// line in every named repository, and the caller asked for that scope. The
/// bakeoff that ruled `repo_grep` out for ranking (r21-N1) still holds — this
/// command is not a ranking source and the UI labels it as a line search.
#[tauri::command]
pub async fn repo_grep_many(
    app: tauri::AppHandle,
    cancels: tauri::State<'_, GrepCancels>,
    task: Option<String>,
    slugs: Vec<String>,
    pattern: String,
    case_insensitive: Option<bool>,
    per_repo_limit: Option<usize>,
    total_limit: Option<usize>,
) -> Result<GrepBatchResult, String> {
    use tauri::Emitter;
    let start = Instant::now();
    let task_id = task.unwrap_or_else(|| "grep".to_string());
    let token = Arc::new(AtomicBool::new(false));
    cancels.insert(&task_id, token.clone());
    let roots = crate::project_roots();
    let skipped = slugs.len().saturating_sub(BATCH_MAX_REPOS);
    let entries: Vec<(String, PathBuf)> = slugs
        .into_iter()
        .take(BATCH_MAX_REPOS)
        .map(|slug| {
            let path = crate::repo_index::find(&roots, &slug).0;
            (slug, path.unwrap_or_default())
        })
        .collect();
    let per_repo = per_repo_limit
        .unwrap_or(BATCH_PER_REPO_HITS)
        .clamp(1, BATCH_PER_REPO_HITS);
    let total = total_limit.unwrap_or(BATCH_TOTAL_HITS).clamp(1, BATCH_TOTAL_HITS);
    let deadline = start + std::time::Duration::from_millis(BATCH_DEADLINE_MS);
    let task_for_events = task_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = |done: usize, total: usize, slug: &str| {
            app.emit(
                "grep://progress",
                serde_json::json!({
                    "task": task_for_events,
                    "done": done,
                    "total": total,
                    "slug": slug,
                }),
            )
            .ok();
        };
        let mut out = grep_many_roots(
            entries,
            &pattern,
            case_insensitive.unwrap_or(false),
            total,
            per_repo,
            deadline,
            &token,
            &mut progress,
        );
        out.repositories_skipped += skipped;
        out
    })
    .await
    .map_err(|e| format!("跨仓库搜索任务异常: {e}"))?;
    cancels.remove(&task_id);
    Ok(outcome)
}

/// The testable batch core: paths in, bounded groups out.
pub(crate) fn grep_many_roots(
    entries: Vec<(String, PathBuf)>,
    pattern: &str,
    ci: bool,
    total_limit: usize,
    per_repo_limit: usize,
    deadline: Instant,
    cancelled: &AtomicBool,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> GrepBatchResult {
    let start = Instant::now();
    if let Err(e) = compile_pattern(pattern, ci) {
        return GrepBatchResult {
            pattern: pattern.to_string(),
            groups: Vec::new(),
            total_hits: 0,
            files_scanned: 0,
            files_skipped: 0,
            elapsed_ms: start.elapsed().as_millis(),
            truncated: false,
            timed_out: false,
            cancelled: false,
            repositories_skipped: 0,
            error: Some(e),
        };
    }

    let mut groups = Vec::new();
    let mut total_hits = 0usize;
    let mut files_scanned = 0usize;
    let mut files_skipped = 0usize;
    let mut timed_out = false;
    let mut truncated = false;
    let mut was_cancelled = false;
    let total_repos = entries.len();
    let mut done = 0usize;

    for (slug, path) in entries {
        if cancelled.load(Ordering::SeqCst) {
            was_cancelled = true;
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        if total_hits >= total_limit {
            truncated = true;
            break;
        }
        if path.as_os_str().is_empty() {
            groups.push(GrepGroup {
                slug: slug.clone(),
                root: String::new(),
                files_scanned: 0,
                files_skipped: 0,
                hits: Vec::new(),
                error: Some("未找到仓库".to_string()),
            });
            done += 1;
            progress(done, total_repos, &slug);
            continue;
        }
        let remaining = (total_limit - total_hits).min(per_repo_limit);
        let mut result = grep_root(
            &path,
            &path.to_string_lossy(),
            pattern,
            ci,
            remaining,
            Some(deadline),
        );
        let expired = Instant::now() >= deadline;
        if result.hits.len() >= remaining {
            truncated = true;
        }
        total_hits += result.hits.len();
        files_scanned += result.files_scanned;
        files_skipped += result.files_skipped;
        groups.push(GrepGroup {
            slug: slug.clone(),
            root: result.root,
            files_scanned: result.files_scanned,
            files_skipped: result.files_skipped,
            hits: std::mem::take(&mut result.hits),
            error: result.error,
        });
        done += 1;
        progress(done, total_repos, &slug);
        if expired {
            timed_out = true;
            break;
        }
    }

    GrepBatchResult {
        pattern: pattern.to_string(),
        groups,
        total_hits,
        files_scanned,
        files_skipped,
        elapsed_ms: start.elapsed().as_millis(),
        truncated,
        timed_out,
        cancelled: was_cancelled,
        repositories_skipped: 0,
        error: None,
    }
}


/// Scan one file. Returns `(hits, skipped)`; `skipped` means a policy boundary
/// (size cap or binary sniff) refused it. A read failure is not a skip: the old
/// serial walk already treated it as "attempted", and the stats keep saying so.
fn scan_file(re: &Regex, path: &Path, root: &Path) -> (Vec<GrepHit>, bool) {
    let Ok(meta) = fs::metadata(path) else {
        return (Vec::new(), false);
    };
    if meta.len() > MAX_FILE_BYTES {
        return (Vec::new(), true);
    }
    let Ok(bytes) = fs::read(path) else {
        return (Vec::new(), false);
    };
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0) {
        return (Vec::new(), true);
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return (Vec::new(), true);
    };
    let display = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let mut hits = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if re.is_match(line) {
            hits.push(GrepHit {
                file: display.clone(),
                line: idx + 1,
                content: line.to_string(),
            });
        }
    }
    (hits, false)
}

/// Scan candidates in parallel while keeping the serial order of hits.
///
/// The chunk boundaries are static and results are concatenated in input order, so
/// two runs over the same tree produce the same list; `files_scanned` is the count
/// of files actually read (a file whose read fails is still attempted and counted,
/// exactly like the serial loop). `limit` caps each chunk locally and the final
/// truncation caps the whole result.
/// What one scan actually covered. The two booleans are part of the answer:
/// a prefix returned as if it were the whole repository is the failure this type
/// exists to make impossible.
struct ScanOutcome {
    hits: Vec<GrepHit>,
    scanned: usize,
    skipped: usize,
    truncated: bool,
    timed_out: bool,
}

fn scan_candidates(
    candidates: Vec<PathBuf>,
    re: &Regex,
    root: &Path,
    limit: usize,
    deadline: Option<Instant>,
) -> ScanOutcome {
    if candidates.is_empty() || limit == 0 {
        return ScanOutcome {
            hits: Vec::new(),
            scanned: 0,
            skipped: 0,
            truncated: false,
            timed_out: false,
        };
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(4)
        .min(candidates.len());
    let chunk_size = candidates.len().div_ceil(threads.max(1));
    let chunks: Vec<&[PathBuf]> = candidates.chunks(chunk_size.max(1)).collect();
    let per_chunk: Vec<(usize, usize, Vec<GrepHit>, bool, bool)> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                scope.spawn(move || {
                    let mut scanned = 0usize;
                    let mut skipped = 0usize;
                    let mut hits = Vec::new();
                    let mut truncated = false;
                    let mut timed_out = false;
                    for path in chunk {
                        if deadline.is_some_and(|d| Instant::now() >= d) {
                            timed_out = true;
                            break;
                        }
                        scanned += 1;
                        let (found, refused) = scan_file(re, path, root);
                        if refused {
                            skipped += 1;
                        }
                        hits.extend(found);
                        if hits.len() >= limit {
                            truncated = true;
                            break;
                        }
                    }
                    (scanned, skipped, hits, truncated, timed_out)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or((0, 0, Vec::new(), false, false)))
            .collect()
    });
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut skipped = 0usize;
    let mut truncated = false;
    let mut timed_out = false;
    for (n, refused, mut part, chunk_truncated, chunk_timed_out) in per_chunk {
        scanned += n;
        skipped += refused;
        truncated |= chunk_truncated;
        timed_out |= chunk_timed_out;
        hits.append(&mut part);
    }
    if hits.len() > limit {
        truncated = true;
    }
    hits.truncate(limit);
    ScanOutcome {
        hits,
        scanned,
        skipped,
        truncated,
        timed_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            // Under the crate's own target dir, not the OS temp dir: the test is
            // reproducible on a machine whose TEMP lives on a different volume,
            // and it never writes outside the checkout.
            let p = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("test-scratch")
                .join(format!("grep-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(p.join("src")).unwrap();
            for i in 0..12 {
                std::fs::write(p.join("src").join(format!("f{i:02}.rs")), format!("fn hit_{i}() {{}}
let x = {i};
")).unwrap();
            }
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn candidates(root: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .map(|e| e.into_path())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn parallel_scan_preserves_serial_order_and_respects_limit() {
        let s = Scratch::new("order");
        let re = Regex::new("fn hit_").unwrap();
        let files = candidates(&s.0);
        let full = scan_candidates(files.clone(), &re, &s.0, 1000, None);
        // Force a second scanning shape by asking for 3 threads' worth of chunks via a small limit.
        let limited = scan_candidates(files, &re, &s.0, 5, None);
        let serial = full.hits;
        assert_eq!(serial.len(), 12);
        assert_eq!(limited.hits.len(), 5);
        assert!(limited.truncated, "a limit hit must be reported, not silently short");
        assert!(!full.truncated && !full.timed_out, "a complete scan must not claim truncation");
        assert_eq!(full.scanned, 12);
        assert!(serial.windows(2).all(|w| w[0].file <= w[1].file), "hits must stay in walk order");
        assert!(limited.hits.iter().all(|h| re.is_match(&h.content)));
    }

    #[test]
    fn an_expired_deadline_is_reported_as_a_partial_scan() {
        let s = Scratch::new("deadline");
        let re = Regex::new("fn hit_").unwrap();
        let out = scan_candidates(candidates(&s.0), &re, &s.0, 1000, Some(Instant::now()));
        assert!(out.timed_out, "the caller must be able to say the scan was cut short");
        assert!(out.hits.is_empty(), "an expired deadline reads no files");
        assert_eq!(out.scanned, 0);
    }

    #[test]
    fn oversized_and_binary_files_are_skipped_and_counted() {
        let s = Scratch::new("limits");
        let root = s.0.join("limits");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("small.rs"), "fn hit() {}\n").unwrap();
        // One byte past the cap, with a matching line after the boundary: if the
        // cap were not applied, this file would contribute a hit.
        let mut big = vec![b'a'; MAX_FILE_BYTES as usize + 1];
        big.extend_from_slice(b"\nfn hit_big() {}\n");
        std::fs::write(root.join("big.rs"), big).unwrap();
        // NUL inside the sniff window: binary even though it starts as text.
        std::fs::write(root.join("bin.rs"), b"fn hit() {}\0\n").unwrap();

        let out = grep_root(&root, &root.to_string_lossy(), "fn hit", false, 100, None);

        assert!(out.error.is_none(), "unexpected error: {:?}", out.error);
        assert_eq!(out.files_scanned, 3, "all three are attempted");
        assert_eq!(out.files_skipped, 2, "oversized + binary are reported, not silent");
        assert_eq!(out.hits.len(), 1, "only the small text file can match");
        assert_eq!(out.hits[0].file, "small.rs");
    }

    #[test]
    fn the_command_resolves_a_slug_and_refuses_an_arbitrary_path() {
        // The old command took this string as the directory. It is now a slug
        // lookup: a path (or an unknown owner/repo) must produce an error, never
        // a scan of that path.
        let out = repo_grep(
            "D:\\Windows".to_string(),
            "password".to_string(),
            Some(false),
            Some(100),
        );
        assert!(out.error.is_some(), "a path is not a slug and must not be scanned");
        assert!(out.hits.is_empty());
        assert!(!out.truncated && !out.timed_out);
    }

    #[test]
    fn ignored_directories_are_pruned_not_merely_hidden() {
        let s = Scratch::new("prune");
        std::fs::create_dir_all(s.0.join("node_modules").join("pkg")).unwrap();
        std::fs::create_dir_all(s.0.join(".git")).unwrap();
        std::fs::write(s.0.join("node_modules").join("pkg").join("dep.js"), "fn hit_dep() {}\n")
            .unwrap();
        std::fs::write(s.0.join(".git").join("hook.ts"), "fn hit_git() {}\n").unwrap();

        let out = grep_root(&s.0, &s.0.to_string_lossy(), "fn hit_", false, 100, None);

        assert!(out.error.is_none(), "unexpected error: {:?}", out.error);
        assert_eq!(out.files_scanned, 12, "only the twelve src files are candidates");
        assert_eq!(out.hits.len(), 12);
        assert!(
            out.hits.iter().all(|h| h.file.starts_with("src")),
            "no hit may come from node_modules or .git: {:?}",
            out.hits.iter().map(|h| &h.file).collect::<Vec<_>>()
        );
    }
    #[test]
    fn batch_search_groups_by_repository_and_respects_caps() {
        let a = Scratch::new("batch-a");
        let b = Scratch::new("batch-b");
        let deadline = Instant::now() + std::time::Duration::from_secs(30);
        let mut progress: Vec<(usize, usize, String)> = Vec::new();
        let out = grep_many_roots(
            vec![
                ("owner/a".to_string(), a.0.clone()),
                ("owner/b".to_string(), b.0.clone()),
                ("owner/missing".to_string(), PathBuf::new()),
            ],
            "fn hit_",
            false,
            1000,
            5,
            deadline,
            &AtomicBool::new(false),
            &mut |done, total, slug| progress.push((done, total, slug.to_string())),
        );
        assert_eq!(progress, vec![(1, 3, "owner/a".to_string()), (2, 3, "owner/b".to_string()), (3, 3, "owner/missing".to_string())]);

        assert_eq!(out.groups.len(), 3);
        assert_eq!(out.groups[0].hits.len(), 5, "the per-repo cap must hold");
        assert_eq!(out.groups[1].hits.len(), 5);
        assert_eq!(out.total_hits, 10, "the total is what the groups actually carry");
        assert!(out.truncated, "reaching the per-repo cap is a visible truncation");
        assert_eq!(
            out.groups[2].error.as_deref(),
            Some("未找到仓库"),
            "a slug with no path is its own row, not a silent omission"
        );
        assert!(out.groups[0].hits.iter().all(|h| h.file.starts_with("src")));
    }

    #[test]
    fn batch_search_reports_an_invalid_pattern_once() {
        let s = Scratch::new("batch-invalid");
        let out = grep_many_roots(
            vec![("owner/a".to_string(), s.0.clone())],
            "(",
            false,
            10,
            10,
            Instant::now() + std::time::Duration::from_secs(30),
            &AtomicBool::new(false),
            &mut |_, _, _| {},
        );
        assert!(out.error.as_deref().unwrap_or("").contains("正则编译失败"));
        assert!(out.groups.is_empty(), "nothing is scanned when the pattern cannot compile");
    }

    #[test]
    fn a_cancelled_batch_returns_the_groups_already_found() {
        let s = Scratch::new("batch-cancel");
        let token = AtomicBool::new(true);
        let out = grep_many_roots(
            vec![("owner/a".to_string(), s.0.clone())],
            "fn hit_",
            false,
            1000,
            50,
            Instant::now() + std::time::Duration::from_secs(30),
            &token,
            &mut |_, _, _| {},
        );
        assert!(out.cancelled);
        assert_eq!(out.total_hits, 0);
        assert!(out.groups.is_empty());
        assert!(!out.timed_out, "cancellation is not a timeout");
    }

    #[test]
    fn an_expired_batch_deadline_stops_before_the_first_repository() {
        let s = Scratch::new("batch-deadline");
        let out = grep_many_roots(
            vec![("owner/a".to_string(), s.0.clone())],
            "fn hit_",
            false,
            1000,
            50,
            Instant::now() - std::time::Duration::from_secs(1),
            &AtomicBool::new(false),
            &mut |_, _, _| {},
        );
        assert!(out.timed_out);
        assert_eq!(out.total_hits, 0);
        assert!(out.groups.is_empty());
        assert!(out.error.is_none(), "a timeout is a boundary, not a broken pattern");
    }

    #[test]
    #[ignore = "benchmark; run with --ignored --nocapture"]
    fn bench_parallel_vs_serial_on_this_crate() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let re = Regex::new("fn ").unwrap();
        let files = candidates(&root);
        let t0 = std::time::Instant::now();
        let mut serial = Vec::new();
        for f in &files {
            serial.extend(scan_file(&re, f, &root).0);
        }
        let serial_ms = t0.elapsed().as_millis();
        let t1 = std::time::Instant::now();
        let parallel = scan_candidates(files.clone(), &re, &root, 100_000, None).hits;
        let parallel_ms = t1.elapsed().as_millis();
        println!("grep files={} hits={} serial={}ms parallel={}ms", files.len(), serial.len(), serial_ms, parallel_ms);
        assert_eq!(serial.len(), parallel.len(), "same candidate set and regex must find the same hits");
    }

}
