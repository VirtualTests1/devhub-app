/**
 * The 记录页's filter pipeline, as pure functions (r17-o2-3).
 *
 * The predicate used to be inline in `views/RecordsView.tsx:180-193` — a `.tsx`,
 * so not reachable by the Node type-stripping runner. This is the largest filter
 * in the app (every entry is scanned, and the search branch lower-cases eight
 * fields per entry), and its rules are the kind a refactor quietly breaks:
 *
 *   - **`全部` is not `0` seconds but "no cutoff at all"**, which is why the
 *     cutoff falls back to `Number.MIN_SAFE_INTEGER` rather than to `now`. A
 *     reversed `secs ? … : 0` would hide every entry older than 1970.
 *   - **`tag` is compared exactly, never case-folded** — the chip ids are a
 *     closed table and the stored tag is whatever that table wrote.
 *   - **the eight-field haystack skips empties** rather than matching a `"null"`
 *     or an empty string against every query.
 *
 * The grouping step (fold by `target`) stays in the view on purpose: its key and
 * label come from `views/records/format.ts`, which is already pure and tested
 * (`groupKeyOf` / `groupLabelOf`), so extracting the four-line `Map` loop here
 * would only move it across a directory boundary for no gain.
 */

/** The fields the filter reads. A structural subset of `ActivityEntry`. */
export type RecordFilterEntry = {
  tag: string;
  ts: number;
  action: string;
  detail?: string;
  slug?: string;
  path?: string;
  source?: string;
  target?: string;
  before?: string;
  after?: string;
};

export type RecordFilterContext = {
  /** The 类别 chip id, or `"all"`. */
  tag: string;
  /** Unix **seconds** floor. Entries older than this are dropped. */
  cutoff: number;
  /** Raw search text; normalised per entry. */
  query: string;
};

/**
 * Unix-seconds cutoff for a 时间范围 row.
 *
 * `seconds === 0` is the 全部 row and means "no bound", so it returns
 * `Number.MIN_SAFE_INTEGER` — not `now`, which would drop the whole history.
 */
export function recordCutoff(seconds: number, nowMs: number): number {
  return seconds ? Math.floor(nowMs / 1000) - seconds : Number.MIN_SAFE_INTEGER;
}

/** Whether one entry survives the current 类别 / 时间范围 / 搜索. */
export function matchRecordEntry(entry: RecordFilterEntry, ctx: RecordFilterContext): boolean {
  if (ctx.tag !== "all" && entry.tag !== ctx.tag) return false;
  if (entry.ts < ctx.cutoff) return false;
  const q = ctx.query.trim().toLowerCase();
  if (!q) return true;
  return [entry.action, entry.detail, entry.slug, entry.path, entry.source, entry.target, entry.before, entry.after]
    .filter((field): field is string => !!field)
    .some((field) => field.toLowerCase().includes(q));
}

/** `matchRecordEntry` over a list, one pass. */
export function filterRecordEntries<T extends RecordFilterEntry>(
  entries: readonly T[],
  ctx: RecordFilterContext,
): T[] {
  return entries.filter((entry) => matchRecordEntry(entry, ctx));
}
