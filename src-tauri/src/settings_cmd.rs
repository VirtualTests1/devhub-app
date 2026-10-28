//! Persisted application settings: the config file, the settings dialogs' IPC,
//! and the project-root guard rails — moved out of `lib.rs` by r21-O1-1.
//!
//! Why the split: `lib.rs` sat at the invariants ceiling (7862/7863 lines,
//! scripts/check-invariants.mjs (LIB_RS_CEILING)) with every unrelated round
//! paying rent in merge conflicts. This is the first mechanically extracted
//! section — items keep their original bodies; visibility is `pub(crate)` (and
//! `pub` where the crate root's `generate_handler!` names them), and the crate
//! root re-imports the names with `use settings_cmd::*` so existing call sites
//! and the `mod tests` block resolve unchanged.
//!
//! Nothing here may gain new behaviour in this move. `AppConfig` remains the
//! single persisted shape; `transact`/`lock_config` keep the lock order
//! documented at the mutex declarations; every `#[tauri::command]` is registered
//! in the crate root's handler list as `settings_cmd::<name>`.

use super::*;

#[path = "crypto.rs"]
mod crypto;

// ---------------------------------------------------------------------------
// Application settings (persisted)
// ---------------------------------------------------------------------------

/// User settings that must survive a restart.
///
/// Stored in a fixed location rather than in the project root, because the
/// project root is itself one of the settings and may be pointed elsewhere.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppConfig {
    /// Empty means "use the computed default".
    #[serde(default)]
    pub(crate) project_root: String,
    #[serde(default)]
    pub(crate) mirror_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) ip_pin_enabled: bool,
    /// Empty means "use the built-in list".
    #[serde(default)]
    pub(crate) mirrors: Vec<String>,
    /// Empty means "auto-discover".
    #[serde(default)]
    pub(crate) proxy: String,
    /// Optional GitHub token. Raises the search allowance from 10 to 30 requests
    /// per minute.
    ///
    /// **At rest** the value is Windows DPAPI ciphertext (`dpapi:v1:<hex>`, see
    /// `crypto.rs`), bound to the current Windows user. In memory and on the IPC /
    /// log side it is the plaintext the search path needs: it never reaches argv,
    /// the UI or activity records (the existing three invariants are unchanged).
    /// Legacy plaintext values are still accepted on read and are encrypted by
    /// `write_config` on the next save; `migrate_token_storage` does that once at
    /// startup instead of waiting for a settings change.
    #[serde(default)]
    pub(crate) github_token: String,
    /// Additional project directories whose repositories are also listed.
    /// Solves "切换目录后旧项目消失"：主目录 + 附加目录一起扫描。
    #[serde(default)]
    pub(crate) extra_roots: Vec<String>,
    /// Last terminal the user picked ("pwsh" | "powershell" | "cmd" | "wsl:<distro>").
    #[serde(default)]
    pub(crate) terminal_choice: String,
    /// Last IDE the user picked (a detect_ides id).
    #[serde(default)]
    pub(crate) ide_choice: String,
    /// Executables the user named by hand, for an install no registry locator
    /// can see (a portable copy, a custom drive, an unregistered SKU).
    #[serde(default)]
    pub(crate) custom_ides: Vec<String>,
    /// How many days of activity history to keep. 0 means keep forever.
    #[serde(default = "default_retention")]
    pub(crate) activity_retention_days: u32,
    /// Whether a search request follows the hosts redirect or bypasses it with
    /// `--resolve`. `bypass` is the default because that is what makes search
    /// work at all on a machine where an accelerator has redirected GitHub to
    /// loopback without a certificate the system trust store accepts.
    #[serde(default = "default_route")]
    pub(crate) search_route: String,
    /// Same choice for `git clone`, which has its own four-layer fallback and
    /// therefore a different default risk profile.
    #[serde(default = "default_route")]
    pub(crate) download_route: String,
    /// Keystroke quiet period before a search fires, ms. The old build hard-coded
    /// 1000 and the report was that it is both too slow to type into and too
    /// fast for a 10-requests-per-minute allowance.
    #[serde(default = "default_debounce")]
    pub(crate) search_debounce_ms: u32,
    /// How many repositories may clone at once.
    #[serde(default = "default_parallel")]
    pub(crate) parallel_downloads: u32,
    /// Directories this machine has used as the main root before.
    ///
    /// Kept separately from `extra_roots`: "附加" is a choice about what to
    /// list, "历史" is a memory of where it used to be. The report asked for a
    /// way to switch back, and re-adding a path by typing it is not switching
    /// back.
    #[serde(default)]
    pub(crate) recent_roots: Vec<String>,
    /// Scheduled clean-up: `manual` | `daily` | `weekly` | `monthly`.
    #[serde(default = "default_cleanup_mode")]
    pub(crate) cleanup_mode: String,
    /// How much of the repository `git clone` is asked for: empty/`full` (the default
    /// and what any unrecognised value means), `shallow`, or `blobless`.
    ///
    /// `docs/clone-strategy.md` is the evidence for the default and for the
    /// accompanying `clone_strategy_note`, which reports the case git reports as a
    /// success: a server that ignores `--filter`/`--depth` still exits 0 and still
    /// writes the promisor configuration, so the setting alone cannot say what happened.
    #[serde(default)]
    pub(crate) clone_strategy: String,
    /// What a scheduled clean-up throws away, in days. Separate from
    /// `activity_retention_days` on purpose: "只保留 30 天" and "每周清一次" are
    /// two different controls that happened to share a name before.
    #[serde(default = "default_retention")]
    pub(crate) cleanup_keep_days: u32,
    /// When the scheduled clean-up last ran, so a restart does not re-run it.
    #[serde(default)]
    pub(crate) last_cleanup_ts: i64,
}

pub(crate) fn default_route() -> String {
    "bypass".to_string()
}
pub(crate) fn default_debounce() -> u32 {
    700
}
pub(crate) fn default_parallel() -> u32 {
    3
}
pub(crate) fn default_cleanup_mode() -> String {
    "manual".to_string()
}

pub(crate) fn default_retention() -> u32 {
    30
}

/// The default has to be written out rather than derived.
///
/// `#[serde(default = "default_true")]` only applies while *deserialising*; a
/// derived `Default` ignores it and produces `false`. That is why "DNS 失败时钉死
/// IP" was off in every session even though the config schema, the UI text and the
/// downloader all treat it as on: `read_config()` falls back to
/// `AppConfig::default()` whenever the file is absent, and that value said false.
impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            project_root: String::new(),
            mirror_enabled: false,
            ip_pin_enabled: default_true(),
            mirrors: Vec::new(),
            proxy: String::new(),
            github_token: String::new(),
            extra_roots: Vec::new(),
            terminal_choice: String::new(),
            ide_choice: String::new(),
            custom_ides: Vec::new(),
            activity_retention_days: default_retention(),
            search_route: default_route(),
            download_route: default_route(),
            search_debounce_ms: default_debounce(),
            parallel_downloads: default_parallel(),
            recent_roots: Vec::new(),
            cleanup_mode: default_cleanup_mode(),
            clone_strategy: String::new(),
            cleanup_keep_days: default_retention(),
            last_cleanup_ts: 0,
        }
    }
}

