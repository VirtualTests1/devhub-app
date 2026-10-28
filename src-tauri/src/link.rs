//! Unified network link diagnostics.
//!
//! ## Why this module exists
//!
//! Before this module, the answer to "what path is my GitHub traffic taking?"
//! was spread across three files that each knew part of the truth:
//!
//!   * `netpath.rs` — reads `hosts` and the system proxy registry
//!   * `downloader.rs` — probes local proxy ports, resolves via public DNS
//!   * `search.rs` — decides whether to follow or bypass the hosts redirect
//!
//! The result was three independent answers that could disagree: the status
//! strip said 未发现 while `hosts` pointed at loopback; the search route
//! said 绕过 while the downloader had already given up on direct. A user
//! cannot act on three partial answers, so this module produces **one**
//! `LinkStatus` that every consumer reads.
//!
//! ## What it does NOT do
//!
//! It never modifies `hosts`, never enables or disables a proxy, and never
//! writes system settings. Detection only — the same constraint `netpath.rs`
//! documents. The user decides what to do about what this reports.

use serde::Serialize;
use std::sync::Mutex;

use crate::netpath::{self, HostsState};

/// The one answer to "what is happening to my GitHub traffic".
///
/// Every field is a fact the UI can show; `advice` is the single sentence
/// that tells the user what to do about it. Keeping the advice here rather
/// than in the UI means the logic is testable and the wording cannot drift
/// from the facts it describes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// Whether `hosts` redirects a GitHub domain to loopback.
    pub hosts_hijacked: bool,
    /// How many GitHub-related lines the hosts file redirects.
    pub hosts_redirect_count: usize,
    /// Who probably wrote them, if a known marker was found.
    pub hosts_by: Option<String>,
    /// The first loopback address a GitHub domain is pointed at.
    pub hosts_first_addr: Option<String>,
    /// Whether something is actually listening where hosts points.
    ///
    /// `None` when hosts does not redirect GitHub at all (nothing to probe).
    pub accelerator_online: Option<bool>,
    /// The `HKCU\...\Internet Settings` proxy, only when `ProxyEnable` is 1.
    pub system_proxy: Option<String>,
    /// A public-DNS-agreed IP for `github.com`, when one is available.
    pub resolved_ip: Option<String>,
    /// Whether the resolved IP is a real public address (not loopback).
    ///
    /// False when the local accelerator also answers DNS and all three
    /// resolvers agree on a loopback address — pinning to that would mean
    /// the "直连" label was attached to traffic going to the user's own
    /// machine.
    pub ip_is_public: bool,
    /// One sentence telling the user what to do, in Chinese.
    pub advice: String,
}

impl Default for LinkStatus {
    fn default() -> Self {
        Self {
            hosts_hijacked: false,
            hosts_redirect_count: 0,
            hosts_by: None,
            hosts_first_addr: None,
            accelerator_online: None,
            system_proxy: None,
            resolved_ip: None,
            ip_is_public: false,
            advice: String::new(),
        }
    }
}

/// How long a `LinkStatus` is worth reusing.
///
/// The facts this holds change when the user starts or stops an accelerator,
/// edits `hosts`, or changes the system proxy. None of those happen often,
/// but they can happen at any moment, so the cache is short: long enough to
/// avoid re-probing on every refresh, short enough that a change is picked
/// up within a few seconds.
const CACHE_TTL_MS: u64 = 5_000;

static CACHE: Mutex<Option<(std::time::Instant, LinkStatus)>> = Mutex::new(None);

/// Drops the cached `LinkStatus`.
///
/// Called after any operation that could have changed the network state:
/// a settings save that changes the route, a git bootstrap, or an explicit
/// refresh from the UI.
pub fn invalidate() {
    if let Ok(mut c) = CACHE.lock() {
        *c = None;
    }
}

/// Returns the current link status, using the cache when it is fresh.
///
/// `force` bypasses the cache — used when the user clicks 刷新 or when a
/// settings change might have altered the network path.
pub fn status(force: bool) -> LinkStatus {
    if !force {
        if let Ok(c) = CACHE.lock() {
            if let Some((at, st)) = c.as_ref() {
                if at.elapsed() < std::time::Duration::from_millis(CACHE_TTL_MS) {
                    return st.clone();
                }
            }
        }
    }
    let st = probe();
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((std::time::Instant::now(), st.clone()));
    }
    st
}

/// Probes every link fact and assembles the one `LinkStatus`.
///
/// This is the only function that knows how the pieces fit together, so the
/// advice string is derived from the complete picture rather than from one
/// signal.
fn probe() -> LinkStatus {
    let hosts = netpath::read_hosts_state();
    let system_proxy = netpath::system_proxy();
    let resolved = crate::downloader::resolve_agreed_ip("github.com");
    let ip_is_public = resolved
        .as_deref()
        .and_then(|ip| ip.parse::<std::net::IpAddr>().ok())
        .map(|a| match a {
            std::net::IpAddr::V4(v4) => {
                !v4.is_loopback()
                    && !v4.is_private()
                    && !v4.is_unspecified()
                    && !v4.is_link_local()
                    && !v4.is_multicast()
            }
            std::net::IpAddr::V6(v6) => {
                !v6.is_loopback() && !v6.is_unspecified() && !v6.is_multicast()
            }
        })
        .unwrap_or(false);

    let accelerator_online = if hosts.hijacked {
        netpath::probe_hijack_target(std::time::Duration::from_millis(300)).map(|p| p.online)
    } else {
        None
    };

    let advice = build_advice(&hosts, system_proxy.as_deref(), resolved.as_deref(), ip_is_public, accelerator_online);

    LinkStatus {
        hosts_hijacked: hosts.hijacked,
        hosts_redirect_count: hosts.redirect_count,
        hosts_by: hosts.owner,
        hosts_first_addr: hosts.first_addr,
        accelerator_online,
        system_proxy,
        resolved_ip: resolved,
        ip_is_public,
        advice,
    }
}

