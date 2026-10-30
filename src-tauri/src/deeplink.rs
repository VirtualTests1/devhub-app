//! Deep Link / URI Scheme 支持（N3）。
//!
//! `devhub://owner/repo` → 触发 GitHub 搜索 + 下载流程。
//!
//! Windows 上注册协议的两种方式：
//! 1. 通过 `register_deeplink` 命令手动注册（设置页「注册协议」行触发，运行时写 HKCU\Software\Classes\devhub 三处键，当前用户权限即可、不需要管理员）。
//! 2. 安装包（NSIS/WiX）注册按需求不做（REQUIREMENTS.md §3.5 / §6：MSI/NSIS 暂不考虑），所以没有 installer 这条路。
//!
//! 协议处理链：
//!   系统启动 devhub.exe "devhub://torvalds/linux"
//!   → `single_instance` plugin 把 argv 传给回调（第二次启动时），或
//!      `std::env::args()` 在 setup 里读取（首次启动时）
//!   → 提取 owner/repo 与动作
//!   → emit `deeplink://clone`（下载）或 `deeplink://open`（打开本地已有项目）
//!   → 前端监听并走 `startDownload` / `setOpenSlug`

use std::process::Command;
use tauri::Emitter;

/// 支持的 scheme。
pub const SCHEME: &str = "devhub";

/// 一条 `devhub://…` URL 解析后的产物。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLink {
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// `devhub://clone/owner/repo`（以及默认形式 `devhub://owner/repo`）
    Clone { owner: String, repo: String },
    /// `devhub://open/owner/repo`：在本地已有仓库时打开它，而不是再下载一份。
    Open { owner: String, repo: String },
}

impl Action {
    /// 把动作发给前端。事件名留在这里而不是调用点，`check-events.mjs` 的
    /// 字面量扫描仍能看见两个名字；`lib.rs` 因此不必为两个动作各写一遍 emit。
    pub fn emit(&self, app: &tauri::AppHandle) -> Result<(), tauri::Error> {
        match self {
            Action::Clone { owner, repo } => {
                app.emit("deeplink://clone", &format!("{owner}/{repo}"))
            }
            Action::Open { owner, repo } => {
                app.emit("deeplink://open", &format!("{owner}/{repo}"))
            }
        }
    }
}

/// 从命令行参数里提取 `devhub://…` URL（取第一个匹配的）。
pub fn pick_url_from_args() -> Option<String> {
    std::env::args().find_map(|a| {
        if a.starts_with(&format!("{SCHEME}://")) {
            Some(a)
        } else {
            None
        }
    })
}

/// 把 `devhub://owner/repo`、`devhub://clone/owner/repo` 或
/// `devhub://open/owner/repo` 解析成 Action。
pub fn parse(url: &str) -> Result<DeepLink, String> {
    let rest = url
        .strip_prefix(&format!("{SCHEME}://"))
        .ok_or_else(|| format!("不是 {SCHEME}:// 协议: {url}"))?;
    // 支持三种形式：默认 clone、显式 clone、open。
    let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let action = match parts.as_slice() {
        [owner, repo] => Action::Clone {
            owner: owner.to_string(),
            repo: repo.to_string(),
        },
        ["clone", owner, repo] => Action::Clone {
            owner: owner.to_string(),
            repo: repo.to_string(),
        },
        ["open", owner, repo] => Action::Open {
            owner: owner.to_string(),
            repo: repo.to_string(),
        },
        _ => return Err(format!("无法解析路径：{rest}（期望 owner/repo）")),
    };
    Ok(DeepLink { action })
}

/// 解析 argv 里的 deep link，返回任意已知动作；没有或解析失败返回 None。
pub fn extract_action() -> Option<Action> {
    let url = pick_url_from_args()?;
    match parse(&url) {
        Ok(DeepLink { action }) => Some(action),
        Err(e) => {
            eprintln!("[deeplink] 解析失败：{e}");
            None
        }
    }
}


// ---------------------------------------------------------------------------
// Windows 协议注册
// ---------------------------------------------------------------------------