pub(crate) fn default_true() -> bool {
    true
}

/// `devhub-config.json` beside the app, i.e. `<install dir>\devhub-config.json`.
///
/// Deliberately next to the executable rather than in the project root: the
/// project root is one of the settings, so it cannot also be where the settings
/// file lives. In a portable layout this keeps the whole install self-contained
/// and means uninstalling is just deleting the folder.
///
/// The previous version derived this from `bundled_runtime_dir()` with a
/// `CARGO_MANIFEST_DIR` fallback, which made a copied release binary write its
/// config back into the development checkout.
pub(crate) fn config_path() -> PathBuf {
    let base = bundled_runtime_dir()
        .and_then(|rt| {
            if rt.file_name().map(|n| n == "runtime").unwrap_or(false) {
                rt.parent().map(PathBuf::from)
            } else {
                Some(rt)
            }
        })
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|e| e.parent().map(PathBuf::from))
        })
        .unwrap_or_else(std::env::temp_dir);
    base.join("devhub-config.json")
}

/// `(path, modification stamp, length, parsed config)`.
///
/// The stamp is a `SystemTime`, not a whole-second count, and the length is carried
/// beside it: with `as_secs()` alone, a rewrite that landed inside the same second as
/// the cached read was invisible — hand-editing `devhub-config.json`, or a second
/// instance of the app writing it, could keep an old value for up to a full second and
/// the UI would report the setting it had just replaced. `write_config` clears the
/// entry, so in-process writers were never the problem; external ones were.
pub(crate) static CONFIG_CACHE: Mutex<Option<(std::path::PathBuf, std::time::SystemTime, u64, AppConfig)>> =
    Mutex::new(None);

/// Where the last `read_config` got its answer. `settings_view` surfaces this so a
/// recovered or unreadable config is visible instead of looking like "the user has
/// no settings".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConfigReadState {
    /// `file` | `backup` | `default`.
    pub(crate) source: String,
    /// The parse/read failure that forced recovery, when there was one.
    pub(crate) error: Option<String>,
}

pub(crate) static CONFIG_READ_STATE: Mutex<ConfigReadState> = Mutex::new(ConfigReadState {
    source: String::new(),
    error: None,
});

pub(crate) fn config_read_state() -> ConfigReadState {
    CONFIG_READ_STATE
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

fn set_config_read_state(source: &str, error: Option<String>) {
    if let Ok(mut s) = CONFIG_READ_STATE.lock() {
        *s = ConfigReadState {
            source: source.to_string(),
            error,
        };
    }
}

/// `<config>.json.bak`, i.e. `devhub-config.json.bak` beside the config.
pub(crate) fn config_backup_path() -> PathBuf {
    let mut name = config_path().into_os_string();
    name.push(".bak");
    PathBuf::from(name)
}

/// What a main+backup pair yields. Split out from the I/O so the three cases can be
/// asserted without touching the developer's real config file.
#[derive(Debug)]
pub(crate) struct RecoveredConfig {
    pub(crate) cfg: Option<AppConfig>,
    /// `file` | `backup` | `default`.
    pub(crate) source: &'static str,
    /// Why the main file was not used, when it was not.
    pub(crate) error: Option<String>,
}

/// Decide between the main config and its backup.
///
/// - main parses → use it, no error;
/// - main is missing → defaults, **not** an error (first run);
/// - main exists but does not parse, backup parses → backup, with the main error kept;
/// - neither parses → defaults, with both errors kept for the UI.
pub(crate) fn recover_config(
    main: Option<&str>,
    main_missing: bool,
    backup: Option<&str>,
) -> RecoveredConfig {
    if let Some(text) = main {
        match serde_json::from_str::<AppConfig>(text) {
            Ok(cfg) => {
                return RecoveredConfig {
                    cfg: Some(cfg),
                    source: "file",
                    error: None,
                }
            }
            Err(e) => {
                let main_error = format!("主配置解析失败：{e}");
                if let Some(b) = backup {
                    match serde_json::from_str::<AppConfig>(b) {
                        Ok(cfg) => {
                            return RecoveredConfig {
                                cfg: Some(cfg),
                                source: "backup",
                                error: Some(main_error),
                            }
                        }
                        Err(be) => {
                            return RecoveredConfig {
                                cfg: None,
                                source: "default",
                                error: Some(format!("{main_error}；备份也解析失败：{be}")),
                            }
                        }
                    }
                }
                return RecoveredConfig {
                    cfg: None,
                    source: "default",
                    error: Some(format!("{main_error}；没有可用的备份")),
                };
            }
        }
    }
    if main_missing {
        // A deleted main file is normally a first run. A backup that still parses is
        // the one case where it is not: recover it rather than silently resetting.
        if let Some(b) = backup {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(b) {
                return RecoveredConfig {
                    cfg: Some(cfg),
                    source: "backup",
                    error: Some("主配置不存在，已从备份恢复".to_string()),
                };
            }
        }
        return RecoveredConfig {
            cfg: None,
            source: "default",
            error: None,
        };
    }
    RecoveredConfig {
        cfg: None,
        source: "default",
        error: Some("主配置无法读取".to_string()),
    }
}

/// r17-o2-env-cache: 仓库环境探测结果的短 TTL 缓存，避免每次打开项目面板都重跑
/// python/node/docker 子进程探测。
pub(crate) static ENV_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);
pub(crate) static ENV_CACHE: Mutex<Option<std::collections::HashMap<String, (std::time::Instant, Environments)>>> =
    Mutex::new(None);

