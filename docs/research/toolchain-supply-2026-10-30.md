# 工具链与供应链：clippy、cargo-audit、覆盖率（r33-D10）

日期：2026-10-30。环境：`rustc 1.95.0 (59807616e 2026-04-14)`，
`cargo-audit 0.22.2`（`cargo search cargo-audit` 当日最新，装到项目内 `.pack/tools`，
不写全局 `~/.cargo/bin`），Node `22.19.0`。

## 1. clippy：分组的真实门禁

`cargo clippy --all-targets -- -D warnings` 在加入门禁前实测 **77 个错误**（`--lib`
口径 53 个），全部是风格/复杂度类：`too_many_arguments`（8–10 个参数）、
`cloned_ref_to_slice_refs`（测试夹具）、`sort_by_key`、`div_ceil`、`is_multiple_of`、
`empty_lines_after_doc_comment` 等。

决定：**不**用 `-D warnings` 一次性抬高（那会变成一次跨 20+ 文件的重写，且其中
`too_many_arguments` 涉及 Tauri 命令签名），而是把**会改变行为的两组**设为错误：

```powershell
cargo clippy --all-targets -- -D clippy::correctness -D clippy::suspicious
pnpm rust:clippy   # 同一个命令的本地入口（--lib）
```

这一步先发现并修掉 3 个 `empty_lines_after_doc_comments`（`activity.rs`、`lib.rs`
两处），随后 `--lib` 口径 **0 error / 45 style+complexity warnings**。45 条是已测量的
债务，不隐藏：`rust:clippy` 会原样打印它们，`-D warnings` 留到清理完成后再上。
CI 的 `cargo clippy` 步骤跑同一组 lint（`.github/workflows/ci.yml`）。

## 2. cargo-audit：真实运行结果与一次网络失败

脚本原来在工具缺失时打印 INFO 并退出 0；`pnpm verify` 与 CI 都会因此把“没审计”
读成绿色。本轮：

- `scripts/rust-supply.mjs` 新增 `--require`（工具或数据库缺失 → exit 2）与项目内
  查找 `.pack/tools/bin/cargo-audit.exe`；
- CI 固定安装 `cargo-audit --locked --version 0.22.2`，然后
  `node scripts/rust-supply.mjs --require`。

本机实测（2026-10-30）：

```text
cargo install cargo-audit --locked --version 0.22.2 --root .pack/tools   # 成功
node scripts/rust-supply.mjs --require
→ OK: cargo-audit 报告 0 条已知漏洞。                                      # exit 0
```

同一会话里另一次 `pnpm verify` 的审计步骤遇到 GitHub advisory-db 的 git 传输失败
（`failed to prepare fetch`），脚本按设计报 `CANNOT DETERMINE` 并以 INFO 退出；
这不是“有漏洞”，也不是“干净”。为了把两种状态分开，又用已缓存的数据库做了一次
不联网复核：

```text
cd src-tauri
../.pack/tools/bin/cargo-audit audit --no-fetch --json
→ vulnerabilities.count = 0
→ database.advisory-count = 1386（advisory-db commit ee1a49a，2026-10-29）
→ lockfile.dependency-count = 509
```

结论：**在缓存的 RustSec 数据库（1 386 条 advisory、509 个依赖）上为 0 条已知漏洞**；
数据库刷新在本机不稳定，CI 的 `--require` 会强制“刷新失败即失败”。本轮未推送，
**CI 结果未核实**。

## 3. Node 覆盖率基线

`pnpm test:coverage`（Node 内置 `--experimental-test-coverage`，无新依赖）：

- 用例：**1 464 个**（含子测试），全过；
- 全树：**line 86.26% · branch 81.42% · funcs 72.63%**。

没有设阈值：这是第一次测，先有基线再谈棘轮；不同机器/Node 版本的分母可能不同，
所以数字写在这里而不是钉进 CI。覆盖率不替代功能验证，只说明哪些文件从未被执行。

## 4. rustfmt：明确不接入

`cargo fmt --check` 在本树报 **577 处 Diff**，分布在核心模块（`activity.rs`、
`lib.rs` 等）。这是一次纯格式大重写，会淹没本轮的功能 diff，也违反“不要夹带无关
格式化”的规范。结论：**不接入 fmt 门禁**；若未来要接，应单独一轮、先确认与在途
分支的合并代价。

## 5. 复现命令

```powershell
pnpm rust:clippy
pnpm test:coverage
cargo install cargo-audit --locked --version 0.22.2 --root .pack/tools
node scripts/rust-supply.mjs --require   # 需要能访问 RustSec advisory-db 的 git 端点
```

## 6. 未验证 / 遗留

- CI 上 clippy 与 cargo-audit 步骤未实际运行（本轮未推送）；本地跑的是同一命令。
  审计的“0 条”是缓存数据库读数，不是对 GitHub 最新 DB 的实时结论。
- 45 条 clippy 风格/复杂度告警未清理；其中 `too_many_arguments` 是设计取舍，不是
  待办清单上的机械项。
- 覆盖率未按目录设阈值；`src-tauri` 没有 JS 覆盖率口径，Rust 侧靠 493 个
  `#[test]`（`cargo test --lib`，2026-10-30 实测 493 passed / 0 failed）。
