# 自动更新机制调研（r28-R1）

状态：**只做“检查更新 + 跳转发布页”，不做自动替换可执行文件。**
调研日期：2026-10-28。

## 来源

- Tauri 2 updater 插件文档：<https://v2.tauri.app/plugin/updater/>（2026-10-28 抓取）。
- GitHub Releases latest API：<https://api.github.com/repos/VirtualTests1/devhub-app/releases/latest>（2026-10-28 实测可解析）。
- 本仓当前发布：`v0.3.0`，仅源码、无安装包资产。

## 事实

- Tauri updater 需要 `pubkey`、`endpoints`，生产模式要求 TLS；更新产物需要签名，校验失败会拒绝更新。
- 当前仓库没有 updater endpoint、签名密钥、安装包或 updater manifest；把按钮做成“自动更新”无法兑现。
- 本应用是绿色目录运行，替换正在执行的 exe 还需要处理文件占用、回滚、失败恢复和代码签名，这些都不在现有工程边界内。

## 方案比较

| 方案 | 收益 | 成本/风险 | 结论 |
|---|---|---|---|
| GitHub Release 检查 + 打开页面 | 用户能看到新版本，不改变本地文件 | 只有提示，不自动安装 | **采用（r28-N1）** |
| Tauri updater 自动安装 | 一键升级 | 需要签名密钥、manifest、回滚与安装形态；当前没有 | 暂不采用 |
| 静默下载并替换 | 最少点击 | 代码签名、杀软、运行中文件占用、回滚都未解决 | 不采用 |

## 复现 / 验证

- `node --experimental-strip-types ... tests/about-ui.test.ts` 与 `cargo test --lib update_check`：解析、版本比较、草稿/无 release 错误。
- 手动网络测试（ignored）：`cargo test --lib update_check::tests::live_release_feed_is_parseable -- --ignored`。
- 未验证：真实安装包的签名更新、Windows 文件占用下的替换。

## 重开条件

出现经签名的安装包、稳定的 updater manifest/endpoint、密钥管理与回滚方案后，再评估把检查升级为自动安装；届时需要真机 GUI 更新演练，不以编译通过代替。