pub(crate) fn read_config() -> AppConfig {
    let p = config_path();
    if let Ok(c) = CONFIG_CACHE.lock() {
        if let Some((cached_path, stamp, len, cfg)) = c.as_ref() {
            if cached_path == &p {
                if let Ok(m) = std::fs::metadata(&p) {
                    // One `metadata` call answers both halves of the stamp; the old
                    // code called it twice (once for `modified()`, once for the store).
                    if m.modified().ok().as_ref() == Some(stamp) && m.len() == *len {
                        return cfg.clone();
                    }
                }
            }
        }
    }
    let main = std::fs::read_to_string(&p);
    let main_missing = matches!(&main, Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let main_text = main.as_deref().ok();
    let backup_text = std::fs::read_to_string(config_backup_path()).ok();
    let recovered = recover_config(main_text, main_missing, backup_text.as_deref());
    set_config_read_state(recovered.source, recovered.error.clone());
    let mut cfg = recovered.cfg.unwrap_or_default();
    // Decrypt before caching: every consumer of `read_config` expects a plaintext
    // token. A value that fails to decrypt is left in its storage form so a later
    // unrelated save cannot erase the only copy (`write_config` keeps it verbatim);
    // `settings_view` reports it as unreadable instead of pretending there is none.
    if let Ok(Some(plain)) = crypto::unprotect(&cfg.github_token) {
        cfg.github_token = plain;
    }
    if let Ok(m) = std::fs::metadata(&p) {
        if let Ok(stamp) = m.modified() {
            if let Ok(mut c) = CONFIG_CACHE.lock() {
                *c = Some((p, stamp, m.len(), cfg.clone()));
            }
        }
    }
    cfg
}

/// One-time migration from the legacy plaintext token to the DPAPI form.
///
/// Called once from the Tauri setup hook. Returns `Ok(true)` when it rewrote the
/// file. A failure is returned (not swallowed) so the caller can log it; startup
/// continues either way, because an unencrypted token is still usable and blocking
/// the app over a storage format change would be worse than the format itself.
/// Setup-hook wrapper: log the three outcomes and never fail startup.
pub(crate) fn migrate_token_storage_on_startup() {
    match migrate_token_storage() {
        Ok(true) => println!("[settings] GitHub token migrated to DPAPI storage"),
        Ok(false) => {}
        Err(e) => eprintln!("[settings] token migration skipped: {e}"),
    }
}

pub(crate) fn migrate_token_storage() -> Result<bool, String> {
    let _gate = lock_config();
    let cfg = read_config_for_write()?;
    if cfg.github_token.trim().is_empty() || crypto::is_protected(&cfg.github_token) {
        return Ok(false);
    }
    write_config(&cfg)?;
    Ok(true)
}

/// The token as the downloader must use it.
///
/// `read_config` normally hands back plaintext. This helper covers the two other
/// shapes: a protected value that failed to decrypt must **not** be sent to GitHub
/// as if it were a token, and a legacy plaintext value is used as-is.
pub(crate) fn usable_token(stored: &str) -> String {
    match crypto::unprotect(stored) {
        Ok(Some(plain)) => plain,
        Ok(None) => stored.trim().to_string(),
        Err(_) => String::new(),
    }
}

/// Reads the config **for a write**.
///
/// `read_config` deliberately answers with defaults when the file cannot be read
/// or parsed — a broken file must not brick the UI. That is exactly the wrong
/// answer one line before a whole-file rewrite: the defaults are then persisted,
/// and the GitHub token, mirror list, extra roots and retention policy disappear
/// with no record. On the write path a present-but-unreadable file is an error
/// the user can act on; an absent file is still a normal first run.
pub(crate) fn read_config_for_write() -> Result<AppConfig, String> {
    let p = config_path();
    let main = std::fs::read_to_string(&p);
    let main_missing = matches!(&main, Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let main_io_error = main.as_ref().err().map(|e| e.to_string());
    let main_text = main.as_deref().ok();
    let backup_text = std::fs::read_to_string(config_backup_path()).ok();
    let recovered = recover_config(main_text, main_missing, backup_text.as_deref());
    match recovered.cfg {
        Some(cfg) => {
            set_config_read_state(recovered.source, recovered.error);
            Ok(cfg)
        }
        None => {
            set_config_read_state("default", recovered.error.clone());
            if main_missing {
                // No main and no usable backup: first run is still a normal write.
                return Ok(AppConfig::default());
            }
            let reason = recovered
                .error
                .or(main_io_error)
                .unwrap_or_else(|| "未知原因".to_string());
            Err(format!(
                "配置文件 {} 无法使用（{reason}），备份 {} 也不可用。为避免用默认值覆盖你的设置\
                 （令牌、镜像、项目根、保留策略），本次保存已取消；请先修复该文件。",
                p.display(),
                config_backup_path().display()
            ))
        }
    }
}

pub(crate) fn write_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建配置目录: {e}"))?;
    }
    // Encrypt at the single write point, so every caller (`save_settings`,
    // `apply_config_value`, `forget_recent_root`, migration, tests) gets the same
    // storage rule. An already-protected value is kept verbatim: a failed decrypt
    // left ciphertext in the field, and `protect` must not wrap it a second time
    // or erase the only copy.
    let mut stored = cfg.clone();
    if !stored.github_token.is_empty() {
        stored.github_token = crypto::protect(&stored.github_token)?;
    }
    let text = serde_json::to_string_pretty(&stored).map_err(|e| format!("序列化配置失败: {e}"))?;
    // Keep a parseable copy of the newest successful save beside the original. The
    // bytes are written **after** token encryption and before the main file: the
    // backup must never contain a plaintext token, and if the main rename fails the
    // backup still describes the state the caller asked for. A backup failure is
    // reported but never blocks the real save.
    if let Err(e) = write_atomic(&config_backup_path(), text.as_bytes()) {
        eprintln!("[settings] 配置备份写入失败（主文件继续写）: {e}");
    }
    write_atomic(&p, text.as_bytes()).map_err(|e| format!("写入配置失败: {e}"))?;
    if let Ok(mut c) = CONFIG_CACHE.lock() {
        *c = None;
    }
    // The main file has just been rewritten from a value we serialized, so the
    // recovered/corrupt state no longer describes what is on disk.
    set_config_read_state("file", None);
    Ok(())
}

/// Writes `bytes` to `path` via a uniquely-named sibling temp file + rename.
///
/// Shared by every whole-file rewrite in the backend (`write_config`,
/// `repo_index::save_root`, `activity::write_all`) because they all carry the
/// same two failure shapes: a crash or kill mid-write leaving a truncated file
/// that the next reader treats as real, and two writers on a fixed temp name
/// renaming whichever finished last — a result that was a function of timing
/// rather than of content (the activity log measured this before the temp name
/// included pid+seq).
///
/// The temp name is unique per call for the same reason. A rename failure
/// removes the temp file rather than leaving it to rot next to the real one.
/// Callers that need their own error wording map the `io::Error` themselves;
/// the message here names the operation so a bare `map_err` still says which
/// half failed.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => std::path::Path::new("."),
    };
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => format!(
            "{n}.tmp.{}.{}",
            std::process::id(),
            ATOMIC_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        None => format!(
            ".devhub-tmp.{}.{}",
            std::process::id(),
            ATOMIC_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
    };
    let tmp = parent.join(name);
    let out = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Flush the handle's buffers before rename: a rename that lands while
        // the data is still in the stdio buffer can publish an empty or short
        // file under the final name. (`fsync` of the directory is not available
        // on Windows via std; process-crash durability is best-effort here, and
        // the reader side already treats a torn JSON as "rebuild".)
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if out.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    out
}

/// Sequence for `write_atomic` temp names. Cross-process uniqueness comes from
/// the pid; this only has to keep two calls *in this process* from colliding.
pub(crate) static ATOMIC_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Serialises the whole `read_config()` → mutate → `write_config()` span.
///
/// `read_config` hands out a snapshot of the *entire* file and `write_config`
/// puts back a snapshot of the entire file, so two overlapping mutations lose
/// one of them without either writer failing. Concretely, today: open a terminal
/// with the dropdown (`open_terminal_with_sync` reads the config to find out
/// whether `terminalChoice` already matches) while a settings save is in flight
/// (`apply_settings_update`). The terminal path reads the pre-save snapshot,
/// stamps `terminalChoice` into it and writes the whole thing back — so the new
/// mirror flag, the new token and the new extra roots that the save had already
/// written are gone, and both calls still return success because each one's own
/// rename landed. The same shape covers a 记录 → 回退 (`apply_config_value`)
/// racing the autosave, `add_custom_ide` racing `forget_recent_root`, and
/// `apply_due_cleanup` writing `lastCleanupTs` from a snapshot that predates a
/// concurrent save.
pub(crate) static CONFIG_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Locks a `()` gate, recovering from a poison.
pub(crate) fn lock_gate(gate: &std::sync::Mutex<()>) -> std::sync::MutexGuard<'_, ()> {
    gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Takes the config write gate.
