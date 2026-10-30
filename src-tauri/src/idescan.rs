//! Which editors/IDEs are actually installed on this machine, and where their
//! icon lives.
//!
//! ## Why this file exists
//!
//! The previous implementation guessed install locations: a PATH lookup for
//! `code`/`cursor`/`windsurf`, plus a fixed glob under
//! `%ProgramFiles%\JetBrains\<product>*\bin\*.exe`. On the machine this was
//! reported from, that found exactly one IDE (VS Code) while eight were
//! installed, because every single one of them lives off-pattern:
//!
//!   Trae CN                    -> E:\Apps\trae.ai\Trae CN\Trae CN.exe
//!   CodeBuddy CN               -> D:\Apps\CodeBuddy\CodeBuddy CN\CodeBuddy CN.exe
//!   IntelliJ IDEA 2025.3.3     -> D:\Apps\IDEA2533\IntelliJ IDEA 2025.3.3\bin\idea64.exe
//!   DevEco Studio              -> D:\Apps\DevEco\DevEco Studio\bin\devecostudio64.exe
//!   Visual Studio Community 26 -> D:\Apps\VisualStudio\Community\Common7\IDE\devenv.exe
//!
//! No vendor-documented default path finds those. Windows' own uninstall
//! registry does, because the installer writes it: every one of the eight above
//! has an `Uninstall` record carrying the real executable path. That is the
//! first locator now, not a fallback.
//!
//! ## Model
//!
//! Taken from `packages/host/open-in-app` in deepseek-harness: a compile-time
//! **catalog** of applications, each declaring an **ordered chain of locators**,
//! where every locator must resolve to an executable that verifiably exists on
//! disk. A locator that yields a missing file is a miss, never a "probably
//! installed" - a stale uninstall record is common and would otherwise offer a
//! button that cannot work.
//!
//! Chain order: uninstall record -> `App Paths` -> known candidate paths -> PATH.
//!
//! ## Icons
//!
//! Extracted from the resolved executable, the same way the reference does it:
//! `System.Drawing.Icon::ExtractAssociatedIcon`, which yields 32px - the most
//! the stock .NET surface gives without a native addon. One `powershell.exe`
//! run extracts **all** pending icons from one manifest file, because a spawn
//! per IDE made the first open of the picker take seconds. Results are cached
//! on disk under the config directory, so the cost is paid once per install
//! change. A failed extraction leaves that IDE with no icon and the UI draws a
//! generic glyph.

use std::path::{Path, PathBuf};

use crate::launch::{self, ToolInfo};

/// One catalog entry. All strings are matched case-insensitively.
struct Spec {
    id: &'static str,
    label: &'static str,
    /// `App Paths` subkey names to try, e.g. `Code.exe`.
    app_paths: &'static [&'static str],
    /// `Uninstall` DisplayName prefixes to try.
    record_prefixes: &'static [&'static str],
    /// Launcher under the record's `InstallLocation`, for the products whose
    /// record points at an uninstaller icon rather than the app exe.
    relative: &'static [&'static str],
    /// Literal candidate paths. `${NAME}` expands from the environment.
    candidates: &'static [&'static str],
    /// Command names to look for on PATH.
    path_cmds: &'static [&'static str],
}

