//! GitHub starred-repository listing, for the 星标导入 panel on the Add-repos
//! page (round 18 direction N3).
//!
//! ## Why this runs in Rust and not in the window
//!
//! `GET /user/starred` answers **only** to an authenticated request, and the
//! token lives in the Rust config (`AppConfig::github_token`), never in the
//! webview — `docs/security-posture.md` describes the token as deliberately
//! Rust-only, and the frontend is told nothing more than "a token exists".
//! Handing the API call to `fetch()` would mean exporting the token into JS for
//! every page load. So the request is made here instead.
//!
//! ## Transport
//!
//! Same as search: the `curl` binary (see `search.rs` for why not an HTTP
//! crate), with the token fed through curl's `-K -` stdin config so it never
//! appears in this process's command line, and the same two automatic remedies
//! when a local accelerator intercepts `api.github.com` (relaxed revocation
//! check, then a public-DNS-agreed IP via `--resolve`).
//!
//! ## Why there is no cache and no local rate guard here
//!
//! Unlike search, every request carries the token, so GitHub applies the
//! authenticated allowance — 5 000 requests/hour (REST docs, read 2026-10-18) —
//! which a button-driven "load one page" flow cannot exhaust. And a star list
//! changes only when the user stars something, so re-fetching on demand is
//! cheaper than maintaining a cache.

use serde::{Deserialize, Serialize};

use crate::search::{
    bypass_ip_for_retry, curl_with_token, is_option_unsupported, is_revocation_failure,
    parse_repo_item, split_headers, status_of, which_curl, RepoHit, USER_AGENT,
};

const API: &str = "https://api.github.com/user/starred";

/// Repos per page. GitHub caps `per_page` at 100 (REST docs, read 2026-10-18);
/// a full page is also this module's "there may be more" signal.
const PER_PAGE: u32 = 100;

/// How many pages this panel will walk. 10 × 100 = 1 000 stars is past what a
/// pick-and-download list stays usable at, and the cap keeps both the JSON and
/// the rendered list bounded. Reaching the cap says so in the type (the last
/// page reports `has_more = false`), it does not silently truncate.
const MAX_PAGE: u32 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarPage {
    pub items: Vec<RepoHit>,
    /// True when the page came back full, i.e. another page probably exists.
    ///
    /// `/user/starred` reports no total count, and this project has no `Link`
    /// header parser (the header exists; nothing here reads it). A full page is
    /// the standard approximation, and its one wrong guess is cheap: a user
    /// whose star count is an exact multiple of [`PER_PAGE`] gets one extra
    /// "load more" that returns an empty page, after which the button goes away.
    pub has_more: bool,
    /// Echoed back so the caller can match a response to the page it asked for
    /// — appending an out-of-order answer would silently interleave the list.
    pub page: u32,
    /// Requests left in the hourly allowance, straight from GitHub's headers.
    pub remaining: Option<u32>,
    /// Seconds until the allowance resets, when GitHub told us.
    pub reset_in: Option<u64>,
}

fn build_url(page: u32) -> String {
    format!("{API}?page={page}&per_page={PER_PAGE}")
}

fn has_more_for(page: u32, item_count: usize) -> bool {
    page < MAX_PAGE && item_count >= PER_PAGE as usize
}

/// Parses a 2xx starred-list body: a **bare JSON array** of repo objects.
///
/// Returns the mapped items **and the raw array length**. The caller's
/// [`has_more_for`] needs the raw count, not the filtered one: a full page
/// whose trailing entries were skipped (private, nameless) is still a full
/// page, and a walk driven by the visible count would stop at the first page
/// that happened to contain one private star.
///
/// Not routable through [`crate::search::parse_search_response`]: search wraps
/// its items in an object (`{"total_count": …, "items": […]}`) while this
/// endpoint's body *is* the array. The per-item mapping is shared
/// ([`parse_repo_item`]), which is where the fields actually live.
///
/// `private: true` entries are dropped on purpose: a classic token's list
/// includes the account's private stars, but cloning one needs a credential
/// the download path does not carry — a row whose only outcome is an auth
/// failure is a promise the app cannot keep (v1 scope: public repos only).
pub(crate) fn parse_starred_body(body: &str) -> Result<(Vec<RepoHit>, usize), String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("无法解析 GitHub 星标响应: {e}"))?;
    let array = json
        .as_array()
        .ok_or_else(|| "GitHub 星标响应不是 JSON 数组".to_string())?;
    let raw_len = array.len();
    let items = array
        .iter()
        .filter(|it| it.get("private").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(parse_repo_item)
        .collect();
    Ok((items, raw_len))
}

