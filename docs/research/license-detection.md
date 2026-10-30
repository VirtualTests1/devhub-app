# 许可证识别：签名法与边界（r33-D7）

日期：2026-10-30。实现：[`src-tauri/src/licenses.rs`](../../src-tauri/src/licenses.rs)，
汇总与导出：[`src/lib/license-overview.ts`](../../src/lib/license-overview.ts)。

## 1. 为什么不用 GitHub 的 `license.spdx_id`

`GET /repos/{owner}/{repo}` 自带 `license.spdx_id`，项目墙的 `heat.rs` 也已经在缓存它。
但它需要网络、只覆盖拿到过元数据的仓库，而且对本地没有 remote 的克隆没有答案。
这个方向回答的是“**我这台机器上的每个克隆**现在是什么许可证”，离线、一次扫描，
不需要再消耗 API 额度。

## 2. 方法

只读仓库**根目录**：

1. `LICENSE*` / `LICENCE*` / `COPYING*` / `UNLICENSE*`（含 `LICENSE.md` 等）；
2. 清单里的声明：`package.json` / `composer.json` 的 `license`（字符串、`{type}` 或旧式
   `licenses[].type`）、`Cargo.toml` 的 `license = "…"`、`pyproject.toml` 的
   `license = "…"` 或 `license = { text = "…" }`、根目录第一个 `*.csproj` 的
   `<PackageLicenseExpression>` / `<PackageLicenseFile>` / `<PackageLicenseUrl>`。

先看许可证文件：能识别就记 `detected`，并保留文件名；识别失败但有清单声明，则记
`declared` 并注明来源是清单；两者都没有是 `missing`，有文件但没有分类是 `unknown`。
三类分开，是因为动作不同——补许可证、人工读、还是已经清楚。

识别顺序（取首个命中）：SPDX 标识行 → AGPL/LGPL/GPL → Apache-2.0 → MPL-2.0 → MIT →
BSD-3/2 → ISC → Unlicense → CC0 → BSL-1.0 → Zlib → EPL-2.0 → CC-BY-4.0。
所有匹配都在小写文本上做，GNU 家族先于普通 GPL 检查。

## 3. 可复现验证

```powershell
pnpm test                    # tests/license-overview.test.ts：汇总、tone、CSV 公式中和
pnpm test:rust               # licenses.rs 的 7 个单测：签名、SPDX、清单、优先级、缺失
```

CSV 导出沿用活动记录导出的规则：每个字段加引号、双引号翻倍、以 `= + - @ \t \r`
开头的值前置 `'`，避免仓库名成为电子表格公式。导出的列是
`slug,license,source,file,confidence,error`。

## 4. 诚实边界

- **不是法律意见**。短语签名会漏掉改写过的许可证文本、翻译版本和自定义条款；`unknown`
  是“需要人读”，不是“没有许可证”。
- 只读根目录。`LICENSES/` 子目录（REUSE 规范）与 `license-file` 指向的嵌套路径不扫；
  一个仓库根目录同时有多个许可证时只取排序后的第一个。
- 只读前 64 KiB；超长文件的后半段不会参与签名匹配。
- 单次最多 500 个仓库；超出时界面明说“只扫描了前 500 个”。
- 未在真机 WebView2 中驱动导出按钮；文件扫描、分类与 CSV 生成由单测覆盖，
  导出按钮与现有 `write_text_file` 保存流程同一条路径。
