# Windows 变更检测：USN 日志 vs ReadDirectoryChangesW（r31-R3）

日期：2026-10-29。环境：Windows 10/11，D: 为 NTFS（同一 checkout 所在卷）。
本轮结论：**暂不接入** USN 日志；保留现有 `ReadDirectoryChangesW` 实时监听 +
700 ms 轮询兜底。下面是可复现实验与不接入的具体理由。

## 1. 现状与问题

应用需要知道仓库目录是否被外部改动（终端里 `npm install`、编辑器保存、另一个工具
写文件）。`src-tauri/src/native_watch.rs` 用 `ReadDirectoryChangesW` 推事件，
`src-tauri/src/fs_watch.rs` 的轮询是 watcher 不可用时的兜底。

USN 日志的额外价值只有一个：**应用没运行时发生的改动，下次启动可以回放**。
实时性、低延迟并不是它的优势——它需要主动读日志，而 ReadDirectoryChangesW 是推送。

## 2. 可复现实验

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/usn-probe.ps1 `
  -Volume D: -ProbeDir <throwaway-dir>
```

2026-10-29 实测（同一卷）：

| 项目 | 结果 |
|---|---|
| `fsutil usn queryjournal D:` | 退出码 **0**（当前用户，无显式提权） |
| Journal ID | `0x01da7cf895ef89c4` |
| Next USN before | `0x000000029acd47d0` |
| 写入并删除一个临时文件后 | `0x000000029acd4a70`（前进 `0x2a0` = 672 字节） |
| Maximum Size / Allocation Delta | 32.0 MB / 8.0 MB |
| `fsutil usn readjournal D:`（手工） | 退出码 **0**，返回 USN 记录 |
| 控制台标签 | 本次捕获为本地化文本，在 Git Bash/PowerShell 重定向下显示为乱码 |

`scripts/usn-probe.ps1` 只查询、可选写一个临时文件并删除；它**不** dump 整个日志
（日志可能很大），也不解析本地化标签。

## 3. 方案比较

| 方案 | 能力 | 成本/边界 | 结论 |
|---|---|---|---|
| ReadDirectoryChangesW（现状） | 实时、内核推送、按目录树 | 应用未运行时的事件丢失；网络盘/大量目录有边界 | 保留 |
| 700 ms 轮询（现状兜底） | 不依赖 watcher | 延迟、I/O、无法知道“改了什么” | 保留 |
| USN 日志（FSCTL_READ_USN_JOURNAL） | 可回放应用关闭期间的变化 | 卷级；日志会 wrap；需要持久化 USN checkpoint；路径/FRN 映射；某些卷/权限下不可读；文本 `fsutil` 输出本地化，必须走 FFI 二进制结构 | 暂不接入 |
| 重启后全量 mtime 扫描 | 简单 | 大仓库慢，仍无法区分变化来源 | 不新增 |

## 4. 为什么不直接接

1. **输出不是稳定接口**：`fsutil` 的标签随系统语言变化；Rust 侧应使用
   `DeviceIoControl(FSCTL_READ_USN_JOURNAL)` 的二进制 `USN_RECORD`，不是解析文本。
   这是一套新的 unsafe FFI 与结构体对齐工作，需要独立测试与错误处理。
2. **checkpoint 与 wrap**：必须保存 last USN（以及 Journal ID），日志被清除/重置或
   wrap 后要从头扫描或退化为全量。应用的“下次启动”可能间隔数天，wrap 是常态而不是
   异常。
3. **卷级范围**：一个项目容器可以在多个卷/网络盘上；USN 只覆盖本地 NTFS 卷。
   `scripts/usn-probe.ps1` 在 D: 当前用户可读，不代表所有卷/策略下都可读。
4. **收益不紧迫**：实时改动已经有 watcher；关闭期间的变化下次启动会做一次 wall
   refresh/metadata 读取。USN 只会把“启动后多久发现”从一次刷新缩短到一次回放，而
   当前没有用户报告这个延迟。

## 5. 若未来接入的可执行方案

- Rust `DeviceIoControl` + `FSCTL_READ_USN_JOURNAL`，按卷读者；只在用户显式启用
  “关闭期间变更回放”时启动。
- 每个卷保存 `{journalId, lastUsn}` 到应用配置；Journal ID 变化或 USN 不可用时，
  退化为一次全量目录签名扫描，并在 UI 说明原因。
- 只保留最近 N 天的记录；丢弃无法映射到项目根的记录；限制每次回放时间/记录数。
- 单测用合成的 `USN_RECORD` 字节；集成测试只在本机 NTFS 临时卷上可跳过。
- 不请求管理员权限；读不到就保持现有 watcher，不阻塞启动。

## 6. 未验证/信息缺失

- 没有在“应用关闭 → 外部改动 → 重启”的完整场景上实现或测量回放；本文只验证了
  journal 可查询、可读、Next USN 会前进。
- 没有测试非管理员在其它卷/组策略下的可读性，也没有测试 journal wrap 的实际时间。
- 没有用 Rust FFI 读取 USN 记录；`fsutil` 的本地化输出明确不适合作为生产解析层。
- 现有 watcher 的实际漏事件率没有测量；本轮没有改动它。后续的
  [native-watch-stress](native-watch-stress.md) 用合成密集写入测到 500/500 唯一文件名
  覆盖（单次运行、合成负载），这不等于真实编辑器的长期漏事件率，也不覆盖停止路径。

## 7. 来源

- USN 变更日志（Windows）：
  <https://learn.microsoft.com/windows/win32/fileio/change-journal-records>
- `FSCTL_READ_USN_JOURNAL`：
  <https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-fsctl_read_usn_journal>
- `ReadDirectoryChangesW`：
  <https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-readdirectorychangesw>
- 本机 `fsutil usn queryjournal D:` / `readjournal D:` 输出（2026-10-29，见 §2）。