/// 注册 `devhub://` 协议到 Windows 注册表（HKEY_CURRENT_USER，不需要管理员权限）。
///
/// 注册后，浏览器/系统就能用 `devhub://owner/repo` 把请求转发给本程序。
/// 参考：https://learn.microsoft.com/en-us/windows/win32/shell/url-protocols#registering-the-protocol
#[cfg(target_os = "windows")]
pub fn register_windows_protocol(exe_path: &str) -> Result<(), String> {
    // 用 `reg add` 命令写入 HKCU\Software\Classes\devhub
    // 不需要管理员权限（HKCU 是当前用户的注册表根）。
    let base = r"HKCU\Software\Classes\devhub";

    let run_reg = |args: &[&str]| -> Result<(), String> {
        let output = Command::new("reg")
            .args(args)
            .output()
            .map_err(|e| format!("reg {} 失败：{e}", args.get(1).unwrap_or(&"?")))?;
        if !output.status.success() {
            return Err(format!(
                "注册协议失败 ({}): {}",
                args.get(1).unwrap_or(&"?"),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    };

    // 根键的默认值：URL:DevHub Protocol（告诉系统这是一个 URL 协议）
    run_reg(&["add", base, "/f", "/ve", "/t", "REG_SZ", "/d", "URL:DevHub Protocol"])?;

    // URL Protocol 标记（告诉系统这是一个协议处理程序）
    run_reg(&["add", base, "/f", "/v", "URL Protocol", "/t", "REG_SZ", "/d", ""])?;

    // shell/open/command：指向当前 exe，%1 是 URL 参数
    let command_key = format!("{base}\\shell\\open\\command");
    let command_value = format!("\"{exe_path}\" \"%1\"");
    run_reg(&[
        "add",
        &command_key,
        "/f",
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        &command_value,
    ])?;

    Ok(())
}

/// 非 Windows 平台：预留空实现，返回 Ok。
#[cfg(not(target_os = "windows"))]
pub fn register_windows_protocol(_exe_path: &str) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// 通过前端调用：注册 Windows 协议 `devhub://`。
///
/// 把当前可执行文件路径写进 HKCU\Software\Classes\devhub\shell\open\command。
/// 不需要管理员权限。注册成功后，浏览器/系统就能把 `devhub://owner/repo`
/// 转发给本程序，走上面的 deep link 处理链。
#[tauri::command(async)]
pub fn register_deeplink() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("无法获取当前可执行文件路径：{e}"))?;
    let exe_str = exe
        .to_str()
        .ok_or_else(|| "可执行路径包含非 UTF-8 字符".to_string())?
        .to_string();
    register_windows_protocol(&exe_str)?;
    Ok(format!("已注册 devhub:// → {exe_str}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
// r21 N3-2：本文件此前没有任何测试，`parse` 是整条链的第一道闸——它认什么、
// 不认什么，直接决定用户双击一个链接之后有没有反应。下面两类分开写：
//
//   - **契约**：两种合法形式照收，畸形一律拒——这半改坏是功能失效；
//   - **边界（有意不修）**：大小写、百分号编码、两段式里的 `clone` 歧义、
//     形如盘符的 owner。这些是实测出来的**当前行为**，测试把它钉成文字而不是
//     悄悄改掉：改行为要单独的验证条件（真机双击链接没有实测），且其中
//     「盘符形 owner」那条已由前端 `cloneTargetOf` 拦下（纵深防御）。
//
// `pick_url_from_args` / `extract_clone_target` 不在这里测：它们读进程 argv，
// 而 `cargo test` 的 argv 是测试框架自己的，改它等于污染同进程的其它测试。

#[cfg(test)]
mod tests {
    use super::*;

    fn clone_of(url: &str) -> Result<(String, String), String> {
        match parse(url)? {
            DeepLink {
                action: Action::Clone { owner, repo },
            } => Ok((owner, repo)),
            DeepLink {
                action: Action::Open { .. },
            } => Err("open, not clone".into()),
        }
    }

    fn open_of(url: &str) -> Result<(String, String), String> {
        match parse(url)? {
            DeepLink {
                action: Action::Open { owner, repo },
            } => Ok((owner, repo)),
            DeepLink {
                action: Action::Clone { .. },
            } => Err("clone, not open".into()),
        }
    }

    // --- 契约 ---------------------------------------------------------------

    #[test]
    fn parse_accepts_both_supported_forms() {
        assert_eq!(
            clone_of("devhub://torvalds/linux"),
            Ok(("torvalds".into(), "linux".into()))
        );
        // `clone/` 前缀那一式归一到同一对 owner/repo。
        assert_eq!(
            clone_of("devhub://clone/torvalds/linux"),
            Ok(("torvalds".into(), "linux".into()))
        );
    }

    #[test]
    fn parse_open_form_is_distinct_from_clone() {
        assert_eq!(
            open_of("devhub://open/torvalds/linux"),
            Ok(("torvalds".into(), "linux".into()))
        );
        // 默认形式与 clone 前缀都仍然是克隆，不会被 open 抢走。
        assert!(open_of("devhub://torvalds/linux").is_err());
        assert!(open_of("devhub://clone/torvalds/linux").is_err());
        assert!(clone_of("devhub://open/torvalds/linux").is_err());
    }

    #[test]
    fn parse_tolerates_empty_and_redundant_segments() {
        // split('/').filter(!is_empty)：空段被滤掉，所以尾斜杠与双斜杠都算同一式。
        for url in ["devhub://torvalds/linux/", "devhub://torvalds//linux"] {
            assert_eq!(
                clone_of(url),
                Ok(("torvalds".into(), "linux".into())),
                "{url} should normalise"
            );
        }
    }

    #[test]
    fn parse_rejects_malformed_urls() {
        for url in [
            "https://github.com/torvalds/linux", // 不是 devhub:// 协议
            "devhub://",                        // 零段
            "devhub://torvalds",                // 只有一段
            "devhub://a/b/c",                   // 三段且不带 clone/open 前缀
            "devhub://open/a/b/c",              // open 也不能带第四段
            "devhub:///a/b/extra",              // 滤掉空段后仍是三段
            "torvalds/linux",                   // 没有协议头
        ] {
            let got = clone_of(url);
            assert!(got.is_err(), "{url} must be rejected, got {got:?}");
        }
    }

    // --- 边界（钉住当前行为，有意不修） --------------------------------------

    #[test]
    fn boundary_scheme_is_case_sensitive() {
        // Windows 的协议关联本身不区分大小写，浏览器完全可能把 `DEVHUB://…`
        // 原样交过来；这里连同 pick_url_from_args 的 starts_with("devhub://")
        // 一起不认它，链接于是**静默没有反应**。未修：改它要连着真机双击验证，
        // 记在 docs/deeplink.md 的「未验证边界」里。
        assert!(clone_of("DEVHUB://torvalds/linux").is_err());
        assert!(clone_of("Devhub://torvalds/linux").is_err());
    }

    #[test]
    fn boundary_percent_encoding_is_passed_through_undecoded() {
        // URL 里的 %20 不会被解码——GitHub 仓库名里没有空格，合法链接不会带编码，
        // 带编码的（或被编码改写过的）会原样进 owner/repo，随后由 git 拒绝。
        assert_eq!(
            clone_of("devhub://own%20er/repo"),
            Ok(("own%20er".into(), "repo".into()))
        );
    }

    #[test]
    fn boundary_two_segment_form_reads_clone_as_an_owner() {
        // `devhub://clone/owner` 只有两段，按 owner/repo 收下（owner 就叫 clone）。
        // 歧义但与两段式规则一致；三段式优先匹配 `clone/owner/repo`，
        // 所以真正的前缀形式不受影响。
        assert_eq!(clone_of("devhub://clone/linux"), Ok(("clone".into(), "linux".into())));
    }

    #[test]
    fn boundary_drive_shaped_owner_passes_here_and_is_blocked_frontend_side() {
        // `devhub://D:/foo` 解出 owner = "D:"。它在下游会被 parse_ref 当成本地
        // 路径形状，所以前端 `cloneTargetOf`（src/lib/deeplink-client.ts）拒绝
        // 含冒号的段——那道守卫的测试在 tests/deeplink-chain.test.ts。
        // 这里不改 parse：它对合法 owner/repo 没有影响，而改行为需要真机验证。
        assert_eq!(clone_of("devhub://D:/foo"), Ok(("D:".into(), "foo".into())));
    }

    #[test]
    fn both_emit_sites_still_carry_owner_slash_repo() {
        // 两端契约在载荷形状上会合：`{owner}/{repo}`（恰好一个 `/`），前端守卫也只认它。
        // 事件名与 emit 收在 `Action::emit`：lib.rs 两个调用点各一次，两个事件名在这里
        // 各出现一次——任何一侧漏掉一条启动路径，这条先红。
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let call = ["action.", "emit", "("].concat();
        assert_eq!(
            lib.matches(&call).count(),
            2,
            "setup 与 second-instance 各一处，少一处就是一条启动路径断了"
        );
        let me = include_str!("deeplink.rs").replace("\r\n", "\n");
        let code = me.split("#[cfg(test)]").next().unwrap_or(&me);
        // 拼出 needle，避免测试源码里出现连续的事件调用前缀（check-events 会扫描
        // Rust 注释/字符串），也避免断言字符串把自己数进去。
        let prefix = ["app.", "emit", "(\"deeplink://"].concat();
        for name in ["clone", "open"] {
            let needle = format!("{prefix}{name}\"");
            assert_eq!(code.matches(&needle).count(), 1, "deeplink://{name} 只在一处 emit");
        }
        assert_eq!(
            code.matches(r#"format!("{owner}/{repo}")"#).count(),
            2,
            "两个事件都发 owner/repo，形状一致"
        );
    }
}
