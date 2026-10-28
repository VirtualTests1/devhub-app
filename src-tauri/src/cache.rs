//! In-process cache bounds (r20-O2).
//!
//! Extracted from `lib.rs` following the `deps.rs` (commit `6062783`) and `covers.rs`
//! (r20-O3-1) precedent: a rule with no repository state in it, so it can be tested
//! without a filesystem, a project root, or a network.
//!
//! ## Why one function rather than two call sites
//!
//! Both in-process maps in `lib.rs` had half of the same rule and were missing the
//! other half. The freshness cache carried a 5-minute TTL that was consulted only on
//! **read**, so expired verdicts kept their keys for the life of the process; the
//! environment cache had a 60-second TTL and neither eviction nor a bound. `heat.rs`
//! (CAP 400 + `retain`, `heat.rs:175-187`) and `search.rs` (cap 200 + `retain`,
//! `search.rs:205-213`) already do it correctly inside their own modules — this is that
//! shape, written down once so a third cache cannot invent a fourth variant.
//!
//! ## The order inside matters
//!
//! Expired entries are dropped *before* the cap is applied. A map that has been idle
//! longer than its TTL therefore never pays the cap for entries that are already wrong,
//! and eviction only ever discards a verdict that was still true — the oldest one.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Insert `(Instant::now(), value)` under `key`, dropping expired entries first and
/// then, only if the map is still full, the oldest surviving one.
pub(crate) fn insert_bounded<K, V>(
    map: &mut HashMap<K, (Instant, V)>,
    ttl: Duration,
    cap: usize,
    key: K,
    value: V,
) where
    K: Clone + Eq + Hash,
{
    let now = Instant::now();
    map.retain(|_, (at, _)| at.elapsed() < ttl);
    if map.len() >= cap {
        let mut ordered: Vec<(Instant, K)> = map.iter().map(|(k, (at, _))| (*at, k.clone())).collect();
        ordered.sort_by_key(|(at, _)| *at);
        // Make room for exactly one entry, oldest first — deterministic, so a test can
        // name which key had to go.
        let drop_n = map.len() - cap + 1;
        for (_, k) in ordered.into_iter().take(drop_n) {
            map.remove(&k);
        }
    }
    map.insert(key, (now, value));
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use super::insert_bounded;

    #[test]
    fn expired_entries_are_dropped_before_the_cap_is_counted() {
        // `checked_sub` is how a test manufactures an expired stamp without sleeping for
        // the TTL: the map is written by hand, then one insert decides its fate.
        let ttl = Duration::from_millis(50);
        let mut map: HashMap<String, (Instant, u8)> = HashMap::new();
        let old = Instant::now()
            .checked_sub(ttl * 2)
            .expect("an instant in the past");
        map.insert("stale".to_string(), (old, 1));
        insert_bounded(&mut map, ttl, 4, "fresh".to_string(), 2);
        assert!(
            !map.contains_key("stale"),
            "an expired entry must not survive a write"
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn the_cap_is_a_ceiling_and_the_oldest_live_entry_loses() {
        let ttl = Duration::from_secs(3600);
        let mut map: HashMap<String, (Instant, u8)> = HashMap::new();
        let base = Instant::now();
        map.insert("a".to_string(), (base, 1));
        map.insert("b".to_string(), (base + Duration::from_millis(5), 2));
        map.insert("c".to_string(), (base + Duration::from_millis(10), 3));
        insert_bounded(&mut map, ttl, 3, "d".to_string(), 4);
        assert_eq!(map.len(), 3);
        assert!(!map.contains_key("a"), "the oldest stamp is the one that goes");
        assert!(map.contains_key("d"));
    }

    #[test]
    fn rewriting_a_key_does_not_grow_the_map() {
        let ttl = Duration::from_secs(3600);
        let mut map: HashMap<String, (Instant, u8)> = HashMap::new();
        insert_bounded(&mut map, ttl, 2, "x".to_string(), 1);
        insert_bounded(&mut map, ttl, 2, "x".to_string(), 2);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("x").map(|(_, v)| *v), Some(2));
    }

    /// A zero-cap map is a caller error, but it must not panic or loop: the rule here is
    /// "keep the new entry", which is what the last assertion pins.
    #[test]
    fn a_cap_of_zero_still_accepts_the_new_entry() {
        let mut map: HashMap<String, (Instant, u8)> = HashMap::new();
        map.insert("old".to_string(), (Instant::now(), 1));
        insert_bounded(&mut map, Duration::from_secs(60), 0, "new".to_string(), 2);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("new"));
    }
}
