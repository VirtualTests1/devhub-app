//! Repository cover images: the four commands that sit on top of `ogimage`.
//!
//! Extracted from `lib.rs` in r20-O3, following the `deps.rs` precedent (commit
//! `6062783`): thin command wrappers with no lib.rs-only helpers of their own, so
//! they move without dragging the rest of the file with them.
//!
//! Failure here is always soft. A card that cannot get a cover keeps its generated
//! gradient — that is a deliberate design rule (`DEVELOPMENT.md` §4 "Repository
//! covers"), so none of these commands is allowed to `?` a fetch error out to the
//! page; the reason travels inside `CoverImage::error` instead.

use crate::ogimage;

// r21-O1-3: the `--cover-check` CLI probe moved in from lib.rs; this glob
// supplies `project_root()` from the crate root without re-importing it.
use super::*;

/// Fetches (or reuses) the OpenGraph cover for a repository.
///
/// Runs off the UI thread because it reaches the network. Failure is always soft:
/// the card keeps its generated gradient.
#[tauri::command]
pub async fn fetch_cover(slug: String, force: Option<bool>) -> Result<ogimage::CoverImage, String> {
    let root = crate::project_root();
    tauri::async_runtime::spawn_blocking(move || {
        ogimage::fetch_cover(&root, &slug, force.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("封面图任务异常: {e}"))
}

/// The cover a person chose in 项目设置, copied into the covers cache.
///
/// Off the UI thread because it reads the chosen file (up to `MAX_BYTES`) and writes
/// the copy. Like `fetch_cover`, failure is soft: the card keeps whatever it was
/// already showing, and the reason is reported in `error` for the tooltip.
#[tauri::command]
pub async fn custom_cover(
    app: tauri::AppHandle,
    source: String,
) -> Result<ogimage::CoverImage, String> {
    let root = crate::project_root();
    // The sibling text endpoint is guarded for a sharper reason than convenience:
    // unguarded, a page-supplied path can point at `devhub-config.json` and read the
    // GitHub token out of it. `custom_cover` was the one filesystem-reaching command
    // still doing `PathBuf::from(source)` with no containment — the magic sniff and the
    // size cap say "this is an image", not "this path was allowed".
    //
    // Containment, the denied-name check and the copy share one blocking task:
    // `guard` canonicalizes the roots (real fs work) that must not run on an
    // async runtime thread.
    tauri::async_runtime::spawn_blocking({
        let app2 = app.clone();
        move || -> Result<ogimage::CoverImage, String> {
            let guarded = crate::path_guard::guard(&app2, &source, crate::path_guard::Access::Read)?;
            if let Some(name) = guarded.file_name().map(|n| n.to_string_lossy().to_lowercase()) {
                // Belt and braces: even inside an admitted directory, the app's own
                // secret and per-repository marker files are never cover candidates.
                if name == "devhub-config.json" || name == ".devhub.json" {
                    return Err("这个文件不是封面图片".to_string());
                }
            }
            Ok(ogimage::custom_cover(&root, &guarded))
        }
    })
    .await
    .map_err(|e| format!("封面任务异常: {e}"))?
}

#[tauri::command(async)]
pub fn cover_cache_size() -> u64 {
    ogimage::cache_size(&crate::project_root())
}

#[tauri::command(async)]
pub fn clear_cover_cache() -> Result<u64, String> {
    ogimage::clear_cache(&crate::project_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four commands must keep the exact names the page invokes them by:
    /// `check-commands.mjs` matches the identifier after the module path, so a
    /// rename here is an IPC break, not a refactor. Pinned statically because the
    /// registration list lives in `lib.rs`.
    #[test]
    fn cover_commands_keep_their_ipc_names() {
        // Newlines are normalised first: this repo's working copies carry CRLF
        // (`core.autocrlf`), and a check written against `"\n"` would fail on whichever
        // entry happens to be last in `generate_handler!` — a line-ending accident
        // reported as a missing command.
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        for name in [
            "covers::fetch_cover",
            "covers::custom_cover",
            "covers::cover_cache_size",
            "covers::clear_cover_cache",
        ] {
            assert!(
                lib.contains(&format!("{name},")) || lib.contains(&format!("{name}\n")),
                "`{name}` is no longer registered in generate_handler!"
            );
        }
    }

    /// The extracted commands are pure wrappers over `ogimage`, so the behaviour worth
    /// pinning is the one the page depends on: an empty or absent cache reports zero
    /// and clears to zero instead of erroring. `DEVHUB_PROJECT_ROOT` is deliberately
    /// NOT mutated here — `project_root()` reads it process-wide and other tests in
    /// the same binary would silently start pointing at this temp directory.
    #[test]
    fn cache_size_and_clear_tolerate_an_absent_or_empty_cache() {
        let dir = std::env::temp_dir().join("devhub-covers-r20-o3-empty");
        assert_eq!(
            ogimage::cache_size(&dir),
            0,
            "a root with no covers directory must measure zero, not panic"
        );
        let _ = std::fs::create_dir_all(dir.join("cache/covers"));
        assert_eq!(ogimage::cache_size(&dir), 0);
        assert_eq!(
            ogimage::clear_cache(&dir).unwrap_or(u64::MAX),
            0,
            "clearing an empty cache must report zero removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------------------
// r21-O1-3: `--cover-check` headless probe, moved verbatim from lib.rs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repository cover images
// ---------------------------------------------------------------------------
//
// The four commands that used to live here moved to `covers.rs` in r20-O3,
// following the `deps.rs` precedent. `run_headless_cover_check` stays: it is a
// CLI probe (`--cover-check`), not an IPC surface.

/// Headless cover probe: `devhub-app.exe --cover-check owner/repo`.
///
/// Reports whether the cover was fetched, how long it took, and the cached file's
/// size. Used to verify the cover path without the GUI.
pub fn run_headless_cover_check(slug: &str) -> i32 {
    let root = project_root();
    println!("project_root = {}", root.display());
    println!("slug = {slug}");

    let t = std::time::Instant::now();
    let first = ogimage::fetch_cover(&root, slug, true);
    let first_ms = t.elapsed().as_millis();
    println!(
        "first: cached={} ms={first_ms} path={:?}",
        first.cached, first.path
    );
    if let Some(e) = &first.error {
        println!("first.error = {e}");
    }

    let t2 = std::time::Instant::now();
    let second = ogimage::fetch_cover(&root, slug, false);
    let second_ms = t2.elapsed().as_millis();
    println!(
        "second: cached={} ms={second_ms} path={:?}",
        second.cached, second.path
    );

    if let Some(p) = &second.path {
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        println!("cached_bytes = {size}");
    }
    println!("cache_total_bytes = {}", ogimage::cache_size(&root));

    let mut failures = Vec::new();
    if first.path.is_none() {
        failures.push("首次抓取失败");
    }
    if !second.cached {
        failures.push("第二次未命中缓存");
    }
    // A traversal-style slug must be refused outright.
    let bad = ogimage::fetch_cover(&root, "../../etc/passwd", true);
    if bad.path.is_some() {
        failures.push("恶意 slug 未被拒绝");
    }

    if failures.is_empty() {
        println!("OK");
        0
    } else {
        println!("ERROR {}", failures.join("; "));
        1
    }
}
