//! Repository search IPC: status, GitHub token check, heat, the search call
//! itself, the README fetch, the accelerator cache and the starred list —
//! split out of `lib.rs` by r21-O1-2.
//!
//! Bodies are verbatim; visibility is `pub(crate)` except the
//! `#[tauri::command]` fns, which stay `pub` and are registered at the crate
//! root as `search_cmd::<name>`. The root re-imports the names with
//! `use search_cmd::*` so tests and existing call sites resolve unchanged.
//! `repo_heat_many`/`search_repositories` keep their `spawn_blocking` shapes —
//! the move must not change how they schedule.

use super::*;

// ---------------------------------------------------------------------------
// Repository search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchStatus {
    /// Requests left in the local anonymous budget for the current minute.
    pub(crate) remaining_budget: u32,
    pub(crate) cached_queries: usize,
    pub(crate) has_token: bool,
    /// The allowance GitHub applies: 30/min with a token, 10/min without.
    pub(crate) limit_per_minute: u32,
}

#[tauri::command]
pub(crate) async fn search_status(settings: tauri::State<'_, Settings>) -> Result<SearchStatus, String> {
    // Async + off-thread: this locks the same search cache that a running search
    // locks, and it reads the config file off disk. As a synchronous command it
    // ran on the window's thread and inherited any stall there.
    let cache = std::sync::Arc::clone(&settings.search);
    tauri::async_runtime::spawn_blocking(move || {
        let (remaining, cached) = match cache.lock() {
            Ok(c) => (c.remaining_budget(), c.entry_count()),
            Err(_) => (0, 0),
        };
        let has_token = !read_config().github_token.trim().is_empty();
        SearchStatus {
            remaining_budget: remaining,
            cached_queries: cached,
            has_token,
            limit_per_minute: if has_token { 30 } else { 10 },
        }
    })
    .await
    .map_err(|e| format!("搜索状态任务异常: {e}"))
}

/// Checks whether the stored GitHub token is usable right now — r18 R3.
///
/// The token itself never leaves Rust: the command reads it from the config file, feeds
/// it to curl through stdin (`search.rs:37 curl_with_token`), and returns an
/// `auth::TokenReport` whose every field is an *observation about the response*. The
/// webview has always been told only `has_github_token` (a boolean), and that stays true.
///
/// Async + `spawn_blocking` because it is one blocking curl; the settings button that
/// calls it must not freeze the window.
#[tauri::command]
pub(crate) async fn verify_github_token() -> Result<auth::TokenReport, String> {
    let token = read_config().github_token;
    let route = read_config().search_route;
    tauri::async_runtime::spawn_blocking(move || {
        // Same routing rule as search and heat: 绕过 only means something when `hosts`
        // really redirects the API host and public DNS agrees on an address. Without a
        // token there is nothing to resolve, and `auth::verify` says so without spawning
        // curl at all.
        let resolve = if route == "bypass" && netpath::read_hosts_state().hijacked {
            downloader::resolve_agreed_ip("api.github.com")
        } else {
            None
        };
        auth::verify(&token, resolve.as_deref())
    })
    .await
    .map_err(|e| format!("令牌校验任务异常: {e}"))
}

/// Fetches star counts (and language / licence / last push) for repositories the
/// wall already knows — r18 N4.
///
/// Async + `spawn_blocking` for the same reason as `search_repositories`: this runs
/// `curl` per repository, and a synchronous command would freeze the window for the
/// whole batch.
///
/// `names` are `owner/repo` strings the page composes from the wall's own
/// `owner`/`repo` fields. They are **not** trusted: `heat::parse_full_name` rejects
/// anything that is not exactly two safe segments, because the value goes straight
/// into the path of `https://api.github.com/repos/…`. A rejected name is dropped
/// silently rather than echoed back — the caller can only have sent something that
/// is not a repository identity, and the tile simply keeps showing no number.
///
/// This is a read, so no activity record is written (the same line `search_repositories`
/// and `repo_metadata` already hold: 记录 answers "someone changed something").
#[tauri::command]
pub(crate) async fn repo_heat_many(names: Vec<String>, force: Option<bool>) -> Result<Vec<heat::Heat>, String> {
    let token = read_config().github_token;
    let route = read_config().search_route;
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let slugs: Vec<String> = names.iter().filter_map(|n| heat::parse_full_name(n)).collect();
        // Same routing decision as search: honour 绕过 only when `hosts` really points
        // GitHub somewhere local and public DNS agrees on an address.
        let resolve = if route == "bypass" && netpath::read_hosts_state().hijacked {
            downloader::resolve_agreed_ip("api.github.com")
        } else {
            None
        };
        heat::heat_many(
            heat::shared(),
            &slugs,
            &token,
            resolve.as_deref(),
            std::time::Instant::now(),
            force,
            &heat::fetch_one,
        )
    })
    .await
    .map_err(|e| format!("热度任务异常: {e}"))
}


