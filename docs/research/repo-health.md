# 仓库健康总览：本地事实与边界（r34-D5）

日期：2026-10-30。实现：[`src-tauri/src/health.rs`](../../src-tauri/src/health.rs)、
[`src/lib/health-overview.ts`](../../src/lib/health-overview.ts)、
[`src/views/records/HealthOverviewCard.tsx`](../../src/views/records/HealthOverviewCard.tsx)。

## 1. 它回答什么

单仓库「诊断…」对话框会做网络新鲜度、端口、依赖等昂贵探针；本总览回答的是**集合层面**
的问题：哪些克隆现在不健康。只用本地事实：

| 事实 | 来源 | 问题码 |
|---|---|---|
| marker 状态 | `read_marker_strict`（absent/unreadable/corrupt） | `marker` |
| 是否有 `.git` | 目录检查 | `no-git` |
| 工作树脏条目 | `git status --porcelain=v2 --branch` | `dirty` |
| detached HEAD | 同一份 status 的 `# branch.head (detached)` | `detached` |
| 分支无上游 | status 的 `# branch.upstream` 缺失 | `no-upstream` |
| 记录的 venv | marker `venvPath` + `Scripts/python.exe`/`bin/python` | `venv-missing` / `venv-invalid` |
| README | 四个候选文件名 | `no-readme` |
| 已确认启动配置 | marker `launch` | `no-launch` |

`git status` 每个仓库一次、5 秒超时；失败不伪装成干净，而是 `git-status` 警告 + 原话。

## 2. 严重度与上限

- `error`：marker 不可用（身份/端口块/启动配置都可能丢失）。
- `warn`：没有 git、脏工作树、detached、缺 venv、git status 失败。
- `info`：无上游、无 README、无启动配置——这些是“可以没有”的事实，不阻塞使用。
- 单次最多 200 个仓库；超出时界面明说。全量结果可导出 CSV（公式中和与许可证导出同一套）。

## 3. 验证

- `cargo test --lib health`：status v2 解析、detached、markerless 目录、缺失 venv。
- `tests/health-overview.test.ts`：clean/warn/error 汇总、排序、worstSeverity。
- 未在真机点击卡片；Rust 规则、汇总与类型检查覆盖。

## 4. 限制

- 只看本地事实：远端新鲜度（`repo_freshness`）与依赖更新仍是单仓库诊断的职责。
- `git status` 在大仓库上可能慢；200 个仓库的最坏耗时会明显高于 200 个小仓库，界面是
  按需触发，不自动轮询。
- 没有自动修复：detached/脏/缺 venv 需要用户决定；总览只给事实与码。
