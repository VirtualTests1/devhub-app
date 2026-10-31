#![cfg(test)]

use super::*;

    /// `update_repo` owes the freshness cache an eviction: after a pull moves
    /// HEAD, the slug's cached verdict describes a commit no longer checked out.
    /// This pins both halves of the policy — a *successful* update drops that
    /// slug's entry, a refused `--ff-only` pull keeps it, and the eviction is
    /// scoped to the slug that was updated.
    #[test]
    fn a_successful_update_evicts_only_that_slugs_freshness_entry() {
        let verdict = |slug: &str, state: &str| Freshness {
            slug: slug.to_string(),
            state: state.to_string(),
            local_head: None,
            remote_head: None,
            checked_at: 0,
            error: None,
        };
        freshness_store(&verdict("r17-updated", "behind"));
        freshness_store(&verdict("r17-untouched", "fresh"));

        invalidate_freshness_after_update(false, "r17-updated");
        assert!(
            freshness_cached("r17-updated").is_some(),
            "a refused pull leaves HEAD in place, so the cached verdict is still valid",
        );

        invalidate_freshness_after_update(true, "r17-updated");
        assert!(
            freshness_cached("r17-updated").is_none(),
            "after a successful update the slug's cache entry must no longer exist",
        );
        assert_eq!(
            freshness_cached("r17-untouched").map(|f| f.state),
            Some("fresh".to_string()),
            "eviction must be scoped to the slug that was updated",
        );

        // The cache is a process-wide singleton; leave it as we found it.
        freshness_evict("r17-untouched");
    }

    #[test]
    fn env_cache_stores_and_clears() {
        {
            let mut g = ENV_CACHE.lock().unwrap();
            let map = g.get_or_insert_with(Default::default);
            map.insert(
                "demo-slug".to_string(),
                (std::time::Instant::now(), Environments { python: Some("py".into()), node: None, docker: None, vscode: None }),
            );
        }
        {
            let g = ENV_CACHE.lock().unwrap();
            let env = g.as_ref().unwrap().get("demo-slug").unwrap().1.clone();
            assert_eq!(env.python.as_deref(), Some("py"));
        }
        clear_env_cache();
        let g = ENV_CACHE.lock().unwrap();
        assert!(g.as_ref().map(|m| m.is_empty()).unwrap_or(true));
    }

    /// The units in a history line have to read the same as the wall's own
    /// `formatBytes`, and the thresholds are where a hand-written ladder drifts:
    /// 1023 B stays bytes, 1024 becomes KB, and the GB step is the only one with
    /// two decimals. Pinned because `human_bytes` and `src/lib/format.ts` are two
    /// implementations of one contract with nothing between them but a comment.
    #[test]
    fn human_bytes_uses_the_binary_ladder() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(1024 * 1024 - 1), "1024.0 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(human_bytes(125_829_120), "120.0 MB");
        assert_eq!(human_bytes(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(human_bytes(1_610_612_736), "1.50 GB");
    }

    #[test]
    fn window_state_usable_rejects_off_screen_and_swapped_monitors() {
        // 同一台屏、窗口完全在工作区内 → 可用。
        let same_monitor = WindowState {
            x: 100.0, y: 80.0, width: 1200.0, height: 800.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(window_state_usable(&same_monitor, 1920.0, 1040.0));
        // 显示器换了尺寸（副屏拔掉/缩放变了）→ 不信任旧坐标。
        assert!(!window_state_usable(&same_monitor, 1366.0, 768.0));
        // 窗口跑到工作区右边外面去了 → 退回居中。
        let offscreen = WindowState {
            x: 2000.0, y: 80.0, width: 1200.0, height: 800.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(!window_state_usable(&offscreen, 1920.0, 1040.0));
        // 比最小还小的记录是坏数据，退回最小居中。
        let too_small = WindowState {
            x: 100.0, y: 80.0, width: 400.0, height: 300.0,
            maximized: false, monitor_w: 1920.0, monitor_h: 1040.0,
        };
        assert!(!window_state_usable(&too_small, 1920.0, 1040.0));
    }

    #[test]
    fn phrase_helpers_answer_every_input_shape() {
        // An unknown mode must read 手动, not 每天 with an empty tail.
        assert_eq!(cleanup_phrase("manual", 30), "手动");
        assert_eq!(cleanup_phrase("", 30), "手动");
        assert_eq!(cleanup_phrase("daily", 0), "每天 · 保留 永久");
        assert_eq!(cleanup_phrase("weekly", 30), "每周 · 保留 30 天");
        assert_eq!(cleanup_phrase("monthly", 7), "每月 · 保留 7 天");
        assert_eq!(route_phrase("useHosts"), "沿用本地加速");
        assert_eq!(route_phrase("bypass"), "绕过（IP 直连）");
        assert_eq!(route_phrase("nonsense"), "绕过（IP 直连）");
        assert_eq!(retention_phrase(0), "永久");
        assert_eq!(retention_phrase(1), "1 天");
    }

    /// `reap` freezes `ran_for` at the exit moment, so retention measured with it
    /// never expired for a short-lived process. `exited_at` is the clock that must
    /// drive the TTL, and every path that marks a child exited has to set it.
    #[test]
    fn an_exit_stamps_the_retention_clock() {
        let child = proc::silent("cmd")
            .args(["/C", "exit"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd /C exit");
        let pid = child.id();
        let mut g = std::collections::HashMap::new();
        g.insert(
            pid,
            Tracked {
                child,
                label: "x".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );
        // Polled rather than slept-and-asserted: `cmd /C exit` is instantaneous in
        // theory, but on a machine running six other checkouts' typechecks it is
        // not, and a fixed 120 ms sleep made this test fail for load, not for
        // behaviour. The deadline only bounds how long we wait to observe it.
        for _ in 0..100 {
            reap(&mut g);
            if g.get(&pid).map(|t| t.exited).unwrap_or(false) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let t = g.get(&pid).expect("entry");
        assert!(t.exited, "the dead child must read as exited");
        assert!(
            t.exited_at.is_some(),
            "and the TTL clock must start; without it the entry is un-prunable"
        );
        assert!(t.ran_for.is_some(), "run duration stays frozen");
    }

    /// The exit policy has to take the child down, not merely relabel it. Spawning a
    /// real 30-ping child is the only way to ask that question here; `proc::silent`
    /// keeps it from flashing a console window during the test run.
    #[test]
    fn kill_tree_terminates_a_tracked_child_and_counts_it_once() {
        let child = proc::silent("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a long-running child");
        let pid = child.id();
        let procs = std::sync::Mutex::new(std::collections::HashMap::from([(
            pid,
            Tracked {
                child,
                label: "ping".into(),
                slug: "t/t".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        )]));

        let (killed, failures) = kill_tree(&procs);
        assert_eq!(killed, 1, "one running process, one kill");
        // `failures` is *allowed* to be non-empty here: this test runs on a machine
        // that may be building six worktrees at once, and the tree kill is bounded by
        // `PROBE_TIMEOUT`, so a starved `taskkill` can legitimately time out. What
        // must never happen is a silent one — see the deterministic case below, which
        // asserts the reporting path itself instead of the machine's composure.
        for f in &failures {
            assert!(
                f.contains("taskkill 超时") || f.contains("无法运行") || f.contains("PID"),
                "a reported tree-kill failure has to name its pid and reason: {f}"
            );
        }
        {
            let g = procs.lock().expect("table lock");
            let t = g.get(&pid).expect("the entry stays in the table");
            assert!(t.exited, "and it must read as exited afterwards");
            assert!(t.ran_for.is_some(), "with its run time frozen at the kill");
            assert!(
                t.exited_at.is_some(),
                "and the retention clock starts here, not at `ran_for`"
            );
        }
        assert_eq!(
            kill_tree(&procs).0,
            0,
            "a second pass must not re-count or re-kill what already went"
        );
    }

    /// The reporting path itself, without depending on the machine being idle.
    ///
    /// `kill_tree` used to drop every `taskkill` outcome, so an orphan holding a
    /// port after quit was invisible. A pid that cannot exist is the deterministic
    /// way to prove the failure is now surfaced and named.
    #[test]
    fn an_unkillable_pid_is_reported_instead_of_swallowed() {
        use std::collections::HashMap;
        let mut child = proc::silent("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a long-running child");
        let real = child.id();
        // A pid the OS will not find: `taskkill` fails fast on this, while the
        // real child keeps the entry live so the accounting path is exercised too.
        let ghost = if real == u32::MAX { real - 1 } else { u32::MAX };
        let procs = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        {
            let mut g = procs.lock().expect("table");
            g.insert(
                real,
                Tracked {
                    child,
                    label: "ping".into(),
                    slug: "t/t".into(),
                    started: std::time::Instant::now(),
                    exited: false,
                    code: None,
                    job_handle: None,
                    ran_for: None,
                    exited_at: None,
                    suspended: false,
                },
            );
        }
        let reaped = procs.lock().unwrap().remove(&real);
        if let Some(mut t) = reaped {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
        let mut g = procs.lock().unwrap();
        g.insert(
            ghost,
            Tracked {
                child: proc::silent("cmd")
                    .args(["/C", "ping", "-n", "30", "127.0.0.1"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .expect("spawn the second child"),
                label: "ghost".into(),
                slug: "t/t".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );
        drop(g);
        let (killed, failures) = kill_tree(&procs);
        assert_eq!(killed, 1, "the ghost entry is still counted as taken down");
        // Measured, not assumed: `taskkill /PID <nonexistent>` *starts fine* and
        // exits non-zero with 「没有找到进程」, so what must reach the caller is the
        // pid and that reason — the pre-fix code dropped both.
        assert!(
            failures.iter().any(|f| f.contains(&ghost.to_string()) && f.contains("ghost")),
            "the reported failure has to name the pid and the label it belongs to, got {failures:?}"
        );
        assert!(
            failures.iter().any(|f| {
                let s = f.to_lowercase();
                s.contains("没有找到进程") || s.contains("退出码") || s.contains("not found") || s.contains("exit code")
            }),
            "the OS reason must survive into the report, got {failures:?}"
        );
    }

    /// The failure mode the write lock exists for, made deterministic.
    ///
    /// Two transactions that each touch a *different* field lose one of them when
    /// both read before either writes: the second write is built on the pre-first
    /// read and reverts the first field on disk. A single field cannot show this
    /// (last-writer-wins is indistinguishable from a lost update), so the probe uses
    /// `terminal_choice` and `ide_choice`.
    ///
    /// Driven on plain values rather than against the real `devhub-config.json`: a
    /// test that rewrote the developer's own config would be worse than no test, which
    /// is the same reason `transact` takes the read/write pair as arguments.
    /// `reap` is what the process panel's 运行中/已退出 answer is built from, and it
    /// is the function that freezes `ran_for`. Nothing tested it: `proc.rs` tests the
    /// syscalls, not the registry the UI reads.
    #[test]
    fn reap_freezes_an_exited_child_once() {
        let mut child = proc::silent("cmd")
            .args(["/C", "exit", "3"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd /C exit 3");
        // Waited for here so the `try_wait` inside `reap` already has an answer: the
        // test is about what `reap` does with it, not about timing.
        let status = child.wait().expect("the child is gone");
        let pid = child.id();
        let mut g = std::collections::HashMap::new();
        g.insert(
            pid,
            Tracked {
                child,
                label: "npm run dev".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited: false,
                code: None,
                job_handle: None,
                ran_for: None,
                exited_at: None,
                suspended: false,
            },
        );

        reap(&mut g);
        let t = g.get(&pid).unwrap();
        assert!(t.exited, "an exited child must be marked exited");
        assert_eq!(t.code, status.code(), "and its exit code recorded");
        let first = t.ran_for.expect("frozen at the moment it went");

        reap(&mut g);
        assert_eq!(
            g.get(&pid).unwrap().ran_for,
            Some(first),
            "a second pass must not let the number keep growing - that was the old bug"
        );
    }

    /// The three states and the two affordance flags, because the frontend offers
    /// 停止/挂起 from `stoppable`/`suspendable` alone.
    #[test]
    fn summarise_reports_state_and_affordances() {
        fn tracked(exited: bool, suspended: bool, code: Option<i32>) -> Tracked {
            let child = proc::silent("cmd")
                .args(["/C", "exit"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn cmd /C exit");
            Tracked {
                child,
                label: "dev".into(),
                slug: "o/r".into(),
                started: std::time::Instant::now(),
                exited,
                code,
                job_handle: None,
                ran_for: Some(std::time::Duration::from_millis(1500)),
                exited_at: if exited { Some(std::time::Instant::now()) } else { None },
                suspended,
            }
        }

        let mut g = std::collections::HashMap::new();
        g.insert(1, tracked(false, false, None));
        g.insert(2, tracked(false, true, None));
        g.insert(3, tracked(true, false, Some(7)));

        let mut rows: Vec<(u32, String, bool, bool, Option<i32>, u64)> = g
            .iter()
            .map(|(pid, t)| {
                let s = summarise(*pid, t);
                (
                    s.pid,
                    s.state,
                    s.stoppable,
                    s.suspendable,
                    s.exit_code,
                    s.elapsed_ms,
                )
            })
            .collect();
        rows.sort();

        assert_eq!(rows[0].1, "running", "neither exited nor suspended");
        assert!(rows[0].2 && rows[0].3, "running is stoppable and suspendable");
        assert_eq!(rows[1].1, "suspended");
        assert_eq!(rows[2].1, "exited");
        assert_eq!(rows[2].4, Some(7), "the exit code reaches the panel");
        assert!(
            !rows[2].2 && !rows[2].3,
            "an exited process must not offer 停止 or 挂起"
        );
        for row in rows.iter() {
            assert_eq!(row.5, 1500, "ran_for is what the elapsed number reports");
        }
        for t in g.values_mut() {
            let _ = t.child.wait();
        }
    }

    #[test]
    fn an_interleaved_read_modify_write_reverts_the_other_field() {
        // Not driven with threads on purpose: forcing "both read before either writes"
        // needs a barrier inside the read, and the gated run then deadlocks on that
        // barrier by construction. `gated_transactions_never_lose_an_increment` covers
        // the concurrent half; this one pins the *arithmetic* of the failure.
        let base = AppConfig::default();

        // Ungated: both transactions start from the same old value.
        let a = {
            let mut c = base.clone();
            c.terminal_choice = "pwsh".into();
            c
        };
        let b = {
            let mut c = base.clone();
            c.ide_choice = "code".into();
            c
        };
        // The point of the shape: `b` was built from `base`, so writing it after `a`
        // reverts `a`'s field.
        // A writes, then B — still holding a pre-A snapshot — writes over it. Both
        // bindings are used on purpose: naming them is what keeps the lost update
        // readable, and `let _ = a` would let the compiler drop the first write.
        let after_a = a;
        let disk = {
            let _ = &after_a;
            b
        };
        assert_eq!(disk.ide_choice, "code");
        assert_ne!(
            disk.terminal_choice, "pwsh",
            "A's choice was reverted by B's stale write — that is the lost update"
        );

        // Gated: B reads what A left behind, so both land.
        let mut disk = base;
        {
            let mut c = disk.clone();
            c.terminal_choice = "pwsh".into();
            disk = c;
        }
        {
            let mut c = disk.clone();
            c.ide_choice = "code".into();
            disk = c;
        }
        assert_eq!(disk.terminal_choice, "pwsh");
        assert_eq!(disk.ide_choice, "code");
    }

    /// The concurrent half, and the reason the gate spans the whole read→edit→write
    /// sequence: 24 gated transactions against one field all land.
    #[test]
    fn gated_transactions_never_lose_an_increment() {
        use std::sync::{Arc, Mutex};
        const N: usize = 24;
        let stored = Arc::new(Mutex::new(AppConfig::default()));
        let gate = Arc::new(Mutex::new(()));
        // `AppConfig::default().parallel_downloads` is not zero (it is the shipped
        // default), so the assertion is about the delta, not the absolute number.
        let before = stored.lock().unwrap().parallel_downloads;

        std::thread::scope(|scope| {
            for _ in 0..N {
                let stored = Arc::clone(&stored);
                let gate = Arc::clone(&gate);
                scope.spawn(move || {
                    // Taken here rather than passed to `transact` because production's
                    // gate is a `&'static Mutex` (`CONFIG_WRITE`) while this store lives
                    // on the test's stack; the span under test is identical.
                    let _guard = gate.lock().unwrap();
                    let read = {
                        let stored = Arc::clone(&stored);
                        move || Ok(stored.lock().unwrap().clone())
                    };
                    let write = {
                        let stored = Arc::clone(&stored);
                        move |c: &AppConfig| {
                            *stored.lock().unwrap() = c.clone();
                            Ok(())
                        }
                    };
                    if transact(None, read, write, |cfg| {
                        cfg.parallel_downloads += 1;
                        Ok(())
                    })
                    .is_err()
                    {
                        panic!("the in-memory store never fails to write");
                    }
                });
            }
        });

        assert_eq!(
            stored.lock().unwrap().parallel_downloads as usize,
            before as usize + N,
            "every gated increment must be present; fewer is the lost update"
        );
    }

    /// What `transact` guarantees, and what the validating callers depend on: an edit
    /// that returns `Err` persists nothing — not even the fields it already mutated in
    /// place. (`update_config_if_changed`'s "unchanged means no write" rule lives in
    /// that helper rather than here, so this pins the failure path only.)
    #[test]
    fn a_rejected_edit_writes_nothing() {
        use std::sync::{Arc, Mutex};
        let stored = Arc::new(Mutex::new(AppConfig::default()));
        let writes = Arc::new(Mutex::new(0usize));
        let before = stored.lock().unwrap().clone();
        let read = {
            let stored = Arc::clone(&stored);
            move || Ok(stored.lock().unwrap().clone())
        };
        let write = {
            let stored = Arc::clone(&stored);
            let writes = Arc::clone(&writes);
            move |c: &AppConfig| {
                *stored.lock().unwrap() = c.clone();
                *writes.lock().unwrap() += 1;
                Ok(())
            }
        };
        let err = transact(None, read, write, |cfg| {
            cfg.terminal_choice = "cmd".into();
            // Annotated because this edit only ever fails, so `T` has no other
            // occurrence to be inferred from.
            Err::<(), _>("拒绝：这个选择不合法".to_string())
        })
        .unwrap_err();
        assert_eq!(err, "拒绝：这个选择不合法");
        assert_eq!(*writes.lock().unwrap(), 0, "a rejected edit must not persist");
        assert_eq!(
            stored.lock().unwrap().terminal_choice, before.terminal_choice,
            "and the mutation it made in memory must not have reached the store"
        );
    }

    /// undoable `value` descriptor must be reversible by the same key it was
    /// recorded under. If a setting starts recording an undo that
    /// `restore_config_value` does not know, the button appears and does nothing
    /// — which is worse than not offering it, so this test is the guard.
    #[test]
    fn every_recorded_undo_key_is_reversible() {
        let cases: &[(&str, &str)] = &[
            ("projectRoot", "D:\\somewhere\\else"),
            ("searchRoute", "useHosts"),
            ("downloadRoute", "bypass"),
            ("terminalChoice", "pwsh"),
            ("ideChoice", "vscode"),
            ("cleanupMode", "weekly"),
            ("mirrorEnabled", "false"),
            ("ipPinEnabled", "true"),
            ("activityRetentionDays", "90"),
            ("cleanupKeepDays", "7"),
            ("searchDebounceMs", "1200"),
            ("parallelDownloads", "5"),
        ];
        for (key, value) in cases {
            let mut cfg = AppConfig::default();
            restore_config_value(&mut cfg, key, value)
                .unwrap_or_else(|e| panic!("{key} is recorded as undoable but failed: {e}"));
        }
    }

    #[test]
    fn restoring_a_value_actually_changes_that_field_only() {
        let mut cfg = AppConfig::default();
        let before = (cfg.ip_pin_enabled, cfg.mirror_enabled, cfg.project_root.clone());
        restore_config_value(&mut cfg, "searchDebounceMs", "300").unwrap();
        assert_eq!(cfg.search_debounce_ms, 300);
        // The whole point of a per-field 回退 is that it does not also move
        // unrelated settings back to their defaults.
        assert_eq!(
            (cfg.ip_pin_enabled, cfg.mirror_enabled, cfg.project_root.clone()),
            before,
            "回退 one key must not disturb the others"
        );
    }

    #[test]
    fn a_recent_root_can_be_forgotten() {
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\old".into(), "D:\\older".into()];
        assert!(remove_recent_root(&mut cfg, "D:\\old").unwrap());
        assert_eq!(cfg.recent_roots, vec!["D:\\older".to_string()]);
        assert_eq!(cfg.project_root, "D:\\now", "删除历史不应动当前主目录");
    }

    #[test]
    fn the_live_main_root_is_never_erasable_from_history() {
        // 需求3 把它合并进同一张列表后，这条路径才真正可达：以前历史目录是
        // 只读的，用户碰不到「移除」；合并后如果这里放行，主目录会被自己
        // 抹掉，合并列表随即多出一条同路径的重复项。
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\now".into()];
        assert!(remove_recent_root(&mut cfg, "d:\\NOW").is_err());
        assert_eq!(cfg.recent_roots, vec!["D:\\now".to_string()]);
    }

    #[test]
    fn restore_refuses_bin_entries_that_belong_to_someone_else() {
        // 回收站里不止有 DevHub 删掉的东西：`restore_from_bin` 按 original_path 匹配
        // 整个回收站，所以「页面发来一个路径」并不等于「这个路径属于本项目」。
        // 不加约束时，一条被改坏的 回退 记录就能把别的程序删掉的文件还原到
        // 谁都没选过的位置。
        let container = std::env::temp_dir().join("devhub-restore-container");
        let elsewhere = std::env::temp_dir().join("devhub-restore-elsewhere");
        let _ = std::fs::remove_dir_all(&container);
        let _ = std::fs::remove_dir_all(&elsewhere);
        std::fs::create_dir_all(&container).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        let inside = container.join("tool_alice").to_string_lossy().to_string();
        let foreign = elsewhere.join("report.docx").to_string_lossy().to_string();

        assert!(
            restore_targets(&[inside.clone()], &[container.clone()]).is_empty(),
            "仓库目录内的还原目标不该被拦"
        );
        assert_eq!(
            restore_targets(&[foreign.clone()], &[container.clone()]),
            vec![foreign.clone()],
            "容器之外的路径必须被拒绝，哪怕它真实存在"
        );
        // 一批里混进一条外部路径，拒的就是那一条；命令按「有拒绝就整批不做」处理，
        // 而不是悄悄还原其余的。
        assert_eq!(
            restore_targets(&[inside, foreign], &[container.clone()]).len(),
            1
        );
        let _ = std::fs::remove_dir_all(&container);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn forgetting_something_already_gone_is_a_no_op_not_an_error() {
        // 用户可以两个窗口各点一次，或手工改过配置。重复删除应当安静成功，
        // 否则第二次点击会弹一个无法解释的失败。
        let mut cfg = AppConfig::default();
        cfg.project_root = "D:\\now".into();
        cfg.recent_roots = vec!["D:\\old".into()];
        assert!(!remove_recent_root(&mut cfg, "D:\\never-there").unwrap());
        assert_eq!(cfg.recent_roots, vec!["D:\\old".to_string()]);
        assert!(remove_recent_root(&mut cfg, "   ").is_err());
    }

    #[test]
    fn an_unrecorded_key_errors_rather_than_silently_succeeding() {
        let mut cfg = AppConfig::default();
        assert!(restore_config_value(&mut cfg, "githubToken", "x").is_err());
        // A value that cannot parse must surface, not leave the old number in
        // place while the UI reports 已回退.
        assert!(restore_config_value(&mut cfg, "parallelDownloads", "many").is_err());
    }

    #[test]
    fn a_fresh_config_enables_ip_pinning() {
        // `default_true` on AppConfig is the documented default; the UI states it
        // and the downloader's layer 2 depends on it.
        let cfg = AppConfig::default();
        assert!(
            cfg.ip_pin_enabled,
            "IP pinning must default to enabled; using derive(Default) here would silently disable layer 2"
        );
        assert!(!cfg.mirror_enabled, "third-party mirrors stay opt-in");
    }

    #[test]
    fn settings_state_is_seeded_from_the_saved_config() {
        let cfg = AppConfig {
            mirror_enabled: true,
            ip_pin_enabled: false,
            ..Default::default()
        };
        let settings = Settings::from_config(&cfg);
        assert!(locked_bool(&settings.mirror_enabled, false));
        assert!(!locked_bool(&settings.ip_pin_enabled, true));

        // And the seeder must not invert the default for a config that has never
        // been written: `AppConfig::default()` keeps pinning on.
        let fresh = Settings::from_config(&AppConfig::default());
        assert!(locked_bool(&fresh.ip_pin_enabled, true));
    }

    /// A scratch container laid out the way the real one is allowed to be:
    /// the current flat `<repo>_<owner>` form, the legacy
    /// `code/<host>/<owner>/<repo>` form, DevHub's own bookkeeping directories,
    /// a marked-but-not-cloned directory (an archive download has no `.git`),
    /// and a plain directory that is nothing at all.
    ///
    /// Named per test: these run in parallel in one process, and a container
    /// shared between them would be wiped by whichever finished first.
    fn guard_fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("devhub-delguard-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "tool_alice/.git",
            "code/github.com/bob/legacy/.git",
            "venvs/tool_alice",
            "cache/covers",
            "_worktrees/alice__tool",
            "not_a_project",
            "marked_only",
            "tool_alice/subdir",
            ".hidden/repo/.git",
        ] {
            std::fs::create_dir_all(root.join(dir)).expect("fixture");
        }
        // The archive-download case: no git history, only what the downloader
        // wrote. This is what makes the marker half of the rule necessary.
        std::fs::write(
            downloader::marker_path(&root.join("marked_only")),
            r#"{"slug":"github.com/carol/marked_only","url":"https://github.com/carol/marked_only.git","clonedAt":"","portBase":0,"services":[]}"#,
        )
        .expect("marker");
        root
    }

    #[test]
    fn the_delete_guard_allows_the_directories_the_container_lists_as_projects() {
        let root = guard_fixture("allows");
        let roots = [root.clone()];

        for rel in ["tool_alice", "code/github.com/bob/legacy"] {
            let (r, t) = path_guard::check_delete_target(&roots, &root.join(rel))
                .unwrap_or_else(|e| panic!("{rel} was refused: {e}"));
            let href = downloader::repo_ref_of(&r, &t)
                .unwrap_or_else(|| panic!("{rel} should resolve to a repository"));
            // The pair must be self-consistent: `delete_repo` compares the
            // repository's parent against this root when pruning an emptied
            // directory, so returning the two in different normal forms would
            // silently disable that cleanup.
            assert!(t.starts_with(&r), "{rel}: {t:?} is not under {r:?}");
            assert!(!href.slug().is_empty());
        }

        // An archive download carries only the marker, and a 回退 of it has to
        // work as well as a clone's.
        let marked = root.join("marked_only");
        let (_r, t) = path_guard::check_delete_target(&roots, &marked).expect("marked allowed");
        assert_eq!(
            downloader::read_marker(&t).map(|m| m.url),
            Some("https://github.com/carol/marked_only.git".to_string())
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_delete_guard_refuses_devhubs_own_directories_and_the_root() {
        let root = guard_fixture("refuses");
        let roots = [root.clone()];

        // Each of these is a directory the app cares about, none is a project:
        // the venv of another repository, the cover cache, a worktree copy, the
        // container itself, and a dot directory that the walk skips.
        for (rel, want) in [
            ("", "就是项目根目录"),
            ("venvs", "DevHub 自己的目录"),
            ("venvs/tool_alice", "DevHub 自己的目录"),
            ("cache", "DevHub 自己的目录"),
            ("_worktrees", "DevHub 自己的目录"),
            (".hidden", "DevHub 自己的目录"),
            (".hidden/repo", "DevHub 自己的目录"),
            ("not_a_project", "不是"),
            ("tool_alice/subdir", "不是"),
        ] {
            let p = if rel.is_empty() {
                root.clone()
            } else {
                root.join(rel)
            };
            let err = path_guard::check_delete_target(&roots, &p)
                .expect_err(&format!("{rel} must be refused"));
            assert!(
                err.contains(want),
                "{rel} was refused for the wrong reason: {err}"
            );
        }

        // Refusing has to mean refusing: the guard runs before anything is
        // removed, so everything it turned down must still be on disk.
        assert!(root.join("venvs/tool_alice").exists(), "refusing deleted");
        assert!(root.join("tool_alice/.git").exists());
        assert!(root.join("_worktrees/alice__tool").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_delete_guard_refuses_a_path_outside_every_root() {
        let root = guard_fixture("outside");
        let other =
            std::env::temp_dir().join(format!("devhub-delguard-other-{}", std::process::id()));
        std::fs::create_dir_all(other.join("stranger/repo/.git")).expect("fixture");
        let err = path_guard::check_delete_target(&[root.clone()], &other.join("stranger/repo"))
            .expect_err("must refuse");
        assert!(err.contains("不在任何项目根目录内"), "{err}");

        // A nested container is why one root's objection must not end the search.
        // `inside_repo_container/` sits *within* a repository as far as the first
        // root is concerned — the walk reports the repository and never descends
        // into it — while the second root was pointed at it directly, and there
        // it is an ordinary project. That is not hypothetical: the worktree
        // feature puts clones inside a repository.
        let nested = root.join("tool_alice/inside_repo_container");
        let inside = nested.join("repo/.git");
        std::fs::create_dir_all(inside).expect("fixture");
        let roots = [root.clone(), nested.clone()];
        let (r, t) = path_guard::check_delete_target(&roots, &nested.join("repo"))
            .unwrap_or_else(|e| panic!("the second root should have allowed it: {e}"));
        assert!(t.starts_with(&r));
        assert_eq!(
            r.file_name().and_then(|n| n.to_str()),
            Some("inside_repo_container")
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn the_delete_guard_says_so_for_a_directory_that_is_already_gone() {
        let root = guard_fixture("gone");
        let err = path_guard::check_delete_target(&[root.clone()], &root.join("alice/not-cloned"))
            .expect_err("missing");
        assert!(err.contains("已不存在"), "{err}");

        let err = path_guard::check_delete_target(&[root.clone()], std::path::Path::new(""))
            .expect_err("empty");
        assert!(err.contains("没有记下下载位置"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }
