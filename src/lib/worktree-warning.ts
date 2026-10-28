import type { WorktreeStatus } from "../types";
import { messageOf } from "./report-error";

/**
 * The working-tree line a delete confirmation shows, in one testable place.
 *
 * Why a `.ts` helper instead of an inline expression in `ProjectsView.tsx`
 * (round 12, 让失败可见 8.3): the line is the only thing between a confirmation
 * dialog and an irreversible delete, and `ProjectsView.tsx` is the hottest file
 * in the app. Pinning the wording here gives the rule a test while the view
 * keeps a six-line hunk.
 *
 * The reported defect: the `catch` around `repo_worktree_status` was bare, so
 * `statusLine` stayed empty and "问不到 git" rendered the identical confirmation
 * as "工作树干净". `types.ts:193` already states the rule for the payload ("git
 * refusing to answer must read as 无法确认, never as 干净") — nothing enforced it
 * at the surface that shows it.
 *
 * Re-verifying the surrounding fifteen lines found the same confusion in three
 * more places, all of them now handled here:
 *   - `hasGit: false` degrades to an all-default payload, so a repository with NO
 *     version control read as clean too. (`launch.rs:781` returns the default
 *     `WorktreeStatus` before it ever looks at the tree.)
 *   - When `find_git` fails, `worktree_status` returns `hasGit: true` with every
 *     other field still default — "git is not even installed" read as clean.
 *   - And the opposite error: a *clean* repository on a named branch used to
 *     print "工作树还有未提交内容：分支 main", because the branch was one of the
 *     bits. Silence belongs to clean and only to clean.
 */

/** The result of asking `repo_worktree_status`, failure included. */
export type WorktreeProbe =
  | { ok: true; status: WorktreeStatus }
  | { ok: false; reason: unknown };

/**
 * The "could not check" sentence.
 *
 * `why` is what the probe lost — the backend's own words when the command
 * rejected, a named cause when the payload itself answered nothing. The
 * permanent tail is the point of the whole function: on 永久删除 there is no
 * recycle bin and no 回退, so an unknown tree must be read as a risky one.
 */
function unknownLine(why: string, permanent: boolean): string {
  return (
    `\n\n⚠ 未能检查工作树状态（${why}）：无法确认有没有未提交的修改，请当作可能有。` +
    `${permanent ? "永久删除后这些内容也无法通过 git 找回。" : ""}`
  );
}

/**
 * The bits a dirty tree is made of, in the order the user acts on them.
 *
 * Exported (round 16, N1-2) because the 工作树 panel needs the *same* three words on
 * each row — "3 个未提交修改" — and the alternative to sharing this list is a second
 * copy of the wording, which is exactly the drift `types.ts:193` and the header of
 * this file exist to prevent. The sentence stays here; a caller that only wants the
 * counts calls this.
 */
export function worktreeContentBits(st: WorktreeStatus): string[] {
  return [
    st.dirty ? `${st.dirty} 个未提交修改` : null,
    st.untracked ? `${st.untracked} 个未跟踪文件` : null,
    st.ahead ? `${st.ahead} 个提交尚未推送到上游` : null,
  ].filter((b): b is string => b !== null);
}

/**
 * The whole line, or "" when there is genuinely nothing to warn about.
 *
 * `permanent` is the difference between 回收站 (the files come back, and 记录 can
 * 回退 the entry) and 永久删除. The no-git case is only surfaced for the
 * irreversible verb: a git-less directory sent to the Recycle Bin still comes
 * back, while one deleted for good has no second source at all — the same thing
 * the 启动面板's typed confirmation says (`launch/CleanupSection.tsx:207-211`).
 */
export function worktreeWarningLine(probe: WorktreeProbe, permanent: boolean): string {
  if (!probe.ok) return unknownLine(messageOf(probe.reason), permanent);
  const st = probe.status;
  if (!st.hasGit) {
    return permanent
      ? "\n\n⚠ 这个目录没有 git 历史（压缩包下载或手工复制），删除后无从恢复任何版本。"
      : "";
  }
  const bits = worktreeContentBits(st);
  if (bits.length === 0) {
    // Nothing to report — but a git-backed repository that cannot even name its
    // branch has not said it is clean, it has said nothing. `ahead === null`
    // here covers the whole-default payload `launch.rs` returns when `find_git`
    // fails; a clean tree with a readable branch is the only silent case.
    if (st.branch === null && st.ahead === null) {
      return unknownLine("git 没有回答：可能不在 PATH，或仓库已损坏", permanent);
    }
    return "";
  }
  const where = st.branch ? `（分支 ${st.branch}）` : "";
  return `\n\n⚠ 工作树里有还没提交或还没推送的内容${where}：${bits.join(" · ")}。删除后无法通过 git 找回。`;
}
