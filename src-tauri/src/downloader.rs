//! Four-layer resilient downloader for GitHub repositories.
//!
//! Why four layers: on mainland-China networks, github.com access is
//! *intermittently* unstable (measured: 8/8 direct `git clone` successes in one
//! run, timeouts minutes earlier). A single-path downloader fails randomly.
//!
//! Layer order, each with its own failure mode:
//!   1. Direct                  - system git + system DNS
//!   2. IP-pinned               - public DNS resolves the IP, git keeps the real
//!                                hostname + SNI, so certificate validation STAYS ON
//!   3. Local proxy             - auto-discovered (e.g. Watt Toolkit on 26501)
//!   4. Mirror                  - user-replaceable, always announced in the UI
//!
//! SECURITY INVARIANTS (do not weaken these):
//!   * We never pass `-c http.sslverify=false`. Layer 2 keeps SNI and full
//!     certificate validation by keeping the real hostname in the URL; only the
//!     DNS resolution is overridden. (Verified: using a *fake* hostname with
//!     curloptResolve fails with SEC_E_WRONG_PRINCIPAL, which proves the
//!     certificate is still being checked.)
//!   * Proxy settings are passed per-invocation with `-c`, never written to the
//!     user's global `git config`.
//!   * Layer 2 only pins an IP when independent resolvers agree on it.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Public types (mirrored in TypeScript)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// Set for local repositories: the path (or file:// URL) to clone from.
    /// No DNS pinning or mirror layer applies to these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
    /// Absolute directory this repository occupies, when it is already on disk.
    /// `None` for a ref that has only been parsed. The 项目墙 can show it, and
    /// the 记录 view needs it to say which path an operation touched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl RepoRef {
    /// `host/owner/repo` - the canonical slug used for markers and port keys.
    pub fn slug(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.repo)
    }
    /// The directory name used on disk: `<repo>_<owner>`.
    ///
    /// 0.2.0 used `code/<host>/<owner>/<repo>`, so a download landed in
    /// `项目/code/github.com/joeseesun/opus-video-prompts`: four levels deep for
    /// one repository, with the host as pure noise in the common case. The
    /// flattened name keeps the owner in the name, so two repositories called
    /// `utils` cannot collide.
    pub fn dir_name(&self) -> String {
        let repo = sanitize_component(&self.repo);
        let owner = sanitize_component(&self.owner);
        if owner.is_empty() {
            repo
        } else {
            format!("{repo}_{owner}")
        }
    }
    /// The URL handed to git. Local repositories keep their own path.
    pub fn https_url(&self) -> String {
        if let Some(local) = &self.local {
            // Must be a file:// URL. git parses a bare `D:\path` as the scp-like
            // `host:path` form and fails with "hostname contains invalid
            // characters" (observed).
            if local.contains("://") {
                return local.clone();
            }
            return format!("file:///{}", local.replace('\\', "/"));
        }
        format!("https://{}/{}/{}.git", self.host, self.owner, self.repo)
    }
    pub fn is_local(&self) -> bool {
        self.local.is_some()
    }
}

/// Standard base64 (RFC 4648, with padding), used only for GitHub's HTTP
/// Basic credential. Hand-rolled because the alternative is a new direct
/// dependency for 20 lines; the encoder is pinned by the RFC 4648 vectors in
/// this module's tests.
pub(crate) fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The `http.<url>.extraHeader` entry that authenticates a **direct**
/// `https://github.com/` transcript, or `None` when the token does not apply.
///
/// Why not the URL userinfo the app used until r27: `git clone` writes the URL
/// it was given into `.git/config`, so `https://x-access-token:<token>@...`
/// left a plaintext PAT in every private clone. Measured on 2026-10-28 with a
/// local dumb-HTTP repository: the token was still in `remote.origin.url`
/// after the clone. A per-invocation header (passed via `GIT_CONFIG_*`
/// environment variables, never argv and never written to config) authenticates
/// the same request without persisting anything.
///
/// The returned key is scoped to `https://github.com/` so Git refuses to send
/// the header to any other host. That matters most for the mirror layer: a
/// bare-host mirror rewrites a github.com URL through `url.<base>.insteadOf`,
/// and an unscoped `http.extraHeader` would then deliver the token to that
/// third party. Callers therefore must not ask for this entry on the mirror
/// layer at all.
pub fn github_auth_cfg(url: &str, token: &str) -> Option<(&'static str, String)> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    // The prefix check also rejects userinfo: `https://user@github.com/…`
    // continues with `@`, not `/`.
    if !lower.starts_with("https://github.com/") {
        return None;
    }
    let encoded = base64_encode(format!("x-access-token:{token}").as_bytes());
    Some((
        "http.https://github.com/.extraHeader",
        format!("Authorization: Basic {encoded}"),
    ))
}

/// Applies one config entry through Git's environment-config channel.
///
/// `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` exist so a
/// caller can pass configuration without `-c` (argv, visible in a process list)
/// or a file (persisted). Verified against Git 2.51.0 with a scoped
/// `http.<url>.extraHeader`: the header arrived on every request and the
/// cloned `.git/config` contained no token.
fn apply_git_auth(cmd: &mut std::process::Command, auth: Option<(&str, &str)>) {
    if let Some((key, value)) = auth {
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", key)
            .env("GIT_CONFIG_VALUE_0", value);
    }
}

/// The same URL with a DevHub-written credential removed, or `None` when the
/// URL is not that shape.
///
/// Restricted to `http(s)://github.com/…` and to userinfo DevHub itself could
/// have written (`x-access-token`, or a `ghp_`/`github_pat_`-family password).
/// A user's own credential for a private mirror is not ours to delete.
pub fn url_without_devhub_credentials(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let at = rest.find('@')?;
    let userinfo = &rest[..at];
    let host_and_path = &rest[at + 1..];
    let host = host_and_path.split('/').next().unwrap_or("");
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let mut parts = userinfo.splitn(2, ':');
    let user = parts.next().unwrap_or("");
    let password = parts.next().unwrap_or("");
    let token_like = user.eq_ignore_ascii_case("x-access-token")
        || ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]
            .iter()
            .any(|p| password.starts_with(p));
    if !token_like {
        return None;
    }
    Some(format!("{scheme}://{host_and_path}"))
}

/// Rewrites a legacy token-bearing `origin` URL in an existing clone.
///
/// Returns the clean URL when a rewrite happened, `None` when there was
/// nothing to do, and an error when `git remote set-url` failed. Idempotent:
/// the second call sees a clean URL and does nothing.
pub fn scrub_origin_credentials(
    git: &Path,
    repo: &Path,
) -> Result<Option<String>, String> {
    let Some(url) = remote_origin_url(git, repo) else {
        return Ok(None);
    };
    let Some(clean) = url_without_devhub_credentials(&url) else {
        return Ok(None);
    };
    let out = git_cmd(git)
        .arg("-C")
        .arg(repo)
        .arg("remote")
        .arg("set-url")
        .arg("origin")
        .arg(&clean)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("无法启动 git: {e}"))?;
    if !out.status.success() {
        return Err(truncate(
            &redact_secrets(&crate::proc::decode_console(&out.stderr)),
            300,
        ));
    }
    Ok(Some(clean))
}

/// Makes one path component safe to use as a Windows directory name.
///
/// GitHub names are already well behaved, but a *local* repository takes its
/// owner from the parent directory name, which can contain anything.
fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows forbids a component ending in a dot or a space.
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    // …and a component whose *stem* is a device name, with or without an
    // extension, in any case. `CON` is a real owner name on GitHub; before this,
    // a repository under it produced a directory Windows refuses to create, and
    // the user saw an opaque clone error several layers away from the cause.
    // Prefixing rather than failing keeps the download working and the name close.
    if is_reserved_device_name(&trimmed) {
        format!("_{trimmed}")
    } else {
        trimmed
    }
}

/// Windows' reserved device names: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
/// `LPT1`–`LPT9`.
fn is_reserved_device_name(s: &str) -> bool {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    RESERVED.contains(&stem.as_str())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadLayer {
    Direct,
    IpPinned,
    LocalProxy,
    Mirror,
    Bundle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub layer: DownloadLayer,
    pub label: String,
    pub ok: bool,
    pub detail: String,
    pub ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub layer: DownloadLayer,
    pub path: String,
    pub attempts: Vec<AttemptRecord>,
    /// True when the result came from an archive instead of git, meaning there
    /// is no history and worktrees are unavailable. The UI must say so.
    pub degraded: bool,
    /// True when third-party infrastructure carried the code. The UI must say so.
    pub via_third_party: bool,
    /// Post-clone integrity warnings (r30-R1): LFS pointers left on disk,
    /// submodules declared but not initialised, or an LFS scan that could not
    /// finish. Not a failure — the repository is usable and the UI shows them
    /// as warnings beside the success.
    #[serde(default)]
    pub hazards: crate::clone_hazards::CloneHazards,
}

/// What one 更新 (`git pull --ff-only`) accomplished.
///
/// Separate from [`DownloadOutcome`] because an update changes an existing
/// clone: the interesting numbers are the HEAD before and after, not a landing
/// path. `commits` is `None` when git could not count them (a shallow or
/// grafted history), and the UI must not print "0 个新提交" for that.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub layer: DownloadLayer,
    pub path: String,
    /// HEAD before the pull, shortened for display.
    pub before: String,
    /// HEAD after the pull.
    pub after: String,
    pub commits: Option<u32>,
    pub via_third_party: bool,
    pub attempts: Vec<AttemptRecord>,
    /// Up to 20 new commits (`short hash` + subject), oldest…newest as git log
    /// prints them. Empty when HEAD did not move or git could not read the log;
    /// the UI must not turn that into "no changes".
    #[serde(default)]
    pub recent: Vec<CommitSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub subject: String,
}

/// A reserved run of ports for one repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBlock {
    pub base: u16,
    /// Named assignments inside the block, e.g. ("http", 20000).
    pub services: Vec<(String, u16)>,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct DownloaderConfig {
    /// Where repositories live. Default is `<install parent>\项目\`, resolved by
    /// the caller; the downloader only needs the concrete path.
    pub project_root: PathBuf,
    pub mirrors: Vec<String>,
    /// Extra local proxy candidates, tried after the built-in list.
    pub extra_proxies: Vec<String>,
    pub allow_ip_pin: bool,
    pub allow_third_party: bool,
    /// Which link mode the ladder starts from: `auto` | `bypass` | `useHosts`
    /// (empty = auto). Only the STARTING layer changes: auto skips a doomed
    /// direct dial when hosts is hijacked and the accelerator is not
    /// answering; bypass always does when IP-pinning is available. The rest of
    /// the ladder keeps its order.
    pub route: String,
    /// `full` (default, also what an empty or unrecognised value means) | `shallow` |
    /// `blobless`. Round 16 R1-3; `docs/clone-strategy.md` records why the default is
    /// `full` and why a non-default value is never allowed to report itself as a
    /// success without a probe behind it.
    pub clone_strategy: String,
    /// GitHub personal access token for cloning private repositories.
    ///
    /// Empty when the user has not configured one. When set and the URL points at
    /// `https://github.com/`, [`github_auth_cfg`] supplies a per-invocation,
    /// host-scoped `Authorization: Basic` header through Git's `GIT_CONFIG_*`
    /// environment channel. It is therefore never part of a URL, never written
    /// to `.git/config`, and never on a mirror layer's request.
    pub github_token: String,
}

impl Default for DownloaderConfig {
    fn default() -> Self {
        Self {
            project_root: PathBuf::from("project"),
            mirrors: default_mirrors(),
            extra_proxies: Vec::new(),
            allow_ip_pin: true,
            allow_third_party: false,
            route: "auto".to_string(),
            clone_strategy: String::new(),
            github_token: String::new(),
        }
    }
}

/// Public git mirrors. Verified reachable at build time, but third-party and
/// therefore NOT trusted by default (`allow_third_party` starts false).
fn default_mirrors() -> Vec<String> {
    vec![
        "https://gh-proxy.com/".to_string(),
        "https://hk.gh-proxy.com/".to_string(),
    ]
}

/// Local proxy ports commonly used by accelerators on Windows.
/// 26501 is the documented Watt Toolkit GitHub-acceleration port; 7890/7897 are
/// Clash defaults. Discovery is a plain TCP connect, nothing is modified.
const PROXY_CANDIDATES: &[u16] = &[26501, 26502, 7890, 7897, 10809, 10808, 1080, 2080];

/// Public resolvers queried to cross-check an IP before pinning it.
// Two independent operators per region: the cross-check must still be able to
// find an agreement on networks where one provider's resolver is blocked
// (measured here: 1.1.1.1 times out, 223.5.5.5 and 119.29.29.29 both answer).
const PUBLIC_DNS: &[&str] = &["1.1.1.1", "8.8.8.8", "223.5.5.5", "119.29.29.29"];

// ---------------------------------------------------------------------------
// Port pool
// ---------------------------------------------------------------------------

/// Reserved range for per-repository port blocks. Chosen above the common
/// ephemeral/dev range and below the dynamic Windows range to avoid collisions.
const POOL_LOW: u16 = 20000;
const POOL_HIGH: u16 = 29999;
/// Each repository gets this many consecutive ports.
const BLOCK_SIZE: u16 = 10;
/// Names assigned inside every block, in order.
const RESERVED_SERVICES: &[&str] = &[
    "http", "https", "api", "web", "admin", "db", "redis", "ws", "metrics", "extra",
];
/// Ports Windows itself may hold; never allocate over them.
const SYSTEM_PORTS: &[u16] = &[135, 139, 445, 5040];

/// Port blocks handed out during this process's lifetime.
///
/// `allocate()` decides what is taken by reading each repository's
/// `.devhub.json`, but that marker is only written at the **end** of a clone.
/// With one download at a time that never mattered; with parallel downloads two
/// clones both scanned an empty directory, both picked the same `port_base`, and
/// the second marker overwrote the first's claim — so two projects could be
/// configured to share a port block and then fight over it at launch. This set
/// is the in-flight reservation the filesystem cannot provide.
///
/// Entries are released when the download call that reserved them returns
/// ([`release_blocks`]): the reservation only has to cover the window before
/// `.devhub.json` exists, because after that the marker on disk is the claim and
/// `allocate` scans it. The comment below is why the table exists at all.
static ALLOCATED_BASES: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());

/// Reserves one block for an in-flight download. `false` means the table could not
/// be locked, so the caller holds no reservation and has nothing to give back.
fn claim_block(base: u16) -> bool {
    match ALLOCATED_BASES.lock() {
        Ok(mut g) => {
            g.push(base);
            true
        }
        Err(_) => false,
    }
}

/// Returns blocks to the pool once their download call is over, and reports how many
/// were actually still held.
///
/// Not releasing them was a documented trade-off ("harmless inside a 1000-port
/// pool"), and for one clone it is. But `allocate()` reserves *before* attempting
/// the transfer, so every failed attempt — a wrong name, a refused mirror, a clone
/// that hit [`CLONE_TIMEOUT`] — burned a segment for the life of the process, and
/// the pool is only ~1000 segments. A long-lived session that retries a typo a few
/// hundred times ends with every port physically free and the answer being
/// "范围内没有可用的端口段".
fn release_blocks(bases: &[u16]) -> usize {
    if bases.is_empty() {
        return 0;
    }
    match ALLOCATED_BASES.lock() {
        Ok(mut g) => {
            let before = g.len();
            for b in bases {
                g.retain(|x| *x != *b);
            }
            before - g.len()
        }
        Err(_) => 0,
    }
}

/// Currently listening TCP ports, used to avoid handing out a busy port.
/// Returns empty on failure rather than aborting allocation.
fn ports_in_use() -> Vec<u16> {
    // Bounded. `allocate()`/`claim_port_block` call this on every download and
    // every port reuse, so an unbounded `.output()` on a wedged TCP stack used to
    // be able to park the whole queue indefinitely. `output_timeout` also drains
    // the pipes on threads, which matters here: `netstat -ano -p TCP` on a busy
    // machine is far past the ~64 KiB pipe buffer.
    let mut cmd = crate::proc::silent("netstat");
    cmd.args(["-ano", "-p", "TCP"]);
    let out = match crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT) {
        Ok(Some(o)) => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut ports = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        // e.g. "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1234"
        let mut it = line.split_whitespace();
        let _proto = it.next();
        if let Some(local) = it.next() {
            if let Some(port) = local.rsplit(':').next() {
                if let Ok(p) = port.parse::<u16>() {
                    ports.push(p);
                }
            }
        }
    }
    ports
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DownloadError {
    InvalidRef(String),
    TargetExists(PathBuf),
    GitMissing,
    AllLayersFailed(Vec<AttemptRecord>),
    Io(String),
    /// `git ls-remote` proved the repository is not publicly readable.
    RepoMissing(String),
    /// The pre-download existence check could not reach the host at all, so
    /// the repository's existence is unknown. Kept separate from
    /// `RepoMissing` because the remedy is different: check the network
    /// instead of checking the name.
    CheckNetwork(String),
    /// A bounded child process reached its deadline and was killed. Distinct from
    /// `Io` because the remote side is not necessarily broken — the honest advice
    /// is "retry, or fetch less", not "your disk failed".
    Timeout(String),
    /// The user cancelled this download. Never retried and never reported as a
    /// network failure: the partial landing directory is removed by the caller.
    Cancelled,
    /// A branch name the user typed did not pass `git check-ref-format`.
    InvalidBranch(String),
}

/// A one-way cancellation flag shared between the command and the worker.
///
/// `Arc<AtomicBool>` rather than a channel: the only operation is "stop now",
/// it must be readable from the 200 ms clone watchdog without blocking, and a
/// late cancel after the worker finished must be harmless. The command inserts
/// a token into a registry before spawning and sets it from `cancel_download`.
#[derive(Clone, Default)]
pub struct CancelToken(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRef(s) => write!(f, "无法解析的仓库标识: {s}"),
            Self::TargetExists(p) => write!(f, "目标目录已存在: {}", p.display()),
            Self::GitMissing => write!(
                f,
                "找不到 git。已查找系统 PATH 与应用内置 runtime\\git，均未找到。"
            ),
            Self::AllLayersFailed(attempts) => {
                writeln!(f, "四条下载路径全部失败：")?;
                for a in attempts {
                    writeln!(
                        f,
                        "  [{}] {} -> {}",
                        if a.ok { "成功" } else { "失败" },
                        a.label,
                        a.detail
                    )?;
                }
                Ok(())
            }
            Self::Io(s) => write!(f, "IO 错误: {s}"),
            Self::RepoMissing(slug) => {
                write!(f, "仓库不存在或没有访问权限: {slug}")
            }
            Self::CheckNetwork(detail) => {
                write!(f, "无法确认仓库是否存在（网络错误）: {detail}")
            }
            Self::Timeout(detail) => write!(f, "操作超时: {detail}"),
            Self::Cancelled => write!(f, "已取消"),
            Self::InvalidBranch(msg) => write!(f, "无效的分支名: {msg}"),
        }
    }
}

impl std::error::Error for DownloadError {}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/// Parses `owner/repo`, a full URL, or `host/owner/repo` into a RepoRef.
/// Removes the Windows verbatim (`\\?\` / `\\?\UNC\`) prefix that
/// `canonicalize` adds.
///
/// It matters because a `\\?\D:\x` path converted to a URL becomes
/// `file://///?/D:/x`, which git cannot open ("does not appear to be a git
/// repository", observed).
///
/// Delegates to `crate::netpath::strip_verbatim` so the two call sites
/// (here and `lib.rs`'s delete guard) cannot drift apart.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    crate::netpath::strip_verbatim(&p)
}

pub fn parse_ref(input: &str) -> Result<RepoRef, DownloadError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(DownloadError::InvalidRef(input.to_string()));
    }

    // --- local repository -----------------------------------------------------
    // Accepts `file:///D:/x/repo.git`, `D:\x\repo.git`, `\\server\share\repo` and
    // `./relative/path`. Local repos get a synthetic `local/<parent>/<name>` slug
    // so they still land somewhere unique and deterministic.
    let looks_local = s.starts_with("file://")
        || s.starts_with("\\\\")
        || s.starts_with("./")
        || s.starts_with(".\\")
        || s.starts_with("../")
        || s.starts_with("..\\")
        || (s.len() > 1 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic());
    if looks_local {
        let raw = s
            .strip_prefix("file:///")
            .or_else(|| s.strip_prefix("file://"))
            .unwrap_or(s);
        let path = PathBuf::from(raw.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !path.exists() {
            return Err(DownloadError::InvalidRef(format!(
                "本地路径不存在: {}",
                path.display()
            )));
        }
        let abs = std::fs::canonicalize(&path).unwrap_or(path);
        let abs = strip_verbatim_prefix(abs);
        let mut name = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        // A bare repo is conventionally named `<name>.git`.
        if let Some(stripped) = name.strip_suffix(".git") {
            name = stripped.to_string();
        }
        let parent = abs
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());
        let path_str = abs.to_string_lossy().to_string();
        return Ok(RepoRef {
            host: "local".to_string(),
            owner: parent,
            repo: name,
            local: Some(path_str),
            path: None,
        });
    }

    // Strip scheme. Everything after this works on an owned string so we can
    // normalise the scp-like `user@host:path` form into `host/path`.
    let mut rest: String = match s.find("://") {
        Some(idx) => s[idx + 3..].to_string(),
        None => s.to_string(),
    };
    if let Some(at) = rest.find('@') {
        let hostpart = rest[at + 1..].to_string();
        // scp-like syntax (`git@github.com:owner/repo`): ':' separates host from
        // path. It is not a port because the part before it has no '/'.
        rest = match hostpart.split_once(':') {
            Some((host, path)) if !host.contains('/') && !path.starts_with("//") => {
                format!("{host}/{path}")
            }
            _ => hostpart,
        };
    }
    // Drop query/fragment and a trailing .git
    let rest = rest.split(['?', '#']).next().unwrap_or(&rest);
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);

    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let (host, owner, repo) = match parts.len() {
        2 => ("github.com".to_string(), parts[0], parts[1]),
        3.. => (
            parts[parts.len() - 3].to_string(),
            parts[parts.len() - 2],
            parts[parts.len() - 1],
        ),
        _ => return Err(DownloadError::InvalidRef(input.to_string())),
    };

    if owner.is_empty() || repo.is_empty() {
        return Err(DownloadError::InvalidRef(input.to_string()));
    }
    Ok(RepoRef {
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
        local: None,
        path: None,
    })
}

// ---------------------------------------------------------------------------
// git discovery
// ---------------------------------------------------------------------------

/// A resolved git executable plus how we found it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLocation {
    pub path: String,
    pub version: String,
    pub source: String,
}

/// Memoised git location.
///
/// Measured: an uncached `find_git` costs **~2.8 s** in a packaged build, because
/// it walks every directory on `PATH` and then spawns `git --version` to read the
/// version. The environment snapshot is re-read on every refresh, so without this
/// cache the status strip waited 2.8 s every single time.
///
/// `Some(None)` means "checked, and there is no git" - that is a real answer and
/// must not be confused with "not checked yet".
static GIT_CACHE: std::sync::Mutex<Option<Option<GitLocation>>> = std::sync::Mutex::new(None);

/// Drops the memoised git location.
///
/// Needed after the portable Git bootstrap installs a runtime: the cached answer
/// "no git" would otherwise persist for the rest of the session and the app would
/// keep telling the user that git is missing.
pub fn reset_git_cache() {
    if let Ok(mut c) = GIT_CACHE.lock() {
        *c = None;
    }
}

/// Looks for git on PATH, then in the app's bundled runtime directory.
///
/// The bundled location is a plain directory, NOT a Tauri sidecar, so that a
/// downloaded portable Git does not have to be registered at build time.
///
/// The result is memoised; see `GIT_CACHE`.
pub fn find_git(bundled_runtime: Option<&Path>) -> Option<GitLocation> {
    if let Ok(c) = GIT_CACHE.lock() {
        if let Some(cached) = c.as_ref() {
            return cached.clone();
        }
    }

    let found = find_git_uncached(bundled_runtime);

    if let Ok(mut c) = GIT_CACHE.lock() {
        *c = Some(found.clone());
    }
    found
}

fn find_git_uncached(bundled_runtime: Option<&Path>) -> Option<GitLocation> {
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();

    if let Some(rt) = bundled_runtime {
        for rel in ["git/bin/git.exe", "git/cmd/git.exe", "git.exe"] {
            candidates.push((rt.join(rel), "bundled".to_string()));
        }
    }

    if let Some(p) = which_git_on_path() {
        // Prefer the system git: a user-installed git is usually better tested.
        candidates.insert(0, (p, "system".to_string()));
    }

    for (path, source) in candidates {
        if !path.is_file() {
            continue;
        }
        if let Some(version) = git_version(&path) {
            return Some(GitLocation {
                path: path.to_string_lossy().to_string(),
                version,
                source,
            });
        }
    }
    None
}

/// Every git invocation goes through here so long-path support is not optional
/// (r27-R1). `-c` must precede the subcommand; all call sites add one afterwards.
///
/// `core.longpaths=true` makes git use the `\?\` file APIs inside the
/// repository, which is what allows a checkout whose *files* exceed MAX_PATH.
/// It cannot make a landing directory whose own path is over 260 characters
/// work: git must `chdir` there first, and Windows refuses that. `download_inner`
/// refuses such a target with a clear message instead of leaving a broken clone.
pub(crate) fn git_cmd(git: &Path) -> std::process::Command {
    let mut cmd = crate::proc::silent(git);
    cmd.arg("-c").arg("core.longpaths=true");
    cmd
}

