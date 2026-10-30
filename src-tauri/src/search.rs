//! GitHub repository search.
//!
//! Hard constraint: the **unauthenticated** search API allows only **10 requests
//! per minute** (measured against `/rate_limit`). A naive search-as-you-type box
//! would burn that in seconds and then fail. So three mitigations are built in:
//!
//!   1. a short in-memory cache, so repeating or refining a query costs nothing
//!   2. a client-side rate guard that refuses to fire when the budget is spent,
//!      and reports the real remaining count from GitHub's own headers
//!   3. the UI debounces keystrokes; this module never searches on every character
//!
//! HTTP is done with the `curl` binary rather than an HTTP client crate: curl
//! ships with Windows 10 1803+ and with git, and it is what the rest of this
//! project already uses, so there is no extra dependency and no second TLS stack.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const API: &str = "https://api.github.com/search/repositories";

/// GitHub requires a `User-Agent` on every API request and uses it in its
/// traffic logs. It must be derived from the crate version, never hand-written:
/// a literal here goes stale on the next release and then reports a version this
/// build does not have.
///
/// `pub(crate)` from r18-N3/N4 onward: `heat.rs`, the star-list module and `auth.rs` issue
/// the same API calls and must send the identical UA and the identical token-safe curl
/// configuration. Duplicating `curl_with_token` would mean two places to get wrong —
/// the whole point of that helper is that the token never reaches the command line.
pub(crate) const USER_AGENT: &str = concat!("DevHub/", env!("CARGO_PKG_VERSION"));

/// Runs an already-configured curl command with the GitHub token fed via
/// stdin config (`-K -`) instead of a `-H` argument.
///
/// ## Why not a command-line argument
///
/// On Windows, another process can read this process's command line (via the
/// PEB) and would see `Authorization: Bearer <token>` — the token would leak to
/// anything on the machine that looks. curl's `-K -` reads config from stdin in
/// the same syntax as its config file, so the header never appears in argv.
pub(crate) fn curl_with_token(
    mut cmd: std::process::Command,
    token: &str,
) -> std::io::Result<std::process::Output> {
    use std::io::Write;
    use std::process::Stdio;
    cmd.arg("-K").arg("-");
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        // Escape for curl's config-file double-quoted string.
        let escaped = token.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = writeln!(stdin, "header = \"Authorization: Bearer {escaped}\"");
        // Drop stdin so curl sees EOF and starts the request.
    }
    child.wait_with_output()
}

/// How long a result stays usable. Search results change slowly; ten minutes is
/// a reasonable compromise between freshness and staying inside the rate limit.
const CACHE_TTL: Duration = Duration::from_secs(600);

/// GitHub's unauthenticated search allowance, per minute.
const SEARCH_LIMIT_PER_MIN: u32 = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoHit {
    pub full_name: String,
    #[serde(default)]
    pub description: String,
    pub stars: u64,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub topics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub items: Vec<RepoHit>,
    pub total_count: u64,
    /// True when the results came from the local cache instead of the network.
    pub from_cache: bool,
    /// True when GitHub answered `304 Not Modified` to a conditional request and
    /// the stored body was reused. Kept separate from `from_cache` on purpose: a
    /// local TTL hit is *our* decision, a `304` is the *server* confirming the
    /// representation is unchanged, and the UI must be able to say which one
    /// happened rather than blur them into one "cached" label.
    #[serde(default)]
    pub not_modified: bool,
    /// Requests still allowed in the current minute, taken from GitHub's headers.
    /// `None` when unknown (cache hit, or the request failed).
    pub remaining: Option<u32>,
    /// Seconds until the limit resets, when GitHub told us.
    pub reset_in: Option<u64>,
    /// Set when nothing was returned because the local budget was exhausted.
    #[serde(default)]
    pub throttled: bool,
    #[serde(default)]
    pub error: Option<String>,
}

impl SearchOutcome {
    fn empty(error: impl Into<String>) -> Self {
        Self {
            items: Vec::new(),
            total_count: 0,
            from_cache: false,
            not_modified: false,
            remaining: None,
            reset_in: None,
            throttled: false,
            error: Some(error.into()),
        }
    }
}

/// One cached result, plus everything needed to revalidate it later.
struct CacheEntry {
    at: Instant,
    outcome: SearchOutcome,
    /// The exact request URL this entry answers. GitHub's ETag validates **one
    /// URL**: "a different page size, page number, or filter produces a different
    /// response with a different `etag`" (GitHub best-practices page, fetched
    /// 2026-10-17), so an etag is looked up by URL and never by the normalised
    /// query the entry itself is keyed on.
    url: String,
    /// GitHub's `etag` for `url`, verbatim (it keeps the surrounding quotes).
    /// `None` when the response carried none — then there is nothing to
    /// revalidate with and every request for that URL goes out unconditional.
    etag: Option<String>,
}

/// Cache keyed by the exact query, with the time it was stored.
#[derive(Default)]
pub struct SearchCache {
    entries: HashMap<String, CacheEntry>,
    /// Timestamps of recent real network calls, for the local rate guard.
    calls: Vec<Instant>,
}

