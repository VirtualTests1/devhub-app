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
#[tauri::command]
pub fn repo_grep(
    root: String,
    pattern: String,
    case_insensitive: Option<bool>,
    limit: Option<usize>,
) -> GrepResult {
    let start = Instant::now();
    let limit = limit.unwrap_or(500);
    let ci = case_insensitive.unwrap_or(false);

    // 先尝试编译正则，失败直接返回。
    let re = match Regex::new(&if ci {
        format!("(?i){pattern}")
    } else {
        pattern.clone()
    }) {
        Ok(r) => r,
        Err(e) => {
            return GrepResult {
                pattern,
                root,
                files_scanned: 0,
                files_skipped: 0,
                hits: vec![],
                elapsed_ms: start.elapsed().as_millis(),
                error: Some(format!("正则编译失败：{e}")),
            };
        }
    };

    if !Path::new(&root).is_dir() {
        let err_msg = format!("目录不存在：{root}");
        return GrepResult {
            pattern,
            root,
            files_scanned: 0,
            files_skipped: 0,
            hits: vec![],
            elapsed_ms: start.elapsed().as_millis(),
            error: Some(err_msg),
        };
    }

    let root_path = Path::new(&root);

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

    let (hits, scanned, skipped) = scan_candidates(candidates, &re, root_path, limit);

    GrepResult {
        pattern,
        root,
        files_scanned: scanned,
        files_skipped: skipped,
        hits,
        elapsed_ms: start.elapsed().as_millis(),
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
fn scan_candidates(
    candidates: Vec<PathBuf>,
    re: &Regex,
    root: &Path,
    limit: usize,
) -> (Vec<GrepHit>, usize, usize) {
    if candidates.is_empty() || limit == 0 {
        return (Vec::new(), 0, 0);
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(4)
        .min(candidates.len());
    let chunk_size = candidates.len().div_ceil(threads.max(1));
    let chunks: Vec<&[PathBuf]> = candidates.chunks(chunk_size.max(1)).collect();
    let per_chunk: Vec<(usize, usize, Vec<GrepHit>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                scope.spawn(move || {
                    let mut scanned = 0usize;
                    let mut skipped = 0usize;
                    let mut hits = Vec::new();
                    for path in chunk {
                        scanned += 1;
                        let (found, refused) = scan_file(re, path, root);
                        if refused {
                            skipped += 1;
                        }
                        hits.extend(found);
                        if hits.len() >= limit {
                            break;
                        }
                    }
                    (scanned, skipped, hits)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or((0, 0, Vec::new())))
            .collect()
    });
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut skipped = 0usize;
    for (n, refused, mut part) in per_chunk {
        scanned += n;
        skipped += refused;
        hits.append(&mut part);
    }
    hits.truncate(limit);
    (hits, scanned, skipped)
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
        let (serial, serial_scanned, _) = scan_candidates(files.clone(), &re, &s.0, 1000);
        // Force a second scanning shape by asking for 3 threads' worth of chunks via a small limit.
        let (limited, _, _) = scan_candidates(files, &re, &s.0, 5);
        assert_eq!(serial.len(), 12);
        assert_eq!(limited.len(), 5);
        assert_eq!(serial_scanned, 12);
        assert!(serial.windows(2).all(|w| w[0].file <= w[1].file), "hits must stay in walk order");
        assert!(limited.iter().all(|h| re.is_match(&h.content)));
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

        let out = repo_grep(
            root.to_string_lossy().to_string(),
            "fn hit".to_string(),
            Some(false),
            Some(100),
        );

        assert!(out.error.is_none(), "unexpected error: {:?}", out.error);
        assert_eq!(out.files_scanned, 3, "all three are attempted");
        assert_eq!(out.files_skipped, 2, "oversized + binary are reported, not silent");
        assert_eq!(out.hits.len(), 1, "only the small text file can match");
        assert_eq!(out.hits[0].file, "small.rs");
    }

    #[test]
    fn ignored_directories_are_pruned_not_merely_hidden() {
        let s = Scratch::new("prune");
        std::fs::create_dir_all(s.0.join("node_modules").join("pkg")).unwrap();
        std::fs::create_dir_all(s.0.join(".git")).unwrap();
        std::fs::write(s.0.join("node_modules").join("pkg").join("dep.js"), "fn hit_dep() {}\n")
            .unwrap();
        std::fs::write(s.0.join(".git").join("hook.ts"), "fn hit_git() {}\n").unwrap();

        let out = repo_grep(
            s.0.to_string_lossy().to_string(),
            "fn hit_".to_string(),
            Some(false),
            Some(100),
        );

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
        let (parallel, _, _) = scan_candidates(files.clone(), &re, &root, 100_000);
        let parallel_ms = t1.elapsed().as_millis();
        println!("grep files={} hits={} serial={}ms parallel={}ms", files.len(), serial.len(), serial_ms, parallel_ms);
        assert_eq!(serial.len(), parallel.len(), "same candidate set and regex must find the same hits");
    }

}
