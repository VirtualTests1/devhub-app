import { create } from "zustand";

/**
 * 项目墙的多选状态（需求 9.1）.
 *
 * ## Why this is not in `wall.ts`
 *
 * `wall.ts` persists: its prefs and per-repository states are *preferences* about
 * how this device arranges the wall, and they have to survive a restart. A
 * selection is none of that — it is "the twelve cards I am pointing at right now",
 * and restoring that on the next launch would mean the first plain click after a
 * restart silently acts on cards chosen in a session that already ended. So this
 * store never touches `localStorage`, and the two kinds of fact stay separable.
 *
 * ## Why it is a store and not `useState` in the view
 *
 * The selection has to outlive the wall's own re-renders (filter, sort, grouping)
 * and be readable from the floating bar without threading props through it. It also
 * has to be clearable from anywhere by Escape. `ProjectsView` is already ~900 lines;
 * a batch operation that cannot see which cards are chosen is the alternative.
 *
 * ## What a selection survives, and what it deliberately does not
 *
 * Slugs that leave the wall (hidden, deleted, filtered out) stay selected: a batch
 * acting on exactly what was chosen is safer than a batch silently shrinking under
 * the user's hand. `prune()` is what the view calls when the action has run.
 */

type SelectionState = {
  /** 多选 mode, toggled by the header control. */
  mode: boolean;
  /** Chosen slugs, in the order they were chosen. */
  slugs: string[];
  /** The last card clicked alone - one end of a Ctrl/Shift range. */
  anchor: string | null;
  enter: () => void;
  exit: () => void;
  toggle: (slug: string) => void;
  /** Shift: add the visible block between the anchor and `slug`. */
  extendTo: (order: string[], slug: string) => void;
  selectAll: (slugs: string[]) => void;
  clear: () => void;
  /** Drops selections that are no longer valid (deleted, hidden, gone from disk). */
  prune: (stillThere: Set<string>) => void;
};

/**
 * The inclusive block of `order` between `from` and `to`.
 *
 * Exported separately because it is the only arithmetic in this file and the part
 * worth being sure about: an off-by-one here selects one card too many, and the
 * batch then acts on a repository nobody meant to touch.
 */
export function rangeOf(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1);
}

export const useSelection = create<SelectionState>((set, get) => ({
  mode: false,
  slugs: [],
  anchor: null,

  enter: () => set((s) => (s.mode ? s : { mode: true })),

  // 退出多选 discards the set: the next 多选 is a new intent, not a continuation of
  // a batch that was already run (or aborted) in the previous one.
  exit: () => set({ mode: false, slugs: [], anchor: null }),

  toggle: (slug) =>
    set((s) => {
      const has = s.slugs.includes(slug);
      return {
        mode: true,
        slugs: has ? s.slugs.filter((x) => x !== slug) : [...s.slugs, slug],
        anchor: slug,
      };
    }),

  extendTo: (order, slug) => {
    const s = get();
    // Without an anchor there is no range to extend - a Shift-click on a fresh wall
    // behaves like the first click of a range, not like a no-op.
    if (!s.anchor || !s.slugs.length) {
      set({ mode: true, slugs: [slug], anchor: slug });
      return;
    }
    const block = rangeOf(order, s.anchor, slug);
    if (!block.length) {
      set({ slugs: [...s.slugs, slug], anchor: slug });
      return;
    }
    set({
      mode: true,
      slugs: [...s.slugs, ...block.filter((x) => !s.slugs.includes(x))],
      anchor: slug,
    });
  },

  selectAll: (slugs) =>
    set((s) => {
      const next = [...s.slugs];
      for (const x of slugs) if (!next.includes(x)) next.push(x);
      return { mode: true, slugs: next, anchor: s.anchor ?? slugs[0] ?? null };
    }),

  clear: () => set({ slugs: [], anchor: null }),

  prune: (stillThere) =>
    set((s) => {
      const next = s.slugs.filter((x) => stillThere.has(x));
      if (next.length === s.slugs.length) return s;
      return {
        slugs: next,
        anchor: next.includes(s.anchor ?? "") ? s.anchor : null,
      };
    }),
}));