///
/// Poison recovery is deliberate: `write_config` only ever renames a fully
/// written temp file, so the file on disk is whole even when a panicked writer
/// left the gate behind, and refusing every later save would turn one panic into
/// a permanently broken 设置 page.
pub(crate) fn lock_config() -> std::sync::MutexGuard<'static, ()> {
    lock_gate(&CONFIG_WRITE)
}

/// One read → edit → write cycle, gated or not.
///
/// Split out and parameterised over the read/write pair because that is the only
/// way to test the *discipline*: `config_path()` resolves beside the running
/// binary, so a test driving `read_config`/`write_config` would rewrite the
/// developer's `devhub-config.json` — the same reason `remove_recent_root` and
/// `restore_config_value` are pure functions (see their comments). The `gate`
/// argument is what lets the same test reproduce the lost update by passing
/// `None`.
///
/// An `Err` from `edit` means nothing is written, which is what the callers that
/// validate before mutating depend on.
pub(crate) fn transact<T>(
    gate: Option<&std::sync::Mutex<()>>,
    mut read: impl FnMut() -> Result<AppConfig, String>,
    mut write: impl FnMut(&AppConfig) -> Result<(), String>,
    edit: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = gate.map(lock_gate);
    let mut cfg = read()?;
    let out = edit(&mut cfg)?;
    write(&cfg)?;
    Ok(out)
}

/// The gated mutation every writer should use instead of a bare
/// `read_config()` … `write_config()`.
pub(crate) fn update_config<T>(edit: impl FnOnce(&mut AppConfig) -> Result<T, String>) -> Result<T, String> {
    transact(Some(&CONFIG_WRITE), read_config_for_write, write_config, edit)
}

/// As [`update_config`], but leaves the file untouched when the edit changed
/// nothing — the picker paths write on a click, and a click that picked the
/// entry already chosen used to skip the write entirely.
pub(crate) fn update_config_if_changed(edit: impl FnOnce(&mut AppConfig) -> bool) -> Result<(), String> {
    let _guard = lock_config();
    let mut cfg = read_config_for_write()?;
    if edit(&mut cfg) {
        write_config(&cfg)
    } else {
        Ok(())
    }
}

/// A report on a candidate project directory, so the UI can reject a bad choice
/// *before* saving it instead of failing later during a download.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootCheck {
    pub(crate) path: String,
    pub(crate) exists: bool,
    pub(crate) parent_exists: bool,
    pub(crate) writable: bool,
    /// True when the path is under a location Windows treats as read-only, which
    /// makes "everything under the software directory" impossible there.
    pub(crate) under_program_files: bool,
    pub(crate) ok: bool,
    pub(crate) message: String,
}

/// Probes writability by actually creating and removing a file.
pub(crate) fn probe_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".devhub-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Reports on a candidate project directory.
///
/// Writes and deletes a probe file, so it is disk I/O - the async command below
/// runs it on a worker thread. The UI calls it on a 300 ms debounce while the
/// user types, which on the main thread was part of the reported stutter.
pub(crate) fn check_project_root(path: String) -> RootCheck {
    let p = PathBuf::from(path.trim());
    let exists = p.is_dir();
    let parent_exists = p.parent().map(|par| par.is_dir()).unwrap_or(false);
    let probe_dir: Option<PathBuf> = if exists {
        Some(p.clone())
    } else if parent_exists {
        p.parent().map(PathBuf::from)
    } else {
        None
    };
    let writable = probe_dir.as_deref().map(probe_writable).unwrap_or(false);
    let lowered = p.to_string_lossy().to_lowercase();
    let under_program_files = lowered.contains("program files");

    let (ok, message) = if path.trim().is_empty() {
        (false, "路径不能为空".to_string())
    } else if under_program_files {
        (
            false,
            "Program Files 及其子目录是只读的，Windows 不允许应用在此写入数据；请换一个可写目录"
                .to_string(),
        )
    } else if !writable {
        (false, "该位置不可写，请检查权限或换一个目录".to_string())
    } else if !exists && !parent_exists {
        (false, "上层目录不存在，无法创建".to_string())
    } else if !exists {
        (true, "目录尚不存在，保存时会自动创建".to_string())
    } else {
        (true, "可用".to_string())
    };

    RootCheck {
        path: p.to_string_lossy().to_string(),
        exists,
        parent_exists,
        writable,
        under_program_files,
        ok,
        message,
    }
}