impl SearchCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn normalize(query: &str) -> String {
        query.trim().to_lowercase()
    }

    /// Returns a cached result when it is still inside the TTL.
    fn get(&self, query: &str) -> Option<SearchOutcome> {
        let key = Self::normalize(query);
        let entry = self.entries.get(&key)?;
        if entry.at.elapsed() < CACHE_TTL {
            let mut hit = entry.outcome.clone();
            hit.from_cache = true;
            // A local TTL hit is not a server-confirmed 304, and the UI labels the
            // two differently, so this must stay false here.
            hit.not_modified = false;
            // A cached answer consumed no quota, so do not claim a remaining count.
            hit.remaining = None;
            hit.reset_in = None;
            hit.throttled = false;
            hit.error = None;
            Some(hit)
        } else {
            None
        }
    }

    /// The etag stored for exactly this URL, if any — the value to send back as
    /// `If-None-Match`.
    fn etag_for_url(&self, url: &str) -> Option<String> {
        self.entries
            .values()
            .find(|e| e.url == url)
            .and_then(|e| e.etag.clone())
    }

    /// The last stored result for this URL, whether or not it is still inside the
    /// TTL. A `304` reuses it: the server has just confirmed the representation has
    /// not changed since that etag, so the body we held is current again.
    fn fallback_for_url(&self, url: &str) -> Option<SearchOutcome> {
        self.entries
            .values()
            .find(|e| e.url == url)
            .map(|e| e.outcome.clone())
    }

    /// Re-stamps an entry a `304` proved still current, so it serves from the TTL
    /// again. The stored body and etag are untouched; only the clock moves.
    fn touch(&mut self, url: &str) {
        if let Some(e) = self.entries.values_mut().find(|e| e.url == url) {
            e.at = Instant::now();
        }
    }

    fn put(&mut self, query: &str, outcome: &SearchOutcome, url: &str, etag: Option<String>) {
        // Drop expired entries first; the old rule cleared everything past the
        // cap, which threw away results still inside the TTL and cost real
        // rate-limit budget to refetch them.
        self.entries.retain(|_, e| e.at.elapsed() < CACHE_TTL);
        // Still over the cap: evict the oldest one, not the whole map. Validators
        // (url + etag) live inside the entry, so this bounds them too.
        while self.entries.len() > 200 {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            Self::normalize(query),
            CacheEntry {
                at: Instant::now(),
                outcome: outcome.clone(),
                url: url.to_string(),
                etag,
            },
        );
    }

    /// True when the local call budget for the current minute is used up.
    fn budget_exhausted(&self) -> bool {
        self.calls
            .iter()
            .filter(|t| t.elapsed() < Duration::from_secs(60))
            .count()
            >= SEARCH_LIMIT_PER_MIN as usize
    }

    fn seconds_until_budget(&self) -> u64 {
        // Round 13 (d3-1): `.min()`, not `.max()`. The budget (a rolling 60s
        // window of `SEARCH_LIMIT_PER_MIN` calls) frees up when the *oldest*
        // call in the window ages out — that call has the *smallest* remaining
        // time. `.max()` returned the newest call's remaining time, so the
        // throttle waited until *every* recent call had expired: correct in
        // never blocking, but it over-waits by up to ~60s and the `reset_in`
        // the UI shows was wrong. `min` is the moment the window actually opens.
        self.calls
            .iter()
            .filter(|t| t.elapsed() < Duration::from_secs(60))
            .map(|t| 60u64.saturating_sub(t.elapsed().as_secs()))
            .min()
            .unwrap_or(0)
    }

    fn record_call(&mut self) {
        self.calls.retain(|t| t.elapsed() < Duration::from_secs(60));
        self.calls.push(Instant::now());
    }

    /// Visible for tests.
    pub fn calls_last_minute(&self) -> usize {
        self.calls
            .iter()
            .filter(|t| t.elapsed() < Duration::from_secs(60))
            .count()
    }

    pub fn remaining_budget(&self) -> u32 {
        SEARCH_LIMIT_PER_MIN.saturating_sub(self.calls_last_minute() as u32)
    }

    /// Clears cached results **and their validators**. An entry owns its etag, so
    /// clearing cannot leave a stale validator behind to revalidate against a body
    /// this cache no longer holds. The rate-limit history is kept, because
    /// forgetting it would let the guard be bypassed and get the IP throttled for
    /// real.
    pub fn clear_results(&mut self) {
        self.entries.clear();
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

/// Builds the API URL for a query and page.
pub fn build_url(query: &str, page: u32, per_page: u32, sort: &str) -> String {
    let sort = if sort.is_empty() { "best-match" } else { sort };
    format!(
        "{API}?q={}&page={}&per_page={}&sort={}&order=desc",
        urlencode(query),
        page.max(1),
        per_page.clamp(1, 50),
        sort
    )
}

/// Minimal percent-encoding for a query string. Enough for search terms; not a
/// general-purpose encoder.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parses a GitHub search response into hits plus the rate-limit headers.
///
/// Split out from the network call so it can be tested against real captured
/// shapes, including the error body GitHub returns when throttled.
pub fn parse_search_response(
    body: &str,
    remaining: Option<u32>,
    reset_in: Option<u64>,
) -> SearchOutcome {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => {
            return SearchOutcome {
                remaining,
                reset_in,
                ..SearchOutcome::empty(format!("无法解析 GitHub 响应: {e}"))
            }
        }
    };

    if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
        let throttled = remaining == Some(0) || msg.to_lowercase().contains("rate limit");
        return SearchOutcome {
            items: Vec::new(),
            total_count: 0,
            from_cache: false,
            not_modified: false,
            remaining,
            reset_in,
            throttled,
            error: Some(msg.to_string()),
        };
    }

    let total_count = json
        .get("total_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let items: Vec<RepoHit> = json
        .get("items")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_repo_item).collect())
        .unwrap_or_default();

    SearchOutcome {
        items,
        total_count,
        from_cache: false,
        not_modified: false,
        remaining,
        reset_in,
        throttled: false,
        error: None,
    }
}

