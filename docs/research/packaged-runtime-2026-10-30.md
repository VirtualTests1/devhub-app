# 打包构建的 CSP / IPC 运行时验证（r34-D10）

日期：2026-10-30。构建：`pnpm tauri build --debug --no-bundle`（本机 10 分 21 秒），
产物 `src-tauri/target/debug/devhub-app.exe`，`dist` 已嵌入。场景：
[`scripts/scenarios/packaged-runtime.mjs`](../../scripts/scenarios/packaged-runtime.mjs)。

## 1. 为什么不能只信 dev URL

r33 的 CSP 收紧（`connect-src 'self'`）是在 Vite 的 `http://localhost:1420` 页面上
验证的。打包后页面从 Tauri 自己的 origin 加载，`fetch`/IPC 的源规则不同；只用 dev
结果就宣称“打包版 CSP 没问题”是未验证的推断。本方向补上打包构建的真实运行。

## 2. 步骤

```powershell
pnpm build
pnpm tauri build --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
$env:DEVHUB_PROJECT_ROOT="D:\wai\Project\DeepSeekHarness\issues\devhub-app\.mcpfixtures\container"
src-tauri\target\debug\devhub-app.exe
node scripts/cdp.mjs scripts/scenarios/packaged-runtime.mjs --port 9223
```

## 3. 实测结果（2026-10-30）

```json
{
  "href": "http://tauri.localhost/",
  "origin": "http://tauri.localhost",
  "packagedProtocol": true,
  "hasMain": true,
  "skipLink": "跳到主要内容",
  "version": "0.3.0",
  "repoCount": 1,
  "repoError": null,
  "healthScanned": 1,
  "healthError": null,
  "consoleErrors": []
}
```

- 页面确实来自 `tauri.localhost`，不是 Vite 的 localhost:1420。
- `app_version`、`list_repositories`、`repo_health_overview` 都通过 IPC 返回；
  CSP 收紧没有切断 IPC。
- 控制台没有 CSP violation / refused to connect。
- `repoCount = 1` 是本次环境（`DEVHUB_PROJECT_ROOT=.mcpfixtures/container` 与配置/索引
  组合）的实际读数；它不影响“打包 origin 上 IPC 可用”的结论，但说明这**不是**对完整
  项目墙的验收。上一轮 dev 场景也看到同样的 1，原因未进一步归因。

## 4. 边界

- `--debug` 构建，不是 release/签名安装包；`bundle.active = false`，没有可执行的安装器
  可测。签名、SmartScreen 与自动更新仍未验证。
- 只驱动了一个窗口、一次命令集；没有点开新的健康/密钥/许可证对话框。那些 UI 由构建、
  类型检查与单元测试覆盖，不是本场景的验收对象。
- CDP 需要显式 `--remote-debugging-port`；普通用户运行不会开调试端口。这个场景是
  验证工具，不是产品功能。
- 打包构建耗时 10 分 21 秒（D: 盘）；不放进 CI 的每次 push 门禁，按发布前检查运行。