fn which_git_on_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in ["git.exe", "git"] {
            let cand = dir.join(name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Runs `git --version` with a **timeout**.
///
/// The previous `Command::output()` had no bound: a git that hangs (network-
/// mounted install, antivirus scan, broken shim) would block the caller forever.
/// Observed cost when healthy is ~100 ms, but up to 2.8 s under load.
fn git_version(git: &Path) -> Option<String> {
    use std::io::Read;

    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    let mut child = git_cmd(git)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started.elapsed() > TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => {
                // The child is still running; leaving it unreaped would leak
                // the handle (and a zombie on Unix).
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut buf = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut buf);
    }
    let version = buf.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

// ---------------------------------------------------------------------------
// Marker file (.devhub.json)
// ---------------------------------------------------------------------------

/// Everything DevHub persists about one repository.
///
/// This is the single source of truth for the port block, which is why port
/// allocation cannot drift: it is stored once, here, and never duplicated.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub cloned_at: String,
    #[serde(default)]
    pub port_base: u16,
    /// Named port assignments, e.g. http -> 20000.
    #[serde(default)]
    pub services: Vec<(String, u16)>,
    #[serde(default)]
    pub python_version: Option<String>,
    /// The venv lives OUTSIDE the repository so same-named repos cannot collide.
    #[serde(default)]
    pub venv_path: Option<String>,
    /// User-confirmed launch command, set by the launch screen.
    #[serde(default)]
    pub launch: Option<crate::launch::LaunchConfig>,
    /// Per-repository override of 逐步确认, set from 项目设置.
    ///
    /// `Option` rather than `bool` because "unset" and "off" are different answers:
    /// unset follows the global default, off is a decision about this repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stepwise: Option<bool>,
    /// Terminal id overriding the machine-wide 默认终端 for this repository only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_choice: Option<String>,
    /// IDE id overriding the machine-wide 默认 IDE for this repository only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ide_choice: Option<String>,
    /// When 更新 (git pull) last succeeded, RFC 3339. `None` = never updated
    /// through the app, which is also what every pre-round-11 marker says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pull: Option<String>,
    /// Which Python interpreter this repository launches with (round 11, 需求 8.5).
    ///
    /// The machine can carry several (this one has three: `python` → 3.11.5,
    /// `py -3.12` → E:\wai\python, `py -3.10`), and `REQUIREMENTS.md` §3.6 records
    /// that not locking the version "必然产生依赖冲突". The value is the
    /// interpreter's own path; `None` follows the venv, then PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python_choice: Option<String>,
    /// C3: a per-repository description override, set from 项目设置 or the
    /// search panel. `None` means "use the GitHub API description, if any".
    /// Old markers without this field parse as `None` via the serde default,
    /// so existing `.devhub.json` files are fully backward-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The branch this clone was asked to check out (r27-N1). `None` means the
    /// remote's default branch, which is also what every pre-r27 marker says.
    /// Kept so 项目设置 can show it, and so a confirmed overwrite re-download
    /// does not silently switch the user back to the default branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

pub(crate) fn marker_path(repo: &Path) -> PathBuf {
    repo.join(".devhub.json")
}

pub fn read_marker(repo: &Path) -> Option<Marker> {
    match read_marker_strict(repo).ok()? {
        MarkerFile::Valid(m) => Some(m),
        _ => None,
    }
}

/// What a repository's `.devhub.json` actually looks like on disk.
///
/// `read_marker` collapses all four of these into `Option`, which is the wrong
/// shape for a writer: a file that exists but is momentarily locked, and a file
/// that is genuinely absent, both came back as `None`, and `update_marker` then
/// rebuilt the marker from `Marker::default()` — silently resetting `slug`,
/// `port_base`/`services` (the block that must never drift, 需求 8.7) and the
/// confirmed launch command. The distinction is the whole point of this enum.
pub(crate) enum MarkerFile {
    /// No file. A freshly cloned repository before `finish()` writes one.
    Absent,
    /// Read and parsed.
    Valid(Marker),
    /// The file exists but could not be read *now* (locked by an editor, a
    /// concurrent indexer, an AV scan). Transient — a retry can succeed, so a
    /// write must not go ahead and destroy what is in there.
    Unreadable(String),
    /// The file exists, was read, and is not valid JSON. Not transient —
    /// preserving the bytes is the only recoverable move.
    Corrupt,
}

pub(crate) fn read_marker_strict(repo: &Path) -> Result<MarkerFile, String> {
    let path = marker_path(repo);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MarkerFile::Absent),
        Err(e) => return Ok(MarkerFile::Unreadable(e.to_string())),
    };
    match serde_json::from_str::<Marker>(&text) {
        Ok(m) => Ok(MarkerFile::Valid(m)),
        Err(_) => Ok(MarkerFile::Corrupt),
    }
}

/// Reads, mutates and writes back the marker.
///
/// An **absent** marker becomes a fresh one rather than failing, because the
/// repository itself is still usable. An **unreadable** marker aborts the write
/// (the caller can retry; nothing is lost). A **corrupt** marker is set aside as
/// `.devhub.json.bad` before the fresh one is written, so the previous identity
/// and port block stay recoverable instead of evaporating into a default.
pub fn update_marker<F>(repo: &Path, mutate: F) -> Result<(), String>
where
    F: FnOnce(&mut Marker),
{
    let path = marker_path(repo);
    let mut marker = match read_marker_strict(repo)? {
        MarkerFile::Valid(m) => m,
        MarkerFile::Absent => Marker::default(),
        MarkerFile::Unreadable(e) => {
            return Err(format!(
                "暂存目录的 .devhub.json 现在读不到（{e}），已取消写入以免丢失端口与环境记录，请稍后重试"
            ))
        }
        MarkerFile::Corrupt => {
            let backup = path.with_extension("json.bad");
            // If the backup cannot be made, do not overwrite: "we destroyed your
            // marker" is strictly worse than "we refused to write this time".
            std::fs::rename(&path, &backup).map_err(|e| {
                format!("标记文件已损坏且无法备份到 .devhub.json.bad（{e}），已取消写入")
            })?;
            eprintln!(
                "[marker] {} 无法解析，原文件已备份为 {}",
                path.display(),
                backup.display()
            );
            Marker::default()
        }
    };
    mutate(&mut marker);
    let text = serde_json::to_string_pretty(&marker)
        .map_err(|e| format!("序列化 .devhub.json 失败: {e}"))?;
    // Atomic replace, the way the app config already writes itself (`save_config`:
    // tmp + rename). A bare `fs::write` here could leave a half-written marker on
    // disk if the process died mid-write — and because `update_marker` reads a bad
    // file as "no marker", that truncation silently rewrites the repository's
    // identity, port block and confirmed command from defaults on the next edit.
    crate::write_atomic(&path, text.as_bytes())
        .map_err(|e| format!("写入 .devhub.json 失败: {e}"))?;
    // A marker edit is the one container change the index's directory stamps
    // cannot see: the file already exists, so no parent directory's mtime moves.
    crate::repo_index::invalidate();
    Ok(())
}

/// Directories under the project root that belong to DevHub itself, or that are
/// never repositories. Anything starting with `.` is skipped as well.
///
/// `pub(crate)` because the 回退 path has to use *this* list rather than its own
/// idea of what is safe to delete: a record's path pointing at `venvs/<name>`
/// would otherwise be a 回退 that wipes another project's environment.
const RESERVED_ROOT_DIRS: &[&str] = &["cache", "venvs", "runtime", "_worktrees", "_bootstrap"];

pub(crate) fn is_reserved_dir(name: &str) -> bool {
    name.starts_with('.') || RESERVED_ROOT_DIRS.iter().any(|r| name.eq_ignore_ascii_case(r))
}

/// Walks the project root and calls `f(relative_path, absolute_path)` for every
/// directory that is a git repository.
///
/// **Two layouts are recognised on purpose:**
///   * current: `<root>/<repo>_<owner>`
///   * legacy (0.2.0): `<root>/code/<host>/<owner>/<repo>`
///
/// Repositories that were already downloaded with the old layout keep working -
/// and keep being found by every action - without anything being moved behind
/// the user's back. Depth-bounded so a stray deep tree cannot make this slow.
/// Directories that are build output rather than a container of repositories.
///
/// Measured on this machine with `--scan-check`: pointing a project root at a
/// Rust working copy made one walk cost **86 s cold / 3.3 s warm** while finding
/// *one* slug cost 3.5 s, because the walk opened 595 directories and statted
/// every entry of `target/debug/deps`. The names below are the ones that produce
/// that shape.
///
/// Only non-repositories are pruned: a directory carrying `.git` is reported
/// before this list is consulted, so a repository named `dist` is still a
/// project. The same predicate is what the 回退 guard uses to decide whether a
/// path is ours to delete, so pruning cannot make something undeletable that is
/// still listed, or vice versa.
const BUILD_ARTIFACT_DIRS: &[&str] = &[
    "target",
    "node_modules",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".venv",
    "venv",
];

pub(crate) fn is_build_artifact_dir(name: &str) -> bool {
    BUILD_ARTIFACT_DIRS
        .iter()
        .any(|d| name.eq_ignore_ascii_case(d))
}

/// What a container walk touched.
///
/// `--scan-check` prints these because wall-clock alone cannot tell a wide
/// container from a deep one: 11 repositories under a root that also holds a
/// Rust `target/` directory can visit six thousand directories, and the number
/// that matters is the second one.
#[derive(Default, Clone, Debug)]
pub struct WalkStats {
    /// Directories opened with `read_dir` (repositories are reported, not opened).
    pub dirs_visited: u64,
    /// Directories reported as repositories.
    pub repos: u64,
    /// Directories skipped by the depth bound.
    pub depth_cuts: u64,
    /// Every directory that was opened, with the child names it held, so a later
    /// check can tell whether the set of repositories changed.
    pub containers: Vec<ContainerStamp>,
}

/// A stamp on one container directory: the names of the subdirectories it held.
///
/// A *name set*, deliberately, rather than an mtime. The index file this describes
/// is written **into** the container, so an mtime stamp would be invalidated by
/// its own save - and an mtime that changes when nothing relevant changed is a
/// stamp that buys nothing. Listing directory names is immune to files appearing,
/// and still moves the moment a repository is added, removed or renamed.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ContainerStamp {
    pub path: String,
    /// Subdirectory names, sorted, so the comparison is order-independent.
    pub dirs: Vec<String>,
}

pub fn collect_repos<F>(root: &Path, f: &mut F)
where
    F: FnMut(&Path, &Path),
{
    let mut stats = WalkStats::default();
    walk_repos(root, root, 0, f, &mut stats);
}

/// `collect_repos` plus the visit counts.
pub fn collect_repos_counted<F>(root: &Path, f: &mut F, stats: &mut WalkStats)
where
    F: FnMut(&Path, &Path),
{
    walk_repos(root, root, 0, f, stats);
}

fn walk_repos<F>(root: &Path, dir: &Path, depth: usize, f: &mut F, stats: &mut WalkStats)
where
    F: FnMut(&Path, &Path),
{
    if depth > 5 || !dir.is_dir() {
        stats.depth_cuts += 1;
        return;
    }
    // A repository is reported and never descended into: everything inside it
    // (nested clones, vendored projects) belongs to that repository.
    if dir.join(".git").exists() {
        stats.repos += 1;
        f(dir.strip_prefix(root).unwrap_or(dir), dir);
        return;
    }
    if depth > 0 {
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if is_reserved_dir(name) || is_build_artifact_dir(name) {
                return;
            }
        }
    }
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            let mut names: Vec<String> = Vec::new();
            let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                        names.push(n.to_string());
                    }
                    subdirs.push(p);
                }
            }
            names.sort();
            stats.dirs_visited += 1;
            stats.containers.push(ContainerStamp {
                path: dir.to_string_lossy().to_string(),
                dirs: names,
            });
            for p in subdirs {
                walk_repos(root, &p, depth + 1, f, stats);
            }
        }
        Err(_) => {
            // Unreadable (permissions, a deleted tree, an offline drive): the
            // walk reports what it can reach rather than failing the wall.
        }
    }
}

/// Normalises a slug for comparison: forward slashes, no surrounding slashes.
pub(crate) fn normalize_slug(s: &str) -> String {
    s.trim().trim_matches('/').replace('\\', "/")
}

/// `owner/repo` -> `("owner", "repo")`, and `host/owner/repo` -> the last three
/// parts. Returns `None` when there is nothing usable.
fn split_slug(slug: &str) -> Option<(String, String, String)> {
    let norm = normalize_slug(slug);
    let parts: Vec<&str> = norm.split('/').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 | 1 => None,
        2 => Some(("github.com".to_string(), parts[0].to_string(), parts[1].to_string())),
        _ => {
            let n = parts.len();
            Some((
                parts[n - 3].to_string(),
                parts[n - 2].to_string(),
                parts[n - 1].to_string(),
            ))
        }
    }
}

/// Identifies an on-disk repository directory.
///
/// Order: the `.devhub.json` marker (authoritative - it holds the exact slug),
/// then the legacy `code/<host>/<owner>/<repo>` path, then the current
/// `<repo>_<owner>` name. The last case can only recover the owner from the name,
/// so `github.com` is assumed; that branch exists for a repository a user copied
/// in by hand, because such a directory has no marker to read.
pub fn repo_ref_of(root: &Path, repo: &Path) -> Option<RepoRef> {
    repo_ref_of_marker(root, repo, read_marker(repo).as_ref())
}

/// `repo_ref_of` with the marker already in hand.
///
/// The index reads every marker anyway, and re-reading one costs about as much as
/// the directory stat that found it: a wall of 13 repositories used to open
/// `.devhub.json` twice per repository.
pub fn repo_ref_of_marker(root: &Path, repo: &Path, marker: Option<&Marker>) -> Option<RepoRef> {
    if let Some(m) = marker {
        if let Some((host, owner, name)) = split_slug(&m.slug) {
            return Some(RepoRef {
                host,
                owner,
                repo: name,
                local: None,
                path: Some(repo.to_string_lossy().to_string()),
            });
        }
    }

    if let Ok(rel) = repo.strip_prefix(root) {
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();
        if parts.len() >= 4 && parts[0].eq_ignore_ascii_case("code") {
            let n = parts.len();
            return Some(RepoRef {
                host: parts[n - 3].clone(),
                owner: parts[n - 2].clone(),
                repo: parts[n - 1].clone(),
                local: None,
                path: Some(repo.to_string_lossy().to_string()),
            });
        }
    }

    let name = repo.file_name()?.to_string_lossy().to_string();
    let (repo_name, owner) = name.rsplit_once('_')?;
    if repo_name.is_empty() || owner.is_empty() {
        return None;
    }
    Some(RepoRef {
        host: "github.com".to_string(),
        owner: owner.to_string(),
        repo: repo_name.to_string(),
        local: None,
        path: Some(repo.to_string_lossy().to_string()),
    })
}

/// Every name one on-disk repository answers to.
///
/// A type rather than four positional `&str`s because the four are compared in a
/// fixed precedence, and because the set was incomplete: the wall lists a
/// markerless directory under `host/owner/repo` (recovered from its
/// `<repo>_<owner>` name by `repo_ref_of`), while the lookup only ever compared
/// the marker, the path and the directory name. `--scan-check` caught that on a
/// real container - 2 of 13 repositories were listed and unresolvable, so every
/// action on them answered 未找到仓库.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct RepoNames {
    /// Path relative to the root, normalised to forward slashes.
    pub rel: String,
    /// The `.devhub.json` slug, normalised. Empty when there is no marker.
    pub marker: String,
    pub dir_name: String,
    /// The slug the wall lists this repository under, from `repo_ref_of`.
    pub identified: String,
}

/// The name set for one directory the walk reported.
pub fn repo_names(root: &Path, rel: &Path, repo: &Path) -> RepoNames {
    repo_names_with(root, rel, repo, read_marker(repo).as_ref())
}

/// `repo_names` with the marker already in hand, so a scan does not read the same
/// file twice.
pub fn repo_names_with(
    root: &Path,
    rel: &Path,
    repo: &Path,
    marker: Option<&Marker>,
) -> RepoNames {
    RepoNames {
        rel: normalize_slug(&rel.to_string_lossy()),
        marker: marker.map(|m| normalize_slug(&m.slug)).unwrap_or_default(),
        dir_name: repo
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        identified: repo_ref_of_marker(root, repo, marker)
            .map(|r| normalize_slug(&r.slug()))
            .unwrap_or_default(),
    }
}

/// How well one on-disk repository answers one spelling.
///
/// `Some(0)` exact, `Some(1)` suffix (`owner/repo` against `host/owner/repo`),
/// `Some(2)` bare repository name, `None` no match. Shared with the index so both
/// resolve a slug with **the same** comparison.
pub fn slug_score(want: &str, names: &RepoNames) -> Option<u8> {
    let suffix = format!("/{want}");
    let legacy = names.rel.strip_prefix("code/").unwrap_or(&names.rel);
    let exact = [
        names.identified.as_str(),
        names.marker.as_str(),
        names.rel.as_str(),
        names.dir_name.as_str(),
        legacy,
    ]
    .into_iter()
    .any(|n| !n.is_empty() && n == want);
    if exact {
        return Some(0);
    }
    let ends_in_want = |n: &str| !n.is_empty() && n.ends_with(&suffix);
    if ends_in_want(&names.marker) || ends_in_want(legacy) {
        return Some(1);
    }
    let last_is_want = |n: &str| !n.is_empty() && n.rsplit('/').next() == Some(want);
    if last_is_want(&names.marker) || last_is_want(legacy) || last_is_want(&names.identified) {
        return Some(2);
    }
    None
}

/// Finds a repository directory by any name it is known by.
///
/// Deliberately permissive: the marker slug, the directory name, the legacy
/// `code/<host>/<owner>/<repo>` path, any suffix of those, and the bare repository
/// name all resolve. The project view once handed this function `owner/repo` with
/// the host dropped, and every action on a downloaded repository failed.
///
/// Uncached by design - it is the fallback the index degrades *to*. The wall's own
/// path is [`crate::repo_index::find`], which answers from one walk instead of one
/// walk per question.
pub fn find_repo_by_slug(root: &Path, slug: &str) -> Option<PathBuf> {
    let want = normalize_slug(slug);
    if want.is_empty() {
        return None;
    }
    let mut best: Option<(u8, PathBuf)> = None;

    collect_repos(root, &mut |rel, abs| {
        let names = repo_names(root, rel, abs);
        let Some(score) = slug_score(&want, &names) else {
            return;
        };
        if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
            best = Some((score, abs.to_path_buf()));
        }
    });

    best.map(|(_, p)| p)
}

/// The venv directory that belongs to a repository, if one exists.
///
/// New layout: `<root>/venvs/<repo>_<owner>`, i.e. paired 1:1 with the repository
/// directory. Legacy layout: `<root>/venvs/<host>_<owner>_<repo>`, which is what
/// 0.2.0 created by replacing the separators in the relative path, so old venvs
/// are still found instead of being silently orphaned.
pub fn venv_dir_for(root: &Path, repo: &Path) -> Option<PathBuf> {
    let primary = venv_expected_dir(root, repo)?;
    if primary.is_dir() {
        return Some(primary);
    }
    let rel = repo.strip_prefix(root).ok()?;
    let rel = rel.strip_prefix("code").unwrap_or(rel);
    let legacy = root
        .join("venvs")
        .join(rel.to_string_lossy().replace(['\\', '/'], "_"));
    if legacy.is_dir() {
        Some(legacy)
    } else {
        None
    }
}

/// Where an environment for this repository *would* live, whether or not one exists.
///
/// Split from [`venv_dir_for`] because the two answer different questions: that one
/// reports what is on disk, this one reports where `create_repo_venv` is about to
/// write. 项目设置 needs the second to name the path it is offering to create, and
/// copying the rule into the command layer is how the two would drift.
pub fn venv_expected_dir(root: &Path, repo: &Path) -> Option<PathBuf> {
    let name = repo.file_name()?.to_string_lossy().to_string();
    Some(root.join("venvs").join(name))
}

/// Does this directory look like a Python virtual environment?
///
/// `pyvenv.cfg` is what the stdlib `venv` writes. The interpreter paths are the
/// fallback for environments built by another tool (virtualenv, conda, a copied
/// directory) where the cfg may be absent, so a perfectly usable venv is not
/// refused for the crime of having been made elsewhere.
pub fn looks_like_venv(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    dir.join("pyvenv.cfg").is_file()
        || dir.join("Scripts").join("python.exe").is_file()
        || dir.join("bin").join("python").is_file()
}

/// The extensions a cover may be, as the cache file name suffix. Kept in one place
/// because `tauri.conf.json`'s asset-protocol scope has to list exactly these.
pub const COVER_KINDS: &[&str] = &["png", "jpg", "webp", "gif"];

