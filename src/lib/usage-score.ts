/**
 * The 常用 page's ranking arithmetic, as pure functions (r17-o2-3).
 *
 * The formula and the two ranking passes used to live in `views/FrequentView.tsx`
 * — the `score` helper at `:1103-1106` and the two memos at `:151-193`. That file
 * is a `.tsx`, so none of it was reachable from the Node test runner, and the part
 * worth pinning is exactly the part that is arithmetic rather than rendering:
 *
 *   - **the decay is per *day*, not per use.** One use today beats five last
 *     month, which is the whole sentence 常用 is meant to answer.
 *   - **`Math.max(0, …)` is the guard** for a `last` in the future (a clock skew,
 *     an imported file): without it the denominator goes below 1 and a stale
 *     entry outranks a fresh one.
 *   - **a zero-count row is still a row.** The caller filters on the key prefix,
 *     never on the score, so an entry that has been counted down to 0 is not
 *     silently dropped from 设置 ranking.
 *
 * The day-granularity clock itself (`usageScoreDay`) is part of this module: the
 * ranking memo has to be pinned to one instant per pass or two cards get ranked
 * against two different clocks (`FrequentView.tsx:1096-1101`).
 */

/** `{ count, last }` as stored by `store/customize.ts`'s usage table. */
export type UsageEntry = { count: number; last: number };

/**
 * Recency-weighted count: used once today beats used five times last month.
 *
 * `nowMs` comes in rather than being read here, so one derivation cannot straddle
 * a millisecond — or a day — boundary.
 */
export function usageScore(u: UsageEntry, nowMs: number): number {
  const daysAgo = Math.max(0, (nowMs - u.last) / 86_400_000);
  return u.count / (1 + daysAgo);
}

/** The day-granularity clock the ranking memo is pinned to (`FrequentView`'s `scoreDay`). */
export function usageScoreDay(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

/**
 * `repo:<slug>` rows → `slug → score`, in the usage table's own key order.
 *
 * A `Map` rather than a sorted list: the caller (最近使用) sorts, drops the pinned
 * slugs and slices, and a stable `Array.sort` over this insertion order is what
 * keeps two equal scores from trading places between renders.
 */
export function repoScoreBySlug(
  usage: Record<string, UsageEntry>,
  nowMs: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [key, entry] of Object.entries(usage)) {
    if (key.startsWith("repo:")) scores.set(key.slice(5), usageScore(entry, nowMs));
  }
  return scores;
}

/** The most-used 设置 rows, highest hit count first, capped at `limit`. */
export function topSettingUsage(
  usage: Record<string, UsageEntry>,
  limit: number,
): { key: string; hits: number }[] {
  return Object.entries(usage)
    .filter(([key]) => key.startsWith("setting:"))
    .map(([key, entry]) => ({ key: key.slice("setting:".length), hits: entry.count }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
}
