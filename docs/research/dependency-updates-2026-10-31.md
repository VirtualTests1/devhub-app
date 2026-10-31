# 依赖更新与漏洞审计（2026-10-31，r35 发布前）

本轮发布冻结依赖：没有升级 lockfile，没有新增 npm/Rust 依赖。下面是发布前实际跑过的
盘点，供下一轮决定升级顺序。

## 1. npm 可用更新

`pnpm outdated --json` 显示（只列与本项目直接相关的）：

| 包 | 当前 | 最新 | 类型 |
|---|---|---|---|
| `@tauri-apps/api` | 2.12.1 | 2.12.4 | 运行时 |
| `@tauri-apps/cli` | 2.12.1 | 2.12.4 | 开发 |
| `@tauri-apps/plugin-dialog` | 2.8.1 | 2.8.4 | 运行时 |
| `@tauri-apps/plugin-opener` | 2.7.0 | 2.7.2 | 运行时 |
| `@vitejs/plugin-react` | 6.1.1 | 6.1.2 | 开发 |
| `react` / `react-dom` | 19.3.0 | 19.3.1 | 运行时 |
| `@typescript-eslint/*` | 8.71.2 | 8.72.1 | 开发 |
| `eslint` | 9.39.4 | 10.14.0 | 开发（大版本） |
| `typescript` | 6.0.3 | 7.0.2 | 开发（大版本） |

这些小版本本可以在发布前升级，但那会让 lockfile、构建产物与 Release 资产之间多一次
不可回退的关联；本轮选择冻结，下一轮按“升级 → 全门禁 → 打包”的完整链路做。

## 2. npm 漏洞

`node scripts/audit-report.mjs` 在默认镜像没有审计端点后回退到 npm 官方 registry，
得到 **1 条 moderate advisory**：

- `minimatch <11.0.1`，GHSA-g3hv-75wg-m249（globparts 放大的 DoS）。
- 受影响的两个安装版本：`minimatch@3.1.5`（ESLint 9 的 `@eslint/config-array`）和
  `minimatch@10.2.6`（`@typescript-eslint/typescript-estree`）。
- **只在开发工具链，不进入 DevHub 发布二进制**；CI 使用的 glob 来自仓库自身配置，
  不接收不受信输入。

没有用 `pnpm.overrides` 强行跨大版本覆盖到 11.x：两个父包都按 3.x/10.x 的 API 使用它，
覆盖可能让 lint 在发布前失效。下一轮先升级 `eslint`/`@typescript-eslint` 到支持修复版
的版本，再跑 `pnpm gate`；在此之前记录为残余风险，不宣称“无已知漏洞”。

## 3. Rust

`cargo update --dry-run` 显示多项 patch 更新（含 `wry 0.57.0 → 0.57.1` 等），没有升级；
`node scripts/rust-supply.mjs --require` 使用缓存 advisory-db 报告 **0 条已知漏洞**。
Rust 依赖的升级同样留到下一轮，以完整 `cargo test --lib` + `clippy` + 打包验证。

## 4. 结论

- 发布版本不新增依赖，npm 运行时依赖没有已知 high/critical。
- 唯一 moderate 是 dev-only 的 minimatch；已在 Release notes 与本文记录。
- 更新不是“跑一次 outdated”，而是下一轮的独立工作项，需要重新测 bundle 预算与启动。
