# Git LFS 与子模块：克隆成功不等于工作树完整（r30-R1）

日期：2026-10-29。环境：Windows 10/11，Git `2.51.0.windows.1`，git-lfs `3.7.0`。
本文记录的是本机可复现实验，不是对 GitHub 托管行为的推断。

## 1. 结论

`git clone` 的退出码只描述“仓库对象与引用是否拉下来了”，不描述工作树里的文件是否可用：

- **Git LFS**：检出的是指针文件，除非 smudge filter 成功取回对象。没有 git-lfs、或对象缺失、或显式跳过 smudge 时，克隆可能“成功”或“部分成功”，而文件内容仍是 130 字节的指针。
- **子模块**：`git clone` 不初始化子模块；`.gitmodules` 存在，子目录是空的，`git submodule status` 以 `-` 开头。

DevHub 不自动执行 `git lfs pull` 或 `git submodule update --init`。这两件事会把额外的网络、凭据和供应链面引入一次“下载仓库”操作；本轮的交付是**有界检测 + 明确警告**（`src-tauri/src/clone_hazards.rs` + 下载完成卡片上的黄色标记），不是自动拉取。

r31-R1 补上了第 5 条路径：克隆因 LFS smudge 失败时，`try_git` 会用 `GIT_LFS_SKIP_SMUDGE=1` 再克隆一次。成功则保留指针文件并继续走同一套 hazard 警告（完成卡片会显示“Git LFS 指针 N 个”）；再次失败才回到原来的非瞬时失败路径。这个回退只在错误文本命中 smudge 症状，或失败目标里已经出现 `.git` + 声明 LFS 的 `.gitattributes` 时触发——后者覆盖了本机 fixture 中 stderr 没有进入 tail 的情况。它仍不取回对象，也不把指针伪装成完整文件。

## 2. 可复现实验

以下命令在 Git Bash 中执行；`<tmp>` 取任意临时目录的 Windows 路径，`file:///<tmp>` 是 Git 接受的本地 URL 形式。

### 2.1 LFS 指针即使“克隆成功”也仍在

1. 建源仓库，写入 `.gitattributes`（`*.bin filter=lfs diff=lfs merge=lfs -text`）和一个手工指针文件 `blob.bin`，`git add` 后提交。
2. `git lfs ls-files --all` 输出 `aaaaaaaaaa - blob.bin`：索引里有 LFS 条目，但对象并未上传。
3. `git lfs pointer --check --file=blob.bin` 退出码 **0**：确认该文件是合法指针。
4. `GIT_LFS_SKIP_SMUDGE=1 git clone file:///<tmp>/src clone` 退出码 **0**；`head -1 clone/blob.bin` 仍是
   `version https://git-lfs.github.com/spec/v1`。
5. 不跳过 smudge 时，同一 fixture 的克隆退出码是 **128**，stderr 为
   `error: external filter 'git-lfs filter-process' failed` / `fatal: blob.bin: smudge filter lfs failed` /
   `warning: Clone succeeded, but checkout failed.`；目标目录里没有 `blob.bin` 的工作树文件。

第 4 条是“退出 0 但文件不可用”，第 5 条是“退出非 0 但仓库目录已存在”。两者都不能只用退出码判断工作树完整性。

### 2.2 子模块是空的，且状态以 `-` 开头

1. 建子仓库并提交；建父仓库，执行
   `git -c protocol.file.allow=always submodule add file:///<tmp>/sub vendor/lib`，提交。
2. `git clone file:///<tmp>/parent clone` 退出码 **0**。
3. `ls -A clone/vendor/lib` 条目数 **0**；`git -C clone submodule status` 输出
   `-<sha> vendor/lib`；`.gitmodules` 中有 `[submodule "vendor/lib"]`。

## 3. 方案比较

| 方案 | 成本/风险 | 结论 |
|---|---|---|
| 克隆后自动 `git lfs pull` | 额外网络与 LFS 服务器鉴权；便携 Git 不一定带 git-lfs；可能交互式询问；失败会把“已下载”变成“下载失败” | 不做 |
| 克隆后自动 `git submodule update --init --recursive` | 任意子模块远端、凭据、递归深度与供应链面；一次克隆变成多次未知网络操作 | 不做 |
| 有界检测 + 警告 | 根 `.gitattributes` 声明 LFS 时最多读 500 个 tracked 文件的前 160 字节；`git ls-files -z` 8 秒上限；检测失败只显示“未核验” | **本轮采纳** |
| 完全不提示 | 用户拿到看似成功、实际不可构建的目录 | 拒绝 |

## 4. 实现边界

- 只有根目录 `.gitattributes` 声明 `filter=lfs` / `diff=lfs` / `merge=lfs` 才扫描；子目录里的属性文件不触发扫描。
- 扫描名单来自 `git ls-files -z`，最多 500 条；读取前 160 字节，匹配 `version https://git-lfs.github.com/spec/v1`。
- `git ls-files` 超时或失败时 `lfsUnchecked=true`，界面说“LFS 未核验”，不说“没有指针”。
- 子模块只认 `.gitmodules` 中有名字的 `[submodule "..."]` 段；克隆后是否已初始化不在检测范围内（应用从不初始化）。
- 检测失败、读文件失败都不影响下载成功的结论；这些是警告，不是失败。
- 名称/路径安全：`git ls-files` 的相对路径若是绝对路径或含 `..`，直接跳过并标记未核验。

## 5. 未解决/未验证

- 回退只重试一次，且只在失败目标已经有 `.git` 与 LFS `.gitattributes` 时也会触发；一个在 LFS 仓库中因其他原因失败的克隆会多付一次 skip-smudge 尝试（失败成本已由 `try_git` 的时间和层级逻辑约束）。
- 本地 `file://` fixture 的第一次克隆 stderr 没有进入 `GitRun` 的 tail（已观察），所以实现同时用目标状态识别 LFS checkout 失败；真实 GitHub 大仓库上的错误文本与目标状态组合未单独测量。
- 没有真实 GitHub 大仓库、真实 submodule 网络的端到端验证；实验全部是本地 `file://` fixture。
- 检测上限 500 个 tracked 文件：LFS 文件排在 500 名之后时可能漏报。
- 未做 GUI 真机验证；本轮只验证了 Rust 单测、前端类型检查与构建级测试。

## 6. 来源

- Git LFS pointer 规范：<https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md>
- Git `gitmodules` 文档：<https://git-scm.com/docs/gitmodules>
- Git `git submodule` 文档：<https://git-scm.com/docs/git-submodule>
- 本机 `git --version` / `git lfs version` 输出（2026-10-29，见 §1）。
