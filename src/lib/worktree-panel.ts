import { worktreeContentBits, worktreeWarningLine } from "./worktree-warning";
import type { WorktreeInfo, WorktreeList, WorktreeRemoveReport } from "../types";

/**
 * The decisions behind 项目设置 → 工作树（第十六轮方向 N1-2）.
 *
 * Same reason every other non-trivial branch in this app was pulled out of its
 * view: a `.tsx` cannot be asserted on from `node --test`, and the branches here
 * are the ones that decide whether a 删除 button is offered at all.
 */

/**
 * The placement rule, mirrored from `gitwt::worktree_dir_name`.
 *
 * Mirrored rather than fetched because the panel shows the path *before* the
 * create button is pressed — a preview that came from the backend would need a
 * round trip per keystroke. The two sides are pinned by the same three fixtures in
 * `tests/worktree-panel.test.ts` and in `gitwt.rs`'s own test, so the mirror cannot
 * quietly drift the way `trash_repo`'s inline copy of this rule did until round 16.
 */
export function worktreeDirName(slug: string, tail: string): string {
  const flat = (s: string) => s.trim().replace(/[\\/]/g, "__");
  return `${flat(slug)}__${flat(tail)}`;
}

/** Where the next worktree of this slug will land, for the panel to name up front. */
export function worktreePlacement(
  container: string,
  slug: string,
  branch: string,
  subdir: string,
): string {
  const tail = subdir.trim() || branch.trim();
  if (!tail) return "";
  const sep = container.includes("\\") ? "\\" : "/";
  return `${container.replace(/[\\/]+$/, "")}${sep}${worktreeDirName(slug, tail)}`;
}

/** The name a row is identified by, in the order the user reads the list. */
export function worktreeLabel(w: WorktreeInfo): string {
  if (w.bare) return "裸仓库（不是工作树）";
  if (w.branch) return w.branch;
  // A detached tree has no branch to name it; the sha is not optional information,
  // it is the whole identity, and `git worktree list` hands it over for a reason.
  if (w.head) return `分离头指针 ${w.head.slice(0, 8)}`;
  if (w.detached) return "分离头指针（没有提交）";
  return "（git 没有说它在哪个分支上）";
}

/** Why this row cannot be deleted by this app, or `null` when it can. */
export function worktreeDeleteRefusal(w: WorktreeInfo): string | null {
  if (w.isMain) {
    return "这是仓库本身，不是挂出来的工作树；要连它一起删除请用项目墙上的「删除项目」";
  }
  if (w.locked) return "git 把这个工作树锁住了（git worktree unlock 之后才能删）";
  if (!w.exists) return "目录已经不在了，这里只会清掉 git 的登记";
  if (!w.managed) {
    return "这个工作树不在项目的 _worktrees 目录里，本应用不删自己没放在那里的东西";
  }
  return null;
}

/**
 * The short line under one row: what is uncommitted *in this tree*.
 *
 * Built from `worktreeContentBits` — the same three phrases the delete
 * confirmation uses — and never from a reworded copy of them. An all-clean tree
 * says nothing, exactly like `worktreeWarningLine`: silence belongs to clean and
 * only to clean. A tree git would not answer for says that, because
 * "问不到" must not read as "干净" (`types.ts` states the rule, this is a place
 * that obeys it).
 */
export function worktreeRowNote(w: WorktreeInfo): string {
  const st = w.status;
  if (!w.exists) return w.prunable ? "登记还在，目录已经不在了" : "目录已经不在了";
  if (!st || !st.hasGit) return "问不到这个目录的 git 状态";
  // The whole-default payload `launch::worktree_status` returns when git refused:
  // same test `worktreeWarningLine` applies for the same reason.
  if (st.branch === null && st.ahead === null && st.dirty === 0 && st.untracked === 0) {
    return "问不到这个目录的 git 状态：可能不在 PATH，或仓库已损坏";
  }
  const bits = worktreeContentBits(st);
  return bits.length ? `未提交内容：${bits.join(" · ")}` : "";
}

/**
 * The paragraph the delete confirmation shows.
 *
 * Delegates to `worktreeWarningLine` with `permanent = true` and does not restate
 * it: `git worktree remove` deletes with git's own `rm -rf`, so a worktree removal
 * *is* the irreversible case that flag exists for.
 */
export function worktreeConfirmLine(w: WorktreeInfo): string {
  if (!w.status) return "";
  return worktreeWarningLine({ ok: true, status: w.status }, true).trim();
}

/** One honest sentence about what a removal did, plus the tone to show it in. */
export function worktreeRemovalLine(r: WorktreeRemoveReport): { tone: "ok" | "warn"; text: string } {
  if (r.failed.length > 0) {
    const dirty = r.failed.some((f) => f.includes("--force"));
    return {
      tone: "warn",
      text: dirty
        ? `工作树里有还没提交或还没跟踪的文件，git 拒绝删除它。勾上「强制」才会连这些一起删——那是不进回收站的删除。`
        : `删除工作树未完成：${r.failed.join("；")}`,
    };
  }
  if (r.removed) {
    return {
      tone: "ok",
      text: r.force
        ? `已删除 ${r.path}（用了 --force：里面未提交的内容是 git 直接删掉的，不进回收站，无从找回）。`
        : `已删除 ${r.path}。分支${r.branch ? ` ${r.branch} ` : "（分离头指针）"}仍然留在仓库里，需要时可以再挂出来。`,
    };
  }
  if (r.pruned > 0) {
    return {
      tone: "ok",
      text: `没有目录可删，清掉了 ${r.pruned} 条指向不存在位置的 git 登记。${r.note ?? ""}`,
    };
  }
  return { tone: "ok", text: `没有任何东西被删除，git 也没有拒绝：${r.path} 本来就没什么可清理的。` };
}

/**
 * What an empty list means, because three different facts share the shape `[]`.
 *
 * `hasGit: false` is not "没有工作树" (it is "这个目录没有版本控制"), and `error` is
 * neither (it is "问了，git 没答") — the distinction the backend's `WorktreeList`
 * was shaped for in the first place, and the reason this is a function rather than
 * one string in the component.
 */
export function worktreeEmptyLine(list: WorktreeList): string {
  if (!list.hasGit) {
    return "这个目录没有 git 历史（多半是压缩包下载或手工复制的），没有仓库可以挂工作树。";
  }
  if (list.error) return `问不到工作树列表：${list.error}`;
  return `还没有工作树。这个仓库目前只有一个目录；新建后会落在 ${list.container}。`;
}

/**
 * Whether the create field has anything sendable.
 *
 * Only the branch is required: the sub-directory name is an optional override, and
 * `gitwt::preview_path` derives one from the branch when it is empty. Requiring it
 * here would block a create that has nothing wrong with it.
 */
export function worktreeCanCreate(branch: string): boolean {
  return branch.trim().length > 0;
}
