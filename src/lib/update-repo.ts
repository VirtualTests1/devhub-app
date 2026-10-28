import { LAYER_LABEL, type UpdateOutcome } from "../types";
import { messageOf } from "./report-error";

/**
 * The wall's 更新 (`git pull --ff-only`) — one per-slug call, one wording.
 *
 * ## Why a `.ts` helper instead of a closure in `ProjectsView.tsx`
 *
 * Two surfaces need the *same* verb: the card menu (one repository) and 批量更新
 * (the selection). A per-tile arrow function in the view would have been written
 * twice within one screenful of code, which is the exact shape `tests/single-source.test.ts`
 * was created to catch. What is here has no React, no `invoke` and no JSX: the
 * command arrives as a one-argument function, so Node can drive the whole thing
 * with a fake (`tests/update-repo.test.ts`) and the view keeps the three lines
 * that actually touch state.
 *
 * ## Why `--ff-only` is the product boundary, in code
 *
 * `downloader.rs:2920-2933` states it: a fast-forward is the only update that
 * cannot surprise the user, so a diverged branch or a dirty tree is *reported*
 * with git's own words and never resolved for them. Nothing here proposes a
 * rebase, a merge, a force or a stash — REQUIREMENTS.md §3.1 keeps diff/merge UI
 * out of the app entirely. The verbs on offer are 更新 (ff-only) and 重新下载.
 *
 * ## The failure text needs surgery, not just a prefix
 *
 * `update_repo` rejects with `DownloadError`'s `Display`, and the ladder's final
 * error is `AllLayersFailed` — whose wording is written for a *download*:
 * `四条下载路径全部失败：` followed by one indented `[失败] <链路> -> <原因>` line
 * per layer (`downloader.rs:383-395`). For a pull that is wrong twice over: an
 * update has three roads, not four (`types.ts:130-133` says so explicitly,
 * because a pull has no clone URL for the mirror layer to rewrite), and a local
 * git refusal repeats itself under every layer because the layers differ only in
 * how they reach the network. Showing that block verbatim in a per-card banner —
 * let alone N times in a batch list — buries the one sentence the user needs.
 * `compactUpdateFailure` folds it back to the distinct causes, once each.
 */

/** The command seam: `ProjectsView` passes a real `invoke`, a test passes a stub. */
export type UpdateInvoker = (slug: string) => Promise<UpdateOutcome>;

/** One repository's answer. `detail` is always user-facing prose, never a stack. */
export type UpdateResult =
  | { ok: true; detail: string; outcome: UpdateOutcome }
  | { ok: false; detail: string; remedy: string | null; retryable: boolean };

/** `  [失败] 直连 -> error: could not lock HEAD` */
const ATTEMPT_LINE = /^\[(成功|失败)\]\s+(.+?)\s*->\s*(.+)$/;

/** `四条下载路径全部失败：` — the header `AllLayersFailed` prints before its rows. */
const FAILURE_HEADER = /^\S{0,8}全部失败[：:]$/;

/** The outcome in one line, in the words `RepoSyncPanel.tsx:317-334` already uses.
 *
 * Two honesty rules carried over from that panel, because they are the part a
 * caller gets wrong under time pressure:
 *   - `commits === null` is *not* `0`. git could not count them (a shallow or
 *     grafted history), so the sentence says so instead of claiming 新增 0 个提交.
 *   - `viaThirdParty` is an anomaly for an update and gets printed, not dropped.
 */
export function describeUpdateOutcome(o: UpdateOutcome): string {
  const layer = LAYER_LABEL[o.layer] ?? o.layer;
  let text: string;
  if (o.before === o.after) {
    text = `已是最新（HEAD ${o.after || "未知"}，链路 ${layer}）`;
  } else {
    text = `已快进 ${o.before || "?"} → ${o.after || "?"}`;
    if (o.commits !== null) text += `，新增 ${o.commits} 个提交`;
    text += `（链路 ${layer}）`;
    if (o.commits === null) {
      text += "；git 数不出提交数（浅克隆或被改写过历史），所以不报「0 个新提交」";
    }
  }
  if (o.viaThirdParty) text += "；代码经由第三方镜像传输（更新出现这一条即为异常）";
  // A batch row is one line, so show the first few subjects rather than a count
  // the user already has. The full list belongs to the single-repo panel.
  if (o.recent?.length) {
    const shown = o.recent
      .slice(-3)
      .map((c) => `${c.hash} ${c.subject}`)
      .join("；");
    text += `；新提交：${shown}${o.recent.length > 3 ? ` 等 ${o.recent.length} 个` : ""}`;
  }
  return text;
}

/**
 * The backend's failure sentence, reduced to what the user can act on.
 *
 * Single-line rejections (`IO 错误: …`, `找不到 git。…`, `未找到仓库: …`) are
 * returned untouched — the backend's own words are the best copy available, and
 * `report-error.ts` already rules that re-wording here is how "which layer said
 * that?" starts. Only the `AllLayersFailed` block is folded, and it is folded
 * rather than deleted: the layer names stay when they differ, because "直连和
 * 本地代理都试过了，第三方镜像被禁用" is information.
 */
