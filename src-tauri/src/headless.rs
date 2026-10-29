//! Headless CLI checks (`run_headless_*`) used by `main.rs` for the
//! `--check-*` entry points — split out of `lib.rs` by r21-O1-2.
//!
//! These are `pub` and re-exported at the crate root (`pub use headless::*`)
//! because `main.rs` calls them as `devhub_app_lib::run_headless_*`; the paths
//! must not change. Bodies are verbatim — the move adds no behaviour.

use super::*;

/// Headless settings probe: `devhub-app.exe --settings-check`.
///
/// Writes a config, reads it back, asserts the round trip, and reports where the
/// file lives. Used to verify persistence without the GUI.
pub fn run_headless_settings_check() -> i32 {
    let path = config_path();
    println!("config_path = {}", path.display());
    println!("exists_before = {}", path.exists());

    // Preserve whatever is there so a developer's real settings are not clobbered.
    let backup = std::fs::read_to_string(&path).ok();

    let probe = AppConfig {
        project_root: std::env::temp_dir()
            .join("devhub-settings-probe")
            .to_string_lossy()
            .to_string(),
        mirror_enabled: true,
        ip_pin_enabled: false,
        mirrors: vec!["https://example.invalid/".to_string()],
        proxy: "http://127.0.0.1:26501".to_string(),
        github_token: "probe-token".to_string(),
        ..AppConfig::default()
    };

    if let Err(e) = write_config(&probe) {
        println!("ERROR 写入失败: {e}");
        return 1;
    }
    let read_back = read_config();

    let mut failures = Vec::new();
    if read_back.project_root != probe.project_root {
        failures.push("projectRoot 未往返");
    }
    if read_back.mirror_enabled != probe.mirror_enabled {
        failures.push("mirrorEnabled 未往返");
    }
    if read_back.ip_pin_enabled != probe.ip_pin_enabled {
        failures.push("ipPinEnabled 未往返");
    }
    if read_back.mirrors != probe.mirrors {
        failures.push("mirrors 未往返");
    }
    if read_back.proxy != probe.proxy {
        failures.push("proxy 未往返");
    }

    println!("project_root = {}", read_back.project_root);
    println!("mirror_enabled = {}", read_back.mirror_enabled);
    println!("ip_pin_enabled = {}", read_back.ip_pin_enabled);
    println!("mirrors = {:?}", read_back.mirrors);
    println!("proxy = {}", read_back.proxy);

    // The saved root must also become the effective one.
    let effective = std::env::var_os("DEVHUB_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(read_back.project_root.clone()));
    println!("effective_project_root = {}", effective.display());
    if std::env::var_os("DEVHUB_PROJECT_ROOT").is_none() && project_root() != effective {
        failures.push("project_root() 未采用已保存设置");
    }

    // A relaunch must pick the saved flags up. Before this was fixed the state was
    // built with `Settings::default()`, so both flags were false on every start.
    let seeded = Settings::from_config(&read_back);
    let seeded_mirror = locked_bool(&seeded.mirror_enabled, false);
    let seeded_pin = locked_bool(&seeded.ip_pin_enabled, true);
    println!("relaunch_mirror_enabled = {seeded_mirror}");
    println!("relaunch_ip_pin_enabled = {seeded_pin}");
    if seeded_mirror != probe.mirror_enabled {
        failures.push("重启后 mirrorEnabled 未采用已保存设置");
    }
    if seeded_pin != probe.ip_pin_enabled {
        failures.push("重启后 ipPinEnabled 未采用已保存设置");
    }

    // Validation must reject a read-only location.
    let bad = check_project_root("C:\\Program Files\\DevHub\\项目".to_string());
    println!("reject_program_files = {}", !bad.ok);
    if bad.ok {
        failures.push("Program Files 未被拒绝");
    }
    let good = check_project_root(std::env::temp_dir().to_string_lossy().to_string());
    println!("accept_temp_dir = {}", good.ok);
    if !good.ok {
        failures.push("临时目录被误拒");
    }

    // Restore the previous state.
    match backup {
        Some(prev) => {
            let _ = std::fs::write(&path, prev);
            println!("restored_previous_config = true");
        }
        None => {
            let _ = std::fs::remove_file(&path);
            println!("restored_previous_config = false (removed probe file)");
        }
    }

    if failures.is_empty() {
        println!("OK");
        0
    } else {
        println!("ERROR {}", failures.join("; "));
        1
    }
}

/// Headless search probe: `devhub-app.exe --search-check <query>`.
///
/// Performs a real search against GitHub and reports the results plus the
/// rate-limit situation. Also verifies that the cache serves the second request
/// without spending quota.
pub fn run_headless_search_check(query: &str) -> i32 {
    let mut cache = search::SearchCache::new();
    let token = read_config().github_token;
    let token = if token.trim().is_empty() {
        None
    } else {
        Some(token.as_str())
    };

    println!("query = {query}");
    println!("has_token = {}", token.is_some());
    println!("budget_before = {}", cache.remaining_budget());

    let first = search::search(&mut cache, query, 1, PAGE_SIZE, "", token, None);
    println!("--- first call (network) ---");
    println!("total_count = {}", first.total_count);
    println!("items = {}", first.items.len());
    println!("from_cache = {}", first.from_cache);
    println!("remaining_header = {:?}", first.remaining);
    println!("reset_in = {:?}", first.reset_in);
    println!("throttled = {}", first.throttled);
    if let Some(e) = &first.error {
        println!("error = {e}");
    }
    for hit in first.items.iter().take(5) {
        println!(
            "  {}  ⭐{}  {}  {}",
            hit.full_name,
            hit.stars,
            if hit.language.is_empty() {
                "-"
            } else {
                &hit.language
            },
            if hit.archived { "[archived]" } else { "" }
        );
    }
    println!("budget_after_first = {}", cache.remaining_budget());

    // Second identical call must be served from cache and spend no quota.
    let second = search::search(&mut cache, query, 1, PAGE_SIZE, "", token, None);
    println!("--- second call (cache expected) ---");
    println!("from_cache = {}", second.from_cache);
    println!("budget_after_second = {}", cache.remaining_budget());

    let mut failures = Vec::new();
    if first.error.is_some() {
        failures.push("首次搜索报错");
    }
    if first.items.is_empty() {
        failures.push("没有返回任何结果");
    }
    if !second.from_cache {
        failures.push("第二次相同查询未命中缓存");
    }
    if cache.remaining_budget() == 0 && first.error.is_none() && !first.from_cache {
        // Not a failure: the search succeeded but used the last of the budget.
        println!("note: local anonymous budget is now exhausted");
    }

    if failures.is_empty() {
        println!("OK");
        0
    } else {
        println!("ERROR {}", failures.join("; "));
        1
    }
}

/// Headless environment timing: `devhub-app.exe --env-check [runs]`.
///
/// Reports how long collecting the environment snapshot takes, broken down by
/// part. This exists because "the UI no longer freezes" is otherwise an
/// unverifiable claim: the fix moved this work off the UI thread, and the
/// measurable proxy for that is how long the work itself takes.
pub fn run_headless_env_check(runs: u32) -> i32 {
    let runs = runs.clamp(1, 20);
    let root = project_root();
    println!("project_root = {}", root.display());
    println!("runs = {runs}");

    // Warm up so first-run thread-pool creation does not dominate.
    let _ = collect_environment(&root, false, true, "bypass", "bypass", false);

    let mut worst_probe = 0u128;
    let mut worst_dns = 0u128;
    let mut worst_total = 0u128;

    for i in 1..=runs {
        let t_probe = std::time::Instant::now();
        let proxies = downloader::probe_local_proxies(&[]);
        let probe_ms = t_probe.elapsed().as_millis();

        let t_dns = std::time::Instant::now();
        let ip = downloader::resolve_agreed_ip("github.com");
        let dns_ms = t_dns.elapsed().as_millis();

        // A third, *combined* call. These are three separate measurements, and the
        // labels say so: one run can legitimately print a combined time smaller
        // than its standalone DNS time (the OS resolver caches between calls), which
        // looked like a contradiction when the column was called `total`.
        let t_total = std::time::Instant::now();
        let _ = collect_environment(&root, false, true, "bypass", "bypass", false);
        let total_ms = t_total.elapsed().as_millis();

        println!(
            "run {i}: probe_alone={probe_ms}ms ({} found) dns_alone={dns_ms}ms ({}) combined={total_ms}ms",
            proxies.len(),
            ip.as_deref().unwrap_or("no agreement")
        );
        worst_probe = worst_probe.max(probe_ms);
        worst_dns = worst_dns.max(dns_ms);
        worst_total = worst_total.max(total_ms);
    }
    println!(
        "note: probe_alone / dns_alone / combined are three separate calls, so they do not add up;"
    );
    println!("      only `combined` is the number the UI waits for.");

    // One-off: locating git, on a fresh lookup. `find_git` memoises, so this
    // reports the cached path - the cold cost was measured separately at ~2.8 s
    // before the cache existed. Kept as a regression guard: if it ever reports a
    // large number again, the cache has stopped working.
    let t_warm_git = std::time::Instant::now();
    let _ = find_git(bundled_runtime_dir().as_deref());
    let warm_git_ms = t_warm_git.elapsed().as_millis();

    println!("worst_probe_ms = {worst_probe}");
    println!("worst_dns_ms = {worst_dns}");
    println!("worst_total_ms = {worst_total}");
    println!("git_lookup_cached_ms = {warm_git_ms}");
    // Answers the "存在 UAC 提权" report from inside the app: DevHub never asks for
    // elevation, so a `true` here means it was started elevated from outside.
    println!("elevated = {}", proc::is_elevated());
    println!("note: find_git is memoised. Uncached it cost ~2.8 s (PATH walk + a");
    println!("      `git --version` subprocess) on every refresh; it is now ~0 ms.");

    // Budget covers probe + DNS. It is deliberately far below the old serial
    // probing cost (~2364 ms on the UI thread), so a regression trips it.
    const BUDGET_MS: u128 = 1500;
    if worst_total > BUDGET_MS {
        println!("ERROR 环境探测耗时 {worst_total}ms 超过预算 {BUDGET_MS}ms");
        return 1;
    }
    if warm_git_ms > 200 {
        println!("ERROR git 查询缓存失效，本次耗时 {warm_git_ms}ms");
        return 1;
    }
    println!("OK");
    0
}

/// Headless container-walk timing: `devhub-app.exe --scan-check [runs] [root]`.
///
/// Answers the question the `[timing]` line cannot: *why* a refresh is slow. It
/// reports the directory count and marker-read count next to the milliseconds,
/// and then repeats the per-slug lookups the commands do, because that is the
/// part that runs thirteen times per user action.
///
/// With `[root]` it scans only that directory, which is how the pathological
/// container (a root that also holds a build tree) is measured without pointing
/// the app's own config at it.
pub fn run_headless_scan_check(runs: u32, root: Option<String>) -> i32 {
    let runs = runs.clamp(1, 20);
    let roots: Vec<PathBuf> = match root {
        Some(r) => vec![PathBuf::from(r)],
        None => project_roots(),
    };

    println!("roots = {}", roots.len());
    for r in &roots {
        println!("  {}", r.display());
    }
    println!("runs = {runs}");

    let mut worst_walk = 0u128;
    let mut worst_list = 0u128;
    let mut worst_lookup = 0u128;
    let mut dirs = 0u64;
    let mut repos = 0u64;
    let mut markers = 0u64;
    let mut reparse = 0u64;
    let mut hits_total = 0usize;
    let mut n_total = 0usize;

    for i in 1..=runs {
        let mut stats = downloader::WalkStats::default();
        let mut read_markers = 0u64;
        let t_walk = std::time::Instant::now();
        for root in &roots {
            downloader::collect_repos_counted(
                root,
                &mut |_rel, abs| {
                    if downloader::read_marker(abs).is_some() {
                        read_markers += 1;
                    }
                },
                &mut stats,
            );
        }
        let walk_ms = t_walk.elapsed().as_millis();

        // The command path: walk *and* identify every repository, which reads
        // the marker a second time per repo.
        let t_list = std::time::Instant::now();
        let mut out: Vec<RepoRef> = Vec::new();
        for root in &roots {
            downloader::collect_repos(root, &mut |_rel, abs| {
                if let Some(r) = downloader::repo_ref_of(root, abs) {
                    out.push(r);
                }
            });
        }
        out.sort_by(|a, b| a.slug().cmp(&b.slug()));
        out.dedup_by(|a, b| a.slug() == b.slug());
        let list_ms = t_list.elapsed().as_millis();

        // What the `find_repo_any` call sites cost: one full walk per slug.
        let t_lookup = std::time::Instant::now();
        let mut hits = 0usize;
        for r in &out {
            let slug = r.slug();
            let found = roots
                .iter()
                .any(|rt| downloader::find_repo_by_slug(rt, &slug).is_some());
            if found {
                hits += 1;
            }
        }
        let lookup_ms = t_lookup.elapsed().as_millis();
        hits_total = hits;
        n_total = out.len();

        println!(
            "run {i}: walk={walk_ms}ms dirs={} repos={} | list={list_ms}ms refs={} | lookups={lookup_ms}ms resolved={hits}/{n}",
            stats.dirs_visited,
            stats.repos,
            out.len(),
            n = out.len()
        );
        worst_walk = worst_walk.max(walk_ms);
        worst_list = worst_list.max(list_ms);
        worst_lookup = worst_lookup.max(lookup_ms);
        dirs = dirs.max(stats.dirs_visited);
        repos = repos.max(stats.repos);
        markers = markers.max(read_markers);
        reparse = reparse.max(stats.reparse_skipped);
    }

    println!("dirs_visited_max = {dirs}");
    println!("repos_max = {repos}");
    println!("markers_read_per_walk = {markers}");
    println!("reparse_skipped_max = {reparse}");
    println!("worst_walk_ms = {worst_walk}");
    println!("worst_list_ms = {worst_list}");
    println!("worst_lookup_all_slugs_ms = {worst_lookup}");
    println!("note: a command today calls find_repo_any once, and each call is a");
    println!("      full walk of every root - so naming one repository costs as");
    println!("      much as rebuilding the whole wall.");

    // The same three phases through the index, so the improvement is a measured
    // pair of numbers in one run rather than a claim about a previous run.
    let t = std::time::Instant::now();
    let (idx_repos, origin1) = repo_index::repos(&roots);
    let idx_list_ms = t.elapsed().as_millis();
    let t = std::time::Instant::now();
    let mut idx_hits = 0usize;
    for r in &idx_repos {
        if repo_index::find(&roots, &r.slug()).0.is_some() {
            idx_hits += 1;
        }
    }
    let idx_lookup_ms = t.elapsed().as_millis();
    // Second pass: nothing on disk moved, so this is the cached answer.
    let t = std::time::Instant::now();
    let (again, origin2) = repo_index::repos(&roots);
    let idx_cached_ms = t.elapsed().as_millis();
    // And one lookup after being told the disk changed, which is what the
    // directory re-validation actually costs.
    repo_index::invalidate();
    let t = std::time::Instant::now();
    let validated = idx_repos
        .first()
        .map(|r| repo_index::find(&roots, &r.slug()).0.is_some())
        .unwrap_or(false);
    let idx_validate_ms = t.elapsed().as_millis();

    println!("--- indexed ---");
    println!(
        "list={idx_list_ms}ms source={} refs={} | lookups={idx_lookup_ms}ms resolved={idx_hits}/{} | cached_list={idx_cached_ms}ms source={} refs={}",
        origin1.label(),
        idx_repos.len(),
        idx_repos.len(),
        origin2.label(),
        again.len()
    );
    println!("revalidate_one_lookup={idx_validate_ms}ms (resolved={validated})");
    println!(
        "note: DEVHUB_NO_INDEX=1 makes every indexed call walk, which is how the");
    println!("      two halves above are compared against each other.");
    if idx_hits != hits_total || idx_repos.len() != n_total {
        println!(
            "ERROR 索引与全扫描不一致：解析 {} / 全扫描解析 {hits_total}，索引 {} 项 / 全扫描 {n_total} 项",
            idx_hits, idx_repos.len()
        );
        return 1;
    }
    if again.len() != idx_repos.len() {
        println!("ERROR 第二次取索引得到 {} 项，第一次 {} 项", again.len(), idx_repos.len());
        return 1;
    }

    if worst_list > 1500 {
        println!("ERROR 项目墙扫描 {worst_list}ms 超过预算 1500ms");
        return 1;
    }
    println!("OK");
    0
}

