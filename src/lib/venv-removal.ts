import { formatBytes } from "./format";
import type { VenvState } from "../types";

export type { VenvState };

/**
 * The two pure decisions behind 项目设置 → Python 与虚拟环境.
 *
 * Both live here rather than inside `RepoPythonPanel` for the reason that has
 * pushed every non-trivial branch out of this app's views all round: a `.tsx`
 * cannot be asserted on from `node --test`, and these two are exactly the kind
 * of branching a UI change breaks silently.
 */

/** Mirrors `launch::VenvRemoval` (camelCase on both sides, serde `rename_all`). */
export type VenvRemovalMode = "toBin" | "destroy" | "forgetRecord";

/** Mirrors `launch::VenvReport`. */
export interface VenvReport {
  hadVenv: boolean;
  removedVenv: boolean;
  /** The pointer was dropped from the marker without deleting a directory. */
  recordOnly: boolean;
  freedBytes: number;
  toBin: boolean;
  path: string | null;
  failed: string[];
}

/**
 * One honest sentence about what a removal did, plus the tone to show it in.
 */
export function venvRemovalLine(r: VenvReport): {
  tone: "ok" | "warn";
  text: string;
} {
  if (r.failed.length > 0) {
    return { tone: "warn", text: `删除虚拟环境未完成：${r.failed.join("；")}` };
  }
  if (r.removedVenv) {
    const freed = r.freedBytes > 0 ? `，释放 ${formatBytes(r.freedBytes)}` : "";
    return {
      tone: "ok",
      text: r.toBin
        ? `虚拟环境已移入回收站${freed}。还原由 Windows 负责；要让这个仓库重新用上环境，点「检查 / 重建」。`
        : `虚拟环境已彻底删除${freed}。已安装的包不会回来，点「检查 / 重建」会新建一个空环境。`,
    };
  }
  if (r.recordOnly) {
    return {
      tone: "ok",
      text: r.hadVenv
        ? `已停止跟踪 ${r.path ?? "该目录"}。目录还在原处，本应用不会删除自己没创建的环境。`
        : "已清除记录里的虚拟环境路径——磁盘上本来就没有那个目录。",
    };
  }
  return { tone: "ok", text: "这个仓库本来就没有记录或留下虚拟环境目录，无需清理。" };
}

/**
 * The line under the 虚拟环境 row, chosen from what is on disk rather than from
 * what the marker was last told.
 *
 * `where` is the *expected* location (`项目\venvs\<repo>_<owner>`), which the panel
 * could not name before: the hint used to print a path only when the marker had
 * one, so 「尚未创建」 pointed at nothing and the user had to know the rule.
 */
export function venvStateHint(state: VenvState, recorded: string | null, where: string | null): string {
  const shown = recorded ?? where;
  switch (state) {
    case "ready":
      return `已就绪：${shown ?? ""}`;
    case "missing":
      return `记录指向 ${recorded ?? ""}，但那个目录已经不在了——多半被移动或手动删过。先「清除记录」，再重建。`;
    case "notAVenv":
      return `记录指向 ${recorded ?? ""}，但那个目录现在不是一个虚拟环境（只建了一半，或内容被换过）。先「清除记录」，再重建。`;
    case "unrecorded":
      return `磁盘上有 ${where ?? ""}，是一条虚拟环境，但这条记录没有指向它。点「重新记录 / 重建」会把它写回记录。`;
    case "staleDir":
      return `${where ?? ""} 这个目录已经存在，但它不是虚拟环境。「重建」会直接往里面写（python -m venv 不清空已有内容），确认那是残留的话可以先「彻底删除」再建。`;
    case "nothing":
      return `尚未创建。位置是 ${where ?? "项目\\venvs\\<repo>_<owner>"}，在仓库之外，所以同名仓库不会互相踩。`;
  }
}

/** Whether the delete row has anything to offer at all. */
export function venvHasSomethingToClean(state: VenvState): boolean {
  return state !== "nothing";
}

/**
 * The verb the create button should use.
 *
 * `create_repo_venv` is one call for all of these: it runs `python -m venv` at the
 * expected path and then writes the path into the marker, so it creates, re-points
 * an unrecorded environment, and rebuilds a broken one alike. The panel's old title
 * claimed the backend "目录已存在但不是虚拟环境时拒绝覆盖" — re-read against
 * `launch::create_venv` it does no such thing (it only checks `pyvenv.cfg`
 * afterwards), which is why `staleDir` says plainly what will happen instead.
 */
export function venvCreateLabel(state: VenvState): string {
  switch (state) {
    case "ready":
      return "检查 / 重建";
    case "unrecorded":
      return "重新记录";
    case "staleDir":
      return "重建";
    case "missing":
    case "notAVenv":
      return "重建";
    case "nothing":
      return "创建虚拟环境";
  }
}

/**
 * Whether 彻底删除 needs the typed confirmation.
 *
 * The record-only cases (`missing`, `notAVenv`, `unrecorded`) destroy nothing, so
 * asking the user to retype the slug for them would train them to retype it without
 * reading — which is the one thing that makes a real typed confirmation fail.
 */
export function venvDestroyIsIrreversible(state: VenvState): boolean {
  return state === "ready" || state === "staleDir";
}
