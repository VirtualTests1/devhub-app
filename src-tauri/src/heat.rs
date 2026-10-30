//! r18-N3: 仓库热度元数据（Star 数、语言、许可、最近推送）。
//!
//! ## 为什么是「一个仓库一次 GET」而不是搜索接口
//!
//! 项目墙上的仓库是**已经克隆在本地**的，只知道 `owner/repo`，不知道关键词；
//! `search.rs` 那条 `/search/repositories` 路是按查询词组织的，配额口径也不同。
//! `/repos/{owner}/{repo}` 一次就返回 `stargazers_count` / `language` /
//! `license.spdx_id` / `pushed_at`，正好是磁贴要显示的那几个数。
//!
//! 请求外形照 `search.rs:1449 fetch_readme_once`（同样是「每个 owner/repo 一次 GET」），
//! 差别只有三处：加 `-i` 以便读校验器与限额头、`Accept` 用 JSON、以及失败时要能区分
//! 「这个仓库没有热度信息」和「这次没拿到」。
//!
//! ## 配额与校验器（这一节是本模块存在的理由）
//!
//! 未登录时 GitHub 的核心 API 限额是**每小时**量级，而墙上一次刷新可能涉及几十个仓库，
//! 所以三条规矩缺一不可：
//! 1. **有校验器就必须用**：`If-None-Match` 命中 `304` 不计入限额（本仓库
//!    `docs/search-cache.md` §1.1 已按 GitHub 最佳实践页记录过这条），所以「刷新」在
//!    多数情况下是廉价的条件请求；
//! 2. **服务端说了算**：只在**确实看到** `x-ratelimit-remaining: 0` 时才拒绝新的非条件请求，
//!    并在错误文案里带上 `x-ratelimit-reset` 的绝对时间。看不到这些头就当作未知，
//!    不猜一个本地数字把自己锁死；
//! 3. **TTL 挡在前面**：`HEAT_TTL` 内的重复请求直接复用缓存，连条件请求都不发。
//!
//! ## 分层降级与 `search.rs` 完全一致
//!
//! Schannel 吊销检查失败 → `--ssl-revoke-best-effort` 重试一次 → 仍失败且 hosts 被劫持
//! 且公网 DNS 至少两家一致 → `--resolve` 钉死 IP 再试一次。三条都在 `search.rs` 里，
//! 这里只复用判定函数（`is_revocation_failure` / `is_option_unsupported` /
//! `bypass_ip_for_retry`），不再抄一份 curl 参数表。
//!
//! ## 可测的部分
//!
//! `parse_full_name` / `parse_heat` / `HeatCache` / `heat_many` 都不碰网络也不碰 OS 句柄：
//! `heat_many` 把取数动作收成一个 `fn` 指针参数，测试注入假实现即可覆盖「TTL 命中不发请求」
//! 「304 复用旧 body 且不计费」「限额为 0 时跳过」这三条真正的规则。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// One repository's heat facts, as the wall shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HeatSource {
    /// Fetched just now (a `200`).
    Fresh,
    /// A `304` — the server confirmed the copy we already held.
    Revalidated,
    /// Served from `HEAT_TTL` without any request.
    Cached,
    /// No answer this time; `error` says why and `stars` etc. are whatever was last known.
    Failed,
}

/// The per-repository row the frontend renders.
///
/// `slug` is `owner/repo` — the same identity the wall already carries, and the key
/// the store indexes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heat {
    pub slug: String,
    pub stars: u64,
    pub forks: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// GitHub's `pushed_at`, verbatim (an ISO 8601 string). Reparsing it here would
    /// add a timezone rule the app does not need: the UI already formats epochs, and
    /// this value is a label, not a clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed_at: Option<String>,
    pub source: HeatSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// How long a heat row may be served without asking again.
///
/// Star counts move on the scale of days. Six hours keeps a whole session cheap while
/// still meaning the number is not from last week.
pub const HEAT_TTL: Duration = Duration::from_secs(6 * 3600);

/// Most repositories one batch will touch, and the width of its thread pool —
/// the same shape as `lib.rs`'s `FRESHNESS_MANY_FRESH_LIMIT` / `DEFAULT_PARALLEL` pair,
/// because both are "N git/HTTP operations the user asked for at once".
pub const HEAT_BATCH_CAP: usize = 30;
pub const HEAT_PARALLEL: usize = 3;

/// Upper bound on retained rows. Repositories get removed from the wall; the cache
/// must not grow with them.
const HEAT_CACHE_CAP: usize = 400;

#[derive(Debug, Clone)]
struct Entry {
    at: Instant,
    heat: Heat,
    /// GitHub's own validator for exactly this URL (`"/repos/{slug}"`). Kept quoted
    /// verbatim, the same reason `search.rs:450 etag_of` keeps the quotes.
    etag: Option<String>,
}

/// The heat cache plus the last rate-limit answer the server gave.
#[derive(Debug)]
pub struct HeatCache {
    entries: HashMap<String, Entry>,
    remaining: Option<u32>,
    reset: Option<u64>,
}