#[tauri::command]
pub(crate) async fn validate_project_root(path: String) -> RootCheck {
    match tauri::async_runtime::spawn_blocking(move || check_project_root(path)).await {
        Ok(c) => c,
        Err(e) => RootCheck {
            path: String::new(),
            exists: false,
            parent_exists: false,
            writable: false,
            under_program_files: false,
            ok: false,
            message: format!("目录校验任务异常: {e}"),
        },
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    pub(crate) project_root: String,
    /// True when projectRoot is the computed default rather than a saved choice.
    pub(crate) project_root_is_default: bool,
    pub(crate) mirror_enabled: bool,
    pub(crate) ip_pin_enabled: bool,
    pub(crate) mirrors: Vec<String>,
    /// The list actually in effect (saved list, or the built-in one).
    pub(crate) effective_mirrors: Vec<String>,
    pub(crate) proxy: String,
    pub(crate) config_path: String,
    /// Where the current settings came from: `file` (normal), `backup` (the main
    /// file was missing or unparsable, the `.bak` was used), `default` (neither
    /// worked). The UI shows a warning for the last two.
    pub(crate) config_source: String,
    /// Parse/read failure that forced recovery, verbatim from the backend.
    pub(crate) config_error: Option<String>,
    pub(crate) config_backup_path: String,
    /// True when a GitHub token is stored and usable. The token itself is never sent
    /// to the UI, only whether one exists.
    pub(crate) has_github_token: bool,
    /// True when the config carries a DPAPI-protected token that this Windows user
    /// cannot decrypt (copied from another account/machine, or corrupted). The UI
    /// says so instead of showing the same "not configured" state as an empty field.
    pub(crate) token_unreadable: bool,
    /// Additional directories whose repositories are also listed.
    pub(crate) extra_roots: Vec<String>,
    pub(crate) terminal_choice: String,
    pub(crate) ide_choice: String,
    /// Executables the user named by hand, shown so they can be removed again.
    pub(crate) custom_ides: Vec<String>,
    pub(crate) activity_retention_days: u32,
    /// Network routing and cadence, so the 设置 page can show and change them
    /// without a second round trip to a dedicated command.
    pub(crate) search_route: String,
    pub(crate) download_route: String,
    pub(crate) search_debounce_ms: u32,
    pub(crate) parallel_downloads: u32,
    pub(crate) cleanup_mode: String,
    pub(crate) cleanup_keep_days: u32,
    /// Which clone strategy the downloader will ask git for (see `AppConfig`).
    pub(crate) clone_strategy: String,
    /// Directories that have been the main root before, newest first.
    pub(crate) recent_roots: Vec<String>,
    /// Whether something is currently redirecting GitHub through this machine.
    pub(crate) hosts_hijacked: bool,
    pub(crate) hosts_by: Option<String>,
}

pub(crate) fn settings_view(settings: &Settings) -> SettingsView {
    let cfg = read_config();
    let read_state = config_read_state();
    let hosts = netpath::read_hosts_state();
    let saved = !cfg.project_root.trim().is_empty();
    let builtin = downloader::DownloaderConfig::default().mirrors;
    SettingsView {
        project_root: if saved {
            cfg.project_root.clone()
        } else {
            project_root().to_string_lossy().to_string()
        },
        project_root_is_default: !saved,
        mirror_enabled: locked_bool(&settings.mirror_enabled, false),
        ip_pin_enabled: locked_bool(&settings.ip_pin_enabled, true),
        mirrors: cfg.mirrors.clone(),
        effective_mirrors: if cfg.mirrors.is_empty() {
            builtin
        } else {
            cfg.mirrors.clone()
        },
        proxy: cfg.proxy.clone(),
        config_path: config_path().to_string_lossy().to_string(),
        config_source: if read_state.source.is_empty() {
            "file".to_string()
        } else {
            read_state.source
        },
        config_error: read_state.error,
        config_backup_path: config_backup_path().to_string_lossy().to_string(),
        has_github_token: !cfg.github_token.trim().is_empty() && !crypto::is_protected(&cfg.github_token),
        token_unreadable: crypto::is_protected(&cfg.github_token),
        extra_roots: cfg.extra_roots.clone(),
        terminal_choice: cfg.terminal_choice.clone(),
        ide_choice: cfg.ide_choice.clone(),
        custom_ides: cfg.custom_ides.clone(),
        activity_retention_days: cfg.activity_retention_days,
        search_route: cfg.search_route.clone(),
        download_route: cfg.download_route.clone(),
        search_debounce_ms: cfg.search_debounce_ms,
        parallel_downloads: cfg.parallel_downloads,
        cleanup_mode: cfg.cleanup_mode.clone(),
        cleanup_keep_days: cfg.cleanup_keep_days,
        clone_strategy: cfg.clone_strategy.clone(),
        recent_roots: cfg.recent_roots.clone(),
        hosts_hijacked: hosts.hijacked,
        hosts_by: hosts.owner,
    }
}

/// The settings snapshot.
///
/// Async because building it touches the filesystem three times - `read_config()`,
/// the system hosts file, and resolving the project root - and a synchronous command
/// did all of that on the main thread. The app asks for this at startup, after every
/// save, and each time 设置 opens.
#[tauri::command]
pub(crate) async fn get_settings(app: tauri::AppHandle) -> Result<SettingsView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Settings>();
        Ok(settings_view(&settings))
    })
    .await
    .map_err(|e| format!("读取设置失败: {e}"))?
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsUpdate {
    pub(crate) project_root: String,
    pub(crate) mirror_enabled: bool,
    pub(crate) ip_pin_enabled: bool,
    pub(crate) mirrors: Vec<String>,
    pub(crate) proxy: String,
    /// An empty string means "leave the stored token alone"; the UI never
    /// receives the token, so it cannot send it back.
    #[serde(default)]
    pub(crate) github_token: String,
    /// Explicitly remove the stored token.
    #[serde(default)]
    pub(crate) clear_github_token: bool,
    /// Additional project directories. Absent in older clients = keep as-is.
    #[serde(default)]
    pub(crate) extra_roots: Option<Vec<String>>,
    /// Days of activity history to keep. 0 = forever. Absent = keep as-is.
    #[serde(default)]
    pub(crate) activity_retention_days: Option<u32>,
    /// `bypass` | `useHosts`. Absent = keep as-is, so an older client's save
    /// cannot silently reset a routing choice.
    #[serde(default)]
    pub(crate) search_route: Option<String>,
    #[serde(default)]
    pub(crate) download_route: Option<String>,
    #[serde(default)]
    pub(crate) search_debounce_ms: Option<u32>,
    #[serde(default)]
    pub(crate) parallel_downloads: Option<u32>,
    #[serde(default)]
    pub(crate) cleanup_mode: Option<String>,
    #[serde(default)]
    pub(crate) cleanup_keep_days: Option<u32>,
    #[serde(default)]
    pub(crate) clone_strategy: Option<String>,
}

/// What a settings save produced.
///
/// `notes` is the human-readable list of what actually changed: the UI used to
/// answer a save with a generic "设置已保存", which is exactly the same
/// uninformative shape the 记录 view was criticised for. `root_changed` tells
/// the frontend to re-pull the project wall, which is the other half of the
/// "改了目录但没有生效" report.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveOutcome {
    pub(crate) settings: SettingsView,
    pub(crate) notes: Vec<String>,
    pub(crate) root_changed: bool,
}

/// Retention days as a readable phrase. `0` is 永久, not "0 天".
pub(crate) fn retention_phrase(days: u32) -> String {
    if days == 0 {
        "永久".to_string()
    } else {
        format!("{days} 天")
    }
}

/// A boolean as it reads in a record's diff line.
pub(crate) fn bool_phrase(v: bool) -> String {
    if v { "开".to_string() } else { "关".to_string() }
}