export function compactUpdateFailure(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  const attempts: { label: string; detail: string }[] = [];
  const strays: string[] = [];
  let sawHeader = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (FAILURE_HEADER.test(t)) {
      sawHeader = true;
      continue;
    }
    const m = ATTEMPT_LINE.exec(t);
    if (m) {
      // Only the refusals are causes. A `[成功]` row inside a rejected call is the
      // marker write-back note (`downloader.rs:3075-3086`: the pull worked and
      // `lastPull` did not persist) — real information, but not a failed road, and
      // counting it would corrupt the "N 条链路同一原因" arithmetic below.
      if (m[1] === "失败") attempts.push({ label: m[2] ?? "", detail: m[3] ?? "" });
      else strays.push(m[3] ?? "");
      continue;
    }
    strays.push(t);
  }
  if (!sawHeader && !attempts.length) return text;

  const parts: string[] = [];
  if (strays.length) parts.push(strays.join(" "));
  // Same cause under every layer — a dirty tree or a diverged branch is refused
  // locally, before the network is even tried — so print it once.
  const byCause = new Map<string, string[]>();
  for (const a of attempts) {
    const labels = byCause.get(a.detail);
    if (labels) labels.push(a.label);
    else byCause.set(a.detail, [a.label]);
  }
  for (const [cause, labels] of byCause) {
    if (labels.length === attempts.length && labels.length > 1) {
      parts.push(`${cause}（${labels.length} 条链路同一原因）`);
    } else {
      parts.push(`${labels.join("、")}：${cause}`);
    }
  }
  return parts.join("；") || text;
}

/**
 * Whether 重试 can plausibly change the answer, and what else the user must do.
 *
 * The split is by *cause*, not by error type, because the backend collapses
 * everything into one `String`. A network timeout, a hung `git`, and git's own
 * refusal to ff-only over a dirty tree are all worth another press: the first
 * depends on the line, the other two depend on something the user can fix in
 * between. A repository with no git history, no recorded remote, no git binary
 * or no directory at all is not worth a retry button — pressing it would print
 * the identical sentence, which is how a retry affordance becomes noise. Those
 * get a different next step instead, and that step is the point of `remedy`.
 */
export function classifyUpdateFailure(raw: string): {
  detail: string;
  remedy: string | null;
  retryable: boolean;
} {
  const detail = compactUpdateFailure(raw);
  const dead: [RegExp, string][] = [
    [/没有 git 历史|无 git 历史/, "压缩包下载的仓库没有历史，只能重新下载一次（左侧「添加」）。"],
    [/找不到远程地址/, "这个目录既没有 .devhub.json 的 URL，也没有 git remote，先把远程补上再更新。"],
    [/找不到 git/, "这台机器上找不到 git：安装它（winget install Git.Git），或让内置 runtime\\git 可用。"],
    [/未找到仓库/, "磁盘上已经找不到这个目录，先在 设置 → 项目 里恢复项目墙。"],
    [/仓库不存在或没有访问权限/, "远程仓库不存在或已设为私有，更新不会改变这一点。"],
  ];
  for (const [re, remedy] of dead) {
    if (re.test(detail)) return { detail, remedy, retryable: false };
  }
  const retryRemedy: [RegExp, string][] = [
    [/would be overwritten|local changes|unstaged|未提交/, "git 为了不覆盖本地修改而拒绝：先在别处提交或 stash，再回来重试。"],
    [/fast-forward|分叉|non-fast-forward/, "分支已经分叉，ff-only 不会替你合并：这需要有意识地处理，重试不会绕过它。"],
    [/超过 \d+ 秒|timed out|timeout|无法连接|connect|reset|TLS|early EOF/i, "远程没有答上来，稍后重试即可（结果不落盘，所以不会重复下载）。"],
  ];
  for (const [re, remedy] of retryRemedy) {
    if (re.test(detail)) return { detail, remedy, retryable: true };
  }
  return { detail, remedy: null, retryable: true };
}

/**
 * A failure as one line, remedy folded in — the shape a 批量更新 row has room for.
 *
 * The card's own banner prints `detail` and `remedy` on two lines, because it has
 * the width. `BatchBar` renders one row per repository in a scrolling list, so the
 * cause and the next step have to survive being concatenated: a batch that names
 * twelve refusals but never says *what to do about them* is a list of bad news.
 */
export function updateFailureLine(r: { detail: string; remedy: string | null }): string {
  return r.remedy ? `${r.detail}；${r.remedy}` : r.detail;
}

/**
 * The one call the wall makes for 更新.
 *
 * It never rejects: a batch of nine must keep going when two of them refuse, and
 * the card menu must show the refusal instead of swallowing it. The failure is
 * routed through `messageOf` like every other surface in this app — never
 * `String(e)` — then compacted and classified, so both callers read the same
 * sentence.
 */
export async function updateOneRepo(slug: string, call: UpdateInvoker): Promise<UpdateResult> {
  try {
    const outcome = await call(slug);
    return { ok: true, detail: describeUpdateOutcome(outcome), outcome };
  } catch (err) {
    const f = classifyUpdateFailure(messageOf(err));
    return { ok: false, ...f };
  }
}
