import { create } from "zustand";

import {
  WALL_VIEW_LIMIT,
  sanitiseCriteria,
  sanitiseViewName,
  sanitiseViews,
  sameViewName,
  type WallView,
  type WallViewCriteria,
} from "../lib/wall-views";

/**
 * The saved-view store.
 *
 * Persistence is limited to the views themselves. `activeId` is "which saved
 * view the current wall still matches" — a session fact, like the search it came
 * from — and `applyRequest` is a one-shot message from the palette to a view that
 * may not be mounted yet. Writing either to disk would make the next launch open
 * a filtered wall nobody asked for.
 *
 * `createWallViewsStore` takes its storage so tests can use a Map, the same seam
 * `lib/download-recovery` uses. The live singleton is built over localStorage.
 */

export const WALL_VIEWS_KEY = "devhub.wall.views.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export type SaveViewResult =
  | { ok: true; view: WallView }
  | { ok: false; reason: "empty" | "duplicate" | "full" };

export type WallViewsState = {
  views: WallView[];
  /** The saved view the wall is currently showing, or null after a manual edit. */
  activeId: string | null;
  /** A pending request from the palette; `seq` makes consuming it race-free. */
  applyRequest: { id: string; seq: number } | null;
  save: (name: string, criteria: WallViewCriteria) => SaveViewResult;
  rename: (id: string, name: string) => SaveViewResult;
  remove: (id: string) => void;
  /** Ask the wall to adopt this view; ProjectsView consumes it on its next render. */
  requestApply: (id: string) => void;
  /** Clear the request only if it is still the one that was consumed. */
  consume: (seq: number) => void;
  /** A manual filter/sort edit no longer matches any named view. */
  clearActive: () => void;
  /**
   * Replace the saved list with an imported one (r31-N1). Used by the wall
   * export/import flow; an empty array is a real "this export had no views"
   * statement and clears the list.
   */
  replaceViews: (views: readonly WallView[]) => void;
};

function readStored(storage: StorageLike | null): WallView[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(WALL_VIEWS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const rows =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { views?: unknown }).views
        : parsed;
    return sanitiseViews(rows);
  } catch {
    return [];
  }
}

function writeStored(storage: StorageLike | null, views: WallView[]) {
  if (!storage) return;
  try {
    storage.setItem(WALL_VIEWS_KEY, JSON.stringify({ version: 1, views }));
  } catch {
    /* quota/private mode: the session keeps its views, the next launch does not */
  }
}

export function createWallViewsStore(storage: StorageLike | null = resolveStorage()) {
  let seq = 0;
  return create<WallViewsState>((set, get) => ({
    views: readStored(storage),
    activeId: null,
    applyRequest: null,

    save: (name, criteria) => {
      const clean = sanitiseViewName(name);
      if (!clean) return { ok: false, reason: "empty" };
      const views = get().views;
      if (views.length >= WALL_VIEW_LIMIT) return { ok: false, reason: "full" };
      if (views.some((v) => sameViewName(v.name, clean))) return { ok: false, reason: "duplicate" };
      const view: WallView = {
        id: `wv-${Date.now().toString(36)}-${(seq++).toString(36)}`,
        name: clean,
        ...sanitiseCriteria(criteria),
      };
      const next = [...views, view];
      set({ views: next, activeId: view.id });
      writeStored(storage, next);
      return { ok: true, view };
    },

    rename: (id, name) => {
      const clean = sanitiseViewName(name);
      if (!clean) return { ok: false, reason: "empty" };
      const views = get().views;
      if (!views.some((v) => v.id === id)) return { ok: false, reason: "empty" };
      if (views.some((v) => v.id !== id && sameViewName(v.name, clean))) {
        return { ok: false, reason: "duplicate" };
      }
      const next = views.map((v) => (v.id === id ? { ...v, name: clean } : v));
      set({ views: next });
      writeStored(storage, next);
      const renamed = next.find((v) => v.id === id);
      return renamed ? { ok: true, view: renamed } : { ok: false, reason: "empty" };
    },

    remove: (id) => {
      const next = get().views.filter((v) => v.id !== id);
      if (next.length === get().views.length) return;
      set((s) => ({
        views: next,
        activeId: s.activeId === id ? null : s.activeId,
        applyRequest: s.applyRequest?.id === id ? null : s.applyRequest,
      }));
      writeStored(storage, next);
    },

    requestApply: (id) => {
      if (!get().views.some((v) => v.id === id)) return;
      seq += 1;
      set({ applyRequest: { id, seq } });
    },

    consume: (requestSeq) => {
      if (get().applyRequest?.seq !== requestSeq) return;
      set({ applyRequest: null });
    },

    clearActive: () => {
      if (get().activeId !== null) set({ activeId: null });
    },

    replaceViews: (views) => {
      const next = sanitiseViews(views);
      set({ views: next, activeId: null, applyRequest: null });
      writeStored(storage, next);
    },
  }));
}

export const useWallViews = createWallViewsStore();