/// Applies a settings update and returns the new config plus what changed.
///
/// Split out from the command so the command can run it on a worker thread:
/// this writes files, probes directory writability and creates directories, and
/// a synchronous command runs all of that on the main thread.
pub(crate) fn apply_settings_update(value: SettingsUpdate) -> Result<(AppConfig, Vec<String>, bool), String> {
    // Gated for the whole read → validate → write span. `CONFIG_WRITE`'s doc
    // comment already names this command as one of the two writers the gate
    // exists for, but the gate was only ever taken by `update_config` /
    // `update_config_if_changed` — the settings save itself ran ungated, so the
    // race the comment describes was still open (a concurrent
    // `open_terminal_with_sync` or `save_tool_choice` could clobber the save or
    // be clobbered by it). Validation that can fail (`check_project_root`,
    // `create_dir_all`) happens inside the gate on purpose: an `Err` from
    // `edit`-equivalent code must leave no half-applied config behind, and the
    // directory probes are the same kind of bounded local I/O the clean-up path
    // already holds the gate for.
    let _gate = lock_config();
    let trimmed = value.project_root.trim().to_string();
    if !trimmed.is_empty() {
        let check = check_project_root(trimmed.clone());
        if !check.ok {
            return Err(check.message);
        }
        if !check.exists {
            std::fs::create_dir_all(&trimmed).map_err(|e| format!("无法创建项目目录: {e}"))?;
        }
    }

    // Strict read: this is the app's most-used writer, and a defaults snapshot
    // written back here is how a token or a mirror list silently disappears.
    let existing = read_config_for_write()?;
    let old_root = existing.project_root.trim().to_string();

    // "切换主目录后旧项目消失"的第二半：把上一个主目录自动收进附加目录。
    // 只在实际存在的目录上做，且校验不过就静默跳过 - 一个自动带过来的旧目录
    // 不该让整次保存失败。
    let previous_effective = if old_root.is_empty() {
        default_project_root()
    } else {
        PathBuf::from(&old_root)
    };
    let mut requested = value.extra_roots.clone().unwrap_or_else(|| existing.extra_roots.clone());
    let mut carried: Option<String> = None;
    {
        let prev = previous_effective.to_string_lossy().to_string();
        let same_as_new = prev.eq_ignore_ascii_case(&trimmed);
        let already_listed = requested.iter().any(|r| r.trim().eq_ignore_ascii_case(&prev));
        if !same_as_new && !already_listed && previous_effective.is_dir() {
            if check_project_root(prev.clone()).ok {
                requested.push(prev.clone());
                carried = Some(prev);
            }
        }
    }

    let mut cleaned_roots: Vec<String> = Vec::new();
    for r in requested {
        let t = r.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if t.eq_ignore_ascii_case(&trimmed) || cleaned_roots.iter().any(|c| c.eq_ignore_ascii_case(&t)) {
            continue;
        }
        let check = check_project_root(t.clone());
        if !check.ok {
            return Err(format!("附加目录不可用（{t}）：{}", check.message));
        }
        if !check.exists {
            std::fs::create_dir_all(&t).map_err(|e| format!("无法创建附加目录 {t}: {e}"))?;
        }
        cleaned_roots.push(t);
    }

    let github_token = if value.clear_github_token {
        String::new()
    } else if value.github_token.trim().is_empty() {
        // The UI is never given the token, so an empty value means "unchanged".
        existing.github_token.clone()
    } else {
        value.github_token.trim().to_string()
    };

    // Remember every directory that has been the main root, newest first, so
    // 设置 → 项目目录 can offer "switch back" instead of making the user retype a
    // path. Capped at eight: a decade of moving the root is not useful history.
    let mut recent: Vec<String> = Vec::new();
    let old_trimmed = old_root.trim().to_string();
    if !old_trimmed.is_empty() && !old_trimmed.eq_ignore_ascii_case(trimmed.as_str()) {
        recent.push(old_trimmed);
    }
    for r in existing.recent_roots.iter() {
        if recent.len() >= 8 {
            break;
        }
        if !r.eq_ignore_ascii_case(&trimmed) && !recent.iter().any(|x| x.eq_ignore_ascii_case(r)) {
            recent.push(r.clone());
        }
    }

    let cfg = AppConfig {
        project_root: trimmed,
        mirror_enabled: value.mirror_enabled,
        ip_pin_enabled: value.ip_pin_enabled,
        mirrors: value
            .mirrors
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect(),
        proxy: value.proxy.trim().to_string(),
        github_token,
        extra_roots: cleaned_roots,
        terminal_choice: existing.terminal_choice,
        ide_choice: existing.ide_choice,
        custom_ides: existing.custom_ides,
        activity_retention_days: value
            .activity_retention_days
            .unwrap_or(existing.activity_retention_days),
        search_route: value
            .search_route
            .unwrap_or_else(|| existing.search_route.clone()),
        download_route: value
            .download_route
            .unwrap_or_else(|| existing.download_route.clone()),
        search_debounce_ms: value
            .search_debounce_ms
            .unwrap_or(existing.search_debounce_ms)
            .clamp(0, 5000),
        parallel_downloads: value
            .parallel_downloads
            .unwrap_or(existing.parallel_downloads)
            .clamp(1, 6),
        cleanup_mode: value
            .cleanup_mode
            .unwrap_or_else(|| existing.cleanup_mode.clone()),
        cleanup_keep_days: value.cleanup_keep_days.unwrap_or(existing.cleanup_keep_days),
        clone_strategy: value
            .clone_strategy
            .unwrap_or_else(|| existing.clone_strategy.clone()),
        recent_roots: recent,
        last_cleanup_ts: existing.last_cleanup_ts,
    };
    write_config(&cfg)?;
    // Route switches (search/download) and proxy changes alter what the link
    // probe should say; drop the cached diagnosis so the next environment
    // refresh reflects the new path instead of the 5 s-old one.
    link::invalidate();

    // One record per actual change, each naming the thing that happened and the
    // path it touched. This used to be a single "修改设置" row carrying a
    // semicolon-joined blob, which told the user nothing about which of the
    // four things they had just clicked took effect.
    let mut notes: Vec<String> = Vec::new();
    let root_changed = cfg.project_root != old_root;
    if root_changed {
        let from = display_root(&old_root);
        let to = display_root(&cfg.project_root);
        notes.push(format!("项目目录：{from} → {to}"));
        record_activity(
            Log::new("settings", "修改项目目录", SRC_SETTINGS)
                .detail(&format!("{from} → {to}"))
                .target("config.projectRoot")
                .change(&old_root, &cfg.project_root)
                .undo(activity::Undo::value(
                    "config",
                    "projectRoot",
                    &old_root,
                ))
                .path_str(&project_root().to_string_lossy()),
        );
    }
    if let Some(p) = &carried {
        notes.push(format!("旧目录已转入附加目录：{p}"));
        record_activity(
            Log::new("settings", "旧项目目录转入附加目录", SRC_SETTINGS)
                .detail("切换主目录后仍会在项目墙上显示")
                .path_str(p),
        );
    }
    for added in cfg.extra_roots.iter().filter(|a| !existing.extra_roots.iter().any(|e| e.eq_ignore_ascii_case(a))) {
        // The carry-over has its own record above; without this it would be
        // written twice, which is the noise this view was complained about.
        if carried.as_deref().map(|c| c.eq_ignore_ascii_case(added)) == Some(true) {
            continue;
        }
        notes.push(format!("新增附加目录：{added}"));
        record_activity(
            Log::new("settings", "添加附加项目目录", SRC_SETTINGS)
                .detail("该目录下的仓库也会出现在项目墙上")
                .path_str(added),
        );
    }
    for removed in existing.extra_roots.iter().filter(|e| !cfg.extra_roots.iter().any(|a| a.eq_ignore_ascii_case(e))) {
        notes.push(format!("移除附加目录：{removed}"));
        record_activity(
            Log::new("settings", "移除附加项目目录", SRC_SETTINGS)
                .detail("该目录下的仓库不再出现在项目墙上，磁盘文件未改动")
                .path_str(removed),
        );
    }
    if cfg.mirror_enabled != existing.mirror_enabled {
        let on = cfg.mirror_enabled;
        notes.push(if on { "启用第三方镜像" } else { "关闭第三方镜像" }.to_string());
        record_activity(
            Log::new("settings", if on { "启用第三方镜像" } else { "关闭第三方镜像" }, SRC_SETTINGS)
                .detail(if on { "代码将经由第三方服务器传输" } else { "只走直连与本地代理" })
                .target("config.mirrorEnabled")
                .change(&bool_phrase(existing.mirror_enabled), &bool_phrase(on))
                .undo(activity::Undo::value(
                    "config",
                    "mirrorEnabled",
                    &existing.mirror_enabled.to_string(),
                )),
        );
    }
    if cfg.ip_pin_enabled != existing.ip_pin_enabled {
        let on = cfg.ip_pin_enabled;
        notes.push(if on { "启用 DNS 失败时 IP 钉死" } else { "关闭 IP 钉死" }.to_string());
        record_activity(
            Log::new("settings", if on { "启用 IP 钉死" } else { "关闭 IP 钉死" }, SRC_SETTINGS)
                .detail("影响下载第二层回退")
                .target("config.ipPinEnabled")
                .change(&bool_phrase(existing.ip_pin_enabled), &bool_phrase(on))
                .undo(activity::Undo::value(
                    "config",
                    "ipPinEnabled",
                    &existing.ip_pin_enabled.to_string(),
                )),
        );
    }
    if cfg.activity_retention_days != existing.activity_retention_days {
        let from = retention_phrase(existing.activity_retention_days);
        let to = retention_phrase(cfg.activity_retention_days);
        notes.push(format!("记录保留：{from} → {to}"));
        record_activity(
            Log::new("settings", "修改记录保留时长", SRC_SETTINGS)
                .detail(&format!("{from} → {to}"))
                .target("config.activityRetentionDays")
                .change(&from, &to)
                .undo(activity::Undo::value(
                    "config",
                    "activityRetentionDays",
                    &existing.activity_retention_days.to_string(),
                ))
                .path(&activity_path()),
        );
    }
    // The round-3 settings all record the same way, so they share one helper
    // rather than six near-identical blocks: a change to a named config key,
    // with its before/after pair and a value 回退 that puts the old value back.
    record_config_change(
        &mut notes,
        "searchRoute",
        "搜索链路",
        &route_phrase(&existing.search_route),
        &route_phrase(&cfg.search_route),
    );
    record_config_change(
        &mut notes,
        "downloadRoute",
        "下载链路",
        &route_phrase(&existing.download_route),
        &route_phrase(&cfg.download_route),
    );
    record_config_change(
        &mut notes,
        "cleanupMode",
        "记录清理计划",
        &cleanup_phrase(&existing.cleanup_mode, existing.cleanup_keep_days),
        &cleanup_phrase(&cfg.cleanup_mode, cfg.cleanup_keep_days),
    );
    record_config_change(
        &mut notes,
        "cloneStrategy",
        "克隆深度策略",
        &clone_strategy_phrase(&existing.clone_strategy),
        &clone_strategy_phrase(&cfg.clone_strategy),
    );
    record_config_change(
        &mut notes,
        "searchDebounceMs",
        "搜索停顿",
        &format!("{} 毫秒", existing.search_debounce_ms),
        &format!("{} 毫秒", cfg.search_debounce_ms),
    );
    record_config_change(
        &mut notes,
        "parallelDownloads",
        "并行下载数",
        &existing.parallel_downloads.to_string(),
        &cfg.parallel_downloads.to_string(),
    );
    if cfg.github_token != existing.github_token {
        if cfg.github_token.is_empty() {
            notes.push("已删除 GitHub Token".to_string());
            record_activity(
                Log::new("settings", "删除 GitHub Token", SRC_SETTINGS)
                    .detail("搜索限额回到 10 次/分钟")
                    .path(&config_path()),
            );
        } else {
            let verb = if existing.github_token.is_empty() { "设置" } else { "更换" };
            notes.push(format!("已{verb} GitHub Token"));
            record_activity(
                Log::new("settings", &format!("{verb} GitHub Token"), SRC_SETTINGS)
                    .detail("只记录已设置，不记录内容")
                    .path(&config_path()),
            );
        }
    }

    Ok((cfg, notes, root_changed))
}