/// Parses one repository object into a [`RepoHit`].
///
/// Shared by search and the starred list (`stars.rs`): GitHub sends the same
/// repo object for both `search/repositories` items and `/user/starred`
/// entries, so the field mapping exists once. An entry without a `full_name`
/// is not a repository and is skipped rather than surfacing as a nameless row.
pub(crate) fn parse_repo_item(it: &serde_json::Value) -> Option<RepoHit> {
    let full_name = it
        .get("full_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if full_name.is_empty() {
        return None;
    }
    Some(RepoHit {
        full_name: full_name.to_string(),
        description: it
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        stars: it
            .get("stargazers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        language: it
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: it
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        archived: it
            .get("archived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        topics: it
            .get("topics")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Pulls the rate-limit headers out of a raw `curl -i` response.
///
/// `curl -i` writes headers then the body, separated by a blank line.
pub fn split_headers(raw: &str) -> (HashMap<String, String>, String) {
    let mut headers = HashMap::new();
    // Redirects can produce several header blocks; use the last one.
    let mut body_start = 0usize;
    let mut search_from = 0usize;
    while let Some(idx) = raw[search_from..].find("\r\n\r\n") {
        let abs = search_from + idx;
        body_start = abs + 4;
        search_from = body_start;
    }
    let head = &raw[..body_start.min(raw.len())];
    for line in head.lines() {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }
    let body = raw[body_start.min(raw.len())..].to_string();
    (headers, body)
}

/// Reads GitHub's `etag` header out of the parsed headers.
///
/// `split_headers` lower-cases header names, and GitHub sends the value quoted
/// (`etag: "644b…"`), so the quotes are kept verbatim — they are part of the
/// validator and `If-None-Match` must echo the value exactly. A blank value is
/// treated as absent: it validates nothing.
pub fn etag_of(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .get("etag")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

/// The HTTP status code of the **last** response block in a `curl -i` capture.
///
/// `curl -i` writes a status line (`HTTP/2 200`, `HTTP/1.1 304 Not Modified`)
/// before each header block, and `-L` may emit several; the status that matters is
/// the last block's, which is the same block `split_headers` takes its headers
/// from. This is what tells a `304` apart from a body — a `304` carries no body,
/// so the body alone cannot.
pub fn status_of(raw: &str) -> Option<u16> {
    let mut body_start = 0usize;
    let mut search_from = 0usize;
    while let Some(idx) = raw[search_from..].find("\r\n\r\n") {
        let abs = search_from + idx;
        body_start = abs + 4;
        search_from = body_start;
    }
    raw.get(..body_start.min(raw.len()))?
        .lines()
        .rfind(|line| line.starts_with("HTTP/"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
}

/// A readable hint when GitHub says the request budget is exhausted.
///
/// `x-ratelimit-remaining: 0` is a fact even on a `200` that happens to answer
/// (some endpoints report the budget before the refusal), so callers may append
/// this to any error. `now_epoch` is injected for the test; production passes
/// the wall clock.
pub(crate) fn rate_limit_hint_at(
    headers: &HashMap<String, String>,
    now_epoch: u64,
) -> Option<String> {
    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.trim().parse::<u64>().ok())?;
    if remaining > 0 {
        return None;
    }
    let minutes = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|reset| reset.saturating_sub(now_epoch).div_ceil(60).max(1));
    Some(match minutes {
        Some(m) => format!(
            "GitHub API 限额已用尽，约 {m} 分钟后恢复；可在设置 → 网络填写令牌以提高额度。"
        ),
        None => "GitHub API 限额已用尽；可在设置 → 网络填写令牌以提高额度。".to_string(),
    })
}

/// [`rate_limit_hint_at`] with the current wall clock.
pub(crate) fn rate_limit_hint(headers: &HashMap<String, String>) -> Option<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rate_limit_hint_at(headers, now)
}

pub(crate) fn which_curl() -> Option<std::path::PathBuf> {
    if let Some(rt) = std::env::var_os("SystemRoot") {
        let p = std::path::PathBuf::from(rt).join("System32/curl.exe");
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

/// True when a curl failure text is the schannel revocation-check failure the
/// local accelerator's self-issued certificate produces on this machine.
///
/// Shared by `search` and `fetch_readme`: both hit `api.github.com` through
/// the same `curl`/schannel stack, so both need the same detection before the
/// automatic hosts bypass retry decides to fire.
pub(crate) fn is_revocation_failure(message: &str) -> bool {
    message.contains("CRYPT_E_NO_REVOCATION_CHECK")
        || message.contains("CRYPT_E_REVOCATION_OFFLINE")
        || message.contains("schannel")
}

/// True when curl rejected the command line rather than the connection.
///
/// `--ssl-revoke-best-effort` is only understood by newer curl. On a build that
/// predates it the retry fails for a reason that has nothing to do with the
/// certificate, and reporting that as a TLS failure would send the user after a
/// problem they do not have — so the original error is kept instead.
pub(crate) fn is_option_unsupported(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("unknown option")
        || m.contains("unrecognized option")
        || m.contains("is unknown")
        || m.contains("unsupported option")
}

/// The hosts-bypass retry: when the first attempt failed with the revocation
/// error and `hosts` still points the API at loopback, dial the real address
/// with `--resolve` and try once more. Returns the replacement IP, if the
/// preconditions (error shape + hijacked hosts + public-DNS agreement) hold.
pub(crate) fn bypass_ip_for_retry(error: Option<&str>, already_resolved: bool) -> Option<String> {
    if already_resolved {
        return None;
    }
    let err = error?;
    if !is_revocation_failure(err) {
        return None;
    }
    if !crate::netpath::read_hosts_state().hijacked {
        return None;
    }
    crate::downloader::resolve_agreed_ip("api.github.com")
}

/// Performs one search, honouring the cache and the local rate guard.
///
/// `resolve` is `(host, ip)`: when present, curl is told to dial that address
/// for the host instead of asking the system resolver — which is the only way to
/// reach the API at all when a local accelerator has pointed `api.github.com` at
/// `127.0.0.1` in the `hosts` file. It is not a security downgrade: the
/// certificate is still checked against the *hostname*, so a wrong address fails
/// the handshake rather than succeeding quietly.
///
/// When the caller passed no `resolve` (the 沿用本地加速 route) and the attempt
/// dies, two remedies are tried in order, and the one that works on the reported
/// machine is the first:
///
///   1. Retry with Schannel's revocation check relaxed. The accelerator's own
///      certificate cannot be *checked* for revocation, which is a different
///      thing from being invalid. This needs no DNS at all.
///   2. Retry against a public-DNS-agreed IP, the same bypass the 绕过 route
///      uses — still worth trying, but it is unavailable when the accelerator
///      also answers DNS, which is why it is no longer the only remedy.
///
/// Either way the user is not forced into the settings page for an error the app
/// can clearly diagnose.
pub fn search(
    cache: &mut SearchCache,
    query: &str,
    page: u32,
    per_page: u32,
    sort: &str,
    token: Option<&str>,
    resolve: Option<(&str, &str)>,
) -> SearchOutcome {
    let trimmed = query.trim();
    let token = token.map(str::trim).filter(|t| !t.is_empty());
    if let Some(early) = short_circuit(cache, trimmed, page, token) {
        return early;
    }
    let (url, validator) = conditional_parts(cache, trimmed, page, per_page, sort);
    let cond = validator.as_ref().map(|(e, p)| (e.as_str(), p));
    let (outcome, charged, etag) = attempt(trimmed, page, per_page, sort, token, resolve, cond);
    record_outcome(cache, trimmed, page, &url, &outcome, charged, etag);
    outcome
}

/// The same flow against the mutex the command layer actually owns.
///
/// [`search`] needs `&mut SearchCache` for its whole body, so calling it from the
/// command held the search-cache mutex for the full duration of curl: `--max-time`
/// 25 s (`run_query`), up to three attempts. `search_status` and
/// `clear_search_cache` lock that same mutex, and `search_status` was a synchronous
/// command — which made one search freeze the window for as long as the request
/// took. Here the lock is taken only for the two sections that need it and is
/// released while the request is in flight.
pub fn search_locked(
    slot: &std::sync::Mutex<SearchCache>,
    query: &str,
    page: u32,
    per_page: u32,
    sort: &str,
    token: Option<&str>,
    resolve: Option<(&str, &str)>,
) -> SearchOutcome {
    let trimmed = query.trim();
    let token = token.map(str::trim).filter(|t| !t.is_empty());
    let early = match slot.lock() {
        Ok(cache) => short_circuit(&cache, trimmed, page, token),
        Err(_) => return SearchOutcome::empty("搜索状态锁已损坏"),
    };
    if let Some(early) = early {
        return early;
    }
    // Read the validator under the lock, then release it for the request: the etag
    // and the body it validated are a snapshot, so the curl call never holds the
    // mutex.
    let (url, validator) = match slot.lock() {
        Ok(cache) => conditional_parts(&cache, trimmed, page, per_page, sort),
        Err(_) => return SearchOutcome::empty("搜索状态锁已损坏"),
    };
    let cond = validator.as_ref().map(|(e, p)| (e.as_str(), p));
    // Nothing guards the slot across this call.
    let (outcome, charged, etag) = attempt(trimmed, page, per_page, sort, token, resolve, cond);
    if let Ok(mut cache) = slot.lock() {
        record_outcome(&mut cache, trimmed, page, &url, &outcome, charged, etag);
    }
    outcome
}

/// The URL for this request, plus what the cache can revalidate it with: the stored
/// etag and the body that etag validated. `None` means no validator was available,
/// so the request goes out unconditional.
///
/// Only page 1 is cached, so only page 1 has a validator to revalidate — and the
/// validator is looked up by the **full URL**, because an etag belongs to one URL.
fn conditional_parts(
    cache: &SearchCache,
    trimmed: &str,
    page: u32,
    per_page: u32,
    sort: &str,
) -> (String, Option<(String, SearchOutcome)>) {
    let url = build_url(trimmed, page, per_page, sort);
    if page > 1 {
        return (url, None);
    }
    match (cache.etag_for_url(&url), cache.fallback_for_url(&url)) {
        (Some(etag), Some(prev)) => (url, Some((etag, prev))),
        _ => (url, None),
    }
}

/// Applies one attempt's result to the cache: charge the budget it really spent,
/// refresh a `304`-revalidated entry, or store a fresh success with its etag.
///
/// A `304` revalidated a body we already held, and GitHub does not count it against
/// the rate limit (see [`SearchOutcome::not_modified`]), so it is charged nothing
/// here — only its timestamp is refreshed, so it serves from the TTL again.
fn record_outcome(
    cache: &mut SearchCache,
    query: &str,
    page: u32,
    url: &str,
    outcome: &SearchOutcome,
    charged: u32,
    etag: Option<String>,
) {
    for _ in 0..charged {
        cache.record_call();
    }
    if outcome.not_modified {
        cache.touch(url);
    } else if outcome.error.is_none() && page <= 1 {
        cache.put(query, outcome, url, etag);
    }
}

/// The outcome a `304 Not Modified` produces: the body we already held, re-labelled
/// as "the server confirmed it is current" rather than "served from the local TTL".
///
/// The rate-limit numbers are kept when the `304` carried them (GitHub usually sends
/// them on every response); they are the server's own count, so repeating them is
/// honest, unlike a local cache hit which has nothing to report.
fn apply_not_modified(
    prev: &SearchOutcome,
    remaining: Option<u32>,
    reset_in: Option<u64>,
) -> SearchOutcome {
    let mut hit = prev.clone();
    hit.from_cache = true;
    hit.not_modified = true;
    hit.remaining = remaining;
    hit.reset_in = reset_in;
    hit.throttled = false;
    hit.error = None;
    hit
}

/// The parts of a search that can be answered without a request: an empty query, a
/// cache hit inside the TTL, or the local anonymous-call budget being spent.
fn short_circuit(
    cache: &SearchCache,
    trimmed: &str,
    page: u32,
    token: Option<&str>,
) -> Option<SearchOutcome> {
    if trimmed.is_empty() {
        return Some(SearchOutcome::empty("请输入搜索关键词"));
    }
    if page <= 1 {
        if let Some(hit) = cache.get(trimmed) {
            return Some(hit);
        }
    }
    // With a token the allowance is far higher, so the local guard would only get
    // in the way. Without one it is what keeps us from being throttled for real.
    if token.is_none() && cache.budget_exhausted() {
        let wait = cache.seconds_until_budget().max(1);
        return Some(SearchOutcome {
            throttled: true,
            reset_in: Some(wait),
            remaining: Some(0),
            ..SearchOutcome::empty(format!(
                "本分钟内的 {SEARCH_LIMIT_PER_MIN} 次匿名搜索额度已用完，请等待约 {wait} 秒。\
                 在设置里填入 GitHub Token 可将额度提高到 30 次/分钟。"
            ))
        });
    }
    None
}

/// One attempt's outcome plus, for a fresh `200`, the etag to remember.
struct QueryResult {
    outcome: SearchOutcome,
    /// The `etag` a body-bearing success carried. `None` for an error, a `304`, or a
    /// response that sent no etag — in every one of those there is nothing new to
    /// revalidate with.
    etag: Option<String>,
}

/// The request and its remedies, plus how many attempts spent the local budget.
///
/// Every attempt charges the budget once **except a `304`**, which GitHub does not
/// count against the rate limit (see [`SearchOutcome::not_modified`]).
///
/// `cond` is `(etag, previous body)`: when present the first request is conditional,
/// and a `304` reuses the previous body instead of refetching.
fn attempt(
    trimmed: &str,
    page: u32,
    per_page: u32,
    sort: &str,
    token: Option<&str>,
    resolve: Option<(&str, &str)>,
    cond: Option<(&str, &SearchOutcome)>,
) -> (SearchOutcome, u32, Option<String>) {
    let bypass = resolve.is_some();
    let mut charged = 0u32;
    let mut r = run_query(trimmed, page, per_page, sort, token, resolve, false, bypass, cond);
    if !r.outcome.not_modified {
        charged += 1;
    }

    // The conditional request must never be the *reason* a search fails: a curl that
    // does not understand how the validator was sent, or a `304` this cache cannot
    // satisfy, degrades to one plain request. The `is_option_unsupported` guard mirrors
    // remedy 1 below — a request-shape problem must not be reported as the network error
    // (`-H` is understood by every curl, so today this is a guard against a future change
    // to how the validator is carried, not a branch the current curl takes).
    if cond.is_some() && r.outcome.error.is_some() {
        let plain = run_query(trimmed, page, per_page, sort, token, resolve, false, bypass, None);
        if !plain.outcome.not_modified {
            charged += 1;
        }
        let unusable = plain
            .outcome
            .error
            .as_deref()
            .map(is_option_unsupported)
            .unwrap_or(false);
        if !unusable {
            r = plain;
        }
    }

    // Remedy 1, and the one that actually works on the reported machine: the
    // failure is Schannel being unable to *check* revocation for the local
    // accelerator's own certificate, so retry with the check relaxed. This does
    // not depend on DNS at all, which matters because the accelerator that
    // rewrites `hosts` usually answers DNS too — and `resolve_agreed_ip` is
    // therefore the one remedy that can be unavailable exactly when it is needed.
    if r.outcome
        .error
        .as_deref()
        .map(is_revocation_failure)
        .unwrap_or(false)
        && cfg!(windows)
    {
        let retried = run_query(trimmed, page, per_page, sort, token, resolve, true, bypass, cond);
        if !retried.outcome.not_modified {
            charged += 1;
        }
        // Keep the original error when curl did not understand the flag: a
        // "unknown option" reported as a TLS failure is worse than the TLS
        // failure the user can act on.
        let unusable = retried
            .outcome
            .error
            .as_deref()
            .map(is_option_unsupported)
            .unwrap_or(false);
        if !unusable {
            r = retried;
        }
    }

    // Remedy 2: the hosts bypass, when a public-DNS-agreed address is available.
    if let Some(ip) = bypass_ip_for_retry(r.outcome.error.as_deref(), resolve.is_some()) {
        // The retry costs one more call against the local budget, counted here and
        // recorded by the caller along with every other attempt.
        let retried = run_query(
            trimmed,
            page,
            per_page,
            sort,
            token,
            Some(("api.github.com", &ip)),
            false,
            true,
            cond,
        );
        if !retried.outcome.not_modified {
            charged += 1;
        }
        r = retried;
    }

    (r.outcome, charged, r.etag)
}

/// One network attempt: builds the curl command and turns the raw output into a
/// `QueryResult`.
///
/// `best_effort` retries a Schannel revocation failure with the check relaxed —
/// see `search` for why that is the first remedy tried. `bypass_requested` only
/// shapes the error text: "you asked to bypass and it still failed" and "you are
/// following the accelerator and it failed" need different advice, and the old
/// unconditional hint told people already set to 绕过 to switch to 绕过.
///
/// `cond` is `(etag, previous body)`: when present the request carries
/// `If-None-Match`, and a `304` answer reuses that previous body.
fn run_query(
    trimmed: &str,
    page: u32,
    per_page: u32,
    sort: &str,
    token: Option<&str>,
    resolve: Option<(&str, &str)>,
    best_effort: bool,
    bypass_requested: bool,
    cond: Option<(&str, &SearchOutcome)>,
) -> QueryResult {
    let curl = match which_curl() {
        Some(c) => c,
        None => {
            return QueryResult {
                outcome: SearchOutcome::empty("找不到 curl，无法访问 GitHub API"),
                etag: None,
            }
        }
    };

    let url = build_url(trimmed, page, per_page, sort);
    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        // -i so we can read the rate-limit headers, not just the body.
        "-i",
        "--no-progress-meter",
        "-L",
        "--max-time",
        "25",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {USER_AGENT}"),
    ]);
    if let Some((etag, _)) = cond {
        // The validator is echoed verbatim: GitHub quotes it, and the quotes are part
        // of the value, so it must not be stripped. `-H` is understood by every curl,
        // so carrying the validator costs no option-existence guard of its own.
        cmd.arg("-H").arg(format!("If-None-Match: {etag}"));
    }
    if let Some((host, ip)) = resolve {
        cmd.arg("--resolve").arg(format!("{host}:443:{ip}"));
    }
    // Windows curl is built on Schannel, which wants a *fresh* revocation answer
    // for the certificate the local accelerator presents. An accelerator does not
    // publish one, so the handshake dies with CRYPT_E_NO_REVOCATION_CHECK — a
    // "could not check" rather than a "certificate is bad". Relaxing only the
    // revocation *source* is the narrow remedy; the certificate is still
    // validated and still has to match the hostname.
    if best_effort && cfg!(windows) {
        cmd.arg("--ssl-revoke-best-effort");
    }
    cmd.arg(&url);

    let out = match token {
        Some(t) => match curl_with_token(cmd, t) {
            Ok(o) => o,
            Err(e) => {
                return QueryResult {
                    outcome: SearchOutcome::empty(format!("无法启动 curl: {e}")),
                    etag: None,
                }
            }
        },
        None => match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                return QueryResult {
                    outcome: SearchOutcome::empty(format!("无法启动 curl: {e}")),
                    etag: None,
                }
            }
        },
    };

    // Not `decode_console`: that function's whole job is Windows *console* bytes,
    // whose codepage is a property of this machine. This is an HTTP response body,
    // and GitHub answers in UTF-8 — running it through the OEM table would
    // reinterpret a non-UTF-8 payload as zh-CN GBK for no reason.
    let raw = String::from_utf8_lossy(&out.stdout).into_owned();
    let (headers, body) = split_headers(&raw);

    let remaining = headers
        .get("x-ratelimit-remaining")
        .and_then(|v| v.parse::<u32>().ok());
    let reset_in = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.parse::<u64>().ok())
        .and_then(|reset_epoch| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some(reset_epoch.saturating_sub(now))
        });

    // A `304` carries no body on purpose, so it must be recognised from the status
    // line and handled *before* the empty-body failure check below — an empty body
    // is the correct shape here, not an error. The stored body is reused because the
    // server has just said the representation has not changed since that etag.
    if status_of(&raw) == Some(304) {
        return QueryResult {
            outcome: match cond {
                Some((_, prev)) => apply_not_modified(prev, remaining, reset_in),
                // A validator is only sent when a body is held, so this should not
                // happen — but a `304` we cannot satisfy must be reported as a miss,
                // never quietly as a success.
                None => SearchOutcome::empty("GitHub 返回 304，但没有可复用的缓存结果"),
            },
            etag: None,
        };
    }

    if !out.status.success() && body.trim().is_empty() {
        // `decode_console`, not `from_utf8_lossy`: curl's error text is
        // formatted by Windows in the OEM codepage, and the lossy decode turned
        // `CRYPT_E_NO_REVOCATION_CHECK - 无法验证证书是否已吊销` into a row of
        // replacement characters, which is what made the reported failure look
        // like a mystery instead of a hosts-file redirect.
        let stderr = crate::proc::decode_console(&out.stderr);
        let trimmed = stderr.trim();
        let hint = if trimmed.contains("CRYPT_E_NO_REVOCATION_CHECK")
            || trimmed.contains("CRYPT_E_REVOCATION_OFFLINE")
        {
            if best_effort {
                // Already the relaxed attempt, and it still failed: the
                // certificate itself is the problem, not the missing revocation
                // source. Telling the user to switch route again would be noise.
                "（已放宽吊销检查重试，仍未通过：本机加速工具提供的证书本身不受信任。）"
            } else if bypass_requested {
                // The user is set to 绕过 but no usable public IP was agreed on,
                // which happens when the accelerator also answers DNS. The old
                // text sent these users to switch to the setting they were on.
                "（已按「绕过」设置尝试直连官方 IP，但本机 DNS 也被加速工具接管，取不到可用地址。\
                 可改为「沿用加速」，让请求走本机加速。）"
            } else {
                "（本机 hosts 可能把 GitHub 指向了 127.0.0.1，通常是本地加速工具的自签证书未通过吊销检查。把「设置 → 网络 → 搜索链路」改成「绕过」即可。）"
            }
        } else if trimmed.contains("Failed to connect to") || trimmed.contains("could not connect") {
            "（连接被拒：hosts 把该域名指向了本机，而本机没有服务在监听。）"
        } else {
            ""
        };
        return QueryResult {
            outcome: SearchOutcome::empty(format!("请求失败: {trimmed}{hint}")),
            etag: None,
        };
    }

    // Success is cached by the caller (`search`), so a failed bypass retry
    // cannot overwrite a good cached page-1 result with an error. The etag is only
    // remembered for a body-bearing success: there is nothing to revalidate with
    // when the answer was an error body.
    let outcome = parse_search_response(&body, remaining, reset_in);
    let etag = if outcome.error.is_none() {
        etag_of(&headers)
    } else {
        None
    };
    QueryResult { outcome, etag }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_SHAPE: &str = r#"{
      "total_count": 2,
      "incomplete_results": false,
      "items": [
        {
          "full_name": "rust-lang/rust",
          "description": "Empowering everyone to build reliable and efficient software.",
          "stargazers_count": 102000,
          "language": "Rust",
          "updated_at": "2026-01-01T00:00:00Z",
          "archived": false,
          "topics": ["compiler", "hacktoberfest"]
        },
        {
          "full_name": "tokio-rs/tokio",
          "description": null,
          "stargazers_count": 28000,
          "language": "Rust",
          "updated_at": "2026-01-02T00:00:00Z",
          "archived": false,
          "topics": []
        }
      ]
    }"#;

    #[test]
    fn parses_a_realistic_search_response() {
        let r = parse_search_response(REAL_SHAPE, Some(9), Some(30));
        assert_eq!(r.total_count, 2);
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].full_name, "rust-lang/rust");
        assert_eq!(r.items[0].stars, 102000);
        assert_eq!(r.items[0].topics, vec!["compiler", "hacktoberfest"]);
        // A null description must not panic and becomes empty.
        assert_eq!(r.items[1].description, "");
        assert_eq!(r.remaining, Some(9));
        assert_eq!(r.reset_in, Some(30));
        assert!(r.error.is_none());
    }

    #[test]
    fn parses_the_rate_limit_error_body_as_throttled() {
        let body = r#"{"message":"API rate limit exceeded for 1.2.3.4.","documentation_url":"https://docs.github.com/rest"}"#;        let r = parse_search_response(body, Some(0), Some(42));
        assert!(r.throttled, "a rate-limit message must set throttled");
        assert!(r.items.is_empty());
        assert!(r.error.as_deref().unwrap_or("").contains("rate limit"));
        assert_eq!(r.reset_in, Some(42));
    }

    #[test]
    fn a_non_rate_limit_message_is_reported_but_not_marked_throttled() {
        let body = r#"{"message":"Validation Failed"}"#;
        let r = parse_search_response(body, Some(5), None);
        assert!(!r.throttled);
        assert_eq!(r.error.as_deref(), Some("Validation Failed"));
    }

    #[test]
    fn invalid_json_yields_an_error_not_a_panic() {
        let r = parse_search_response("<html>gateway error</html>", None, None);
        assert!(r.error.is_some());
        assert!(r.items.is_empty());
    }

    #[test]
    fn revocation_errors_are_recognised_for_the_bypass_retry() {
        // The exact schannel text this machine produces, including the decoded
        // Chinese half. The bypass retry must fire on these...
        assert!(is_revocation_failure(
            "schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK (0x80092012) - 无法验证证书是否已吊销"
        ));
        assert!(is_revocation_failure(
            "schannel: CRYPT_E_REVOCATION_OFFLINE (0x80092013)"
        ));
        assert!(is_revocation_failure("schannel: SEC_E_UNTRUSTED_ROOT (0x80090325)"));
        // ...and not on ordinary failures, or the retry would double every
        // genuine network error for no reason.
        assert!(!is_revocation_failure("Failed to connect to 127.0.0.1 port 443"));
        assert!(!is_revocation_failure("Operation timed out after 25000 ms"));
        assert!(!is_revocation_failure("API rate limit exceeded"));
    }

    #[test]
    fn query_is_url_encoded() {
        let u = build_url("tokio async", 1, 20, "");
        assert!(u.contains("q=tokio+async"), "{u}");
        assert!(u.contains("per_page=20"));
        let u2 = build_url("c++", 1, 20, "stars");
        assert!(u2.contains("q=c%2B%2B"), "{u2}");
        assert!(u2.contains("sort=stars"), "{u2}");
    }

    #[test]
    fn page_and_per_page_are_clamped() {
        let u = build_url("x", 0, 999, "");
        assert!(u.contains("page=1"), "{u}");
        assert!(u.contains("per_page=50"), "{u}");
    }

    #[test]
    fn headers_are_read_from_the_last_block_after_a_redirect() {
        // curl -L can emit an initial 301 block followed by the real response.
        let raw = "HTTP/1.1 301 Moved\r\nLocation: /x\r\n\r\nHTTP/1.1 200 OK\r\nX-RateLimit-Remaining: 7\r\nContent-Type: application/json\r\n\r\n{\"total_count\":0,\"items\":[]}";
        let (h, body) = split_headers(raw);
        assert_eq!(
            h.get("x-ratelimit-remaining").map(String::as_str),
            Some("7")
        );
        assert!(body.starts_with("{\"total_count\""));
    }

    #[test]
    fn a_rate_limit_hint_names_the_wait_and_the_way_out() {
        let mut h = HashMap::new();
        h.insert("x-ratelimit-remaining".to_string(), "0".to_string());
        h.insert("x-ratelimit-reset".to_string(), "1000".to_string());
        let hint = rate_limit_hint_at(&h, 700).expect("exhausted budget must explain itself");
        assert!(hint.contains("5 分钟"), "{hint}");
        assert!(hint.contains("令牌"), "{hint}");
        // Rounded up: 61 seconds is "2 minutes", never "1 minute" that already passed.
        h.insert("x-ratelimit-reset".to_string(), "761".to_string());
        assert!(rate_limit_hint_at(&h, 700).unwrap().contains("2 分钟"));
        // No reset header still gives an actionable sentence.
        h.remove("x-ratelimit-reset");
        assert!(rate_limit_hint_at(&h, 700).unwrap().contains("限额已用尽"));
    }

    #[test]
    fn a_positive_budget_is_not_a_hint() {
        let mut h = HashMap::new();
        h.insert("x-ratelimit-remaining".to_string(), "12".to_string());
        assert_eq!(rate_limit_hint_at(&h, 1_000), None);
        assert_eq!(rate_limit_hint_at(&HashMap::new(), 1_000), None);
        h.insert("x-ratelimit-remaining".to_string(), "not a number".to_string());
        assert_eq!(rate_limit_hint_at(&h, 1_000), None);
    }

    /// The status line and the etag of a `curl -i` capture, read from the last block.
    /// Nothing here touches the network: the shapes are the ones curl writes, captured
    /// by hand, and the point is that a `304` is told apart from a `200` even though a
    /// `304` has no body at all.
    #[test]
    fn status_and_etag_are_read_from_the_last_block() {
        let raw = "HTTP/1.1 301 Moved\r\nLocation: /x\r\n\r\n\
                   HTTP/2 304\r\netag: \"644b5b0155e6404a9cc4bd9d8b1ae730\"\r\n\
                   x-ratelimit-remaining: 9\r\n\r\n";
        let (h, body) = split_headers(raw);
        assert_eq!(status_of(raw), Some(304));
        assert_eq!(
            etag_of(&h).as_deref(),
            Some("\"644b5b0155e6404a9cc4bd9d8b1ae730\""),
            "the quotes are part of the validator and must survive parsing"
        );
        assert_eq!(
            h.get("x-ratelimit-remaining").map(String::as_str),
            Some("9")
        );
        assert!(body.is_empty(), "a 304 has no body — that is not an error");
    }

    #[test]
    fn a_200_block_reports_its_status_and_a_missing_etag_is_absent() {
        let raw = "HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{\"total_count\":0}";
        let (h, _) = split_headers(raw);
        assert_eq!(status_of(raw), Some(200));
        assert!(etag_of(&h).is_none(), "no etag header means nothing to revalidate");

        // An etag header present but blank validates nothing, so it is treated as absent.
        let (blank, _) = split_headers("HTTP/2 200\r\netag:\r\n\r\n{}");
        assert!(etag_of(&blank).is_none());
    }

    #[test]
    fn cache_returns_a_hit_and_marks_it() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        let r = parse_search_response(REAL_SHAPE, Some(9), Some(30));
        cache.put("rust", &r, &url, None);
        let hit = cache.get("rust").expect("cached");
        assert!(hit.from_cache);
        // A local TTL hit is NOT a server-confirmed 304 — the UI labels them differently.
        assert!(!hit.not_modified);
        assert_eq!(hit.items.len(), 2);
        // A cache hit spends no quota, so it must not claim a remaining count.
        assert!(hit.remaining.is_none());
        // Lookup is case- and whitespace-insensitive.
        assert!(cache.get("  RUST ").is_some());
        assert!(cache.get("python").is_none());
    }

    #[test]
    fn a_stored_validator_is_looked_up_by_url_not_by_query() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        let other = build_url("rust async", 1, 20, "");
        cache.put(
            "rust",
            &parse_search_response(REAL_SHAPE, None, None),
            &url,
            Some("\"v1\"".to_string()),
        );
        assert_eq!(cache.etag_for_url(&url).as_deref(), Some("\"v1\""));
        assert!(
            cache.etag_for_url(&other).is_none(),
            "an etag belongs to exactly one URL (a different query or page has a different etag)"
        );
    }

    #[test]
    fn a_page_beyond_one_has_no_validator() {
        // Only page 1 is cached, so only page 1 can be revalidated.
        let cache = SearchCache::new();
        let (_, v) = conditional_parts(&cache, "rust", 2, 20, "");
        assert!(v.is_none());
    }

    #[test]
    fn a_304_reuses_the_previous_result_and_is_distinct_from_a_local_hit() {
        let first = parse_search_response(REAL_SHAPE, Some(5), Some(30));
        let revalidated = apply_not_modified(&first, Some(4), Some(29));
        // A 304 keeps the body and reports the server's own count...
        assert_eq!(revalidated.items.len(), 2);
        assert_eq!(revalidated.remaining, Some(4));
        assert_eq!(revalidated.reset_in, Some(29));
        assert!(revalidated.from_cache && revalidated.not_modified);
        // ...while a local TTL hit reports no count and never claims a 304.
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        cache.put("rust", &first, &url, Some("\"v1\"".to_string()));
        let local = cache.get("rust").expect("cached");
        assert!(local.from_cache && !local.not_modified);
        assert!(local.remaining.is_none());
    }

    #[test]
    fn a_304_spends_no_local_budget_and_keeps_the_entry() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        let first = parse_search_response(REAL_SHAPE, Some(5), Some(30));
        cache.put("rust", &first, &url, Some("\"v1\"".to_string()));
        let revalidated = apply_not_modified(&first, None, None);
        // Exactly what `record_outcome` does for a 304: charged 0, etag None.
        record_outcome(&mut cache, "rust", 1, &url, &revalidated, 0, None);
        assert_eq!(
            cache.calls_last_minute(),
            0,
            "GitHub does not count a 304 against the rate limit, so the local guard must not either"
        );
        assert_eq!(cache.entry_count(), 1, "the revalidated entry is kept, not refetched");
        assert_eq!(cache.etag_for_url(&url).as_deref(), Some("\"v1\""));
    }

    #[test]
    fn a_fresh_success_stores_its_etag_and_charges_one_call() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        let r = parse_search_response(REAL_SHAPE, Some(5), Some(30));
        record_outcome(&mut cache, "rust", 1, &url, &r, 1, Some("\"abc\"".to_string()));
        assert_eq!(cache.calls_last_minute(), 1);
        assert_eq!(cache.etag_for_url(&url).as_deref(), Some("\"abc\""));
    }

    #[test]
    fn clearing_results_also_forgets_the_etags() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        cache.put(
            "rust",
            &parse_search_response(REAL_SHAPE, None, None),
            &url,
            Some("\"v1\"".to_string()),
        );
        assert!(cache.etag_for_url(&url).is_some());
        cache.clear_results();
        assert_eq!(cache.entry_count(), 0);
        assert!(
            cache.etag_for_url(&url).is_none(),
            "clear_search_cache must not leave a validator pointing at a body it no longer holds"
        );
    }

    #[test]
    fn the_local_guard_stops_after_the_anonymous_budget() {
        let mut cache = SearchCache::new();
        assert_eq!(cache.remaining_budget(), SEARCH_LIMIT_PER_MIN);
        for _ in 0..SEARCH_LIMIT_PER_MIN {
            assert!(!cache.budget_exhausted());
            cache.record_call();
        }
        assert!(
            cache.budget_exhausted(),
            "budget must run out after the limit"
        );
        assert_eq!(cache.remaining_budget(), 0);
        assert!(cache.seconds_until_budget() > 0);
    }

    #[test]
    fn a_revocation_failure_is_recognised_by_either_code() {
        assert!(is_revocation_failure(
            "curl: (35) schannel: next InitializeSecurityContext failed: \
             CRYPT_E_NO_REVOCATION_CHECK (0x80092012)"
        ));
        assert!(is_revocation_failure("CRYPT_E_REVOCATION_OFFLINE"));
        // A plain connection refusal is a different problem with a different
        // remedy, and must not be sent down the revocation retry path.
        assert!(!is_revocation_failure(
            "curl: (7) Failed to connect to api.github.com port 443: Connection refused"
        ));
    }

    #[test]
    fn an_unknown_curl_flag_is_not_mistaken_for_a_tls_failure() {
        assert!(is_option_unsupported(
            "curl: option --ssl-revoke-best-effort: is unknown"
        ));
        assert!(is_option_unsupported("unrecognized option --ssl-revoke-best-effort"));
        assert!(!is_option_unsupported(
            "curl: (35) schannel: CRYPT_E_NO_REVOCATION_CHECK"
        ));
    }

    #[test]
    fn empty_query_is_rejected_before_any_request() {
        let mut cache = SearchCache::new();
        let r = search(&mut cache, "   ", 1, 20, "", None, None);
        assert!(r.error.is_some());
        // No call was recorded, so the budget is untouched.
        assert_eq!(cache.calls_last_minute(), 0);
    }

    #[test]
    fn throttling_is_reported_without_touching_the_network() {
        let mut cache = SearchCache::new();
        for _ in 0..SEARCH_LIMIT_PER_MIN {
            cache.record_call();
        }
        let r = search(&mut cache, "rust", 1, 20, "", None, None);
        assert!(r.throttled);
        assert!(r.items.is_empty());
        assert!(r.reset_in.unwrap_or(0) > 0);
        assert!(r.error.as_deref().unwrap_or("").contains("额度已用完"));
    }

    #[test]
    fn clearing_results_keeps_the_rate_history() {
        let mut cache = SearchCache::new();
        cache.record_call();
        let url = build_url("x", 1, 20, "");
        cache.put("x", &parse_search_response(REAL_SHAPE, None, None), &url, None);
        assert_eq!(cache.entry_count(), 1);
        cache.clear_results();
        assert_eq!(cache.entry_count(), 0);
        assert_eq!(
            cache.calls_last_minute(),
            1,
            "forgetting the call history would let the guard be bypassed"
        );
    }

    /// The cached/throttled verdicts are the ones that need no request, and they are
    /// exactly the ones `search_locked` must produce while holding the mutex only for
    /// that check. Pinned here so the split into `short_circuit` + `attempt` cannot
    /// silently change what a caller sees.
    #[test]
    fn locked_slot_serves_a_hit_and_leaves_the_budget_untouched() {
        let mut cache = SearchCache::new();
        let url = build_url("rust", 1, 20, "");
        cache.put("rust", &parse_search_response(REAL_SHAPE, None, None), &url, None);
        let slot = std::sync::Mutex::new(cache);
        let r = search_locked(&slot, "rust", 1, 20, "", None, None);
        assert!(r.from_cache, "a TTL hit must not become a request");
        assert_eq!(r.items.len(), 2);
        assert_eq!(
            slot.lock().unwrap().calls_last_minute(),
            0,
            "a cache hit consumed no local budget"
        );
    }

    #[test]
    fn locked_slot_throttles_anonymous_searches_before_the_network() {
        let mut cache = SearchCache::new();
        for _ in 0..SEARCH_LIMIT_PER_MIN {
            cache.record_call();
        }
        let slot = std::sync::Mutex::new(cache);
        let r = search_locked(&slot, "golang", 1, 20, "", None, None);
        assert!(r.throttled);
        assert!(r.error.as_deref().unwrap_or("").contains("额度已用完"));
    }

    /// A poisoned mutex must not take the process down: `search_locked` is reached
    /// from a `spawn_blocking` worker, and the previous code path returned an `Err`
    /// to the command instead. Same visible answer, no panic.
    #[test]
    fn locked_slot_reports_a_poisoned_mutex_instead_of_panicking() {
        let slot = std::sync::Arc::new(std::sync::Mutex::new(SearchCache::new()));
        let poison = std::sync::Arc::clone(&slot);
        let h = std::thread::spawn(move || {
            let _g = poison.lock().unwrap();
            panic!("poison the search cache on purpose");
        });
        assert!(h.join().is_err(), "the poisoning thread must have panicked");
        let r = search_locked(&slot, "rust", 1, 20, "", None, None);
        assert!(
            r.error.as_deref().unwrap_or("").contains("锁已损坏"),
            "got {:?}",
            r.error
        );
    }
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

