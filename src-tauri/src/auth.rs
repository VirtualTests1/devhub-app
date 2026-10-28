//! r18-R3: 令牌自检 —— 把「存了一个 Token」变成「知道这个 Token 现在能不能用」。
//!
//! ## 这一模块解决的具体问题
//!
//! 设置页一直可以填 GitHub Personal Access Token，而应用对它的态度是「存下来、搜索时
//! 附上、额度从 10/分 提到 30/分」（`search.rs:705-715`）。用户填完之后**没有任何办法
//! 知道它是否有效**：填错一位、被撤销、过期，界面都毫无反应，只表现为「搜索变慢/结果少」，
//! 而那句 `i18n.ts:451` 的「Token 以明文保存在配置文件里」也就成了一句没有下文的提醒。
//! REQUIREMENTS.md §7「明确未做」里的「私有仓库 / GitHub 登录」有一条前置条件就是「先知道
//! 令牌行不行」，所以这里做的是那个前置，不做登录流程本身。
//!
//! ## 只发一次请求，且只看**观察到的**状态
//!
//! `GET https://api.github.com/user` —— 一个需要已认证请求的端点。判定完全基于响应本身：
//!
//! - `200` → 令牌有效；`login` 取自 body。
//! - `401` → 令牌无效（填错 / 已撤销）。
//! - `403` → 被拒绝；用 `x-ratelimit-remaining == 0` 区分「额度用尽」和「权限不够」。
//! - 其它状态或传输失败 → 无法判定，原话回抛。
//!
//! 作用域头（`X-OAuth-Scopes`）**只在响应里真的有的时候**才显示，缺席就写「本次响应没有
//! 返回作用域头」。不在这里解释为什么缺席：细粒度令牌与 GitHub App 令牌是否一定不带这个头，
//! 我在 2026-10-18 没能从官方文档页面核实到（能打开的那页只写了 OAuth App 的 token 校验端点
//! 与「Invalid tokens will return 404 NOT FOUND」，见下），所以界面只报观察结果，不报推断。
//!
//! ## 令牌的去向（三条都是既有约定，不是新规矩）
//!
//! 1. 不进命令行：`search.rs:37 curl_with_token` 用 curl 的 `-K -` 从 stdin 读配置，
//!    Windows 上别的进程读得到本进程的 argv（PEB），读不到它的 stdin。
//! 2. 不进界面：命令只返回 `TokenReport`，其中没有任何字段是令牌本身；设置页早就只读
//!    `has_github_token` 这个布尔（`lib.rs:5000` 一带）。
//! 3. 不进活动记录：`record_config_change` 那套记录的是「设置/更换/删除」，从不记值
//!    （`lib.rs:5446-5460`）；校验是一次读取，不写记录。
//!
//! 出处（本轮实测与既有文档）：
//!   - GitHub REST 文档 `https://docs.github.com/en/rest/apps/oauth-applications`
//!     （2026-10-18 取回）：只确认了 OAuth App 的 token 校验端点行为「Invalid tokens will
//!     return 404 NOT FOUND」——那是带 client secret 的 `POST /applications/{client_id}/token`，
//!     **不适用于 PAT**，所以这里没有采用它，也因此不用 404 做判据。
//!   - 本仓库 `docs/security-posture.md`：`connect-src` 允许 `https://api.github.com`，
//!     所以这条请求不需要动 CSP；令牌刻意只存在于 Rust 侧。

use std::collections::HashMap;

use serde::Serialize;

use crate::search::{
    curl_with_token, is_option_unsupported, is_revocation_failure, split_headers, status_of,
    which_curl, USER_AGENT,
};

/// The endpoint whose status answers "is this token usable right now".
const USER_ENDPOINT: &str = "https://api.github.com/user";

/// What the settings page shows after 校验. No field is the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenReport {
    /// True only for a `200`. `valid == false` does **not** mean "invalid token" —
    /// that is what `status` is for; a transport failure must not read as a bad token.
    pub valid: bool,
    /// The HTTP status that was observed, if any response arrived at all.
    pub status: Option<u16>,
    /// `login` from a `200` body, verbatim.
    pub login: Option<String>,
    /// `X-OAuth-Scopes` verbatim, or absent when the response did not carry it.
    pub scopes: Option<String>,
    /// `X-Expired-OAuth-Scopes`, GitHub's own "these were removed" header, when present.
    pub expired_scopes: Option<String>,
    pub remaining: Option<u32>,
    pub limit: Option<u32>,
    /// Why the answer is what it is, in the app's own words. Present whenever the check
    /// could not conclude `valid`, so the UI never has to invent an explanation.
    pub note: Option<String>,
}

impl TokenReport {
    fn inconclusive(status: Option<u16>, note: String) -> Self {
        TokenReport {
            valid: false,
            status,
            login: None,
            scopes: None,
            expired_scopes: None,
            remaining: None,
            limit: None,
            note: Some(note),
        }
    }
}

