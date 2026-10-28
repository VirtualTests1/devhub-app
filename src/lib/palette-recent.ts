/**
 * Palette recency: the last few commands you actually ran (r24-N1-3).
 *
 * The palette already ranks by the query. Recency is not a relevance signal, so
 * it must not outrank one: the boost here is a tie-breaker (≤ 0.06 against fused
 * scores in the 0–1 range), and it is applied only after the text has matched.
 * With no query, recency *is* the ordering — the default slice is a shelf, and a
 * shelf whose first row is what you used last is the point.
 *
 * Storage is `localStorage` under its own versioned key, same local-preference
 * convention as the shortcut bindings and the wall. A corrupt value degrades to
 * "no recents": an unreadable preference must not stop Ctrl+K from opening.
 *
 * No React, no i18n: pure module so the ranking rule is testable under Node.
 */

export const PALETTE_RECENT_KEY = "devhub.palette.recent.v1";

/** Six is one screenful of the default slice; older ids fall off silently. */
export const PALETTE_RECENT_MAX = 6;

/** The storage shape this module needs; `localStorage` satisfies it. */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(storage?: RecentStorage): RecentStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Parse a stored value; anything that is not an array of non-empty strings is empty. */
export function parseRecent(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= PALETTE_RECENT_MAX) break;
  }
  return out;
}

export function readRecent(storage?: RecentStorage): string[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    return parseRecent(s.getItem(PALETTE_RECENT_KEY));
  } catch {
    return [];
  }
}

/** Move `id` to the front, dedupe, cap, and persist. Returns the new list. */
export function pushRecent(id: string, storage?: RecentStorage): string[] {
  const clean = id.trim();
  const current = readRecent(storage);
  if (!clean) return current;
  const next = [clean, ...current.filter((x) => x !== clean)].slice(0, PALETTE_RECENT_MAX);
  const s = resolveStorage(storage);
  if (s) {
    try {
      s.setItem(PALETTE_RECENT_KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode: the session keeps its order, the shelf resets next launch */
    }
  }
  return next;
}

/**
 * Tie-break bonus for one command id: 0.06 for the newest, −0.01 per position,
 * 0 when absent. Value-level tests pin the ordering, not a magic constant's fate.
 */
export function recentBoost(id: string, ids: readonly string[]): number {
  const at = ids.indexOf(id);
  if (at < 0 || at >= PALETTE_RECENT_MAX) return 0;
  return Math.max(0.01, 0.06 - at * 0.01);
}

/**
 * Order rows by recency for the no-query shelf; unknown rows keep their original
 * relative order after the known ones (stable).
 */
export function rankByRecent<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: ids.indexOf(row.id) }))
    .sort((a, b) => {
      const ar = a.rank < 0 ? Number.POSITIVE_INFINITY : a.rank;
      const br = b.rank < 0 ? Number.POSITIVE_INFINITY : b.rank;
      return ar - br || a.index - b.index;
    })
    .map((x) => x.row);
}
