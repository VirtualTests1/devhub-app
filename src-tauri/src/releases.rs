//! Latest GitHub release for one repository (r33-D6).
//!
//! This is **read-only metadata**, not an updater: it names the newest published
//! release and links to it. Installing or swapping an asset is a separate product
//! decision with signing and rollback requirements (`docs/research/update-architecture.md`).
//!
//! Transport follows `heat.rs` and `stars.rs`: `curl`, the token fed through stdin
//! config (never argv), `If-None-Match` from a cached validator, and the same
//! one-shot remedies when a local accelerator intercepts `api.github.com`.
//!
//! Bounds: one answer per repository for six hours (a release feed moves on the
//! scale of weeks), a 200-row in-process cache, one request at a time per call, and
//! a 15 s deadline. The unauthenticated allowance is 60 requests/hour shared with
//! search and previews; the token raises it to 5 000, which is why the UI calls this
//! only when asked.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const API_PREFIX: &str = "https://api.github.com/repos";
const CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const RELEASE_CACHE_CAP: usize = 200;
const REQUEST_TIMEOUT_SECS: &str = "15";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub slug: String,
    /// `release` | `none` | `error`.
    ///
    /// `none` is an answer (the repository has no published release); `error` is
    /// "this check did not run". They must not share a badge.
    pub state: String,
    pub tag: Option<String>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// Unix seconds of the answer, or `None` for an error that never reached GitHub.
    pub checked_at: Option<u64>,
    /// True when the six-hour cache or a `304` produced this row.
    pub from_cache: bool,
    pub error: Option<String>,
}

struct Cached {
    info: ReleaseInfo,
    at: Instant,
    checked: u64,
    etag: Option<String>,
}

static CACHE: Mutex<Option<HashMap<String, Cached>>> = Mutex::new(None);

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether a cached answer may be returned without a request. Pure, so the
/// boundary is pinned by a test rather than read off the wall clock.
fn cache_is_fresh(age: Duration, force: bool) -> bool {
    !force && age < CACHE_TTL
}

fn error_row(slug: &str, message: String) -> ReleaseInfo {
    ReleaseInfo {
        slug: slug.to_string(),
        state: "error".to_string(),
        tag: None,
        name: None,
        url: None,
        published_at: None,
        prerelease: false,
        checked_at: None,
        from_cache: false,
        error: Some(message),
    }
}

fn none_row(slug: &str) -> ReleaseInfo {
    ReleaseInfo {
        slug: slug.to_string(),
        state: "none".to_string(),
        tag: None,
        name: None,
        url: None,
        published_at: None,
        prerelease: false,
        checked_at: Some(now_epoch()),
        from_cache: false,
        error: None,
    }
}

/// Parse one `/releases/latest` body. Pure; a fixture in the tests is the only
/// contract GitHub's field names have here.
pub fn parse_release(slug: &str, body: &str) -> Result<ReleaseInfo, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Release JSON 无法解析: {e}"))?;
    if value.get("message").and_then(|v| v.as_str()) == Some("Not Found") {
        return Ok(none_row(slug));
    }
    let tag = value
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Release 没有 tag_name".to_string())?;
    let url = value
        .get("html_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Release 没有 html_url".to_string())?;
    if value.get("draft").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("Latest Release 是草稿".to_string());
    }
    Ok(ReleaseInfo {
        slug: slug.to_string(),
        state: "release".to_string(),
        tag: Some(tag.to_string()),
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        url: Some(url.to_string()),
        published_at: value
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        prerelease: value
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        checked_at: Some(now_epoch()),
        from_cache: false,
        error: None,
    })
}

fn valid_slug(slug: &str) -> bool {
    let mut parts = slug.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !owner.is_empty()
        && !repo.is_empty()
        && owner
            .chars()
            .chain(repo.chars())
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
}

fn cached_for(slug: &str, force: bool) -> Option<ReleaseInfo> {
    let guard = CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let row = map.get(slug)?;
    if !cache_is_fresh(row.at.elapsed(), force) {
        return None;
    }
    let mut info = row.info.clone();
    info.checked_at = Some(row.checked);
    info.from_cache = true;
    Some(info)
}

fn etag_for(slug: &str) -> Option<String> {
    CACHE
        .lock()
        .ok()?
        .as_ref()?
        .get(slug)?
        .etag
        .clone()
}

