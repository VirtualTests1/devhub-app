//! OpenGraph cover images for repository cards.
//!
//! Design: the UI must never show an empty tile, so cards always render a
//! **generated** gradient immediately and this module only *upgrades* that to a
//! real cover when one is available. Therefore every command here is allowed to
//! fail cheaply and quietly.
//!
//! Images come from `opengraph.githubassets.com`. Measured on this machine:
//! HTTP 200, `image/png`, 49-88 KB, and five consecutive fetches of the same repo
//! all succeeded in ~0.49 s. That is good enough for lazy loading, but it is a
//! third-party CDN, so results are cached on disk and never waited on.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Refuse anything larger than this. A cover image has no business being big, and
/// a wrong URL returning a huge body should not fill the disk.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// How many covers the disk cache may hold before the oldest are evicted.
const MAX_CACHE_FILES: usize = 400;

/// Byte ceiling for the whole cover cache (400 typical covers plus headroom).
const MAX_CACHE_BYTES: u64 = 128 * 1024 * 1024;

/// How long a cached cover is trusted before a conditional request revalidates it.
///
/// Matches the endpoint's own `Cache-Control: public, max-age=21600, immutable`
/// (measured 2026-10-24). Revalidation after that costs one 304 (0-byte body) per
/// cover, not another 49–88 KB download.
const ETAG_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// How long a failed cover fetch is remembered before the next mount may retry.
///
/// A repository with no OpenGraph image answers 404 every time. The frontend's
/// session map used to keep the empty answer forever, and the backend had no
/// negative cache at all, so every remount after a restart paid another request
/// for a fact that cannot change in a minute. Five minutes is long enough to cover
/// a view switch or a filter change, short enough that a transient CDN/network
/// failure is retried in the same session. It matches `lib/cover-memo.ts`.
const NEGATIVE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverImage {
    /// Absolute path on disk, or None when no cover is available.
    pub path: Option<String>,
    /// True when the file came from the cache instead of the network.
    pub cached: bool,
    /// Set when the fetch failed; the UI ignores it and keeps the generated tile.
    #[serde(default)]
    pub error: Option<String>,
}

/// Turns `owner/repo` into a filesystem-safe stem.
///
/// Anything outside `[A-Za-z0-9._-]` becomes `_`, so a hostile repo name cannot
/// escape the cache directory.
fn cache_stem(slug: &str) -> String {
    slug.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn cache_dir(root: &Path) -> PathBuf {
    root.join("cache").join("covers")
}

/// Where the validator for one cached image lives.
///
/// A sidecar rather than an in-file header: the cache file is a real PNG that the
/// asset protocol serves byte-for-byte, and its mtime is what the eviction planner
/// already sorts by.
fn etag_path(file: &Path) -> PathBuf {
    file.with_extension("png.etag")
}

fn read_etag(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let one = raw.trim();
    if one.is_empty() {
        None
    } else {
        Some(one.to_string())
    }
}

/// Writes (or, after a 304, refreshes the mtime of) the validator sidecar.
fn write_etag(path: &Path, etag: &str) {
    // Best effort, like every other cache write here: failing to remember a
    // validator only costs a full download next time.
    let _ = crate::write_atomic(path, etag.trim().as_bytes());
}

/// Best-effort removal of a temp artifact or a replaced cache entry.
///
/// The one removal whose failure *does* matter — evicting a real cover — logs its
/// own error in `prune_cache`; everything routed here is either a `.part` /
/// `.headers` leftover or a sidecar that can be re-derived.
fn discard(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// The last `ETag:` header in a curl `-D` dump, or `None`.
///
/// `-L` means the dump can contain several response blocks; the last one is the
/// response that actually produced the file. Header names are case-insensitive
/// and CRLF is stripped by `lines()`. Pure so the parser is testable without a
/// network.
fn parse_etag(headers: &str) -> Option<String> {
    let mut found = None;
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("etag") {
            let one = value.trim();
            if !one.is_empty() {
                found = Some(one.to_string());
            }
        }
    }
    found
}

/// What a cache hit should do next.
#[derive(Debug, PartialEq, Eq)]
enum CachePlan {
    /// Within `ETAG_TTL`: serve the file without touching the network.
    Fresh,
    /// Stale, with a validator: one conditional GET; a 304 keeps the file.
    Conditional(String),
    /// Stale without a validator (a cache from before this feature): fetch once
    /// to refresh the bytes *and* seed the sidecar.
    Refresh,
}

fn plan_cache_hit(
    etag: Option<&str>,
    validated: Option<SystemTime>,
    now: SystemTime,
) -> CachePlan {
    let age = validated.and_then(|at| now.duration_since(at).ok());
    if let Some(age) = age {
        if age < ETAG_TTL {
            return CachePlan::Fresh;
        }
    }
    match etag {
        Some(one) => CachePlan::Conditional(one.to_string()),
        None => CachePlan::Refresh,
    }
}

/// The cache hit shape, in one place so every early return reports it the same way.
fn cached_cover(file: &Path, error: Option<String>) -> CoverImage {
    CoverImage {
        path: Some(file.to_string_lossy().to_string()),
        cached: true,
        error,
    }
}

/// One file the eviction planner may consider.
#[derive(Debug, Clone)]
struct CacheEntry {
    name: String,
    size: u64,
    modified: SystemTime,
}

impl CacheEntry {
    #[cfg(test)]
    fn new(name: &str, size: u64, secs: u64) -> Self {
        Self {
            name: name.to_string(),
            size,
            modified: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs),
        }
    }
}