/// Runs a search **off the UI thread**.
///
/// This performs an HTTP request through `curl`, which is blocking; running it as
/// a plain synchronous command froze the window for the duration of every search.
#[tauri::command]
pub(crate) async fn search_repositories(
    settings: tauri::State<'_, Settings>,
    query: String,
    page: u32,
    sort: String,
) -> Result<search::SearchOutcome, String> {
    let token = read_config().github_token;
    let route = read_config().search_route;
    // Clone the Arc so the worker owns a handle; the state guard stays behind.
    let cache = std::sync::Arc::clone(&settings.search);

    tauri::async_runtime::spawn_blocking(move || {
        // `bypass` is only honoured when something actually redirects the API
        // host, and only when public DNS agrees on an address. Silently falling
        // back to the hosts answer when DNS fails would look like the switch did
        // nothing, so `resolve` stays None and the caller sees the real error.
        let resolve = if route == "bypass" && netpath::read_hosts_state().hijacked {
            resolve_agreed_ip("api.github.com").map(|ip| ("api.github.com".to_string(), ip))
        } else {
            None
        };
        // `search_locked` takes the mutex only around the cache-hit/budget check and
        // again around the store, so a 25 s curl no longer keeps the cache locked
        // for everybody else.
        Ok(search::search_locked(
            &cache,
            &query,
            page,
            PAGE_SIZE,
            &sort,
            Some(token.as_str()),
            resolve.as_ref().map(|(h, i)| (h.as_str(), i.as_str())),
        ))
    })
    .await
    .map_err(|e| format!("搜索任务异常: {e}"))?
}

/// Reads one repository's README for the in-app preview.
#[tauri::command]
pub(crate) async fn repo_readme(full_name: String) -> Result<String, String> {
    let token = read_config().github_token;
    let route = read_config().search_route;
    tauri::async_runtime::spawn_blocking(move || {
        let ip = if route == "bypass" && netpath::read_hosts_state().hijacked {
            resolve_agreed_ip("api.github.com")
        } else {
            None
        };
        search::fetch_readme(&full_name, Some(token.as_str()), ip.as_deref())
    })
    .await
    .map_err(|e| format!("README 任务异常: {e}"))?
}

#[tauri::command]
pub(crate) fn clear_search_cache(settings: tauri::State<'_, Settings>) {
    if let Ok(mut c) = settings.search.lock() {
        c.clear_results();
    }
}

/// Lists one page of the token owner's GitHub stars (r18 N3, 星标导入).
///
/// `/user/starred` has no anonymous form, so `stars::list_starred_page` answers
/// the no-token case with a message pointing at the settings page — the token
/// itself never leaves Rust (see `stars.rs`). The route decision mirrors
/// `search_repositories`: a local accelerator that hijacks `api.github.com`
/// breaks this call for exactly the reason it broke search.
#[tauri::command]
pub(crate) async fn list_starred_repos(page: u32) -> Result<stars::StarPage, String> {
    let token = read_config().github_token;
    let route = read_config().search_route;
    tauri::async_runtime::spawn_blocking(move || {
        let ip = if route == "bypass" && netpath::read_hosts_state().hijacked {
            resolve_agreed_ip("api.github.com")
        } else {
            None
        };
        stars::list_starred_page(page, Some(token.as_str()), ip.as_deref())
    })
    .await
    .map_err(|e| format!("星标列表任务异常: {e}"))?
}

/// Results per page. GitHub caps this at 100; 20 keeps the JSON small and the
/// rate limit is what actually constrains us, not page size.
pub(crate) const PAGE_SIZE: u32 = 20;

