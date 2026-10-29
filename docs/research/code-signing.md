# 代码签名、SmartScreen 与发布完整性（r31-R2）

日期：2026-10-29。当前状态：Release `v0.3.0` 是**仅源码**发布，没有可执行文件、
没有证书、没有签名流水线。本文记录选型与边界，并交付一个与签名解耦的发布清单工具。

## 1. 问题

便携 ZIP/安装器一旦上传，用户面对的第一个信任问题不是功能，而是 Windows 的
SmartScreen：“未知发布者”会阻止大多数普通用户继续。签名能给出身份，但不能凭一次签名
立刻建立信誉；把“已签名”写成“不会拦截”是不诚实的。

## 2. 方案比较

| 方案 | 能给出什么 | 成本/限制 | 结论 |
|---|---|---|---|
| 自签名证书 | 文件未被篡改的本地校验 | 不受公共信任，SmartScreen 仍会警告；分发根证书是另一种风险 | 不用于公开 Release |
| OV Authenticode 证书 | 可验证的发布者身份、时间戳后长期有效 | 需要 CA 审核、硬件令牌/云 HSM；SmartScreen 信誉仍需积累 | 发布二进制时的候选 |
| EV Authenticode | 更高身份门槛，历史上有更快的信誉 | 成本/审核更高，仍需硬件/云 HSM | 只在上传量证明需要时选 |
| Azure Trusted Signing | 微软托管的签名身份与短期证书、适合 CI | 订阅/资格审核；依赖云服务与网络 | 发布流水线成熟后的候选 |
| 不签名 + SHA-256 清单 | 用户可校验下载完整性；明确“未知发布者” | 不提供发布者身份，不消除 SmartScreen | **当前阶段采纳**（尚未发布二进制） |

时间戳必须做：没有时间戳的签名会在证书到期后失效；有 RFC 3161 时间戳的签名可以在
证书过期后继续验证。签名后必须用 `signtool verify /pa /v` 验证，而不是只看签名命令
退出 0。

## 3. 本轮的交付

`scripts/release-manifest.mjs`（零依赖）：

```bash
# 对任意发布目录生成 release-manifest.json + SHA256SUMS
node scripts/release-manifest.mjs <release-dir>
# 或
pnpm release:manifest <release-dir>

# 上传前重新计算并核对：缺失/改动/多出的文件都会失败
node scripts/release-manifest.mjs <release-dir> --check
```

- 只遍历普通文件，不跟随 symlink/junction；
- 文件按路径排序，哈希为 SHA-256，清单不含时间戳，同一输入产生同一清单；
- `--check` 发现缺失、哈希/大小不符、未列入清单的普通文件时退出 1；
- 它不签名、不上传、不修改任何文件（除输出清单本身）。
- 单元测试覆盖确定性、GNU `SHA256SUMS` 格式、改动/删除/多文件、链接跳过、损坏清单。

发布二进制时的顺序应是：**从 tagged commit 构建 → 签名 → `signtool verify /pa` →
生成清单 → 上传 ZIP 与清单 → 在 Release notes 写来源、构建方式、SHA-256**。签名证书
和私钥不进仓库，使用 CI secret 或硬件/云 HSM。

## 4. 未验证/不承诺

- 没有购买或测试任何 Authenticode/Trusted Signing 证书；本文的成本与 SmartScreen 行为
  来自官方文档，不是本机实测。
- 本轮没有构建或上传 Windows 可执行文件；清单工具用临时 fixture 验证，未对真实 ZIP 运行。
- SmartScreen 信誉是云端行为，无法用本地脚本证明“签名后不会被拦截”；发布说明不得这样写。
- 未接入 CI 的签名步骤；在证书、密钥保管和回滚方案确定前，不应伪造一条“已签名”流水线。

## 5. 复现

```bash
node --experimental-strip-types --import ./tests/helpers/register.mjs \
  --test tests/release-manifest.test.ts
```

## 6. 来源

- Microsoft Authenticode / SignTool：
  <https://learn.microsoft.com/windows/win32/seccrypto/signtool>
- SmartScreen 与代码签名：
  <https://learn.microsoft.com/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/>
- Azure Trusted Signing：
  <https://learn.microsoft.com/azure/trusted-signing/overview>
- RFC 3161 Time-Stamp Protocol：<https://www.rfc-editor.org/rfc/rfc3161>