/// Checks a port block the person picked by hand, with the same tests
/// [`Downloader::allocate`] applies to one the app picked itself.
///
/// `roots` is every configured project root, not only the primary one: 附加目录
/// repositories draw from the same pool, so a block that is free in one container
/// can be taken in another. `except` is the repository being edited - its own
/// current block must not be reported as colliding with itself, and it is compared
/// by directory name rather than by `Path` because the index and a fresh walk can
/// spell the same directory with a different case, which `Path` equality is.
///
/// The in-flight `ALLOCATED_BASES` reservation is checked as well as the markers on
/// disk: a marker only exists once a clone finishes, which is the blind spot that
/// let two parallel downloads take one block. A hand-picked value can land on a
/// block that a download in this session has already reserved but not yet written.
pub fn claim_port_block(roots: &[PathBuf], base: u16, except: &Path) -> Result<PortBlock, String> {
    let top = POOL_HIGH - BLOCK_SIZE;
    if base < POOL_LOW || base > top {
        return Err(format!("端口段要在 {POOL_LOW}–{top} 之间"));
    }
    if (base - POOL_LOW) % BLOCK_SIZE != 0 {
        return Err(format!(
            "端口段要按 {BLOCK_SIZE} 对齐，例如 {POOL_LOW} 或 {}",
            POOL_LOW + BLOCK_SIZE
        ));
    }

    let want = except.file_name().map(|n| n.to_string_lossy().to_lowercase());
    let mut taken: Option<(u16, String)> = None;
    for root in roots {
        if taken.is_some() {
            break;
        }
        let clash = &mut taken;
        collect_repos(root, &mut |_rel, abs| {
            if clash.is_some() {
                return;
            }
            if abs.file_name().map(|n| n.to_string_lossy().to_lowercase()) == want {
                return;
            }
            if let Some(m) = read_marker(abs) {
                if m.port_base > 0 && m.port_base.abs_diff(base) < BLOCK_SIZE {
                    *clash = Some((
                        m.port_base,
                        abs.file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default(),
                    ));
                }
            }
        });
    }
    if let Some((other, where_)) = taken {
        return Err(format!("{base} 与「{where_}」的端口段 {other} 重叠"));
    }

    let reserved: Vec<u16> = ALLOCATED_BASES
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    if let Some(u) = reserved.iter().find(|u| u.abs_diff(base) < BLOCK_SIZE) {
        return Err(format!("{base} 已被本次运行中的下载保留（{u}）"));
    }

    let in_use = ports_in_use();
    if let Some(p) = (base..base + BLOCK_SIZE).find(|p| in_use.contains(p) || SYSTEM_PORTS.contains(p))
    {
        return Err(format!("{p} 正在被监听或属于系统占用，换一段"));
    }

    Ok(PortBlock {
        base,
        services: RESERVED_SERVICES
            .iter()
            .enumerate()
            .map(|(i, name)| (name.to_string(), base + i as u16))
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// Generic file download (used to fetch the portable Git archive)
// ---------------------------------------------------------------------------

/// Downloads `url` to `dest`, reporting byte progress.
///
/// Uses the `curl` command-line tool rather than a Rust HTTP client: curl ships
/// with Windows 10 1803+ and with git, it handles TLS/proxy/redirects the same
/// way git does, and it needs no heavy dependency. Returns bytes written.
///
/// `accept_header` is needed for the GitHub *asset* API endpoint, which returns
/// JSON metadata unless `Accept: application/octet-stream` is sent.
pub fn download_file(
    progress: ProgressFn,
    url: &str,
    dest: &Path,
    stage: &str,
    accept_header: Option<&str>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建 {}: {e}", parent.display()))?;
    }
    let _ = std::fs::remove_file(dest);

    let curl = which_curl().ok_or("找不到 curl（Windows 10 1803+ 或 git 应自带）")?;
    progress(stage, &format!("开始下载 {url}"));
    progress(
        stage,
        "下载不显示百分比：curl 的进度条无法可靠解析，界面以此处的字节数为准",
    );

    let mut cmd = crate::proc::silent(&curl);
    cmd.args([
        "-L",                  // follow redirects (GitHub release assets do)
        "--fail",              // treat HTTP errors as failures
        "--no-progress-meter", // keep stderr free of the human progress table
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--retry-all-errors",
        "--connect-timeout",
        "20",
        // A transfer that stalls mid-body would otherwise sit in `cmd.output()`
        // below forever: `--connect-timeout` only bounds connection setup, and
        // `--retry` only re-fires attempts that ended. Every other curl caller in
        // this crate sets `--max-time` (`search.rs`, `ogimage.rs`, `gitboot.rs`);
        // this was the one that could hang a download slot with no deadline.
        "--max-time",
        "900",
        "-o",
    ])
    .arg(dest)
    .arg(url)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .stdin(Stdio::null());

    if let Some(accept) = accept_header {
        cmd.arg("-H").arg(format!("Accept: {accept}"));
    }

    let output = cmd.output().map_err(|e| format!("无法启动 curl: {e}"))?;
    if !output.status.success() {
        // curl's error strings come from Windows in the OEM codepage; a lossy
        // UTF-8 decode turned the Chinese half into U+FFFD.
        let err = crate::proc::decode_console(&output.stderr);
        let tail: Vec<&str> = err.lines().rev().take(3).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(format!("curl 失败: {}", tail.join(" | ")));
    }

    let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("下载结果为空文件".to_string());
    }
    progress(stage, &format!("下载完成，{} 字节", size));
    Ok(size)
}

/// Finds curl on PATH or next to git.
fn which_curl() -> Option<PathBuf> {
    if let Some(rt) = std::env::var_os("SystemRoot") {
        let p = PathBuf::from(rt).join("System32/curl.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in ["curl.exe", "curl"] {
            let cand = dir.join(name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Layer 2: DNS cross-checked IP pinning
// ---------------------------------------------------------------------------

/// Resolves `host` via several public resolvers and returns an IP only when at
/// least two of them agree. Disagreement means we cannot decide safely, so we
/// refuse to pin rather than trust one answer.
///
/// Resolvers are queried **concurrently** and the whole thing is bounded by an
/// **overall deadline**. Measured here: individual queries normally take ~70 ms,
/// but one resolver occasionally burns its whole per-query timeout and the total
/// jumped to 3068 ms. Since this is advisory information for the UI, a short
/// deadline is the right trade-off: if the resolvers cannot answer in time we
/// report "no agreement" rather than stalling.
const DNS_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1100);
const DNS_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);

const DNS_CACHE_TTL_MS: u64 = 30_000;

/// A resolved-and-agreed address, with the clock it was learned at.
struct DnsCacheEntry {
    host: String,
    at: Instant,
    ip: String,
}

/// The cross-check cache: **one** host, remembering only what agreed.
///
/// Capacity is a single slot and the entry ages out after [`DNS_CACHE_TTL_MS`];
/// both bounds matter because this is a process-global that would otherwise grow
/// with every host the app ever pins.
#[derive(Default)]
struct DnsCache {
    entry: Option<DnsCacheEntry>,
}

impl DnsCache {
    /// The agreed IP for `host`, if one was learned within the TTL.
    fn get(&self, host: &str, now: Instant) -> Option<String> {
        let e = self.entry.as_ref()?;
        if e.host != host {
            return None;
        }
        if now.duration_since(e.at).as_millis() as u64 >= DNS_CACHE_TTL_MS {
            return None;
        }
        Some(e.ip.clone())
    }

    /// Stores an agreed IP, replacing whatever host was cached before (capacity
    /// one, so a different host evicts the previous entry).
    ///
    /// A **failure is deliberately not stored.** "These resolvers could not agree,
    /// right now" is a property of this moment, not of the host: remembering it
    /// would keep `resolve_agreed_ip` returning `None` for the whole TTL and leave
    /// layer 2 (and the search bypass that shares this cache) switched off exactly
    /// when a retry could succeed — a transient failure promoted to a 30-second
    /// fact. The timeout path below already returned without caching; this makes
    /// the disagreement path agree with it.
    fn put(&mut self, host: &str, ip: Option<&str>, now: Instant) {
        let Some(ip) = ip else { return };
        self.entry = Some(DnsCacheEntry {
            host: host.to_string(),
            at: now,
            ip: ip.to_string(),
        });
    }
}

static DNS_CACHE: std::sync::Mutex<DnsCache> = std::sync::Mutex::new(DnsCache { entry: None });

pub fn resolve_agreed_ip(host: &str) -> Option<String> {
    if let Ok(c) = DNS_CACHE.lock() {
        if let Some(ip) = c.get(host, Instant::now()) {
            return Some(ip);
        }
    }

    use hickory_resolver::config::{
        ConnectionConfig, NameServerConfig, ResolveHosts, ResolverConfig, ResolverOpts,
    };
    use hickory_resolver::net::runtime::TokioRuntimeProvider;
    use hickory_resolver::Resolver;

    let host_owned = host.to_string();
    let mut handles: Vec<std::thread::JoinHandle<Option<String>>> = Vec::new();
    for ns in PUBLIC_DNS {
        let ip: std::net::IpAddr = match ns.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let h = host_owned.clone();
        handles.push(std::thread::spawn(move || {
            let ns = NameServerConfig::new(
                ip,
                true,
                vec![ConnectionConfig::udp(), ConnectionConfig::tcp()],
            );
            let cfg = ResolverConfig::from_parts(None, vec![], vec![ns]);
            let mut opts = ResolverOpts::default();
            opts.timeout = DNS_QUERY_TIMEOUT;
            opts.attempts = 1;
            // The cross-check exists to see what public DNS says *instead of* the
            // local hosts file; reading hosts here would return whatever
            // accelerator wrote 127.0.0.1 and defeat the whole layer.
            opts.use_hosts_file = ResolveHosts::Never;
            // DNSSEC is not compiled in (no `dnssec-*` feature), so there is
            // nothing to disable; `validate` is absent from this build's opts.
            // hickory 0.26 is async-only. A current-thread runtime per probe keeps
            // this synchronous helper's contract (one thread → one answer) without
            // changing the concurrency the outer loop already provides.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build()
                .ok()?;
            // Build and query inside `block_on`: the provider captures the
            // current Tokio handle, so constructing the resolver while the
            // runtime is merely *created* (not entered) leaves its background
            // tasks without a reactor.
            let lookup = rt.block_on(async {
                let resolver =
                    Resolver::builder_with_config(cfg, TokioRuntimeProvider::default())
                        .with_options(opts)
                        .build()
                        .ok()?;
                resolver.lookup_ip(&h).await.ok()
            })?;
            lookup.iter().next().map(|a| a.to_string())
        }));
    }

    let deadline = std::time::Instant::now() + DNS_DEADLINE;
    let mut votes: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut answers = 0usize;
    let mut pending = handles;

    while !pending.is_empty() {
        let mut still = Vec::new();
        for h in pending {
            if h.is_finished() {
                answers += 1;
                if let Ok(Some(addr)) = h.join() {
                    *votes.entry(addr).or_insert(0) += 1;
                }
            } else {
                still.push(h);
            }
        }
        pending = still;
        if pending.is_empty() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let timed_out = !pending.is_empty();

    let mut ranked: Vec<(String, usize)> = votes.into_iter().collect();
    ranked.retain(|(ip, _)| match ip.parse::<std::net::IpAddr>() {
        Ok(a) => is_public_unicast(&a),
        Err(_) => false,
    });
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    if timed_out && answers < 2 {
        // Too few resolvers answered and the deadline passed: an un-decidable
        // moment, reported to the caller and *not* cached (see `DnsCache::put`).
        return None;
    }
    let result = match ranked.first() {
        Some((ip, count)) if *count >= 2 => Some(ip.clone()),
        _ => None,
    };
    if let Ok(mut c) = DNS_CACHE.lock() {
        c.put(host, result.as_deref(), Instant::now());
    }
    result
}

/// True for an address a public DNS name could legitimately resolve to.
fn is_public_unicast(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_unspecified()
                || v4.is_link_local()
                || v4.is_multicast())
        }
        std::net::IpAddr::V6(v6) => {
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast())
        }
    }
}

// ---------------------------------------------------------------------------
// Layer 3: local proxy discovery
// ---------------------------------------------------------------------------

/// How long a single loopback probe may take.
///
/// A loopback socket either refuses immediately or accepts immediately, so 100 ms
/// is generous. Measured: probing eight candidates cost **2364 ms** serially with
/// a 250 ms timeout, versus **170 ms** concurrently with this timeout. That
/// difference was blocking the UI, because the environment panel runs this on load.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(100);

/// Normalizes a system `ProxyServer` value into `host:port` **only when it is
/// loopback**, or `None`.
///
/// The registry value can be `127.0.0.1:7890`, `http://127.0.0.1:7890`, or a
/// `http=…;https=…` string (netpath already picks the https member). A remote
/// proxy is deliberately not auto-used: the product promises "auto-discover your
/// local proxy", and silently sending repository traffic to a host from a stale
/// registry value is a different promise. It still appears in 网络诊断.
pub fn loopback_proxy_addr(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    for prefix in ["http://", "https://", "socks5://", "socks4://"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    let s = s.trim_end_matches('/');
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        // [::1]:7890
        let (h, p) = rest.split_once("]:")?;
        (format!("[{h}]"), p)
    } else {
        let (h, p) = s.rsplit_once(':')?;
        (h.to_string(), p)
    };
    let port: u16 = port.parse().ok()?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]";
    if !loopback || port == 0 {
        return None;
    }
    Some(format!("{host}:{port}"))
}

/// Probes every candidate port **concurrently** and returns all that accept.
///
/// We only *discover* a proxy - we never configure or install one. The system
/// proxy comes first when it is loopback (r27-R2): it is the one candidate the
/// user explicitly configured, and the hard-coded accelerator ports below are
/// guesses. Duplicates are removed so a configured 7890 does not probe twice.
pub fn probe_local_proxies(extra: &[String]) -> Vec<String> {
    let candidates = proxy_candidates(extra, crate::netpath::system_proxy().as_deref());

    let handles: Vec<_> = candidates
        .into_iter()
        .map(|addr| {
            std::thread::spawn(move || {
                let sock: std::net::SocketAddr = addr.parse().ok()?;
                if std::net::TcpStream::connect_timeout(&sock, PROBE_TIMEOUT).is_ok() {
                    Some(format!("http://{addr}"))
                } else {
                    None
                }
            })
        })
        .collect();

    let mut found = Vec::new();
    for h in handles {
        if let Ok(Some(addr)) = h.join() {
            found.push(addr);
        }
    }
    found
}

/// The ordered, de-duplicated candidate list. Separate from probing so the
/// ordering rule (configured system proxy → built-in guesses → user extras) is
/// testable without a registry or a listening socket.
fn proxy_candidates(extra: &[String], system: Option<&str>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = system.and_then(loopback_proxy_addr) {
        candidates.push(p);
    }
    candidates.extend(PROXY_CANDIDATES.iter().map(|p| format!("127.0.0.1:{p}")));
    for c in extra {
        let trimmed = c.trim();
        if !trimmed.is_empty() {
            candidates.push(
                trimmed
                    .trim_start_matches("http://")
                    .trim_end_matches('/')
                    .to_string(),
            );
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|c| seen.insert(c.clone()));
    candidates
}

/// The first discovered proxy, or None.
pub fn discover_local_proxy(extra: &[String]) -> Option<String> {
    probe_local_proxies(extra).into_iter().next()
}

// ---------------------------------------------------------------------------
// Progress plumbing
// ---------------------------------------------------------------------------

/// Progress sink. Deliberately NOT tied to `AppHandle` so the whole downloader
/// can be driven headlessly (see `run_headless_clone`), which is how the
/// four-layer fallback is actually verified.
///
/// `Arc` rather than a plain reference: progress is reported from the threads
/// that drain git's stdout/stderr, and `std::thread::spawn` requires `'static`.
pub type ProgressFn = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct GitRun {
    pub ok: bool,
    /// The process exit code; `None` when the OS never reported one (killed by
    /// the timeout watchdog, or an abnormal exit).
    pub code: Option<i32>,
    pub stderr_tail: String,
    pub stdout_tail: String,
}

/// How many times a single layer retries a transient network failure before the
/// next layer is tried.
const RETRY_ATTEMPTS: u32 = 2;

/// The per-attempt backoff before a transient retry.
///
/// An immediate retry against the same flaky connection usually hits the same
/// reset, because whatever caused the reset (an in-flight RST, a half-closed
/// keepalive socket, a rate-limiter backfill) is still in place on the other
/// side. A short, growing sleep lets the other end settle before the next
/// attempt: attempt 1 pays 500 ms, attempt 2 pays 1000 ms, and so on. Bounded
/// by [`RETRY_ATTEMPTS`] (currently 2), so the worst-case added latency on a
/// transient failure is 1.5 s — the ladder's other layers cost tens of
/// seconds each, so this is not a regression in the failure path.
const RETRY_BACKOFF_MS: u64 = 500;

/// Runs one attempt of a transient-retry loop, with growing backoff between
/// attempts, and reports each attempt through the progress sink.
///
/// The closure takes the 1-based attempt number and returns
/// `true` to *stop* (the layer settled: it succeeded, hit a non-transient
/// failure, or burned its last attempt) and `false` to *keep going* (a
/// transient failure with more attempts left). It must perform the actual
/// work (the `git clone`), record its own progress lines, and clean up any
/// partial directory.
///
/// Extracted from `try_git` so the loop — the part that is easy to get wrong
/// (the backoff schedule, the last-attempt detection) — lives in one place
/// and is reusable for any layer that wants the same shape.
///
/// `FnMut` rather than `Fn` because the retry body mutates its own captured
/// counters (`notes`, `total_ms`, `settled`); a `Fn` closure cannot.
fn run_with_retries<F>(progress: &ProgressFn, attempts: u32, mut run_one: F)
where
    F: FnMut(u32) -> bool,
{
    for attempt in 1..=attempts {
        // The closure drives the attempt; `true` settles the layer and stops
        // the loop, `false` means "transient, keep retrying".
        let settled = run_one(attempt);
        if settled || attempt == attempts {
            return;
        }
        // Not settled and not the last attempt: pay the backoff, then loop.
        // attempt 1 pays 500 ms, attempt 2 pays 1000 ms — growing, so a
        // connection that is genuinely down cools off faster than one that
        // is flaky.
        let backoff_ms = RETRY_BACKOFF_MS * attempt as u64;
        progress(
            "clone",
            &format!("瞬时网络错误，{backoff_ms}ms 后重试…"),
        );
        std::thread::sleep(std::time::Duration::from_millis(backoff_ms));
    }
}

/// curl exit codes that mean "the network went wrong mid-transfer" rather
/// than "the URL is wrong / the file is missing / auth failed".
///
/// 28  = operation timeout
/// 52  = empty reply from server
/// 56  = receive failure (connection reset by peer)
///
/// These are the exact symptom the transient-retry loop exists to absorb.
/// They are a **secondary** classifier on top of the stderr string matching in
/// [`is_transient_failure`]: when git's stderr already names the symptom the
/// string match wins, and when the connection is reset in a way git does not
/// spell out (a bare `curl: (56)` with no English text) the code catches it.
const CURL_TRANSIENT_EXIT_CODES: &[i32] = &[28, 52, 56];

/// Classifies a failed git run as worth retrying.
///
/// Two signals, OR'd:
///   * **stderr string matching** — git's own words for a network reset.
///   * **curl exit code** — when the transport failed in a way that does not
///     show up in the stderr tail (curl bails with a bare exit code), the
///     exit code is the secondary transient signal.
///
/// Network resets and timeouts are the exact symptom of the intermittent
/// GitHub instability this downloader exists to absorb, so they are retried in
/// place before falling through to the next layer. Authentication and
/// protocol errors are NOT retried - retrying cannot help and only adds delay.
fn is_transient_failure(run: &GitRun) -> bool {
    let blob = format!("{} {}", run.stderr_tail, run.stdout_tail).to_ascii_lowercase();
    const TRANSIENT: &[&str] = &[
        "connection was reset",
        "recv failure",
        "could not connect to server",
        "connection timed out",
        "operation timed out",
        "the remote end hung up",
        "early eof",
        "rpc failed",
        "tls connection was non-properly terminated",
    ];
    if TRANSIENT.iter().any(|m| blob.contains(m)) {
        return true;
    }
    // Secondary signal: a known curl transient exit code. The stderr tail is
    // not always present (curl bails before printing a friendly message), so
    // the code is the only evidence of "this was a flake, not a 404".
    if let Some(code) = run.code {
        if CURL_TRANSIENT_EXIT_CODES.contains(&code) {
            return true;
        }
    }
    false
}

/// Same transient-keyword check as {@link is_transient_failure} but for the
/// `(ok, code, stderr, timed_out)` tuple that `run_pull` returns. A timed-out
/// pull is also transient: the connection hung and may succeed on retry.
fn is_transient_pull(stderr: &str, timed_out: bool) -> bool {
    if timed_out {
        return true;
    }
    let blob = stderr.to_ascii_lowercase();
    const TRANSIENT: &[&str] = &[
        "connection was reset",
        "recv failure",
        "could not connect to server",
        "connection timed out",
        "operation timed out",
        "the remote end hung up",
        "early eof",
        "rpc failed",
        "tls connection was non-properly terminated",
    ];
    TRANSIENT.iter().any(|m| blob.contains(m))
}

/// Redacts credentials from a URL before it goes into a log line. Anything in
/// the userinfo (`https://user:me@host/...` or an OAuth-style
/// `https://user:***@host/...`) must never reach the 详细日志.
fn redact_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let rest = &url[scheme_end + 3..];
    // Credentials live in the userinfo, which ends at the first `/`, `?` or `#`.
    // Scanning the whole remainder for `@` redacted — and destroyed — a path that
    // merely contains one: `https://github.com/a@b.git` came out as
    // `https://***@b.git`, losing the host and implying a token that was never
    // there. Both halves matter: the token must never reach the log, and a
    // redaction that eats the host makes the 详细日志 unusable for diagnosis.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{}://***@{}", &url[..scheme_end], &rest[at + 1..]),
        None => url.to_string(),
    }
}

/// GitHub's personal-access-token prefixes. A run starting with one of these is a
/// credential whatever the text around it is, so it gets masked on sight.
const CREDENTIAL_PREFIXES: [&str; 6] = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];

/// The characters that end a credential-shaped run inside free text.
fn is_run_break(c: char) -> bool {
    !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn mask_run(text: &str, from: usize) -> (String, usize) {
    let end = text[from..]
        .find(is_run_break)
        .map(|i| from + i)
        .unwrap_or(text.len());
    let mut out = String::new();
    out.push_str(&text[..from]);
    out.push_str("***");
    (out, end)
}

/// Masks credential-shaped runs in **arbitrary text** before it reaches a log line.
///
/// `redact_url` above answers "this string is a URL". The three call sites this exists for
/// are not URLs: a `-c key=value` list, git's stderr tail, and the `DEVHUB_DEBUG_ARGS`
/// argv dump. Each can carry a secret that the URL redactor would never see —
/// `-c http.extraHeader=Authorization: Bearer ghp_…` contains no `://` at all, and git
/// echoes a remote URL inside quotes in its own error text
/// (`fatal: Authentication failed for 'https://x-access-token:ghp_…@github.com/…'`).
///
/// Three rules, applied in order, and each one stops at a span boundary rather than
/// consuming the rest of the line: the predecessor's lesson is recorded above — a
/// redaction that eats the host makes the 详细日志 useless, so precision matters as much
/// as the masking.
///   1. every `<scheme>://<userinfo>@` inside the text, userinfo → `***`;
///   2. the *value* of `Authorization: …` and of `Bearer …` (case-insensitive);
///   3. any run beginning with a GitHub PAT prefix (`ghp_`, `gho_`, `ghu_`, `ghs_`,
///      `ghr_`, `github_pat_`).
///
/// This is a log-line sanitizer, not a validator: it does not decide whether a token is
/// well-formed, and it never rewrites anything that is not one of the three shapes.
pub(crate) fn redact_secrets(text: &str) -> String {
    let step1 = mask_inline_urls(text);
    let step2 = mask_auth_values(&step1);
    mask_prefixed_tokens(&step2)
}

/// Rule 1: URL userinfo inside free text.
fn mask_inline_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let after = scheme_end + 3;
        // The authority stops at the first path/query/quote/space — the same boundary
        // `redact_url` uses, plus the quote/space cases a URL inside a sentence needs.
        let span_end = rest[after..]
            .find(['/', '?', '#', ' ', '\t', '"', '\'', '`'])
            .map(|i| after + i)
            .unwrap_or(rest.len());
        out.push_str(&rest[..after]);
        match rest[after..span_end].rfind('@') {
            Some(at) => {
                out.push_str("***");
                // Only up to `span_end`: the authority ends there, and pushing the whole
                // remainder here would then push it a second time below, when the loop
                // resumes at `span_end`. That duplication is what this line looked like
                // before its own test caught it — `…@github.com/o/r.git/'/o/r.git/'`.
                out.push_str(&rest[after + at..span_end]);
            }
            None => out.push_str(&rest[after..span_end]),
        }
        rest = &rest[span_end..];
    }
    out.push_str(rest);
    out
}

/// Case-insensitive `find` that returns a **byte** offset in `hay`, searching from `from`.
///
/// Written by hand rather than as `hay.to_ascii_lowercase().find(needle)` because
/// `to_ascii_lowercase` on a `str` can change the byte length of the string (an `İ` in a
/// Windows path becomes two bytes when lower-cased), and every offset taken from the
/// lower-cased copy would then slice the original at a non-boundary and panic. All the
/// needles here are ASCII, and an ASCII byte can only begin at a char boundary.
fn find_ci(hay: &str, needle: &str, from: usize) -> Option<usize> {
    let hb = hay.as_bytes();
    let nb = needle.as_bytes();
    let mut i = from.min(hb.len());
    while i + nb.len() <= hb.len() {
        if hb[i..i + nb.len()].eq_ignore_ascii_case(nb) && hay.is_char_boundary(i) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Rule 2: the value after `Authorization:` / `Bearer`, not the key.
fn mask_auth_values(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0usize;
    loop {
        let auth = find_ci(text, "authorization:", from);
        let bearer = find_ci(text, "bearer ", from);
        let at = match (auth, bearer) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => break,
        };
        let value_start_raw = if Some(at) == auth {
            at + "authorization:".len()
        } else {
            at + "bearer ".len()
        };
        // Skip whitespace the writer left between the key and the value.
        let value_start = text[value_start_raw..]
            .find(|c: char| !c.is_whitespace())
            .map(|i| value_start_raw + i)
            .unwrap_or(text.len());
        // Already masked → leave it exactly as it is and move past it. Without this the
        // next pass would prepend another `***` in front of the existing one, because `*`
        // is a run break, so the value it finds is empty. Idempotence is cheap and it
        // means a line that goes through two log helpers is not silently re-written.
        if text[value_start..].starts_with("***") {
            out.push_str(&text[from..value_start + 3]);
            from = value_start + 3;
            continue;
        }
        let (masked, end) = mask_run(text, value_start);
        out.push_str(&text[from..value_start]);
        out.push_str(&masked[value_start..]);
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

/// Rule 3: any run that begins with a GitHub PAT prefix.
fn mask_prefixed_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0usize;
    loop {
        let tail = &text[from..];
        let mut best: Option<(usize, usize)> = None;
        for prefix in CREDENTIAL_PREFIXES {
            if let Some(rel) = tail.find(prefix) {
                let at = from + rel;
                if best.map(|(b, _)| at < b).unwrap_or(true) {
                    best = Some((at, prefix.len()));
                }
            }
        }
        let Some((at, len)) = best else { break };
        let keep = at + len;
        let (masked, end) = mask_run(text, keep);
        out.push_str(&text[from..keep]);
        out.push_str(&masked[keep..]);
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

/// Caps one log line so a chatty git stderr cannot flood the 详细日志.
fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

/// True when `git ls-remote`'s error text means "this repository is not
/// publicly readable" rather than "the network is broken". The distinction
/// decides between 仓库不存在或没有访问权限 and 网络错误, which need different
/// user actions.
/// What git itself says when the name is wrong or the repository is private.
///
/// Matched on the *phrase*, not on loose words. A bare `403` or `denied` also
/// comes out of a forward proxy that refused the CONNECT, and reporting that as
/// "the repository does not exist" sends the user to fix the name when the name
/// is fine — so the HTTP codes only count when git framed them as the remote's
/// answer to a repository request.
const MISSING_PHRASES: &[&str] = &[
    "not found",
    "does not exist",
    "no such repository",
    "repository not found",
    "could not read username",
    "could not read password",
    "authentication failed",
    "auth failed",
    "invalid username",
    "access denied",
    "permission denied",
];

/// Git's own wording for "the remote answered, and it refused this repository".
/// Paired with [`HTTP_STATUS_MISSING`] below so a status code alone is not enough.
///
/// Deliberately narrow: `access` is not in this list because `unable to access`
/// is git's phrasing for *any* transport failure, and `git` is not because it
/// appears in every URL.
const MISSING_REMOTE_CONTEXT: &[&str] = &["repository", "private", "permission"];

/// Bare HTTP statuses that mean the remote refused the repository — but only
/// when they arrive with the context above.
const HTTP_STATUS_MISSING: &[&str] = &["403", "404"];

fn looks_like_missing_repo(stderr: &str) -> bool {
    let blob = stderr.to_ascii_lowercase();
    if MISSING_PHRASES.iter().any(|m| blob.contains(m)) {
        return true;
    }
    // A status code on its own is not a diagnosis: a proxy that returns 403 for
    // the CONNECT is a network answer, not a repository answer.
    HTTP_STATUS_MISSING
        .iter()
        .any(|code| blob.contains(code))
        && MISSING_REMOTE_CONTEXT
            .iter()
            .any(|ctx| blob.contains(ctx))
}

/// How long the pre-download `git ls-remote` existence probe may take. It is a
/// single small HTTP exchange; 15 s of silence means the network is the
/// problem, not the repository.
const LS_REMOTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Runs `git ls-remote <url> HEAD`, bounded by `LS_REMOTE_TIMEOUT`.
///
/// `resolve` is `(host, ip)`: git is told to dial that address instead of asking
/// the system resolver, which is the only way to get past a `hosts` file that
/// points the repository host at this machine. It is the same
/// `http.curloptResolve` trick the download ladder uses, so the probe and the
/// download it is gating finally travel the same roads.
///
/// Returns `(ok, exit_code, stderr_summary, timed_out)`. Unlike
/// `run_git_streaming` this is a quiet probe: nothing is forwarded to the UI
/// line-by-line, only the summary goes to the log through the caller.
fn run_ls_remote(
    git: &Path,
    url: &str,
    proxy: Option<&str>,
    resolve: Option<(&str, &str)>,
    auth: Option<(&str, &str)>,
) -> (bool, Option<i32>, String, bool) {
    use std::io::Read;

    let mut cmd = git_cmd(git);
    if let Some(p) = proxy {
        // `-c` must precede the subcommand: `git -c http.proxy=… ls-remote …`.
        cmd.arg("-c").arg(format!("http.proxy={p}"));
    }
    if let Some((host, ip)) = resolve {
        cmd.arg("-c").arg(format!("http.curloptResolve={host}:443:{ip}"));
    }
    cmd.arg("ls-remote").arg(url).arg("HEAD");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    apply_git_auth(&mut cmd, auth);
    cmd.stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("无法启动 git: {e}"), false),
    };
    let mut stderr = child.stderr.take();

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut buf = Vec::new();
                if let Some(mut s) = stderr.take() {
                    let _ = s.read_to_end(&mut buf);
                }
                let text = truncate(&redact_secrets(crate::proc::decode_console(&buf).trim()), 400);
                return (status.success(), status.code(), text, false);
            }
            Ok(None) => {
                if started.elapsed() > LS_REMOTE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let mut buf = Vec::new();
                    if let Some(mut s) = stderr.take() {
                        let _ = s.read_to_end(&mut buf);
                    }
                    let text = crate::proc::decode_console(&buf);
                    let text = if text.trim().is_empty() {
                        format!("超过 {} 秒无响应", LS_REMOTE_TIMEOUT.as_secs())
                    } else {
                        truncate(text.trim(), 400)
                    };
                    return (false, None, text, true);
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => {
                // A failed `try_wait` leaves the child handle unusable but the
                // process still owned by us. Pair kill+wait exactly as the
                // timeout branch above does, so the child cannot outlive the
                // probe (same rule the gitboot extraction comment records).
                let _ = child.kill();
                let _ = child.wait();
                return (false, None, format!("等待 git 失败: {e}"), false);
            }
        }
    }
}

