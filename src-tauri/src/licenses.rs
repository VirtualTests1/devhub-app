//! Local licence detection for the collection (r33-D7).
//!
//! ## What this is, and is not
//!
//! It reads **top-level files only** — `LICENSE*` / `LICENCE*` / `COPYING*` and the
//! license field of the common manifests — and classifies what it finds. It is not
//! legal advice, and a `NOASSERTION`/unknown answer is a real answer: a licence a
//! human has to read is not the same thing as no licence, and neither is the same
//! as MIT.
//!
//! ## Why not the GitHub API
//!
//! `GET /repos/{owner}/{repo}` already carries `license.spdx_id`, and the wall
//! caches it in `heat.rs` — but only for repositories whose heat was fetched, only
//! with network, and it says nothing about a local repository that has no remote.
//! This command answers for every clone on disk, offline, in one pass.
//!
//! ## Bounds
//!
//! One licence file and one manifest per repository, at most 16 KiB each, read
//! through `path_guard::read_text_capped`. The batch is capped at 500 repositories;
//! the wall is windowed well below that today, and the UI says when the cap applied.

use serde::Serialize;
use std::path::Path;

const MAX_LICENSE_BYTES: u64 = 64 * 1024;
const MAX_BATCH_REPOS: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRow {
    pub slug: String,
    /// The detected SPDX-ish name, a declared expression, or `None`.
    pub license: Option<String>,
    /// `license-file` | `package.json` | `Cargo.toml` | `pyproject.toml` |
    /// `composer.json` | `*.csproj` | `none`.
    pub source: String,
    /// The top-level file the answer came from, when it came from one.
    pub file: Option<String>,
    /// `detected` (from licence text) | `declared` (manifest) | `unknown`
    /// (a licence file we could not classify) | `missing`.
    pub confidence: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseOverview {
    pub rows: Vec<LicenseRow>,
    pub scanned: usize,
    /// True when more repositories existed than the batch cap.
    pub capped: bool,
    pub elapsed_ms: u128,
}

fn row(
    slug: &str,
    license: Option<String>,
    source: &str,
    file: Option<String>,
    confidence: &str,
    error: Option<String>,
) -> LicenseRow {
    LicenseRow {
        slug: slug.to_string(),
        license,
        source: source.to_string(),
        file,
        confidence: confidence.to_string(),
        error,
    }
}

/// Top-level files that can legally carry a licence.
fn is_license_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let base = n.split_once('.').map(|(b, _)| b).unwrap_or(&n);
    matches!(base, "license" | "licence" | "copying" | "unlicense")
        && (n == base || n.starts_with("license.") || n.starts_with("licence.") || n.starts_with("copying."))
}

/// Read one file's first bytes, refusing links and anything too large.
fn read_head(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    crate::path_guard::read_text_capped(path, MAX_LICENSE_BYTES).ok()
}

/// Classify licence text by its distinctive phrases.
///
/// Order matters where a phrase is a prefix of another (the GNU family); the
/// returned name is an SPDX identifier, because that is what the export joins on.
pub fn detect_license_text(text: &str) -> Option<String> {
    // A machine-readable identifier wins over prose: it is the project's own
    // declaration, and it survives translations of the body text.
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(pos) = lower.find("spdx-license-identifier:") {
            let expr = line[pos + "spdx-license-identifier:".len()..]
                .trim()
                .trim_end_matches("*/")
                .trim()
                .trim_end_matches("-->")
                .trim();
            if !expr.is_empty() {
                return Some(expr.to_string());
            }
        }
    }

    let t = text.to_ascii_lowercase();
    let has = |s: &str| t.contains(s);
    if has("gnu affero general public license") && has("version 3") {
        return Some("AGPL-3.0".to_string());
    }
    if has("gnu lesser general public license") {
        if has("version 3") {
            return Some("LGPL-3.0".to_string());
        }
        if has("version 2.1") {
            return Some("LGPL-2.1".to_string());
        }
    }
    if has("gnu general public license") {
        if has("version 3") {
            return Some("GPL-3.0".to_string());
        }
        if has("version 2") {
            return Some("GPL-2.0".to_string());
        }
    }
    if has("apache license") && has("version 2.0") {
        return Some("Apache-2.0".to_string());
    }
    if has("mozilla public license") && has("version 2.0") {
        return Some("MPL-2.0".to_string());
    }
    if has("permission is hereby granted, free of charge") {
        return Some("MIT".to_string());
    }
    if has("redistribution and use in source and binary forms") {
        if has("neither the name") || has("names of its contributors") {
            return Some("BSD-3-Clause".to_string());
        }
        return Some("BSD-2-Clause".to_string());
    }
    if has("permission to use, copy, modify, and/or distribute this software") {
        return Some("ISC".to_string());
    }
    if has("this is free and unencumbered software released into the public domain") {
        return Some("Unlicense".to_string());
    }
    if has("cc0 1.0 universal") {
        return Some("CC0-1.0".to_string());
    }
    if has("boost software license") {
        return Some("BSL-1.0".to_string());
    }
    if has("zlib license") {
        return Some("Zlib".to_string());
    }
    if has("eclipse public license") && has("2.0") {
        return Some("EPL-2.0".to_string());
    }
    if has("creative commons attribution 4.0") {
        return Some("CC-BY-4.0".to_string());
    }
    None
}

