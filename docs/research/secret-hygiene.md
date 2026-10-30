# 本地密钥卫生扫描：模式、脱敏与边界（r34-D7）

日期：2026-10-30。实现：[`src-tauri/src/secrets.rs`](../../src-tauri/src/secrets.rs)、
[`src/dialogs/SecretScanDialog.tsx`](../../src/dialogs/SecretScanDialog.tsx)。

## 1. 范围

单仓库、离线、只读。扫描器寻找**高信号**形状：

| kind | 形状 |
|---|---|
| `github-token` | `ghp_/gho_/ghu_/ghs_/ghr_` + 长串，或 `github_pat_` |
| `aws-access-key` | `AKIA` + 16 位大写字母数字 |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` 头 |
| `slack-token` | `xox[baprs]-…` |
| `stripe-live` | `sk_live_…` |
| `generic-assignment` | `api_key/secret/token/password = "…"`，值熵 ≥ 3.2 且不含占位词 |

它不是 gitleaks/trufflehog 的替代品；自定义格式、拆分字符串、编码后的密钥都可能漏掉。
界面把它写成“提示去看”，不是“安全结论”。

## 2. 脱敏契约

命中永远不返回完整值：token 形状取前 4 + `…` + 后 4；私钥只返回头行。复制按钮复制的
也是脱敏后的行。结果只在对话框内存里；不写活动记录、不写 config、不落盘。

## 3. 上限

单仓库、深度 8、单文件 1 MiB、2 000 文件、100 命中、10 秒；跳过 `.git`/依赖/构建目录、
符号链接、二进制（前 8 KiB 含 NUL）。`truncated`/`timedOut` 与 `filesSkipped` 一并显示，
“没有命中”只在确实扫描完成时才说。

## 4. 验证

- `cargo test --lib secrets`：6 个测试，包含运行时构造的假 token（源码里不出现完整
  令牌形状）、私钥头、占位词、高熵赋值、熵阈值。
- 扫描根由后端从 `repo_index` 解析，只接受 slug；页面不能传任意路径。
- 未在真机点击对话框；规则、脱敏、根解析与类型检查覆盖。

## 5. 未验证/风险

- 合成语料之外的误报率未知；`generic-assignment` 尤其需要人工判断。
- 没有对二进制文件内容做深度解码；UTF-16 文本会因 NUL 被跳过。
- 不是持续监控：用户点一次才扫一次。