/// Maps a non-2xx GitHub answer to the message the panel shows.
///
/// The status alone does not decide the text: GitHub uses `403` both for the
/// hourly limit (with `x-ratelimit-remaining: 0`) and for a credential that may
/// not read stars, and those need different remedies — which is why
/// `remaining` is part of the signature. A `404` on `/user/starred` is how
/// GitHub hides a resource from a fine-grained token that was never granted
/// access to it, so it gets the permission sentence rather than a generic one.
fn error_for_status(status: u16, body: &str, remaining: Option<u32>, reset_in: Option<u64>) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string));
    match status {
        401 => "GitHub Token 无效或已过期，请在 设置 → GitHub Token 里更新后重试".to_string(),
        403 if remaining == Some(0) => {
            let wait = match reset_in {
                Some(s) => format!("，约 {s} 秒后自动恢复"),
                None => String::new(),
            };
            format!("GitHub 接口额度已用完{wait}。星标导入用的是账号额度，稍等再试即可。")
        }
        403 => format!(
            "GitHub 拒绝读取星标（403）：{}",
            message
                .as_deref()
                .unwrap_or("请确认 Token 未过期；fine-grained Token 需要勾选 Star 的读取权限")
        ),
        404 => "GitHub 找不到星标接口（404）。如果使用的是 fine-grained Token，请确认它允许读取你账号的 Star。".to_string(),
        other => format!(
            "GitHub 返回 {other}：{}",
            message.as_deref().unwrap_or("没有给出原因")
        ),
    }
}

/// One network attempt at one page, no retries.
fn list_once(
    page: u32,
    token: &str,
    resolve: Option<&str>,
    best_effort: bool,
) -> Result<StarPage, String> {
    let curl = which_curl().ok_or("找不到 curl，无法访问 GitHub API")?;
    let url = build_url(page);
    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        // -i so the rate-limit headers are readable; the numbers the panel
        // reports are GitHub's own, not a local guess.
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
    if let Some(ip) = resolve {
        cmd.arg("--resolve").arg(format!("api.github.com:443:{ip}"));
    }
    if best_effort && cfg!(windows) {
        cmd.arg("--ssl-revoke-best-effort");
    }
    cmd.arg(&url);

    let out = curl_with_token(cmd, token).map_err(|e| format!("无法启动 curl: {e}"))?;
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

    if !out.status.success() && body.trim().is_empty() {
        // curl itself failed (TLS, DNS, timeout …) before any HTTP answer.
        let stderr = crate::proc::decode_console(&out.stderr);
        let trimmed = stderr.trim();
        let hint = if is_revocation_failure(trimmed) {
            if best_effort {
                // Already the relaxed attempt: the certificate itself is the
                // problem, not the missing revocation source.
                "（已放宽吊销检查重试，仍未通过：本机加速工具提供的证书本身不受信任。）"
            } else if resolve.is_some() {
                // The 绕过 route pinned an address and it still failed, so the
                // hosts advice would send the user to the setting they are on.
                "（已按「绕过」设置直连官方 IP，仍未通过。）"
            } else {
                "（本机 hosts 可能把 GitHub 指向了 127.0.0.1，通常是本地加速工具的自签证书未通过吊销检查。把「设置 → 网络 → 搜索链路」改成「绕过」即可。）"
            }
        } else if trimmed.contains("Failed to connect to") || trimmed.contains("could not connect") {
            "（连接被拒：hosts 把该域名指向了本机，而本机没有服务在监听。）"
        } else {
            ""
        };
        return Err(format!("请求失败: {trimmed}{hint}"));
    }

    let status = status_of(&raw).unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(error_for_status(status, &body, remaining, reset_in));
    }

    let (items, raw_len) = parse_starred_body(&body)?;
    Ok(StarPage {
        has_more: has_more_for(page, raw_len),
        items,
        page,
        remaining,
        reset_in,
    })
}

