//! Read-only application update check (r28-N1).
//!
//! This is deliberately **not** an updater: it reads the public GitHub Release
//! metadata, compares the tag with `CARGO_PKG_VERSION`, and returns a link. It
//! never downloads or replaces a binary. Replacing an executable needs a signed
//! manifest, a rollback story and a code-signing identity; none of that exists
//! yet, so offering a button that claims to update would be worse than no button.
//!
//! The endpoint is fixed to this repository; no user-controlled URL or token is
//! involved. `curl` is reused (like the rest of the download layer) and a
//! Schannel revocation-check failure gets the same one-shot `--ssl-no-revoke`
//! retry the search path uses, because that failure is a local trust-store
//! condition, not evidence that the release feed is untrusted.

use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RELEASE_URL: &str =
    "https://api.github.com/repos/VirtualTests1/devhub-app/releases/latest";

/// How long an answer is reused without asking GitHub again.
///
/// A release feed changes at most a few times a month, and an unauthenticated
/// caller has 60 requests an hour shared with repository previews and search.
/// Ten minutes keeps 检查更新 honest for a session's worth of clicking without
/// turning one button into a quota sink. `force` bypasses it.
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub url: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// Unix seconds of the request that produced this answer. `None` only for a
    /// parsed fixture, never for a live check.
    pub checked_at: Option<u64>,
    /// True when the answer came from the ten-minute cache or a `304`.
    pub from_cache: bool,
}

/// One cached answer plus what a conditional request needs.
struct CachedCheck {
    update: AppUpdate,
    fetched_at: Instant,
    checked_at: u64,
    etag: Option<String>,
}

static CHECK_CACHE: Mutex<Option<CachedCheck>> = Mutex::new(None);

/// A `curl -i` answer, split but not interpreted.
struct Fetched {
    body: String,
    status: Option<u16>,
    headers: HashMap<String, String>,
    etag: Option<String>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether a cached answer may be returned as-is. Pure so the boundary is
/// pinned by a test instead of being inferred from a wall clock.
fn cache_is_fresh(age: Duration, force: bool) -> bool {
    !force && age < CACHE_TTL
}

fn view_of(cache: &CachedCheck, from_cache: bool) -> AppUpdate {
    let mut update = cache.update.clone();
    update.checked_at = Some(cache.checked_at);
    update.from_cache = from_cache;
    update
}

fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let text = raw.trim().trim_start_matches('v').trim_start_matches('V');
    let core = text.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    Some(parse_version(a)?.cmp(&parse_version(b)?))
}

/// Parses one `/releases/latest` JSON object. Pure, so the test suite can pin
/// the field names and the "no release" shape without network.
pub fn parse_release(body: &str, current: &str) -> Result<AppUpdate, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Release JSON 无法解析: {e}"))?;
    if value.get("message").and_then(|v| v.as_str()) == Some("Not Found") {
        return Err("GitHub 仓库还没有发布 Release".to_string());
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
    let latest = parse_version(tag)
        .ok_or_else(|| format!("无法识别的发布版本号: {tag}"))?;
    let current_parsed = parse_version(current)
        .ok_or_else(|| format!("无法识别的当前版本号: {current}"))?;
    Ok(AppUpdate {
        current: current.to_string(),
        latest: tag.trim_start_matches(['v', 'V']).to_string(),
        available: latest > current_parsed,
        url: url.to_string(),
        notes: value
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        published_at: value
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        prerelease: value
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        checked_at: None,
        from_cache: false,
    })
}

fn which_curl() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("SystemRoot") {
        let p = PathBuf::from(root).join("System32").join("curl.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("curl.exe"))
        .find(|p| p.is_file())
}

/// One conditional request. `etag` is sent only when a previous body is held;
/// a `304` is returned as a status, not an error, because it is the server
/// confirming the cached body is still current (and it costs no quota).
fn fetch_release(etag: Option<&str>) -> Result<Fetched, String> {
    let curl = which_curl().ok_or("找不到 curl，无法检查更新")?;
    let run = |no_revoke: bool| {
        let mut cmd = crate::proc::silent(&curl);
        // `-i` is what makes a `304` distinguishable from an empty `200`; without
        // it the body alone cannot tell the two apart.
        cmd.args([
            "-sS",
            "-i",
            "-L",
            "--no-progress-meter",
            "--connect-timeout",
            "8",
            "--max-time",
            "15",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: DevHub-update-check",
        ]);
        if let Some(validator) = etag {
            cmd.arg("-H").arg(format!("If-None-Match: {validator}"));
        }
        if no_revoke {
            cmd.arg("--ssl-no-revoke");
        }
        cmd.arg(RELEASE_URL)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(20))
    };
    let first = run(false)
        .map_err(|e| format!("无法启动 curl: {e}"))?
        .ok_or_else(|| "检查更新超时".to_string())?;
    let mut output = first;
    // Without `--fail`, curl exits 0 for HTTP errors and non-zero for transport
    // failures. Only the latter can be a revocation problem; keeping the body of
    // a 403 is what lets GitHub's own sentence reach the user.
    if !output.status.success() {
        let raw = String::from_utf8_lossy(&output.stdout);
        if crate::search::status_of(&raw).is_none() {
            let err = crate::proc::decode_console(&output.stderr);
            if crate::search::is_revocation_failure(&err) {
                output = run(true)
                    .map_err(|e| format!("无法启动 curl: {e}"))?
                    .ok_or_else(|| "检查更新超时".to_string())?;
            } else {
                return Err(format!("检查更新失败: {}", err.trim()));
            }
        }
    }
    let raw = String::from_utf8(output.stdout)
        .map_err(|_| "Release 响应不是 UTF-8".to_string())?;
    let (headers, body) = crate::search::split_headers(&raw);
    let status = crate::search::status_of(&raw);
    if !output.status.success() && status.is_none() {
        let err = crate::proc::decode_console(&output.stderr);
        return Err(format!("检查更新失败: {}", err.trim()));
    }
    if status != Some(200) && status != Some(304) {
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .or_else(|| {
                let err = crate::proc::decode_console(&output.stderr);
                let one = err.trim();
                (!one.is_empty()).then(|| one.to_string())
            })
            .unwrap_or_else(|| {
                format!(
                    "GitHub API 返回 {}",
                    status.map(|s| s.to_string()).unwrap_or_else(|| "无状态码".to_string())
                )
            });
        return Err(match crate::search::rate_limit_hint(&headers) {
            Some(hint) => format!("{detail}（{hint}）"),
            None => format!("检查更新失败: {detail}"),
        });
    }
    Ok(Fetched {
        body,
        status,
        etag: crate::search::etag_of(&headers),
        headers,
    })
}

