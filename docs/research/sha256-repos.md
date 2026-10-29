# Git SHA-256 仓库兼容性（r32-R1）

日期：2026-10-29。环境：`git version 2.51.0.windows.1`，Windows 10/11。

## 1. 为什么查

Git 支持 `--object-format=sha256`，对象 ID 从 40 位十六进制变成 64 位。本应用把
commit id 当字符串存进更新摘要、活动记录和前端展示；只要有一处按“40 位”解析，
SHA-256 仓库就会在某个只有少数人使用的路径上失败。这个方向先用真实仓库跑一遍，
再决定是否需要改代码。

## 2. 可复现实验

```powershell
git init --object-format=sha256 <throwaway-dir>
git -C <throwaway-dir> -c user.name=probe -c user.email=probe@example.invalid commit --allow-empty -m one
git -C <throwaway-dir> rev-parse HEAD        # 64 hex
```

实验被固化为常驻测试（git 不支持该参数时跳过）：

```powershell
cd src-tauri
cargo test --lib sha256_repositories_parse_like_sha1_ones
```

测试实际覆盖：

- `git rev-parse HEAD` 长度 = 64；
- `count_commits` 在两次提交之间返回 `Some(1)`；
- `recent_commits` 能解析 `git log --format=%h%x09%s` 的输出（更新摘要使用）；
- `short_hash` 仍输出 7 位（显示层没有按 40 截断）；
- `is_shallow_repository` 返回 `Some(false)`。

结果：**全部通过**（2026-10-29，本机）。没有发现需要修改的生产代码。

## 3. 代码审计

- `downloader.rs` 的 `short_hash` 取前 7 个字符，不假设总长度；
- `recent_commits` 使用 `%h`，由 git 决定缩写长度；
- 全仓搜索 `len() == 40` 只命中 `gitwt.rs` 的一个 **SHA-1 测试夹具**断言，不是生产分支；
- 前端只把 hash 当字符串截断/复制，没有十六进制长度校验。

## 4. 边界与未验证

- 没有在 GitHub 托管的真实仓库上验证 SHA-256：GitHub 是否提供（或将来提供）
  SHA-256 托管未核实；本实验只证明“本地/自建实例的 SHA-256 仓库，本应用的
  读取路径可用”。
- 没有做 GUI 真机验证；更新摘要的显示由 Rust 解析测试和前端既有类型覆盖。
- `gitwt`（worktree 列表）与 `repo_detail` 共用 `rev-parse`/字符串 hash，未单独
  用 SHA-256 仓库跑 worktree 场景。