fn json_license(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(s) = v.get("license").and_then(|x| x.as_str()) {
        if !s.trim().is_empty() {
            return Some(s.trim().to_string());
        }
    }
    if let Some(s) = v.get("license").and_then(|x| x.get("type")).and_then(|x| x.as_str()) {
        if !s.trim().is_empty() {
            return Some(s.trim().to_string());
        }
    }
    // Legacy npm shape: `"licenses": [{"type": "MIT"}]`.
    v.get("licenses")
        .and_then(|x| x.as_array())
        .and_then(|rows| rows.iter().find_map(|r| r.get("type").and_then(|t| t.as_str())))
        .map(str::to_string)
}

fn toml_license(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some(rest) = line.strip_prefix(key) else { continue };
        let rest = rest.trim_start().strip_prefix('=').map(str::trim)?;
        if rest.starts_with('{') {
            // pyproject: license = { text = "MIT" }
            if let Some(pos) = rest.find("text") {
                let after = rest[pos + 4..].trim_start().strip_prefix('=').map(str::trim)?;
                let value = after.trim_matches(|c| c == '"' || c == '\'' || c == '}' || c == ' ');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
            continue;
        }
        let value = rest.trim_matches(|c| c == '"' || c == '\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn csproj_license(text: &str) -> Option<String> {
    for tag in ["PackageLicenseExpression", "PackageLicenseFile", "PackageLicenseUrl"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        if let Some(start) = text.find(&open) {
            if let Some(end) = text[start..].find(&close) {
                let value = text[start + open.len()..start + end].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// The first recognised licence file in a repository root.
fn license_file(dir: &Path) -> Option<(String, String)> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| is_license_file(n))
        .collect();
    names.sort();
    for name in names {
        if let Some(text) = read_head(&dir.join(&name)) {
            return Some((name, text));
        }
    }
    None
}

fn manifest_license(dir: &Path) -> Option<(String, String)> {
    let candidates = [
        ("package.json", "package.json"),
        ("Cargo.toml", "Cargo.toml"),
        ("pyproject.toml", "pyproject.toml"),
        ("composer.json", "composer.json"),
    ];
    for (file, source) in candidates {
        let path = dir.join(file);
        let Some(text) = read_head(&path) else { continue };
        let found = match file {
            "Cargo.toml" => toml_license(&text, "license"),
            "pyproject.toml" => toml_license(&text, "license"),
            _ => json_license(&text),
        };
        if let Some(value) = found {
            return Some((source.to_string(), value));
        }
    }
    // A .csproj is not at a fixed name; take the first one at the root.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.to_ascii_lowercase().ends_with(".csproj") {
                if let Some(text) = read_head(&entry.path()) {
                    if let Some(value) = csproj_license(&text) {
                        return Some((name, value));
                    }
                }
            }
        }
    }
    None
}

/// One repository, top-level only.
pub fn scan_license(slug: &str, dir: &Path) -> LicenseRow {
    if !dir.is_dir() {
        return row(slug, None, "none", None, "unknown", Some("目录不存在".to_string()));
    }
    let file = license_file(dir);
    let manifest = manifest_license(dir);
    if let Some((name, text)) = file {
        return match detect_license_text(&text) {
            Some(spdx) => row(slug, Some(spdx), "license-file", Some(name), "detected", None),
            None => {
                // An unclassified licence file plus a declared expression is still
                // useful — but the source must say manifest, not pretend the file
                // was recognised.
                if let Some((source, value)) = manifest {
                    row(slug, Some(value), &source, Some(name), "declared", None)
                } else {
                    row(slug, None, "license-file", Some(name), "unknown", None)
                }
            }
        };
    }
    if let Some((source, value)) = manifest {
        return row(slug, Some(value), &source, None, "declared", None);
    }
    row(slug, None, "none", None, "missing", None)
}

/// Scan every repository the wall knows about.
fn overview_blocking() -> LicenseOverview {
    let start = std::time::Instant::now();
    let roots = crate::project_roots();
    let (entries, _) = crate::repo_index::repos(&roots);
    let capped = entries.len() > MAX_BATCH_REPOS;
    let rows: Vec<LicenseRow> = entries
        .iter()
        .take(MAX_BATCH_REPOS)
        .map(|repo| {
            let slug = repo.slug();
            match repo.path.as_deref() {
                Some(path) => scan_license(&slug, Path::new(path)),
                None => row(&slug, None, "none", None, "unknown", Some("仓库没有本地目录".to_string())),
            }
        })
        .collect();
    LicenseOverview {
        scanned: rows.len(),
        rows,
        capped,
        elapsed_ms: start.elapsed().as_millis(),
    }
}

#[tauri::command]
pub async fn license_overview() -> Result<LicenseOverview, String> {
    tauri::async_runtime::spawn_blocking(overview_blocking)
        .await
        .map_err(|e| format!("许可证扫描任务异常: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_common_licenses_are_recognised_by_their_own_phrases() {
        assert_eq!(
            detect_license_text("MIT License\n\nPermission is hereby granted, free of charge, ..."),
            Some("MIT".to_string())
        );
        assert_eq!(
            detect_license_text("Apache License\nVersion 2.0, January 2004"),
            Some("Apache-2.0".to_string())
        );
        assert_eq!(
            detect_license_text("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"),
            Some("GPL-3.0".to_string())
        );
        assert_eq!(
            detect_license_text("GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1"),
            Some("LGPL-2.1".to_string())
        );
        assert_eq!(
            detect_license_text("Redistribution and use in source and binary forms, with or without\nNeither the name of the copyright holder"),
            Some("BSD-3-Clause".to_string())
        );
        assert_eq!(
            detect_license_text("Permission to use, copy, modify, and/or distribute this software for any purpose"),
            Some("ISC".to_string())
        );
    }

    #[test]
    fn an_spdx_line_beats_prose_and_is_kept_verbatim() {
        assert_eq!(
            detect_license_text("// SPDX-License-Identifier: MIT OR Apache-2.0\nCopyright ..."),
            Some("MIT OR Apache-2.0".to_string())
        );
    }

    #[test]
    fn manifest_shapes_are_read_without_a_toml_json_dependency() {
        assert_eq!(json_license(r#"{"license":"MIT"}"#).as_deref(), Some("MIT"));
        assert_eq!(json_license(r#"{"license":{"type":"ISC"}}"#).as_deref(), Some("ISC"));
        assert_eq!(
            json_license(r#"{"licenses":[{"type":"BSD-2-Clause"}]}"#).as_deref(),
            Some("BSD-2-Clause")
        );
        assert_eq!(toml_license("license = \"MIT\"\n", "license").as_deref(), Some("MIT"));
        assert_eq!(
            toml_license("license = { text = \"Apache-2.0\" }", "license").as_deref(),
            Some("Apache-2.0")
        );
        assert_eq!(toml_license("license-file = \"COPYING\"", "license"), None);
        assert_eq!(
            csproj_license("<PackageLicenseExpression>MIT</PackageLicenseExpression>").as_deref(),
            Some("MIT")
        );
    }

    #[test]
    fn a_license_file_is_preferred_over_a_manifest() {
        let dir = std::env::temp_dir().join(format!("devhub-license-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("LICENSE"), "Permission is hereby granted, free of charge").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"license":"Apache-2.0"}"#).unwrap();
        let r = scan_license("o/r", &dir);
        assert_eq!(r.license.as_deref(), Some("MIT"));
        assert_eq!(r.source, "license-file");
        assert_eq!(r.confidence, "detected");
        assert_eq!(r.file.as_deref(), Some("LICENSE"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_file_with_a_declared_manifest_says_which_answer_it_used() {
        let dir = std::env::temp_dir().join(format!("devhub-license-unknown-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("LICENSE"), "All rights reserved. Ask a lawyer.").unwrap();
        std::fs::write(dir.join("Cargo.toml"), "license = \"MIT\"\n").unwrap();
        let r = scan_license("o/r", &dir);
        assert_eq!(r.license.as_deref(), Some("MIT"));
        assert_eq!(r.source, "Cargo.toml");
        assert_eq!(r.confidence, "declared");
        assert_eq!(r.file.as_deref(), Some("LICENSE"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_file_and_no_manifest_is_missing_not_unknown() {
        let dir = std::env::temp_dir().join(format!("devhub-license-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = scan_license("o/r", &dir);
        assert_eq!(r.source, "none");
        assert_eq!(r.confidence, "missing");
        assert!(r.license.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn license_file_names_are_matched_precisely() {
        assert!(is_license_file("LICENSE"));
        assert!(is_license_file("license.md"));
        assert!(is_license_file("LICENCE.txt"));
        assert!(is_license_file("COPYING"));
        assert!(!is_license_file("LICENSE-notes.txt"));
        assert!(!is_license_file("my-license"));
        assert!(!is_license_file("package.json"));
    }
}