/// The repository's current HEAD, full hash. `None` when it is not a git
/// repository, has no commits yet, or git will not say.
///
/// Uses the memoised [`find_git`], so a wall of freshness badges does not walk
/// `PATH` once per tile (measured: 2.8 s uncached, 0 ms warm).
pub fn local_head(repo: &Path) -> Option<String> {
    let git = find_git(None)?;
    let out = git_cmd(std::path::Path::new(&git.path))
        .arg("-C")
        .arg(repo)
        .arg("rev-parse")
        .arg("HEAD")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// First 7 characters, the length git itself uses in its own output.
fn short_hash(h: &str) -> String {
    h.chars().take(7).collect()
}

/// How long one `git pull` layer may take. Generous next to
/// `LS_REMOTE_TIMEOUT` because a pull downloads real objects, but still
/// bounded: an unbounded child is how the old `verify_git` hang happened.
const PULL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// How long one streaming `git` run (the clone) may take. Deliberately far above
/// [`PULL_TIMEOUT`]: a first clone transfers the whole history, and a large
/// repository over a mirror legitimately runs for tens of minutes. It is not
/// unbounded, because the caller of `run_git_streaming` holds a download slot, its
/// progress sink and a reserved port block for the duration — which is how a stalled
/// connection used to park one of the parallel-download slots forever with no way for
/// the user to get it back.
const CLONE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

// ---------------------------------------------------------------------------
// Clone strategy (round 16, R1-3) — see docs/clone-strategy.md for the evidence
// ---------------------------------------------------------------------------

/// Is this clone source one where git ignores `--depth` and `--filter` outright?
///
/// Measured 2026-10-16 (`scripts/clone-bench.ps1`, phase A): cloning a **filesystem
/// path** takes git's local hard-link fast path, which copies the whole object store
/// and prints `warning: --depth is ignored in local clones; use file:// instead.` and
/// `warning: --filter is ignored in local clones; use file:// instead.` — with exit
/// code 0. The download then *looks* like a shallow/blobless one in the log because
/// the flag was passed, while being byte-for-byte a full clone.
///
/// `file://` is deliberately NOT treated as local here: it is the transport the
/// mirror/backup layer uses, it does honour `--depth`, and git's own warning names it
/// as the remedy.
pub fn source_ignores_clone_strategy(url: &str) -> bool {
    let u = url.trim();
    // An empty source is treated as "a place where the flags do nothing" rather than as
    // a remote. It cannot be cloned at all, so the only decision that is never wrong is
    // the one that adds no arguments — and this function is called before any URL
    // validation, so "not yet known to be valid" is exactly the state it sees.
    if u.is_empty() {
        return true;
    }
    // Any real URL scheme git understands is a network transport for this purpose.
    for scheme in ["http://", "https://", "ssh://", "git://", "file://", "ftps://"] {
        if u.to_ascii_lowercase().starts_with(scheme) {
            return false;
        }
    }
    // `git@host:path` and scp-style `ssh://…` syntax are remote even without an http
    // scheme; the tell is a colon after the `@`.
    if let Some(at) = u.find('@') {
        if u[at..].contains(':') {
            return false;
        }
    }
    // Whatever is left is a path on this machine (or a drive letter), i.e. the
    // hard-link fast path.
    true
}

/// Why a user-supplied branch name is not usable, or `None` when it is.
///
/// `git check-ref-format --branch` is the authority (it knows about refspec
/// grammar, `@{`, `.lock`, control characters …), but it is a subprocess; this
/// pure pre-check gives a useful message for the obvious cases and, more
/// importantly, rejects a leading `-` before it can be mistaken for an option.
pub fn branch_name_error(name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() {
        return None; // empty means "default branch", handled by the caller
    }
    if n.len() > 255 {
        return Some("分支名超过 255 个字符".to_string());
    }
    if n.starts_with('-') {
        return Some("分支名不能以 - 开头".to_string());
    }
    if n.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Some("分支名不能包含空白或控制字符".to_string());
    }
    if n.contains("..")
        || n.contains("@{")
        || n.contains('~')
        || n.contains('^')
        || n.contains(':')
        || n.contains('?')
        || n.contains('*')
        || n.contains('[')
        || n.contains('\\')
        || n.ends_with('/')
        || n.ends_with('.')
        || n.ends_with(".lock")
    {
        return Some("分支名包含 git 不允许的字符或后缀".to_string());
    }
    None
}

/// Runs git's own ref-format check. Returns the trimmed branch or `None` for
/// "default branch". Used before a clone so a malformed name fails with a
/// Git-shaped explanation instead of a confusing "remote branch not found".
fn validate_branch(git: &Path, raw: &str) -> Result<Option<String>, DownloadError> {
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if let Some(msg) = branch_name_error(name) {
        return Err(DownloadError::InvalidBranch(msg));
    }
    let out = crate::proc::output_timeout(
        git_cmd(git)
            .args(["check-ref-format", "--branch", name]),
        crate::proc::PROBE_TIMEOUT,
    )
    .map_err(|e| DownloadError::Io(format!("无法校验分支名: {e}")))?
    .ok_or_else(|| DownloadError::Timeout("校验分支名超时".to_string()))?;
    if !out.status.success() {
        return Err(DownloadError::InvalidBranch(format!(
            "git check-ref-format 拒绝了这个名字：{name}"
        )));
    }
    Ok(Some(name.to_string()))
}

/// The extra `git clone` arguments one strategy asks for, or none.
///
/// Kept a pure function of `(strategy, url)` precisely so the two rules that the
/// benchmark produced can be tested without a repository: which flags go in, and the
/// one that must never be silently dropped — the local-path case, where adding the
/// flag would buy nothing and make the log lie.
pub fn clone_strategy_args(strategy: &str, url: &str) -> Vec<String> {
    if source_ignores_clone_strategy(url) {
        return Vec::new();
    }
    match strategy.trim().to_ascii_lowercase().as_str() {
        // `full` (and anything unrecognised, and the empty default) clones completely.
        "shallow" => vec!["--depth".into(), "1".into()],
        "blobless" => vec!["--filter=blob:none".into()],
        _ => Vec::new(),
    }
}

/// Sentences git prints when it throws a strategy parameter away.
///
/// Every one of these was captured verbatim on 2026-10-16 on git 2.51.0.windows.1;
/// see the four `warn=` lines in `docs/clone-strategy.md` §3.2. The reason they are
/// the primary signal is that in all four measured cases **the clone exited 0**:
/// there is no failure to branch on, only a warning to notice.
const IGNORED_FILTER_MESSAGES: &[&str] = &[
    "filtering not recognized by server, ignoring",
    "--filter is ignored in local clones",
    "--depth is ignored in local clones",
];

/// What actually happened, as a sentence for the activity record. `None` = nothing to
/// say (the default full clone).
///
/// The three cases are deliberately answered with different confidence, because they
/// *have* different confidence and a launcher that reports all three as "成功" is
/// reporting two of them falsely:
///
///   * a warning says the parameter was ignored → **not applied**, stated flatly;
///   * `shallow` → provable locally and cheaply with `--is-shallow-repository`;
///   * `blobless` → **not provable from the working tree**. `.git/config` gets
///     `promisor = true` and `partialclonefilter = blob:none` written into it even
///     when the server ignored the filter (measured), so the config cannot be the
///     evidence, and counting objects would need a full `cat-file --batch-all-objects`
///     pass on every download. Absence of the warning is therefore reported as
///     "requested and nothing said against it", not as "confirmed".
///
/// `stderr_tail` is a *tail*: a warning pushed out of it by a long checkout is
/// possible, which is why the sentence never claims more than the probe supports.
pub fn clone_strategy_note(
    strategy: &str,
    stderr_tail: &str,
    git: &Path,
    repo: &Path,
) -> Option<String> {
    let s = strategy.trim().to_ascii_lowercase();
    if s.is_empty() || s == "full" {
        return None;
    }
    let ignored = IGNORED_FILTER_MESSAGES
        .iter()
        .find(|m| stderr_tail.contains(**m));
    if let Some(m) = ignored {
        return Some(format!(
            "按 {s} 请求克隆，但 git 明确忽略了该参数（原文：{m}），实际是完整克隆"
        ));
    }
    if s == "shallow" {
        return match is_shallow_repository(git, repo) {
            Some(true) => Some("按 shallow 请求克隆，已确认为浅克隆（历史被截断，读旧提交需先 git fetch --unshallow）".into()),
            Some(false) => Some(format!(
                "按 {s} 请求克隆，但仓库不是浅仓库 —— 参数没有生效，实际是完整克隆"
            )),
            None => Some(format!(
                "按 {s} 请求克隆，但克隆后无法向 git 确认状态，此条不作任何保证"
            )),
        };
    }
    if s == "blobless" {
        return Some(
            "按 blobless 请求克隆，git 没有报告过滤被忽略；**但这不能证明过滤生效**——服务器忽略 \
             --filter 时 .git/config 里的 promisor/partialclonefilter 照样被写入（实测）。读取旧 \
             文件内容可能需要网络。"
                .to_string(),
        );
    }
    Some(format!(
        "cloneStrategy「{s}」不是认识的值，按完整克隆处理"
    ))
}

/// `git rev-parse --is-shallow-repository`, or `None` when git would not say.
fn is_shallow_repository(git: &Path, repo: &Path) -> Option<bool> {
    let mut cmd = git_cmd(git);
    cmd.arg("-C")
        .arg(repo)
        .arg("rev-parse")
        .arg("--is-shallow-repository");
    let out = crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT).ok()??;
    if !out.status.success() {
        return None;
    }
    let text = crate::proc::decode_console(&out.stdout).trim().to_ascii_lowercase();
    match text.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Runs `git -C <repo> pull --ff-only`, bounded by [`PULL_TIMEOUT`].
///
/// `--ff-only` is deliberate: a diverged branch is a decision for the user,
/// and a silent merge commit created by a launcher is not something they asked
/// for. When it refuses, stderr says so and the update reports failure.
///
/// Returns `(ok, exit_code, stderr_summary, timed_out)`, the same shape as
/// [`run_ls_remote`] so the layer loop can treat them alike.
fn run_pull(
    git: &Path,
    repo: &Path,
    extra_cfg: &[String],
    auth: Option<(&str, &str)>,
) -> (bool, Option<i32>, String, bool) {
    use std::io::Read;

    let mut cmd = git_cmd(git);
    for c in extra_cfg {
        cmd.arg("-c").arg(c);
    }
    cmd.arg("-C")
        .arg(repo)
        .arg("pull")
        .arg("--ff-only")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    apply_git_auth(&mut cmd, auth);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("无法启动 git: {e}"), false),
    };
    let mut stderr = child.stderr.take();

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut buf = Vec::new();
                if let Some(mut s) = stderr.take() {
                    let _ = s.read_to_end(&mut buf);
                }
                let text = truncate(&redact_secrets(crate::proc::decode_console(&buf).trim()), 400);
                return (status.success(), status.code(), text, false);
            }
            Ok(None) => {
                if started.elapsed() > PULL_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let mut buf = Vec::new();
                    if let Some(mut s) = stderr.take() {
                        let _ = s.read_to_end(&mut buf);
                    }
                    let text = crate::proc::decode_console(&buf);
                    let text = if text.trim().is_empty() {
                        format!("超过 {} 秒无响应", PULL_TIMEOUT.as_secs())
                    } else {
                        truncate(text.trim(), 400)
                    };
                    return (false, None, text, true);
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => {
                // Same pairing as the timeout branch above: `try_wait` failing
                // does not mean the child is gone, only that we can no longer
                // ask it. Kill and reap before reporting.
                let _ = child.kill();
                let _ = child.wait();
                return (false, None, format!("等待 git 失败: {e}"), false);
            }
        }
    }
}

/// Runs `git ls-remote <url> HEAD` and returns the **hash** it printed.
///
/// [`run_ls_remote`] exists to answer yes/no and throws stdout away; the
/// freshness badge needs the actual commit id, which is why this is a second
/// function rather than a flag on the first. Same escape hatches (proxy, IP
/// pin), same timeout, same refusal to guess.
fn run_ls_remote_head(
    git: &Path,
    url: &str,
    proxy: Option<&str>,
    resolve: Option<(&str, &str)>,
    auth: Option<(&str, &str)>,
) -> Result<String, String> {
    use std::io::Read;

    let mut cmd = git_cmd(git);
    if let Some(p) = proxy {
        cmd.arg("-c").arg(format!("http.proxy={p}"));
    }
    if let Some((host, ip)) = resolve {
        cmd.arg("-c").arg(format!("http.curloptResolve={host}:443:{ip}"));
    }
    cmd.arg("ls-remote").arg(url).arg("HEAD");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    apply_git_auth(&mut cmd, auth);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(format!("无法启动 git: {e}")),
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out_buf = Vec::new();
                if let Some(mut s) = stdout.take() {
                    let _ = s.read_to_end(&mut out_buf);
                }
                if !status.success() {
                    let mut err_buf = Vec::new();
                    if let Some(mut s) = stderr.take() {
                        let _ = s.read_to_end(&mut err_buf);
                    }
                    let text = crate::proc::decode_console(&err_buf);
                    return Err(truncate(&redact_secrets(text.trim()), 400));
                }
                // `<sha>\tHEAD\n` - the first whitespace-separated field.
                let text = String::from_utf8_lossy(&out_buf);
                let hash = text.split_whitespace().next().unwrap_or("").trim();
                if hash.is_empty() {
                    return Err("git 未返回 HEAD".to_string());
                }
                return Ok(hash.to_string());
            }
            Ok(None) => {
                if started.elapsed() > LS_REMOTE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超过 {} 秒无响应", LS_REMOTE_TIMEOUT.as_secs()));
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(e) => {
                // See the timeout branch above: kill+wait is the contract for
                // every abandoned child in this file.
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 git 失败: {e}"));
            }
        }
    }
}

/// Counts commits between two revisions inside `repo`.
///
/// `None` when git cannot answer (a shallow or grafted history, or a repo with
/// no commits) - the caller must not print "0 个新提交" for that.
/// The first `limit` commits in `from..to`, newest last (git log's own order).
///
/// Same tolerance as [`count_commits`]: a shallow or grafted history, a missing
/// git, or a timeout yields an empty list rather than an error. The count is the
/// authoritative number; this list is the human-readable detail.
fn recent_commits(repo: &Path, from: &str, to: &str, limit: usize) -> Vec<CommitSummary> {
    if from.is_empty() || to.is_empty() || from == to {
        return Vec::new();
    }
    let Some(gh) = find_git(None) else {
        return Vec::new();
    };
    let range = format!("{from}..{to}");
    let mut cmd = git_cmd(std::path::Path::new(&gh.path));
    cmd.arg("-C")
        .arg(repo)
        .args([
            "log",
            "--format=%h%x09%s",
            "-n",
            &limit.to_string(),
            &range,
        ]);
    let Ok(Some(out)) = crate::proc::output_timeout(
        &mut cmd,
        std::time::Duration::from_secs(5),
    ) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    crate::proc::decode_console(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (hash, subject) = line.split_once('\t')?;
            Some(CommitSummary {
                hash: hash.trim().to_string(),
                subject: subject.trim().to_string(),
            })
        })
        .filter(|c| !c.hash.is_empty())
        .collect()
}

fn count_commits(repo: &Path, from: &str, to: &str) -> Option<u32> {
    let git = find_git(None)?;
    let out = git_cmd(std::path::Path::new(&git.path))
        .arg("-C")
        .arg(repo)
        .arg("rev-list")
        .arg("--count")
        .arg(format!("{from}..{to}"))
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    std::str::from_utf8(&out.stdout).ok()?.trim().parse().ok()
}

/// The repository's own `origin` URL, when it has one.
fn remote_origin_url(git: &Path, repo: &Path) -> Option<String> {
    let out = git_cmd(git)
        .arg("-C")
        .arg(repo)
        .arg("remote")
        .arg("get-url")
        .arg("origin")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The `url.<...>.insteadOf` rule that routes one pull through one mirror entry.
///
/// A pull fetches from the repository's configured remote, so a mirror has to
/// rewrite that URL rather than be handed to `clone` as an argument. Both
/// mirror spellings collapse into the same mechanism:
///
///   - a bare host (`hk.gh-proxy.com`) becomes
///     `url.hk.gh-proxy.com/.insteadOf=https://github.com/` - exactly the rule
///     the download ladder already builds for a clone;
///   - a full prefix (`https://gh-proxy.com/`) becomes
///     `url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/`,
///     the same prefix substitution written as one rule. Git treats the
///     subsection as an opaque string, colons and slashes included.
///
/// The trailing slash on the *original* is required: without it the rule does
/// not match and the URL is used as-is (measured, `DEVELOPMENT.md` §3).
fn mirror_instead_of(base: &str, host: &str) -> Vec<String> {
    let origin = format!("https://{host}/");
    if base.contains("://") {
        let normalized = format!("{}/", base.trim_end_matches('/'));
        vec![format!("url.{normalized}{origin}.insteadOf={origin}")]
    } else {
        let normalized = format!("{}/", base.trim_end_matches('/'));
        vec![format!("url.{normalized}.insteadOf={origin}")]
    }
}
/// `Receiving objects:  45% (1234/2740), 1.20 MiB` -> `45`.
///
/// This is **parsing**, not fabrication: the number is the one git printed. It is
/// used for the progress bar, while the full line still reaches the UI as a
/// single updating status line instead of hundreds of log entries.
fn progress_percent(line: &str) -> Option<u8> {
    let pct = line.find('%')?;
    let digits: String = line[..pct]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    digits.parse::<u8>().ok()
}

/// Runs git, streaming output to the UI as it arrives.
///
/// Terminates a child **and its existing descendants**, then reaps it.
///
/// The Job Object is the primary mechanism, but it only owns processes created
/// *after* `AssignProcessToJobObject`. `git` starts `git-remote-https` almost
/// immediately, and `cmd /C` starts its target before the assignment lands, so a
/// job close alone can leave an already-spawned grandchild holding the pipes —
/// the parent dies, the reader threads never see EOF, and the cancel appears to
/// hang. `taskkill /T` walks the parent chain at kill time, which covers exactly
/// that window. It is bounded, and its failure is ignored because `child.kill`
/// below is the last resort.
fn terminate_child_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut taskkill = crate::proc::silent("taskkill");
        taskkill.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        // Deliberate best-effort cleanup: a taskkill failure is already covered
        // by the child.kill below, and the caller is on a cancellation path that
        // must not turn into a second error surface.
        crate::proc::output_timeout(
            &mut taskkill,
            std::time::Duration::from_secs(2),
        )
        .ok();
    }
    child.kill().ok();
    child.wait().ok();
}

/// Two kinds of stderr arrive here:
///   * real messages (`Cloning into ...`, warnings, errors) -> stage `<stage>`
///   * in-place progress rewrites of one line, which git separates with `\r`
///     (`Receiving objects: 12% ...`) -> stage `<stage>-progress`
///
/// The split is what fixes "下载过程行数过多": a clone of a large repository
/// emits one progress rewrite per percent, so forwarding them all produced
/// hundreds of log lines. Progress ticks are throttled to one per percent, and
/// the UI shows them on a single updating line plus a progress bar.
fn run_git_streaming(
    progress: ProgressFn,
    git: &Path,
    args: &[String],
    cwd: Option<&Path>,
    stage: &str,
    auth: Option<(&str, &str)>,
    cancel: &CancelToken,
) -> Result<GitRun, DownloadError> {
    let mut cmd = git_cmd(git);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // Never let git block on an interactive credential prompt.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "");
    apply_git_auth(&mut cmd, auth);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| DownloadError::Io(format!("无法启动 git: {e}")))?;

    // Own the child's tree so a cancel (or an app crash) cannot leave
    // `git-remote-https` behind. Dropping the guard closes the job; on a normal
    // exit that close happens after the child is gone and is a no-op.
    let job = crate::proc::JobGuard::for_child(child.id());

    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    // git writes progress to stderr (it uses \r for in-place updates).
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let tx2 = tx.clone();
    let stage_s = stage.to_string();
    let progress_s = progress.clone();
    let h_err = stderr.map(|s| {
        std::thread::spawn(move || {
            let mut last_percent: Option<u8> = None;
            for chunk in BufReader::new(s).split(b'\r').flatten() {
                // git echoes paths back in the console codepage, and a Chinese
                // directory name in a progress line must not arrive mangled.
                let text = crate::proc::decode_console(&chunk).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                match progress_percent(&text) {
                    Some(pct) => {
                        // git rewrites one line in place. One tick per percent is
                        // enough for a bar and keeps the log readable.
                        if last_percent != Some(pct) {
                            last_percent = Some(pct);
                            progress_s(&format!("{stage_s}-progress"), &text);
                        }
                    }
                    None => {
                        // Not a progress rewrite: a real message, worth keeping.
                        let _ = tx.send((true, text.clone()));
                        progress_s(&stage_s, &text);
                    }
                }
            }
        })
    });
    let progress_o = progress.clone();
    let stage_o = stage.to_string();
    let h_out = stdout.map(|s| {
        std::thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                let text = line.trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let _ = tx2.send((false, text.clone()));
                progress_o(&stage_o, &text);
            }
        })
    });

    // Bounded, in the same shape as `run_pull`: `child.wait()` here had no deadline
    // at all, so a clone whose connection went silent neither finished nor failed —
    // it just stayed. Polling `try_wait` keeps the two reader threads streaming
    // progress the whole time, which an unbounded wait also did.
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel.is_cancelled() {
                    // `drop(job)` is the atomic kill for the whole tree; the
                    // `child.kill()` below covers the fallback where job
                    // assignment failed, and `wait` reaps the root handle.
                    drop(job);
                    terminate_child_tree(&mut child);
                    if let Some(h) = h_err {
                        h.join().ok();
                    }
                    if let Some(h) = h_out {
                        h.join().ok();
                    }
                    return Err(DownloadError::Cancelled);
                }
                if started.elapsed() > CLONE_TIMEOUT {
                    drop(job);
                    terminate_child_tree(&mut child);
                    if let Some(h) = h_err {
                        h.join().ok();
                    }
                    if let Some(h) = h_out {
                        h.join().ok();
                    }
                    return Err(DownloadError::Timeout(format!(
                        "clone 超过 {} 分钟仍未结束，已中止",
                        CLONE_TIMEOUT.as_secs() / 60
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                // The old early return skipped both cleanups that every other
                // abandoned path here performs: the child (kill+wait) and the
                // two reader threads still parked on its pipes (join). A
                // `try_wait` error is not "the process is gone" — it is "we
                // can no longer ask", and the handle still owns everything.
                drop(job);
                terminate_child_tree(&mut child);
                if let Some(h) = h_err {
                    let _ = h.join();
                }
                if let Some(h) = h_out {
                    let _ = h.join();
                }
                return Err(DownloadError::Io(e.to_string()));
            }
        }
    };
    if let Some(h) = h_err {
        let _ = h.join();
    }
    if let Some(h) = h_out {
        let _ = h.join();
    }
    drop(job);

    let mut err_lines: Vec<String> = Vec::new();
    let mut out_lines: Vec<String> = Vec::new();
    while let Ok((is_err, line)) = rx.try_recv() {
        if is_err {
            err_lines.push(line);
        } else {
            out_lines.push(line);
        }
    }
    let tail = |v: &[String]| {
        v.iter()
            .rev()
            .take(4)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    };

    Ok(GitRun {
        ok: status.success(),
        code: status.code(),
        stderr_tail: tail(&err_lines),
        stdout_tail: tail(&out_lines),
    })
}

// ---------------------------------------------------------------------------
// The downloader
// ---------------------------------------------------------------------------

