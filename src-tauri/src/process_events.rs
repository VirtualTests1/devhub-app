//! Push notifications for the process table (`process://update`).
//!
//! The webview still polls `live_processes` every two seconds as the authoritative
//! reconciliation, but a spawn, stop, suspend/resume or crash used to be invisible
//! for up to one poll interval. This module adds the second channel: whenever the
//! *meaningful* state of the tracked table changes, the backend emits the same
//! `Vec<ProcessState>` that `live_processes` answers with.
//!
//! ## What drives an emit
//!
//! - Every mutation site calls [`ProcessNotifier::publish`] as soon as it has released
//!   the `procs` lock: the spawn sink, stop, suspend/resume, and the TTL sweep that
//!   runs inside `snapshot_processes`.
//! - A monitor thread reaps exited children every [`WATCH_EVERY`] and emits when the
//!   snapshot moved. Without it a crash would still wait for the frontend's next
//!   poll, because `reap` only runs when something asks for a snapshot.
//!
//! ## What the dedupe hash covers
//!
//! Emitting on every 500 ms tick would be worse than the poll it replaces, so the
//! notifier keeps the fingerprint of the last payload it sent. The hash covers
//! everything the UI renders or acts on:
//!
//!   `pid`, `label`, `slug`, `state`, `exit_code`, `stoppable`, `suspendable`,
//!   the list length, and the order of the entries.
//!
//! `elapsed_ms` is deliberately **excluded for running/suspended rows**: it advances
//! on every snapshot, so including it would make every tick a "change" and recreate
//! the exact spam the 2 s poll identity rule (`sameProcessList` in
//! `src/store/processes.ts`) exists to avoid. For `exited` rows the value is frozen
//! at the exit (`Tracked::ran_for`), so it is included: it is then a real fact, not a
//! clock. `live_processes` never returns exited rows today, but the fingerprint is
//! written against the full `ProcessState` shape so it stays honest if that changes.

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use crate::{snapshot_processes, ProcessState, ProcTable, Settings, Tracked};

/// How often the monitor reaps the table. A crash is therefore visible in under a
/// second, while a mutation site pushes immediately. One `try_wait` per tracked
/// child per tick — the child handles are already owned by the table, so this is a
/// syscall per process, not a scan.
pub(crate) const WATCH_EVERY: std::time::Duration = std::time::Duration::from_millis(500);

