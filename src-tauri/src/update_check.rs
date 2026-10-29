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
use std::path::{Path, PathBuf};
use std::process::Stdio;

const RELEASE_URL: &str =
    "https://api.github.com/repos/VirtualTests1/devhub-app/releases/latest";

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

fn fetch_release() -> Result<String, String> {
    let curl = which_curl().ok_or("找不到 curl，无法检查更新")?;
    let run = |no_revoke: bool| {
        let mut cmd = crate::proc::silent(&curl);
        cmd.args([
            "-sS",
            "-L",
            "--fail",
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
        if no_revoke {
            cmd.arg("--ssl-no-revoke");
        }
        cmd.arg(RELEASE_URL)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(20))
    };
    let first = run(false).map_err(|e| format!("无法启动 curl: {e}"))?;
    let output = match first {
        Some(o) if o.status.success() => o,
        Some(o) => {
            let err = crate::proc::decode_console(&o.stderr);
            if crate::search::is_revocation_failure(&err) {
                run(true)
                    .map_err(|e| format!("无法启动 curl: {e}"))?
                    .ok_or_else(|| "检查更新超时".to_string())?
            } else {
                return Err(format!("检查更新失败: {}", err.trim()));
            }
        }
        None => return Err("检查更新超时".to_string()),
    };
    if !output.status.success() {
        let err = crate::proc::decode_console(&output.stderr);
        return Err(format!("检查更新失败: {}", err.trim()));
    }
    String::from_utf8(output.stdout).map_err(|_| "Release 响应不是 UTF-8".to_string())
}

/// Read-only check exposed to the settings About page.
#[tauri::command]
pub async fn check_app_update() -> Result<AppUpdate, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let body = fetch_release()?;
        parse_release(&body, env!("CARGO_PKG_VERSION"))
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
        let same = parse_release(body, "0.4.0").expect("same");
        assert!(!same.available);
        let older = parse_release(body, "0.5.0").expect("older");
        assert!(!older.available);
    }

    #[test]
    #[ignore = "network: reads the public GitHub release feed"]
    fn live_release_feed_is_parseable() {
        let body = fetch_release().expect("release feed");
        let update = parse_release(&body, "0.0.0").expect("parse live release");
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
