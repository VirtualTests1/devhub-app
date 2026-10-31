import { ask as askDialog } from "@tauri-apps/plugin-dialog";
import { t } from "./i18n";

/**
 * A single, consistent confirmation for *destructive* actions.
 *
 * Every destructive confirm in the app is a `warning` dialog with a 取消 cancel
 * label; only the message, title and ok label differ. Centralizing that means a
 * future change (a shared icon, a stricter default button, an a11y tweak) is one
 * edit, not a dozen drifting `askDialog({ kind: "warning" })` call sites.
 *
 * Non-destructive / informational confirms (开启开发者模式, 应用模版, 移除常用项,
 * and RecordsView's conditional delete/restore/download) stay on raw `askDialog`
 * because their `kind` is not a fixed `warning`.
 */
export async function confirmDestructive(
  message: string,
  opts: { title: string; okLabel: string },
): Promise<boolean> {
  return askDialog(message, {
    title: opts.title,
    kind: "warning",
    okLabel: opts.okLabel,
    cancelLabel: t("iface.cancel"),
  });
}