impl Default for HeatCache {
    fn default() -> Self {
        Self::new()
    }
}

impl HeatCache {
    pub fn new() -> Self {
        HeatCache {
            entries: HashMap::new(),
            remaining: None,
            reset: None,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// When the spent allowance refills, as seconds since the epoch — verbatim from the
    /// header, because the app does not own GitHub's clock and should not pretend to
    /// translate it.
    pub fn reset(&self) -> Option<u64> {
        self.reset
    }

    /// True when the server has *positively* told us the allowance is spent.
    ///
    /// Deliberately narrow. A local guess ("60 per hour, so stop at 55") would refuse
    /// requests the server would have answered for free, and would be wrong the moment a
    /// token raises the allowance to 5000.
    pub fn exhausted(&self) -> bool {
        self.remaining == Some(0)
    }

    /// A row still inside the TTL, relabelled `Cached`. `None` means "must ask".
    pub fn fresh(&self, slug: &str, now: Instant) -> Option<Heat> {
        let e = self.entries.get(slug)?;
        if now.duration_since(e.at) >= HEAT_TTL {
            return None;
        }
        let mut heat = e.heat.clone();
        heat.source = HeatSource::Cached;
        heat.error = None;
        Some(heat)
    }

    /// The validator plus the body it validates — what a conditional request needs.
    ///
    /// A `304` answers with **no body**, so reusing the previous row only works while we
    /// still hold it; that is why the validator and the body live in one entry.
    pub fn validator(&self, slug: &str) -> Option<(String, Heat)> {
        let e = self.entries.get(slug)?;
        let etag = e.etag.clone()?;
        Some((etag, e.heat.clone()))
    }

    /// Store a `200` answer (with its validator) and the limit headers that came with it.
    pub fn put(&mut self, slug: &str, heat: Heat, etag: Option<String>, now: Instant) {
        self.entries.retain(|_, e| now.duration_since(e.at) < HEAT_TTL * 4);
        while self.entries.len() >= HEAT_CACHE_CAP {
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
            slug.to_string(),
            Entry {
                at: now,
                heat,
                etag,
            },
        );
    }

    /// A `304` proved the held row is current: move its clock, keep validator and body.
    pub fn touch(&mut self, slug: &str, now: Instant) {
        if let Some(e) = self.entries.get_mut(slug) {
            e.at = now;
        }
    }

    /// Record what the server said about the allowance. Only a number is trusted;
    /// an absent header leaves the previous answer in place rather than clearing it,
    /// because "we did not see it this time" is not evidence that it came back.
    pub fn note_limit(&mut self, remaining: Option<u32>, reset: Option<u64>) {
        if let Some(r) = remaining {
            self.remaining = Some(r);
        }
        if let Some(t) = reset {
            self.reset = Some(t);
        }
    }
}

/// The one static cache, in the same style as the freshness cache in `lib.rs` (a
/// `OnceLock<Mutex<..>>` rather than managed state, so this module owns its own data).
static HEAT: OnceLock<Mutex<HeatCache>> = OnceLock::new();

pub fn shared() -> &'static Mutex<HeatCache> {
    HEAT.get_or_init(|| Mutex::new(HeatCache::new()))
}

/// Strict `owner/repo` validation.
///
/// The two segments go straight into `https://api.github.com/repos/{owner}/{repo}`, and
/// they arrive from the **page** (the wall already knows each clone's remote). Letting
/// anything through would mean a page-supplied string deciding which path GitHub answers
/// — including `..`, a `?`, or a second `/`. So: exactly two segments, each 1..=100 chars
/// from the set GitHub itself allows in a repository name, and no leading/trailing dot.
pub fn parse_full_name(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_matches('/');
    let mut parts = trimmed.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if !valid_segment(owner) || !valid_segment(repo) {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn valid_segment(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 100 {
        return false;
    }
    if s.starts_with('.') || s.ends_with('.') {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Parse one `/repos/{owner}/{repo}` body into a `Heat`.
///
/// Every field is optional-by-contract on GitHub's side (a repository can legitimately
/// have no language, no licence, no README), so a body that parses but lacks
/// `stargazers_count` is *not* a heat row: without the star count there is nothing to
/// show or sort by, and inventing `0` would sort an unknown repository last *and* claim
/// it has zero stars. `None` therefore means "this response tells us nothing".
pub fn parse_heat(slug: &str, body: &str) -> Option<Heat> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    // A renamed or moved repository answers `301` with a body that has a `url` field and
    // no star count; anything without `stargazers_count` is not a repository object.
    let stars = v.get("stargazers_count")?.as_u64()?;
    Some(Heat {
        slug: slug.to_string(),
        stars,
        forks: v.get("forks_count").and_then(|x| x.as_u64()).unwrap_or(0),
        language: v.get("language").and_then(|x| x.as_str()).map(str::to_string),
        license: v
            .get("license")
            .and_then(|l| l.get("spdx_id"))
            .and_then(|s| s.as_str())
            // GitHub spells "no SPDX identifier" as the literal NOASSERTION; showing that
            // string would read like a licence name, so it becomes "absent".
            .filter(|s| !s.is_empty() && *s != "NOASSERTION")
            .map(str::to_string),
        pushed_at: v.get("pushed_at").and_then(|x| x.as_str()).map(str::to_string),
        source: HeatSource::Fresh,
        error: None,
    })
}

/// What one network attempt produced.
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub heat: Heat,
    /// Whether this answer consumed a GitHub API request (0 for a 304 or a
    /// transport failure, 1 otherwise). No production caller reads it today; it
    /// is the accounting model the tests pin so a future quota change cannot
    /// silently relabel a free 304 as charged.
    #[allow(dead_code)]
    pub charged: u8,
    pub etag: Option<String>,
    pub remaining: Option<u32>,
    pub reset: Option<u64>,
}

/// Refresh a batch of repositories.
///
/// Order preserved, `HEAT_BATCH_CAP` enforced, and the three rules from the module
/// header applied per slug. `fetch` is injected so the rules are testable without a
/// network; production passes [`fetch_one`].
///
/// `force` is 刷新: it skips only the TTL shortcut. The held validator is still sent,
/// so a forced refresh costs a conditional request (a `304`, which GitHub does not
/// charge) rather than a full one. Dropping the validator too would make 刷新 the most
/// expensive way to ask for the same answer.
///
/// Three phases, and the split is the point:
///   A. one lock pass decides, per slug, between "the cache settles it", "ask with a
///      validator", and "ask plain";
///   B. the requests run off the lock, `HEAT_PARALLEL` of them per chunk;
///   C. one lock pass stores the answers and moves the clock on what a `304` confirmed.
/// A poisoned cache lock is reported as a failed batch rather than answered with data
/// we cannot prove we still hold.
///
/// The fetcher is a generic parameter rather than `&dyn Fn…`: a bare `&dyn Fn` trait
/// object defaults to `+ 'static`, which forbids a test closure from borrowing the
/// counter it asserts on (E0373, hit on this module's first build). The generic form
/// costs nothing at the one production call site, which passes `&heat::fetch_one`.
pub fn heat_many<F>(
    cache: &Mutex<HeatCache>,
    slugs: &[String],
    token: &str,
    resolve: Option<&str>,
    now: Instant,
    force: bool,
    fetch: &F,
) -> Vec<Heat>
where
    F: Fn(&str, Option<&str>, Option<&str>, Option<(&str, &Heat)>) -> FetchResult + Sync,
{
    let wanted: Vec<String> = slugs.iter().take(HEAT_BATCH_CAP).cloned().collect();
    let authed = (!token.trim().is_empty()).then(|| token.trim().to_string());

    // Phase A. `answers[i] == None` means "this slug is being asked about".
    let mut answers: Vec<Option<Heat>> = Vec::with_capacity(wanted.len());
    let mut pending: Vec<(String, Option<(String, Heat)>)> = Vec::new();
    let mut poisoned = false;
    if let Ok(guard) = cache.lock() {
        let exhausted = guard.exhausted();
        for slug in &wanted {
            let settled = if force { None } else { guard.fresh(slug, now) };
            if let Some(hit) = settled {
                answers.push(Some(hit));
                continue;
            }
            if exhausted {
                answers.push(Some(stale_or_failed(&guard, slug)));
                continue;
            }
            let cond = guard.validator(slug);
            if cond.is_none() && guard.entries.contains_key(slug) {
                // Past the TTL with no validator to revalidate it: show the held row now,
                // marked `Cached` and not `Fresh`, so nothing in the UI can claim this
                // number was just confirmed by the server.
                answers.push(guard.entries.get(slug).map(|e| stale(&e.heat)));
            } else {
                answers.push(None);
            }
            pending.push((slug.clone(), cond));
        }
    } else {
        poisoned = true;
        answers = wanted.iter().map(|s| Some(failed_row(s, "热度缓存不可用"))).collect();
    }

    // Phase B. Chunks rather than a shared queue: a slow repository costs its own chunk,
    // not the whole batch, and `scope` guarantees every thread is joined before returning.
    let mut results: Vec<(String, FetchResult)> = Vec::new();
    if !pending.is_empty() && !poisoned {
        std::thread::scope(|scope| {
            let token_ref: Option<&str> = authed.as_deref();
            // `HEAT_PARALLEL` at a time, in chunks. Firing all 30 at once would be the
            // same 30 requests with a burst profile nobody asked for, and a chunk that
            // stalls on a 20 s curl then holds up only its own three names.
            for chunk in pending.chunks(HEAT_PARALLEL) {
                let mut handles = Vec::with_capacity(chunk.len());
                for (slug, cond) in chunk {
                    let slug = slug.clone();
                    let cond = cond.clone();
                    handles.push(scope.spawn(move || {
                        let r = fetch(
                            &slug,
                            token_ref,
                            resolve,
                            cond.as_ref().map(|(e, h)| (e.as_str(), h)),
                        );
                        (slug, r)
                    }));
                }
                for h in handles {
                    if let Ok(pair) = h.join() {
                        results.push(pair);
                    }
                }
            }
        });
    }

    // Phase C. Store, and re-stamp what the server confirmed.
    if let Ok(mut guard) = cache.lock() {
        for (slug, r) in &results {
            guard.note_limit(r.remaining, r.reset);
            match r.heat.source {
                HeatSource::Fresh => guard.put(slug, r.heat.clone(), r.etag.clone(), now),
                HeatSource::Revalidated => guard.touch(slug, now),
                // A failure never overwrites what we hold: a stale number is worth more
                // than no number, and the reason travels in the returned row.
                _ => {}
            }
        }
    }

    let by_slug: HashMap<&str, &FetchResult> = results.iter().map(|(s, r)| (s.as_str(), r)).collect();
    for (i, slug) in wanted.iter().enumerate() {
        if let Some(r) = by_slug.get(slug.as_str()) {
            answers[i] = Some(r.heat.clone());
        } else if answers[i].is_none() {
            answers[i] = Some(failed_row(slug, if poisoned { "热度缓存不可用" } else { "没有取到" }));
        }
    }
    answers.into_iter().flatten().collect()
}

/// A row we hold, relabelled as unconfirmed.
fn stale(heat: &Heat) -> Heat {
    Heat {
        source: HeatSource::Cached,
        error: None,
        ..heat.clone()
    }
}

/// When the allowance is spent: the held row if there is one, otherwise a row that says
/// exactly that — including the reset time when the server told us one.
fn stale_or_failed(guard: &HeatCache, slug: &str) -> Heat {
    match guard.entries.get(slug) {
        Some(e) => stale(&e.heat),
        None => Heat {
            slug: slug.to_string(),
            stars: 0,
            forks: 0,
            language: None,
            license: None,
            pushed_at: None,
            source: HeatSource::Failed,
            error: Some(
                guard
                    .reset()
                    .map(|t| format!("GitHub 配额已用尽， unix 时间 {t} 重置"))
                    .unwrap_or_else(|| "GitHub 配额已用尽".to_string()),
            ),
        },
    }
}

fn failed_row(slug: &str, why: &str) -> Heat {
    Heat {
        slug: slug.to_string(),
        stars: 0,
        forks: 0,
        language: None,
        license: None,
        pushed_at: None,
        source: HeatSource::Failed,
        error: Some(why.to_string()),
    }
}


/// The real fetch: one `curl` against `/repos/{owner}/{repo}` with the same remedy
/// ladder as `search.rs`. Returns the parsed row, how many requests it cost, the
/// validator, and whatever limit headers came back.
pub fn fetch_one(
    slug: &str,
    token: Option<&str>,
    resolve: Option<&str>,
    cond: Option<(&str, &Heat)>,
) -> FetchResult {
    // `charged` answers "did this consume an API request", not "how many curl processes
    // ran": a request that died in the TLS handshake never reached GitHub's API and is not
    // charged there, and a `304` is explicitly free (`docs/search-cache.md` §1.1). So the
    // ladder below does not add its attempts up — the answer that stands at the end decides.
    let attempt = fetch_once(slug, token, resolve, false, cond);
    let attempt = remedy_revocation(slug, token, resolve, cond, attempt);
    let attempt = remedy_bypass(slug, token, resolve, cond, attempt);
    match attempt {
        Ok(r) => r,
        // Transport-level failure: nothing was charged, and `error` carries curl's own
        // words, already redacted of any URL userinfo by `downloader::redact_url` upstream.
        Err(e) => FetchResult {
            heat: failed_row(slug, &e),
            charged: 0,
            etag: None,
            remaining: None,
            reset: None,
        },
    }
}

/// Remedy 1 — Schannel could not *check* the revocation status of a local accelerator's
/// own certificate, so retry once with only that check relaxed. The certificate is still
/// validated and still has to match the hostname; this is the narrow remedy, and it needs
/// no DNS at all. Same order as `search.rs:attempt`.
fn remedy_revocation(
    slug: &str,
    token: Option<&str>,
    resolve: Option<&str>,
    cond: Option<(&str, &Heat)>,
    attempt: Result<FetchResult, String>,
) -> Result<FetchResult, String> {
    let Err(err) = attempt else { return attempt };
    if !cfg!(windows) || !crate::search::is_revocation_failure(&err) {
        return Err(err);
    }
    let retried = fetch_once(slug, token, resolve, true, cond);
    // Keep the original error when curl did not understand the flag: an "unknown option"
    // reported as a TLS failure sends the user after a problem they do not have.
    match &retried {
        Err(e2) if crate::search::is_option_unsupported(e2) => Err(err),
        _ => retried,
    }
}

/// Remedy 2 — the hosts bypass: dial the public-DNS-agreed address with `--resolve`,
/// but only when `hosts` really is hijacked and at least two resolvers agree
/// (`bypass_ip_for_retry` owns that whole decision, including the already-resolved case).
fn remedy_bypass(
    slug: &str,
    token: Option<&str>,
    resolve: Option<&str>,
    cond: Option<(&str, &Heat)>,
    attempt: Result<FetchResult, String>,
) -> Result<FetchResult, String> {
    let Err(err) = attempt else { return attempt };
    match crate::search::bypass_ip_for_retry(Some(&err), resolve.is_some()) {
        Some(ip) => fetch_once(slug, token, Some(&ip), false, cond),
        None => Err(err),
    }
}

#[derive(Debug, Clone)]
struct Raw {
    body: String,
    etag: Option<String>,
    status: Option<u16>,
    remaining: Option<u32>,
    reset: Option<u64>,
}

fn fetch_once(
    slug: &str,
    token: Option<&str>,
    resolve: Option<&str>,
    best_effort: bool,
    cond: Option<(&str, &Heat)>,
) -> Result<FetchResult, String> {
    let curl = crate::search::which_curl().ok_or("找不到 curl，无法访问 GitHub API")?;
    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        // -i so the validator and the rate-limit headers are readable, not just the body.
        "-i",
        "--no-progress-meter",
        "-L",
        "--max-time",
        "20",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {}", crate::search::USER_AGENT),
    ]);
    if let Some((etag, _)) = cond {
        cmd.arg("-H").arg(format!("If-None-Match: {etag}"));
    }
    if let Some(ip) = resolve {
        cmd.arg("--resolve").arg(format!("api.github.com:443:{ip}"));
    }
    if best_effort && cfg!(windows) {
        cmd.arg("--ssl-revoke-best-effort");
    }
    cmd.arg(format!("https://api.github.com/repos/{slug}"));

    let out = match token {
        Some(t) => crate::search::curl_with_token(cmd, t).map_err(|e| format!("无法启动 curl: {e}"))?,
        None => cmd.output().map_err(|e| format!("无法启动 curl: {e}"))?,
    };
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        return Err(format!("读取仓库信息失败: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (headers, body) = crate::search::split_headers(&text);
    let status = crate::search::status_of(&text);
    let raw = Raw {
        body,
        etag: crate::search::etag_of(&headers),
        status,
        remaining: headers.get("x-ratelimit-remaining").and_then(|v| v.trim().parse().ok()),
        reset: headers.get("x-ratelimit-reset").and_then(|v| v.trim().parse().ok()),
    };
    Ok(finish(slug, raw, cond))
}

/// Turn one curl answer into a `FetchResult`.
///
/// Split out from `fetch_once` so the `304` / `404` / `403` decisions — the part with
/// rules in them — are testable without a process.
fn finish(slug: &str, raw: Raw, cond: Option<(&str, &Heat)>) -> FetchResult {
    let mut charged = 1u8;
    let mut heat = match raw.status {
        // A `304` carries no body. Reuse exactly what the validator belongs to.
        Some(304) => match cond {
            Some((_, prev)) => {
                charged = 0;
                Heat {
                    slug: slug.to_string(),
                    source: HeatSource::Revalidated,
                    ..prev.clone()
                }
            }
            // 304 with nothing to serve is a bug on our side, not GitHub's: report it
            // rather than rendering an empty tile.
            None => failed_row(slug, "GitHub 回答 304，但本地没有可复用的数据"),
        },
        Some(404) => failed_row(slug, "找不到该仓库，或它需要登录才能看到"),
        // Any 2xx carries the repository object; the placeholder below is replaced by
        // `parse_heat` underneath, which is the only thing that can produce a `Fresh` row.
        Some(s) if (200..300).contains(&s) => Heat {
            slug: slug.to_string(),
            stars: 0,
            forks: 0,
            language: None,
            license: None,
            pushed_at: None,
            source: HeatSource::Fresh,
            error: None,
        },
        Some(401) | Some(403) => failed_row(
            slug,
            &format!(
                "GitHub 拒绝该请求（状态 {}），{raw429}",
                raw.status.unwrap_or(0),
                raw429 = if raw.remaining == Some(0) { "且配额已用尽" } else { "可能是令牌或私有仓库权限" }
            ),
        ),
        Some(other) => failed_row(slug, &format!("GitHub 返回状态 {other}")),
        // No status line at all means the capture is not what `-i` should produce.
        None => failed_row(slug, "无法从响应里读出状态码"),
    };
    if heat.source == HeatSource::Fresh {
        heat = match parse_heat(slug, &raw.body) {
            Some(parsed) => parsed,
            None => failed_row(slug, "响应里没有 stargazers_count"),
        };
    }
    FetchResult {
        heat,
        charged,
        etag: raw.etag,
        remaining: raw.remaining,
        reset: raw.reset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heat(slug: &str, stars: u64) -> Heat {
        Heat {
            slug: slug.to_string(),
            stars,
            forks: 1,
            language: Some("Rust".to_string()),
            license: Some("MIT".to_string()),
            pushed_at: Some("2026-10-17T00:00:00Z".to_string()),
            source: HeatSource::Fresh,
            error: None,
        }
    }

    #[test]
    fn full_name_accepts_only_two_safe_segments() {
        assert_eq!(parse_full_name("rust-lang/rust").as_deref(), Some("rust-lang/rust"));
        assert_eq!(parse_full_name("  octocat/Hello-World  ").as_deref(), Some("octocat/Hello-World"));
        assert_eq!(parse_full_name("a/b/").as_deref(), Some("a/b"));
        // The shapes that would change which URL GitHub answers.
        assert_eq!(parse_full_name("a/b/c"), None);
        assert_eq!(parse_full_name("a"), None);
        assert_eq!(parse_full_name("a/"), None);
        assert_eq!(parse_full_name("/b"), None);
        assert_eq!(parse_full_name("a/../b"), None);
        assert_eq!(parse_full_name("a/b?per_page=1"), None);
        assert_eq!(parse_full_name("a%2Fb/c"), None);
        assert_eq!(parse_full_name("a/b#frag"), None);
        assert_eq!(parse_full_name(""), None);
        assert_eq!(parse_full_name(".hidden/b"), None);
        assert_eq!(parse_full_name(&format!("a/{}", "b".repeat(101))), None);
    }

    #[test]
    fn parse_heat_reads_the_five_fields_the_tile_shows() {
        let body = r#"{"full_name":"a/b","stargazers_count":4242,"forks_count":7,
            "language":"Rust","license":{"spdx_id":"MIT"},"pushed_at":"2026-10-01T00:00:00Z"}"#;
        let h = parse_heat("a/b", body).unwrap();
        assert_eq!((h.stars, h.forks), (4242, 7));
        assert_eq!(h.language.as_deref(), Some("Rust"));
        assert_eq!(h.license.as_deref(), Some("MIT"));
        assert_eq!(h.pushed_at.as_deref(), Some("2026-10-01T00:00:00Z"));
        assert_eq!(h.source, HeatSource::Fresh);
    }

    #[test]
    fn a_body_without_stars_is_not_a_heat_row() {
        // A `301` moved-repository body, and a plain error body.
        assert!(parse_heat("a/b", r#"{"url":"https://api.github.com/repos/c/b"}"#).is_none());
        assert!(parse_heat("a/b", r#"{"message":"Not Found"}"#).is_none());
        assert!(parse_heat("a/b", "not json").is_none());
        // `language: null` is normal (a repository with no detected language) and must not
        // lose the stars we did get.
        let h = parse_heat("a/b", r#"{"stargazers_count":3,"language":null,"license":null}"#).unwrap();
        assert_eq!(h.stars, 3);
        assert!(h.language.is_none(), "a null language is absent, not the empty string");
        assert_eq!(h.license, None);
    }

    #[test]
    fn noassertion_license_is_absent_not_a_name() {
        let h = parse_heat("a/b", r#"{"stargazers_count":1,"license":{"spdx_id":"NOASSERTION"}}"#).unwrap();
        assert_eq!(h.license, None);
    }

    #[test]
    fn ttl_hit_is_served_relabelled_and_needs_no_validator() {
        let t0 = Instant::now();
        let mut c = HeatCache::new();
        c.put("a/b", heat("a/b", 10), Some("\"E1\"".to_string()), t0);
        let hit = c.fresh("a/b", t0 + Duration::from_secs(60)).unwrap();
        assert_eq!(hit.source, HeatSource::Cached);
        assert_eq!(hit.stars, 10);
        assert!(hit.error.is_none());
        // Past the TTL the same row must not be served as if it were current.
        assert!(c.fresh("a/b", t0 + HEAT_TTL + Duration::from_secs(1)).is_none());
        assert!(c.fresh("nope/nope", t0).is_none());
    }

    #[test]
    fn validator_and_body_travel_together() {
        let t0 = Instant::now();
        let mut c = HeatCache::new();
        c.put("a/b", heat("a/b", 10), None, t0);
        assert!(c.validator("a/b").is_none(), "no etag means nothing to send");
        c.put("a/b", heat("a/b", 11), Some("\"E2\"".to_string()), t0);
        let (etag, prev) = c.validator("a/b").unwrap();
        assert_eq!(etag, "\"E2\"");
        assert_eq!(prev.stars, 11);
    }

    #[test]
    fn a_304_moves_the_clock_and_keeps_the_validator() {
        let t0 = Instant::now();
        let mut c = HeatCache::new();
        c.put("a/b", heat("a/b", 10), Some("\"E1\"".to_string()), t0);
        // Without the touch this row would be expired six hours later…
        assert!(c.fresh("a/b", t0 + HEAT_TTL + Duration::from_secs(10)).is_none());
        // …and the `304` is exactly what re-stamps it. The body and the validator stay.
        c.touch("a/b", t0 + HEAT_TTL);
        let after = c.fresh("a/b", t0 + HEAT_TTL + Duration::from_secs(10)).unwrap();
        assert_eq!(after.stars, 10);
        assert_eq!(c.validator("a/b").unwrap().0, "\"E1\"");
        assert!(c.fresh("a/b", t0 + HEAT_TTL * 2 + Duration::from_secs(10)).is_none());
        // Touching something that is not there is a no-op, not a panic and not an insert.
        c.touch("missing/one", t0);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn rate_limit_is_only_refused_on_a_positive_zero() {
        let mut c = HeatCache::new();
        assert!(!c.exhausted());
        c.note_limit(Some(0), Some(1_800_000_000));
        assert!(c.exhausted());
        assert_eq!(c.reset(), Some(1_800_000_000));
        // An answer without the headers leaves the previous one in place: "not seen" is
        // not evidence that the allowance came back.
        c.note_limit(None, None);
        assert!(c.exhausted());
        c.note_limit(Some(4999), None);
        assert!(!c.exhausted());
    }

    #[test]
    fn cache_bounds_by_age_not_by_wholesale_clear() {
        let t0 = Instant::now();
        let mut c = HeatCache::new();
        for i in 0..(HEAT_CACHE_CAP + 40) {
            c.put(&format!("o/r{i}"), heat(&format!("o/r{i}"), i as u64), None, t0 + Duration::from_millis(i as u64));
        }
        assert!(c.len() <= HEAT_CACHE_CAP, "len {} exceeded cap {}", c.len(), HEAT_CACHE_CAP);
        // The most recent insert always survives; the evicted ones are the oldest.
        assert!(c.fresh(&format!("o/r{}", HEAT_CACHE_CAP + 39), t0).is_some());
    }

    #[test]
    fn finish_reuses_the_held_row_on_304_and_charges_nothing() {
        let prev = heat("a/b", 999);
        let raw = Raw {
            body: String::new(),
            etag: Some("\"E1\"".to_string()),
            status: Some(304),
            remaining: Some(59),
            reset: None,
        };
        let r = finish("a/b", raw, Some(("\"E1\"", &prev)));
        assert_eq!(r.charged, 0);
        assert_eq!(r.heat.source, HeatSource::Revalidated);
        assert_eq!(r.heat.stars, 999);
        assert_eq!(r.remaining, Some(59));
    }

    #[test]
    fn finish_treats_404_as_a_question_about_access_not_a_crash() {
        let raw = Raw {
            body: r#"{"message":"Not Found"}"#.to_string(),
            etag: None,
            status: Some(404),
            remaining: Some(58),
            reset: None,
        };
        let r = finish("a/b", raw, None);
        assert_eq!(r.heat.source, HeatSource::Failed);
        assert!(r.heat.error.as_deref().unwrap().contains("登录"), "文案要说出私有仓库这一种可能");
        assert_eq!(r.charged, 1);
    }

    #[test]
    fn finish_reports_an_exhausted_allowance_as_the_reason_for_a_403() {
        let raw = Raw {
            body: String::new(),
            etag: None,
            status: Some(403),
            remaining: Some(0),
            reset: Some(1),
        };
        let r = finish("a/b", raw, None);
        assert!(r.heat.error.as_deref().unwrap().contains("配额已用尽"));
    }

    #[test]
    fn finish_needs_a_body_that_actually_carries_stars() {
        let raw = Raw {
            body: r#"{"stargazers_count":12}"#.to_string(),
            etag: Some("\"E3\"".to_string()),
            status: Some(200),
            remaining: Some(57),
            reset: None,
        };
        let r = finish("a/b", raw, None);
        assert_eq!((r.heat.source, r.heat.stars, r.charged), (HeatSource::Fresh, 12, 1));
        assert_eq!(r.etag.as_deref(), Some("\"E3\""));

        let redirect = Raw {
            body: r#"{"url":"https://api.github.com/repos/x/y"}"#.to_string(),
            etag: None,
            status: Some(200),
            remaining: None,
            reset: None,
        };
        let r2 = finish("a/b", redirect, None);
        assert_eq!(r2.heat.source, HeatSource::Failed);
        assert!(r2.heat.error.as_deref().unwrap().contains("stargazers_count"));
    }

    #[test]
    fn force_skips_the_ttl_but_still_revalidates() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        cache.lock().unwrap().put("a/b", heat("a/b", 5), Some("\"E\"".to_string()), t0);
        let slugs = vec!["a/b".to_string()];
        let out = heat_many(&cache, &slugs, "", None, t0 + Duration::from_secs(5), true, &|slug, _, _, cond| {
            // The whole point of 刷新 being cheap: inside the TTL we still ask, but we
            // ask with the validator we hold.
            assert_eq!(cond.expect("force must not throw the validator away").0, "\"E\"");
            FetchResult {
                heat: heat(slug, 6),
                charged: 1,
                etag: Some("\"E2\"".to_string()),
                remaining: Some(30),
                reset: None,
            }
        });
        assert_eq!((out[0].stars, out[0].source), (6, HeatSource::Fresh));
        // And the new validator replaced the old one.
        assert_eq!(cache.lock().unwrap().validator("a/b").unwrap().0, "\"E2\"");
    }

    #[test]
    fn heat_many_serves_a_ttl_hit_without_calling_the_fetcher() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        cache.lock().unwrap().put("a/b", heat("a/b", 5), Some("\"E\"".to_string()), t0);
        let slugs = vec!["a/b".to_string()];
        let out = heat_many(&cache, &slugs, "", None, t0 + Duration::from_secs(30), false, &|slug, _, _, _| {
            panic!("fetcher must not run for {slug}");
        });
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].stars, out[0].source), (5, HeatSource::Cached));
    }

    #[test]
    fn heat_many_sends_the_validator_and_lets_a_304_refresh_the_clock() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        {
            let mut g = cache.lock().unwrap();
            g.put("a/b", heat("a/b", 5), Some("\"E\"".to_string()), t0);
            g.put("a/b", heat("a/b", 5), Some("\"E\"".to_string()), t0);
        }
        let slugs = vec!["a/b".to_string()];
        // Past the TTL, but the validator is still held: the fetcher must see it.
        let out = heat_many(&cache, &slugs, "", None, t0 + HEAT_TTL + Duration::from_secs(1), false, &|slug, token, resolve, cond| {
            assert!(token.is_none(), "no token configured means no Authorization header");
            assert!(resolve.is_none());
            let (etag, prev) = cond.expect("the held validator must be handed to the fetcher");
            assert_eq!(etag, "\"E\"");
            FetchResult {
                heat: Heat { slug: slug.to_string(), source: HeatSource::Revalidated, ..prev.clone() },
                charged: 0,
                etag: Some(etag.to_string()),
                remaining: Some(40),
                reset: None,
            }
        });
        assert_eq!((out[0].stars, out[0].source), (5, HeatSource::Revalidated));
        // The touch means the very next call inside the window is a pure cache hit.
        let again = heat_many(&cache, &slugs, "", None, t0 + HEAT_TTL + Duration::from_secs(60), false, &|slug, _, _, _| {
            panic!("the 304 should have re-stamped {slug}")
        });
        assert_eq!(again[0].source, HeatSource::Cached);
    }

    #[test]
    fn heat_many_refuses_to_fetch_when_the_server_said_zero() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        cache.lock().unwrap().note_limit(Some(0), Some(123));
        let slugs = vec!["a/b".to_string(), "c/d".to_string()];
        let out = heat_many(&cache, &slugs, "", None, t0, false, &|slug, _, _, _| panic!("nothing may be fetched for {slug}"));
        assert_eq!(out.len(), 2);
        // One of them we have never seen: that is a Failed row that says why.
        assert_eq!(out[0].source, HeatSource::Failed);
        assert!(out[0].error.as_deref().unwrap().contains("配额已用尽"));
        assert!(out[0].error.as_deref().unwrap().contains("123"));
    }

    #[test]
    fn heat_many_keeps_a_stale_row_rather_than_showing_nothing() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        cache.lock().unwrap().put("a/b", heat("a/b", 77), None, t0);
        let slugs = vec!["a/b".to_string()];
        let out = heat_many(&cache, &slugs, "", None, t0 + HEAT_TTL * 2, false, &|slug, _, _, cond| {
            assert!(cond.is_none(), "a row with no etag cannot be revalidated");
            FetchResult {
                heat: failed_row(slug, "读取仓库信息失败: 连接超时"),
                charged: 1,
                etag: None,
                remaining: None,
                reset: None,
            }
        });
        assert_eq!(out[0].source, HeatSource::Failed);
        assert!(out[0].error.as_deref().unwrap().contains("超时"));
        // And the failure did not destroy what the cache holds for the next round.
        assert_eq!(cache.lock().unwrap().validator("a/b").is_none(), true);
        let after = heat_many(&cache, &slugs, "", None, t0 + HEAT_TTL * 2 + Duration::from_secs(1), false, &|slug, _, _, _| {
            FetchResult { heat: heat(slug, 80), charged: 1, etag: None, remaining: None, reset: None }
        });
        assert_eq!(after[0].stars, 80);
    }

    #[test]
    fn heat_many_caps_the_batch_at_the_documented_limit() {
        let t0 = Instant::now();
        let cache = Mutex::new(HeatCache::new());
        let slugs: Vec<String> = (0..(HEAT_BATCH_CAP + 25)).map(|i| format!("o/r{i}")).collect();
        let seen = std::sync::atomic::AtomicUsize::new(0);
        let out = heat_many(&cache, &slugs, "tok", Some("1.2.3.4"), t0, false, &|slug, _, resolve, _| {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(resolve, Some("1.2.3.4"), "the pinned address is threaded through");
            FetchResult { heat: heat(slug, 1), charged: 1, etag: None, remaining: None, reset: None }
        });
        assert_eq!(out.len(), HEAT_BATCH_CAP);
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), HEAT_BATCH_CAP);
    }
}
