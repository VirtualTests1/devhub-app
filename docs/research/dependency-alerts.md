# 剩余依赖告警处置（r28-R3）

状态：**已修复高危与 Vite 告警；剩余 glib 为 Linux-only 传递依赖，记录为已接受风险。**
调研日期：2026-10-28。

## 已处理

- `hickory-resolver` 0.24 → 0.26.3：修复 GHSA-5j98（high）与 hickory-proto 的 GHSA-q2qq（medium）；同时修正交叉校验读取 hosts 的行为。
- Vite 8.3.2 → 8.3.5：修复 Vite/launch-editor 的 7 条告警。
- 移除未接线的 Tantivy 依赖：`lru` 告警随之消失。

## 剩余项

- `glib` 0.18.5（medium，GHSA-wrw7-89jp-8q8g）经 `gtk → tauri` 进入 `--target all` 依赖树；在 Windows 目标下：

  ```text
  cargo tree -i glib --target x86_64-pc-windows-msvc
  warning: nothing to print.
  ```

  因此它不是 Windows 构建的实际依赖。升级它需要跟随 Tauri 的 Linux GTK 栈，收益与风险不匹配；本轮不强行升级。

## 决策与边界

- 保持 Dependabot alerts/security updates 开启，不关闭告警来“变绿”。
- 发布说明不宣称“无已知漏洞”；若未来提供 Linux 构建，必须重新评估 glib。
- 复现：`cargo tree -i lru --target all`（无匹配）、`cargo tree -i glib --target x86_64-pc-windows-msvc`（nothing to print）、`cargo tree -i glib --target all`（经 gtk/tauri）。
- 未验证：Windows 安装包运行时是否引入其他平台特定依赖；GitHub Dependabot 刷新存在延迟，以刷新后的页面为准。
