import { invoke } from "@tauri-apps/api/core";
import { confirmDestructive } from "./confirm";
import { t } from "./i18n";
import { messageOf } from "./report-error";
import { toast } from "../store/toast";

/**
 * 清空全部操作记录的完整路径：确认对话框 → 清空命令 → 结果提示。
 *
 * 记录页与设置页各有一个「清空」入口，此前各自复制了同一段对话框文案与
 * try/catch——改一处漏一处。这个 helper 是那两处的唯一来源；返回值告诉调用
 * 方记录是否真的被清了（记录页要接着 reload，设置页不用）。
 */
export async function confirmAndClearActivity(): Promise<boolean> {
  // The native dialog rather than window.confirm: a webview confirm is
  // easy to dismiss without reading, and this one deletes a file.
  const ok = await confirmDestructive(t("activity.clearConfirm"), {
    title: t("activity.clearTitle"),
    okLabel: t("activity.clearOk"),
  });
  if (!ok) return false;
  try {
    await invoke("clear_activity");
    toast.success(t("activity.cleared"));
    return true;
  } catch (e) {
    toast.error(t("activity.clearFailed", { msg: messageOf(e) }));
    return false;
  }
}
