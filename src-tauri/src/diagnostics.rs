//! Diagnostics report export (r17-n3-3; JSON added r26-N2).
//!
//! One `DiagnosticsFacts` value feeds both formats: the Markdown a person pastes
//! into a support thread and the JSON a script can parse. Building the two from a
//! single collection is deliberate — the old separate-builder temptation is how a
//! report starts disagreeing with itself.
//!
//! It is read-only and carries no repository contents and no token value: paths,
//! versions and counts only.

use crate::settings_cmd::{config_path, write_atomic};
use crate::{
    bundled_runtime_dir, disk, find_git, netpath, path_guard, project_root, project_roots,
    read_config, record_activity, repo_index, settings_cmd, window_state_path, Log, SRC_RECORDS,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootFact {
    path: String,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFact {
    source: String,
    error: Option<String>,
    backup_path: String,
    /// A closed set, so a consumer does not have to parse Chinese prose.
    token_state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildFact {
    rustc_wrapper: String,
    vendored_sccache: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskFact {
    path: String,
    available: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsFacts {
    app_version: String,
    os: String,
    arch: String,
    webview2: crate::webview2::WebView2Info,
    config_path: String,
    window_state_path: String,
    roots: Vec<RootFact>,
    git_path: Option<String>,
    settings: SettingsFact,
    build: BuildFact,
    repo_count: usize,
    disk: Option<DiskFact>,
}

fn token_state(cfg: &crate::AppConfig) -> &'static str {
    if cfg.github_token.trim().is_empty() {
        "not_configured"
    } else if settings_cmd::usable_token(&cfg.github_token).is_empty() {
        "undecryptable"
    } else {
        "configured"
    }
}

fn collect_facts() -> DiagnosticsFacts {
    let cfg = read_config();
    let state = settings_cmd::config_read_state();
    let roots = project_roots();
    let (repos, _origin) = repo_index::repos(&roots);
    let vendored = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor/sccache/bin/sccache.exe");
    DiagnosticsFacts {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        webview2: crate::webview2::info(),
        config_path: config_path().display().to_string(),
        window_state_path: window_state_path().display().to_string(),
        roots: roots
            .iter()
            .map(|r| RootFact {
                path: r.display().to_string(),
                exists: r.is_dir(),
            })
            .collect(),
        git_path: find_git(bundled_runtime_dir().as_deref()).map(|g| g.path),
        settings: SettingsFact {
            source: state.source,
            error: state.error,
            backup_path: settings_cmd::config_backup_path().display().to_string(),
            token_state: token_state(&cfg),
        },
        build: BuildFact {
            rustc_wrapper: std::env::var("RUSTC_WRAPPER").unwrap_or_else(|_| "（未设置）".to_string()),
            vendored_sccache: vendored.is_file(),
        },
        repo_count: repos.len(),
        disk: disk::space_for(&project_root()).map(|s| DiskFact {
            path: project_root().display().to_string(),
            available: s.available,
            total: s.total,
        }),
    }
}

pub(crate) fn build_diagnostics_report() -> String {
    let f = collect_facts();
    let mut out = String::new();
    out.push_str("# DevHub 诊断报告\n\n");
    out.push_str(&format!("- 应用版本: {}\n", f.app_version));
    out.push_str(&format!("- 操作系统: {} ({})\n", f.os, f.arch));
    out.push_str(&format!(
        "- WebView2: {}（{}）\n",
        f.webview2.version.as_deref().unwrap_or("未检测到"),
        f.webview2.source
    ));
    out.push_str(&format!("- 配置文件: {}\n", f.config_path));
    out.push_str(&format!("- 窗口状态: {}\n", f.window_state_path));

    out.push_str("\n## 项目容器\n");
    for r in &f.roots {
        out.push_str(&format!("- {}（存在={}）\n", r.path, r.exists));
    }

    out.push_str("\n## Git\n");
    match &f.git_path {
        Some(path) => out.push_str(&format!("- 路径: {path}\n")),
        None => out.push_str("- 未找到 git（会触发 Git 引导）\n"),
    }

    out.push_str("\n## 设置健康\n");
    out.push_str(&format!("- 配置读取来源: {} ({})\n", f.settings.source, f.config_path));
    if let Some(err) = &f.settings.error {
        out.push_str(&format!("- 配置错误: {err}\n"));
    }
    out.push_str(&format!("- 配置备份: {}\n", f.settings.backup_path));
    out.push_str(&format!(
        "- GitHub Token: {}\n",
        match f.settings.token_state {
            "not_configured" => "未配置",
            "undecryptable" => "已存储但当前用户无法解密",
            _ => "已配置（值不写入报告）",
        }
    ));

    out.push_str("\n## 构建环境\n");
    out.push_str(&format!("- RUSTC_WRAPPER: {}\n", f.build.rustc_wrapper));
    out.push_str(&format!("- 内置 sccache: {}\n", f.build.vendored_sccache));

    out.push_str("\n## 仓库\n");
    out.push_str(&format!("- 已索引仓库数: {}\n", f.repo_count));

    out.push_str("\n## 落位卷\n");
    match &f.disk {
        Some(d) => out.push_str(&format!("- {}: 剩余 {} B / 共 {} B\n", d.path, d.available, d.total)),
        None => out.push_str("- 无法读取落位卷空间\n"),
    }

    out.push('\n');
    out
}

/// Machine-readable twin of the report. Pretty-printed so a human can still read
/// it, but stable key names make it scriptable.
pub(crate) fn build_diagnostics_json() -> Result<String, String> {
    serde_json::to_string_pretty(&collect_facts())
        .map(|mut s| {
            s.push('\n');
            s
        })
        .map_err(|e| format!("诊断 JSON 序列化失败: {e}"))
}

/// Write the diagnostics report the user picked.
///
/// `format` is optional and defaults to Markdown, so the existing palette action
/// (which sends only `path`) keeps its behaviour. Only `"json"` selects the other
/// format; an unknown value is a caller error rather than a silent Markdown file.
#[tauri::command]
pub async fn export_diagnostics(
    app: tauri::AppHandle,
    path: String,
    format: Option<String>,
) -> Result<String, String> {
    let json = match format.as_deref() {
        None | Some("") | Some("markdown") => false,
        Some("json") => true,
        Some(other) => return Err(format!("不支持的诊断格式：{other}")),
    };
    let report = if json {
        build_diagnostics_json()?
    } else {
        build_diagnostics_report()
    };
    let shown = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let target = path_guard::guard(&app, &path, path_guard::Access::Write)?;
        let shown = netpath::strip_verbatim(&target).display().to_string();
        write_atomic(&target, report.as_bytes()).map_err(|e| format!("写入诊断文件失败: {e}"))?;
        Ok(shown)
    })
    .await
    .map_err(|e| format!("导出任务异常: {e}"))??;
    record_activity(
        Log::new("settings", if json { "导出诊断报告（JSON）" } else { "导出诊断报告" }, SRC_RECORDS)
            .detail(&format!("写到 {shown}")),
    );
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::{build_diagnostics_json, build_diagnostics_report};

    #[test]
    fn report_contains_health_build_and_disk_sections_without_token_values() {
        let report = build_diagnostics_report();
        for heading in ["## 设置健康", "## 构建环境", "## 落位卷", "## 仓库"] {
            assert!(report.contains(heading), "missing {heading} in diagnostics report");
        }
        assert!(report.contains("GitHub Token:"), "token state line missing");
        assert!(!report.contains("Bearer "), "diagnostics must never carry an authorization value");
        assert!(!report.contains("ghp_"), "diagnostics must never carry a token-shaped value");
    }

    #[test]
    fn json_report_has_stable_keys_and_no_token_material() {
        let json = build_diagnostics_json().expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).expect("parse");
        for key in ["appVersion", "os", "arch", "configPath", "roots", "settings", "build", "repoCount"] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert!(value["settings"].get("tokenState").is_some(), "token state must be a closed identifier");
        assert!(!json.contains("Bearer "));
        assert!(!json.contains("ghp_"));
    }
}
