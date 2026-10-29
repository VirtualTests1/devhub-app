//! Which Microsoft Edge WebView2 runtime is actually installed (r31-N3).
//!
//! Tauri needs the Evergreen WebView2 runtime; when it is missing the window
//! cannot render at all, and when it is old the support conversation starts with
//! "which version?". The app itself cannot read `navigator.userAgent` before the
//! webview exists, so the backend resolves it before/independently of the page.
//!
//! Detection order:
//!   1. enumerate the two documented install roots (`Program Files (x86)` and
//!      `%LOCALAPPDATA%`), looking for `Application/<version>/msedgewebview2.exe`;
//!   2. a fixed-version folder named by `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`;
//!   3. the EdgeUpdate client registry values (`pv`) as a fallback.
//!
//! No network, no elevation, no writes. A directory whose version cannot be
//! parsed is ignored rather than shown as a version; "missing" is a real answer,
//! not an empty string.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const WEBVIEW2_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebView2Info {
    /// The highest installed version, e.g. `156.0.4314.50`; `None` = not found.
    pub version: Option<String>,
    /// `directory`, `registry`, or `missing`.
    pub source: &'static str,
    /// The directory containing `msedgewebview2.exe`, for support reports.
    pub path: Option<String>,
}

impl WebView2Info {
    fn missing() -> Self {
        Self {
            version: None,
            source: "missing",
            path: None,
        }
    }
}

/// Parse a version directory/registry value into comparable numeric parts.
///
/// WebView2 versions are four dotted numbers in practice; two or three are
/// accepted too because the registry has shown shortened values. A suffix such
/// as `-beta` is ignored for ordering, but the original string is returned by
/// the caller when it wins.
pub fn version_parts(raw: &str) -> Option<Vec<u64>> {
    let core = raw.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = Vec::new();
    for piece in core.split('.') {
        if piece.is_empty() || !piece.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts.push(piece.parse::<u64>().ok()?);
        if parts.len() > 4 {
            return None;
        }
    }
    if parts.len() < 2 {
        return None;
    }
    while parts.len() < 4 {
        parts.push(0);
    }
    Some(parts)
}

/// The highest parseable version, or `None`. Ties keep the first (stable input
/// order from the filesystem is not guaranteed, so the caller sorts its list).
pub fn best_version(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .filter_map(|raw| version_parts(raw).map(|parts| (parts, raw.clone())))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, raw)| raw)
}

fn executable_in(dir: &Path) -> bool {
    dir.join("msedgewebview2.exe").is_file()
}

/// Versions under one `...\Microsoft\EdgeWebView\Application` directory.
fn scan_application_root(root: &Path, out: &mut Vec<(String, PathBuf)>) {
    let app = root.join("Microsoft").join("EdgeWebView").join("Application");
    let Ok(entries) = std::fs::read_dir(&app) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || version_parts(&entry.file_name().to_string_lossy()).is_none() {
            continue;
        }
        if executable_in(&path) {
            out.push((entry.file_name().to_string_lossy().to_string(), path));
        }
    }
}

/// Directories a fixed/evergreen WebView2 runtime can live in for this user.
fn install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
        if let Some(dir) = std::env::var_os(key) {
            roots.push(PathBuf::from(dir));
        }
    }
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(dir));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn from_directories() -> Option<WebView2Info> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    for root in install_roots() {
        scan_application_root(&root, &mut found);
    }
    if let Some(dir) = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER") {
        let path = PathBuf::from(dir);
        if executable_in(&path) {
            if let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) {
                if version_parts(&name).is_some() {
                    found.push((name, path));
                }
            }
        }
    }
    let version = best_version(&found.iter().map(|(v, _)| v.clone()).collect::<Vec<_>>())?;
    let path = found.into_iter().find(|(v, _)| v == &version).map(|(_, p)| p);
    Some(WebView2Info {
        version: Some(version),
        source: "directory",
        path: path.map(|p| p.to_string_lossy().to_string()),
    })
}

#[cfg(windows)]
fn registry_value(hive: winreg::HKEY, view: Option<u32>) -> Option<String> {
    use winreg::RegKey;
    let subkey = format!(r"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}");
    let hk = RegKey::predef(hive);
    let key = match view {
        Some(flags) => hk.open_subkey_with_flags(&subkey, winreg::enums::KEY_READ | flags).ok()?,
        None => hk.open_subkey(&subkey).ok()?,
    };
    key.get_value::<String, _>("pv").ok()
}

#[cfg(windows)]
fn from_registry() -> Option<WebView2Info> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY};
    let mut candidates = Vec::new();
    if let Some(v) = registry_value(HKEY_CURRENT_USER, None) {
        candidates.push(v);
    }
    if let Some(v) = registry_value(HKEY_LOCAL_MACHINE, Some(KEY_WOW64_32KEY)) {
        candidates.push(v);
    }
    let version = best_version(&candidates)?;
    Some(WebView2Info {
        version: Some(version),
        source: "registry",
        path: None,
    })
}

#[cfg(not(windows))]
fn from_registry() -> Option<WebView2Info> {
    None
}

/// Resolve the runtime. Never fails: missing is represented explicitly.
pub fn info() -> WebView2Info {
    from_directories()
        .or_else(from_registry)
        .unwrap_or_else(WebView2Info::missing)
}

/// Read-only command for 设置 → 关于 and the diagnostics export.
#[tauri::command(async)]
pub fn webview2_info() -> WebView2Info {
    info()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parts_are_numeric_and_padded() {
        assert_eq!(version_parts("156.0.4314.50"), Some(vec![156, 0, 4314, 50]));
        assert_eq!(version_parts("v156.0.4314.50"), Some(vec![156, 0, 4314, 50]));
        assert_eq!(version_parts("156.0.4314.50-beta"), Some(vec![156, 0, 4314, 50]));
        assert_eq!(version_parts("156.0"), Some(vec![156, 0, 0, 0]));
        assert_eq!(version_parts("156"), None);
        assert_eq!(version_parts("SetupMetrics"), None);
        assert_eq!(version_parts("1.2.3.4.5"), None);
    }

    #[test]
    fn best_version_compares_numerically_not_lexically() {
        let got = best_version(&[
            "99.0.0.0".to_string(),
            "156.0.4314.50".to_string(),
            "155.9.9.9".to_string(),
            "not a version".to_string(),
        ]);
        assert_eq!(got.as_deref(), Some("156.0.4314.50"));
        assert_eq!(best_version(&[]), None);
        assert_eq!(best_version(&["x".to_string()]), None);
    }

    #[test]
    fn scanning_a_temp_application_root_requires_the_executable_and_a_version() {
        let root = std::env::temp_dir().join(format!("devhub-webview2-{}", std::process::id()));
        let app = root.join("Microsoft/EdgeWebView/Application");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(app.join("156.0.4314.50")).unwrap();
        std::fs::create_dir_all(app.join("SetupMetrics")).unwrap();
        std::fs::write(app.join("156.0.4314.50/msedgewebview2.exe"), b"x").unwrap();

        let mut found = Vec::new();
        scan_application_root(&root, &mut found);
        assert_eq!(found.len(), 1, "only the versioned dir with the executable counts");
        assert_eq!(found[0].0, "156.0.4314.50");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_is_an_explicit_answer_not_an_empty_string() {
        assert_eq!(WebView2Info::missing().version, None);
        assert_eq!(WebView2Info::missing().source, "missing");
    }
}