/// Refuses a landing directory whose own path is close enough to MAX_PATH that
/// a checkout cannot work, with a message that says what to shorten.
///
/// `core.longpaths` (see [`git_cmd`]) fixes long paths *inside* a repository; it
/// cannot fix the clone target, because git has to change into that directory
/// before it can read any config. Measured 2026-10-28: cloning into a 297-char
/// target exits 128 with "Clone succeeded, but checkout failed / this operation
/// must be run in a work tree", leaving a repository-shaped directory with an
/// empty work tree. A preflight refusal is the honest alternative to that
/// half-success. 240 leaves room for `.git` and the first checked-out file.
#[cfg(windows)]
pub fn target_path_length_error(path: &Path) -> Option<String> {
    let len = path.to_string_lossy().chars().count();
    if len <= 240 {
        return None;
    }
    Some(format!(
        "目标落位路径有 {len} 个字符，超过了 Windows 传统 260 字符限制的可用余量。\
         请缩短项目目录或落位名（应用已对仓库内部文件启用 core.longpaths，但 git 无法先进入这么长的目录）。"
    ))
}

#[cfg(not(windows))]
pub fn target_path_length_error(_path: &Path) -> Option<String> {
    None
}

/// True when a directory exists and holds nothing at all.
///
/// An empty directory is a *placeholder*, not a repository: an interrupted
/// clone, a directory the user made by hand, or — the case this exists for —
/// one that `reveal_path` created so the add view could show the landing
/// directory in Explorer before anything was downloaded. Cloning into it is
/// right; renaming the download out of it is not.
///
/// A directory that cannot be read is reported as non-empty, because the safe
/// answer to "I cannot tell" is "do not touch it".
pub fn dir_is_empty(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
}

/// True when `path` is something a download must not be aimed at.
///
/// The distinction matters because the add view reveals the landing directory
/// before downloading, and revealing it creates it. `exists()` alone therefore
/// reports a conflict on a directory the app itself just made, and the download
/// is either refused or silently redirected to a host-suffixed path.
pub fn is_occupied(path: &std::path::Path) -> bool {
    if !path.exists() {
        return false;
    }
    !(path.is_dir() && dir_is_empty(path))
}

pub struct Downloader {
    pub config: DownloaderConfig,
    pub git: GitLocation,
    /// Set by `download_repo` when the UI may cancel this task. Headless and
    /// test callers keep the default token, which is never cancelled.
    cancel: CancelToken,
}

impl Downloader {
    pub fn new(
        config: DownloaderConfig,
        bundled_runtime: Option<PathBuf>,
    ) -> Result<Self, DownloadError> {
        let git = find_git(bundled_runtime.as_deref()).ok_or(DownloadError::GitMissing)?;
        Ok(Self {
            config,
            git,
            cancel: CancelToken::default(),
        })
    }