/// Lists one page of the token owner's stars, with the same two automatic
/// remedies search uses when a local accelerator intercepts the API host
/// (`search.rs::search`, `fetch_readme`): relax the Schannel revocation check
/// first (no DNS needed), then — when the first attempt still failed on the
/// revocation error and `hosts` is hijacked and no address was pinned yet —
/// one retry against a public-DNS-agreed IP.
///
/// `resolve` is the caller's 绕过 decision (`Some(ip)` pins the address), not a
/// fallback: passing `None` does **not** mean "try anything", it means "use the
/// hosts/system answer" until the retry decides otherwise.
pub fn list_starred_page(
    page: u32,
    token: Option<&str>,
    resolve: Option<&str>,
) -> Result<StarPage, String> {
    if page == 0 || page > MAX_PAGE {
        return Err(format!("页码应在 1–{MAX_PAGE} 之间（一次最多 {MAX_PAGE} 页）。"));
    }
    let token = match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => {
            return Err(
                "星标列表需要 GitHub Token：请在 设置 → GitHub Token 里填入个人访问令牌后再试。"
                    .to_string(),
            )
        }
    };

    let first = list_once(page, token, resolve, false);
    let after_revocation = match first {
        Err(e) if is_revocation_failure(&e) && cfg!(windows) => {
            let retried = list_once(page, token, resolve, true);
            match &retried {
                // Keep the original error when curl did not understand the
                // flag — the retry failed for an unrelated reason.
                Err(e2) if is_option_unsupported(e2) => Err(e),
                _ => retried,
            }
        }
        ok => ok,
    };

    match after_revocation {
        Err(e) => match bypass_ip_for_retry(Some(&e), resolve.is_some()) {
            Some(ip) => list_once(page, token, Some(&ip), false),
            None => Err(e),
        },
        ok => ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape of one `GET /user/starred` page, per GitHub's REST docs (read
    /// 2026-10-18): a bare JSON array whose entries are the same repo object
    /// `search/repositories` returns. There was no token on this machine to
    /// capture a live answer with, so this is the documented shape with
    /// deliberately awkward variants (null description, missing language and
    /// topics, one entry that is not a repository at all, one private entry) —
    /// it pins the array wrapper, the skip rules and the raw-length count; the
    /// item fields themselves are pinned by search.rs's `REAL_SHAPE`.
    const REAL_SHAPE: &str = r#"[
      {
        "full_name": "rust-lang/rust",
        "description": "Empowering everyone to build reliable and efficient software.",
        "stargazers_count": 102000,
        "language": "Rust",
        "updated_at": "2026-01-01T00:00:00Z",
        "archived": false,
        "topics": ["compiler", "language"]
      },
      {
        "full_name": "tauri-apps/tauri",
        "description": null,
        "stargazers_count": 90000,
        "language": null,
        "archived": true
      },
      {
        "full_name": "someone/private-thing",
        "private": true,
        "stargazers_count": 3
      },
      { "id": 1, "description": "a repo object without full_name" }
    ]"#;

    #[test]
    fn url_carries_page_and_page_size() {
        assert_eq!(
            build_url(3),
            "https://api.github.com/user/starred?page=3&per_page=100"
        );
    }

    #[test]
    fn parses_the_documented_array_shape() {
        let (items, raw) = parse_starred_body(REAL_SHAPE).expect("fixture must parse");
        assert_eq!(items.len(), 2, "the private and nameless entries must be skipped");
        assert_eq!(raw, 4, "raw length counts every array entry, skipped ones included");
        assert_eq!(items[0].full_name, "rust-lang/rust");
        assert_eq!(items[0].stars, 102000);
        assert_eq!(items[0].language, "Rust");
        assert_eq!(items[0].topics, vec!["compiler", "language"]);
        // Null description and missing language/topics must land as empty, not
        // as the strings "null" or a panic.
        assert_eq!(items[1].description, "");
        assert_eq!(items[1].language, "");
        assert_eq!(items[1].updated_at, "");
        assert!(items[1].archived);
        assert!(items[1].topics.is_empty());
    }

    #[test]
    fn private_stars_are_filtered_out() {
        // The download path carries no credential for private repos, so
        // listing one would offer an action that cannot succeed. Public
        // entries beside it are unaffected, and an absent `private` field
        // means public (the documented default).
        let (items, raw) = parse_starred_body(
            r#"[
              { "full_name": "me/mine", "private": true, "stargazers_count": 1 },
              { "full_name": "me/public", "private": false },
              { "full_name": "me/quiet" }
            ]"#,
        )
        .expect("fixture must parse");
        assert_eq!(raw, 3);
        assert_eq!(items.len(), 2, "only the private entry must go");
        assert_eq!(items[0].full_name, "me/public");
        assert_eq!(items[1].full_name, "me/quiet");
    }

    #[test]
    fn empty_array_is_a_valid_empty_page() {
        let (items, raw) = parse_starred_body("[]").expect("empty array must parse");
        assert!(items.is_empty());
        assert_eq!(raw, 0);
        assert!(!has_more_for(1, raw));
    }

    #[test]
    fn rejects_bodies_that_are_not_an_array() {
        let err = parse_starred_body(r#"{"message": "…"}"#).unwrap_err();
        assert!(err.contains("不是 JSON 数组"), "got: {err}");
        let err = parse_starred_body("not json at all").unwrap_err();
        assert!(err.contains("无法解析"), "got: {err}");
    }

    #[test]
    fn a_full_page_means_more_but_the_cap_wins() {
        let full: Vec<serde_json::Value> = (0..PER_PAGE)
            .map(|i| serde_json::json!({ "full_name": format!("o/r{i}") }))
            .collect();
        let body = serde_json::to_string(&full).expect("fixture serialises");
        let (items, raw) = parse_starred_body(&body).expect("fixture must parse");
        assert_eq!(items.len() as u32, PER_PAGE);
        assert_eq!(raw as u32, PER_PAGE);
        assert!(has_more_for(1, raw));
        // The last allowed page reports no more even if it came back full:
        // MAX_PAGE is the end of what this panel walks.
        assert!(!has_more_for(MAX_PAGE, raw));
        // …and a short page anywhere means the list ended.
        assert!(!has_more_for(1, 99));
    }

    #[test]
    fn guards_fire_before_any_network_call() {
        let err = list_starred_page(0, Some("t"), None).unwrap_err();
        assert!(err.contains("页码"), "got: {err}");
        let err = list_starred_page(MAX_PAGE + 1, Some("t"), None).unwrap_err();
        assert!(err.contains("页码"), "got: {err}");
        // No token: the message must say where to put one, and must arrive
        // without touching the network (this test machine has no token).
        let err = list_starred_page(1, None, None).unwrap_err();
        assert!(err.contains("GitHub Token"), "got: {err}");
        let err = list_starred_page(1, Some("   "), None).unwrap_err();
        assert!(err.contains("GitHub Token"), "got: {err}");
    }

    #[test]
    fn status_errors_map_to_their_remedies() {
        // 401: token bad or expired.
        let e = error_for_status(401, "{}", None, None);
        assert!(e.contains("Token 无效"), "got: {e}");
        // 403 with the budget spent: the wait comes from the header and the
        // text must not blame the token.
        let body = r#"{"message": "API rate limit exceeded"}"#;
        let e = error_for_status(403, body, Some(0), Some(30));
        assert!(e.contains("额度已用完"), "got: {e}");
        assert!(e.contains("30 秒"), "got: {e}");
        // 403 without the spent budget: GitHub's own message is carried.
        let e = error_for_status(403, body, Some(3), None);
        assert!(e.contains("rate limit exceeded"), "got: {e}");
        // 404 on this endpoint is how a fine-grained token without star access
        // is hidden; the remedy is permissions, not a retry.
        let e = error_for_status(404, "{}", None, None);
        assert!(e.contains("fine-grained"), "got: {e}");
        // Anything else: status plus GitHub's message.
        let e = error_for_status(500, r#"{"message": "boom"}"#, None, None);
        assert!(e.contains("500") && e.contains("boom"), "got: {e}");
    }
}
