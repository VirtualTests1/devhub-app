# 崩溃可观测性：本地 panic 报告（r30-R3）

日期：2026-10-29。环境：Rust `1.95.0`，Tauri 2，release profile `panic = "abort"`。
本文记录方案比较、可复现实验和落地边界；不把“捕获所有崩溃”写成已完成能力。

## 1. 问题

应用是便携启动器，release 用 `panic = "abort"`：没有 unwind、没有进程内恢复，进程消失后
用户只看到窗口关闭。上一次运行的失败历史记录的是**前端**的 `reportError`/`fatal`，Rust
侧的 panic（后台线程、下载、扫描）不会进入那个存储。需要的是“下次启动能看到上次为什么
退出”，而不是自动上报或自动重启。

## 2. 方案比较

| 方案 | 能力 | 成本/边界 | 结论 |
|---|---|---|---|
| Windows Error Reporting `LocalDumps` | 原生崩溃、minidump、可交给调试器 | 机器级注册表/每镜像配置；二进制 dump 不能在应用内读；可能含内存中的敏感数据 | 不采纳 |
| Crashpad / Sentry 等外部上报 | 跨语言崩溃、符号化、聚合 | 网络上传、DSN/项目、隐私与同意、额外依赖；便携工具没有后端 | 不采纳 |
| `panic = "unwind"` + `catch_unwind` | 能在进程内恢复/记录 | 改变 release 失败语义、体积与生成代码；不是“捕获原生崩溃” | 不采纳 |
| **Rust panic hook + 本地 JSON** | Rust panic 的信息、位置、线程、尽力而为的调用栈 | 只在 panic 路径生效；strip 后符号有限；不覆盖原生/渲染器崩溃 | **采纳** |

## 3. 实验：`panic = "abort"` 下 hook 仍会执行

用一个独立小程序验证，而不是从文档推断：

```rust
// <tmp>/panic.rs
use std::io::Write;
fn main() {
    let p = std::env::temp_dir().join("devhub-r30-panic-hook.txt");
    let _ = std::fs::remove_file(&p);
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut f) = std::fs::File::create(&p) {
            let _ = writeln!(f, "hooked: {info}");
        }
    }));
    panic!("r30 probe");
}
```

```text
rustc -C panic=abort -O -o <tmp>/panic.exe <tmp>/panic.rs   # exit 0
<tmp>/panic.exe                                             # Git Bash reported 127
```

结果：hook 文件被写出，内容为 `hooked: panicked at <tmp>/panic.rs (line 10): r30 probe`；
stdout/stderr 为空。结论：**abort 策略下 hook 在终止前运行**，因此本地写报告可行。
（Git Bash 的 127 是本次观察到的退出码，不作为 Windows 进程退出语义的结论。）

## 4. 实现

- `src-tauri/src/crash.rs`：
  - `install()` 只执行一次；保留并调用上一个 hook，所以控制台信息不变。
  - 报告字段：`at`（RFC 3339 UTC）、`version`、`message`、`location`、`thread`、`backtrace`；
    message 最多 4,000 字节、backtrace 最多 12,000 字节，按 UTF-8 字符边界截断。
  - 写盘走 `write_atomic`（临时文件 + rename），失败只忽略，绝不在 hook 里再 panic。
  - `Backtrace::force_capture()`：release 通常没有设置 `RUST_BACKTRACE`，默认捕获会是空的；
    strip 之后符号仍然有限，报告会诚实保留“能拿到的那部分”。
  - 命令 `last_crash` / `clear_crash`；报告在用户清除前一直保留，便于之后粘贴到 Issue。
  - 在 Tauri `setup` 的第一行安装，setup 后续步骤的 panic 也能被记录。
- 前端：
  - `App.tsx` 启动时读一次；同一时间戳只弹一次 toast（`localStorage` 去重），提示详情在
    设置 → 故障与诊断。
  - `FailureHistorySection` 显示时间、版本、位置/线程、消息与可展开的调用栈；复制时用
    `redactSecrets` 隐藏令牌形状；清除需要确认。
  - 没有自动上传、没有网络请求、没有“发送报告”按钮。

## 5. 边界与未验证

- 只覆盖 Rust panic。原生库的 access violation、栈溢出、WebView2 渲染进程崩溃、断电/被
  任务管理器结束都不经过这个 hook。
- strip 之后 backtrace 可能只有地址或 `unknown`；消息与位置仍然有用。
- 报告文件在配置旁（`devhub-crash.json`），包含本地路径/线程名等诊断信息；它是本地文件，
  复制动作由用户发起。磁盘上不保证已脱敏，只有复制/展示路径会脱敏。
- 没有真机触发一次 Tauri 进程 panic 的端到端验证；已验证独立 `panic=abort` 程序、Rust
  单测（写读/截断/空调用栈）、前端类型检查与源接线测试。

## 6. 复现

```bash
# 单元测试：写读、损坏、截断、空 backtrace
pnpm test:rust -- crash::

# 前端接线：启动读一次、去重、诊断卡复制/清除
node --experimental-strip-types --import ./tests/helpers/register.mjs \
  --test tests/crash-ui.test.ts
```

## 7. 来源

- Rust `std::panic::set_hook`：<https://doc.rust-lang.org/std/panic/fn.set_hook.html>
- Rust `Backtrace`：<https://doc.rust-lang.org/std/backtrace/struct.Backtrace.html>
- Windows Error Reporting LocalDumps 配置：
  <https://learn.microsoft.com/windows/win32/wer/collecting-user-mode-dumps>
- 本机 `rustc --version`（2026-10-29，见 §1）。