#[tauri::command]
pub(crate) async fn save_settings(
    settings: tauri::State<'_, Settings>,
    value: SettingsUpdate,
) -> Result<SaveOutcome, String> {
    let (cfg, notes, root_changed) = tauri::async_runtime::spawn_blocking(move || {
        apply_settings_update(value)
    })
    .await
    .map_err(|e| format!("保存任务异常: {e}"))??;

    // A different container means a different set of repositories. The index
    // compares root lists anyway; this makes the change take effect on the next
    // call rather than on the next validation round.
    if root_changed {
        repo_index::invalidate();
    }

    // Apply immediately so the change takes effect without a restart.
    set_locked_bool(&settings.mirror_enabled, cfg.mirror_enabled);
    set_locked_bool(&settings.ip_pin_enabled, cfg.ip_pin_enabled);
    Ok(SaveOutcome {
        settings: settings_view(&settings),
        notes,
        root_changed,
    })
}

pub(crate) fn display_root(p: &str) -> String {
    if p.trim().is_empty() {
        "（默认）".to_string()
    } else {
        p.to_string()
    }
}

/// Remove one entry from the recent-roots history, in place.
///
/// Split out of the command so the rule that actually matters — the current main
/// root is not history and must survive — is unit-testable. `config_path()`
/// resolves next to the running binary, so a test that went through
/// `read_config`/`write_config` would read and rewrite the developer's real
/// settings file.
///
/// Returns whether anything was removed. "Nothing matched" is not an error: the
/// entry may already be gone (another window, or a hand-edited config), and the
/// caller's job is only to keep the displayed list truthful.
///
/// Path comparison is case-insensitive, matching how `recent_roots` is written
/// in `apply_settings_update`.
pub(crate) fn remove_recent_root(cfg: &mut AppConfig, path: &str) -> Result<bool, String> {
    let wanted = path.trim();
    if wanted.is_empty() {
        return Err("路径为空".to_string());
    }
    let current = cfg.project_root.trim();
    if !current.is_empty() && current.eq_ignore_ascii_case(wanted) {
        return Err("这是当前正在使用的主目录，不能从历史里移除。".to_string());
    }
    let before = cfg.recent_roots.len();
    cfg.recent_roots
        .retain(|r| !r.trim().eq_ignore_ascii_case(wanted));
    Ok(cfg.recent_roots.len() != before)
}

/// Drop one entry from the recent-roots history.
///
/// 需求3 要求「附加/历史」合并成一张列表后，历史项必须能被移除，否则合并
/// 反而比分开更糟：分开时历史至少只读，合并后它就变成了一个既不能关掉、
/// 又会一直累积的列表。
///
/// 为什么必须是一条独立命令而不是走 `save_settings`：`apply_settings_update`
/// 每次都会把 `recent_roots` 整体重算一遍（旧主目录入列 + 沿用旧列表，见该
/// 函数内注释）。也就是说**任何一次设置保存都会把刚删掉的条目原样写回来**，
/// 删除意图根本无法通过那条通路表达。
///
/// 返回 `SaveOutcome` 而不是裸 `SettingsView`：前端的 `onSaved` 契约就是这个
/// 结构（`{settings, notes, rootChanged}`），改成别的形状就得在前端另开一条
/// 旁路去刷新 store，而`settings_view` 每次都重新 `read_config()`，走同一条
/// 通路即可拿到移除后的最新值。`root_changed` 恒为 false——删一条历史不改主
/// 目录，不需要让项目墙重新扫描。
#[tauri::command]
pub(crate) async fn forget_recent_root(
    settings: tauri::State<'_, Settings>,
    path: String,
) -> Result<SaveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Gated with the same `CONFIG_WRITE` the rest of the config writers use.
        // Ungated, this read → mutate → write raced `apply_settings_update` and
        // `save_tool_choice`: whichever finished last won with a whole-file
        // rewrite of its own snapshot, so a forget could resurrect a field the
        // concurrent save had just changed (or the save could restore the root
        // this command had just removed — the exact inverse of the bug
        // `forget_recent_root` was added to fix).
        let _gate = lock_config();
        let mut cfg = read_config_for_write()?;
        remove_recent_root(&mut cfg, &path)?;
        write_config(&cfg)
    })
    .await
    .map_err(|e| format!("移除历史目录任务异常: {e}"))??;
    Ok(SaveOutcome {
        // settings_view re-reads the config, so this reflects the removal.
        settings: settings_view(&settings),
        notes: vec![],
        root_changed: false,
    })
}