fn store(slug: &str, info: ReleaseInfo, etag: Option<String>) {
    let Ok(mut guard) = CACHE.lock() else { return };
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= RELEASE_CACHE_CAP && !map.contains_key(slug) {
        // Bounded: drop expired rows first, then the oldest insertion. A map with
        // one slot per repository on this wall would still be small, but the cap is
        // the invariant every in-process cache here carries.
        map.retain(|_, row| row.at.elapsed() < CACHE_TTL);
        if map.len() >= RELEASE_CACHE_CAP {
            if let Some(oldest) = map.iter().min_by_key(|(_, row)| row.checked).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
    }
    map.insert(
        slug.to_string(),
        Cached {
            info,
            at: Instant::now(),
            checked: now_epoch(),
            etag,
        },
    );
}

/// Fetches (or reuses) the latest release for `slug`.
pub fn fetch_release(slug: &str, force: bool) -> ReleaseInfo {
    let slug = slug.trim().trim_matches('/');
    if !valid_slug(slug) {
        return error_row(slug, format!("无法识别的仓库标识: {slug}"));
    }
    if !force {
        if let Some(hit) = cached_for(slug, false) {
            return hit;
        }
    }

    let curl = match crate::search::which_curl() {
        Some(c) => c,
        None => return error_row(slug, "找不到 curl，无法访问 GitHub API".to_string()),
    };
    let token = {
        let cfg = crate::settings_cmd::read_config();
        let usable = crate::settings_cmd::usable_token(&cfg.github_token);
        if usable.trim().is_empty() {
            None
        } else {
            Some(usable)
        }
    };
    let etag = if force { None } else { etag_for(slug) };

    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        "-i",
        "--no-progress-meter",
        "-L",
        "--max-time",
        REQUEST_TIMEOUT_SECS,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {}", crate::search::USER_AGENT),
    ]);
    if let Some(one) = &etag {
        cmd.arg("-H").arg(format!("If-None-Match: {one}"));
    }
    let url = format!("{API_PREFIX}/{slug}/releases/latest");
    cmd.arg(&url);
    let out = match token.as_deref() {
        Some(t) => match crate::search::curl_with_token(cmd, t) {
            Ok(o) => o,
            Err(e) => return error_row(slug, format!("无法启动 curl: {e}")),
        },
        None => match cmd.output() {
            Ok(o) => o,
            Err(e) => return error_row(slug, format!("无法启动 curl: {e}")),
        },
    };
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        return error_row(slug, format!("读取发布信息失败: {}", err.trim()));
    }

    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (headers, body) = crate::search::split_headers(&text);
    let status = crate::search::status_of(&text);
    let fresh_etag = crate::search::etag_of(&headers);
    match status {
        Some(304) => {
            if let Ok(mut guard) = CACHE.lock() {
                if let Some(row) = guard.as_mut().and_then(|m| m.get_mut(slug)) {
                    row.at = Instant::now();
                    row.checked = now_epoch();
                    let mut info = row.info.clone();
                    info.checked_at = Some(row.checked);
                    info.from_cache = true;
                    return info;
                }
            }
            error_row(slug, "GitHub 回答 304，但本地没有可复用的发布信息".to_string())
        }
        Some(404) => {
            let info = none_row(slug);
            store(slug, info.clone(), fresh_etag);
            info
        }
        Some(401) | Some(403) => {
            let hint = crate::search::rate_limit_hint(&headers)
                .unwrap_or_else(|| "可能是令牌或私有仓库权限".to_string());
            error_row(slug, format!("GitHub 拒绝该请求（状态 {}）：{hint}", status.unwrap_or(0)))
        }
        Some(s) if (200..300).contains(&s) => match parse_release(slug, &body) {
            Ok(info) => {
                store(slug, info.clone(), fresh_etag);
                info
            }
            Err(e) => error_row(slug, e),
        },
        Some(other) => error_row(slug, format!("GitHub 返回状态 {other}")),
        None => error_row(slug, "无法从响应里读出状态码".to_string()),
    }
}

#[tauri::command]
pub async fn repo_release(slug: String, force: Option<bool>) -> Result<ReleaseInfo, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_release(&slug, force.unwrap_or(false)))
        .await
        .map_err(|e| format!("发布检查任务异常: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_body_maps_every_field_the_row_shows() {
        let body = r#"{
            "tag_name": "v1.4.2",
            "name": "Spring cleaning",
            "html_url": "https://github.com/o/r/releases/tag/v1.4.2",
            "published_at": "2026-09-01T10:00:00Z",
            "prerelease": true,
            "draft": false
        }"#;
        let r = parse_release("o/r", body).unwrap();
        assert_eq!(r.state, "release");
        assert_eq!(r.tag.as_deref(), Some("v1.4.2"));
        assert_eq!(r.name.as_deref(), Some("Spring cleaning"));
        assert!(r.prerelease);
        assert!(r.url.as_deref().unwrap().ends_with("/v1.4.2"));
    }

    #[test]
    fn a_not_found_body_is_an_answer_not_an_error() {
        let r = parse_release("o/r", r#"{"message":"Not Found"}"#).unwrap();
        assert_eq!(r.state, "none");
        assert!(r.error.is_none());
    }

    #[test]
    fn a_draft_or_malformed_body_is_an_error() {
        assert!(parse_release("o/r", r#"{"draft":true,"tag_name":"v1","html_url":"x"}"#).is_err());
        assert!(parse_release("o/r", r#"{"tag_name":"v1"}"#).is_err());
        assert!(parse_release("o/r", "not json").is_err());
    }

    #[test]
    fn cache_freshness_has_one_boundary_and_force_bypasses_it() {
        assert!(cache_is_fresh(CACHE_TTL - Duration::from_secs(1), false));
        assert!(!cache_is_fresh(CACHE_TTL, false));
        assert!(!cache_is_fresh(Duration::ZERO, true));
    }

    #[test]
    fn only_owner_repo_shapes_are_requested() {
        assert!(valid_slug("owner/repo"));
        assert!(valid_slug("Owner.Name/repo_name"));
        assert!(!valid_slug("owner"));
        assert!(!valid_slug("owner/repo/extra"));
        assert!(!valid_slug("owner/re po"));
        assert!(!valid_slug("../etc/passwd"));
    }
}
