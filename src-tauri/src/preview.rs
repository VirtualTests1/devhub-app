//! Download preflight: what GitHub says about a repository before it is cloned
//! (r22-N1).
//!
//! `preview_ref` (`lib.rs`) already answers "where would this land, and is that
//! directory occupied" without touching the network. This module adds the other
//! half: the public facts GitHub exposes at `GET /repos/{owner}/{repo}` (stars,
//! language, license, default branch, size, last push, archived/fork/private) plus
//! free space on the landing volume.
//!
//! The endpoint is documented at
//! `https://docs.github.com/en/rest/repos/repos#get-a-repository` (retrieved
//! 2026-10-21): `size` is an integer and the response carries `default_branch`,
//! `license.spdx_id`, `language`, `stargazers_count`, `pushed_at`, `archived`,
//! `private` and `fork`. A live anonymous request on the same date returned
//! `{"full_name":"octocat/Hello-World","size":1,"default_branch":"master",...}`.
//! The unit is **not** re-derived here: the UI labels the field "GitHub 报告的
//! 大小" and prints the integer, rather than converting it to MB from an
//! unverified unit.
//!
//! ## Failures are answers, not command errors
//!
//! A 404, a rate limit or a dead network must not make the add page's preview
//! disappear: the command returns `facts: None` plus `error: Some(github's own
//! sentence)` and the UI shows "远端信息不可用" beside the local preview. The
//! same shape `repo_freshness` uses for "could not ask".

use super::*;

/// The subset of `GET /repos/{owner}/{repo}` this UI actually reads.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoFacts {
    pub full_name: String,
    pub description: Option<String>,
    pub stars: u64,
    pub language: Option<String>,
    /// `license.spdx_id`, when GitHub published a recognised license.
    pub license: Option<String>,
    pub default_branch: Option<String>,
    /// GitHub's integer `size` field, passed through unchanged (see module note).
    pub size: Option<u64>,
    pub pushed_at: Option<String>,
    pub archived: bool,
    pub private: bool,
    pub fork: bool,
}

/// One preflight answer. `facts` and `error` are mutually exclusive in practice;
/// `disk` is independent of whether GitHub answered.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePreview {
    pub facts: Option<RepoFacts>,
    /// GitHub's own message when the API did not answer with a repository.
    pub error: Option<String>,
    pub disk_free_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    /// The path whose volume was measured (the guarded target, or the project root).
    pub disk_path: String,
    pub disk_error: Option<String>,
}

