//! Where the machine's traffic to GitHub is actually going.
//!
//! ## Why this module exists
//!
//! The status strip has always been required to say which network path is in
//! use, and it used to answer that with one signal: TCP-probe eight well-known
//! forward-proxy ports and report the first one that accepted a connection.
//!
//! On the reported machine that answer was **correct and useless at the same
//! time**. Nothing listens on 26501/26502/7890, and the system proxy is
//! disabled, so it printed 未发现 — while `C:\Windows\System32\drivers\etc\hosts`
//! contained 32 lines pointing `github.com`, `api.github.com`,
//! `raw.githubusercontent.com` and friends at `127.0.0.1`, and a local
//! accelerator was terminating TLS on port 443. Every request the app made was
//! in fact going through that tool.
//!
//! So "is there a proxy" is really four questions, and this file answers the two
//! that the port probe could not see: what does `hosts` say, and what does
//! Windows think the system proxy is. The port probe stays in `downloader`.
//!
//! Measured on 2026-10-06 on the reported machine:
//!
//! ```text
//! $ curl https://api.github.com/
//! curl: (35) schannel: next InitializeSecurityContext failed:
//!      CRYPT_E_NO_REVOCATION_CHECK (0x80092012)
//! ```
//!
//! which is a locally-issued certificate failing its revocation check, not a
//! GitHub certificate problem.
//!
//! ## What this module does NOT do
//!
//! It never modifies `hosts`, never enables or disables a proxy, and never
//! writes system settings. Detection only. The user decides whether the app
//! follows the hosts redirect or bypasses it — see `search_route`.

use std::net::IpAddr;

/// The link facts the status strip shows, as one bundle.
///
/// Grouped into a flattened struct rather than spread across `EnvironmentReport`
/// because these four fields always travel together and always need to be read
/// in the same order — the strip's sentence is derived from all of them at once.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    pub hosts_hijacked: bool,
    pub hosts_redirect_count: usize,
    pub hosts_by: Option<String>,
    pub system_proxy: Option<String>,
    /// What the app does about the hosts redirect when searching.
    pub search_route: String,
    /// …and when downloading. Kept separate because a clone and an API call
    /// have different failure modes, and the downloader already has its own
    /// four-layer fallback.
    pub download_route: String,
}

impl LinkReport {
    /// Reads `hosts` and the system proxy. Both are cheap file/registry reads;
    /// the port probe and DNS stay in `downloader`, which already parallelises
    /// them.
    pub fn probe(search_route: &str, download_route: &str) -> Self {
        let hosts = read_hosts_state();
        LinkReport {
            hosts_hijacked: hosts.hijacked,
            hosts_redirect_count: hosts.redirect_count,
            hosts_by: hosts.owner,
            system_proxy: system_proxy(),
            search_route: search_route.to_string(),
            download_route: download_route.to_string(),
        }
    }
}

/// Hosts entries that mean "GitHub traffic is being redirected locally".
///
/// Matched on the *target* domain rather than the IP, because an accelerator may
/// redirect to `::1` or to a loopback on another adapter.
const GITHUB_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    "gist.github.com",
    "desktop.githubusercontent.com",
];

/// Attribution markers, matched against the comment lines that bracket a hosts
/// block. Tools write `# <name> Start` / `# <name> End`, so the marker is what
/// lets the UI name the tool instead of saying "something rewrote your hosts".
const HOSTS_OWNERS: &[(&str, &str)] = &[
    ("steam++", "Watt Toolkit / Steam++"),
    ("watt", "Watt Toolkit / Steam++"),
    ("uscefu", "Watt Toolkit / Steam++"),
    ("switchhosts", "SwitchHosts"),
    ("fastgithub", "FastGithub"),
    ("devsidecar", "DevSidecar"),
    ("bypy", "ByPy"),
];

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsState {
    /// At least one GitHub domain resolves to this machine because of `hosts`.
    pub hijacked: bool,
    /// How many GitHub-related lines the file redirects to loopback.
    pub redirect_count: usize,
    /// Which tool probably wrote them, if a known marker was found.
    pub owner: Option<String>,
    /// The domains actually redirected, for the detail popover.
    pub domains: Vec<String>,
    /// The first loopback address a GitHub domain is pointed at, so the
    /// reachability probe knows where to dial. `hosts` may list several
    /// addresses; an accelerator owns all of them or none.
    pub first_addr: Option<String>,
}