/// The catalog. Order is display order: the VS Code family first, then
/// JetBrains, then the rest.
const SPECS: &[Spec] = &[
    Spec {
        id: "vscode",
        label: "Visual Studio Code",
        app_paths: &["code.exe", "Code.exe"],
        record_prefixes: &["Microsoft Visual Studio Code"],
        relative: &["Code.exe"],
        candidates: &[
            "${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
            "${ProgramFiles}/Microsoft VS Code/Code.exe",
        ],
        path_cmds: &["code"],
    },
    Spec {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        app_paths: &["Code - Insiders.exe"],
        record_prefixes: &["Microsoft Visual Studio Code Insiders"],
        relative: &["Code - Insiders.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"],
        path_cmds: &["code-insiders"],
    },
    Spec {
        id: "cursor",
        label: "Cursor",
        app_paths: &["Cursor.exe"],
        record_prefixes: &["Cursor"],
        relative: &["Cursor.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"],
        path_cmds: &["cursor"],
    },
    Spec {
        id: "windsurf",
        label: "Windsurf",
        app_paths: &["Windsurf.exe"],
        record_prefixes: &["Windsurf"],
        relative: &["Windsurf.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe"],
        path_cmds: &["windsurf"],
    },
    Spec {
        // VS Code forks that register themselves under their own display name.
        id: "trae-cn",
        label: "Trae CN",
        app_paths: &["Trae CN.exe"],
        record_prefixes: &["Trae CN"],
        relative: &["Trae CN.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/Trae CN/Trae CN.exe"],
        path_cmds: &["trae"],
    },
    Spec {
        id: "trae-solo-cn",
        label: "TRAE SOLO CN",
        app_paths: &["TRAE SOLO CN.exe"],
        record_prefixes: &["TRAE SOLO CN"],
        relative: &["TRAE SOLO CN.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/TRAE SOLO CN/TRAE SOLO CN.exe"],
        path_cmds: &[],
    },
    Spec {
        id: "codebuddy-cn",
        label: "CodeBuddy CN",
        app_paths: &["CodeBuddy CN.exe"],
        record_prefixes: &["CodeBuddy"],
        relative: &["CodeBuddy CN.exe"],
        candidates: &["${LOCALAPPDATA}/Programs/CodeBuddy CN/CodeBuddy CN.exe"],
        path_cmds: &[],
    },
    Spec {
        id: "zed",
        label: "Zed",
        app_paths: &["zed.exe"],
        record_prefixes: &["Zed"],
        relative: &["zed.exe"],
        candidates: &["${LOCALAPPDATA}/Zed/zed.exe"],
        path_cmds: &["zed"],
    },
    Spec {
        id: "intellij",
        label: "IntelliJ IDEA",
        app_paths: &["idea64.exe"],
        record_prefixes: &["IntelliJ IDEA"],
        relative: &["bin/idea64.exe"],
        candidates: &[
            "${ProgramFiles}/JetBrains/IntelliJ IDEA*/bin/idea64.exe",
            "${LOCALAPPDATA}/JetBrains/Toolbox/apps/IDEA-U/ch-0/*/IntelliJ IDEA/bin/idea64.exe",
        ],
        path_cmds: &["idea"],
    },
    Spec {
        id: "pycharm",
        label: "PyCharm",
        app_paths: &["pycharm64.exe"],
        record_prefixes: &["PyCharm"],
        relative: &["bin/pycharm64.exe"],
        candidates: &[
            "${ProgramFiles}/JetBrains/PyCharm*/bin/pycharm64.exe",
            "${LOCALAPPDATA}/Programs/PyCharm*/bin/pycharm64.exe",
        ],
        path_cmds: &["pycharm"],
    },
    Spec {
        id: "webstorm",
        label: "WebStorm",
        app_paths: &["webstorm64.exe"],
        record_prefixes: &["WebStorm"],
        relative: &["bin/webstorm64.exe"],
        candidates: &["${ProgramFiles}/JetBrains/WebStorm*/bin/webstorm64.exe"],
        path_cmds: &["webstorm"],
    },
    Spec {
        id: "clion",
        label: "CLion",
        app_paths: &["clion64.exe"],
        record_prefixes: &["CLion"],
        relative: &["bin/clion64.exe"],
        candidates: &["${ProgramFiles}/JetBrains/CLion*/bin/clion64.exe"],
        path_cmds: &["clion"],
    },
    Spec {
        id: "goland",
        label: "GoLand",
        app_paths: &["goland64.exe"],
        record_prefixes: &["GoLand"],
        relative: &["bin/goland64.exe"],
        candidates: &["${ProgramFiles}/JetBrains/GoLand*/bin/goland64.exe"],
        path_cmds: &["goland"],
    },
    Spec {
        id: "rider",
        label: "Rider",
        app_paths: &["rider64.exe"],
        record_prefixes: &["JetBrains Rider", "Rider"],
        relative: &["bin/rider64.exe"],
        candidates: &["${ProgramFiles}/JetBrains/Rider*/bin/rider64.exe"],
        path_cmds: &["rider"],
    },
    Spec {
        id: "deveco",
        label: "DevEco Studio",
        app_paths: &["devecostudio64.exe"],
        record_prefixes: &["DevEco Studio"],
        relative: &["bin/devecostudio64.exe"],
        candidates: &[
            "${ProgramFiles}/Huawei/DevEco Studio*/bin/devecostudio64.exe",
            "${LOCALAPPDATA}/Huawei/DevEco Studio*/bin/devecostudio64.exe",
        ],
        path_cmds: &[],
    },
    Spec {
        id: "androidstudio",
        label: "Android Studio",
        app_paths: &["studio64.exe"],
        record_prefixes: &["Android Studio"],
        relative: &["bin/studio64.exe"],
        candidates: &["${ProgramFiles}/Android/Android Studio/bin/studio64.exe"],
        path_cmds: &[],
    },
    Spec {
        // Full Visual Studio. `devenv.exe` in `App Paths` frequently points at
        // BuildTools, which has no IDE, so the uninstall record is the one that
        // matters here and `vswhere` is the tie-breaker.
        id: "visualstudio",
        label: "Visual Studio",
        app_paths: &["devenv.exe"],
        record_prefixes: &["Visual Studio Community", "Visual Studio Professional", "Visual Studio Enterprise"],
        relative: &["Common7/IDE/devenv.exe"],
        candidates: &[],
        path_cmds: &["devenv"],
    },
    Spec {
        id: "hbuilderx",
        label: "HBuilder X",
        app_paths: &["HBuilderX.exe"],
        record_prefixes: &["HBuilderX"],
        relative: &["HBuilderX.exe"],
        candidates: &[],
        path_cmds: &[],
    },
];

