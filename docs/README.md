# DevHub 文档索引

状态截至 2026-10-31。研究文档记录的是**当时**的代码、测量和结论；结论可以过期，
判断前先看对应文档里的日期、提交范围和“未验证”一节。索引只负责指路，不代替证据。

- 用户指南：[`portable/使用说明.md`](../portable/使用说明.md)
- 工程规范：[`AGENTS.md`](../AGENTS.md)
- 安全问题：[`SECURITY.md`](../SECURITY.md)
- 第三方组件：[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)

## 已落地并被代码/测试引用

| 文档 | 落地形状 |
|---|---|
| [crash-observability](research/crash-observability.md) | panic hook + `last_crash` + 记录页崩溃卡 |
| [csv-injection](research/csv-injection.md) | 活动导出对公式前缀做中和 |
| [i18n-lazy-locale](research/i18n-lazy-locale.md) | 英文词表按需分块，缺键回落中文 |
| [launch-output-retention](research/launch-output-retention.md) | 启动输出内存环形缓冲（500 行） |
| [lfs-submodules](research/lfs-submodules.md) | 克隆后检测 LFS 指针/子模块，LFS 失败回退指针克隆 |
| [license-detection](research/license-detection.md) | `licenses.rs` + 记录页许可证卡 + CSV |
| [mcp-2025-11-25](research/mcp-2025-11-25.md) | MCP 修订版协商与两个本地工具 |
| [readme-rendering](research/readme-rendering.md) | README 安全链接与深度上限 |
| [release-awareness](research/release-awareness.md) | `releases.rs` + 同步面板 Release 行 |
| [repo-health](research/repo-health.md) | `health.rs` + 跨仓库健康卡 |
| [scale-1000](research/scale-1000.md) | 墙派生优化；1,000 仓库部分已被 r34 取代 |
| [scale-1000-r34](research/scale-1000-r34.md) | 1,000 仓库采样解析、索引读数 |
| [secret-hygiene](research/secret-hygiene.md) | 本地只读密钥扫描，命中已脱敏 |
| [sha256-repos](research/sha256-repos.md) | 下载后按 SHA-256 校验仓库内容 |
| [update-architecture](research/update-architecture.md) | 检查更新只读，不自动替换二进制 |
| [watcher-poll-cost](research/watcher-poll-cost.md) | 原生 watcher + 5 s 轮询兜底 |
| [packaged-runtime](research/packaged-runtime-2026-10-30.md) | 打包 `tauri.localhost` 的 CDP 验证脚本；尚未进 CI |

## 明确不采用（保留现状并写明理由）

- [fts5-search](research/fts5-search.md)：构建慢、DB 体积大于语料，收益不抵成本。
- [state-store](research/state-store.md)：继续用 JSON + 原子写，不引入 SQLite。
- [tray-notifications](research/tray-notifications.md)：保留任务栏注意力提示，不做托盘气泡。
- [usn-journal](research/usn-journal.md)：不接入 USN 回放；实时监听保留。watcher 的丢事件压力实验见
  [native-watch-stress](research/native-watch-stress.md)。

## 仍开放 / 部分落地

- [code-signing](research/code-signing.md)：签名与发布流水线仍未建立；当前 Release 仅源码。
- [toolchain-supply](research/toolchain-supply-2026-10-30.md)：clippy/audit 已进门禁，
  覆盖率阈值仍未设；工具链版本在 r35 固定到 CI 的 `RUSTUP_TOOLCHAIN`。
- [native-watch-stress](research/native-watch-stress.md)：覆盖率实验已做（合成负载），
  停止路径的 `CancelIoEx` 同步 I/O 行为仍未单独验证。
- [dependency-alerts](research/dependency-alerts.md)：`glib` 中危告警按 Linux-only 接受，
  仍保留 Dependabot 监控。