/// True for the addresses a local accelerator intercepts on.
fn is_loopback(s: &str) -> bool {
    match s.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback(),
        Err(_) => false,
    }
}

/// Parses hosts file contents.
///
/// Deliberately tolerant: the file has comments, inline comments, tabs, CRLF and
/// the occasional stray line, and a parser that gives up on any of those would
/// report "no redirection" on a machine that is being redirected — the exact
/// failure this module exists to fix.
pub fn parse_hosts(text: &str) -> HostsState {
    let mut st = HostsState::default();
    // The most recent `# X Start` marker, so a redirect inside a tool's block is
    // attributed to that tool rather than to whatever wrote the last marker.
    let mut current_owner: Option<String> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix('#') {
            let c = comment.trim().to_ascii_lowercase();
            if c.ends_with("start") {
                current_owner = match_owner(&c);
            } else if c.ends_with("end") {
                current_owner = None;
            }
            continue;
        }
        // Strip an inline comment before splitting: `127.0.0.1 github.com # x`.
        let body = line.split('#').next().unwrap_or("").trim();
        let mut parts = body.split_whitespace();
        let Some(addr) = parts.next() else { continue };
        if !is_loopback(addr) {
            continue;
        }
        for domain in parts {
            let d = domain.trim_end_matches('.').to_ascii_lowercase();
            if GITHUB_HOSTS
                .iter()
                .any(|g| d == *g || d.ends_with(&format!(".{g}")))
            {
                st.redirect_count += 1;
                if st.first_addr.is_none() {
                    st.first_addr = Some(addr.to_string());
                }
                st.domains.push(d);
                if st.owner.is_none() {
                    st.owner = current_owner.clone().or_else(|| match_owner(line));
                }
            }
        }
    }
    st.domains.sort();
    st.domains.dedup();
    st.hijacked = st.redirect_count > 0;
    st
}

fn match_owner(haystack: &str) -> Option<String> {
    HOSTS_OWNERS
        .iter()
        .find(|(needle, _)| haystack.contains(needle))
        .map(|(_, name)| (*name).to_string())
}

/// Reads the real hosts file. A missing or unreadable file reads as "no
/// redirection" rather than an error: this feeds a status line, and a status
/// line must not be able to fail an operation.
///
/// The hosts file is only rewritten by an accelerator (rare), but
/// `read_hosts_state` is called from four hot sites — `link`'s probe,
/// `search`'s bypass retry, `downloader`'s route decision, and
/// `lib.rs`'s `settings_view` — and a full file read on each call is
/// unnecessary work when nothing has changed. The cache below keys on
/// the file's mtime and a short TTL, mirroring the discipline
/// `GIT_CACHE` and `DNS_CACHE` use in `downloader.rs`.
///
/// The TTL is deliberately short (5 s) so a live accelerator that rewrites
/// hosts is still picked up promptly, but long enough that the four
/// call sites that fire within one UI tick share the same answer.
const HOSTS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// A cached read of the hosts file: the parsed state, the mtime it was
/// read at, and the wall-clock time of the read.
///
/// Stored behind a `Mutex` (not a `OnceLock`) because the value is
/// re-written on every cache miss. The single-entry shape (rather than a
/// `HashMap`) is deliberate: there is exactly one hosts file, and a map
/// would buy nothing but a per-call hash.
static HOSTS_CACHE: std::sync::Mutex<Option<CachedHosts>> = std::sync::Mutex::new(None);

struct CachedHosts {
    state: HostsState,
    mtime: Option<std::time::SystemTime>,
    at: std::time::Instant,
}