/// Read-only check exposed to the settings About page.
///
/// `force` skips the ten-minute cache and sends an unconditional request. It is
/// the explicit "I want a fresh answer" control, not the default: an ordinary
/// click inside the window returns the cached answer and says so.
#[tauri::command]
pub async fn check_app_update(force: Option<bool>) -> Result<AppUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let force = force.unwrap_or(false);
        let mut cached = CHECK_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(current) = cached.as_ref() {
            if cache_is_fresh(current.fetched_at.elapsed(), force) {
                return Ok(view_of(current, true));
            }
        }
        let validator = if force {
            None
        } else {
            cached.as_ref().and_then(|c| c.etag.clone())
        };
        let fetched = fetch_release(validator.as_deref())?;
        match fetched.status {
            Some(304) => {
                let Some(current) = cached.as_mut() else {
                    // A validator is only sent when a body is held, so this is a
                    // broken assumption, not a normal answer. Say so; never
                    // present an empty body as a successful check.
                    return Err("GitHub 返回 304，但没有可复用的检查结果".to_string());
                };
                current.fetched_at = Instant::now();
                current.checked_at = now_epoch();
                if let Some(etag) = fetched.etag {
                    current.etag = Some(etag);
                }
                Ok(view_of(current, true))
            }
            Some(200) => {
                let mut update = parse_release(&fetched.body, env!("CARGO_PKG_VERSION"))?;
                let checked_at = now_epoch();
                update.checked_at = Some(checked_at);
                update.from_cache = false;
                *cached = Some(CachedCheck {
                    update: update.clone(),
                    fetched_at: Instant::now(),
                    checked_at,
                    etag: fetched.etag,
                });
                // `headers` is only needed for the error path above; dropping it
                // here keeps the successful branch's intent obvious.
                drop(fetched.headers);
                Ok(update)
            }
            other => Err(format!(
                "检查更新失败: GitHub API 返回 {}",
                other
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "无状态码".to_string())
            )),
        }
    })
    .await
    .map_err(|e| format!("更新检查任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_compared_numerically_then_by_prerelease_core() {
        assert_eq!(compare_versions("v0.3.0", "0.3.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("v0.4.0", "0.3.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.9", "0.3.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("v1.0.0", "0.99.99"), Some(Ordering::Greater));
        assert_eq!(parse_version("v0.3.1-beta.1"), Some((0, 3, 1)));
        assert_eq!(parse_version("0.3"), None);
        assert_eq!(parse_version("nope"), None);
    }

    #[test]
    fn release_json_is_parsed_and_availability_is_derived() {
        let body = r#"{
          "tag_name": "v0.4.0",
          "html_url": "https://github.com/VirtualTests1/devhub-app/releases/tag/v0.4.0",
          "body": "notes",
          "published_at": "2026-10-28T00:00:00Z",
          "prerelease": false,
          "draft": false
        }"#;
        let update = parse_release(body, "0.3.0").expect("release");
        assert!(update.available);
        assert_eq!(update.latest, "0.4.0");
        assert_eq!(update.notes, "notes");
        assert!(!update.prerelease);
        assert_eq!(update.checked_at, None, "a parsed fixture has not been checked at a wall clock");
        assert!(!update.from_cache);
        let same = parse_release(body, "0.4.0").expect("same");
        assert!(!same.available);
        let older = parse_release(body, "0.5.0").expect("older");
        assert!(!older.available);
    }

    #[test]
    fn the_cache_window_is_ten_minutes_and_force_always_bypasses_it() {
        assert!(cache_is_fresh(Duration::from_secs(0), false));
        assert!(cache_is_fresh(Duration::from_secs(599), false));
        assert!(!cache_is_fresh(CACHE_TTL, false));
        assert!(!cache_is_fresh(Duration::from_secs(1), true));
        assert_eq!(CACHE_TTL, Duration::from_secs(600));
    }

    #[test]
    #[ignore = "network: reads the public GitHub release feed"]
    fn live_release_feed_is_parseable() {
        let fetched = fetch_release(None).expect("release feed");
        assert_eq!(fetched.status, Some(200));
        let update = parse_release(&fetched.body, "0.0.0").expect("parse live release");
        assert!(update.available, "0.0.0 must be older than the live release");
        assert!(update.url.starts_with("https://github.com/"));
    }

    #[test]
    fn missing_or_draft_release_is_an_error_not_a_false_latest() {
        assert!(parse_release(r#"{"message":"Not Found"}"#, "0.3.0").is_err());
        assert!(parse_release(r#"{"tag_name":"v0.4.0","draft":true,"html_url":"https://x"}"#, "0.3.0").is_err());
        assert!(parse_release(r#"{"tag_name":"nightly","html_url":"https://x"}"#, "0.3.0").is_err());
    }
}

/// The compiled app version, for the About page before a check has run.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