fn text_of(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn bool_of(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Parse an API response body. Pure, so the field mapping is testable without a
/// network; unknown fields are ignored, and a missing optional field is `None`.
pub(crate) fn parse_repo_facts(body: &str) -> Result<RepoFacts, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("GitHub 返回的不是 JSON：{e}"))?;
    if value.get("full_name").and_then(|v| v.as_str()).is_none() {
        // A rate-limit/404 payload is `{message: ...}`; surface it verbatim instead
        // of inventing a repository with empty fields.
        let message = text_of(&value, "message").unwrap_or_else(|| "响应里没有 full_name".to_string());
        return Err(message);
    }
    Ok(RepoFacts {
        full_name: text_of(&value, "full_name").unwrap_or_default(),
        description: text_of(&value, "description"),
        stars: value
            .get("stargazers_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        language: text_of(&value, "language"),
        license: value
            .get("license")
            .and_then(|l| l.get("spdx_id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| s != "NOASSERTION" && !s.is_empty()),
        default_branch: text_of(&value, "default_branch"),
        size: value.get("size").and_then(|v| v.as_u64()),
        pushed_at: text_of(&value, "pushed_at"),
        archived: bool_of(&value, "archived"),
        private: bool_of(&value, "private"),
        fork: bool_of(&value, "fork"),
    })
}

/// One authenticated (or anonymous) request for the repository document.
pub(crate) fn fetch_repo_facts(
    full_name: &str,
    token: Option<&str>,
    resolve: Option<&str>,
) -> Result<RepoFacts, String> {
    let name = full_name.trim().trim_matches('/');
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty()) {
        return Err("仓库名应为 owner/repo".to_string());
    }
    let curl = search::which_curl().ok_or("找不到 curl，无法访问 GitHub API")?;
    let url = format!("https://api.github.com/repos/{name}");
    let mut cmd = proc::silent(curl);
    cmd.args([
        "-sS",
        "-i",
        "--no-progress-meter",
        "-L",
        "--max-time",
        "20",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        &format!("User-Agent: {}", search::USER_AGENT),
    ]);
    if let Some(ip) = resolve {
        cmd.arg("--resolve").arg(format!("api.github.com:443:{ip}"));
    }
    if cfg!(windows) {
        // Same Schannel revocation shape the search path documents; the cert is still
        // validated and still has to match the hostname.
        cmd.arg("--ssl-revoke-best-effort");
    }
    cmd.arg(&url);
    let authed = token.filter(|t| !t.trim().is_empty());
    let out = match authed {
        Some(t) => search::curl_with_token(cmd, t),
        None => cmd.output(),
    }
    .map_err(|e| format!("无法启动 curl: {e}"))?;
    let raw = String::from_utf8_lossy(&out.stdout).into_owned();
    let (headers, body) = search::split_headers(&raw);
    let status = search::status_of(&raw);
    if status == Some(200) {
        return parse_repo_facts(&body);
    }
    // Non-200: GitHub's `message` is the sentence worth showing ("Not Found",
    // "API rate limit exceeded…"). A transport failure with no HTTP status keeps
    // curl's stderr instead of an invented reason. When the headers say the budget
    // is spent, append the one hint that tells the user what to do about it.
    if let Ok(parsed) = parse_repo_facts(&body) {
        return Ok(parsed);
    }
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| text_of(&v, "message"))
        .or_else(|| {
            let err = proc::decode_console(&out.stderr);
            let one = err.trim();
            (!one.is_empty()).then(|| one.to_string())
        })
        .unwrap_or_else(|| format!("GitHub API 返回 {}", status.map(|s| s.to_string()).unwrap_or("无状态码".into())));
    Err(match search::rate_limit_hint(&headers) {
        Some(hint) => format!("{detail}（{hint}）"),
        None => detail,
    })
}

/// The command the add page calls when the user asks for remote facts.
#[tauri::command]
pub(crate) async fn preview_remote(
    app: tauri::AppHandle,
    input: String,
    target_dir: Option<String>,
) -> Result<RemotePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = downloader::parse_ref(&input).map_err(|e| e.to_string())?;
        if !r.host.eq_ignore_ascii_case("github.com") {
            return Err(format!("远端信息只支持 github.com，收到 {}", r.host));
        }
        let cfg = read_config();
        let token = crate::settings_cmd::usable_token_opt(&cfg.github_token);
        let route = cfg.search_route;
        let ip = if route == "bypass" && netpath::read_hosts_state().hijacked {
            resolve_agreed_ip("api.github.com")
        } else {
            None
        };
        let full_name = format!("{}/{}", r.owner, r.repo);
        let facts = fetch_repo_facts(&full_name, token.as_deref(), ip.as_deref());
        let (facts, error) = match facts {
            Ok(f) => (Some(f), None),
            Err(e) => (None, Some(e)),
        };

        // Disk: measure the guarded target when the page supplied one, otherwise the
        // project root. A refusal is reported, not replaced by a 0-byte answer.
        let (disk_path, disk_error) = match target_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(dir) => match path_guard::guard(&app, dir, path_guard::Access::Write) {
                Ok(p) => (netpath::strip_verbatim(&p), None),
                Err(e) => (PathBuf::from(dir), Some(e)),
            },
            None => (project_root(), None),
        };
        let space = if disk_error.is_none() {
            disk::space_for(&disk_path)
        } else {
            None
        };
        Ok(RemotePreview {
            facts,
            error,
            disk_free_bytes: space.map(|s| s.available),
            disk_total_bytes: space.map(|s| s.total),
            disk_path: disk_path.to_string_lossy().to_string(),
            disk_error,
        })
    })
    .await
    .map_err(|e| format!("远端预检任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "full_name": "octocat/Hello-World",
        "description": "My first repository on GitHub!",
        "stargazers_count": 3864,
        "language": null,
        "license": null,
        "default_branch": "master",
        "size": 1,
        "pushed_at": "2024-08-20T23:54:42Z",
        "archived": false,
        "private": false,
        "fork": false
    }"#;

    #[test]
    fn parses_the_live_hello_world_shape() {
        let f = parse_repo_facts(SAMPLE).unwrap();
        assert_eq!(f.full_name, "octocat/Hello-World");
        assert_eq!(f.stars, 3864);
        assert_eq!(f.default_branch.as_deref(), Some("master"));
        assert_eq!(f.size, Some(1));
        assert_eq!(f.language, None, "null language stays absent, not empty string");
        assert_eq!(f.license, None);
        assert!(!f.archived && !f.private && !f.fork);
    }

    #[test]
    fn a_license_object_is_reduced_to_its_spdx_id() {
        let body = r#"{"full_name":"a/b","license":{"key":"mit","spdx_id":"MIT","name":"MIT License"}}"#;
        assert_eq!(parse_repo_facts(body).unwrap().license.as_deref(), Some("MIT"));
        let noassert = r#"{"full_name":"a/b","license":{"spdx_id":"NOASSERTION"}}"#;
        assert_eq!(parse_repo_facts(noassert).unwrap().license, None, "NOASSERTION is not a license name");
    }

    #[test]
    fn an_error_payload_is_a_reason_not_a_fake_repository() {
        let err = parse_repo_facts(r#"{"message":"API rate limit exceeded"}"#).unwrap_err();
        assert!(err.contains("rate limit"), "GitHub's message must survive: {err}");
        assert!(parse_repo_facts("not json").is_err());
    }

    #[test]
    fn optional_fields_do_not_require_github_to_send_them() {
        let f = parse_repo_facts(r#"{"full_name":"a/b"}"#).unwrap();
        assert_eq!(f.stars, 0);
        assert_eq!(f.size, None);
        assert_eq!(f.pushed_at, None);
    }
}
