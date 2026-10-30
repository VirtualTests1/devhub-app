# 工具链与供应链：clippy、cargo-audit、覆盖率（r33-D10）

日期：2026-10-30。环境：`rustc 1.95.0 (59807616e 2026-04-14)`，
`cargo-audit 0.22.2`（`cargo search cargo-audit` 当日最新，装到项目内 `.pack/tools`，
不写全局 `~/.cargo/bin`），Node `22.19.0`。

## 1. clippy：分组的真实门禁

`cargo clippy --all-targets -- -D warnings` 在加入门禁前实测 **77 个错误**（`--lib`
口径 53 个），全部是风格/复杂度类：`too_many_arguments`（8–10 个参数）、
`cloned_ref_to_slice_refs`（测试夹具）、`sort_by_key`、`div_ceil`、`is_multiple_of`、
`empty_lines_after_doc_comment` 等。

决定分两步：r33 先把**会改变行为的两组**设为错误，r34 完成剩余清理后把
`-D warnings` 全量打开：

```powershell
cargo clippy --lib -- -D warnings
pnpm rust:clippy   # 同一个命令的本地入口
```

r33 这一步先修掉 3 个 `empty_lines_after_doc_comments`，`--lib` 口径剩下
**45 条 style/complexity**。r34 的清理：
- clippy 自动修复了可机改的项（`sort_by_key`、`div_ceil`、`is_multiple_of`、
  单分支 `match`、doc 缩进等）；
- 删除了 5 个确实无调用者的死函数/方法，把只被测试用的 3 个标成 `#[cfg(test)]`；
- 保留两个**有记录的窄例外**：crate 级 `too_many_arguments`（Tauri 命令与
  launch/clone 管道的签名，打包进结构体是单独的 API 设计），以及两处
  `large_enum_variant`（`Line`、`MarkerFile`；boxing 会在热路径分配）。
- 最终 `cargo clippy --lib -- -D warnings` **0 warning / 0 error**，CI 的门禁也换成了
  这一条。`--all-targets` 仍会报告测试代码的风格建议，没有纳入错误门禁。


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
