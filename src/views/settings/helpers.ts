/**
 * Pure helpers for 设置 → 项目目录.
 *
 * Kept in a `.ts` module (not in the `.tsx` view) so the merge/dedupe rules of
 * the 目录 list get unit-tested without mounting React: a regression here would
 * show up as "a directory vanishing from the list" or "the 当前 row sorts below
 * the 附加 rows" — neither of which a screenshot in a review will catch.
 */

/**
 * One row of the merged 项目目录 list (需求3).
 *
 * `kind` is why the path is in the list at all, which is exactly the
 * information the two separate lists used to imply by their section
 * headings — and which the merged list would otherwise have thrown away.
 */
export type DirectoryRow = {
  kind: "current" | "extra" | "recent";
  path: string;
};

export const DIRECTORY_KIND_LABEL: Record<DirectoryRow["kind"], string> = {
  current: "当前",
  extra: "附加",
  recent: "最近",
};

export const DIRECTORY_KIND_HINT: Record<DirectoryRow["kind"], string> = {
  current: "正在使用的主目录。切换主目录后，它会自动变成「最近」。",
  extra: "这些目录里的项目也会显示在项目墙上。",
  recent: "曾经作为主目录用过的路径，最近用过的排在前面。",
};

/**
 * The merged 项目目录 rows, in display order.
 *
 * 比较一律忽略大小写：Windows 上 `c:\work` 与 `C:\work` 是同一个目录，分开
 * 显示等于凭空多出一行。
 *
 * 登记顺序即同 kind 内的显示顺序：主目录置顶，附加目录在前，历史按
 * recent_roots 自带的新旧次序在后。三个 kind 是分三段登记的，所以最后按 rank
 * 排一次——否则一个「附加」会排到它后面才登记的主目录之前。
 *
 * `inputs.recent` is `settings?.recentRoots ?? []` at the call site: the rows
 * exist even before the first settings load.
 */
export function directoryRowsOf(inputs: {
  current: string;
  extra: string[];
  recent: string[];
}): DirectoryRow[] {
  const rank: Record<DirectoryRow["kind"], number> = { current: 0, extra: 1, recent: 2 };
  // key 是小写化路径（用于判重），value 保留用户实际写过的那份大小写。
  const byKey = new Map<string, DirectoryRow>();
  const add = (path: string, kind: DirectoryRow["kind"]) => {
    const trimmed = path.trim();
    const key = trimmed.toLowerCase();
    if (!key) return;
    const prev = byKey.get(key);
    if (prev && rank[prev.kind] <= rank[kind]) return;
    byKey.set(key, { kind, path: trimmed });
  };
  add(inputs.current, "current");
  for (const p of inputs.extra) add(p, "extra");
  for (const p of inputs.recent) add(p, "recent");
  // Map 保持插入序，rank 排序只把三段归位，同段内的先后不变。
  return [...byKey.values()].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * A number field's value, clamped into the range its row declares.
 *
 * Auto-save means whatever sits in the field at commit time becomes the
 * setting. An empty or half-typed field (`""`, `"-"`, `"9"` on the way to
 * `"90"`) must not reach disk as `NaN` or as an out-of-range value that only
 * fails later inside a parallel-download loop. `fallback` is used when the
 * text is not a number at all.
 */
export function clampInt(text: string, min: number, max: number, fallback: number): number {
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
