//! Live reachability of the GitHub link.
//!
//! ## What this module is, and what it is not
//!
//! `link.rs` answers **which path** traffic takes: hosts redirection, the system
//! proxy, a listening forward proxy, DNS. Those facts change when the user starts
//! an accelerator or edits a setting, and the strip refreshes them on that
//! schedule. They do **not** answer the other question a person asks while a
//! download stalls: *is the link up right now?*
//!
//! This module answers only that second question. It resolves `github.com`,
//! connects to `github.com:443`, and reports `online` / `degraded` / `offline`
//! with the measured latency. It deliberately says nothing about hosts, proxies
//! or DNS poisoning — `LinkStatus` already owns those claims, and duplicating
//! them here would create a second, drifting answer.
//!
//! ## Probe shape
//!
//! A DNS resolve and a TCP connect, both inside a hard total budget of
//! [`PROBE_TIMEOUT`]. `ToSocketAddrs` has no timeout of its own, so the resolve
//! and connect run on a worker thread and the caller waits on a channel with
//! `recv_timeout`: a hung resolver cannot keep the command alive past the
//! budget. The worker sends the resolve stage first, which is what lets a
//! connect-stage timeout be classified as `degraded` (DNS answered, TCP did
//! not) rather than `offline` (DNS never answered).
//!
//! No TLS handshake is attempted. A TCP connect is the cheapest honest signal
//! and avoids judging certificates, which is the accelerator's problem and
//! already documented in `netpath.rs`.
//!
//! ## Cache
//!
//! The UI polls every 60 s and re-probes on click, so a 10 s TTL is short
//! enough that a click in a second window shares one answer while a manual
//! [`force`](status) always starts a fresh probe. The cache is a single entry
//! behind a `Mutex`, the same idiom `link.rs` and `netpath.rs` use.
//!
//! ## Tests
//!
//! Classification is a pure function over a `Sample`, so every branch and
//! boundary is unit-tested without a network. The probe itself is not called
//! from any test: a test suite that needs GitHub to be reachable is a flaky
//! suite.

use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The host every download and search ultimately needs.
pub const PROBE_HOST: &str = "github.com";

/// The port that matters for the app's HTTPS traffic.
pub const PROBE_PORT: u16 = 443;

/// Hard budget for one whole probe: resolve + every connect attempt.
///
/// Kept at the same order as the environment probe's own 300 ms loopback check
/// but large enough for a real TLS endpoint on a slow mobile link. The FE does
/// not show a spinner, so this is also the longest a manual re-probe can take.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);

/// A successful probe slower than this is reported as `degraded`.
///
/// Provenance: this is the same 2.5 s ceiling as [`PROBE_TIMEOUT`], chosen so
/// the two cannot disagree — a connect that only just fits inside the budget is
/// still "online", while anything that would have needed more is a connect
/// timeout. A lower number would call a working but slow link broken; a higher
/// one would be unreachable inside the budget.
pub const SLOW_LATENCY_MS: u64 = 2_500;

/// DNS taking longer than this is itself a degraded signal.
///
/// Provenance: measured public resolvers answer in 10–80 ms on the machines
/// this app targets; 1.2 s is more than an order of magnitude worse and still
/// leaves 1.3 s of the budget for the TCP connect. It does not fail the probe —
/// a slow answer is information, not an outage.
pub const SLOW_RESOLVE_MS: u64 = 1_200;

/// How long one answer is worth reusing.
///
/// The FE polls at 60 s and a manual click passes `force`, so 10 s only exists
/// to collapse two concurrent callers (the initial mount and a window-focus
/// probe, for example) into one dial. It is deliberately far below the poll
/// interval so the next scheduled probe still measures the link afresh.
pub const CACHE_TTL: Duration = Duration::from_secs(10);

/// The reachability verdict, as the strip renders it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NetState {
    /// DNS answered and the TCP connect succeeded inside the budget.
    Online,
    /// DNS answered, but the connect failed, timed out, or the probe was slow.
    Degraded,
    /// DNS itself did not answer inside the budget.
    Offline,
}

/// One probe's raw measurements, before classification.
///
/// Separated from [`NetStatus`] so the decision is a pure function of numbers
/// and booleans — the form the unit tests drive without touching the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Whether the resolver returned at least one address.
    pub resolved: bool,
    /// Whether a TCP connect to one of those addresses succeeded.
    pub connected: bool,
    /// Time spent in resolution. Meaningful only when `resolved` is true.
    pub resolve_ms: u64,
    /// Time from probe start to connect success/failure.
    pub latency_ms: u64,
}

