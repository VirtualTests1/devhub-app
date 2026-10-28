/**
 * `devhub://` 协议注册的前端半段（r21 N3-1）。
 *
 * 后端那一半在 `src-tauri/src/deeplink.rs`：`register_deeplink` 取当前 exe 路径，
 * 由 `register_windows_protocol` 写三处 `HKCU\Software\Classes\devhub`（根键默认值、
 * `URL Protocol` 标记、`shell\open\command`），返回 `Result<String, String>`。
 * Tauri 把 `Err(String)` 以**字符串** reject 给前端，所以失败原文就是后端那句话。
 *
 * ## 为什么这层值得单独存在
 *
 *   1. **可测**：`invoke` 是参数而不是模块顶层 import，`tests/deeplink-register-ui.test.ts`
 *      用假的 invoke 驱动成功 / 失败两条路 —— 真正的 `invoke` 要一个 Tauri webview，
 *      Node 里没有。这条纪律与 `src/lib/netdiag.ts`（探针注入）同源。
 *   2. **原样**：失败只过一次 `messageOf`（仓库唯一的错误转文案入口，见
 *      `src/lib/report-error.ts` 的文档），它是**取**理由不是**改**措辞：字符串原样返回。
 *      所以界面上的失败串可以逐字节对上后端，不被翻译成一句「正常」。
 *
 * 本文件不含 React、不含 `.tsx`，因此 `tests/lib-import-graph.test.ts` 覆盖的
 * Node 可加载性自动适用于它。
 */

import { messageOf } from "./report-error";

/** 注入的 invoke：对齐 `@tauri-apps/api/core` 的 `invoke`，本层只用得上 `(cmd) => Promise`。 */
export type InvokeFn = (cmd: string) => Promise<unknown>;

/** 两种结局，外加各自的原文：成功串与失败串都不在这里改写。 */
export type RegisterOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * 跑一次注册，把 IPC 的两条路归一成结局。
 *
 * `invoke` 是参数：调用点（`views/settings/DeepLinkSection.tsx`）传真正的
 * `invoke`，测试传假的。名字必须叫 `invoke` —— check-commands 的正则按
 * `invoke("命令名")` 这个形状找调用者，换成别的名字这条命令就会重新掉进
 * 「注册了没人调用」的 allowlist。
 */
export async function registerProtocol(invoke: InvokeFn): Promise<RegisterOutcome> {
  try {
    // 命令名写字面量而不是常量：`scripts/check-commands.mjs` 按
    // `invoke("命令名")` 的形状找调用者，常量会让它重新看不见这个调用点。
    const message = await invoke("register_deeplink");
    // 成功串是后端自己的话（"已注册 devhub:// → <exe>"），原样交给界面显示。
    return { ok: true, message: typeof message === "string" ? message : String(message) };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}
