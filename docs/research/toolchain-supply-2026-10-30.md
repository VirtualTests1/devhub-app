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

## 2. cargo-audit：工具真的跑了，数据库没拉下来

脚本原来在工具缺失时打印 INFO 并退出 0；`pnpm verify` 与 CI 都会因此把“没审计”
读成绿色。本轮：

- `scripts/rust-supply.mjs` 新增 `--require`（工具或数据库缺失 → exit 2）与项目内
  查找 `.pack/tools/bin/cargo-audit.exe`；
- CI 固定安装 `cargo-audit --locked --version 0.22.2`，然后
  `node scripts/rust-supply.mjs --require`。

本机实测（2026-10-30）：

```
cargo install cargo-audit --locked --version 0.22.2 --root .pack/tools   # 成功
node scripts/rust-supply.mjs --require
→ CANNOT DETERMINE: cargo-audit 输出不可解析
→ could not fetch advisory database: git operation failed:
   error sending request for url (https://github.com/RustSec/advisory-db.git/info/refs...)
→ exit 2
```

结论：**审计本身没有结论**，原因是本机到 GitHub 的 git 传输失败（`api.github.com`
的 HTTPS 请求可用，`github.com` 的 git smart-HTTP 不可用）。这不是“无漏洞”，也不是
“有漏洞”。CI 的 runner 网络不同，步骤已接好，但本轮没有推送，**CI 结果未核实**。
本地 `pnpm verify` 在默认模式下仍把这一态记为 INFO（不阻塞发布前的其他检查），
只有 `--require` 才失败。

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
- 45 条 clippy 风格/复杂度告警未清理；其中 `too_many_arguments` 是设计取舍，不是
  待办清单上的机械项。
- 覆盖率未按目录设阈值；`src-tauri` 没有 JS 覆盖率口径，Rust 侧靠 493 个
  `#[test]`（`cargo test --lib`，2026-10-30 实测 493 passed / 0 failed）。
