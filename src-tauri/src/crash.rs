//! Local crash reports (r30-R3).
//!
//! The release profile uses `panic = "abort"`, so there is no unwind and no
//! process-local recovery. What still exists is the panic hook: Rust runs it
//! before the abort, and a file written there survives the process. This module
//! installs one hook that records the message, source location, thread and a
//! best-effort backtrace beside `devhub-config.json`; the Settings diagnostics
//! section reads it on the next start, and nothing is uploaded anywhere.
//!
//! ## Why not Windows Error Reporting local dumps
//!
//! WER can write minidumps, but enabling `LocalDumps` is a machine-wide registry
//! change (or a per-image setting) and produces a binary a person cannot read in
//! the app. It is the right tool for a symbol server and the wrong one for a
//! portable launcher. The comparison is in `docs/research/crash-observability.md`.
//!
//! ## What this cannot see
//!
//! A hard abort that does not run Rust's panic machinery (stack overflow from a
//! native library, access violation in a dependency, a renderer crash) leaves no
//! report here. `panic = "abort"` also means the hook's execute-before-abort
//! guarantee is the only window; the write must be bounded and allocation-light.
//! The write is best-effort: a failed report never masks the original abort.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Once;

const MESSAGE_MAX: usize = 4_000;
const BACKTRACE_MAX: usize = 12_000;
pub const CRASH_FILE_NAME: &str = "devhub-crash.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    /// RFC 3339 UTC timestamp.
    pub at: String,
    pub version: String,
    pub message: String,
    pub location: Option<String>,
    pub thread: Option<String>,
    /// Symbol names depend on the release strip settings; an empty/None value
    /// means "was not available", never "there was no stack".
    pub backtrace: Option<String>,
}

fn bounded(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    const ELLIPSIS: char = '…';
    let mut cut = max.saturating_sub(ELLIPSIS.len_utf8());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{ELLIPSIS}", &text[..cut])
}

/// Where the crash report lives: beside the config, like the window state.
pub fn crash_path() -> PathBuf {
    crate::config_path().with_file_name(CRASH_FILE_NAME)
}

/// Write one report atomically. Exposed for the test and for a future manual
/// report action; the hook calls it with the current panic's fields.
pub fn write_report(path: &Path, report: &CrashReport) -> Result<(), String> {
    let text = serde_json::to_string_pretty(report).map_err(|e| format!("序列化崩溃报告失败: {e}"))?;
    crate::write_atomic(path, text.as_bytes()).map_err(|e| format!("写入崩溃报告失败: {e}"))
}

pub fn read_report(path: &Path) -> Option<CrashReport> {
    let text = std::fs::read_to_string(path).ok()?;
    let report: CrashReport = serde_json::from_str(&text).ok()?;
    if report.at.trim().is_empty() || report.message.trim().is_empty() {
        return None;
    }
    Some(report)
}

/// Read the report left by the previous process. Kept after reading until the
/// user dismisses it: a crash that is cleared by the act of looking cannot be
/// pasted into an issue later.
#[tauri::command(async)]
pub fn last_crash() -> Option<CrashReport> {
    read_report(&crash_path())
}

#[tauri::command(async)]
pub fn clear_crash() -> Result<(), String> {
    match std::fs::remove_file(crash_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除崩溃报告失败: {e}")),
    }
}

/// Build the report for the hook. Kept apart so the bounded fields are testable
/// without installing a process-wide hook.
pub fn report_of(
    message: String,
    location: Option<String>,
    thread: Option<String>,
    backtrace: Option<String>,
) -> CrashReport {
    CrashReport {
        at: chrono::Utc::now().to_rfc3339(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        message: bounded(message, MESSAGE_MAX),
        location,
        thread,
        backtrace: backtrace.map(|b| bounded(b, BACKTRACE_MAX)).filter(|b| !b.is_empty()),
    }
}

static INSTALLED: Once = Once::new();

/// Install the one panic hook for this process.
///
/// `Once` matters because setup can run twice in a test harness or a future
/// multi-window path; replacing the hook repeatedly would stack writers over the
/// same file. The previous hook is still called, so the console message users
/// already see is unchanged.
pub fn install(path: PathBuf) {
    INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| format!("{info}"));
            let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
            let thread = std::thread::current().name().map(str::to_string);
            // force_capture is deliberate: the default backtrace is only
            // captured when RUST_BACKTRACE is set, which a packaged app never is.
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let report = report_of(message, location, thread, Some(backtrace));
            // Never let a failed report panic out of the hook: that would abort
            // inside an abort. There is no safe reporting channel left while the
            // process is terminating, so a failed write is deliberately dropped.
            write_report(&path, &report).ok();
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CrashReport {
        CrashReport {
            at: "2026-10-29T00:00:00Z".to_string(),
            version: "9.9.9".to_string(),
            message: "boom".to_string(),
            location: Some("src/lib.rs:1:2".to_string()),
            thread: Some("main".to_string()),
            backtrace: Some("frame".to_string()),
        }
    }

    #[test]
    fn a_report_round_trips_and_missing_fields_are_not_invented() {
        let dir = std::env::temp_dir().join(format!("devhub-crash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(CRASH_FILE_NAME);
        let report = sample();
        write_report(&path, &report).expect("write");
        assert_eq!(read_report(&path), Some(report));
        std::fs::write(&path, "{not json").expect("corrupt");
        assert_eq!(read_report(&path), None);
        std::fs::write(&path, r#"{"at":"","version":"1","message":"x"}"#).expect("empty at");
        assert_eq!(read_report(&path), None);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn very_long_message_and_backtrace_are_bounded_on_a_char_boundary() {
        let report = report_of(
            "崩".repeat(MESSAGE_MAX),
            None,
            None,
            Some("栈".repeat(BACKTRACE_MAX)),
        );
        assert!(report.message.len() <= MESSAGE_MAX);
        assert!(report.backtrace.as_ref().is_some_and(|b| b.len() <= BACKTRACE_MAX));
        assert!(report.message.ends_with('…'));
        assert!(report.backtrace.is_some_and(|b| b.ends_with('…')));
        assert_eq!(report.version, env!("CARGO_PKG_VERSION"));
        assert!(!report.at.is_empty());
    }

    #[test]
    fn an_empty_backtrace_is_absent_not_an_empty_string() {
        let report = report_of("x".to_string(), None, None, Some(String::new()));
        assert_eq!(report.backtrace, None);
    }
}