/// The fingerprint of one payload. See the module docs for the field list.
pub(crate) fn process_fingerprint(list: &[ProcessState]) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    list.len().hash(&mut hasher);
    for p in list {
        p.pid.hash(&mut hasher);
        p.label.hash(&mut hasher);
        p.slug.hash(&mut hasher);
        p.state.hash(&mut hasher);
        p.exit_code.hash(&mut hasher);
        p.stoppable.hash(&mut hasher);
        p.suspendable.hash(&mut hasher);
        if p.state == "exited" {
            p.elapsed_ms.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// Emits `process://update` once per meaningful change.
///
/// Cloning is cheap and shares the same dedupe cell, so every launch path and the
/// monitor all update one "last payload" rather than each keeping its own.
#[derive(Clone)]
pub(crate) struct ProcessNotifier {
    app: tauri::AppHandle,
    pub(crate) procs: Arc<ProcTable>,
    last: Arc<Mutex<Option<u64>>>,
}

impl ProcessNotifier {
    pub(crate) fn new(app: tauri::AppHandle, settings: &Settings) -> Self {
        Self {
            app,
            procs: Arc::clone(&settings.procs),
            last: Arc::clone(&settings.process_events),
        }
    }

    /// Takes the snapshot, compares it with the last emitted one, and emits only if
    /// something the UI reads actually changed.
    ///
    /// The `last` guard is held across the snapshot and the emit on purpose: two
    /// emitters racing without it could emit an older snapshot after a newer one
    /// (compute → compare → emit is not atomic). Mutations call this after releasing
    /// the `procs` lock, so the lock order here (`last` → `procs`) is the only one
    /// in the codebase.
    pub(crate) fn publish(&self) {
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = snapshot_processes(&self.procs);
        let fingerprint = process_fingerprint(&snapshot);
        if *last == Some(fingerprint) {
            return;
        }
        *last = Some(fingerprint);
        if let Err(e) = self.app.emit("process://update", &snapshot) {
            // Deliberately not `let _ = …`: the `rust-swallowed-errors` ratchet is
            // right that a failed emit means the webview was told nothing.
            eprintln!("[process] process://update 发送失败：{e}");
        }
    }
}

/// Starts the one reaping monitor. Called from `run()`'s setup, after `Settings`
/// has been managed.
pub(crate) fn start_monitor(app: tauri::AppHandle) {
    let notifier = {
        let settings = app.state::<Settings>();
        ProcessNotifier::new(app.clone(), &settings)
    };
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_EVERY);
        notifier.publish();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EXITED_TTL;
    use std::collections::HashMap;

    fn proc(over: impl FnOnce(&mut ProcessState)) -> ProcessState {
        let mut p = ProcessState {
            pid: 4000,
            label: "npm run dev".into(),
            slug: "github.com/a/b".into(),
            state: "running".into(),
            exit_code: None,
            elapsed_ms: 1000,
            stoppable: true,
            suspendable: true,
            cpu_ms: None,
            working_set_bytes: None,
            io_read_bytes: None,
            io_write_bytes: None,
        };
        over(&mut p);
        p
    }

    fn tracked(
        slug: &str,
        started: std::time::Instant,
        exited: bool,
        code: Option<i32>,
        exited_at: Option<std::time::Instant>,
    ) -> Tracked {
        let child = crate::proc::silent("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a child that stays alive for the duration of the test");
        Tracked {
            child,
            label: "dev".into(),
            slug: slug.into(),
            started,
            exited,
            code,
            job_handle: None,
            ran_for: if exited {
                Some(std::time::Duration::from_millis(1500))
            } else {
                None
            },
            exited_at,
            suspended: false,
        }
    }

    fn stop(table: &mut HashMap<u32, Tracked>) {
        for (_, mut t) in table.drain() {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
    }

    #[test]
    fn fingerprint_ignores_the_clock_on_live_rows() {
        // A tick that only let time pass must not wake the webview — same rule as
        // `sameProcessList` on the frontend.
        let a = proc(|p| p.elapsed_ms = 1000);
        let b = proc(|p| p.elapsed_ms = 9100);
        assert_eq!(process_fingerprint(&[a]), process_fingerprint(&[b]));
    }

    #[test]
    fn fingerprint_changes_for_every_field_the_ui_reads() {
        let base = proc(|_| {});
        let variants = [
            proc(|p| p.pid = 4001),
            proc(|p| p.label = "pnpm dev".into()),
            proc(|p| p.slug = "gitee.com/a/b".into()),
            proc(|p| p.state = "suspended".into()),
            proc(|p| p.exit_code = Some(1)),
            proc(|p| p.stoppable = false),
            proc(|p| p.suspendable = false),
        ];
        for v in variants {
            assert_ne!(
                process_fingerprint(&[base.clone()]),
                process_fingerprint(&[v]),
                "a displayed field changed without changing the fingerprint"
            );
        }
        // Order is part of the payload: the popover walks the array.
        let a = proc(|p| p.pid = 1);
        let b = proc(|p| p.pid = 2);
        assert_ne!(
            process_fingerprint(&[a.clone(), b.clone()]),
            process_fingerprint(&[b, a])
        );
    }

    #[test]
    fn fingerprint_pins_the_frozen_elapsed_of_an_exited_row() {
        // `elapsed_ms` is frozen at exit, so for an exited row it is a fact rather
        // than a clock — and 已退出（代码 N）· 运行了 X 秒 renders it.
        let a = proc(|p| {
            p.state = "exited".into();
            p.exit_code = Some(0);
            p.elapsed_ms = 1500;
            p.stoppable = false;
            p.suspendable = false;
        });
        let mut b = a.clone();
        b.elapsed_ms = 2500;
        assert_ne!(process_fingerprint(&[a]), process_fingerprint(&[b]));
    }

    #[test]
    fn snapshot_returns_live_rows_in_pid_order_and_reaps_a_dead_child() {
        let now = std::time::Instant::now();
        let mut table = HashMap::new();

        let live = tracked("a/b", now, false, None, None);
        let live_pid = live.child.id();
        table.insert(live_pid, live);

        let mut dead = tracked("a/b", now, false, None, None);
        let dead_pid = dead.child.id();
        // Already gone before the first snapshot; `reap` has to notice and skip it.
        let _ = dead.child.kill();
        let _ = dead.child.wait();
        table.insert(dead_pid, dead);

        let procs = std::sync::Mutex::new(table);
        let snapshot = snapshot_processes(&procs);
        assert_eq!(snapshot.len(), 1, "an exited child must not be reported as live");
        assert_eq!(snapshot[0].pid, live_pid);
        assert_eq!(snapshot[0].state, "running");
        assert!(snapshot[0].stoppable);
        stop(&mut procs.into_inner().expect("table"));
    }

    #[test]
    fn snapshot_prunes_an_exited_entry_after_its_retention_window() {
        let now = std::time::Instant::now();
        // `Instant` cannot be constructed arbitrarily; on a machine that booted less
        // than EXITED_TTL ago there is no instant old enough, and the scenario cannot
        // exist yet anyway.
        let Some(old) = now.checked_sub(EXITED_TTL + std::time::Duration::from_secs(1)) else {
            return;
        };
        let mut dead = tracked("a/b", now, true, Some(1), Some(old));
        let pid = dead.child.id();
        // The row claims it exited; make the handle agree so `stop` below is not the
        // only thing that waits on it.
        let _ = dead.child.kill();
        let _ = dead.child.wait();
        let table = HashMap::from([(pid, dead)]);

        let procs = std::sync::Mutex::new(table);
        let snapshot = snapshot_processes(&procs);
        assert!(snapshot.is_empty(), "a row past EXITED_TTL must be forgotten");
        let mut left = procs.into_inner().expect("table");
        assert!(
            left.is_empty(),
            "the sweep must remove the entry, not merely hide it from the answer"
        );
        stop(&mut left);
    }
}