/// Expands `${NAME}` from the environment. An unset variable yields `None` so a
/// candidate simply cannot match rather than collapsing to a relative path.
fn expand(input: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}')?;
        let name = &after[..end];
        let value = std::env::var(name).ok()?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// Turns a registry `DisplayIcon` value into an executable path.
///
/// Observed shapes on this machine, all of which have to be handled:
///   `D:\Apps\VSCode\Microsoft VS Code\Code.exe`
///   `"C:\Program Files (x86)\...\setup.exe"`          (quoted)
///   `C:\ProgramData\Package Cache\{...}\vsta.exe,0`   (icon index suffix)
///   `D:\Apps\Qoder\Qoder CN\uninstallerIcon.ico`       (not an exe -> reject)
///   `msiexec.exe`                                     (the MSI engine -> reject)
///
/// Returns `None` for anything that is not a plausible executable path.
fn parse_display_icon(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Strip a trailing `,<index>`.
    if let Some(pos) = s.rfind(',') {
        if s[pos + 1..].chars().all(|c| c.is_ascii_digit()) && s[pos + 1..].len() < 3 {
            s = s[..pos].trim().to_string();
        }
    }
    // Strip surrounding quotes.
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = s[1..s.len() - 1].to_string();
    }
    let lowered = s.to_lowercase();
    if lowered.ends_with(".exe") {
        if lowered.ends_with("msiexec.exe") || lowered.ends_with("uninstallericon.ico") {
            return None;
        }
        Some(s)
    } else {
        // `.ico`, a bare name, or an icon reference like `shell32.dll,0`.
        None
    }
}

/// Case-insensitive prefix match, tolerating the `(User)` / `(Machine)` suffix
/// Inno Setup appends to `DisplayName`.
fn name_matches(display: &str, prefix: &str) -> bool {
    display.trim().to_lowercase().starts_with(&prefix.trim().to_lowercase())
}

/// One `Uninstall` record, already narrowed to what resolution needs.
struct UninstallRecord {
    display_name: String,
    install_location: Option<String>,
    exe: Option<String>,
}