#[cfg(test)]
mod token_storage_tests {
    use super::*;

    #[test]
    fn a_plaintext_token_is_usable_as_is() {
        assert_eq!(usable_token("ghp_legacy"), "ghp_legacy");
        assert_eq!(usable_token("  ghp_trim  "), "ghp_trim");
        assert_eq!(usable_token(""), "");
    }

    #[test]
    fn a_protected_token_round_trips_through_usable_token() {
        let stored = crypto::protect("ghp_live").expect("protect");
        assert_ne!(stored, "ghp_live");
        assert_eq!(usable_token(&stored), "ghp_live");
    }

    #[test]
    fn an_undecryptable_token_is_empty_not_ciphertext() {
        let foreign = format!("{}{}", crypto::DPAPI_PREFIX, "00");
        assert_eq!(usable_token(&foreign), "", "ciphertext must never be sent to GitHub as a token");
    }

    #[test]
    fn write_config_encrypts_and_read_config_decrypts() {
        // Uses the real `config_path()` only because the test must exercise the
        // funnel that every save goes through; the previous file is restored on the
        // way out, including its absence.
        let path = config_path();
        let backup = config_backup_path();
        let before = std::fs::read(&path).ok();
        let before_backup = std::fs::read(&backup).ok();
        let cfg = AppConfig {
            github_token: "ghp_roundtrip".to_string(),
            ..AppConfig::default()
        };
        write_config(&cfg).expect("write");
        let stored_text = std::fs::read_to_string(&path).expect("read raw");
        assert!(
            stored_text.contains(crypto::DPAPI_PREFIX),
            "the on-disk token must be in DPAPI form: {stored_text}"
        );
        assert!(!stored_text.contains("ghp_roundtrip"), "plaintext must not survive the write");
        let rendered = read_config();
        assert_eq!(rendered.github_token, "ghp_roundtrip", "read_config must hand back plaintext");
        // Restore whatever was there before this test.
        match before {
            Some(bytes) => {
                std::fs::write(&path, bytes).expect("restore main");
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
        match before_backup {
            Some(bytes) => {
                std::fs::write(&backup, bytes).expect("restore backup");
            }
            None => {
                let _ = std::fs::remove_file(&backup);
            }
        }
        if let Ok(mut c) = CONFIG_CACHE.lock() {
            *c = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_uses_the_main_file_when_it_parses() {
        let r = recover_config(Some(r#"{"projectRoot":"/a"}"#), false, Some("{}"));
        assert_eq!(r.source, "file");
        assert_eq!(r.error, None);
        assert_eq!(r.cfg.unwrap().project_root, "/a");
    }

    #[test]
    fn corrupt_main_falls_back_to_a_parsing_backup_and_keeps_the_reason() {
        let r = recover_config(Some("{not json"), false, Some(r#"{"projectRoot":"/b"}"#));
        assert_eq!(r.source, "backup");
        assert_eq!(r.cfg.unwrap().project_root, "/b");
        let err = r.error.expect("the main parse failure must be reported");
        assert!(err.contains("主配置解析失败"), "error should name the main file: {err}");
    }

    #[test]
    fn missing_main_with_a_backup_is_not_a_first_run() {
        let r = recover_config(None, true, Some(r#"{"projectRoot":"/c"}"#));
        assert_eq!(r.source, "backup");
        assert_eq!(r.cfg.unwrap().project_root, "/c");
        assert!(r.error.unwrap().contains("主配置不存在"));
    }

    #[test]
    fn missing_main_without_a_backup_is_a_normal_first_run() {
        let r = recover_config(None, true, None);
        assert_eq!(r.source, "default");
        assert!(r.cfg.is_none());
        assert_eq!(r.error, None, "first run is not an error the UI should shout about");
    }

    #[test]
    fn two_corrupt_files_report_both_failures_and_never_invent_settings() {
        let r = recover_config(Some("{bad"), false, Some("{also bad"));
        assert_eq!(r.source, "default");
        assert!(r.cfg.is_none());
        let err = r.error.expect("both failures must be reported");
        assert!(err.contains("主配置解析失败") && err.contains("备份也解析失败"), "{err}");
    }

    #[test]
    fn backup_path_sits_beside_the_config_with_a_bak_suffix() {
        let path = config_backup_path().to_string_lossy().to_string();
        assert!(path.ends_with("devhub-config.json.bak"), "unexpected backup path: {path}");
    }
}



// ---------------------------------------------------------------------------
// Configuration builder and activity path (r23-O3, moved from lib.rs)
// ---------------------------------------------------------------------------

pub(crate) fn build_config(settings: &Settings) -> DownloaderConfig {
    let mut cfg = DownloaderConfig {
        project_root: project_root(),
        ..Default::default()
    };
    cfg.allow_third_party = super::locked_bool(&settings.mirror_enabled, false);
    cfg.allow_ip_pin = super::locked_bool(&settings.ip_pin_enabled, true);
    // Saved settings, then environment overrides on top.
    let saved = read_config();
    if !saved.mirrors.is_empty() {
        cfg.mirrors = saved.mirrors.clone();
    }
    if !saved.proxy.trim().is_empty() {
        cfg.extra_proxies = vec![saved.proxy.clone()];
    }
    // Round 16 R1-3. Read straight from the saved config rather than through the
    // `locked_bool` mutexes: those two exist because the route switches must be
    // locked against a running download, and a clone strategy is not — it only decides
    // the arguments of a clone that has not started yet.
    cfg.clone_strategy = saved.clone_strategy.clone();
    cfg.github_token = settings_cmd::usable_token(&saved.github_token);
    apply_env_overrides(&mut cfg);
    cfg
}

/// Environment overrides, used by the headless mode and by integration tests so
/// each layer can be exercised in isolation:
///   DEVHUB_ALLOW_MIRROR=1   enable the third-party mirror layer
///   DEVHUB_ALLOW_IP_PIN=0   disable the IP-pinning layer
///   DEVHUB_MIRRORS=a;b      replace the mirror list
pub(crate) fn apply_env_overrides(cfg: &mut DownloaderConfig) {
    if let Ok(v) = std::env::var("DEVHUB_ALLOW_MIRROR") {
        cfg.allow_third_party = v == "1" || v.eq_ignore_ascii_case("true");
    }
    if let Ok(v) = std::env::var("DEVHUB_ALLOW_IP_PIN") {
        cfg.allow_ip_pin = !(v == "0" || v.eq_ignore_ascii_case("false"));
    }
    if let Ok(v) = std::env::var("DEVHUB_MIRRORS") {
        let list: Vec<String> = v
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !list.is_empty() {
            cfg.mirrors = list;
        }
    }
}


pub(crate) fn activity_path() -> PathBuf {
    config_path()
        .parent()
        .unwrap_or(&std::env::temp_dir())
        .join("devhub-activity.jsonl")
}