/// The payload of the `net_status` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    pub state: NetState,
    /// True when DNS returned an address.
    pub resolved: bool,
    /// True when a TCP connect to `github.com:443` succeeded.
    pub connected: bool,
    /// Total resolve+connect time, or `None` when DNS never answered — a
    /// failure duration is not a latency and must not be rendered as one.
    pub latency_ms: Option<u64>,
}

/// The pure classification rule, with every threshold named above.
pub fn classify(sample: &Sample) -> NetState {
    if !sample.resolved {
        return NetState::Offline;
    }
    if !sample.connected {
        return NetState::Degraded;
    }
    if sample.resolve_ms > SLOW_RESOLVE_MS || sample.latency_ms > SLOW_LATENCY_MS {
        return NetState::Degraded;
    }
    NetState::Online
}

fn status_from(sample: Sample) -> NetStatus {
    NetStatus {
        state: classify(&sample),
        resolved: sample.resolved,
        connected: sample.connected,
        latency_ms: sample.resolved.then_some(sample.latency_ms),
    }
}

/// One worker-thread message. The split between `Resolved` and `Done` is the
/// whole reason the outer timeout can tell "DNS hung" from "TCP hung".
enum Stage {
    ResolveFailed,
    Resolved(u64),
    Done { connected: bool, latency_ms: u64 },
}