/// Read a report out of an *observed* response. Pure, so the rules are testable without
/// a network or a token.
///
/// `headers` must already be lower-cased the way `search.rs:416 split_headers` returns
/// them; `body` is the raw payload (a `401` from GitHub carries a `message` we surface).
pub fn parse_report(status: Option<u16>, headers: &HashMap<String, String>, body: &str) -> TokenReport {
    let remaining = headers.get("x-ratelimit-remaining").and_then(|v| v.trim().parse().ok());
    let limit = headers.get("x-ratelimit-limit").and_then(|v| v.trim().parse().ok());
    let scopes = non_empty(headers.get("x-oauth-scopes"));
    let expired_scopes = non_empty(headers.get("x-expired-oauth-scopes"));
    match status {
        Some(200) => {
            let login = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("login").and_then(|l| l.as_str()).map(str::to_string));
            TokenReport {
                valid: true,
                status: Some(200),
                login,
                scopes,
                expired_scopes,
                remaining,
                limit,
                // A token with no scope header is still a working token; saying nothing is
                // more honest than saying "scopes unknown" in a tone that reads like a fault.
                note: None,
            }
        }
        Some(401) => TokenReport {
            valid: false,
            status: Some(401),
            login: None,
            scopes,
            expired_scopes,
            remaining,
            limit,
            note: Some("令牌无效：可能被撤销、过期，或粘贴时少了字符".to_string()),
        },
        // GitHub answers 403 both for a spent allowance and for a token that is fine but
        // not allowed on this endpoint. The header is the only thing that tells them apart,
        // so the two readings are spelled out rather than collapsed into "权限不足".
        Some(403) => TokenReport {
            valid: false,
            status: Some(403),
            login: None,
            scopes,
            expired_scopes,
            remaining,
            limit,
            note: Some(if remaining == Some(0) {
                "令牌本身可用，但本小时的 API 额度已用尽".to_string()
            } else {
                "GitHub 拒绝了这次已认证请求（403），令牌权限不足或需要额外作用域".to_string()
            }),
        },
        Some(other) => TokenReport::inconclusive(
            Some(other),
            github_message(body).unwrap_or_else(|| format!("GitHub 返回状态 {other}")),
        ),
        None => TokenReport::inconclusive(None, "响应里读不出状态行，无法判定".to_string()),
    }
}