/// Fetches one repository's README as raw text.
///
/// This exists so a search result can be read without leaving the app — the
/// report was that the only thing a result could do was fill the composer.
/// `/repos/{full}/readme` with `Accept: application/vnd.github.raw` returns the
/// file itself, so no base64 decoding and no second request for the download
/// URL, and it works for whatever filename the repository chose.
///
/// The same routing decision as search applies: when `hosts` points GitHub at
/// loopback and the user chose 绕过, this must pin the address too, or the
/// in-app README fails for exactly the reason the search used to.
///
/// And the same automatic recovery as search: an un-pinned attempt that dies on
/// the accelerator's certificate revocation error is retried once with a
/// public-DNS-agreed IP when `hosts` is hijacked.
pub fn fetch_readme(full_name: &str, token: Option<&str>, resolve: Option<&str>) -> Result<String, String> {
    let first = fetch_readme_once(full_name, token, resolve, false);
    // Same two remedies, same order, as `search`: relaxing the revocation check
    // needs no DNS and is what actually gets through a local accelerator.
    let after_revocation = match first {
        Err(e) if is_revocation_failure(&e) && cfg!(windows) => {
            let retried = fetch_readme_once(full_name, token, resolve, true);
            match &retried {
                // Keep the original error when curl did not understand the flag.
                Err(e2) if is_option_unsupported(e2) => Err(e),
                _ => retried,
            }
        }
        ok => ok,
    };
    match after_revocation {
        Err(e) => match bypass_ip_for_retry(Some(&e), resolve.is_some()) {
            Some(ip) => fetch_readme_once(full_name, token, Some(&ip), false),
            None => Err(e),
        },
        ok => ok,
    }
}