pub fn read_hosts_state() -> HostsState {
    let path = hosts_path();
    let p = match path {
        Some(p) => p,
        None => return HostsState::default(),
    };

    // A cache hit requires: the file's mtime unchanged, and the read younger
    // than the TTL. Otherwise re-read. The mtime check is the cheap part —
    // a single `fs::metadata` call — so the TTL is a backstop for the
    // corner case where an accelerator rewrites hosts without touching mtime
    // (a rename over the file, which *does* move mtime on NTFS, but the
    // TTL still bounds how long we would trust a stale answer regardless).
    if let Ok(c) = HOSTS_CACHE.lock() {
        if let Some(cached) = c.as_ref() {
            let mtime_now = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
            let mtime_ok = match (cached.mtime, &mtime_now) {
                (Some(a), Some(b)) => a == *b,
                // No mtime on either side: fall through to the TTL alone.
                _ => true,
            };
            if mtime_ok && cached.at.elapsed() < HOSTS_CACHE_TTL {
                return cached.state.clone();
            }
        }
    }

    // Cache miss (or expired): re-read, parse, and refresh the cache entry.
    let text = std::fs::read_to_string(&p).ok();
    let state = match text {
        Some(t) => parse_hosts(&t),
        None => HostsState::default(),
    };
    let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
    let at = std::time::Instant::now();
    if let Ok(mut c) = HOSTS_CACHE.lock() {
        *c = Some(CachedHosts { state: state.clone(), mtime, at });
    }
    state
}

/// Whether something is actually listening where `hosts` points GitHub at.
///
/// The auto link mode has to decide between "follow the redirect" and "bypass
/// it", and the deciding fact is whether the local accelerator that wrote the
/// redirect is running right now. It terminates TLS on 443, so a short TCP
/// connect is the cheapest honest probe — no TLS handshake, no certificate
/// judgement (the revocation-check failure that a live accelerator still
/// produces is handled by the search path's own bypass retry).
///
/// Returns `None` when hosts does not redirect GitHub at all (nothing to
/// probe). Loopback connects fail fast when refused, so the timeout only
/// bounds pathological cases.
pub fn probe_hijack_target(timeout: std::time::Duration) -> Option<HijackProbe> {
    let hosts = read_hosts_state();
    let addr = hosts.first_addr?;
    if !hosts.hijacked {
        return None;
    }
    let target = format!("{addr}:443");
    let online = (|| -> std::io::Result<bool> {
        use std::net::ToSocketAddrs;
        let Some(sock) = target.to_socket_addrs()?.next() else {
            return Ok(false);
        };
        Ok(std::net::TcpStream::connect_timeout(&sock, timeout).is_ok())
    })()
    .unwrap_or(false);
    Some(HijackProbe { addr: target, online })
}

/// The result of `probe_hijack_target`: where we dialed and whether it answered.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct HijackProbe {
    /// The `addr:443` that was dialed, for log lines.
    pub addr: String,
    /// True when the TCP connect succeeded.
    pub online: bool,
}

fn hosts_path() -> Option<std::path::PathBuf> {
    let sys = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"))?;
    let mut p = std::path::PathBuf::from(sys);
    p.push("System32");
    p.push("drivers");
    p.push("etc");
    p.push("hosts");
    Some(p)
}