/// Chooses which cache files to delete so both caps hold again.
///
/// Pure and deterministic so the policy is testable without touching a disk:
/// oldest modification time first, name as the tie-break, and the file just
/// written is never a candidate (it is the reason the caller is pruning).
fn eviction_plan(
    entries: &mut [CacheEntry],
    keep: Option<&str>,
    max_files: usize,
    max_bytes: u64,
) -> Vec<String> {
    entries.sort_by(|a, b| {
        a.modified
            .cmp(&b.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut files = entries.len();
    let mut bytes: u64 = entries.iter().map(|e| e.size).sum();
    let mut drop = Vec::new();
    for entry in entries.iter() {
        if files <= max_files && bytes <= max_bytes {
            break;
        }
        if keep == Some(entry.name.as_str()) {
            continue;
        }
        drop.push(entry.name.clone());
        files = files.saturating_sub(1);
        bytes = bytes.saturating_sub(entry.size);
    }
    drop
}

/// Best-effort enforcement of the cache caps after a successful write.
///
/// Failures are ignored on purpose: a cover is an upgrade, never a requirement,
/// and a cache that cannot be pruned must not turn into a failed cover fetch.
fn is_etag_sidecar(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".etag")
}

fn is_fail_sidecar(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".fail")
}

/// Where a failed fetch for `file` is remembered.
fn failure_path(file: &Path) -> PathBuf {
    file.with_extension("png.fail")
}

/// Whether a remembered failure may still short-circuit a fetch.
///
/// Pure so the boundary is pinned by a test rather than read off a wall clock.
fn failure_is_fresh(age: Duration) -> bool {
    age < NEGATIVE_TTL
}

/// Read a failure marker: when it was written and the reason. Junk is ignored.
fn read_failure(path: &Path) -> Option<(SystemTime, String)> {
    let text = crate::path_guard::read_text_capped(path, 8192).ok()?;
    let (stamp, reason) = text.split_once('\n')?;
    let secs: u64 = stamp.trim().parse().ok()?;
    Some((
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
        reason.trim().to_string(),
    ))
}

/// Remember a failed fetch. Best-effort: a cache that cannot write a marker must
/// not turn into a second failure.
fn write_failure(path: &Path, reason: &str) {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = crate::write_atomic(path, format!("{secs}\n{reason}").as_bytes()) {
        eprintln!("[cover-cache] 无法写入失败标记 {}: {e}", path.display());
    }
}

/// Best-effort enforcement of the cache caps after a successful write.
///
/// Failures are ignored on purpose: a cover is an upgrade, never a requirement,
/// and a cache that cannot be pruned must not turn into a failed cover fetch.
///
/// ETag sidecars are not covers: counting them against `MAX_CACHE_FILES` would
/// halve the number of images the cache can hold. They are removed together with
/// their image, and an orphan (its image already gone) is removed on the next
/// sweep.
fn prune_cache(root: &Path, keep: &Path) {
    let dir = cache_dir(root);
    let Ok(read) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut entries = Vec::new();
    let mut sidecars = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_etag_sidecar(&name) || is_fail_sidecar(&name) {
            sidecars.push((name, meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
            continue;
        }
        entries.push(CacheEntry {
            name,
            size: meta.len(),
            modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }

    // An orphan *ETag* is a leftover from a cover that was removed by 清理缓存 or
    // by an older build; it can never be consulted again. A failure marker is the
    // negative cache and is useful without an image — keep it until its TTL passes,
    // then it is dead weight like any other orphan.
    let images: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.name.as_str()).collect();
    let now = SystemTime::now();
    for (sidecar, modified) in &sidecars {
        let base = sidecar
            .strip_suffix(".etag")
            .or_else(|| sidecar.strip_suffix(".fail"))
            .unwrap_or(sidecar.as_str());
        if images.contains(base) {
            continue;
        }
        if is_fail_sidecar(sidecar) {
            let fresh = now
                .duration_since(*modified)
                .map(failure_is_fresh)
                .unwrap_or(false);
            if fresh {
                continue;
            }
        }
        discard(&dir.join(sidecar));
    }

    let keep_name = keep
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    for name in eviction_plan(
        &mut entries,
        keep_name.as_deref(),
        MAX_CACHE_FILES,
        MAX_CACHE_BYTES,
    ) {
        // Eviction is best-effort, but a persistent failure (locked file, permissions)
        // must leave a trace: a silently full cache is the bug this cap exists to stop.
        if let Err(e) = std::fs::remove_file(dir.join(&name)) {
            eprintln!("[cover-cache] 无法删除 {}: {e}", dir.join(&name).display());
        }
        let sidecar = dir.join(format!("{name}.etag"));
        if sidecar.is_file() {
            discard(&sidecar);
        }
    }
}

/// Fetches (or reuses) the cover for `slug`, writing it under `root/cache/covers`.
///
/// `slug` must be `owner/repo`; the host is fixed to github.com because the
/// OpenGraph endpoint is GitHub-specific.
pub fn fetch_cover(root: &Path, slug: &str, force: bool) -> CoverImage {
    let slug = slug.trim().trim_matches('/');

    // Reject traversal BEFORE dropping empty segments: an earlier version filtered
    // empty components first, which silently discarded the ".." in
    // "../../etc/passwd", so the check below never saw it.
    if slug
        .split('/')
        .any(|seg| seg == ".." || seg == "." || seg.is_empty())
    {
        return CoverImage {
            path: None,
            cached: false,
            error: Some("仓库标识包含路径遍历或空片段，已拒绝".to_string()),
        };
    }

    let parts: Vec<&str> = slug.split('/').collect();
    if parts.len() < 2 {
        return CoverImage {
            path: None,
            cached: false,
            error: Some(format!("无法识别的仓库标识: {slug}")),
        };
    }
    let (owner, repo) = (parts[parts.len() - 2], parts[parts.len() - 1]);
    if !owner
        .chars()
        .chain(repo.chars())
        .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    {
        return CoverImage {
            path: None,
            cached: false,
            error: Some("仓库名含非预期字符，已跳过封面图".to_string()),
        };
    }

    let dir = cache_dir(root);
    let file = dir.join(format!("{}.png", cache_stem(&format!("{owner}_{repo}"))));
    let etag_file = etag_path(&file);
    let fail_file = failure_path(&file);
    // One shape for every "no cover" answer, so the marker and the message cannot
    // drift apart.
    let fail_with = |reason: String| {
        write_failure(&fail_file, &reason);
        CoverImage {
            path: None,
            cached: false,
            error: Some(reason),
        }
    };

    // A non-empty file is a cache candidate; a zero-byte one is a failed attempt.
    let cached = file.is_file() && std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0) > 0;
    if file.is_file() && !cached {
        discard(&file);
    }

    // A recent failure is an answer: do not spend a curl (and a slot in the
    // frontend's cover gate) asking a question the same minute already answered.
    // `force` is the user's explicit 重试 and bypasses this once.
    if !cached && !force {
        if let Some((at, reason)) = read_failure(&fail_file) {
            if let Ok(age) = SystemTime::now().duration_since(at) {
                if failure_is_fresh(age) {
                    return CoverImage {
                        path: None,
                        cached: false,
                        error: Some(format!(
                            "{reason}（{} 分钟内不再重试）",
                            NEGATIVE_TTL.as_secs() / 60
                        )),
                    };
                }
            }
        }
    }

    let mut if_none_match: Option<String> = None;
    if cached && !force {
        let etag = read_etag(&etag_file);
        // The sidecar's mtime means "when this validator was last confirmed". A
        // cache written before this feature has no sidecar; its image mtime is the
        // best available age, and one unconditional fetch seeds a sidecar.
        let validated = std::fs::metadata(&etag_file)
            .and_then(|m| m.modified())
            .ok()
            .or_else(|| std::fs::metadata(&file).and_then(|m| m.modified()).ok());
        match plan_cache_hit(etag.as_deref(), validated, SystemTime::now()) {
            CachePlan::Fresh => return cached_cover(&file, None),
            CachePlan::Conditional(one) => if_none_match = Some(one),
            CachePlan::Refresh => {}
        }
    }

    if let Err(e) = std::fs::create_dir_all(&dir) {
        return CoverImage {
            path: None,
            cached: false,
            error: Some(format!("无法创建封面缓存目录: {e}")),
        };
    }

    let curl = match which_curl() {
        Some(c) => c,
        None => {
            return CoverImage {
                path: None,
                cached: false,
                error: Some("找不到 curl".to_string()),
            }
        }
    };

    // The `/1/` path segment is part of the public URL shape used by GitHub's
    // social preview service. The cache-busting suffix is not needed because the
    // image changes only when the repository metadata changes.
    //
    // curl writes to a temp file, not the cache name, for the same reason every
    // other whole-file write in this backend does: a killed curl (app exit,
    // taskkill from the exit policy, --max-filesize abort) left a partial PNG
    // under the final name, and the `size > 0` hit check above then served that
    // truncated file as a cache hit forever — "the cover looks broken" with no
    // way to recover short of 清理封面缓存. Rename only after success.
    let url = format!("https://opengraph.githubassets.com/1/{owner}/{repo}");
    let tmp = file.with_extension("png.part");
    let headers = file.with_extension("png.headers");
    let mut command = crate::proc::silent(curl);
    command
        .args([
            "-sS",
            "--no-progress-meter",
            "-L",
            "--fail",
            // Covers are decorative, and a fetch holds one of the four shared
            // `cover-gate` slots for its whole lifetime. Measured cold fetches on
            // this network are 0.5–5.1 s; 10 s leaves headroom for a slow CDN
            // without letting one stalled host occupy a slot for twenty seconds.
            "--connect-timeout",
            "5",
            "--max-time",
            "10",
            "--max-filesize",
            &MAX_BYTES.to_string(),
            "-o",
        ])
        .arg(&tmp);
    if let Some(validator) = &if_none_match {
        command.arg("-H").arg(format!("If-None-Match: {validator}"));
    }
    let out = command
        .arg("-D")
        .arg(&headers)
        .arg("-w")
        .arg("%{http_code}")
        .arg(&url)
        .output();

    match out {
        Ok(o) if o.status.success() => {
            let code = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let header_text = std::fs::read_to_string(&headers).unwrap_or_default();
            let fresh_etag = parse_etag(&header_text);
            discard(&headers);

            if code == "304" {
                // No body. The cached bytes are still the ones the server would
                // have sent; refreshing the sidecar is the whole update.
                discard(&tmp);
                if let Some(validator) = fresh_etag.or(if_none_match) {
                    write_etag(&etag_file, &validator);
                }
                if cached {
                    return cached_cover(&file, None);
                }
                return fail_with("封面服务器返回 304，但本地没有可用的封面".to_string());
            }

            let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                discard(&tmp);
                if cached {
                    return cached_cover(&file, Some("封面更新为空，继续使用缓存".to_string()));
                }
                return fail_with("封面图为空".to_string());
            }
            if let Err(e) = std::fs::rename(&tmp, &file) {
                discard(&tmp);
                if cached {
                    return cached_cover(&file, Some(format!("封面更新落盘失败，继续使用缓存: {e}")));
                }
                return fail_with(format!("封面图落盘失败: {e}"));
            }
            // The image is real now; a stale failure must not survive it.
            discard(&fail_file);
            match fresh_etag {
                Some(validator) => write_etag(&etag_file, &validator),
                // A 200 without an ETag: a stale sidecar would make the next request
                // ask about a validator this response no longer offers.
                None => {
                    discard(&etag_file);
                }
            }
            // Only after the atomic rename: a partial file is never a cache entry.
            prune_cache(root, &file);
            CoverImage {
                path: Some(file.to_string_lossy().to_string()),
                cached: false,
                error: None,
            }
        }
        Ok(o) => {
            // Do not leave a partial file behind.
            discard(&tmp);
            discard(&headers);
            let err = crate::proc::decode_console(&o.stderr);
            let tail = err.lines().last().unwrap_or("").to_string();
            if cached {
                return cached_cover(&file, Some(format!("刷新封面失败，继续使用缓存: {tail}")));
            }
            fail_with(format!("获取封面图失败: {tail}"))
        }
        Err(e) => {
            discard(&tmp);
            discard(&headers);
            if cached {
                return cached_cover(&file, Some(format!("无法启动 curl，继续使用缓存: {e}")));
            }
            fail_with(format!("无法启动 curl: {e}"))
        }
    }
}

/// The kinds a cover may be, identified by magic bytes.
///
/// Not by extension: the 项目设置 file picker hands over whatever the person pointed
/// at, and its name says nothing about its contents. The returned string is the
/// cache file's extension, which is also what the asset-protocol scope in
/// `tauri.conf.json` allows to be served.
fn image_kind(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// A stable cache name for a chosen source path.
///
/// Keyed on the whole path, not the file name, because two repositories can pick
/// two different files that are both called `cover.png` - sharing one cache entry
/// would make one card show the other's picture.
fn source_stem(path: &Path) -> String {
    // FNV-1a, so the name depends only on the bytes of the path and no hashing
    // dependency is needed for one file name.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_string_lossy().as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("custom-{hash:016x}")
}

/// The cache copy of a cover chosen in 项目设置.
///
/// The file is **copied** into the covers directory rather than read from wherever
/// it lives: that directory is what the asset-protocol scope reaches, what
/// 清理封面缓存 already owns, and the only way the tile keeps working after the user
/// moves or deletes the original. `cached` reports whether the copy was already
/// current, which is decided by size - the cheapest signal that the file was
/// replaced under the same name.
pub fn custom_cover(root: &Path, source: &Path) -> CoverImage {
    let fail = |e: String| CoverImage {
        path: None,
        cached: false,
        error: Some(e),
    };
    if source.as_os_str().is_empty() {
        return fail("没有指定封面文件".to_string());
    }
    let meta = match std::fs::metadata(source) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return fail("封面路径不是文件".to_string()),
        Err(_) => return fail(format!("封面文件不存在：{}", source.to_string_lossy())),
    };
    if meta.len() > MAX_BYTES {
        return fail(format!("封面文件大于 {} KB", MAX_BYTES / 1024));
    }
    let bytes = match std::fs::read(source) {
        Ok(b) => b,
        Err(e) => return fail(format!("读取封面失败: {e}")),
    };
    let head = &bytes[..bytes.len().min(12)];
    let Some(ext) = image_kind(head) else {
        return fail("只支持 PNG / JPEG / GIF / WEBP 图片".to_string());
    };

    let dir = cache_dir(root);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return fail(format!("无法创建封面缓存目录: {e}"));
    }
    let stem = source_stem(source);
    let file = dir.join(format!("{stem}.{ext}"));
    let current = std::fs::metadata(&file)
        .map(|m| m.len() == bytes.len() as u64)
        .unwrap_or(false);
    if !current {
        // Atomic like the fetch path above: a killed write left a truncated
        // custom cover under the final name with no size change to invalidate it.
        if let Err(e) = crate::write_atomic(&file, &bytes) {
            return fail(format!("写入封面缓存失败: {e}"));
        }
    }
    // Re-saving the same path as another format changes `ext`, and the old copy
    // would otherwise sit in the cache as a stale image of this repository.
    for other in crate::downloader::COVER_KINDS {
        if *other != ext {
            discard(&dir.join(format!("{stem}.{other}")));
        }
    }
    prune_cache(root, &file);
    CoverImage {
        path: Some(file.to_string_lossy().to_string()),
        cached: current,
        error: None,
    }
}