fn fetch_readme_once(
    full_name: &str,
    token: Option<&str>,
    resolve: Option<&str>,
    best_effort: bool,
) -> Result<String, String> {
    let name = full_name.trim().trim_matches('/');
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err("仓库名应为 owner/repo".to_string());
    }
    let curl = which_curl().ok_or("找不到 curl")?;
    let url = format!("https://api.github.com/repos/{name}/readme");
    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        "--no-progress-meter",
        "-L",
        "--max-time",
        "20",
        "-H",
        "Accept: application/vnd.github.raw",
        "-H",
        &format!("User-Agent: {USER_AGENT}"),
    ]);
    if let Some(ip) = resolve {
        cmd.arg("--resolve").arg(format!("api.github.com:443:{ip}"));
    }
    if best_effort && cfg!(windows) {
        cmd.arg("--ssl-revoke-best-effort");
    }
    cmd.arg(&url);
    let authed = token.filter(|t| !t.trim().is_empty());
    let out = match authed {
        Some(t) => curl_with_token(cmd, t).map_err(|e| format!("无法启动 curl: {e}"))?,
        None => cmd.output().map_err(|e| format!("无法启动 curl: {e}"))?,
    };
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        return Err(format!("读取 README 失败: {}", err.trim()));
    }
    // Same rule as the API response above: a README's bytes belong to the repository,
    // not to this machine's console codepage, so a Shift-JIS or Latin-1 README must not
    // be silently re-encoded as Chinese.
    let body = String::from_utf8_lossy(&out.stdout).into_owned();
    if body.trim().is_empty() {
        return Err("这个仓库没有 README".to_string());
    }
    // A repository README long enough to be a problem for the webview is rare,
    // but a 1 MB one is not worth rendering either.
    const CAP: usize = 200_000;
    if body.len() <= CAP {
        return Ok(body);
    }
    // Byte slicing at `CAP` panics when it lands inside a multi-byte character —
    // and a CJK-heavy README is exactly the case where byte index 200 000 is
    // almost never a char boundary. The panic surfaced to the user as 「任务异常」
    // on a repository they could otherwise read.
    let mut cut = CAP;
    while !body.is_char_boundary(cut) {
        cut -= 1;
    }
    Ok(format!("{}\n\n…（已截断）", &body[..cut]))
}