/// Builds the one-sentence advice from the complete picture.
///
/// The order matters: the most common and most actionable case (hosts
/// hijacked, accelerator running) comes first, and the fallback is the
/// "everything looks normal" case.
fn build_advice(
    hosts: &HostsState,
    system_proxy: Option<&str>,
    resolved_ip: Option<&str>,
    ip_is_public: bool,
    accelerator_online: Option<bool>,
) -> String {
    if hosts.hijacked {
        match accelerator_online {
            Some(true) => {
                return format!(
                    "hosts 把 GitHub 指向了本机（{} 条记录{}）。加速工具正在运行，可以沿用加速；如果搜索或下载失败，把链路设置改为「绕过」。",
                    hosts.redirect_count,
                    hosts
                        .owner
                        .as_ref()
                        .map(|o| format!("，可能是 {o} 写入的"))
                        .unwrap_or_default()
                )
            }
            Some(false) => {
                return format!(
                    "hosts 把 GitHub 指向了本机（{} 条记录），但加速工具没有运行。把链路设置改为「绕过」，或者启动你的加速工具。",
                    hosts.redirect_count
                )
            }
            None => {
                return format!(
                    "hosts 把 GitHub 指向了本机（{} 条记录）。如果搜索或下载失败，把链路设置改为「绕过」。",
                    hosts.redirect_count
                )
            }
        }
    }
    if let Some(proxy) = system_proxy {
        return format!(
            "系统代理已启用（{}）。如果 GitHub 访问异常，检查代理设置或把链路改为「绕过」。",
            proxy
        );
    }
    if let Some(ip) = resolved_ip {
        if ip_is_public {
            return format!("GitHub 解析到 {}，链路正常。", ip);
        } else {
            return "DNS 返回了非公网地址，可能是本地 DNS 被改写。把链路设置改为「绕过」。".to_string();
        }
    }
    "未能确认 GitHub 的解析地址，网络可能不可用。".to_string()
}

/// A short label for the status strip, derived from the same facts.
///
/// The strip has room for one phrase; this is that phrase. It deliberately
/// repeats no information the strip already shows as a number.
pub fn strip_label(st: &LinkStatus) -> &'static str {
    if st.hosts_hijacked {
        if st.accelerator_online == Some(true) {
            return "hosts 劫持 · 加速运行中";
        }
        return "hosts 劫持 · 加速未运行";
    }
    if st.system_proxy.is_some() {
        return "系统代理";
    }
    if st.resolved_ip.is_some() && st.ip_is_public {
        return "直连";
    }
    if st.resolved_ip.is_some() && !st.ip_is_public {
        return "DNS 异常";
    }
    "未探测"
}


#[cfg(test)]
mod tests {
    use super::*;

    /// The module doc says the advice builder lives here so it can be tested
    /// (`link.rs:31-32`); until now the file had no test module at all, and
    /// `build_advice` is the single function that turns three network facts into the
    /// sentence a user acts on.
    fn hosts(hijacked: bool, count: usize, owner: Option<&str>) -> netpath::HostsState {
        netpath::HostsState {
            hijacked,
            redirect_count: count,
            owner: owner.map(str::to_string),
            domains: vec!["github.com".to_string()],
            first_addr: Some("127.0.0.1".to_string()),
        }
    }

    #[test]
    fn an_online_accelerator_gets_use_hosts_advice() {
        let a = build_advice(&hosts(true, 4, Some("WattToolKit")), None, None, true, Some(true));
        assert!(a.contains("4 条记录"), "got {a}");
        assert!(a.contains("WattToolKit"), "names who wrote it: {a}");
        assert!(a.contains("沿用加速"), "the working route is 沿用加速: {a}");
        assert!(a.contains("绕过"), "and 绕过 is the fallback: {a}");
    }

    #[test]
    fn an_offline_accelerator_is_told_the_tool_is_not_running() {
        let a = build_advice(&hosts(true, 2, None), None, None, true, Some(false));
        assert!(a.contains("没有运行"), "got {a}");
        // It must not be told to keep using a route that is demonstrably down.
        assert!(!a.contains("可以沿用加速"), "got {a}");
    }

    #[test]
    fn an_unknown_accelerator_state_does_not_claim_one() {
        let a = build_advice(&hosts(true, 1, None), None, None, true, None);
        assert!(a.contains("如果搜索或下载失败"), "conditional wording: {a}");
        assert!(!a.contains("正在运行"), "no claim about the tool: {a}");
    }

    #[test]
    fn a_system_proxy_is_reported_before_dns() {
        let a = build_advice(&hosts(false, 0, None), Some("127.0.0.1:7890"), None, false, None);
        assert!(a.contains("127.0.0.1:7890"), "the proxy is quoted back: {a}");
        assert!(a.contains("系统代理"), "got {a}");
    }

    #[test]
    fn a_public_answer_is_called_normal_and_a_private_one_is_not() {
        let ok = build_advice(&hosts(false, 0, None), None, Some("20.205.243.166"), true, None);
        assert!(ok.contains("链路正常"), "got {ok}");
        let bad = build_advice(&hosts(false, 0, None), None, Some("10.0.0.1"), false, None);
        assert!(bad.contains("非公网地址"), "got {bad}");
        assert!(bad.contains("绕过"), "and it says what to switch to: {bad}");
    }

    #[test]
    fn no_answer_at_all_says_so() {
        let a = build_advice(&hosts(false, 0, None), None, None, false, None);
        assert!(a.contains("未能确认"), "got {a}");
    }
}