fn which_curl() -> Option<PathBuf> {
    if let Some(rt) = std::env::var_os("SystemRoot") {
        let p = PathBuf::from(rt).join("System32/curl.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join("curl.exe");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Total bytes currently used by the cover cache.
pub fn cache_size(root: &Path) -> u64 {
    let dir = cache_dir(root);
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    total += m.len();
                }
            }
        }
    }
    total
}

/// Empties the cover cache.
pub fn clear_cache(root: &Path) -> Result<u64, String> {
    let dir = cache_dir(root);
    let freed = cache_size(root);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清空封面缓存失败: {e}"))?;
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_stem_neutralises_path_traversal() {
        assert_eq!(cache_stem("owner_repo"), "owner_repo");
        assert_eq!(cache_stem("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(cache_stem("a/b\\c:d*e"), "a_b_c_d_e");
        assert!(
            !cache_stem("../../evil").contains('/'),
            "a slug must never introduce a path separator"
        );
        assert!(!cache_stem("..\\..\\evil").contains('\\'));
    }

    #[test]
    fn image_kind_reads_the_bytes_not_the_name() {
        assert_eq!(image_kind(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_kind(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(image_kind(b"GIF89a"), Some("gif"));
        assert_eq!(image_kind(b"RIFFxxxxWEBP"), Some("webp"));
        // An executable renamed `.png` is the case that matters: the picker hands
        // over whatever the user pointed at, and the cache directory is inside the
        // asset-protocol scope, so what lands there can be served to the webview.
        assert_eq!(image_kind(b"MZ\x90\x00"), None);
        assert_eq!(image_kind(b""), None);
        assert_eq!(image_kind(b"RIFFxx"), None, "a short RIFF must not be trusted");
    }

    #[test]
    fn source_stem_separates_two_files_with_the_same_name() {
        let a = source_stem(Path::new(r"C:\one\cover.png"));
        let b = source_stem(Path::new(r"D:\two\cover.png"));
        assert_ne!(a, b, "two repositories may each choose a file called cover.png");
        assert_eq!(a, source_stem(Path::new(r"C:\one\cover.png")));
        assert!(!a.contains('/') && !a.contains('\\'));
    }

    #[test]
    fn a_chosen_cover_is_copied_into_the_cache_and_reused() {
        let root = std::env::temp_dir().join("devhub-cover-custom");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("chosen.png");
        std::fs::write(&src, b"\x89PNG\r\n\x1a\n1234").unwrap();

        let first = custom_cover(&root, &src);
        let path = first.path.clone().expect("the copy should be returned");
        assert!(!first.cached, "the first answer is a fresh copy, not a cache hit");
        let served = Path::new(&path);
        assert!(served.is_file());
        assert!(
            served.starts_with(cache_dir(&root)),
            "only the covers directory is inside the asset-protocol scope: {path}"
        );

        let second = custom_cover(&root, &src);
        assert_eq!(second.path, first.path);
        assert!(second.cached, "an unchanged source is not copied twice");

        // Replacing the file under the same name changes its size, which is the
        // signal the reuse test above looks at.
        std::fs::write(&src, b"\x89PNG\r\n\x1a\n123456789").unwrap();
        assert!(
            !custom_cover(&root, &src).cached,
            "a changed source must be re-copied"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_chosen_cover_that_is_not_an_image_is_refused_and_not_cached() {
        let root = std::env::temp_dir().join("devhub-cover-notimage");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("notes.png");
        std::fs::write(&src, b"just text with a png name").unwrap();

        let r = custom_cover(&root, &src);
        assert!(r.path.is_none());
        assert!(r.error.unwrap().contains("图片"));
        assert_eq!(
            std::fs::read_dir(cache_dir(&root)).map(|d| d.count()).unwrap_or(0),
            0,
            "a refused file must not reach the served directory"
        );

        let gone = custom_cover(&root, &root.join("deleted.png"));
        assert!(gone.path.is_none(), "a source that no longer exists says so");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_slugs_that_are_not_owner_repo() {
        let root = std::env::temp_dir().join("devhub-cover-test");
        let r = fetch_cover(&root, "justoneword", false);
        assert!(r.path.is_none());
        assert!(r.error.is_some());
        let r2 = fetch_cover(&root, "", false);
        assert!(r2.path.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_names_with_unexpected_characters() {
        let root = std::env::temp_dir().join("devhub-cover-test2");
        let r = fetch_cover(&root, "owner/re%2Fpo", false);
        assert!(r.path.is_none(), "a percent-encoded name must not be fetched");
        assert!(r.error.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_path_traversal_segments() {
        // A real bug found by the headless probe: '.' is needed for names like
        // `foo.js`, and empty segments used to be filtered out before validation,
        // which silently discarded the ".." in "../../etc/passwd".
        let root = std::env::temp_dir().join("devhub-cover-traversal");
        let _ = std::fs::remove_dir_all(&root);
        for slug in ["../../etc/passwd", "owner/..", "../owner", "a//b", "./x"] {
            let r = fetch_cover(&root, slug, false);
            assert!(
                r.path.is_none(),
                "slug {slug:?} must be refused, got {:?}",
                r.path
            );
            assert!(r.error.is_some(), "refusal must carry a reason");
        }
        // A single segment is still refused.
        assert!(fetch_cover(&root, "onlyone", false).path.is_none());
        // Dots inside a normal name are still fine.
        assert_eq!(cache_stem("owner_foo.js"), "owner_foo.js");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cache_hit_is_returned_without_network() {
        let root = std::env::temp_dir().join("devhub-cover-test3");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("owner_repo.png");
        std::fs::write(&file, b"not really a png").unwrap();

        let r = fetch_cover(&root, "owner/repo", false);
        assert!(r.cached, "an existing file must short-circuit the fetch");
        assert_eq!(r.path.as_deref(), Some(file.to_string_lossy().as_ref()));
        assert!(r.error.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_zero_byte_cache_entry_is_retried_then_replaced_or_dropped() {
        let root = std::env::temp_dir().join("devhub-cover-test4");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("owner_repo.png");
        std::fs::write(&file, b"").unwrap();

        // Network may or may not be available here; either way the empty file must
        // not be reported as a usable cached cover.
        let r = fetch_cover(&root, "owner/repo", false);
        assert!(!r.cached, "an empty file is not a cache hit");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_reports_what_was_freed() {
        let root = std::env::temp_dir().join("devhub-cover-test5");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), vec![0u8; 1234]).unwrap();
        assert_eq!(cache_size(&root), 1234);
        let freed = clear_cache(&root).unwrap();
        assert_eq!(freed, 1234);
        assert_eq!(cache_size(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn eviction_plan_leaves_a_cache_within_both_caps_alone() {
        let mut entries = vec![
            CacheEntry::new("a.png", 10, 1),
            CacheEntry::new("b.png", 20, 2),
        ];
        let drop = eviction_plan(&mut entries, None, 10, 1000);
        assert!(drop.is_empty(), "nothing over the caps, nothing deleted");
    }

    #[test]
    fn eviction_plan_drops_the_oldest_files_until_the_file_cap_holds() {
        let mut entries = vec![
            CacheEntry::new("newest.png", 10, 30),
            CacheEntry::new("oldest.png", 10, 10),
            CacheEntry::new("middle.png", 10, 20),
        ];
        let drop = eviction_plan(&mut entries, None, 2, 1000);
        assert_eq!(drop, vec!["oldest.png".to_string()]);
    }

    #[test]
    fn eviction_plan_also_honours_the_byte_cap() {
        let mut entries = vec![
            CacheEntry::new("a.png", 60, 10),
            CacheEntry::new("b.png", 60, 20),
        ];
        let drop = eviction_plan(&mut entries, None, 10, 100);
        assert_eq!(drop, vec!["a.png".to_string()], "60+60 > 100 → drop the older");
    }

    #[test]
    fn eviction_plan_never_drops_the_file_that_was_just_written() {
        let mut entries = vec![
            CacheEntry::new("keep.png", 100, 10),
            CacheEntry::new("other.png", 100, 20),
        ];
        let drop = eviction_plan(&mut entries, Some("keep.png"), 1, 100);
        assert_eq!(drop, vec!["other.png".to_string()]);
        assert!(
            !drop.iter().any(|n| n == "keep.png"),
            "the write that triggered pruning must survive it"
        );
    }

    #[test]
    fn prune_cache_removes_files_until_the_directory_is_within_caps() {
        let root = std::env::temp_dir().join("devhub-cover-test6");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        // A single 4 MB cover is far under 128 MB, so write the oldest marker as
        // the keep file and fabricate an oversize total with two sparse entries.
        let keep = dir.join("keep.png");
        std::fs::write(&keep, vec![0u8; 16]).unwrap();
        let old = dir.join("old.png");
        std::fs::write(&old, vec![0u8; 16]).unwrap();
        // Push the byte total over the cap without allocating 128 MB in the test:
        // the planner is already covered above; here the cap is exercised through
        // the real directory scan only for file-count behaviour.
        for i in 0..(MAX_CACHE_FILES + 2) {
            std::fs::write(dir.join(format!("f{i}.png")), b"x").unwrap();
        }
        prune_cache(&root, &keep);
        let files = std::fs::read_dir(&dir).unwrap().count();
        assert!(files <= MAX_CACHE_FILES, "file cap not enforced: {files}");
        assert!(keep.is_file(), "the kept file must survive pruning");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failure_marker_round_trips_and_has_a_real_ttl() {
        let root = std::env::temp_dir().join(format!("devhub-cover-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let marker = failure_path(&root.join("owner_repo.png"));

        assert!(read_failure(&marker).is_none(), "no marker before a failure");
        write_failure(&marker, "获取封面图失败: 404");
        let (at, reason) = read_failure(&marker).expect("a writer must be readable");
        assert_eq!(reason, "获取封面图失败: 404");
        assert!(failure_is_fresh(SystemTime::now().duration_since(at).unwrap()));
        assert!(
            !failure_is_fresh(NEGATIVE_TTL),
            "the boundary must retry: a failure at exactly the TTL is stale"
        );

        std::fs::write(&marker, "not-a-marker").unwrap();
        assert!(read_failure(&marker).is_none(), "junk is ignored, not guessed at");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_keeps_a_fresh_failure_marker_and_drops_a_stale_one() {
        let root = std::env::temp_dir().join(format!("devhub-cover-fail-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("gone.png.fail");
        write_failure(&marker, "404");

        prune_cache(&root, &root.join("not-a-cover.png"));
        assert!(marker.is_file(), "a fresh negative entry survives without its image");

        let old = SystemTime::now() - NEGATIVE_TTL - Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&marker)
            .unwrap()
            .set_modified(old)
            .unwrap();
        prune_cache(&root, &root.join("not-a-cover.png"));
        assert!(!marker.exists(), "an expired negative entry is dead weight");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_etag_reads_the_last_validator_and_ignores_other_lines() {
        // `-L` can dump several response blocks; the last one produced the file.
        let dump = "HTTP/1.1 200 OK\r\nETag: \"first\"\r\n\r\nHTTP/1.1 200 OK\r\nEtag: W/\"second\"\r\n";
        assert_eq!(parse_etag(dump).as_deref(), Some("W/\"second\""));
        assert_eq!(
            parse_etag("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n"),
            None,
            "a status line has a colon too, but no ETag header"
        );
        assert_eq!(parse_etag("ETag:\r\n"), None, "an empty validator is no validator");
        assert_eq!(parse_etag(""), None);
    }

    #[test]
    fn plan_cache_hit_revalidates_only_after_the_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let fresh = Some(now - Duration::from_secs(60));
        let at_ttl = Some(now - ETAG_TTL);
        let stale = Some(now - ETAG_TTL - Duration::from_secs(1));

        assert_eq!(plan_cache_hit(Some("W/\"a\""), fresh, now), CachePlan::Fresh);
        assert_eq!(
            plan_cache_hit(Some("W/\"a\""), at_ttl, now),
            CachePlan::Conditional("W/\"a\"".to_string()),
            "the boundary is not fresh: revalidate once the max-age has passed"
        );
        assert_eq!(
            plan_cache_hit(Some("W/\"a\""), stale, now),
            CachePlan::Conditional("W/\"a\"".to_string())
        );
        assert_eq!(plan_cache_hit(None, stale, now), CachePlan::Refresh);
        assert_eq!(plan_cache_hit(None, None, now), CachePlan::Refresh);
        assert_eq!(
            plan_cache_hit(Some("W/\"a\""), None, now),
            CachePlan::Conditional("W/\"a\"".to_string()),
            "a validator with an unknown age is still usable for a conditional request"
        );
    }

    #[test]
    fn an_etag_sidecar_round_trips_and_a_304_rewrite_refreshes_its_age() {
        let root = std::env::temp_dir().join("devhub-cover-etag-sidecar");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let image = root.join("owner_repo.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        let sidecar = etag_path(&image);

        assert_eq!(read_etag(&sidecar), None, "no sidecar before the first fetch");
        write_etag(&sidecar, "  W/\"abc\"  ");
        assert_eq!(read_etag(&sidecar).as_deref(), Some("W/\"abc\""), "the value is trimmed");

        let old = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        std::fs::File::options()
            .write(true)
            .open(&sidecar)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let validated = || std::fs::metadata(&sidecar).and_then(|m| m.modified()).ok();
        assert_eq!(
            plan_cache_hit(read_etag(&sidecar).as_deref(), validated(), SystemTime::now()),
            CachePlan::Conditional("W/\"abc\"".to_string())
        );

        // What the 304 path does: write the same validator again. Its mtime is the
        // "last confirmed" clock, so this is the whole touch.
        write_etag(&sidecar, "W/\"abc\"");
        assert_eq!(
            plan_cache_hit(read_etag(&sidecar).as_deref(), validated(), SystemTime::now()),
            CachePlan::Fresh,
            "a revalidated cache is fresh for another TTL"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn etag_sidecars_do_not_consume_the_cover_slots_and_leave_with_their_cover() {
        let root = std::env::temp_dir().join("devhub-cover-etag-evict");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("keep.png");
        std::fs::write(&keep, vec![0u8; 16]).unwrap();
        write_etag(&etag_path(&keep), "W/\"keep\"");

        // 400 covers + 400 sidecars: halving the cap for validators would evict
        // half of the images, which is the bug this split exists to prevent.
        for i in 0..(MAX_CACHE_FILES + 2) {
            let image = dir.join(format!("f{i}.png"));
            std::fs::write(&image, b"x").unwrap();
            write_etag(&etag_path(&image), "W/\"x\"");
        }
        prune_cache(&root, &keep);

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let images = names.iter().filter(|n| !is_etag_sidecar(n)).count();
        assert!(images <= MAX_CACHE_FILES, "cover cap not enforced: {images}");
        assert!(keep.is_file(), "the kept cover must survive");
        assert!(etag_path(&keep).is_file(), "its validator must survive with it");

        for name in names.iter().filter(|n| is_etag_sidecar(n)) {
            let base = name.strip_suffix(".etag").unwrap_or(name);
            assert!(
                names.iter().any(|n| n == base),
                "orphan sidecar left behind: {name}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_cache_removes_an_orphan_etag_sidecar() {
        let root = std::env::temp_dir().join("devhub-cover-etag-orphan");
        let _ = std::fs::remove_dir_all(&root);
        let dir = cache_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let sidecar = dir.join("gone.png.etag");
        std::fs::write(&sidecar, b"W/\"gone\"").unwrap();
        prune_cache(&root, &root.join("not-a-cover.png"));
        assert!(!sidecar.exists(), "a validator for a deleted cover is dead weight");
        let _ = std::fs::remove_dir_all(&root);
    }
}