fn non_empty(v: Option<&String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// GitHub's own explanation, when it sent one (`{"message":"Bad credentials"}`), with the
/// documented 200-char shape. Surfacing it verbatim beats a generic "HTTP 4xx": the
/// message is the thing a person can search for.
fn github_message(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("message")
        .and_then(|m| m.as_str())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
}

/// Ask GitHub once, with the same two automatic recoveries the other API paths use
/// (relaxed revocation check, then the hosts bypass). Written out here rather than shared
/// because this is a one-shot diagnostic behind a button: `search.rs` and `heat.rs` run
/// the ladder dozens of times per session, which is what makes their extra guards worth it.
pub fn verify(token: &str, resolve: Option<&str>) -> TokenReport {
    let token = token.trim();
    if token.is_empty() {
        return TokenReport::inconclusive(None, "还没有填写令牌".to_string());
    }
    let attempt = request(token, resolve, false);
    let attempt = match attempt {
        Err(e) if is_revocation_failure(&e) && cfg!(windows) => {
            let retried = request(token, resolve, true);
            match &retried {
                Err(e2) if is_option_unsupported(e2) => Err(e),
                _ => retried,
            }
        }
        ok => ok,
    };
    match attempt {
        Ok(r) => r,
        Err(e) => match crate::search::bypass_ip_for_retry(Some(&e), resolve.is_some()) {
            Some(ip) => request(token, Some(&ip), false).unwrap_or_else(|e2| {
                TokenReport::inconclusive(None, e2)
            }),
            None => TokenReport::inconclusive(None, e),
        },
    }
}

/// One curl of `USER_ENDPOINT`, authenticated. Returns the parsed report (a `401` is
/// still an *answer*, so it is `Ok`).
fn request(token: &str, resolve: Option<&str>, best_effort: bool) -> Result<TokenReport, String> {
    let curl = which_curl().ok_or("找不到 curl，无法访问 GitHub API")?;
    let mut cmd = crate::proc::silent(curl);
    cmd.args([
        "-sS",
        // -i: the scope and rate-limit headers are half the answer.
        "-i",
        "--no-progress-meter",
        "-L",
        "--max-time",
        "20",
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
    cmd.arg(USER_ENDPOINT);
    let out = curl_with_token(cmd, token).map_err(|e| format!("无法启动 curl: {e}"))?;
    if !out.status.success() {
        let err = crate::proc::decode_console(&out.stderr);
        return Err(format!("令牌校验请求失败: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (headers, body) = split_headers(&text);
    Ok(parse_report(status_of(&text), &headers, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_200_is_valid_and_carries_the_login() {
        let h = headers(&[("x-ratelimit-remaining", "4993"), ("x-ratelimit-limit", "5000")]);
        let r = parse_report(Some(200), &h, r#"{"login":"octocat","id":583231}"#);
        assert!(r.valid);
        assert_eq!(r.status, Some(200));
        assert_eq!(r.login.as_deref(), Some("octocat"));
        assert_eq!(r.remaining, Some(4993));
        assert_eq!(r.limit, Some(5000));
        assert!(r.note.is_none(), "一个能用的令牌不该附带解释");
    }

    #[test]
    fn an_absent_scope_header_stays_absent() {
        // A fine-grained token may answer 200 with no `X-OAuth-Scopes` at all; the report
        // must not turn that into a claim about scopes.
        let h = headers(&[("x-ratelimit-remaining", "42")]);
        let r = parse_report(Some(200), &h, r#"{"login":"a"}"#);
        assert!(r.valid);
        assert_eq!(r.scopes, None);
        assert_eq!(r.expired_scopes, None);
    }

    #[test]
    fn an_empty_scope_header_is_absent_too() {
        let h = headers(&[("x-oauth-scopes", ""), ("x-expired-oauth-scopes", "  ")]);
        let r = parse_report(Some(200), &h, r#"{"login":"a"}"#);
        assert_eq!(r.scopes, None);
        assert_eq!(r.expired_scopes, None);
    }

    #[test]
    fn a_401_is_an_invalid_token_and_says_why() {
        let h = headers(&[("x-ratelimit-remaining", "0")]);
        let r = parse_report(Some(401), &h, r#"{"message":"Bad credentials"}"#);
        assert!(!r.valid);
        assert_eq!(r.status, Some(401));
        assert!(r.note.as_deref().unwrap().contains("无效"));
    }

    #[test]
    fn a_403_distinguishes_a_spent_allowance_from_a_permission_problem() {
        let spent = headers(&[("x-ratelimit-remaining", "0")]);
        let r = parse_report(Some(403), &spent, r#"{"message":"Forbidden"}"#);
        assert!(r.note.as_deref().unwrap().contains("额度已用尽"));
        assert!(!r.valid, "额度用尽不等于令牌无效，但也不等于有效");

        let denied = headers(&[("x-ratelimit-remaining", "41")]);
        let r2 = parse_report(Some(403), &denied, "{}");
        assert!(r2.note.as_deref().unwrap().contains("权限不足"));
    }

    #[test]
    fn scopes_are_echoed_verbatim_when_present() {
        let h = headers(&[
            ("x-oauth-scopes", "repo, user, read:org"),
            ("x-expired-oauth-scopes", "gist"),
        ]);
        let r = parse_report(Some(200), &h, r#"{"login":"a"}"#);
        assert_eq!(r.scopes.as_deref(), Some("repo, user, read:org"));
        assert_eq!(r.expired_scopes.as_deref(), Some("gist"));
    }

    #[test]
    fn an_unexpected_status_shows_githubs_own_words_when_it_sent_them() {
        let h = headers(&[]);
        let r = parse_report(Some(502), &h, r#"{"message":"Server Error"}"#);
        assert!(!r.valid);
        assert_eq!(r.note.as_deref(), Some("Server Error"));
        let plain = parse_report(Some(502), &h, "not json");
        assert_eq!(plain.note.as_deref(), Some("GitHub 返回状态 502"));
    }

    #[test]
    fn no_status_line_is_inconclusive_not_a_bad_token() {
        let r = parse_report(None, &headers(&[]), "");
        assert!(!r.valid);
        assert_eq!(r.status, None);
        assert!(r.note.as_deref().unwrap().contains("无法判定"));
    }

    #[test]
    fn malformed_body_does_not_invalidate_a_200() {
        let r = parse_report(Some(200), &headers(&[]), "gateway noise");
        assert!(r.valid, "状态已经是 200：读不出 login 只是少一项显示");
        assert_eq!(r.login, None);
    }

    #[test]
    fn an_empty_token_is_answered_without_touching_the_network() {
        // The command's callers pass the config value straight through; "no token yet"
        // must not become a curl spawn.
        let r = verify("", None);
        assert!(!r.valid);
        assert_eq!(r.status, None);
        assert!(r.note.as_deref().unwrap().contains("还没有填写令牌"));
        let spaced = verify("   ", None);
        assert!(spaced.note.as_deref().unwrap().contains("还没有填写令牌"));
    }

    #[test]
    fn the_report_never_carries_the_token() {
        // Structural guard: `TokenReport` is what crosses the IPC boundary to the webview.
        // A field named after the secret would be the leak, and serde's camelCase rename
        // would carry it out just as happily as any other field.
        let fields = [
            "valid",
            "status",
            "login",
            "scopes",
            "expiredScopes",
            "remaining",
            "limit",
            "note",
        ];
        let json = serde_json::to_string(&TokenReport {
            valid: true,
            status: Some(200),
            login: Some("octocat".to_string()),
            scopes: Some("repo".to_string()),
            expired_scopes: None,
            remaining: Some(1),
            limit: Some(2),
            note: None,
        })
        .unwrap();
        for f in fields {
            assert!(json.contains(f), "报告字段 {f} 变了形状，界面与测试都得跟着改");
        }
        let lowered = json.to_ascii_lowercase();
        for banned in ["bearer", "\"token\"", "ghp_", "github_pat_"] {
            assert!(!lowered.contains(banned), "报告里出现了 {banned}：那是不该离开 Rust 的东西");
        }
    }
}
