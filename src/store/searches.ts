import { create } from "zustand";

/**
 * Saved GitHub searches (round 11, 批量与运维).
 *
 * The add view already keeps a *history* of landing directories (`landing.ts`) and
 * the search box re-runs whatever you type, but a query that took three tries to
 * phrase — `language:rust http client topic:http-server` — was gone as soon as you
 * navigated away, and the 记录 page does not remember searches. This is the explicit
 * half of that: the user pins a query, and it comes back with its sort order,
 * because "星标最多" is part of the question, not an incidental setting.
 *
 * Deliberately NOT the same list as `recentRoots` or the landing history: those
 * answer "where did I put things", this answers "what do I keep looking for".
 */

const KEY = "devhub.searches.v1";
const CAP = 12;
/** Longer than any useful GitHub search string; a longer value is junk or an attack. */
const MAX_QUERY = 200;

/**
 * The sort ids the search UI offers (`AddRepoView.tsx` SEARCH_SORTS) and the
 * backend forwards (`search.rs:215` passes them through to `?sort=`). A value
 * outside this set is dropped on read rather than sent to the API: a corrupt or
 * hand-edited entry must not become an unrequested query variation.
 */
export const KNOWN_SORTS: readonly string[] = ["", "stars", "updated", "forks"];

export type SavedSearch = { q: string; sort: string };

/**
 * Validate one entry from disk. Returns `null` instead of coercing: a half-shaped
 * object would render a row that throws when clicked.
 */
export function normalizeSearch(value: unknown): SavedSearch | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { q?: unknown; sort?: unknown };
  if (typeof raw.q !== "string") return null;
  const q = raw.q.trim();
  if (q.length < 2 || q.length > MAX_QUERY) return null;
  const sort = typeof raw.sort === "string" && KNOWN_SORTS.includes(raw.sort) ? raw.sort : "";
  return { q, sort };
}

function read(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: SavedSearch[] = [];
    for (const item of parsed) {
      const s = normalizeSearch(item);
      if (!s) continue;
      // Case-insensitive on the query, exact on the sort: GitHub search is
      // case-insensitive for repo names, and two entries that differ only by
      // capitalization are one entry the user has to clean up by hand.
      const key = `${s.q.toLowerCase()}|${s.sort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= CAP) break;
    }
    return out;
  } catch {
    return [];
  }
}

function persist(items: SavedSearch[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage full or private mode: the list stays in memory for this session.
  }
}

type SearchesState = {
  items: SavedSearch[];
  /** Pin a query; re-saving an existing one moves it to the front. */
  save: (entry: SavedSearch) => void;
  remove: (index: number) => void;
  clear: () => void;
};

export const useSavedSearches = create<SearchesState>((set, get) => ({
  items: read(),

  save: (entry) => {
    const normalized = normalizeSearch(entry);
    if (!normalized) return;
    const key = `${normalized.q.toLowerCase()}|${normalized.sort}`;
    const next = [
      normalized,
      ...get().items.filter((s) => `${s.q.toLowerCase()}|${s.sort}` !== key),
    ].slice(0, CAP);
    set({ items: next });
    persist(next);
  },

  remove: (index) => {
    const next = get().items.filter((_, i) => i !== index);
    set({ items: next });
    persist(next);
  },

  clear: () => {
    set({ items: [] });
    persist([]);
  },
}));
