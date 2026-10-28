import { invoke } from "@tauri-apps/api/core";
import { confirmDestructive } from "./confirm";
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
  const ok = await confirmDestructive("确定清空全部操作记录？这一步不可撤销，缩短保留时长也会删历史。", {
    title: "清空操作记录",
    okLabel: "清空",
  });
  if (!ok) return false;
  try {
    await invoke("clear_activity");
    toast.success("操作记录已清空");
    return true;
  } catch (e) {
    toast.error(`清空失败：${String(e)}`);
    return false;
  }
}