/// Runs the resolve + connect with a hard outer timeout.
fn probe_sample() -> Sample {
    let (tx, rx) = std::sync::mpsc::channel::<Stage>();
    std::thread::spawn(move || {
        let started = Instant::now();
        let addrs = match (PROBE_HOST, PROBE_PORT).to_socket_addrs() {
            Ok(iter) => iter.collect::<Vec<_>>(),
            Err(_) => {
                tx.send(Stage::ResolveFailed).ok();
                return;
            }
        };
        let resolve_ms = started.elapsed().as_millis() as u64;
        if tx.send(Stage::Resolved(resolve_ms)).is_err() {
            return;
        }
        let mut connected = false;
        for addr in addrs {
            let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            if TcpStream::connect_timeout(&addr, remaining).is_ok() {
                connected = true;
                break;
            }
        }
        let latency_ms = started.elapsed().as_millis() as u64;
        tx.send(Stage::Done {
            connected,
            latency_ms,
        })
        .ok();
    });

    let started = Instant::now();
    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(Stage::ResolveFailed) | Err(_) => Sample {
            resolved: false,
            connected: false,
            resolve_ms: started.elapsed().as_millis() as u64,
            latency_ms: started.elapsed().as_millis() as u64,
        },
        Ok(Stage::Resolved(resolve_ms)) => {
            let remaining = PROBE_TIMEOUT.saturating_sub(started.elapsed());
            match rx.recv_timeout(remaining) {
                Ok(Stage::Done {
                    connected,
                    latency_ms,
                }) => Sample {
                    resolved: true,
                    connected,
                    resolve_ms,
                    latency_ms,
                },
                // DNS answered but the connect stage used up the rest of the
                // budget: report the elapsed time, not a fabricated success.
                _ => Sample {
                    resolved: true,
                    connected: false,
                    resolve_ms,
                    latency_ms: started.elapsed().as_millis() as u64,
                },
            }
        }
        // `Done` cannot precede `Resolved`; treating it as a failed resolve is
        // the conservative reading rather than a panic.
        Ok(Stage::Done { .. }) => Sample {
            resolved: false,
            connected: false,
            resolve_ms: started.elapsed().as_millis() as u64,
            latency_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// A single-entry TTL cache, generic so the expiry rule is testable without a
/// network or a static.
struct TtlCache<T> {
    entry: Option<(Instant, T)>,
}

impl<T> TtlCache<T> {
    const fn new() -> Self {
        Self { entry: None }
    }
}

impl<T: Clone> TtlCache<T> {
    fn get(&self, now: Instant, ttl: Duration) -> Option<T> {
        let (at, value) = self.entry.as_ref()?;
        (now.saturating_duration_since(*at) < ttl).then(|| value.clone())
    }

    fn put(&mut self, now: Instant, value: T) {
        self.entry = Some((now, value));
    }
}

static CACHE: Mutex<TtlCache<NetStatus>> = Mutex::new(TtlCache::new());

/// Returns the current reachability, using the cache when it is fresh.
///
/// `force` bypasses the cache and is what a click on the strip's live signal
/// sends. Everything else (mount, focus, the 60 s timer) leaves it unset.
pub fn status(force: bool) -> NetStatus {
    if !force {
        if let Ok(cache) = CACHE.lock() {
            if let Some(after) = cache.get(Instant::now(), CACHE_TTL) {
                return after;
            }
        }
    }
    let status = status_from(probe_sample());
    if let Ok(mut cache) = CACHE.lock() {
        cache.put(Instant::now(), status.clone());
    }
    status
}

/// `net_status` — the live half of the status strip's network story.
///
/// `spawn_blocking` because the probe waits on DNS/TCP for up to
/// [`PROBE_TIMEOUT`]; a synchronous Tauri command would run it on the UI thread
/// and freeze the window for the same reason `environment` was moved off it.
#[tauri::command]
pub async fn net_status(force: Option<bool>) -> Result<NetStatus, String> {
    let force = force.unwrap_or(false);
    let started = Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || status(force))
        .await
        .map_err(|e| format!("net_status probe task failed: {e}"))?;
    crate::timing::report(
        "net_status",
        started.elapsed().as_millis(),
        format_args!(
            "state={:?} latency={:?} force={force}",
            out.state, out.latency_ms
        ),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(resolved: bool, connected: bool, resolve_ms: u64, latency_ms: u64) -> Sample {
        Sample {
            resolved,
            connected,
            resolve_ms,
            latency_ms,
        }
    }

    #[test]
    fn a_failed_resolve_is_offline() {
        assert_eq!(
            classify(&sample(false, false, 2_500, 2_500)),
            NetState::Offline,
            "no DNS answer is the offline case, even when TCP was never tried"
        );
    }

    #[test]
    fn a_resolve_without_a_connect_is_degraded() {
        assert_eq!(
            classify(&sample(true, false, 20, 80)),
            NetState::Degraded,
            "DNS answered, so the host is reachable but the link is not usable"
        );
    }

    #[test]
    fn a_fast_resolve_and_connect_is_online() {
        assert_eq!(
            classify(&sample(true, true, 20, 120)),
            NetState::Online
        );
    }

    #[test]
    fn slow_dns_is_degraded_even_when_the_connect_succeeds() {
        assert_eq!(
            classify(&sample(true, true, SLOW_RESOLVE_MS + 1, SLOW_RESOLVE_MS + 200)),
            NetState::Degraded
        );
    }

    #[test]
    fn a_slow_connect_is_degraded() {
        assert_eq!(
            classify(&sample(true, true, 20, SLOW_LATENCY_MS + 1)),
            NetState::Degraded
        );
    }

    #[test]
    fn the_thresholds_are_inclusive_on_the_healthy_side() {
        // Exactly at both named limits is still a working link: the probe's own
        // timeout is the same 2.5 s, so an exclusive boundary would make a
        // probe that completed inside its budget report itself as degraded.
        assert_eq!(
            classify(&sample(true, true, SLOW_RESOLVE_MS, SLOW_LATENCY_MS)),
            NetState::Online
        );
        assert_eq!(
            classify(&sample(true, true, SLOW_RESOLVE_MS + 1, SLOW_LATENCY_MS)),
            NetState::Degraded
        );
        assert_eq!(
            classify(&sample(true, true, SLOW_RESOLVE_MS, SLOW_LATENCY_MS + 1)),
            NetState::Degraded
        );
    }

    #[test]
    fn an_unresolved_status_has_no_latency() {
        let st = status_from(sample(false, false, 2_500, 2_500));
        assert_eq!(st.state, NetState::Offline);
        assert_eq!(
            st.latency_ms, None,
            "a failure duration must not be rendered as a latency"
        );
    }

    #[test]
    fn a_resolved_status_keeps_its_measured_latency() {
        let st = status_from(sample(true, true, 20, 120));
        assert_eq!(st.latency_ms, Some(120));
    }

    #[test]
    fn the_cache_expires_exactly_at_its_ttl() {
        let mut cache = TtlCache::new();
        let t0 = Instant::now();
        assert_eq!(cache.get(t0, CACHE_TTL), None, "an empty cache misses");
        cache.put(t0, 7u32);
        assert_eq!(
            cache.get(t0 + CACHE_TTL - Duration::from_millis(1), CACHE_TTL),
            Some(7),
            "just inside the TTL is a hit"
        );
        assert_eq!(
            cache.get(t0 + CACHE_TTL, CACHE_TTL),
            None,
            "the boundary itself is expired — otherwise the TTL is one tick longer than its name"
        );
    }

    #[test]
    fn a_second_put_replaces_the_first_answer() {
        let mut cache = TtlCache::new();
        let t0 = Instant::now();
        cache.put(t0, "old");
        cache.put(t0 + Duration::from_secs(1), "new");
        assert_eq!(cache.get(t0 + Duration::from_secs(2), CACHE_TTL), Some("new"));
    }
}
