// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless diagnostic modes, used to verify the Rust side without the GUI.
    // Each prints its result and exits:
    //   devhub-app.exe --clone <owner/repo|url>
    //   devhub-app.exe --ensure-git [runtime-dir]
    //   devhub-app.exe --find-git [runtime-dir]
    //   devhub-app.exe --launch-check
    //   devhub-app.exe --clear-check <slug>
    //   devhub-app.exe --env-check [runs]
    //   devhub-app.exe --scan-check [runs] [root]
    //   devhub-app.exe --trash-check
    //   devhub-app.exe --cover-check <owner/repo>
    //   devhub-app.exe --spawn-check [--visible] -- <program> [args...]
    let args: Vec<String> = std::env::args().collect();

    if let Some(pos) = args.iter().position(|a| a == "--clone") {
        let target = args.get(pos + 1).cloned().unwrap_or_default();
        if target.is_empty() {
            eprintln!("usage: devhub-app --clone <owner/repo|url>");
            std::process::exit(2);
        }
        std::process::exit(devhub_app_lib::run_headless_clone(&target));
    }

    if let Some(pos) = args.iter().position(|a| a == "--ensure-git") {
        std::process::exit(devhub_app_lib::run_headless_ensure_git(
            args.get(pos + 1).cloned(),
        ));
    }

    if let Some(pos) = args.iter().position(|a| a == "--find-git") {
        std::process::exit(devhub_app_lib::run_headless_find_git(
            args.get(pos + 1).cloned(),
        ));
    }

    if args.iter().any(|a| a == "--launch-check") {
        std::process::exit(devhub_app_lib::run_headless_launch_check());
    }

    if let Some(pos) = args.iter().position(|a| a == "--clear-check") {
        let slug = args.get(pos + 1).cloned().unwrap_or_default();
        if slug.is_empty() {
            eprintln!("usage: devhub-app --clear-check <slug>");
            std::process::exit(2);
        }
        std::process::exit(devhub_app_lib::run_headless_clear_check(&slug));
    }

    if let Some(pos) = args.iter().position(|a| a == "--delete-check") {
        let slug = args.get(pos + 1).cloned().unwrap_or_default();
        if slug.is_empty() {
            eprintln!("usage: devhub-app --delete-check <slug>");
            std::process::exit(2);
        }
        std::process::exit(devhub_app_lib::run_headless_delete_check(&slug));
    }

    if args.iter().any(|a| a == "--trash-check") {
        std::process::exit(devhub_app_lib::run_headless_trash_check());
    }

    if args.iter().any(|a| a == "--settings-check") {
        std::process::exit(devhub_app_lib::run_headless_settings_check());
    }

    if let Some(pos) = args.iter().position(|a| a == "--search-check") {
        let query = args.get(pos + 1).cloned().unwrap_or_default();
        if query.is_empty() {
            eprintln!("usage: devhub-app --search-check <query>");
            std::process::exit(2);
        }
        std::process::exit(devhub_app_lib::run_headless_search_check(&query));
    }

    if let Some(pos) = args.iter().position(|a| a == "--env-check") {
        let runs = args
            .get(pos + 1)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(3);
        std::process::exit(devhub_app_lib::run_headless_env_check(runs));
    }

    if let Some(pos) = args.iter().position(|a| a == "--scan-check") {
        let (runs, root) = parse_scan_check_args(&args[pos + 1..]);
        std::process::exit(devhub_app_lib::run_headless_scan_check(runs, root));
    }

    if let Some(pos) = args.iter().position(|a| a == "--cover-check") {
        let slug = args.get(pos + 1).cloned().unwrap_or_default();
        if slug.is_empty() {
            eprintln!("usage: devhub-app --cover-check owner/repo");
            std::process::exit(2);
        }
        std::process::exit(devhub_app_lib::run_headless_cover_check(&slug));
    }

    if let Some(pos) = args.iter().position(|a| a == "--spawn-check") {
        std::process::exit(devhub_app_lib::run_headless_spawn_check(&args[pos + 1..]));
    }

    devhub_app_lib::run()
}

/// Parses the trailing `[runs] [root]` pair for `--scan-check`.
///
/// In either order: a leading number is the repeat count, anything else is the
/// directory to scan. A second number or a second path stops the scan.
fn parse_scan_check_args(args: &[String]) -> (u32, Option<String>) {
    let mut runs = 3u32;
    let mut root: Option<String> = None;
    for a in args.iter().take_while(|a| !a.starts_with("--")) {
        match (runs, root.clone(), a.parse::<u32>()) {
            (3, None, Ok(n)) => runs = n,
            (_, None, _) => root = Some(a.clone()),
            _ => break,
        }
    }
    (runs, root)
}

#[cfg(test)]
mod tests {
    use super::parse_scan_check_args;

    fn sv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn scan_check_defaults_with_no_args() {
        assert_eq!(parse_scan_check_args(&[]), (3, None));
    }

    #[test]
    fn scan_check_leading_number_is_runs() {
        assert_eq!(parse_scan_check_args(&sv(&["10"])), (10, None));
    }

    #[test]
    fn scan_check_leading_path_is_root() {
        assert_eq!(
            parse_scan_check_args(&sv(&["D:/repos"])),
            (3, Some("D:/repos".into()))
        );
    }

    #[test]
    fn scan_check_number_then_path() {
        assert_eq!(
            parse_scan_check_args(&sv(&["7", "D:/repos"])),
            (7, Some("D:/repos".into()))
        );
    }

    #[test]
    fn scan_check_path_then_number_stops_at_second_token() {
        // Once root is set, a following number is not consumed — the first
        // positional already decided the shape.
        assert_eq!(
            parse_scan_check_args(&sv(&["D:/repos", "9"])),
            (3, Some("D:/repos".into()))
        );
    }

    #[test]
    fn scan_check_stops_at_next_flag() {
        assert_eq!(
            parse_scan_check_args(&sv(&["5", "D:/repos", "--visible"])),
            (5, Some("D:/repos".into()))
        );
    }
}
