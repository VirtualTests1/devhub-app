//! Local secret-hygiene scan for one repository (r34-D7).
//!
//! ## Scope, stated before the patterns
//!
//! This scans the repository's own files for a small set of **high-signal**
//! credential shapes: provider tokens with distinctive prefixes, private-key
//! headers, and key/value assignments whose value passes an entropy floor. It is
//! not a replacement for a dedicated scanner (gitleaks/trufflehog) and it is not
//! a gate: false positives are expected, false negatives are certain for custom
//! formats. The UI words it as a prompt to look, not a verdict.
//!
//! ## Redaction is the contract
//!
//! A hit never carries the full secret. `preview` is first four + ellipsis + last
//! four for token shapes; the private-key kind carries only the header line. The
//! result is held in memory for the dialog's lifetime; it is never written to the
//! activity log, the config, or disk. A scanner that leaks the secret it found is
//! a worse bug than the secret.
//!
//! ## Bounds
//!
//! One repository, depth 8, files up to 1 MiB, 2 000 files, 100 hits, 10 s. Skips
//! `.git`/dependency/build directories and symlinks. Skipped/truncated counts are
//! reported rather than hidden, because "no hits" and "did not look" must not
//! share a result.

use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_FILES: usize = 2_000;
const MAX_HITS: usize = 100;
const MAX_MS: u128 = 10_000;
const MAX_DEPTH: usize = 8;
const BINARY_SNIFF: usize = 8192;
const ENTROPY_FLOOR: f64 = 3.2;

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", ".venv",
    "venv", "__pycache__", ".idea", ".vscode", ".worktrees",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretHit {
    pub file: String,
    pub line: usize,
    pub kind: String,
    /// Masked: the scanner must not leak what it found.
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretReport {
    pub slug: String,
    pub root: String,
    pub hits: Vec<SecretHit>,
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub truncated: bool,
    pub timed_out: bool,
    pub elapsed_ms: u128,
    pub error: Option<String>,
}

struct Patterns {
    fixed: Vec<(&'static str, Regex)>,
    generic: Regex,
}

fn patterns() -> Option<&'static Patterns> {
    static P: OnceLock<Option<Patterns>> = OnceLock::new();
    P.get_or_init(|| {
        let mut fixed = Vec::new();
        for (kind, source) in [
            ("github-token", r"(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})"),
            ("aws-access-key", r"AKIA[0-9A-Z]{16}"),
            ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            ("slack-token", r"xox[baprs]-[0-9A-Za-z-]{10,}"),
            ("stripe-live", r"sk_live_[0-9A-Za-z]{16,}"),
        ] {
            fixed.push((kind, Regex::new(source).ok()?));
        }
        let generic = Regex::new(
            r#"(?i)(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"]"#,
        )
        .ok()?;
        Some(Patterns { fixed, generic })
    })
    .as_ref()
}

/// Shannon entropy over bytes; the generic assignment rule only fires above the
/// floor, which is what keeps `password = "correct horse battery"` and obvious
/// placeholders out of the report.
fn entropy(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    for b in value.bytes() {
        counts[b as usize] += 1;
    }
    let len = value.len() as f64;
    counts
        .iter()
        .filter(|c| **c > 0)
        .map(|c| {
            let p = *c as f64 / len;
            -p * p.log2()
        })
        .sum()
}

fn placeholder(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    ["example", "placeholder", "changeme", "your_", "xxxx", "dummy", "test_"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn mask(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 8 {
        return "…".to_string();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}…{tail}")
}

/// Scan one line, returning hits. Pure except for the compiled pattern set.
fn scan_line(path: &str, line_no: usize, line: &str) -> Vec<SecretHit> {
    let Some(p) = patterns() else { return Vec::new() };
    let mut out = Vec::new();
    for (kind, re) in &p.fixed {
        for m in re.find_iter(line) {
            let preview = if *kind == "private-key" {
                m.as_str().to_string()
            } else {
                mask(m.as_str())
            };
            out.push(SecretHit {
                file: path.to_string(),
                line: line_no,
                kind: (*kind).to_string(),
                preview,
            });
        }
    }
    if let Some(caps) = p.generic.captures(line) {
        if let Some(value) = caps.get(1) {
            let secret = value.as_str();
            if !placeholder(secret) && entropy(secret) >= ENTROPY_FLOOR {
                out.push(SecretHit {
                    file: path.to_string(),
                    line: line_no,
                    kind: "generic-assignment".to_string(),
                    preview: mask(secret),
                });
            }
        }
    }
    out
}

fn scan_repo_blocking(slug: &str, root: &Path) -> SecretReport {
    let start = Instant::now();
    if patterns().is_none() {
        return SecretReport {
            slug: slug.to_string(),
            root: root.to_string_lossy().to_string(),
            hits: Vec::new(),
            files_scanned: 0,
            files_skipped: 0,
            truncated: false,
            timed_out: false,
            elapsed_ms: 0,
            error: Some("内置密钥规则无法编译".to_string()),
        };
    }
    let mut files_scanned = 0usize;
    let mut files_skipped = 0usize;
    let mut hits: Vec<SecretHit> = Vec::new();
    let mut timed_out = false;
    let mut truncated = false;

    let walk = walkdir::WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if crate::disk::is_reparse_point(e.path()) {
                return false;
            }
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && (SKIP_DIRS.contains(&name.as_ref()) || name.starts_with('.')))
        });

    for entry in walk.flatten() {
        if Instant::now().duration_since(start).as_millis() >= MAX_MS {
            timed_out = true;
            break;
        }
        if hits.len() >= MAX_HITS {
            truncated = true;
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if files_scanned + files_skipped >= MAX_FILES {
            truncated = true;
            break;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            files_skipped += 1;
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        files_scanned += 1;
        if bytes.iter().take(BINARY_SNIFF).any(|b| *b == 0) {
            files_skipped += 1;
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        for (idx, line) in text.lines().enumerate() {
            let line_hits = scan_line(&rel, idx + 1, line);
            if !line_hits.is_empty() {
                hits.extend(line_hits);
                if hits.len() >= MAX_HITS {
                    truncated = true;
                    break;
                }
            }
        }
    }

    SecretReport {
        slug: slug.to_string(),
        root: root.to_string_lossy().to_string(),
        hits,
        files_scanned,
        files_skipped,
        truncated,
        timed_out,
        elapsed_ms: start.elapsed().as_millis(),
        error: None,
    }
}

#[tauri::command]
pub async fn repo_secret_scan(slug: String) -> Result<SecretReport, String> {
    // Resolve from the container index, never from a page-supplied path: this
    // command reads file contents, so its inputs must be the same repository
    // identity every other card command uses.
    let root = crate::repo_index::find(&crate::project_roots(), &slug).0;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = root else {
            return SecretReport {
                slug,
                root: String::new(),
                hits: Vec::new(),
                files_scanned: 0,
                files_skipped: 0,
                truncated: false,
                timed_out: false,
                elapsed_ms: 0,
                error: Some("未找到仓库".to_string()),
            };
        };
        if !root.is_dir() {
            return SecretReport {
                slug,
                root: root.to_string_lossy().to_string(),
                hits: Vec::new(),
                files_scanned: 0,
                files_skipped: 0,
                truncated: false,
                timed_out: false,
                elapsed_ms: 0,
                error: Some("目录不存在".to_string()),
            };
        }
        scan_repo_blocking(&slug, &root)
    })
    .await
    .map_err(|e| format!("密钥扫描任务异常: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_shapes_are_found_and_never_returned_whole() {
        // Built at runtime so this source file does not itself look like a token
        // to GitHub's push protection.
        let token = format!("ghp_{}", "A".repeat(36));
        let hits = scan_line("src/x.ts", 3, &format!("const t = \"{token}\";"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "github-token");
        assert!(!hits[0].preview.contains(&token), "the full secret must not leave the scanner");
        assert!(hits[0].preview.contains('…'));
    }

    #[test]
    fn private_key_headers_are_reported_without_the_body() {
        let hits = scan_line("id_rsa", 1, "-----BEGIN OPENSSH PRIVATE KEY-----");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "private-key");
        assert_eq!(hits[0].preview, "-----BEGIN OPENSSH PRIVATE KEY-----");
    }

    #[test]
    fn a_placeholder_assignment_is_not_a_hit() {
        assert!(scan_line("a.ts", 1, r#"password = "example_password_123""#).is_empty());
        assert!(scan_line("a.ts", 1, r#"api_key = "your_api_key_here""#).is_empty());
    }

    #[test]
    fn a_high_entropy_assignment_is_a_generic_hit() {
        let value = "aB3dE5gH7jK9mN2pQ4sT6uV8";
        let hits = scan_line("a.ts", 1, &format!("api_key = \"{value}\""));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "generic-assignment");
        assert!(!hits[0].preview.contains(value));
    }

    #[test]
    fn entropy_is_what_separates_a_key_from_a_sentence() {
        assert!(entropy("aaaaaaaaaaaaaaaa") < ENTROPY_FLOOR);
        assert!(entropy("aB3dE5gH7jK9mN2pQ4sT6uV8") >= ENTROPY_FLOOR);
    }
}
