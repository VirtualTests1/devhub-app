import type { Freshness } from "../types";
import { t } from "./i18n";

/**
 * The honest half of 有新提交: what one `repo_freshness` answer may be said to mean.
 *
 * ## Why the wall has no per-tile badge, and this file exists instead
 *
 * The natural third step after 更新 was a badge on every card. It was rejected,
 * on evidence, not on taste:
 *
 *   - One `repo_freshness` call is one `git ls-remote` subprocess plus one TLS
 *     session to the remote (`downloader.rs:2023`, reached from `lib.rs:1444`), and
 *     `Downloader::new` resolves git per call. A badge driven off the wall paints
 *     N network round trips per wall load.
 *   - The backend cache is real but narrower than "the wall is covered": a static
 *     per-slug map with a five-minute TTL, read by `freshness_cached`
 *     (`lib.rs:1330`) and written only at the end of a completed call
 *     (`freshness_store`, `lib.rs:1342`). It is keyed per slug, has no size cap and
 *     no warm-up. Round-17 O1 added the eviction this paragraph used to complain
 *     was missing — `update_repo` now drops the slug it just changed
 *     (`lib.rs:1259`) — and a batch command (`repo_freshness_many`, `lib.rs:1521`)
 *     that answers many slugs in one IPC. So the first load after a restart still
 *     has no cached answer for *any* tile; the difference is that one 检查更新 can
 *     now fill several of them in a single round of work instead of one IPC each.
 *
 * A badge that is absent on first paint and quietly stale afterwards is the fake
 * badge this app already refused once for 有启动命令 / 已下载 (`ProjectsView.tsx:77-91`:
 * "Left out instead of guessed"). So there is no badge. What is shipped instead is
 * the cheapest affordance that can be defended: **one explicit 检查更新 over the
 * visible/filtered set**, with bounded concurrency, a hard cap, and a per-repository
 * summary that labels each answer with its own age.
 *
 * ## The word 落后 is not available
 *
 * `lib.rs:1342` computes the state as `local == remote ? "fresh" : "behind"`. A
 * repository whose local HEAD is *ahead* of the remote, and one that has diverged,
 * and one whose local hash could not be read at all, all land in `behind`. So
 * `state` is only ever "the two HEADs differ", and the copy says that. Printing
 * 落后于远程 would be a direction claim the payload does not support — and it would
 * invite exactly the update that `--ff-only` is designed to refuse.
 */

export type FreshnessTone = "same" | "diff" | "warn";

export type FreshnessVerdict = {
  tone: FreshnessTone;
  /** The claim the payload supports, and nothing more. */
  text: string;
  /** The evidence: the two HEADs, or the reason there is no answer. */
  detail: string;
};

/**
 * One answer, in the only words that are true for all five states.
 *
 * `unknown` never degrades to 已是最新 — the panel this feeds exists because a
 * badge that lies about being current is worse than no badge, since the user
 * cancels the update they needed.
 */
export function freshnessVerdict(f: Freshness): FreshnessVerdict {
  const short = (h: string | null) =>
    h ? h.slice(0, 7) : t("freshness.headUnreadable");
  switch (f.state) {
    case "fresh":
      return {
        tone: "same",
        text: t("freshness.sameText"),
        detail: t("freshness.sameDetail", { head: short(f.localHead) }),
      };
    case "behind":
      return {
        tone: "diff",
        text: t("freshness.diffText"),
        detail: t("freshness.diffDetail", {
          local: short(f.localHead),
          remote: short(f.remoteHead),
        }),
      };
    case "no-git":
      return {
        tone: "warn",
        text: t("freshness.noGit"),
        detail: f.error ?? t("freshness.noGitDetail"),
      };
    case "missing":
      return {
        tone: "warn",
        text: t("freshness.missing"),
        detail: f.error ?? t("freshness.missingDetail"),
      };
    case "unknown":
      return {
        tone: "warn",
        text: t("freshness.unknown"),
        detail: f.error ?? t("freshness.unknownDetail"),
      };
    default:
      // An unrecognised state is reported as what it is. Mapping it to a tone
      // would invent a meaning the backend never sent.
      return {
        tone: "warn",
        text: t("freshness.unknown"),
        detail: t("freshness.unrecognised", { state: f.state }),
      };
  }
}

/**
 * The row for a slug the batch call did **not reach**.
 *
 * `repo_freshness_many` answers cached hits and a bounded number of fresh misses
 * in one IPC; a slug past that budget comes back with no answer at all
 * (`freshness: null`). That is neither 「无新提交」 nor 「与远程一致」 — this module
 * exists precisely because a verdict that lies about being current is worse than
 * no verdict — so the row says what happened and nothing more.
 */
export function notReachedVerdict(): FreshnessVerdict {
  return {
    tone: "warn",
    text: t("freshness.notReached"),
    detail: t("freshness.notReachedDetail"),
  };
}

/**
 * The row for a slug whose check itself failed (no such directory on disk, a
 * task panic). It is a per-repository answer, not a dead scan — one broken card
 * must not erase the others — and it reads as 无法确认 with the backend's own
 * reason, never as an absence of new commits.
 */
export function errorVerdict(detail: string): FreshnessVerdict {
  return { tone: "warn", text: "无法确认", detail };
}

/** Hard ceiling on one 检查更新. See `uncheckedNote` for what it costs the claim. */
export const FRESHNESS_CAP = 30;

/** Simultaneous `git ls-remote` processes. Three is "useful", not "hammering". */
export const FRESHNESS_WIDTH = 3;

/** What a scan will touch, and what it will not. */
export function planFreshnessScan(
  slugs: readonly string[],
  cap: number = FRESHNESS_CAP,
): { willCheck: string[]; skipped: string[] } {
  const width = Math.max(0, Math.floor(cap));
  return { willCheck: slugs.slice(0, width), skipped: slugs.slice(width) };
}

export type ScanTotals = { total: number; same: number; diff: number; warn: number };

/** The counts behind the summary line. Split out because the line is a claim. */
export function summarizeScan(rows: readonly { tone: FreshnessTone }[]): ScanTotals {
  let same = 0;
  let diff = 0;
  let warn = 0;
  for (const r of rows) {
    if (r.tone === "same") same += 1;
    else if (r.tone === "diff") diff += 1;
    else warn += 1;
  }
  return { total: rows.length, same, diff, warn };
}

/** `一致 12 · 不一致 3 · 无法确认 2` — in the toolbar's `tabular-nums` tradition. */
export function scanSummaryLine(t: ScanTotals): string {
  return `一致 ${t.same} · 不一致 ${t.diff} · 无法确认 ${t.warn}`;
}

/**
 * The sentence that keeps the summary honest when the cap bit.
 *
 * Without it, "一致 30" over a 48-card filter reads as "these 48 are current" — the
 * kind of claim the file's own header comment refuses to make.
 */
export function uncheckedNote(skipped: number): string | null {
  if (skipped <= 0) return null;
  return `另有 ${skipped} 个项目本次未检查（单次上限 ${FRESHNESS_CAP} 个）：请先用搜索或筛选缩小范围，再查一次。`;
}