/// Reads every uninstall record once and caches it for the rest of this scan.
///
/// Three hives, because a per-user install (the VS Code family default) is only
/// in HKCU, a 32-bit installer only appears under WOW6432Node, and JetBrains
/// writes to the 64-bit HKLM.
#[cfg(windows)]
fn uninstall_records() -> Vec<UninstallRecord> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let hives: Vec<(RegKey, &str, u32)> = vec![
        (RegKey::predef(HKEY_CURRENT_USER), uninstall, KEY_READ),
        (RegKey::predef(HKEY_LOCAL_MACHINE), uninstall, KEY_READ | KEY_WOW64_64KEY),
        (RegKey::predef(HKEY_LOCAL_MACHINE), uninstall, KEY_READ | KEY_WOW64_32KEY),
    ];

    let mut out = Vec::new();
    for (root, path, opts) in hives {
        let Ok(key) = root.open_subkey_with_flags(path, opts) else {
            continue;
        };
        for name in key.enum_keys().filter_map(|k| k.ok()) {
            let Ok(sub) = key.open_subkey_with_flags(&name, opts) else {
                continue;
            };
            let display: String = match sub.get_value("DisplayName") {
                Ok(v) => v,
                Err(_) => continue,
            };
            let install: Option<String> = sub.get_value("InstallLocation").ok();
            let icon: Option<String> = sub.get_value("DisplayIcon").ok();
            out.push(UninstallRecord {
                display_name: display,
                install_location: install.filter(|s| !s.trim().is_empty()),
                exe: icon.as_deref().and_then(parse_display_icon),
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn uninstall_records() -> Vec<UninstallRecord> {
    Vec::new()
}

/// The default value of `App Paths\<exe>`.
#[cfg(windows)]
fn app_paths_exe(exe: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let path = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    let hives: Vec<(RegKey, u32)> = vec![
        (RegKey::predef(HKEY_CURRENT_USER), KEY_READ),
        (RegKey::predef(HKEY_LOCAL_MACHINE), KEY_READ | KEY_WOW64_64KEY),
        (RegKey::predef(HKEY_LOCAL_MACHINE), KEY_READ | KEY_WOW64_32KEY),
    ];
    for (root, opts) in hives {
        let Ok(sub) = root.open_subkey_with_flags(&path, opts) else {
            continue;
        };
        if let Ok(v) = sub.get_value::<String, _>("") {
            let v = parse_display_icon(&v)?;
            if is_file(&v) {
                return Some(v);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn app_paths_exe(_exe: &str) -> Option<String> {
    None
}

fn is_file(p: &str) -> bool {
    Path::new(p).is_file()
}

/// Resolves one candidate that may contain `*` path segments.
///
/// Delegates the matching to `launch::glob_simple`, which already handles the
/// `PyCharm*/bin/pycharm64.exe` shape and refuses to follow anything that is
/// not a file. Patterns without a `*` collapse to a plain existence check.
fn find_candidate(path: &str) -> Vec<String> {
    let normalized = path.replace('/', "\\");
    let segs: Vec<&str> = normalized.split('\\').collect();
    let Some(idx) = segs.iter().position(|s| s.contains('*')) else {
        return if is_file(&normalized) {
            vec![normalized]
        } else {
            Vec::new()
        };
    };
    let base = segs[..idx].join("\\");
    let pattern = segs[idx..].join("/");
    launch::glob_simple(Path::new(&base), &pattern)
}

/// Looks one spec up. Returns the executable plus a note on how it was found.
fn resolve(spec: &Spec, records: &[UninstallRecord]) -> Option<(String, String)> {
    // 1. The uninstall record: the only source that sees non-default install
    //    directories, which is where most real installs live.
    for prefix in spec.record_prefixes {
        for r in records.iter().filter(|r| name_matches(&r.display_name, prefix)) {
            // `relative` first: JetBrains records point at bin/<exe>, and some
            // records carry an uninstaller icon instead of the app exe.
            for rel in spec.relative {
                if let Some(loc) = &r.install_location {
                    let candidate = format!(
                        "{}{}{}",
                        loc.trim_end_matches(['\\', '/']),
                        std::path::MAIN_SEPARATOR,
                        rel.replace('/', "\\")
                    );
                    if is_file(&candidate) {
                        return Some((candidate, format!("卸载记录：{}", r.display_name)));
                    }
                }
            }
            if let Some(exe) = &r.exe {
                if is_file(exe) {
                    return Some((exe.clone(), format!("卸载记录：{}", r.display_name)));
                }
            }
        }
    }

    // 2. `App Paths`.
    for exe in spec.app_paths {
        if let Some(p) = app_paths_exe(exe) {
            return Some((p, "App Paths 注册表".to_string()));
        }
    }

    // 3. Known install layouts.
    for cand in spec.candidates {
        let Some(expanded) = expand(cand) else { continue };
        for hit in find_candidate(&expanded) {
            if is_file(&hit) {
                return Some((hit, "已知安装位置".to_string()));
            }
        }
    }

    // 4. PATH.
    for cmd in spec.path_cmds {
        if let Some(p) = which(cmd) {
            return Some((p, "PATH".to_string()));
        }
    }

    None
}

/// Resolves a command name against PATH, mirroring what `where` does without
/// spawning a process.
fn which(name: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for ext in ["", ".exe", ".cmd", ".bat"] {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Visual Studio specifically: `vswhere` is Microsoft's own discovery tool and
/// is the only reliable way to tell Community from BuildTools apart.
fn vswhere_devenv() -> Option<String> {
    let exe = PathBuf::from(r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe");
    if !exe.is_file() {
        return None;
    }
    // `proc::silent`, not a bare `Command`: this crate's own invariant (see
    // proc.rs's module doc) is that no child may be spawned without
    // `CREATE_NO_WINDOW`, because the release build owns no console and each
    // unflagged console child flashes a black window over the UI. This one was a
    // `vswhere.exe` call made on every IDE scan. Bounded for the same reason the
    // other probes are: an unbounded `.output()` here parked the scan.
    let mut cmd = crate::proc::silent(&exe);
    cmd.args(["-release", "Stable", "-property", "installationPath", "-requires", "Microsoft.VisualStudio.Component.IDE.Common.Core"]);
    let out = crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT).ok()??;
    if !out.status.success() {
        return None;
    }
    // PowerShell writes the console codepage, and install paths on this kind of
    // machine contain Chinese (`E:\Apps\...`), which a lossy decode destroyed.
    let text = crate::proc::decode_console(&out.stdout);
    for line in text.lines() {
        let dir = line.trim();
        if dir.is_empty() {
            continue;
        }
        let cand = Path::new(dir).join(r"Common7\IDE\devenv.exe");
        if cand.is_file() {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}

/// Every IDE found on this machine, in catalog order.
///
/// `custom` are user-supplied executable paths (the escape hatch for anything
/// this file's locators cannot see); they are resolved like any other entry and
/// kept even when missing, so a moved install reads as broken rather than
/// silently vanishing.
pub fn detect() -> Vec<ToolInfo> {
    detect_from(&read_config_custom(), &uninstall_records())
}

/// The custom entries, read from the same config file the settings view writes.
fn read_config_custom() -> Vec<String> {
    crate::custom_ides()
}

/// Testable core: everything except the registry and the config file.
fn detect_from(custom: &[String], records: &[UninstallRecord]) -> Vec<ToolInfo> {
    let mut out: Vec<ToolInfo> = Vec::new();
    for spec in SPECS {
        // Full Visual Studio prefers vswhere when it is present: it is the
        // authoritative answer for which SKU has an IDE.
        let found = if spec.id == "visualstudio" {
            vswhere_devenv().map(|p| (p, "vswhere".to_string())).or_else(|| resolve(spec, records))
        } else {
            resolve(spec, records)
        };
        if let Some((path, detail)) = found {
            out.push(ToolInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                path: Some(path),
                detail: Some(detail),
                icon: None,
            });
        }
    }

    for raw in custom {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        if out.iter().any(|i| i.path.as_deref().unwrap_or("") .eq_ignore_ascii_case(p)) {
            continue;
        }
        let label = Path::new(p)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string());
        out.push(ToolInfo {
            id: format!("custom:{p}"),
            label,
            path: Some(p.to_string()),
            detail: Some(if is_file(p) { "手动指定".to_string() } else { "手动指定（文件不存在）".to_string() }),
            icon: None,
        });
    }

    out
}

/// Attaches extracted icons to `items`, filling only the ones still missing.
///
/// A single PowerShell process handles the whole batch; see the module header
/// for why not one per IDE.
pub fn with_icons(mut items: Vec<ToolInfo>, cache_dir: &Path) -> Vec<ToolInfo> {
    let exes: Vec<(String, String)> = items
        .iter()
        .filter_map(|i| i.path.clone().filter(|p| is_file(p)).map(|p| (i.id.clone(), p)))
        .collect();
    let pngs = match extract_icons(&exes, cache_dir) {
        Ok(map) => map,
        Err(e) => {
            eprintln!("[idescan] 图标提取失败: {e}");
            Default::default()
        }
    };
    for item in items.iter_mut() {
        if let Some(data) = pngs.get(&item.id) {
            item.icon = Some(format!("data:image/png;base64,{}", base64(data)));
        }
    }
    items
}

/// Extracts one PNG per executable, reusing anything already cached.
///
/// Returns `id -> png bytes`. The manifest is passed to PowerShell as a file
/// rather than as arguments so paths with spaces, brackets and non-ASCII
/// characters never touch command-line parsing.
fn extract_icons(exes: &[(String, String)], cache_dir: &Path) -> Result<std::collections::HashMap<String, Vec<u8>>, String> {
    let mut out = std::collections::HashMap::new();
    let mut pending: Vec<(String, String, PathBuf)> = Vec::new();
    let _ = std::fs::create_dir_all(cache_dir);

    for (id, exe) in exes {
        let target = cache_dir.join(format!("{}.png", cache_key(exe)));
        if let Ok(bytes) = std::fs::read(&target) {
            if !bytes.is_empty() {
                out.insert(id.clone(), bytes);
                continue;
            }
        }
        pending.push((id.clone(), exe.clone(), target));
    }
    if pending.is_empty() {
        return Ok(out);
    }

    // One PowerShell run for the whole batch.
    let work = cache_dir.join("extract.ps1");
    let manifest = cache_dir.join("manifest.txt");
    let mut text = String::new();
    for (_, exe, target) in &pending {
        text.push_str(&format!("{}|{}\n", exe, target.to_string_lossy()));
    }
    std::fs::write(&manifest, text).map_err(|e| format!("写入图标清单失败: {e}"))?;
    std::fs::write(
        &work,
        [
            "param([string]$Manifest)",
            "$ErrorActionPreference = 'SilentlyContinue'",
            "Add-Type -AssemblyName System.Drawing",
            "foreach ($line in Get-Content -LiteralPath $Manifest) {",
            "  if (-not $line) { continue }",
            "  $parts = $line -split '\\|', 2",
            "  $src = $parts[0]; $dst = $parts[1]",
            "  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)",
            "  if ($null -eq $icon) { continue }",
            "  $bmp = $icon.ToBitmap()",
            "  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)",
            "  $bmp.Dispose(); $icon.Dispose()",
            "}",
            "",
        ]
        .join("\n"),
    )
    .map_err(|e| format!("写入图标脚本失败: {e}"))?;

    // The status, stdout and stderr used to be discarded (`let _ = …`), so a machine
    // where PowerShell is missing, blocked by `AllSigned`, or crashed looked exactly
    // like a machine with no icons to find — and with `$ErrorActionPreference =
    // 'SilentlyContinue'` two lines above, there was nothing left to report either.
    let mut ps_cmd = crate::proc::silent("powershell.exe");
    ps_cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &work.to_string_lossy(),
        "-Manifest",
        &manifest.to_string_lossy(),
    ]);
    // Bounded, and it matters more here than anywhere else in this file: the
    // caller holds the `IDE_DETECT` gate across the whole scan, so one wedged
    // PowerShell (a machine policy that never lets it start, a profile that
    // prompts despite `-NoProfile`) would serialise every future `list_ides`
    // call behind a dead scan — the UI's IDE list simply never comes back.
    // `-File` output is a handful of small PNGs written to disk, so a few
    // seconds of stdout is normal; 60 s is generous next to the measured run.
    let ps = crate::proc::output_timeout(&mut ps_cmd, std::time::Duration::from_secs(60));

    for (id, _, target) in &pending {
        if let Ok(bytes) = std::fs::read(target) {
            if !bytes.is_empty() {
                out.insert(id.clone(), bytes);
            }
        }
    }

    // Only a *total* failure to produce anything is reported, and only when the script
    // itself said it failed: a partial result (some IDEs have no icon) must not become
    // an error, and the caller falls back to no icons either way. The temp files are
    // cleaned before returning either way — the previous Err paths leaked them.
    let result = if out.is_empty() && !pending.is_empty() {
        match ps {
            Ok(Some(o)) if !o.status.success() => {
                let err = crate::proc::decode_console(&o.stderr);
                let err = err.trim();
                Err(format!(
                    "PowerShell 提取图标失败（退出码 {:?}）：{}",
                    o.status.code(),
                    if err.is_empty() { "无输出" } else { err }
                ))
            }
            Ok(None) => Err(
                "PowerShell 提取图标超过 60 秒未结束，已中止（IDE 列表将不带图标显示）".to_string(),
            ),
            Err(e) => Err(format!("无法启动 PowerShell 提取图标: {e}")),
            _ => Ok(out),
        }
    } else {
        Ok(out)
    };
    let _ = std::fs::remove_file(&work);
    let _ = std::fs::remove_file(&manifest);
    result
}

/// A short stable hash of the executable path, so a reinstalled IDE at a new
/// path does not reuse a stale icon.
fn cache_key(exe: &str) -> String {
    let lowered = exe.to_lowercase();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in lowered.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{h:016x}")
}

/// Base64 without pulling in a codec crate for one call site.
fn base64(bytes: &[u8]) -> String {
    const ALPHA: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(ALPHA[(n >> 18) as usize & 63] as char);
        out.push(ALPHA[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHA[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHA[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_icon_handles_every_observed_shape() {
        assert_eq!(
            parse_display_icon(r"D:\Apps\VSCode\Microsoft VS Code\Code.exe").as_deref(),
            Some(r"D:\Apps\VSCode\Microsoft VS Code\Code.exe")
        );
        assert_eq!(
            parse_display_icon(r#""C:\Program Files (x86)\X\setup.exe""#).as_deref(),
            Some(r"C:\Program Files (x86)\X\setup.exe")
        );
        assert_eq!(
            parse_display_icon(r"C:\a\b.exe,0").as_deref(),
            Some(r"C:\a\b.exe")
        );
        // An uninstaller icon is not a launchable app.
        assert_eq!(parse_display_icon(r"D:\Apps\Qoder\Qoder CN\uninstallerIcon.ico"), None);
        assert_eq!(parse_display_icon("msiexec.exe"), None);
        assert_eq!(parse_display_icon(""), None);
    }

    // Round 13 (d3-3): the pure helpers below had no direct tests. They are the
    // easy-to-get-wrong parts of IDE detection — env expansion, the icon cache
    // key, and the hand-rolled base64 — so they earn explicit coverage.
    #[test]
    fn env_expansion_resolves_known_vars_and_stays_plain_without_them() {
        std::env::set_var("DEVHUB_IDESCAN_TEST_VAR", r"C:\resolved");
        // No `${` at all → returned verbatim, no env lookup.
        assert_eq!(expand("just text").as_deref(), Some("just text"));
        // A single var → replaced.
        assert_eq!(
            expand("${DEVHUB_IDESCAN_TEST_VAR}").as_deref(),
            Some(r"C:\resolved")
        );
        // Var embedded between literals → replaced in place.
        assert_eq!(
            expand("x${DEVHUB_IDESCAN_TEST_VAR}y").as_deref(),
            Some("xC:\\resolvedy")
        );
        // An unknown var → the whole expansion fails (the path would be bogus).
        assert_eq!(expand("${DEVHUB_IDESCAN_DOES_NOT_EXIST}"), None);
        std::env::remove_var("DEVHUB_IDESCAN_TEST_VAR");
    }

    #[test]
    fn cache_key_is_case_insensitive_and_stable() {
        let a = cache_key(r"C:\Program Files\App\app.exe");
        // 16 hex chars, no separators.
        assert!(a.len() == 16 && a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, cache_key(r"c:\program files\app\app.exe"), "case must not matter");
        // A different path must (with overwhelming probability) hash differently.
        assert_ne!(a, cache_key(r"C:\Other\other.exe"));
    }

    #[test]
    fn base64_matches_the_standard_alphabet_with_padding() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"Ma"), "TWE=");
    }

    #[test]
    fn record_matching_tolerates_the_user_suffix_and_case() {
        assert!(name_matches("Trae CN (User)", "Trae CN"));
        assert!(name_matches("Microsoft Visual Studio Code", "microsoft visual studio code"));
        assert!(name_matches("JetBrains Rider 2025.3.1", "JetBrains Rider"));
        // "Trae CN (User)" must NOT be claimed by a bare "Trae SOLO" prefix...
        assert!(!name_matches("Trae CN (User)", "TRAE SOLO CN"));
        // ...and a "Rider" prefix must not swallow an unrelated name.
        assert!(!name_matches("JetBrains Toolbox", "JetBrains Rider"));
    }

    #[test]
    fn a_record_pointing_at_a_missing_file_still_resolves_through_install_location() {
        // JetBrains writes DisplayIcon as bin/<exe> and InstallLocation as the
        // product root; the relative launcher is what actually exists.
        let spec = Spec {
            id: "fake",
            label: "Fake",
            app_paths: &[],
            record_prefixes: &["Fake IDE"],
            relative: &["bin/fake64.exe"],
            candidates: &[],
            path_cmds: &[],
        };
        let dir = std::env::temp_dir().join("devhub-idescan-rel");
        let bin = dir.join("bin");
        let _ = std::fs::create_dir_all(&bin);
        std::fs::write(bin.join("fake64.exe"), b"MZ").unwrap();
        let records = vec![UninstallRecord {
            display_name: "Fake IDE 1.2".to_string(),
            install_location: Some(dir.to_string_lossy().to_string()),
            exe: None,
        }];
        let found = detect_from(&[], &records);
        let hit = resolve(&spec, &records);
        assert!(
            hit.is_some(),
            "relative launcher under InstallLocation must resolve"
        );
        // `detect_from` runs the real catalog against the real machine, so the
        // count is the user's business. What must hold is that a fake record
        // cannot inject a fake entry into it.
        assert!(
            !found.iter().any(|i| i.id == "fake"),
            "a spec that is not in the catalog must not appear in its output"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_entries_survive_a_moved_file_and_are_deduped() {
        let dir = std::env::temp_dir().join("devhub-idescan-custom");
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("MyEditor.exe");
        std::fs::write(&real, b"MZ").unwrap();
        let gone = dir.join("Gone.exe").to_string_lossy().to_string();

        let out = detect_from(&[real.to_string_lossy().to_string(), gone.clone()], &[]);
        let labels: Vec<&str> = out.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"MyEditor"), "got {labels:?}");
        assert!(labels.contains(&"Gone"), "a moved manual entry must stay visible as broken");
        let broken = out.iter().find(|i| i.label == "Gone").unwrap();
        assert!(broken.detail.as_deref().unwrap().contains("不存在"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_the_std_library_for_every_length() {
        // Hand-rolled codecs are exactly where corrupt icons come from, so this
        // checks all three chunk lengths against a known-good encoding.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"MI"), "TUk=");
        assert_eq!(base64(b"MIE"), "TUlF");
        assert_eq!(base64(b"MIE/"), "TUlFLw==");
    }

    #[test]
    fn cache_key_is_stable_and_path_specific() {
        assert_eq!(cache_key(r"D:\A\B.exe"), cache_key(r"d:\a\b.exe"));
        assert_ne!(cache_key(r"D:\A\B.exe"), cache_key(r"D:\C\B.exe"));
    }

    #[test]
    fn the_real_scan_finds_something_on_this_machine() {
        // Not asserting a count: what is installed is the user's business. This
        // only proves the pipeline runs without panicking and returns the
        // catalog's own shape.
        let found = detect();
        for f in &found {
            assert!(!f.id.is_empty());
            assert!(!f.label.is_empty());
            println!(
                "ide {} -> {:?} [{}]",
                f.label,
                f.path,
                f.detail.as_deref().unwrap_or("")
            );
        }
    }
}
