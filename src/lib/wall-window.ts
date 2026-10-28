/**
 * Windowed rendering for the 项目墙 (r20-O1-1).
 *
 * The wall mounted every matched card at once: `ProjectsView.tsx` called
 * `list.map(...)` straight into `SortableContext`, so a container with 200
 * repositories put 200 `RepoTile` trees — each with a dnd-kit sortable
 * registration, its own tooltip text and its own gradient — on the main thread
 * during the first paint. Cover images were already deferred
 * (`src/lib/use-in-view.ts`, commit `9f472a4`), which is precisely why the rest
 * of the card still cost something.
 *
 * This is a cap with growth, not a virtualizer. A windowed list would need the
 * grid to stop being one CSS grid (dnd-kit's `rectSortingStrategy` measures real
 * siblings), and rewriting drag-reorder for a placeholder track is a much larger
 * change than the 项目墙 needs. Cards past the cap are simply not mounted;
 * scrolling near the end mounts the next step.
 */

/** Cards rendered before the user scrolls. Sized to cover a 1080p screen at
 * `standard` density with the next row already in hand. */
export const WALL_WINDOW_STEP = 48;

/** The smallest cap the window will ever use — a filter that leaves three cards
 * must not wait for a scroll to show them. */
export const WALL_WINDOW_MIN = WALL_WINDOW_STEP;

/**
 * The cap after one more window, clamped to the list length so the sentinel can
 * stop observing. Never shrinks here: shrinking on every keystroke in the filter
 * box is what makes a filtered wall flicker.
 */
export function growWindow(current: number, total: number, step = WALL_WINDOW_STEP): number {
  if (total <= 0) return 0;
  // NaN means a caller lost the number somewhere; the honest reading is "no window
  // yet", so start at one step rather than at zero cards.
  if (Number.isNaN(current) || current <= 0) return Math.min(step, total);
  // +Infinity is the "everything is already mounted" state — keep it there instead
  // of snapping back to one step and blanking the bottom of the wall.
  if (!Number.isFinite(current) || current >= total) return total;
  return Math.min(current + step, total);
}

/**
 * The cap to apply when the list changed underneath an existing cap.
 *
 * Two cases the filter box hits in the same second: the list got shorter than the
 * cap (then the cap must come down to the list length, or `slice` silently shows
 * everything and the observer never stops), and the list got longer (then the cap
 * stays, so a 显示 48 张 wall that becomes 200 cards still paints 48).
 */
export function fitWindow(cap: number, total: number): number {
  if (total <= 0) return 0;
  const floor = Math.min(WALL_WINDOW_MIN, total);
  return Math.max(floor, Math.min(cap, total));
}

/**
 * Slice grouped walls against one shared budget (r20-O1-1).
 *
 * 按负责人分组 renders one `SortableContext` per owner, and a per-group cap would
 * let a wall of forty one-card owners mount 40 × 48 = 1 920 tiles. The budget is
 * the whole wall's, consumed in render order, so a grouped wall costs exactly the
 * same as a flat one. Group headers are kept for every group that still has cards
 * in the window — a group that is entirely past the cap disappears, which is what
 * "not rendered yet" has to look like or the count in the header would lie.
 */
export function windowGroups<T,>(
  groups: [string, T[]][],
  budget: number,
): [string, T[]][] {
  let left = Math.max(0, budget);
  const out: [string, T[]][] = [];
  for (const [name, items] of groups) {
    if (left <= 0) break;
    const take = Math.min(left, items.length);
    out.push([name, items.slice(0, take)]);
    left -= take;
  }
  return out;
}