    /// Wires the command's cancellation handle into this downloader.
    pub fn with_cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = cancel;
        self
    }

    /// One check used at every ladder boundary. Returning the error rather than
    /// a bool keeps the call sites to `self.check_cancelled()?`.
    fn check_cancelled(&self) -> Result<(), DownloadError> {
        if self.cancel.is_cancelled() {
            Err(DownloadError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// `<root>/<repo>_<owner>` under the project root.
    ///
    /// If that name is already taken by a *different* repository - only possible
    /// across hosts, because the owner is part of the name - the host is appended
    /// rather than overwriting the first repository or refusing a legitimate
    /// download. If it is taken by *this* repository the primary path is returned
    /// and `download` reports the existing-directory conflict, which is the
    /// honest outcome.
    ///
    /// An existing but **empty** directory is treated as free. It used to fall
    /// through to the host-suffixed name, which made the download land somewhere
    /// other than the path the add view had just shown: the view's 落位 row
    /// reveals the landing directory in Explorer, and revealing it creates the
    /// directory first, so one click on the preview silently moved every later
    /// download to `<repo>_<owner>_<host>`.
    pub fn target_path(&self, r: &RepoRef) -> PathBuf {
        let root = &self.config.project_root;
        let primary = root.join(r.dir_name());
        if !primary.exists() {
            return primary;
        }
        let mine = read_marker(&primary)
            .map(|m| normalize_slug(&m.slug) == normalize_slug(&r.slug()))
            .unwrap_or(false);
        if mine {
            return primary;
        }
        if dir_is_empty(&primary) {
            return primary;
        }
        root.join(format!(
            "{}_{}",
            r.dir_name(),
            sanitize_component(&r.host)
        ))
    }

    pub fn download(
        &self,
        progress: ProgressFn,
        input: &str,
    ) -> Result<DownloadOutcome, DownloadError> {
        self.download_to(progress, input, None, false, None)
    }

    /// Like `download`, but the caller names the landing directory explicitly.
    ///
    /// `target_override` replaces the computed `<root>/<repo>_<owner>` path
    /// (the frontend's 高级选项 editor shows and edits it). An empty or
    /// whitespace value means "use the computed path", so callers can pass the
    /// user's text field through without a second check.
    ///
    /// `overwrite` is the re-download path (round 11, 需求 8.7): when the
    /// landing directory is already occupied, an occupied directory used to end
    /// the download with `TargetExists` and the only way forward was 清理 →
    /// 删除 → download again. With `overwrite` the caller has already shown the
    /// user what is there and they confirmed, so the directory is replaced. The
    /// old **port block is preserved** - a re-download changes the code, not the
    /// repository's identity, and `REQUIREMENTS.md` §3.6 promises ports
    /// "永不漂移".
    /// Runs a download, then always hands back the port blocks it reserved.
    ///
    /// `allocate()` reserves *before* attempting, and the ladder can attempt four
    /// layers, so a call that ended in `AllLayersFailed` had already burned up to four
    /// segments for the life of the process. Success needs no reservation any more
    /// either: `finish` has written `.devhub.json`, and `allocate` scans those markers.
    pub fn download_to(
        &self,
        progress: ProgressFn,
        input: &str,
        target_override: Option<&str>,
        overwrite: bool,
        branch: Option<&str>,
    ) -> Result<DownloadOutcome, DownloadError> {
        self.check_cancelled()?;
        let mut session: Vec<u16> = Vec::new();
        // (landing path, path the pre-existing copy was moved to). See
        // `download_inner`'s overwrite branch for why the old copy is renamed
        // aside rather than deleted up front.
        let mut stashed: Option<(PathBuf, PathBuf)> = None;
        let outcome = self.download_inner(
            progress.clone(),
            input,
            target_override,
            overwrite,
            branch,
            &mut session,
            &mut stashed,
        );
        // Reached on every exit path, `?` included — a download that did not land is
        // precisely the case where the reservation must not stay behind.
        let released = release_blocks(&session);
        if released > 0 {
            progress(
                "debug",
                &format!("已归还 {released} 个本次未落地的端口段预留"),
            );
        }
        if let Some((target, backup)) = stashed {
            if outcome.is_ok() {
                let _ = std::fs::remove_dir_all(&backup);
            } else {
                // The ladder failed. Put the user's copy back where it was; a
                // partial clone (the failed attempt's wreckage) has to move out of
                // the way first, and if even that fails the old copy is still on
                // disk at `backup` — which is said out loud rather than swallowed.
                let _ = std::fs::remove_dir_all(&target);
                match std::fs::rename(&backup, &target) {
                    Ok(_) => progress(
                        "clone",
                        "所有下载层均失败，已恢复覆盖前的原目录",
                    ),
                    Err(e) => progress(
                        "clone",
                        &format!(
                            "所有下载层均失败，且原目录无法移回 {}（{e}）；它仍在 {}",
                            target.display(),
                            backup.display()
                        ),
                    ),
                }
            }
        }
        outcome
    }

    fn download_inner(
        &self,
        progress: ProgressFn,
        input: &str,
        target_override: Option<&str>,
        overwrite: bool,
        branch: Option<&str>,
        session: &mut Vec<u16>,
        stashed: &mut Option<(PathBuf, PathBuf)>,
    ) -> Result<DownloadOutcome, DownloadError> {
        let r = parse_ref(input)?;
        let mut effective_branch =
            validate_branch(std::path::Path::new(&self.git.path), branch.unwrap_or(""))?;
        let target = match target_override.map(str::trim).filter(|s| !s.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => self.target_path(&r),
        };
        if let Some(msg) = target_path_length_error(&target) {
            return Err(DownloadError::Io(msg));
        }
        // `is_occupied`, not `exists`: the add view reveals the landing directory
        // in Explorer before downloading, and the directory it reveals is created
        // first, so a plain `exists()` check refused (or silently renamed) a
        // download into a directory the app itself had just made.
        //
        // The one exception is a confirmed re-download, which takes the port
        // block with it so the numbers do not move.
        let mut preserved_ports: Option<PortBlock> = None;
        if is_occupied(&target) {
            if !overwrite {
                return Err(DownloadError::TargetExists(target));
            }
            progress("clone", "目标目录已存在，按确认覆盖重新下载…");
            if let Some(old) = read_marker(&target) {
                if old.port_base > 0 {
                    preserved_ports = Some(PortBlock {
                        base: old.port_base,
                        services: old.services,
                    });
                }
                // A re-download without a new branch keeps the branch the user
                // originally chose. Silently landing on the default branch would
                // change the code under the same directory and same port block.
                if effective_branch.is_none() {
                    effective_branch = old.branch.clone();
                }
            }
            // Moved aside, not deleted. The four-layer ladder can still fail
            // completely after this point (offline, every mirror down, the
            // existence check refusing), and deleting up front meant a confirmed
            // re-download could end with the user holding neither the new copy nor
            // the one they agreed to overwrite. `download_to` puts it back when the
            // ladder fails and removes it when it lands.
            //
            // The name starts with a dot on purpose: `RESERVED_ROOT_DIRS` and the
            // root scan skip anything dotted, so a stashed copy cannot be mistaken
            // for a project by the wall, the cache scan, or a clean-up pass.
            let backup = target
                .parent()
                .map(|p| {
                    let name = target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "repo".to_string());
                    p.join(format!(".devhub-previous-{name}-{}", std::process::id()))
                })
                .ok_or_else(|| {
                    DownloadError::Io("目标目录没有父目录，无法为它安排临时位置".to_string())
                })?;
            std::fs::rename(&target, &backup).map_err(|e| {
                DownloadError::Io(format!(
                    "无法把已存在的 {} 暂存到 {}: {e}",
                    target.display(),
                    backup.display()
                ))
            })?;
            *stashed = Some((target.clone(), backup));
        }
        // The parse stage is what the "详细日志不详细" report was missing: the
        // resolved URL, the slug and the landing path are all decisions the
        // downloader makes silently before any network traffic happens.
        progress("parse", &format!("输入解析为 {}/{}（{}）", r.owner, r.repo, r.host));
        progress("parse", &format!("目标地址 {}", redact_url(&r.https_url())));
        progress("parse", &format!("落位目录 {}", target.display()));
        // Its own stage, not just a `parse` line: the status strip wants to offer
        // "打开落位目录" *while* the download runs, and the frontend must not
        // have to reconstruct `<repo>_<owner>` from the slug to know where that
        // is. One event, carrying the path the downloader actually chose.
        progress("landing", &target.to_string_lossy());
        // Existence proof before any directory is created: a typo'd slug used
        // to cost a full four-layer download attempt plus a half-created
        // directory. Local repositories skip this - parse_ref already proved
        // the path exists.
        if !r.is_local() {
            self.check_remote_exists(&progress, &r)?;
        }
        // The existence probe is bounded but can take 15 s; honour a cancel
        // before it creates the landing directory.
        self.check_cancelled()?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| DownloadError::Io(format!("无法创建 {}: {e}", parent.display())))?;
        }

        let mut attempts: Vec<AttemptRecord> = Vec::new();

        progress(
            "debug",
            &format!(
                "回退计划：直连 → {} → 本地代理 → {}",
                if self.config.allow_ip_pin { "IP 钉死" } else { "IP 钉死（已禁用）" },
                if self.config.allow_third_party { "第三方镜像" } else { "第三方镜像（未启用）" },
            ),
        );

        // A local repository needs no DNS, proxy or mirror: one clone attempt is
        // the whole story.
        if r.is_local() {
            if let Some(a) = self.try_git(
                progress.clone(),
                &r,
                &target,
                DownloadLayer::Direct,
                "本地路径",
                &[],
                None,
                effective_branch.as_deref(),
            )? {
                if a.ok {
                    progress("debug", "选定链路：本地路径（本地仓库单层克隆）");
                    let alloc = self.block_or_preserved(&preserved_ports, session)?;
                    return self.finish(
                        DownloadLayer::Direct,
                        &target,
                        &r.slug(),
                        &r.https_url(),
                        &alloc,
                        vec![a],
                        false,
                        false,
                        effective_branch.as_deref(),
                    );
                }
                attempts.push(a);
            }
            return Err(DownloadError::AllLayersFailed(attempts));
        }

        // ---- Route decision: how the ladder starts --------------------------
        //
        // `route` only moves the STARTING point; the order below is untouched.
        // `auto` (the default) follows a living accelerator and bypasses a dead
        // one; `bypass` always skips the direct dial when hosts is hijacked and
        // IP-pinning can replace it; `useHosts` keeps the direct-first ladder.
        // The probe is a short TCP connect to the loopback target hosts points
        // at — refused instantly when nothing listens.
        let hosts_state = crate::netpath::read_hosts_state();
        let hijack = if hosts_state.hijacked {
            crate::netpath::probe_hijack_target(std::time::Duration::from_millis(800))
        } else {
            None
        };
        let route = if self.config.route.is_empty() {
            "auto"
        } else {
            self.config.route.as_str()
        };
        let skip_direct = match (route, hijack.as_ref()) {
            ("useHosts", _) => {
                progress(
                    "debug",
                    if hijack.is_some() {
                        "下载链路：沿用加速（按设置）——直连先试"
                    } else {
                        "下载链路：直连先试（hosts 无劫持）"
                    },
                );
                false
            }
            ("bypass", Some(p)) => {
                let can_pin = self.config.allow_ip_pin && resolve_agreed_ip(&r.host).is_some();
                if can_pin {
                    progress(
                        "debug",
                        &format!(
                            "下载链路：绕过——hosts 指向 {}，跳过直连，从 IP 钉死层开始（保留证书校验）",
                            p.addr
                        ),
                    );
                    true
                } else {
                    progress("debug", "下载链路：绕过——IP 钉死不可用，直连先试");
                    false
                }
            }
            ("bypass", None) => {
                progress("debug", "下载链路：绕过——hosts 无劫持，直连先试");
                false
            }
            (_, Some(p)) if p.online => {
                progress(
                    "debug",
                    &format!(
                        "下载链路：自动——加速器 {} 在线，直连先试（经本地加速）",
                        p.addr
                    ),
                );
                false
            }
            (_, Some(p)) => {
                let can_pin = self.config.allow_ip_pin && resolve_agreed_ip(&r.host).is_some();
                if can_pin {
                    progress(
                        "debug",
                        &format!(
                            "下载链路：自动——加速器 {} 不在线，跳过直连直接 IP 钉死",
                            p.addr
                        ),
                    );
                    true
                } else {
                    progress(
                        "debug",
                        &format!(
                            "下载链路：自动——加速器 {} 不在线且 IP 钉死不可用，直连先试",
                            p.addr
                        ),
                    );
                    false
                }
            }
            (_, None) => {
                progress("debug", "下载链路：自动——hosts 无劫持，直连先试");
                false
            }
        };

        // ---- Layer 1: direct ------------------------------------------------
        // Skipped only when the route decision says the direct dial is doomed
        // (a hijacked hosts whose accelerator is not answering, or an explicit
        // bypass with pinning available).
        if !skip_direct {
            if let Some(a) = self.try_git(
                progress.clone(),
                &r,
                &target,
                DownloadLayer::Direct,
                "直连",
                &[],
                None,
                effective_branch.as_deref(),
            )? {
                if a.ok {
                    progress("debug", "选定链路：直连（成功，无需回退）");
                    let alloc = self.block_or_preserved(&preserved_ports, session)?;
                    return self.finish(
                        DownloadLayer::Direct,
                        &target,
                        &r.slug(),
                        &r.https_url(),
                        &alloc,
                        attempts,
                        false,
                        false,
                        effective_branch.as_deref(),
                    );
                }
                attempts.push(a);
            }
        }

        // ---- Layer 2: IP-pinned, certificate validation preserved -----------
        if self.config.allow_ip_pin {
            progress("resolve", "直连失败，尝试交叉校验 DNS 解析…");
            if let Some(ip) = resolve_agreed_ip(&r.host) {
                progress("resolve", &format!("多个公共 DNS 一致解析为 {ip}"));
                let pin = format!("http.curloptResolve={}:443:{}", r.host, ip);
                // URL keeps the real hostname -> SNI and cert validation stay on.
                if let Some(a) = self.try_git(
                    progress.clone(),
                    &r,
                    &target,
                    DownloadLayer::IpPinned,
                    &format!("IP 钉死 ({ip}，保留证书校验)"),
                    &[pin],
                    None,
                    effective_branch.as_deref(),
                )? {
                    if a.ok {
                        progress("debug", &format!("选定链路：IP 钉死 ({ip})（直连失败，公共 DNS 一致）"));
                        let alloc = self.block_or_preserved(&preserved_ports, session)?;
                        return self.finish(
                            DownloadLayer::IpPinned,
                            &target,
                            &r.slug(),
                            &r.https_url(),
                            &alloc,
                            attempts,
                            false,
                            false,
                            effective_branch.as_deref(),
                        );
                    }
                    attempts.push(a);
                }
            } else {
                // Say *why* there was nothing to pin, because the two cases need
                // different fixes and the user is the only one who can tell them
                // apart. Observed on 2026-10-07: Watt Toolkit had left its hosts
                // entries in place but was no longer serving :443, so 直连 failed
                // against loopback and the pin layer had no public answer to use
                // either — "未取得一致结果" made that look like a DNS flake.
                let hosts = crate::netpath::read_hosts_state();
                let detail = if hosts.hijacked {
                    format!(
                        "没有可用的公网地址可钉：{} 把 GitHub 指向了本机，公共 DNS 的答案也不是公网地址。\
                         要么让该工具恢复服务，要么清掉 hosts 里它写的那 {} 条。",
                        hosts.owner.as_deref().unwrap_or("本地加速工具"),
                        hosts.redirect_count
                    )
                } else {
                    "公共 DNS 未取得一致结果，为安全起见放弃钉死".to_string()
                };
                attempts.push(AttemptRecord {
                    layer: DownloadLayer::IpPinned,
                    label: "IP 钉死".into(),
                    ok: false,
                    detail,
                    ms: 0,
                });
            }
        }

        // ---- Layer 3: discovered local proxy -------------------------------
        progress("proxy", "探测本地代理…");
        if let Some(proxy) = discover_local_proxy(&self.config.extra_proxies) {
            progress("proxy", &format!("发现本地代理 {proxy}"));
            let cfg = format!("http.proxy={proxy}");
            if let Some(a) = self.try_git(
                progress.clone(),
                &r,
                &target,
                DownloadLayer::LocalProxy,
                &format!("本地代理 {proxy}（仅本次调用，不写全局配置）"),
                &[cfg],
                None,
                effective_branch.as_deref(),
            )? {
                if a.ok {
                    progress("debug", &format!("选定链路：本地代理 {proxy}（前两层失败，代理可用）"));
                    let alloc = self.block_or_preserved(&preserved_ports, session)?;
                    return self.finish(
                        DownloadLayer::LocalProxy,
                        &target,
                        &r.slug(),
                        &r.https_url(),
                        &alloc,
                        attempts,
                        false,
                        false,
                        effective_branch.as_deref(),
                    );
                }
                attempts.push(a);
            }
        } else {
            attempts.push(AttemptRecord {
                layer: DownloadLayer::LocalProxy,
                label: "本地代理".into(),
                ok: false,
                detail: "未发现监听中的本地代理端口".into(),
                ms: 0,
            });
        }

        // ---- Layer 4: third-party mirror (opt-in) ---------------------------
        if self.config.allow_third_party {
            for base in &self.config.mirrors {
                // A mirror entry is either a full URL prefix
                // ("https://gh-proxy.com/https://github.com/o/r.git") or a bare
                // host mapped through url.<base>.insteadOf, which keeps the URL
                // parseable while git rewrites it.
                let mut cfg: Vec<String> = Vec::new();
                let prefix = if base.contains("://") {
                    Some(format!("{base}{}", r.https_url()))
                } else {
                    let normalized = format!("{}/", base.trim_end_matches('/'));
                    let origin = format!("https://{}/", r.host);
                    cfg.push(format!("url.{normalized}.insteadOf={origin}"));
                    None
                };
                let prefix_text = prefix.clone().unwrap_or_else(|| r.https_url());

                if let Some(a) = self.try_git(
                    progress.clone(),
                    &r,
                    &target,
                    DownloadLayer::Mirror,
                    &format!("第三方镜像 {base}（代码经由第三方传输）"),
                    &cfg,
                    prefix.as_deref(),
                    effective_branch.as_deref(),
                )? {
                    if a.ok {
                        progress("debug", &format!("选定链路：第三方镜像 {base}（前三层失败，用户已启用）"));
                        let alloc = self.block_or_preserved(&preserved_ports, session)?;
                        return self.finish(
                            DownloadLayer::Mirror,
                            &target,
                            &r.slug(),
                            &r.https_url(),
                            &alloc,
                            attempts,
                            false,
                            true,
                            effective_branch.as_deref(),
                        );
                    }
                    let mut rec = a;
                    rec.detail = format!("{} url={prefix_text}", rec.detail);
                    attempts.push(rec);
                }
            }
        } else {
            attempts.push(AttemptRecord {
                layer: DownloadLayer::Mirror,
                label: "第三方镜像".into(),
                ok: false,
                detail: "第三方镜像未启用（默认关闭以免代码经由第三方传输）".into(),
                ms: 0,
            });
        }

        self.check_cancelled()?;
        Err(DownloadError::AllLayersFailed(attempts))
    }

    /// Updates an existing clone with `git pull --ff-only`, through the same
    /// ladder a download uses.
    ///
    /// Why `--ff-only` and not a plain pull: a fast-forward is the only update
    /// that cannot surprise the user. A diverged branch or a dirty tree is
    /// reported as a failure carrying git's own words, not resolved for them -
    /// "propose, never auto-run" is the rule the launch flow already follows.
    ///
    /// The port block is deliberately **not** re-allocated: an update changes
    /// commits, not identity, and `REQUIREMENTS.md` §3.6 promises ports
    /// "永不漂移". Only `last_pull` moves.
    ///
    /// `overwrite` is not offered here on purpose: an update never deletes
    /// anything, so there is nothing to confirm.
    pub fn update(
        &self,
        progress: ProgressFn,
        repo: &Path,
    ) -> Result<UpdateOutcome, DownloadError> {
        let git = std::path::Path::new(&self.git.path);
        if !repo.join(".git").exists() {
            return Err(DownloadError::Io(
                "这个目录没有 git 历史（压缩包下载的仓库），无法更新，只能重新下载".to_string(),
            ));
        }
        let before = local_head(repo).unwrap_or_default();
        progress("update", &format!("当前版本 {}", short_hash(&before)));

        // Which remote to pull: the marker's URL when it has one - that is the
        // URL the download actually used, before any mirror rewrite - and the
        // repository's own `origin` otherwise.
        let marker = read_marker(repo);
        let url = marker
            .as_ref()
            .map(|m| m.url.clone())
            .filter(|u| !u.is_empty())
            .or_else(|| remote_origin_url(git, repo))
            .ok_or_else(|| {
                DownloadError::Io("找不到远程地址：.devhub.json 和 git remote 都没有".to_string())
            })?;
        let r = parse_ref(&url)?;
        progress("update", &format!("远程 {}", redact_url(&r.https_url())));

        // The ladder, in the same order the download uses. Only the starting
        // shape differs: a pull has no landing directory to prepare.
        //
        // The last field says whether this layer may receive the GitHub
        // credential. It is false for the mirror layer on purpose: a bare-host
        // mirror rewrites the github.com URL through `url.<base>.insteadOf`, and
        // a token that followed that rewrite would be handed to a third party.
        let mut ladder: Vec<(DownloadLayer, String, Vec<String>, bool, bool)> =
            vec![(DownloadLayer::Direct, "直连".into(), Vec::new(), false, true)];
        if self.config.allow_ip_pin {
            if let Some(ip) = resolve_agreed_ip(&r.host) {
                ladder.push((
                    DownloadLayer::IpPinned,
                    format!("IP 钉死 ({ip}，保留证书校验)"),
                    vec![format!("http.curloptResolve={}:443:{}", r.host, ip)],
                    false,
                    true,
                ));
            } else {
                progress("debug", "IP 钉死不可用：多个公共 DNS 未就一个公网地址达成一致");
            }
        }
        if let Some(proxy) = discover_local_proxy(&self.config.extra_proxies) {
            ladder.push((
                DownloadLayer::LocalProxy,
                format!("本地代理 {proxy}（仅本次调用，不写全局配置）"),
                vec![format!("http.proxy={proxy}")],
                false,
                true,
            ));
        }
        if self.config.allow_third_party {
            for base in &self.config.mirrors {
                ladder.push((
                    DownloadLayer::Mirror,
                    format!("第三方镜像 {base}（代码经由第三方传输）"),
                    mirror_instead_of(base, &r.host),
                    true,
                    false,
                ));
            }
        }

        // Built once: the token never changes during one update. `None` for a
        // non-github host or an empty token.
        let auth = github_auth_cfg(&r.https_url(), &self.config.github_token);
        let mut attempts: Vec<AttemptRecord> = Vec::new();
        for (layer, label, cfg, via_third_party, may_auth) in ladder {
            progress("update", &format!("尝试：{label}"));
            let auth_ref = if may_auth {
                auth.as_ref().map(|(k, v)| (*k, v.as_str()))
            } else {
                None
            };
            let mut last_result: Option<(bool, Option<i32>, String, bool)> = None;
            for attempt in 1..=RETRY_ATTEMPTS {
                let (ok, code, stderr, timed_out) = run_pull(git, repo, &cfg, auth_ref);
                last_result = Some((ok, code, stderr.clone(), timed_out));
                if ok {
                    if attempt > 1 {
                        progress(
                            "debug",
                            &format!("{label} 第 {attempt} 次成功"),
                        );
                    }
                    return self.finish_update(layer, repo, &before, attempts, via_third_party);
                }
                let transient = is_transient_pull(&stderr, timed_out);
                if !transient {
                    progress(
                        "debug",
                        &format!("{label}：非瞬时错误，不再重试本层"),
                    );
                    break;
                }
                if attempt < RETRY_ATTEMPTS {
                    progress(
                        "debug",
                        &format!(
                            "{label} 第 {attempt} 次瞬时失败，{RETRY_BACKOFF_MS}ms 后重试"
                        ),
                    );
                    std::thread::sleep(std::time::Duration::from_millis(RETRY_BACKOFF_MS));
                }
            }
            let (_ok, code, stderr, timed_out) = last_result
                .unwrap_or((false, None, String::new(), false));
            let detail = if timed_out {
                format!("超过 {} 秒无响应", PULL_TIMEOUT.as_secs())
            } else if stderr.is_empty() {
                format!("git 退出码 {:?}，无诊断输出", code)
            } else {
                stderr
            };
            progress("debug", &format!("{label} 失败：{detail}"));
            attempts.push(AttemptRecord {
                layer,
                label,
                ok: false,
                detail,
                ms: 0,
            });
        }
        Err(DownloadError::AllLayersFailed(attempts))
    }

    /// Completes a successful update: counts what arrived and stamps
    /// `last_pull` into the existing marker, leaving every other field alone.
    fn finish_update(
        &self,
        layer: DownloadLayer,
        repo: &Path,
        before: &str,
        mut attempts: Vec<AttemptRecord>,
        via_third_party: bool,
    ) -> Result<UpdateOutcome, DownloadError> {
        let after = local_head(repo).unwrap_or_default();
        let commits = if before.is_empty() || after.is_empty() {
            None
        } else if before == after {
            Some(0)
        } else {
            count_commits(repo, before, &after)
        };
        // Read-modify-write through the shared helper, never a fresh marker: a
        // download writes all fields, and an update must not reset the port
        // block or the confirmed launch command on its way through. It also
        // invalidates the index, which a marker edit has to do (the file
        // already exists, so no directory mtime moves).
        if let Err(e) = update_marker(repo, |m| {
            m.last_pull = Some(chrono::Utc::now().to_rfc3339());
        }) {
            // Surfaced in the update's own 详细日志 instead of swallowed: without
            // the stamp the freshness badge keeps saying "behind" for a repository
            // that was just pulled, and the pull really did succeed — a user who is
            // told 已更新 deserves to see why it will look un-updated afterwards.
            attempts.push(AttemptRecord {
                layer,
                label: "写回 .devhub.json（lastPull）".into(),
                ok: false,
                detail: e,
                ms: 0,
            });
        }
        let recent = recent_commits(repo, before, &after, 20);
        Ok(UpdateOutcome {
            layer,
            path: repo.to_string_lossy().to_string(),
            before: short_hash(before),
            after: short_hash(&after),
            commits,
            via_third_party,
            attempts,
            recent,
        })
    }

    /// The remote's HEAD commit, for the freshness badge.
    ///
    /// Same escape hatches as [`Downloader::check_remote_exists`], for the same
    /// reason: a badge that is stricter than the update it advertises would cry
    /// "behind" on a machine whose hosts redirects the host, even though the
    /// pull itself would have gone through.
    ///
    /// Returns `Ok(None)` when the remote cannot be reached right now - the
    /// caller shows "无法确认", never a wrong answer.
    pub fn remote_head(&self, r: &RepoRef) -> Result<Option<String>, DownloadError> {
        let git = std::path::Path::new(&self.git.path);
        let url = r.https_url();
        let auth = github_auth_cfg(&url, &self.config.github_token);
        let auth_ref = auth.as_ref().map(|(k, v)| (*k, v.as_str()));
        match run_ls_remote_head(git, &url, None, None, auth_ref) {
            Ok(h) => return Ok(Some(h)),
            Err(e) => {
                if looks_like_missing_repo(&e) {
                    return Err(DownloadError::RepoMissing(r.slug()));
                }
            }
        }
        if let Some(proxy) = discover_local_proxy(&self.config.extra_proxies) {
            match run_ls_remote_head(git, &url, Some(&proxy), None, auth_ref) {
                Ok(h) => return Ok(Some(h)),
                Err(e) => {
                    if looks_like_missing_repo(&e) {
                        return Err(DownloadError::RepoMissing(r.slug()));
                    }
                }
            }
        }
        if self.config.allow_ip_pin {
            if let Some(ip) = resolve_agreed_ip(&r.host) {
                match run_ls_remote_head(git, &url, None, Some((&r.host, &ip)), auth_ref) {
                    Ok(h) => return Ok(Some(h)),
                    Err(e) => {
                        if looks_like_missing_repo(&e) {
                            return Err(DownloadError::RepoMissing(r.slug()));
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    /// Completes a successful download.
    ///
    /// `attempts` already holds the real records (including the successful one,
    /// pushed by `try_git`), so nothing synthetic is added here - an earlier
    /// version pushed a placeholder record that showed up in the UI as a blank,
    /// 0ms entry.
    fn finish(
        &self,
        layer: DownloadLayer,
        target: &Path,
        slug: &str,
        url: &str,
        alloc: &PortBlock,
        attempts: Vec<AttemptRecord>,
        degraded: bool,
        via_third_party: bool,
        branch: Option<&str>,
    ) -> Result<DownloadOutcome, DownloadError> {
        let services: Vec<(String, u16)> = alloc
            .services
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        let marker = Marker {
            slug: slug.to_string(),
            url: url.to_string(),
            cloned_at: chrono::Utc::now().to_rfc3339(),
            port_base: alloc.base,
            services,
            branch: branch.map(str::to_string),
            ..Default::default()
        };
        let text = serde_json::to_string_pretty(&marker)
            .map_err(|e| DownloadError::Io(format!("序列化 .devhub.json 失败: {e}")))?;
        // Atomic, like every other marker write (`update_marker`): this is the
        // first write of the file, and a `fs::write` interrupted here leaves a
        // truncated `.devhub.json` behind in a directory that otherwise looks
        // like a successful clone — the next `update_marker` used to read that as
        // "no marker" and rebuild identity + port block from defaults.
        crate::write_atomic(&marker_path(target), text.as_bytes())
            .map_err(|e| DownloadError::Io(format!("写入 .devhub.json 失败: {e}")))?;

        // Bounded and non-fatal: a warning must never turn a completed clone
        // into a failed download. The detector itself never propagates errors.
        let hazards = crate::clone_hazards::detect(std::path::Path::new(&self.git.path), target);

        Ok(DownloadOutcome {
            layer,
            path: target.to_string_lossy().to_string(),
            attempts,
            degraded,
            via_third_party,
            hazards,
        })
    }

    /// The block a re-download reuses, or a fresh one when there is nothing to
    /// reuse. A confirmed overwrite keeps the repository's ports so a restart of
    /// the project does not have to move (需求 8.7).
    fn block_or_preserved(
        &self,
        preserved: &Option<PortBlock>,
        session: &mut Vec<u16>,
    ) -> Result<PortBlock, DownloadError> {
        match preserved {
            Some(p) => Ok(p.clone()),
            None => self.allocate(session),
        }
    }

    /// Reserves a port block for a repository.
    ///
    /// The block is written to `.devhub.json` and never recomputed, which is what
    /// keeps port assignments stable across runs. An earlier version recomputed
    /// them on every read and the numbers drifted.
    fn allocate(&self, session: &mut Vec<u16>) -> Result<PortBlock, DownloadError> {
        let mut used: Vec<u16> = Vec::new();
        collect_repos(&self.config.project_root, &mut |_rel, abs| {
            if let Some(m) = read_marker(abs) {
                if m.port_base > 0 {
                    used.push(m.port_base);
                }
            }
        });
        let in_use = ports_in_use();
        let reserved: Vec<u16> = ALLOCATED_BASES
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();

        for base in (POOL_LOW..=(POOL_HIGH - BLOCK_SIZE)).step_by(BLOCK_SIZE as usize) {
            let clash = used.iter().any(|u| base.abs_diff(*u) < BLOCK_SIZE)
                || reserved.iter().any(|u| base.abs_diff(*u) < BLOCK_SIZE)
                || (base..base + BLOCK_SIZE)
                    .any(|p| in_use.contains(&p) || SYSTEM_PORTS.contains(&p));
            if clash {
                continue;
            }
            if claim_block(base) {
                // Recorded per call, so `download_to` can hand it back when it returns
                // instead of burning the segment for the life of the process.
                session.push(base);
            }
            let services: Vec<(String, u16)> = RESERVED_SERVICES
                .iter()
                .enumerate()
                .map(|(i, name)| (name.to_string(), base + i as u16))
                .collect();
            return Ok(PortBlock { base, services });
        }
        Err(DownloadError::Io(format!(
            "{}–{} 范围内没有可用的端口段",
            POOL_LOW, POOL_HIGH
        )))
    }

    /// Proves a remote repository exists (and is publicly readable) before any
    /// directory is created, using a lightweight `git ls-remote <url> HEAD`.
    ///
    /// Two failure shapes, two errors: a 404/403/auth-shaped answer means the
    /// name is wrong or the repo is private (`RepoMissing`); anything else is a
    /// network failure (`CheckNetwork`). On a network failure the probe is
    /// retried through the same escape hatches the download itself has, because
    /// a probe that is stricter than the thing it gates refuses downloads that
    /// would have succeeded:
    ///
    ///   1. a discovered local proxy,
    ///   2. an IP pin — the `http.curloptResolve` trick from the download ladder,
    ///      which is the only way past a `hosts` file that points the repository
    ///      host at this machine.
    fn check_remote_exists(
        &self,
        progress: &ProgressFn,
        r: &RepoRef,
    ) -> Result<(), DownloadError> {
        let url = r.https_url();
        let auth = github_auth_cfg(&url, &self.config.github_token);
        let auth_ref = auth.as_ref().map(|(k, v)| (*k, v.as_str()));
        let git = Path::new(&self.git.path);
        progress("check", &format!("校验仓库是否存在：{}", redact_url(&url)));
        let (ok, code, stderr, timed_out) = run_ls_remote(git, &url, None, None, auth_ref);
        if ok {
            progress("check", "仓库存在，可以下载");
            return Ok(());
        }
        progress(
            "debug",
            &format!(
                "存在性校验（直连）失败：退出码 {:?}，{}",
                code,
                if stderr.is_empty() { "无输出".to_string() } else { format!("stderr: {stderr}") },
            ),
        );
        if looks_like_missing_repo(&stderr) {
            return Err(DownloadError::RepoMissing(r.slug()));
        }
        let mut last = stderr;
        // Network-shaped failure 1: one retry through a local proxy when one is
        // listening, then give up with the network error rather than guessing.
        if let Some(proxy) = discover_local_proxy(&self.config.extra_proxies) {
            progress("check", &format!("直连校验失败，改经本地代理 {proxy} 重试…"));
            let (ok, code, stderr, _) = run_ls_remote(git, &url, Some(&proxy), None, auth_ref);
            if ok {
                progress("check", "仓库存在，可以下载");
                return Ok(());
            }
            progress(
                "debug",
                &format!("存在性校验（代理 {proxy}）失败：退出码 {:?}，stderr: {stderr}", code),
            );
            if looks_like_missing_repo(&stderr) {
                return Err(DownloadError::RepoMissing(r.slug()));
            }
            last = stderr;
        }
        // Network-shaped failure 2: pin the address, exactly as the download
        // ladder does. Without this the probe answered "cannot confirm" for
        // every repository on a machine whose hosts redirects the host, even
        // though the clone itself would have gone through on the pinned layer.
        if self.config.allow_ip_pin {
            if let Some(ip) = resolve_agreed_ip(&r.host) {
                progress("check", &format!("校验改用 IP 钉死 {} 重试…", ip));
                let (ok, code, stderr, _) = run_ls_remote(git, &url, None, Some((&r.host, &ip)), auth_ref);
                if ok {
                    progress("check", "仓库存在，可以下载");
                    return Ok(());
                }
                progress(
                    "debug",
                    &format!("存在性校验（IP 钉死 {ip}）失败：退出码 {:?}，stderr: {stderr}", code),
                );
                if looks_like_missing_repo(&stderr) {
                    return Err(DownloadError::RepoMissing(r.slug()));
                }
                last = stderr;
            } else {
                progress("debug", "IP 钉死不可用：多个公共 DNS 未就一个公网地址达成一致");
            }
        }
        let detail = if timed_out {
            format!("校验超时（{} 秒无响应）", LS_REMOTE_TIMEOUT.as_secs())
        } else if last.is_empty() {
            "git 未返回诊断信息".to_string()
        } else {
            last
        };
        Err(DownloadError::CheckNetwork(detail))
    }

    /// Runs a `git clone` for one layer, retrying transient network failures in
    /// place before giving up. `url_override` lets the mirror layer clone from a
    /// rewritten URL.
    ///
    /// Returns `None` when the invocation could not even start.
    fn try_git(
        &self,
        progress: ProgressFn,
        r: &RepoRef,
        target: &Path,
        layer: DownloadLayer,
        label: &str,
        extra_cfg: &[String],
        url_override: Option<&str>,
        branch: Option<&str>,
    ) -> Result<Option<AttemptRecord>, DownloadError> {
        self.check_cancelled()?;
        let label = label.to_string();
        let url = url_override
            .map(str::to_string)
            .unwrap_or_else(|| r.https_url());
        // The credential is a per-invocation, github.com-scoped header, never
        // URL userinfo: `git clone` persists the URL it was given into
        // `.git/config`, which is how the previous implementation left a
        // plaintext PAT in every private clone. Mirror layers pass
        // `url_override`, so they never receive the header.
        let auth = if url_override.is_none() {
            github_auth_cfg(&url, &self.config.github_token)
        } else {
            None
        };
        let auth_ref = auth.as_ref().map(|(k, v)| (*k, v.as_str()));
        let mut notes: Vec<String> = Vec::new();
        let mut total_ms: u128 = 0;
        let mut settled: Option<AttemptRecord> = None;
        let mut cancelled = false;
        let git_path = std::path::Path::new(&self.git.path);
        let git_version = self.git.version.clone();

        // Drive the loop through `run_with_retries`. The closure is `FnMut`
        // because it mutates the shared `notes`/`total_ms`/`settled` cells; the
        // helper just counts attempts and pays the backoff between them.
        run_with_retries(&progress, RETRY_ATTEMPTS, |attempt| {
            // A cancel between attempts must not start another clone or burn a
            // retry backoff.
            if self.cancel.is_cancelled() {
                cancelled = true;
                return true;
            }
            progress("clone", &format!("尝试：{label} (第 {attempt} 次)"));
            // A previous failure may have left a partial directory.
            let _ = std::fs::remove_dir_all(target);

            let mut args: Vec<String> = Vec::new();
            for c in extra_cfg {
                args.push("-c".into());
                args.push(c.clone());
            }
            if std::env::var("DEVHUB_DEBUG_ARGS").is_ok() {
                // Redacted too: an argv dump is exactly where a token-bearing URL or a
                // `-c http.extraHeader=…` would appear, and this line exists for people
                // who are already debugging a failure they cannot see otherwise.
                progress(
                    "debug",
                    &redact_secrets(&format!("git {args:?} <<< {}", redact_url(&url))),
                );
            }
            // The key parameters, token-redacted, so the 详细日志 shows what was
            // actually attempted without ever leaking credentials. `extra_cfg` goes
            // through `redact_secrets` because it is a `-c key=value` list, not a URL:
            // a `http.extraHeader=Authorization: Bearer …` entry carries no `://`, so
            // `redact_url` alone would have written the token out verbatim — which is what
            // this line used to do while its own comment claimed the opposite.
            progress(
                "debug",
                &format!(
                    "git clone 参数：layer={layer:?} url={} auth={} extra_cfg=[{}]",
                    redact_url(&url),
                    // Presence only: the header value is a token.
                    if auth_ref.is_some() { "github-basic" } else { "none" },
                    redact_secrets(&extra_cfg.join(", "))
                ),
            );
            args.extend({
                // The strategy flags sit between `clone` and the operands: git accepts
                // them anywhere after the subcommand, and putting them here keeps the
                // one place that decides them auditable. `clone_strategy_args` returns
                // nothing for a local-path source, which is the measured case where the
                // flags would be passed, ignored, and then look like they worked.
                let mut v = vec!["clone".into(), "--progress".into()];
                v.extend(clone_strategy_args(
                    &self.config.clone_strategy,
                    &url,
                ));
                // One argv element (`--branch=name`): a branch starting with `-`
                // can never be parsed as a separate option, and `validate_branch`
                // has already refused those anyway.
                if let Some(b) = branch {
                    v.push(format!("--branch={b}"));
                }
                v.push(url.clone());
                v.push(target.to_string_lossy().to_string());
                v
            });

            let started = Instant::now();
            let run = match run_git_streaming(
                progress.clone(),
                git_path,
                &args,
                None,
                "clone",
                auth_ref,
                &self.cancel,
            ) {
                Ok(r) => r,
                Err(e) => {
                    // A transport-level failure (spawn error, the `CLONE_TIMEOUT`
                    // watchdog) is not a transient retry candidate: it is the
                    // layer's own error, and the caller's `?` is the only honest
                    // outcome. Record it as a failed attempt so the ladder still
                    // reports what happened, then stop the loop.
                    //
                    // This also covers what this round set out to fix: the partial
                    // directory is removed here, so a timed-out clone no longer
                    // leaves wreckage that the next attempt is refused by as
                    // 「目标目录已存在」.
                    let _ = std::fs::remove_dir_all(target);
                    if matches!(e, DownloadError::Cancelled) {
                        cancelled = true;
                        return true;
                    }
                    settled = Some(AttemptRecord {
                        layer,
                        label: label.clone(),
                        ok: false,
                        detail: format!("{e}"),
                        ms: total_ms,
                    });
                    return true;
                }
            };
            let ms = started.elapsed().as_millis();
            total_ms += ms;
            progress(
                "debug",
                &format!(
                    "{label} 第 {attempt} 次结束：{}，退出码 {:?}，耗时 {ms}ms",
                    if run.ok { "成功" } else { "失败" },
                    run.code
                ),
            );
            if !run.ok {
                let diag = if !run.stderr_tail.is_empty() {
                    &run.stderr_tail
                } else {
                    &run.stdout_tail
                };
                if !diag.is_empty() {
                    // Redact **before** truncating: cutting at 300 chars first could land
                    // in the middle of a credential and leave its head in the log.
                    progress(
                        "debug",
                        &format!("stderr 摘要：{}", truncate(&redact_secrets(diag), 300)),
                    );
                }
            }

            if run.ok {
                // What the strategy actually delivered, into the same `notes` that
                // become the activity record's detail. This is the non-silent half of
                // R1-3: in every measured case where git threw the flag away, the clone
                // still exited 0, so without this line a `shallow` download that was in
                // fact a full download would be recorded as a success of `shallow`.
                if let Some(n) =
                    clone_strategy_note(&self.config.clone_strategy, &run.stderr_tail, git_path, target)
                {
                    notes.push(n);
                }
                if !notes.is_empty() {
                    notes.push(format!("第 {attempt} 次成功"));
                }
                let mut detail = format!("{} 用时 {total_ms}ms", git_version);
                if !notes.is_empty() {
                    detail.push_str(&format!("（{}）", notes.join("; ")));
                }
                settled = Some(AttemptRecord {
                    layer,
                    label: label.clone(),
                    ok: true,
                    detail,
                    ms: total_ms,
                });
                return true;
            }

            let detail = if !run.stderr_tail.is_empty() {
                run.stderr_tail.clone()
            } else if !run.stdout_tail.is_empty() {
                run.stdout_tail.clone()
            } else {
                "git 退出但未输出诊断信息".to_string()
            };

            let last = attempt == RETRY_ATTEMPTS;
            if !is_transient_failure(&run) {
                progress("debug", &format!("{label}：非瞬时错误，不再重试本层"));
                // Non-transient (auth, 404, protocol): retrying cannot help.
                let _ = std::fs::remove_dir_all(target);
                settled = Some(AttemptRecord {
                    layer,
                    label: label.clone(),
                    ok: false,
                    detail: format!("{detail}（非瞬时错误，不重试）"),
                    ms: total_ms,
                });
                return true;
            }
            let _ = std::fs::remove_dir_all(target);
            if last {
                settled = Some(AttemptRecord {
                    layer,
                    label: label.clone(),
                    ok: false,
                    detail: format!("{detail}（已重试 {RETRY_ATTEMPTS} 次仍失败）"),
                    ms: total_ms,
                });
                return true;
            }
            notes.push(format!("第 {attempt} 次瞬时失败，重试"));
            progress("clone", "瞬时网络错误，正在重试…");
            false
        });

        if cancelled {
            let _ = std::fs::remove_dir_all(target);
            return Err(DownloadError::Cancelled);
        }
        Ok(settled)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_url_only_touches_the_userinfo() {
        // The credential barrier feeding 详细日志: a token in the userinfo must
        // never survive, and a path that merely contains an `@` must not be
        // mangled into something that looks like it did.
        assert_eq!(
            redact_url("https://octoken:ghp_SECRET@github.com/o/r.git"),
            "https://***@github.com/o/r.git"
        );
        assert_eq!(
            redact_url("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            redact_url("https://github.com/user@repo/dir.git"),
            "https://github.com/user@repo/dir.git",
            "an `@` after the host is path data, not a credential"
        );
        assert_eq!(redact_url("git@github.com:o/r.git"), "git@github.com:o/r.git");
    }

    #[test]
    fn redact_secrets_masks_a_config_value_that_has_no_url_in_it() {
        // The whole reason this function exists: `-c http.extraHeader=…` is not a URL,
        // so `redact_url` would have written the token out verbatim — which is exactly
        // what the clone-parameter log line used to do under a comment claiming the
        // opposite.
        let line = r#"git clone 参数：layer="直连" url=https://github.com/o/r.git extra_cfg=[http.extraHeader=Authorization: Bearer ghp_ABCDEFghijklmnop]"#;
        let red = redact_secrets(line);
        assert!(!red.contains("ghp_ABCDEFghijklmnop"), "令牌原文留在日志里：{red}");
        assert!(red.contains("http.extraHeader="), "键名要留着，否则这行不再说明任何事：{red}");
        assert!(red.contains("url=https://github.com/o/r.git"), "无关的公开 URL 不该被动：{red}");
    }

    #[test]
    fn redact_secrets_masks_a_credential_inside_git_error_text() {
        let line = "fatal: Authentication failed for 'https://x-access-token:ghp_SECRETVALUE@github.com/o/r.git/'";
        let red = redact_secrets(line);
        assert_eq!(
            red,
            "fatal: Authentication failed for 'https://***@github.com/o/r.git/'",
            "git 自己回显的带账号 remote 必须被遮住，同时保留主机与路径"
        );
    }

    #[test]
    fn redact_secrets_leaves_an_email_shaped_path_alone() {
        // The predecessor's failure mode, stated in its own comment: an `@` after the
        // host is path data. Masking it destroys the host and implies a token that was
        // never there, which makes the 详细日志 useless.
        for line in [
            "https://github.com/user@repo/dir.git",
            "git@github.com:o/r.git",
            "remote origin  https://github.com/o/r.git",
        ] {
            assert_eq!(redact_secrets(line), line, "不该被改写：{line}");
        }
    }

    #[test]
    fn redact_secrets_is_case_insensitive_and_idempotent() {
        let a = redact_secrets("HEAD Authorization: ghp_ONE  /  bearer TWO");
        assert!(!a.contains("ghp_ONE") && !a.contains("TWO"), "{a}");
        assert!(a.contains("Authorization:") && a.contains("bearer"), "键名与位置要留着：{a}");
        assert_eq!(redact_secrets(&a), a, "遮过一次不该再改一次");
    }

    #[test]
    fn redact_secrets_survives_non_ascii_without_shifting_offsets() {
        // `to_ascii_lowercase` can change a string's byte length (U+0130 lower-cases to
        // two bytes), so offsets taken from a lower-cased copy would slice the original
        // mid-character and panic. This path is real: git's own messages are localized,
        // and a zh-CN console hands back GBK-decoded text with CJK in it.
        let line = format!("İ 位置 {} Authorization: ghp_TAIL", "错误".repeat(3));
        let red = redact_secrets(&line);
        assert!(!red.contains("ghp_TAIL"), "{red}");
        assert!(red.contains("错误错误错误"), "前后的中文要完好：{red}");
    }

    #[test]
    fn redact_secrets_catches_the_legacy_token_url() {
        // The string git echoes back after a failed authentication with the
        // pre-r27 URL-userinfo credential. The redactor must keep the host and
        // path while hiding the token.
        let authed = "https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/Owner/Repo.git";
        let red = redact_secrets(&format!("fatal: Authentication failed for '{authed}/'"));
        assert!(!red.contains("ghp_AAAA"), "令牌留在日志里：{red}");
        assert!(red.contains("github.com/Owner/Repo.git"), "主机与路径要留着：{red}");
    }

    #[test]
    fn recent_commits_come_from_the_moved_range_only() {
        let Some(gh) = find_git(None) else {
            return;
        };
        let git = std::path::Path::new(&gh.path);
        let repo = std::env::temp_dir().join(format!("devhub-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = git_cmd(git)
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {:?}: {}", args, crate::proc::decode_console(&out.stderr));
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "a@b.c"]);
        run(&["config", "user.name", "a"]);
        let head = || {
            let out = git_cmd(git)
                .args(["-C", &repo.to_string_lossy(), "rev-parse", "HEAD"])
                .output()
                .unwrap();
            crate::proc::decode_console(&out.stdout).trim().to_string()
        };
        std::fs::write(repo.join("a.txt"), "1").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "first"]);
        let first = head();
        std::fs::write(repo.join("a.txt"), "2").unwrap();
        run(&["commit", "-qam", "second subject"]);
        std::fs::write(repo.join("a.txt"), "3").unwrap();
        run(&["commit", "-qam", "third subject"]);
        let last = head();

        let recent = recent_commits(&repo, &first, &last, 20);
        assert_eq!(recent.len(), 2, "the range must exclude the first commit");
        assert_eq!(recent[0].subject, "third subject", "git log is newest first");
        assert_eq!(recent[1].subject, "second subject");
        assert!(recent.iter().all(|c| c.hash.len() >= 7));
        assert!(recent_commits(&repo, &last, &last, 20).is_empty());
        assert!(recent_commits(&repo, &first, &last, 1).len() == 1);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn every_git_command_carries_core_longpaths() {
        let cmd = git_cmd(std::path::Path::new("git"));
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-c", "core.longpaths=true"]);
    }

    #[test]
    fn a_landing_path_too_close_to_max_path_is_refused_with_a_reason() {
        let short = std::path::Path::new("D:/项目/repo_owner");
        assert_eq!(target_path_length_error(short), None);
        #[cfg(windows)]
        {
            let long = std::path::PathBuf::from("D:/").join("x".repeat(260));
            let msg = target_path_length_error(&long).expect("must refuse");
            assert!(msg.contains("260"), "{msg}");
            assert!(msg.contains("缩短"), "the remedy must be in the sentence: {msg}");
        }
    }

    #[test]
    fn branch_names_are_checked_before_git_sees_them() {
        // The leading `-` case is the one that matters: without it a value like
        // `--upload-pack=…` would be parsed as a clone option.
        assert!(branch_name_error("-evil").is_some());
        assert!(branch_name_error("feat/x..y").is_some());
        assert!(branch_name_error("feat/x y").is_some());
        assert!(branch_name_error("feat/x.lock").is_some());
        assert!(branch_name_error("feat/x~1").is_some());
        assert_eq!(branch_name_error(""), None);
        assert_eq!(branch_name_error("feature/x"), None);
        assert_eq!(branch_name_error("v1.2.3"), None);
    }

    #[test]
    fn clone_checks_out_the_requested_branch_and_records_it() {
        let Some(gh) = find_git(None) else {
            return; // no git on this machine: the ref-format contract is above
        };
        let git = std::path::Path::new(&gh.path);
        let root = std::env::temp_dir().join(format!(
            "devhub-branch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let src = root.join("src");
        std::fs::create_dir_all(&src).expect("src");
        let run = |args: &[&str]| {
            let out = git_cmd(git)
                .arg("-C")
                .arg(&src)
                .args(args)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {:?}: {}", args, crate::proc::decode_console(&out.stderr));
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "a@b.c"]);
        run(&["config", "user.name", "a"]);
        std::fs::write(src.join("a.txt"), "main\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "main"]);
        run(&["checkout", "-qb", "feature/x"]);
        std::fs::write(src.join("a.txt"), "feature\n").unwrap();
        run(&["commit", "-qam", "feature"]);

        let dl = Downloader {
            config: DownloaderConfig {
                project_root: root.join("projects"),
                ..Default::default()
            },
            git: gh.clone(),
            cancel: CancelToken::default(),
        };
        let progress: ProgressFn = std::sync::Arc::new(|_: &str, _: &str| {});
        let outcome = dl
            .download_to(
                progress,
                &src.to_string_lossy(),
                None,
                false,
                Some("feature/x"),
            )
            .expect("clone feature/x");
        let target = std::path::Path::new(&outcome.path);
        let marker = read_marker(target).expect("marker");
        assert_eq!(marker.branch.as_deref(), Some("feature/x"));
        let head = git_cmd(git)
            .args(["-C", &outcome.path, "rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .expect("rev-parse");
        assert!(head.status.success());
        assert_eq!(
            crate::proc::decode_console(&head.stdout).trim(),
            "feature/x",
            "the clone must actually check out the requested branch"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).unwrap().trim(),
            "feature"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cancellation_kills_a_running_child_and_returns_cancelled() {
        // Exercises the same wait loop and Job Object teardown a clone uses,
        // with a child that is guaranteed to still be running when the flag
        // flips. A real stalled clone was tried first: with git in the middle,
        // the test process could block on the pipe readers after the kill, so
        // the process-control contract is tested here and the git wiring is
        // covered by `try_git`'s own cancel checks.
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let token = CancelToken::default();
        assert!(!token.is_cancelled());
        let t2 = token.clone();
        let flipper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            t2.cancel();
        });

        let args = vec![
            "/C".to_string(),
            "ping".to_string(),
            "-n".to_string(),
            "30".to_string(),
            "127.0.0.1".to_string(),
        ];
        let started = Instant::now();
        let result = run_git_streaming(
            std::sync::Arc::new(|_: &str, _: &str| {}),
            std::path::Path::new(&shell),
            &args,
            None,
            "clone",
            None,
            &token,
        );
        flipper.join().expect("cancel thread");
        assert!(
            matches!(result, Err(DownloadError::Cancelled)),
            "expected Cancelled, got {:?}",
            result.map(|r| r.ok)
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "cancellation must not wait for the child to finish on its own"
        );
    }

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // RFC 4648 §10 test vectors, plus the exact userinfo this module builds.
        for (raw, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
            ("x-access-token:tok", "eC1hY2Nlc3MtdG9rZW46dG9r"),
        ] {
            assert_eq!(base64_encode(raw.as_bytes()), want, "raw={raw}");
        }
    }

    #[test]
    fn github_auth_cfg_is_scoped_and_never_changes_the_url() {
        let (key, value) = github_auth_cfg("https://github.com/o/r.git", "ghp_SECRET")
            .expect("a token on a plain github URL must authenticate");
        assert_eq!(
            key, "http.https://github.com/.extraHeader",
            "the header must be scoped: an unscoped one follows a mirror's insteadOf rewrite"
        );
        assert_eq!(
            value, "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1NFQ1JFVA==",
            "GitHub accepts x-access-token as the Basic username"
        );
        // Nothing to do: no token.
        assert!(github_auth_cfg("https://github.com/o/r.git", "  ").is_none());
        // A non-github host is left alone (a token must never leak to a mirror).
        assert!(
            github_auth_cfg("https://gh-proxy.com/https://github.com/o/r.git", "ghp_SECRET")
                .is_none()
        );
        // URL userinfo is not ours to duplicate.
        assert!(github_auth_cfg("https://user:pass@github.com/o/r.git", "ghp_SECRET").is_none());
        // Plain http is not upgraded silently.
        assert!(github_auth_cfg("http://github.com/o/r.git", "ghp_SECRET").is_none());
    }

    #[test]
    fn url_without_devhub_credentials_only_touches_our_own_userinfo() {
        assert_eq!(
            url_without_devhub_credentials(
                "https://x-access-token:ghp_SECRET@github.com/Owner/Repo.git"
            )
            .as_deref(),
            Some("https://github.com/Owner/Repo.git")
        );
        assert_eq!(
            url_without_devhub_credentials(
                "https://someone:github_pat_SECRET@github.com/Owner/Repo.git"
            )
            .as_deref(),
            Some("https://github.com/Owner/Repo.git")
        );
        // A user's own credentials on a private mirror are not ours to delete.
        assert_eq!(
            url_without_devhub_credentials("https://me:secret@git.example.com/o/r.git"),
            None
        );
        // Nor is an ordinary credential on github.com one DevHub wrote.
        assert_eq!(
            url_without_devhub_credentials("https://me:secret@github.com/o/r.git"),
            None
        );
        // Already clean.
        assert_eq!(url_without_devhub_credentials("https://github.com/o/r.git"), None);
        // ssh/scp forms are not touched.
        assert_eq!(url_without_devhub_credentials("git@github.com:o/r.git"), None);
    }

    #[test]
    fn scrub_origin_credentials_rewrites_a_legacy_clone_and_is_idempotent() {
        let Some(gh) = find_git(None) else {
            return; // no git on this machine: the CLI contract is covered above
        };
        let git = std::path::Path::new(&gh.path);
        let root = std::env::temp_dir().join(format!(
            "devhub-scrub-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let init = git_cmd(git)
            .arg("-C")
            .arg(&root)
            .arg("init")
            .output()
            .expect("git init");
        assert!(init.status.success(), "git init failed: {:?}", init.status);
        let add = git_cmd(git)
            .arg("-C")
            .arg(&root)
            .args([
                "remote",
                "add",
                "origin",
                "https://x-access-token:ghp_LEGACY@github.com/o/r.git",
            ])
            .output()
            .expect("git remote add");
        assert!(add.status.success());

        let clean = scrub_origin_credentials(git, &root).expect("scrub");
        assert_eq!(clean.as_deref(), Some("https://github.com/o/r.git"));
        let config = std::fs::read_to_string(root.join(".git").join("config")).expect("config");
        assert!(!config.contains("ghp_LEGACY"), "token still on disk: {config}");
        assert!(config.contains("https://github.com/o/r.git"));

        assert_eq!(
            scrub_origin_credentials(git, &root).expect("second scrub"),
            None,
            "a clean origin must be a no-op"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------------------------------------------------------------------
    // Layer 2's cross-check cache: only agreements are remembered, and both
    // bounds (TTL, capacity) hold. No resolver is contacted — these exercise
    // `DnsCache` directly.
    // ---------------------------------------------------------------------

    #[test]
    #[ignore = "network: needs two public DNS resolvers to agree"]
    fn resolve_agreed_ip_can_reach_public_resolvers() {
        // Manual smoke test after the hickory 0.26 (async-only) migration:
        // `cargo test --lib resolve_agreed_ip_can_reach -- --ignored`.
        let ip = resolve_agreed_ip("github.com");
        assert!(ip.is_some(), "public resolvers returned no agreed address");
    }

    #[test]
    fn a_failed_resolution_is_not_cached() {
        let mut cache = DnsCache::default();
        let now = Instant::now();
        cache.put("api.github.com", None, now);
        assert!(
            cache.get("api.github.com", now).is_none(),
            "a transient failure must not become a 30-second fact that keeps the bypass off"
        );
    }

    #[test]
    fn an_agreed_ip_is_served_until_the_ttl_expires() {
        let mut cache = DnsCache::default();
        let t0 = Instant::now();
        cache.put("api.github.com", Some("140.82.1.1"), t0);
        assert_eq!(cache.get("api.github.com", t0).as_deref(), Some("140.82.1.1"));
        let expired = t0 + std::time::Duration::from_millis(DNS_CACHE_TTL_MS);
        assert!(
            cache.get("api.github.com", expired).is_none(),
            "the TTL must expire the entry"
        );
    }

    #[test]
    fn the_cache_capacity_is_one_host() {
        let mut cache = DnsCache::default();
        let t0 = Instant::now();
        cache.put("api.github.com", Some("140.82.1.1"), t0);
        cache.put("github.com", Some("140.82.2.2"), t0);
        assert!(
            cache.get("api.github.com", t0).is_none(),
            "a second host replaces the single slot — the cache is bounded, not a growing map"
        );
        assert_eq!(cache.get("github.com", t0).as_deref(), Some("140.82.2.2"));
    }

    #[test]
    fn a_host_with_no_entry_is_a_miss() {
        let cache = DnsCache::default();
        assert!(cache.get("api.github.com", Instant::now()).is_none());
    }

    #[test]
    fn is_transient_failure_reads_the_instability_symptoms() {
        let run = |tail: &str| GitRun {
            ok: false,
            code: Some(128),
            stderr_tail: tail.into(),
            stdout_tail: String::new(),
        };
        // The exact intermittent-GitHub failure REQUIREMENTS.md §4.2 records.
        assert!(is_transient_failure(&run("fatal: unable to access: Recv failure: Connection was reset")));
        assert!(is_transient_failure(&run("error: RPC failed; curl 18 transfer closed")));
        assert!(is_transient_failure(&run("The remote end hung up unexpectedly")));
        // An auth refusal is NOT transient: retrying it cannot help, and treating
        // it as transient burns the whole retry ladder on a 403.
        assert!(!is_transient_failure(&run("remote: Permission to o/r denied to user.")));
        assert!(!is_transient_failure(&run("repository not found")));
        // Case-insensitive, because git's wording is not stable across versions.
        assert!(is_transient_failure(&run("CONNECTION TIMED OUT")));
    }

    #[test]
    fn slug_score_orders_exact_before_suffix_before_last_segment() {
        let names = |marker: &str, rel: &str, dir_name: &str, identified: &str| RepoNames {
            rel: rel.into(),
            marker: marker.into(),
            dir_name: dir_name.into(),
            identified: identified.into(),
        };
        assert_eq!(
            slug_score("o/r", &names("o/r", "anything", "whatever", "x/y")),
            Some(0),
            "an exact hit on any recorded name wins"
        );
        assert_eq!(
            slug_score("o/r", &names("", "code/github.com/o/r", "r", "")),
            Some(1),
            "the legacy code/<host>/<owner>/<repo> shape resolves by suffix"
        );
        assert_eq!(
            slug_score("o/r", &names("", "mirror/of/o/r", "r", "")),
            Some(1),
            "any path that ends in the wanted slug matches at the suffix level"
        );
        // The weakest tier: nothing ends with `/r`, but a recorded name's last
        // segment is exactly `r`.
        assert_eq!(
            slug_score("r", &names("", "somewhere/deep", "r2", "o/r")),
            Some(2),
            "the last path segment is the weakest match"
        );
        assert_eq!(slug_score("o/r", &names("", "z/other", "other", "")), None);
        assert_eq!(
            slug_score("o/r", &names("", "", "", "")),
            None,
            "empty names must never match - they used to be comparable to anything"
        );
    }

    #[test]
    fn a_corrupt_marker_is_set_aside_before_a_fresh_one_is_written() {
        let root = std::env::temp_dir().join(format!(
            "devhub-marker-corrupt-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture");
        std::fs::write(marker_path(&root), "{ not json at all").expect("fixture");

        update_marker(&root, |m| m.slug = "o/r".into()).expect("the edit itself works");

        assert_eq!(read_marker(&root).expect("fresh marker").slug, "o/r");
        let bad = root.join(".devhub.json.bad");
        assert!(
            bad.exists(),
            "the unreadable bytes must survive as .devhub.json.bad, not evaporate"
        );
        assert_eq!(
            std::fs::read_to_string(&bad).expect("backup readable"),
            "{ not json at all"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The data-loss shape this replaces: `read_marker` returned `None` for a file
    /// that exists but is momentarily locked, `update_marker` read that as "no
    /// marker", and rebuilt `slug`, the port block and the confirmed launch command
    /// from `Marker::default()`.
    #[test]
    fn an_unreadable_marker_aborts_the_write_rather_than_rebuilding_defaults() {
        let root = std::env::temp_dir().join(format!(
            "devhub-marker-locked-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(marker_path(&root)).expect("a directory at the marker path");

        let err = update_marker(&root, |m| m.slug = "o/r".into()).unwrap_err();
        assert!(err.contains("已取消写入"), "the refusal must say so: {err}");
        assert!(
            marker_path(&root).is_dir(),
            "nothing may be written over a marker that could not be read"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The regression that parallel downloads would have introduced.
    ///
    /// `allocate()` read each repository's marker to learn which port blocks were
    /// taken, but the marker is written only after a clone finishes — so two
    /// concurrent clones against an empty root both saw "nothing taken" and both
    /// got the same block. Two allocations in a row from an empty directory must
    /// not collide, and must not even overlap.
    #[test]
    fn parallel_downloads_never_share_a_port_block() {
        if find_git(None).is_none() {
            eprintln!("skip: no git on this machine, cannot build a Downloader");
            return;
        }
        let root = std::env::temp_dir().join(format!("devhub-ports-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cfg = DownloaderConfig {
            project_root: root.clone(),
            ..Default::default()
        };
        let dl = Downloader::new(cfg, None).expect("downloader");

        let mut session: Vec<u16> = Vec::new();
        let a = dl.allocate(&mut session).expect("first block").base;
        let b = dl.allocate(&mut session).expect("second block").base;
        assert_eq!(
            session.len(),
            2,
            "each reservation is recorded so the download call can give it back"
        );
        // The call that made these two reservations is over, so the pool gets both
        // back. Before this, a failed download kept its segment for the life of the
        // process and the pool (~1000 segments) only ever shrank.
        assert_eq!(release_blocks(&session), 2, "both were still held");
        assert_eq!(
            release_blocks(&session),
            0,
            "releasing twice must not hand out a second credit"
        );
        session.clear();
        assert_eq!(release_blocks(&session), 0, "an empty session costs nothing");
        let _ = std::fs::remove_dir_all(&root);

        assert_ne!(a, b, "two allocations from an empty root returned the same base");
        assert!(
            a.abs_diff(b) >= BLOCK_SIZE,
            "blocks {a} and {b} overlap (block size {BLOCK_SIZE})"
        );
    }

    /// A repository owned by `CON` (a real GitHub name) used to produce a directory
    /// Windows refuses to create; the clone error then said nothing about why.
    #[test]
    fn reserved_device_names_are_never_used_as_components() {
        assert_eq!(sanitize_component("CON"), "_CON");
        assert_eq!(sanitize_component("con"), "_con", "case-insensitive");
        assert_eq!(sanitize_component("NUL"), "_NUL");
        assert_eq!(sanitize_component("COM1.zip"), "_COM1.zip", "with an extension");
        assert_eq!(sanitize_component("LPT9"), "_LPT9");
        // Ordinary names, and names that merely *contain* a reserved word, are untouched.
        assert_eq!(sanitize_component("rust-lang"), "rust-lang");
        assert_eq!(sanitize_component("console-tools"), "console-tools");
        assert_eq!(sanitize_component("my.repos"), "my.repos");
        assert_eq!(sanitize_component("trailing."), "trailing", "dot end still trimmed");
    }

    #[test]
    fn parses_owner_repo() {
        let r = parse_ref("octocat/Hello-World").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "octocat");
        assert_eq!(r.repo, "Hello-World");
        assert_eq!(r.slug(), "github.com/octocat/Hello-World");
    }

    #[test]
    fn parses_full_https_url_and_strips_git() {
        let r = parse_ref("https://github.com/rust-lang/rust.git").unwrap();
        assert_eq!(r.owner, "rust-lang");
        assert_eq!(r.repo, "rust");
        assert_eq!(r.https_url(), "https://github.com/rust-lang/rust.git");
    }

    #[test]
    fn parses_ssh_style() {
        let r = parse_ref("git@github.com:owner/repo.git").unwrap();
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn parses_explicit_host() {
        let r = parse_ref("gitlab.com/group/proj").unwrap();
        assert_eq!(r.host, "gitlab.com");
        assert_eq!(r.slug(), "gitlab.com/group/proj");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_ref("").is_err());
        assert!(parse_ref("onlyone").is_err());
        assert!(parse_ref("   ").is_err());
    }

    #[test]
    fn target_path_is_owner_scoped_so_same_names_never_collide() {
        fn dl(root: &str) -> Downloader {
            Downloader {
                config: DownloaderConfig {
                    project_root: PathBuf::from(root),
                    ..Default::default()
                },
                git: GitLocation {
                    path: "git".into(),
                    version: "git".into(),
                    source: "system".into(),
                },
                cancel: CancelToken::default(),
            }
        }
        let a = dl("R").target_path(&parse_ref("alice/tool").unwrap());
        let b = dl("R").target_path(&parse_ref("bob/tool").unwrap());
        assert_ne!(
            a, b,
            "same repo name under different owners must not collide"
        );
        assert_eq!(a, PathBuf::from("R").join("tool_alice"));
        assert_eq!(b, PathBuf::from("R").join("tool_bob"));
    }

    #[test]
    fn target_path_avoids_clobbering_a_different_repository() {
        // `repo_owner` can only collide across hosts: github.com/a/b vs a
        // hypothetical gitlab.com/b_a. The second one must get its own directory
        // instead of overwriting the first.
        let root = std::env::temp_dir().join("devhub-collide");
        let _ = std::fs::remove_dir_all(&root);
        let dl = Downloader {
            config: DownloaderConfig {
                project_root: root.clone(),
                ..Default::default()
            },
            git: GitLocation {
                path: "git".into(),
                version: "git".into(),
                source: "system".into(),
            },
            cancel: CancelToken::default(),
        };

        let first = dl.target_path(&parse_ref("https://github.com/a/b").unwrap());
        assert_eq!(first, root.join("b_a"));
        std::fs::create_dir_all(first.join(".git")).unwrap();
        std::fs::write(
            marker_path(&first),
            r#"{"slug":"github.com/a/b","url":"","clonedAt":"","portBase":0,"services":[]}"#,
        )
        .unwrap();

        // The same repository resolves to its existing directory (so the conflict
        // is reported as "already exists" rather than silently duplicated).
        assert_eq!(first, dl.target_path(&parse_ref("github.com/a/b").unwrap()));

        // Same `repo_owner`, different host: must not overwrite the first one.
        let other = dl.target_path(&parse_ref("https://gitlab.com/a/b").unwrap());
        assert_ne!(
            other, first,
            "a foreign repository must not be overwritten"
        );
        assert_eq!(other, root.join("b_a_gitlab.com"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The regression this guards: the add view reveals the landing directory in
    /// Explorer, and the old `reveal_path` created it. Once `<repo>_<owner>`
    /// existed, `target_path` appended the host and the download silently went
    /// somewhere the preview had not shown.
    #[test]
    fn an_empty_placeholder_directory_is_still_the_target() {
        let root = std::env::temp_dir().join("devhub-placeholder");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("b_a")).unwrap();

        let dl = Downloader {
            config: DownloaderConfig {
                project_root: root.clone(),
                ..Default::default()
            },
            git: GitLocation {
                path: "git".into(),
                version: "git".into(),
                source: "system".into(),
            },
            cancel: CancelToken::default(),
        };

        let primary = root.join("b_a");
        assert_eq!(
            primary,
            dl.target_path(&parse_ref("github.com/a/b").unwrap()),
            "an empty directory is a placeholder, not a conflict"
        );
        assert!(
            !is_occupied(&primary),
            "and a download aimed at it must not be refused"
        );

        // Once anything is in it, it is someone else's directory, and a clone of
        // a same-named repository from another host must go beside it rather
        // than into it.
        std::fs::write(primary.join("keep.txt"), b"x").unwrap();
        assert!(is_occupied(&primary));
        assert_eq!(
            root.join("b_a_gitlab.com"),
            dl.target_path(&parse_ref("gitlab.com/a/b").unwrap())
        );

        // A path that does not exist is never occupied.
        assert!(!is_occupied(&root.join("nope")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The 403/404 narrowing: a proxy that refuses the CONNECT also prints a
    /// bare `403`, and calling that a missing repository sends the user to fix a
    /// name that was never wrong.
    #[test]
    fn a_proxy_refusal_is_not_a_missing_repository() {
        assert!(looks_like_missing_repo(
            "remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found"
        ));
        assert!(looks_like_missing_repo("fatal: Authentication failed for 'https://github.com/'"));
        // GitHub answers a private repository with 403 *about the repository*.
        assert!(looks_like_missing_repo(
            "remote: Repository not found. (403)\nfatal: unable to access"
        ));
        // A forward proxy refusing the tunnel is a network answer.
        assert!(
            !looks_like_missing_repo(
                "fatal: unable to access 'https://github.com/a/b/': \
                 The requested URL returned error: 403"
            ),
            "a bare 403 from the path is not evidence about the repository"
        );
        assert!(
            !looks_like_missing_repo("schannel: CRYPT_E_NO_REVOCATION_CHECK"),
            "a TLS failure is not a missing repository either"
        );
    }

    #[test]
    fn git_lookup_is_memoised_and_can_be_invalidated() {
        // Uncached, this call walks PATH and spawns `git --version`; the whole
        // point of the cache is that the second call does neither. Timing is the
        // only way to observe that from outside, so assert a large margin rather
        // than an exact number (CI machines vary a lot).
        reset_git_cache();

        let rt = std::env::temp_dir().join("devhub-git-cache-test");
        let t_first = std::time::Instant::now();
        let first = find_git(Some(&rt));
        let cold = t_first.elapsed();

        let t_second = std::time::Instant::now();
        let second = find_git(Some(&rt));
        let warm = t_second.elapsed();

        // Same answer either way, including the "no git" case being cached.
        assert_eq!(first.is_some(), second.is_some());
        assert_eq!(
            first.as_ref().map(|g| &g.version),
            second.as_ref().map(|g| &g.version)
        );
        assert!(
            warm <= cold,
            "a cached lookup must not be slower ({warm:?} vs {cold:?})"
        );
        // A cache hit does no I/O at all, so it should be far below the cold path.
        assert!(
            warm < std::time::Duration::from_millis(50),
            "cached git lookup took {warm:?}, expected no work"
        );

        reset_git_cache();
    }

    #[test]
    fn git_version_survives_a_missing_binary() {
        // Must return None rather than panic or hang.
        let bogus = std::path::PathBuf::from("definitely-not-a-real-binary-xyz");
        assert!(git_version(&bogus).is_none());
    }

    #[test]
    fn loopback_proxy_parser_accepts_only_local_ports() {
        for (raw, want) in [
            ("127.0.0.1:7890", Some("127.0.0.1:7890")),
            ("http://127.0.0.1:7890", Some("127.0.0.1:7890")),
            ("http://localhost:7897/", Some("localhost:7897")),
            ("[::1]:7890", Some("[::1]:7890")),
        ] {
            assert_eq!(loopback_proxy_addr(raw).as_deref(), want, "raw={raw}");
        }
        for raw in [
            "10.0.0.1:8080",
            "proxy.example.com:3128",
            "127.0.0.1:0",
            "127.0.0.1",
            "",
            "   ",
            "not a proxy",
        ] {
            assert_eq!(loopback_proxy_addr(raw), None, "must reject {raw:?}");
        }
    }

    #[test]
    fn system_proxy_comes_first_and_is_deduplicated() {
        let c = proxy_candidates(
            &["127.0.0.1:9000".to_string()],
            Some("http://127.0.0.1:7890"),
        );
        assert_eq!(c.first().map(String::as_str), Some("127.0.0.1:7890"));
        assert_eq!(c.iter().filter(|x| *x == "127.0.0.1:7890").count(), 1);
        assert!(c.iter().any(|x| x == "127.0.0.1:9000"));

        // A remote proxy is reported by the diagnostics but never auto-used.
        let c = proxy_candidates(&[], Some("10.0.0.1:8080"));
        assert!(!c.iter().any(|x| x.contains("10.0.0.1")));

        // A disabled proxy is `None` upstream; no entry appears.
        let c = proxy_candidates(&[], None);
        assert!(c.iter().all(|x| x.starts_with("127.0.0.1:")));
    }

    #[test]
    fn probing_terminates_when_a_candidate_is_closed() {
        // The candidate list deliberately contains ports a developer machine may
        // really be using (7890/7897 are common accelerators), so "the result is
        // empty" is not a property of the code — it is a property of the machine.
        // What must hold everywhere is that a closed candidate is not reported and
        // that probing is concurrent and bounded.
        let started = std::time::Instant::now();
        let found = probe_local_proxies(&["127.0.0.1:1".to_string(), "  ".to_string()]);
        let elapsed = started.elapsed();
        assert!(
            !found.iter().any(|f| f.ends_with(":1")),
            "a closed port must not be reported: {found:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(3),
            "probing must be concurrent and bounded, took {elapsed:?}"
        );
    }

    #[test]
    fn probing_reports_a_listening_socket() {
        // Bind a real listener and make sure it is discovered.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let found = probe_local_proxies(&[format!("127.0.0.1:{port}")]);
        assert!(
            found.iter().any(|f| f.ends_with(&port.to_string())),
            "listener on {port} should be found, got {found:?}"
        );
    }

    #[test]
    fn parses_local_drive_path_and_marks_it_local() {
        let d = std::env::temp_dir()
            .join("devhub-localref")
            .join("myrepo.git");
        let _ = std::fs::create_dir_all(&d);
        let r = parse_ref(&d.to_string_lossy()).unwrap();
        assert!(r.is_local(), "a drive path must be treated as local");
        assert_eq!(r.host, "local");
        assert_eq!(
            r.repo, "myrepo",
            "the .git suffix is stripped from the slug"
        );
        // For a local repo the clone URL must be the path itself, never https.
        assert!(!r.https_url().starts_with("https://"));
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    #[test]
    fn parses_file_url_as_local() {
        let d = std::env::temp_dir().join("devhub-fileurl").join("repo");
        let _ = std::fs::create_dir_all(&d);
        let url = format!("file:///{}", d.to_string_lossy().replace('\\', "/"));
        let r = parse_ref(&url).unwrap();
        assert!(r.is_local(), "file:// must be treated as local");
        assert_eq!(r.repo, "repo");
        let _ = std::fs::remove_dir_all(d.parent().unwrap());
    }

    #[test]
    fn missing_local_path_is_rejected_with_a_clear_error() {
        let missing = std::env::temp_dir().join("devhub-does-not-exist-xyz");
        let _ = std::fs::remove_dir_all(&missing);
        let err = parse_ref(&missing.to_string_lossy()).unwrap_err();
        assert!(format!("{err}").contains("本地路径不存在"));
    }

    #[test]
    fn verbatim_prefix_is_stripped_from_canonical_paths() {
        // canonicalize() returns \\?\D:\... on Windows; converting that to a URL
        // yields file://///?/D:/... which git rejects.
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\D:\repos\myrepo")).to_string_lossy(),
            r"D:\repos\myrepo"
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\repo")).to_string_lossy(),
            r"\\server\share\repo"
        );
        // An ordinary path is returned unchanged.
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"D:\plain")).to_string_lossy(),
            r"D:\plain"
        );
    }

    #[test]
    fn marker_round_trips_and_preserves_launch_settings() {
        let d = std::env::temp_dir().join("devhub-marker-test");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        // A fresh marker with a port block.
        let services: Vec<(String, u16)> = vec![("http".into(), 20000), ("db".into(), 20005)];
        std::fs::write(
            marker_path(&d),
            serde_json::to_string_pretty(&Marker {
                slug: "github.com/alice/tool".into(),
                url: "https://github.com/alice/tool.git".into(),
                cloned_at: "2026-01-01T00:00:00Z".into(),
                port_base: 20000,
                services: services.clone(),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();

        let m = read_marker(&d).unwrap();
        assert_eq!(m.port_base, 20000);
        assert_eq!(
            m.services, services,
            "port assignments must survive a round trip"
        );
        assert!(m.launch.is_none());

        // Adding a confirmed launch command must not disturb the port block.
        update_marker(&d, |m| {
            m.launch = Some(crate::launch::LaunchConfig {
                command: "npm run dev".into(),
                cwd: String::new(),
                user_confirmed: true,
                kind: None,
                steps: Vec::new(),
            })
        })
        .unwrap();

        let after = read_marker(&d).unwrap();
        assert_eq!(after.port_base, 20000, "portBase must be preserved");
        assert_eq!(after.services, services, "services must be preserved");
        let l = after.launch.expect("launch config saved");
        assert_eq!(l.command, "npm run dev");
        assert!(l.user_confirmed);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn marker_backward_compat_old_file_without_description_parses_as_none() {
        let d = std::env::temp_dir().join("devhub-marker-bc");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        // Simulate an old marker written before C3 added the `description` field.
        let old_json = r#"{
            "slug": "github.com/alice/tool",
            "url": "https://github.com/alice/tool.git",
            "clonedAt": "2026-01-01T00:00:00Z",
            "portBase": 20000,
            "services": [["http", 20000]]
        }"#;
        std::fs::write(marker_path(&d), old_json).unwrap();

        let m = read_marker(&d).expect("old marker must parse");
        assert_eq!(m.slug, "github.com/alice/tool");
        assert!(m.description.is_none(), "absent description must parse as None, not as an error");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn marker_round_trips_description_override() {
        let d = std::env::temp_dir().join("devhub-marker-desc");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();

        update_marker(&d, |m| {
            m.description = Some("My custom project description".into());
        })
        .unwrap();

        let m = read_marker(&d).unwrap();
        assert_eq!(m.description.as_deref(), Some("My custom project description"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn find_repo_by_slug_accepts_full_slug_and_bare_name() {
        let root = std::env::temp_dir().join("devhub-findrepo");
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("code/github.com/alice/tool");
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        assert!(find_repo_by_slug(&root, "github.com/alice/tool").is_some());
        assert!(find_repo_by_slug(&root, "tool").is_some());
        assert!(find_repo_by_slug(&root, "nope").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The regression that produced "未找到仓库": the project view passed
    /// `owner/repo` (no host) and every action on a downloaded repository failed.
    #[test]
    fn find_repo_by_slug_accepts_owner_repo_and_the_flat_directory_name() {
        let root = std::env::temp_dir().join("devhub-findrepo-flat");
        let _ = std::fs::remove_dir_all(&root);

        // Current layout: flat directory, identity from the marker.
        let repo = root.join("opus-video-prompts_joeseesun");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(
            marker_path(&repo),
            r#"{"slug":"github.com/joeseesun/opus-video-prompts","url":"","clonedAt":"","portBase":20000,"services":[]}"#,
        )
        .unwrap();

        for spelling in [
            "github.com/joeseesun/opus-video-prompts",
            "joeseesun/opus-video-prompts",
            "opus-video-prompts",
            "opus-video-prompts_joeseesun",
        ] {
            assert_eq!(
                find_repo_by_slug(&root, spelling).as_deref(),
                Some(repo.as_path()),
                "lookup failed for `{spelling}`"
            );
        }

        // Legacy layout, marker present (as every 0.2.0 download wrote one).
        let legacy = root.join("code/github.com/alice/tool");
        std::fs::create_dir_all(legacy.join(".git")).unwrap();
        std::fs::write(
            marker_path(&legacy),
            r#"{"slug":"github.com/alice/tool","url":"","clonedAt":"","portBase":20010,"services":[]}"#,
        )
        .unwrap();
        for spelling in [
            "github.com/alice/tool",
            "alice/tool",
            "tool",
            "code/github.com/alice/tool",
        ] {
            assert_eq!(
                find_repo_by_slug(&root, spelling).as_deref(),
                Some(legacy.as_path()),
                "legacy lookup failed for `{spelling}`"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_repository_the_wall_lists_can_be_found_by_its_own_slug() {
        // The invariant `--scan-check` broke on a real container: two
        // hand-copied repositories were listed as `github.com/<owner>/<repo>`
        // (recovered from their `<repo>_<owner>` directory names) but no spelling
        // resolved them, so clicking either answered 未找到仓库. Listing and
        // lookup must accept the same identity, which is what this pins down.
        let root = std::env::temp_dir().join("devhub-listed-is-findable");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("hyperframes_heygen-com/.git")).unwrap();
        std::fs::create_dir_all(root.join("tool_alice/.git")).unwrap();
        std::fs::write(
            marker_path(&root.join("tool_alice")),
            r#"{"slug":"github.com/alice/tool"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("code/github.com/carol/legacy/.git")).unwrap();

        let mut listed: Vec<RepoRef> = Vec::new();
        collect_repos(&root, &mut |_rel, abs| {
            if let Some(r) = repo_ref_of(&root, abs) {
                listed.push(r);
            }
        });
        assert_eq!(listed.len(), 3, "the walk must find all three");

        for r in &listed {
            let found = find_repo_by_slug(&root, &r.slug());
            assert_eq!(
                found.as_deref(),
                r.path.as_deref().map(std::path::Path::new),
                "{} is listed on the wall but no spelling resolves it",
                r.slug()
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hand_picked_port_block_is_checked_the_way_allocation_checks_its_own() {
        let root = std::env::temp_dir().join("devhub-port-claim");
        let _ = std::fs::remove_dir_all(&root);
        // One repository already holding an off-grid block, which is exactly what a
        // hand-edited `.devhub.json` produces and what the guard exists to catch.
        let holder = root.join("holder_owner");
        std::fs::create_dir_all(holder.join(".git")).unwrap();
        std::fs::write(
            holder.join(".devhub.json"),
            serde_json::json!({ "slug": "github.com/a/holder", "portBase": 29975 }).to_string(),
        )
        .unwrap();
        let other = root.join("other_owner");
        std::fs::create_dir_all(other.join(".git")).unwrap();

        // Range and grid first, because they are the two mistakes a person typing a
        // number can actually make.
        assert!(claim_port_block(&[root.clone()], 8080, &other).is_err());
        assert!(claim_port_block(&[root.clone()], 40000, &other).is_err());
        assert!(claim_port_block(&[root.clone()], 20005, &other).is_err());

        let clash = claim_port_block(&[root.clone()], 29970, &other)
            .expect_err("29970-29979 contains the holder's 29975");
        assert!(
            clash.contains("holder_owner") && clash.contains("29975"),
            "a rejection has to name who holds the block: {clash}"
        );

        // A repository may keep the block it already holds - that is what `except` is
        // for, matched by directory name because the index and a fresh walk can spell
        // the same path with a different case.
        let mine = root.join("mine_owner");
        std::fs::create_dir_all(mine.join(".git")).unwrap();
        std::fs::write(
            mine.join(".devhub.json"),
            serde_json::json!({ "slug": "github.com/a/mine", "portBase": 29960 }).to_string(),
        )
        .unwrap();
        // The guarantee under test is the marker scan's `except`: a repository must
        // never be told its own block overlaps *itself*. It is NOT a guarantee that
        // the block is free on this machine - measured 2026-10-16, an unrelated
        // `node server.js` was LISTENING on 29960 (`netstat -ano -p TCP`), and the
        // live-occupancy check below the marker scan then refused the claim for a
        // reason that has nothing to do with self-collision. Accept that refusal;
        // fail only on the one this test is about.
        match claim_port_block(&[root.clone()], 29960, &mine) {
            Ok(_) => {}
            Err(e) => assert!(
                e.contains("正在被监听") || e.contains("本次运行中的下载保留"),
                "自持的对齐段只可能因真实占用被拒，不能因自己的 marker 被拒：{e}"
            ),
        }
        let taken_by_mine = claim_port_block(&[root.clone()], 29960, &other)
            .expect_err("29960 belongs to mine_owner");
        assert!(taken_by_mine.contains("mine_owner"), "{taken_by_mine}");

        // An off-grid value is refused even for the repository that holds it: the pool
        // the app allocates from is aligned, so re-saving a legacy odd number through
        // this door is not on offer. The dialog never sends an unchanged value, so this
        // only reaches someone who types the number by hand.
        assert!(
            claim_port_block(&[root.clone()], 29975, &holder).is_err(),
            "off-grid blocks are refused for everyone, holder included"
        );

        let free = claim_port_block(&[root.clone()], 29940, &other).unwrap();
        assert_eq!(free.base, 29940);
        assert_eq!(
            free.services.first(),
            Some(&("http".to_string(), 29940)),
            "the named assignments are derived from the block, so they move with it"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The whole point of R1-3's split: which flags get passed is decidable without a
    /// repository, and the local-path case must produce **no** flags rather than flags
    /// that git will throw away while still exiting 0.
    #[test]
    fn clone_strategy_flags_are_only_issued_where_git_would_honour_them() {
        // A measured fact from `scripts/clone-bench.ps1` phase A: against a filesystem
        // path git prints `--depth is ignored in local clones` and clones everything.
        assert!(source_ignores_clone_strategy("D:\\wai\\mirror\\upstream"));
        assert!(source_ignores_clone_strategy("/srv/mirror/upstream.git"));
        assert!(source_ignores_clone_strategy("./relative"));
        assert!(source_ignores_clone_strategy(""));
        // `file://` is the transport a mirror restore can use and git names it as the
        // remedy for the ignored flag, so it must NOT be treated as local.
        assert!(!source_ignores_clone_strategy("file:///D:/wai/mirror/upstream"));
        assert!(!source_ignores_clone_strategy("https://github.com/o/r"));
        assert!(!source_ignores_clone_strategy("HTTP://example.com/o/r"));
        assert!(!source_ignores_clone_strategy("git@github.com:o/r"));
        assert!(!source_ignores_clone_strategy("ssh://git@host/o/r"));
        assert!(!source_ignores_clone_strategy("git://127.0.0.1:29717/upstream.git"));

        let remote = "https://github.com/o/r";
        assert!(clone_strategy_args("full", remote).is_empty());
        assert!(clone_strategy_args("", remote).is_empty());
        assert!(clone_strategy_args("banana", remote).is_empty());
        assert_eq!(clone_strategy_args("shallow", remote), ["--depth", "1"]);
        assert_eq!(clone_strategy_args("SHALLOW", remote), ["--depth", "1"]);
        assert_eq!(clone_strategy_args("blobless", remote), ["--filter=blob:none"]);
        // And the local case issues nothing at all, flag-shaped or otherwise.
        assert!(clone_strategy_args("shallow", "D:\\wai\\mirror\\upstream").is_empty());
        assert!(clone_strategy_args("blobless", "D:\\wai\\mirror\\upstream").is_empty());
    }

    /// The sentences that go into the activity record. Each one is checked against the
    /// stderr git actually printed in the benchmark, and the blobless case is asserted
    /// to *not* claim more than the probe supports — that understated wording is the
    /// entire reason this function exists.
    #[test]
    fn a_strategy_git_threw_away_is_reported_as_thrown_away() {
        // full / unset says nothing at all.
        assert!(clone_strategy_note("full", "", Path::new("git"), Path::new(".")).is_none());
        assert!(clone_strategy_note("", "", Path::new("git"), Path::new(".")).is_none());

        let local = "warning: --depth is ignored in local clones; use file:// instead.";
        let n = clone_strategy_note("shallow", local, Path::new("git"), Path::new("."))
            .expect("a local ignore must be reported");
        assert!(n.contains("实际是完整克隆"), "{n}");
        assert!(n.contains("--depth is ignored in local clones"), "{n}");

        let unsup = "warning: filtering not recognized by server, ignoring";
        let n = clone_strategy_note("blobless", unsup, Path::new("git"), Path::new("."))
            .expect("an unsupported filter must be reported");
        assert!(n.contains("实际是完整克隆"), "{n}");

        // An unknown value says which one it was and what it did instead.
        let n = clone_strategy_note("banana", "", Path::new("git"), Path::new("."))
            .expect("an unrecognised value is worth a line");
        assert!(n.contains("banana") && n.contains("完整克隆"), "{n}");

        // blobless with a clean stderr must NOT become "已确认". The config lies (the
        // same two keys are written when the server ignores the filter), so the honest
        // answer is that it could not be confirmed from here.
        let n = clone_strategy_note("blobless", "Receiving objects: 100%", Path::new("git"), Path::new("."))
            .expect("a request is worth recording");
        assert!(n.contains("不能证明"), "{n}");
        assert!(!n.contains("已确认"), "{n}");

        // shallow goes to git itself. A missing/unreadable git says "无法确认" rather
        // than assuming the flag worked.
        let missing = std::env::temp_dir().join("devhub-no-such-git-binary");
        let n = clone_strategy_note("shallow", "ok", missing.as_path(), Path::new("."))
            .expect("a probe that could not run is still a statement");
        assert!(n.contains("无法向 git 确认"), "{n}");
    }

    #[test]
    fn looks_like_venv_accepts_either_layout_and_refuses_a_plain_directory() {
        let root = std::env::temp_dir().join("devhub-venv-looks");
        let _ = std::fs::remove_dir_all(&root);
        let stdlib = root.join("a");
        std::fs::create_dir_all(&stdlib).unwrap();
        std::fs::write(stdlib.join("pyvenv.cfg"), "home = x").unwrap();
        assert!(looks_like_venv(&stdlib));

        let scripts = root.join("b").join("Scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("python.exe"), "").unwrap();
        assert!(looks_like_venv(&root.join("b")), "virtualenv/conda layout");

        let plain = root.join("c");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!looks_like_venv(&plain));
        assert!(!looks_like_venv(&root.join("missing")));
        assert!(!looks_like_venv(stdlib.join("pyvenv.cfg").as_path()), "not a directory");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_repos_ignores_devhub_bookkeeping_directories() {
        let root = std::env::temp_dir().join("devhub-collect");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("kept_owner/.git")).unwrap();
        // These must never be reported as projects.
        std::fs::create_dir_all(root.join("venvs/kept_owner/.git")).unwrap();
        std::fs::create_dir_all(root.join("cache/covers/.git")).unwrap();
        std::fs::create_dir_all(root.join("_worktrees/x/.git")).unwrap();
        std::fs::create_dir_all(root.join("code/github.com/bob/legacy/.git")).unwrap();

        let mut found: Vec<String> = Vec::new();
        collect_repos(&root, &mut |rel, _abs| {
            found.push(rel.to_string_lossy().replace('\\', "/"));
        });
        found.sort();

        assert_eq!(
            found,
            vec![
                "code/github.com/bob/legacy".to_string(),
                "kept_owner".to_string()
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn repo_ref_of_reads_the_marker_before_guessing_from_the_name() {
        let root = std::env::temp_dir().join("devhub-refof");
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("weird_name_with_underscores");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(
            marker_path(&repo),
            r#"{"slug":"gitlab.com/some-group/weird_name_with_underscores","url":"","clonedAt":"","portBase":0,"services":[]}"#,
        )
        .unwrap();

        let r = repo_ref_of(&root, &repo).expect("marker must identify the repository");
        assert_eq!(r.host, "gitlab.com");
        assert_eq!(r.owner, "some-group");
        assert_eq!(r.repo, "weird_name_with_underscores");

        // A directory with no marker falls back to the `<repo>_<owner>` name.
        let manual = root.join("manualrepo_someone");
        std::fs::create_dir_all(manual.join(".git")).unwrap();
        let r = repo_ref_of(&root, &manual).unwrap();
        assert_eq!(r.repo, "manualrepo");
        assert_eq!(r.owner, "someone");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn progress_percent_reads_gits_own_number() {
        assert_eq!(
            progress_percent("Receiving objects:  45% (1234/2740), 1.20 MiB"),
            Some(45)
        );
        assert_eq!(progress_percent("Resolving deltas: 100% (10/10)"), Some(100));
        assert_eq!(progress_percent("Cloning into 'tool'..."), None);
        assert_eq!(progress_percent("remote: Enumerating objects: 12"), None);
        // A line with a stray % must not be mistaken for progress.
        assert_eq!(progress_percent("error: 100 % broken"), None);
    }

    #[test]
    fn short_hash_keeps_gits_own_length() {
        assert_eq!(short_hash("0123456789abcdef"), "0123456");
        // Shorter than seven (a test stub) is passed through, not padded.
        assert_eq!(short_hash("abc"), "abc");
        assert_eq!(short_hash(""), "");
    }

    /// The mirror rule a pull uses. A pull fetches from the repository's own
    /// remote, so both mirror spellings have to arrive as one `insteadOf` rule
    /// that rewrites `https://github.com/` - the trailing slash is what makes
    /// the rule match at all (`DEVELOPMENT.md` §3).
    #[test]
    fn mirror_instead_of_rewrites_the_github_prefix() {
        // Bare host: the rule the download ladder already builds for a clone.
        assert_eq!(
            mirror_instead_of("hk.gh-proxy.com", "github.com"),
            vec!["url.hk.gh-proxy.com/.insteadOf=https://github.com/".to_string()]
        );
        // Full prefix: the same substitution written as one opaque rule.
        assert_eq!(
            mirror_instead_of("https://gh-proxy.com/", "github.com"),
            vec![
                "url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/"
                    .to_string()
            ]
        );
        // A trailing slash on the entry must not double up.
        assert_eq!(
            mirror_instead_of("hk.gh-proxy.com/", "github.com"),
            mirror_instead_of("hk.gh-proxy.com", "github.com")
        );
        // The host is honoured, not assumed: a gist or enterprise host keeps its
        // own origin in the rule.
        assert_eq!(
            mirror_instead_of("hk.gh-proxy.com", "gist.github.com"),
            vec!["url.hk.gh-proxy.com/.insteadOf=https://gist.github.com/".to_string()]
        );
    }

    /// An update refuses what is not a git repository instead of letting git
    /// fail somewhere inside the ladder with a confusing message.
    #[test]
    fn update_refuses_a_directory_without_git_history() {
        let root = std::env::temp_dir().join(format!("devhub-upd-nogit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cfg = DownloaderConfig {
            project_root: root.clone(),
            ..Default::default()
        };
        let dl = Downloader::new(cfg, None);
        // No git on the machine would also refuse; either way the answer must be
        // an error, never a panic.
        match dl {
            Ok(dl) => {
                let err = dl
                    .update(std::sync::Arc::new(|_, _| {}), &root)
                    .expect_err("a plain directory has no history to pull");
                assert!(
                    err.to_string().contains("没有 git 历史"),
                    "unexpected error: {err}"
                );
            }
            Err(e) => assert!(
                // `DownloadError` carries payloads (a slug, a network detail) and has
                // no PartialEq, so the variant is matched rather than compared.
                matches!(e, DownloadError::GitMissing),
                "expected GitMissing, got {e:?}"
            ),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `last_pull` is a new field: every pre-round-11 marker has to keep
    /// deserializing with it absent, which `#[serde(default)]` provides.
    #[test]
    fn an_old_marker_still_loads_with_the_new_fields_absent() {
        let root = std::env::temp_dir().join(format!("devhub-upd-oldmarker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Exactly the shape 0.2.0 wrote: no lastPull, no pythonChoice. Marker is
        // `#[serde(rename_all = "camelCase")]`, so a snake_case document here would
        // not be "an old marker" — it would be a different format that never existed
        // (compare the fixture `scripts/verify-fixes.ps1` writes: clonedAt/portBase).
        std::fs::write(
            marker_path(&root),
            r#"{"slug":"github.com/alice/tool","url":"https://github.com/alice/tool.git","clonedAt":"2026-01-01T00:00:00Z","portBase":20000,"services":[["http",20000]]}"#,
        )
        .unwrap();
        let m = read_marker(&root).expect("an old marker must still parse");
        assert!(m.last_pull.is_none());
        assert!(m.python_choice.is_none());
        assert_eq!(m.port_base, 20000);
        // And the new fields round-trip once set.
        update_marker(&root, |m| {
            m.last_pull = Some("2026-10-14T00:00:00Z".into());
            m.python_choice = Some(r"C:\Python312\python.exe".into());
        })
        .unwrap();
        let after = read_marker(&root).unwrap();
        assert_eq!(after.last_pull.as_deref(), Some("2026-10-14T00:00:00Z"));
        assert_eq!(
            after.python_choice.as_deref(),
            Some(r"C:\Python312\python.exe")
        );
        assert_eq!(after.port_base, 20000, "the port block survives");
        let _ = std::fs::remove_dir_all(&root);
    }
}

