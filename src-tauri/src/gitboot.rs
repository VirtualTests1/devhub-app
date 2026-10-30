//! Portable Git bootstrap.
//!
//! Goal: the app must work on a Windows machine that has no git installed, and
//! must not require the user to install anything by hand.
//!
//! Strategy (all steps measured on this machine):
//!   1. look for git on PATH, then for an already-bootstrapped copy
//!   2. resolve the newest git-for-windows release
//!   3. download PortableGit-<v>-64-bit.7z.exe (~57 MB, 4 MB/s measured)
//!   4. run it silently: `PortableGit.exe -o"<dir>" -y`
//!      (measured: exits 0 on its own, no GUI, ~165 s -> 391 MB extracted,
//!      yields a working `git version 2.56.0.windows.1`)
//!   5. verify the extracted binary by running `git --version`
//!   6. record provenance in a marker file
//!
//! Deliberately NOT attempted: stripping the SFX into a raw .7z with `-x`.
//! Probing the archive's own help triggered a GUI/hang, so only the documented
//! `-o`/`-y` switches are used.

use crate::downloader::{download_file, ProgressFn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Fallback when the release API cannot be reached. Kept in sync with the
/// version verified during development.
pub const FALLBACK_TAG: &str = "v2.56.0.windows.1";

/// What we need in order to fetch the archive.
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAsset {
    pub tag: String,
    pub name: String,
    pub browser_url: String,
    /// `https://api.github.com/.../releases/assets/<id>`; needs
    /// `Accept: application/octet-stream` and does not redirect, so it is a
    /// useful second path when the CDN redirect path is being reset.
    pub api_url: Option<String>,
    pub size: u64,
    /// `sha256:<hex>` from GitHub's release-asset `digest` field (r27-R3).
    /// `None` on older API responses and on the fallback construction; the
    /// installer then records that it could not verify, rather than claiming it did.
    pub digest: Option<String>,
}

/// Mirrors used if github.com itself is unreachable. Same prefix semantics as
/// the repository downloader: `<base><original-url>`.
///
/// NOTE (measured): these proxies do NOT reliably serve `/releases/download/`
/// paths — `gh-proxy.com` answered 404 and `ghfast.top` timed out, while only
/// `hk.gh-proxy.com` returned a redirect. Mirror handling is therefore kept as a
/// last resort here, not the primary path.
const MIRROR_BASES: &[&str] = &["https://hk.gh-proxy.com/", "https://gh-proxy.com/"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBootstrapMarker {
    pub tag: String,
    pub asset: String,
    pub bytes: u64,
    #[serde(default)]
    pub via_mirror: Option<String>,
    /// The digest the asset was checked against, when the API provided one.
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub digest_verified: bool,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapOutcome {
    pub git_path: String,
    pub version: String,
    pub tag: String,
    pub bytes: u64,
    pub via_mirror: Option<String>,
    /// Whether the downloaded archive matched GitHub's sha256 digest. False is
    /// not "corrupt": it means the API did not provide a digest to compare.
    pub digest_verified: bool,
    /// True when an existing installation was reused rather than downloaded.
    pub reused: bool,
}

/// `<runtime>/git/bin/git.exe` — the location the downloader also probes.
pub fn bundled_git_exe(runtime: &Path) -> PathBuf {
    runtime.join("git").join("bin").join("git.exe")
}

pub fn is_bootstrapped(runtime: &Path) -> bool {
    bundled_git_exe(runtime).is_file()
}

/// Reads the provenance marker written after a successful bootstrap.
pub fn read_marker(runtime: &Path) -> Option<GitBootstrapMarker> {
    let p = runtime.join("git-bootstrap.json");
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

/// Asks the release API for the newest release **and the real asset URL**.
///
/// We do not construct the asset file name ourselves: the tag (`v2.56.0.windows.1`)
/// and the asset name (`PortableGit-2.56.0-64-bit.7z.exe`) do not correspond
/// one-to-one, and building it from the tag produced a 404 during testing.
fn resolve_release() -> Option<ReleaseAsset> {
    let curl = which_curl()?;
    // `/releases/latest` works today (measured 200), but git-for-windows has
    // published pre-releases in the past, in which case that endpoint 404s.
    // The list endpoint is stable either way, so it is tried first.
    let endpoints = [
        "https://api.github.com/repos/git-for-windows/git/releases?per_page=5",
        "https://api.github.com/repos/git-for-windows/git/releases/latest",
    ];

    for ep in endpoints {
        let out = crate::proc::silent(&curl)
            .args([
                "-sS",
                "--no-progress-meter",
                "-L",
                "--max-time",
                "25",
                "-H",
                "Accept: application/vnd.github+json",
                ep,
            ])
            .output()
            .ok()?;
        if !out.status.success() {
            continue;
        }
        let body = String::from_utf8_lossy(&out.stdout);
        // Round 13 (d3-4): the asset-selection logic used to live inline behind
        // this network call and was therefore untestable. It is now
        // `parse_release_json`, a pure function with its own unit tests; a parse
        // or selection miss returns `None` and we fall through to the next
        // endpoint exactly as before.
        if let Some(asset) = parse_release_json(&body) {
            return Some(asset);
        }
    }
    None
}

/// Pure parser for a GitHub releases payload.
///
/// Picks the newest `PortableGit-*-64-bit.7z.exe` asset and returns its real
/// download URL. Handles both the list endpoint (a JSON array of releases) and
/// the `/latest` endpoint (a single release object), and tolerates a malformed
/// body, a release with no assets, or a release whose only assets are not the
/// portable archive — all of which return `None` so the caller can try the next
/// endpoint.
fn parse_release_json(body: &str) -> Option<ReleaseAsset> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let releases: Vec<&serde_json::Value> = match &json {
        serde_json::Value::Array(items) => items.iter().collect(),
        v @ serde_json::Value::Object(_) => vec![v],
        _ => return None,
    };
    for rel in releases {
        let tag = match rel.get("tag_name").and_then(|v| v.as_str()) {
            Some(t) => t.to_string(),
            None => continue,
        };
        let assets = match rel.get("assets").and_then(|v| v.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for a in assets {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            // Prefer the plain 64-bit portable archive.
            if !(name.starts_with("PortableGit") && name.ends_with("64-bit.7z.exe")) {
                continue;
            }
            let browser_url = a
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if browser_url.is_empty() {
                continue;
            }
            return Some(ReleaseAsset {
                tag,
                name: name.to_string(),
                browser_url,
                api_url: a.get("url").and_then(|v| v.as_str()).map(str::to_string),
                size: a.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                digest: a
                    .get("digest")
                    .and_then(|v| v.as_str())
                    .filter(|d| !d.trim().is_empty())
                    .map(str::to_string),
            });
        }
    }
    None
}

/// Last-resort construction when the API is unreachable. Kept because a
/// hard-coded pair is still better than failing outright.
fn fallback_release() -> ReleaseAsset {
    let tag = FALLBACK_TAG.to_string();
    let name = "PortableGit-2.56.0-64-bit.7z.exe".to_string();
    ReleaseAsset {
        browser_url: format!(
            "https://github.com/git-for-windows/git/releases/download/{tag}/{name}"
        ),
        tag,
        name,
        api_url: None,
        size: 0,
        digest: None,
    }
}

fn which_curl() -> Option<PathBuf> {
    if let Some(rt) = std::env::var_os("SystemRoot") {
        let p = PathBuf::from(rt).join("System32/curl.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join("curl.exe");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Normalizes GitHub's `sha256:<hex>` digest, or `None` for any other shape.
///
/// A malformed or non-sha256 digest is refused by [`verify_asset`] rather than
/// skipped: "we do not understand the integrity claim" is not the same as "there
/// was no claim", and only the latter may degrade to unverified.
fn parse_sha256_digest(raw: &str) -> Option<String> {
    let (algo, hex) = raw.trim().split_once(':')?;
    if !algo.eq_ignore_ascii_case("sha256") || hex.len() != 64 {
        return None;
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(hex.to_ascii_lowercase())
}

/// Streaming SHA-256 of a file. Chunked so a 57 MB archive does not become a
/// 57 MB allocation on a machine that is already extracting it.
fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| format!("无法打开待校验文件: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取待校验文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// `Ok(true)` = matched, `Ok(false)` = no digest to check, `Err` = mismatch or
/// malformed claim. The caller deletes the archive on `Err`.
fn verify_asset(path: &Path, digest: Option<&str>) -> Result<bool, String> {
    let Some(raw) = digest else {
        return Ok(false);
    };
    let want = parse_sha256_digest(raw)
        .ok_or_else(|| format!("无法解析 GitHub 提供的 digest：{raw}"))?;
    let got = sha256_file(path)?;
    if got != want {
        return Err(format!(
            "安装包 SHA-256 与 GitHub 记录不符：期望 {want}，实际 {got}"
        ));
    }
    Ok(true)
}

/// Runs the self-extracting archive silently.
///
/// `-o"<dir>"` sets the target, `-y` suppresses prompts. Measured: the process
/// terminates on its own and creates `<dir>/bin/git.exe`.
fn extract_silently(
    progress: ProgressFn,
    sfx: &Path,
    target: &Path,
    timeout_secs: u64,
) -> Result<(), String> {
    let mut cmd = crate::proc::silent(sfx);
    cmd.arg(format!("-o{}", target.display()))
        .arg("-y")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动自解压程序: {e}"))?;

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    progress(
                        "git-bootstrap",
                        &format!("解压完成，用时 {} 秒", started.elapsed().as_secs()),
                    );
                    return Ok(());
                }
                return Err(format!("自解压程序退出码 {:?}", status.code()));
            }
            Ok(None) => {
                if started.elapsed().as_secs() > timeout_secs {
                    let _ = child.kill();
                    // Kill without wait leaves the child a zombie with its handle
                    // still open. Every other kill in this crate pairs the two
                    // (`downloader.rs`'s pull/ls-remote deadlines, `proc.rs`, and now
                    // the exit policy in `lib.rs`), so this was an oversight rather
                    // than a choice.
                    let _ = child.wait();
                    return Err(format!("自解压超时（超过 {timeout_secs} 秒）"));
                }
                if started.elapsed().as_secs().is_multiple_of(15) {
                    progress(
                        "git-bootstrap",
                        &format!("解压中… 已用 {} 秒", started.elapsed().as_secs()),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => {
                // The pairing rule the timeout branch's comment declares applies
                // here too: `try_wait` erroring does not reap the child, so the
                // only difference from the timeout path is *why* we stopped
                // asking. Kill and wait before reporting.
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待自解压进程失败: {e}"));
            }
        }
    }
}

fn verify_git(exe: &Path) -> Option<String> {
    // Bounded like every other probe: a wedged `git --version` degrades to
    // "not usable" instead of holding the bootstrap check hostage.
    let mut cmd = crate::proc::silent(exe);
    cmd.arg("--version");
    let out = crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT).ok()??;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// ISO 8601 UTC timestamp. `format!("{:?}", SystemTime::now())` produces
/// `SystemTime { intervals: ... }`, which is unreadable in the marker file.
fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Ensures a usable git exists, downloading a portable copy when necessary.
///
/// Returns the outcome; `reused` is true when nothing had to be downloaded.
pub fn ensure_portable_git(
    progress: ProgressFn,
    runtime: &Path,
    timeout_secs: u64,
) -> Result<BootstrapOutcome, String> {
    let target_git = bundled_git_exe(runtime);
    let git_dir = runtime.join("git");

    // Already present and working: reuse it.
    if target_git.is_file() {
        if let Some(version) = verify_git(&target_git) {
            progress("git-bootstrap", &format!("已存在内置 Git：{version}"));
            let marker = read_marker(runtime);
            return Ok(BootstrapOutcome {
                git_path: target_git.to_string_lossy().to_string(),
                version,
                tag: marker.as_ref().map(|m| m.tag.clone()).unwrap_or_default(),
                bytes: marker.as_ref().map(|m| m.bytes).unwrap_or(0),
                via_mirror: marker.as_ref().and_then(|m| m.via_mirror.clone()),
                digest_verified: marker.as_ref().map(|m| m.digest_verified).unwrap_or(false),
                reused: true,
            });
        }
        // Present but broken: start over rather than trusting it.
        progress("git-bootstrap", "检测到内置 Git 不可用，将重新安装");
        let _ = std::fs::remove_dir_all(&git_dir);
    }

    std::fs::create_dir_all(runtime).map_err(|e| format!("无法创建 {}: {e}", runtime.display()))?;

    progress("git-bootstrap", "查询 git-for-windows 最新版本与资源地址…");
    let asset = resolve_release().unwrap_or_else(|| {
        progress(
            "git-bootstrap",
            &format!("无法访问 release API，改用已知可用版本 {FALLBACK_TAG}"),
        );
        fallback_release()
    });
    progress(
        "git-bootstrap",
        &format!(
            "将安装 {}（{}，{} MB）",
            asset.name,
            asset.tag,
            asset.size / (1024 * 1024)
        ),
    );

    // Download to a temp file first so an interrupted run cannot leave a
    // half-extracted install behind.
    let staging = runtime.join("_bootstrap");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("无法创建暂存目录: {e}"))?;
    let sfx = staging.join(&asset.name);

    // An operator may pre-place the archive (offline install, internal mirror,
    // or to avoid re-downloading during testing). This is also what makes the
    // post-download half of the bootstrap testable without a network round trip.
    let preplaced = std::env::var_os("DEVHUB_GIT_ASSET").map(PathBuf::from);

    // Candidate sources, in order. The API asset endpoint is included because it
    // serves bytes directly without the CDN redirect that is the step most prone
    // to resets here (measured: the browser URL was reset mid-transfer while the
    // API endpoint is a single stable request).
    let mut candidates: Vec<(String, Option<String>, Option<&'static str>)> =
        vec![(asset.browser_url.clone(), None, None)];
    if let Some(api) = &asset.api_url {
        candidates.push((api.clone(), None, Some("application/octet-stream")));
    }
    for base in MIRROR_BASES {
        candidates.push((
            format!("{base}{}", asset.browser_url),
            Some((*base).to_string()),
            None,
        ));
    }

    let mut last_err = String::new();
    let mut bytes = 0u64;
    let mut via_mirror: Option<String> = None;
    let mut downloaded = false;

    if let Some(src) = preplaced.filter(|p| p.is_file()) {
        let n = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        progress(
            "git-bootstrap",
            &format!("使用预置安装包 {}（{} 字节）", src.display(), n),
        );
        std::fs::copy(&src, &sfx).map_err(|e| format!("无法复制预置安装包: {e}"))?;
        bytes = n;
        via_mirror = Some("preplaced".to_string());
        downloaded = true;
    }

    for (url, mirror, accept) in &candidates {
        if downloaded {
            break;
        }
        progress("git-bootstrap", &format!("尝试下载：{url}"));
        match download_file(progress.clone(), url, &sfx, "git-bootstrap", *accept) {
            Ok(n) => {
                // A real PortableGit archive is tens of MB; anything tiny is an
                // error page that curl still wrote successfully.
                if n < 20 * 1024 * 1024 {
                    last_err = format!("{url} 返回的文件过小（{n} 字节），疑似错误页");
                    progress("git-bootstrap", &last_err);
                    continue;
                }
                bytes = n;
                via_mirror = mirror.clone();
                downloaded = true;
                break;
            }
            Err(e) => {
                last_err = format!("{url} -> {e}");
                progress("git-bootstrap", &last_err);
            }
        }
    }

    if !downloaded {
        return Err(format!("便携版 Git 下载失败。最后一次错误：{last_err}"));
    }

    // Integrity before execution: the self-extractor is a program, and the API
    // response that named its URL is the only place a correct hash can come from.
    let digest_verified = match verify_asset(&sfx, asset.digest.as_deref()) {
        Ok(true) => {
            progress("git-bootstrap", "安装包 SHA-256 与 GitHub release digest 一致");
            true
        }
        Ok(false) => {
            progress(
                "git-bootstrap",
                "GitHub release 未提供 sha256 digest，本次无法做哈希校验（安装包仍会用 git --version 验证）",
            );
            false
        }
        Err(e) => {
            // Never leave a file that failed verification on disk for the next
            // run to trust.
            std::fs::remove_file(&sfx).ok();
            return Err(format!("安装包完整性校验失败：{e}"));
        }
    };
    if let Some(m) = &via_mirror {
        if m != "preplaced" {
            // Only say this for a real third-party mirror; a pre-placed local
            // archive is not third-party and the message would be misleading.
            progress(
                "git-bootstrap",
                &format!("注意：安装包经由第三方镜像 {m} 下载"),
            );
        }
    }

    // Extract into staging, then move into place so a failure never leaves a
    // partially installed git.
    let staging_git = staging.join("git");
    let _ = std::fs::remove_dir_all(&staging_git);
    progress(
        "git-bootstrap",
        "正在静默解压（约 400 MB，这一步实测需要 2–3 分钟）…",
    );
    extract_silently(progress.clone(), &sfx, &staging_git, timeout_secs)?;

    let staged_git_exe = staging_git.join("bin").join("git.exe");
    let version =
        verify_git(&staged_git_exe).ok_or_else(|| "解压完成但 git.exe 无法运行".to_string())?;

    // Swap, rather than delete-then-move. The previous order was
    // `remove_dir_all(&git_dir)` followed by `rename`: it destroyed the working
    // bundled Git *before* the new one was in place, so a failed rename — an AV
    // scan or a process still holding `git.exe`, the ordinary reason on Windows —
    // left the app with no bundled Git at all, and the 57 MB archive was deleted
    // moments later, so the next start had to download the whole thing again.
    let previous = runtime.join("git.previous");
    let _ = std::fs::remove_dir_all(&previous);
    let had_previous = git_dir.exists();
    if had_previous {
        std::fs::rename(&git_dir, &previous)
            .map_err(|e| format!("无法把现有内置 Git 暂存到 {}: {e}", previous.display()))?;
    }
    if let Err(e) = std::fs::rename(&staging_git, &git_dir) {
        if had_previous {
            // Best effort, but it is the whole point of this branch: the user
            // keeps a working Git even when the new one cannot take its place.
            let _ = std::fs::rename(&previous, &git_dir);
        }
        return Err(format!("无法将内置 Git 移动到最终位置: {e}"));
    }
    let _ = std::fs::remove_dir_all(&previous);

    let marker = GitBootstrapMarker {
        tag: asset.tag.clone(),
        asset: asset.name.clone(),
        bytes,
        via_mirror: via_mirror.clone(),
        digest: asset.digest.clone(),
        digest_verified,
        installed_at: now_iso8601(),
    };
    // Atomic like every other whole-file rewrite here: this marker is what makes
    // the next start skip a 57 MB re-download, so a truncated copy of it costs the
    // user another download on the next launch.
    let _ = crate::write_atomic(
        &runtime.join("git-bootstrap.json"),
        serde_json::to_string_pretty(&marker)
            .unwrap_or_default()
            .as_bytes(),
    );

    // The archive is 57 MB and no longer needed.
    let _ = std::fs::remove_dir_all(&staging);

    let outcome = BootstrapOutcome {
        git_path: bundled_git_exe(runtime).to_string_lossy().to_string(),
        version,
        tag: asset.tag.clone(),
        bytes,
        via_mirror,
        digest_verified,
        reused: false,
    };
    progress(
        "git-bootstrap",
        &format!("内置 Git 就绪：{}", outcome.version),
    );
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_path_is_where_the_downloader_looks() {
        let rt = Path::new("R");
        let p = bundled_git_exe(rt);
        assert!(
            p.ends_with("git/bin/git.exe") || p.ends_with("git\\bin\\git.exe"),
            "unexpected bundled path: {}",
            p.display()
        );
    }

    // Round 13 (d3-4): `parse_release_json` is the asset-selection logic that
    // used to sit behind a live network call. These pin the "prefer the plain
    // 64-bit portable archive" rule and the array/single-object JSON shapes
    // without touching the network.
    #[test]
    fn parse_release_json_picks_the_64_bit_portable_asset() {
        let body = r#"[
          {
            "tag_name": "v2.56.0.windows.1",
            "assets": [
              {"name": "Git-2.56.0-64-bit.exe", "browser_download_url": "https://x/Git.exe", "size": 1},
              {"name": "PortableGit-2.56.0-64-bit.7z.exe", "browser_download_url": "https://x/Portable.7z", "size": 2, "url": "https://api/asset/9", "digest": "sha256:4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80"}
            ]
          }
        ]"#;
        let a = parse_release_json(body).expect("must find the portable asset");
        assert_eq!(a.name, "PortableGit-2.56.0-64-bit.7z.exe");
        assert_eq!(a.tag, "v2.56.0.windows.1");
        assert_eq!(a.size, 2);
        assert_eq!(a.api_url.as_deref(), Some("https://api/asset/9"));
        assert_eq!(
            a.digest.as_deref(),
            Some("sha256:4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80")
        );
    }

    #[test]
    fn parse_release_json_accepts_a_single_release_object() {
        // The `/latest` endpoint returns one object, not an array.
        let body = r#"{"tag_name":"v2.55.0.windows.1","assets":[{"name":"PortableGit-2.55.0-64-bit.7z.exe","browser_download_url":"https://x/p.7z","size":3}]}"#;
        let a = parse_release_json(body).expect("single release object");
        assert_eq!(a.tag, "v2.55.0.windows.1");
    }

    #[test]
    fn digest_verification_matches_sha256_and_refuses_mismatch() {
        let dir = std::env::temp_dir().join(format!("devhub-digest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("asset.bin");
        std::fs::write(&file, b"hello").unwrap();
        let good = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

        assert_eq!(parse_sha256_digest(good).as_deref(), Some(&good[7..]));
        assert_eq!(
            parse_sha256_digest("SHA256:2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824")
                .as_deref(),
            Some(&good[7..])
        );
        assert_eq!(verify_asset(&file, Some(good)), Ok(true));
        assert_eq!(verify_asset(&file, None), Ok(false), "no claim is not a failure");

        let wrong = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        assert!(verify_asset(&file, Some(wrong)).is_err(), "a mismatch must be fatal");
        assert!(verify_asset(&file, Some("md5:abc")).is_err(), "unknown algorithms are refused");
        assert!(parse_sha256_digest("sha256:not-hex").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_release_json_rejects_non_portable_assets() {
        // Only the plain 64-bit portable archive qualifies; a bare Git installer
        // must not be selected.
        let body = r#"[{"tag_name":"v2.56.0.windows.1","assets":[{"name":"Git-2.56.0-64-bit.exe","browser_download_url":"https://x/g.exe","size":1}]}]"#;
        assert!(
            parse_release_json(body).is_none(),
            "only the portable archive qualifies"
        );
    }

    #[test]
    fn parse_release_json_handles_malformed_and_empty() {
        assert!(parse_release_json("not json").is_none());
        assert!(parse_release_json("{}").is_none());
        assert!(parse_release_json("[]").is_none());
    }

    #[test]
    fn fallback_release_is_self_consistent() {
        let r = fallback_release();
        // The tag and the asset name do NOT correspond one-to-one in the real
        // release (`v2.56.0.windows.1` vs `PortableGit-2.56.0-...`), which is
        // exactly why the API is queried instead of constructing the name.
        assert_eq!(r.tag, FALLBACK_TAG);
        assert!(r.name.starts_with("PortableGit-"));
        assert!(r.name.ends_with("64-bit.7z.exe"));
        assert!(
            r.browser_url.contains(&r.tag) && r.browser_url.ends_with(&r.name),
            "fallback url must contain both tag and asset name: {}",
            r.browser_url
        );
    }

    #[test]
    fn is_bootstrapped_is_false_for_an_empty_dir() {
        let tmp = std::env::temp_dir().join("devhub-gitboot-test-empty");
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::create_dir_all(&tmp);
        assert!(!is_bootstrapped(&tmp));
        assert!(read_marker(&tmp).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
