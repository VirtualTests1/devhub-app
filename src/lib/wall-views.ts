/**
 * Saved wall views: a name for one combination of search, facets, tags, filter
 * and sort (r30-N1).
 *
 * ## Why this is a separate module from the view
 *
 * `ProjectsView.tsx` is a `.tsx`, and the Node test runner cannot strip types
 * from JSX. Every rule that decides "what a valid saved view is" would therefore
 * be unreachable from a test if it lived beside the toolbar. The coercion below
 * is the whole contract: untrusted localStorage, an imported wall, or a future
 * version can hand this module junk, and the answer must be a bounded, valid list
 * rather than a throw or a view whose sort id no longer exists.
 *
 * ## What a view is, and what it deliberately is not
 *
 * It stores *criteria*, never results: a wall view is a question ("Rust projects
 * I tagged backend"), and the cards that answer it change as repositories are
 * added or removed. It also does not store a card order — that is already the
 * wall's own hand-dragged overlay, and duplicating a snapshot of it here would
 * make applying a view silently rearrange the wall.
 *
 * `query`, the two facets and the tag chips are otherwise session state (the view
 * is explicit about that for search and tags); a saved view is the one way a
 * person can say "this combination is worth keeping".
 */
import {
  FILTERS,
  SORTS,
  sanitiseTags,
  type FilterId,
  type SortId,
} from "../store/wall";

/** More than a screenful of views is a menu nobody scans. */
export const WALL_VIEW_LIMIT = 12;
export const WALL_VIEW_NAME_MAX = 40;
export const WALL_VIEW_QUERY_MAX = 200;
/** Facet ids come from metadata; an over-long one is not a language name. */
export const WALL_VIEW_FACET_MAX = 60;

export type WallViewCriteria = {
  /** Trimmed search text; empty means "no search". */
  query: string;
  /** Empty means 全部. */
  language: string;
  /** Empty means 全部. */
  category: string;
  /** Canonical tag spellings, already deduplicated by the wall's rules. */
  tags: string[];
  sort: SortId;
  filter: FilterId;
};

export type WallView = WallViewCriteria & {
  id: string;
  name: string;
};

/** The criteria the wall starts with, and the shape every reader normalises to. */
export const EMPTY_VIEW_CRITERIA: WallViewCriteria = {
  query: "",
  language: "",
  category: "",
  tags: [],
  sort: "name",
  filter: "all",
};

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const one = value.trim();
  return one.length > max ? one.slice(0, max) : one;
}

function sortOf(value: unknown): SortId {
  return SORTS.some((s) => s.id === value) ? (value as SortId) : "name";
}

function filterOf(value: unknown): FilterId {
  return FILTERS.some((f) => f.id === value) ? (value as FilterId) : "all";
}

/** Whether a name is usable; names are the only user-authored label a view has. */
export function sanitiseViewName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > WALL_VIEW_NAME_MAX ? one.slice(0, WALL_VIEW_NAME_MAX) : one;
}

/** Same name, case/space-insensitively — the rule that refuses a duplicate. */
export function sameViewName(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Coerce one untrusted criteria object. Every field has a safe default. */
export function sanitiseCriteria(raw: unknown): WallViewCriteria {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_VIEW_CRITERIA, tags: [] };
  const r = raw as Record<string, unknown>;
  return {
    query: text(r.query, WALL_VIEW_QUERY_MAX),
    language: text(r.language, WALL_VIEW_FACET_MAX),
    category: text(r.category, WALL_VIEW_FACET_MAX),
    tags: sanitiseTags(r.tags) ?? [],
    sort: sortOf(r.sort),
    filter: filterOf(r.filter),
  };
}

/** Coerce one untrusted row, or `null` when it cannot name itself. */
export function sanitiseView(raw: unknown): WallView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id, 80);
  const name = sanitiseViewName(r.name);
  if (!id || !name) return null;
  return { id, name, ...sanitiseCriteria(r) };
}

/** Coerce a stored list: drop junk, deduplicate ids, cap. */
export function sanitiseViews(raw: unknown): WallView[] {
  if (!Array.isArray(raw)) return [];
  const out: WallView[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const view = sanitiseView(row);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    out.push(view);
    if (out.length >= WALL_VIEW_LIMIT) break;
  }
  return out;
}

/** Does this criteria combination actually narrow or reorder the wall? */
export function hasViewCriteria(c: WallViewCriteria): boolean {
  return (
    c.query !== "" ||
    c.language !== "" ||
    c.category !== "" ||
    c.tags.length > 0 ||
    c.filter !== "all" ||
    c.sort !== "name"
  );
}

/** Stable comparison for the "active view" indicator; criteria are already canonical. */
export function sameCriteria(a: WallViewCriteria, b: WallViewCriteria): boolean {
  return (
    a.query === b.query &&
    a.language === b.language &&
    a.category === b.category &&
    a.sort === b.sort &&
    a.filter === b.filter &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i])
  );
}

/** The criteria a view describes, without its identity. */
export function criteriaOf(view: WallView): WallViewCriteria {
  return {
    query: view.query,
    language: view.language,
    category: view.category,
    tags: [...view.tags],
    sort: view.sort,
    filter: view.filter,
  };
}