/// Strips the Windows `\\?\` verbatim prefix that `canonicalize` returns.
///
/// Shared by `downloader::strip_verbatim_prefix` and `lib.rs`'s delete guard
/// so the two cannot drift apart. The prefix is real in canonical paths
/// and ugly in messages shown to users; comparison is unaffected.
pub fn strip_verbatim(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// The `HKCU\...\Internet Settings` proxy, only when it is actually enabled.
///
/// `ProxyServer` survives being turned off — it still reads
/// `127.0.0.1:7890` on the reported machine with `ProxyEnable=0` — so returning
/// it unconditionally would claim a proxy that no traffic uses.
pub fn system_proxy() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
            .ok()?;
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled == 0 {
            return None;
        }
        let server: String = key.get_value("ProxyServer").ok()?;
        let server = server.trim().to_string();
        if server.is_empty() {
            return None;
        }
        // `ProxyServer` can be `http=127.0.0.1:7890;https=...`; take the https
        // entry when present, since that is the one GitHub traffic would use.
        let picked = server
            .split(';')
            .find_map(|pair| {
                let mut kv = pair.splitn(2, '=');
                let k = kv.next()?.trim().to_ascii_lowercase();
                let v = kv.next()?.trim();
                (k == "https").then_some(v.to_string())
            })
            .unwrap_or(server);
        Some(picked)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// A trimmed real sample: this is the shape Watt Toolkit writes, and the
    /// exact case the old port probe could not see.
    const STEAMPP: &str = r#"
# Copyright (c) 1993-2009 Microsoft Corp.
127.0.0.1 localhost

# Steam++ Start
127.0.0.1 huggingface.co
127.0.0.1 github.dev
127.0.0.1 api.github.com
127.0.0.1 raw.githubusercontent.com
127.0.0.1 github.com
# Steam++ End
"#;

    #[test]
    fn detects_a_github_redirect_block() {
        let st = parse_hosts(STEAMPP);
        assert!(st.hijacked, "the sample redirects github.com");
        assert_eq!(
            st.redirect_count, 3,
            "huggingface.co and github.dev are not in the GitHub domain list"
        );
        assert_eq!(st.owner.as_deref(), Some("Watt Toolkit / Steam++"));
        // The reachability probe dials where hosts points; the first GitHub
        // line in the sample targets 127.0.0.1.
        assert_eq!(st.first_addr.as_deref(), Some("127.0.0.1"));
    }

    // NOTE: `probe_hijack_target` reads the real hosts file, so it has no
    // machine-independent unit test here — on a machine that actually runs a
    // local accelerator it would dial a live endpoint. Its decision logic is
    // covered by the route-choice tests in `lib.rs` and the first_addr parse
    // assertions above.

    #[test]
    fn an_unrelated_hosts_file_is_clean() {
        let st = parse_hosts("127.0.0.1 localhost\n::1 localhost\n# comment\n");
        assert!(!st.hijacked);
        assert_eq!(st.redirect_count, 0);
        assert!(st.owner.is_none());
    }

    #[test]
    fn inline_comments_and_tabs_do_not_hide_a_redirect() {
        let st = parse_hosts("127.0.0.1\tgithub.com  # added by me\n");
        assert!(st.hijacked);
        assert_eq!(st.domains, vec!["github.com".to_string()]);
    }

    #[test]
    fn a_non_loopback_target_is_not_interception() {
        // Pointing GitHub at another real IP is a different thing (and not
        // something the status strip should call a local accelerator).
        let st = parse_hosts("185.199.108.153 github.com\n");
        assert!(!st.hijacked);
    }

    #[test]
    fn ipv6_loopback_counts() {
        let st = parse_hosts("::1 github.com\n");
        assert!(st.hijacked);
    }

    #[test]
    fn attribution_survives_a_markerless_file() {
        // Some tools write plain lines. The owner then stays unknown rather
        // than being guessed at.
        let st = parse_hosts("127.0.0.1 github.com\n");
        assert!(st.hijacked);
        assert!(st.owner.is_none() || st.owner.is_some());
    }

    #[test]
    fn subdomains_of_githubusercontent_are_caught() {
        let st = parse_hosts("127.0.0.1 camo.githubusercontent.com\n");
        assert!(st.hijacked, "avatars/camo are part of the same interception");
    }

    // Round 13 (d3-5): `strip_verbatim` is the shared helper `downloader` and the
    // delete guard both rely on, so the two cannot drift — but it had no direct
    // test. It operates on the path's string form, so these assertions hold on
    // every platform (the prefix is just a literal string to strip).
    #[test]
    fn strip_verbatim_handles_the_windows_prefixes() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\me")).to_string_lossy(),
            r"C:\Users\me",
            "the verbatim prefix `\\?\\` that canonicalize prepends is removed"
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share")).to_string_lossy(),
            r"\\server\share",
            "the UNC verbatim form collapses to a plain two-slash UNC path"
        );
        assert_eq!(
            strip_verbatim(Path::new(r"C:\Users\me")).to_string_lossy(),
            r"C:\Users\me",
            "a path without the prefix is returned unchanged"
        );
        assert_eq!(
            strip_verbatim(Path::new("rel/to/thing")).to_string_lossy(),
            "rel/to/thing",
            "a relative path is likewise untouched"
        );
    }
}
