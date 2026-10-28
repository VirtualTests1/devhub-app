/**
 * 记录页的统计纯函数（r19-N1-1）。
 *
 * 「洞察」是三条可以被无声改坏的性质，每条钉性质而不是钉一张快照：
 *
 *   - **按天用的是本地日**，不是 UTC 日。`toISOString()` 会把东半球的凌晨算成
 *     前一天，面板上的「今天」于是和用户过的那天错开——统计越准越可疑。
 *   - **并列名次是定死的**：次数相同按标识的码点序，不用 `localeCompare`
 *     （同一份数据在不同语言环境的机器上必须排出同一个顺序，参考
 *     `lib/bm25.ts` 同分钉码点的先例）。
 *   - **没有 slug 的条目不进仓库榜**：记录可以来自没有项目的界面（设置、外观），
 *     把它们算成一个空壳仓库是编造证据。
 *
 * 与 `records-derive.ts` 的分工：那边管「哪些行看得见」（筛选），这边管
 * 「这些行说了什么」（汇总）。两边都不碰分组——分组键来自
 * `views/records/format.ts`，留在视图里。
 */

/** The fields the stats read. A structural subset of `ActivityEntry`. */
export type StatsEntry = {
  /** Unix **seconds** — the unit `ActivityEntry.ts` is written in. */
  ts: number;
  tag: string;
  slug?: string;
};

/** One local day's tally. */
export type DayCount = { day: string; count: number };

/** One 类别's tally. */
export type TagCount = { tag: string; count: number };

/** One repository's tally. */
export type RepoCount = { slug: string; count: number };

/**
 * Local calendar day key for a unix-seconds timestamp: `YYYY-MM-DD` in the
 * runtime's zone.
 *
 * Zero-padded on purpose: the day list is sorted as plain strings, and
 * `2026-3-5` would sort before `2026-12-1`.
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Per-local-day counts, oldest day first. Days without entries do not appear —
 * a quiet week is a gap in the bars, not a row of zeroes the panel has to skip.
 */
export function entriesByDay(entries: readonly StatsEntry[]): DayCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = localDayKey(e.ts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rankByCount(counts)
    .map(({ key, count }) => ({ day: key, count }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Per-tag counts, busiest first; ties by tag code point. */
export function entriesByTag(entries: readonly StatsEntry[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
  return rankByCount(counts).map(({ key, count }) => ({ tag: key, count }));
}

/**
 * The `limit` most frequent slugs, busiest first; ties by slug code point.
 *
 * Entries with no slug are skipped — a record from 设置 / 外观 has no repository,
 * and inventing an empty-shell repo would be fabricated evidence. `limit <= 0`
 * means "I want zero rows", the same reading `lib/bm25.ts` gives `limit: 0`.
 */
export function topRepos(entries: readonly StatsEntry[], limit: number): RepoCount[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.slug) continue;
    counts.set(e.slug, (counts.get(e.slug) ?? 0) + 1);
  }
  return rankByCount(counts)
    .slice(0, Math.max(0, limit))
    .map(({ key, count }) => ({ slug: key, count }));
}

/**
 * Count desc, then key code-point asc.
 *
 * Code point rather than `localeCompare`: a collator's order is a machine
 * setting, and two builds of this list disagreeing per locale is a list no test
 * on another box can reproduce (the bm25 tie-break pins the same rule).
 */
function rankByCount(counts: Map<string, number>): { key: string; count: number }[] {
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
