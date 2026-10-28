import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, Link2, TriangleAlert } from "lucide-react";

import { ActionRow, SettingsGroup } from "../../components/SettingsRows";
import { registerProtocol } from "../../lib/deeplink-register";
import { useI18n } from "../../lib/useI18n";

/**
 * 设置 → 注册 `devhub://` 协议 (r21 N3-1)。
 *
 * 这一行补的是 Deep Link 链条上唯一没有入口的一环：后端
 * `src-tauri/src/deeplink.rs` 的 `register_deeplink` 早就注册在
 * `generate_handler!` 里，但没有前端调用者（`scripts/check-commands.mjs` 的
 * allowlist 里那条 `R19-N3` 备注就是这个意思），浏览器里的 `devhub://owner/repo`
 * 因此只有在注册表已被别处写过时才会落到本程序。
 *
 * ## 三态，以及各自要说什么
 *
 *   - **未尝试**：进页面时的初始态。不写「未注册」——命令没跑过，我们不知道结果，
 *     说「未注册」是拿「没试过」冒充「查过」。
 *   - **成功**：显示后端返回的原话（`已注册 devhub:// → <exe 路径>`），因为那句话
 *     里带着它到底把哪个 exe 写进了注册表，是用户复核需要的信息。
 *   - **失败**：后端错误串**原样**显示（`messageOf` 只取理由不改措辞），下面给
 *     可执行的替代做法——手动写入同样三处注册表键，并写明安装包注册不可用
 *     （REQUIREMENTS §3.5 / §6：MSI/NSIS 按需求不做，所以那条路不存在，不能暗示）。
 *
 * 权限语义按代码事实说：`register_windows_protocol` 写的是
 * `HKEY_CURRENT_USER`（`reg add HKCU\…`），实现上不需要管理员权限
 * （`deeplink.rs:86-89`、`:147`）。模块头 `deeplink.rs:6` 曾写「当前进程提升
 * 权限后执行」，与函数文档不一致，r21 N3-3 已改齐——沿革记在 `docs/deeplink.md`。
 */

/**
 * `register_windows_protocol` 实际写下的三处（`src-tauri/src/deeplink.rs`
 * 的三段 `reg add`），逐条照抄成 ASCII 两列，失败态里原样展示。
 *
 * 纯 ASCII 是故意的：这是要被用户粘进 PowerShell 的东西，中文化它等于改命令；
 * 组件里因此没有一个中文字面量（`tests/zh-hardcode-ratchet.test.ts` 数得着）。
 */
export const DEEPLINK_REGISTRY_SHAPE = [
  "HKCU\\Software\\Classes\\devhub                    (Default) = URL:DevHub Protocol",
  "HKCU\\Software\\Classes\\devhub                    URL Protocol = (empty)",
  'HKCU\\Software\\Classes\\devhub\\shell\\open\\command  (Default) = "<devhub.exe>" "%1"',
].join("\n");

/** 注册的四种界面状态。判定与文案的接线在下面的 JSX 里，这里只是形状。 */
export type RegisterState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "fail"; error: string };

export function DeepLinkSection() {
  const { t } = useI18n();
  const [state, setState] = useState<RegisterState>({ kind: "idle" });

  async function run() {
    setState({ kind: "busy" });
    const result = await registerProtocol(invoke);
    setState(
      result.ok
        ? { kind: "ok", message: result.message }
        : { kind: "fail", error: result.error },
    );
  }

  return (
    <SettingsGroup title={t("settings.page.deeplinkGroupTitle")} regId="settings-group-deeplink">
      <ActionRow
        icon={<Link2 className="h-4 w-4" />}
        title={t("settings.page.deeplinkRowTitle")}
        hint={t("settings.page.deeplinkRowHint")}
        actionLabel={
          state.kind === "busy" ? t("settings.page.deeplinkBusy") : t("settings.page.deeplinkRegister")
        }
        disabled={state.kind === "busy"}
        secondary
        onAction={() => void run()}
      />
      {state.kind === "idle" && (
        <div className="flex items-start gap-2 px-2.5 py-2 text-caption text-muted-foreground">
          <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
          <span>{t("settings.page.deeplinkIdle")}</span>
        </div>
      )}
      {state.kind === "ok" && (
        <div className="flex items-start gap-2 px-2.5 py-2 text-caption text-success">
          <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t("settings.page.deeplinkOk")}{" "}
            <code className="break-all font-mono">{state.message}</code>
          </span>
        </div>
      )}
      {state.kind === "fail" && (
        <div className="flex items-start gap-2 px-2.5 py-2 text-caption text-danger">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="m-0 break-words">{t("settings.page.deeplinkFailed", { error: state.error })}</p>
            <p className="m-0 text-muted-foreground">{t("settings.page.deeplinkManualHint")}</p>
            <pre className="m-0 overflow-x-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-caption text-muted-foreground">
              {DEEPLINK_REGISTRY_SHAPE}
            </pre>
            <p className="m-0 text-muted-foreground">{t("settings.page.deeplinkNoInstaller")}</p>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
