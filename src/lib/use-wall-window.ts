/**
 * The scroll half of the 项目墙 window (r20-O1-1), kept apart from
 * `src/lib/wall-window.ts` because that file has to stay React-free —
 * `tests/lib-import-graph.test.ts` loads every `src/lib/**` module without a
 * renderer, and a pure window rule must be drivable from a test.
 */
import { useEffect, useRef, useState } from "react";

import { WALL_WINDOW_STEP, fitWindow, growWindow } from "./wall-window";

/**
 * Returns `{ cap, shown, sentinelRef }` for a list of `total` cards.
 *
 * `sentinelRef` goes on an empty element after the last rendered card. When it
 * reaches the viewport the cap takes one step; nothing ever shrinks the cap on
 * scroll, because un-mounting cards behind the user makes dnd-kit measure a list
 * that changed underneath a live drag.
 *
 * `dragging` lifts the cap for the duration of the drag: a card that is not
 * mounted cannot become a drag target, and rendering the rest for one gesture buys
 * back the whole class of "my card vanished when I started dragging".
 */
export function useWallWindow(total: number, dragging: boolean) {
  const [cap, setCap] = useState(WALL_WINDOW_STEP);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // The list shrinks under an existing cap all the time — a filter box, a 批量删除.
  // Clamped in an effect rather than during render so the cap the observer reads and
  // the cap `slice` used in the same paint cannot disagree.
  useEffect(() => {
    setCap((c) => fitWindow(c, total));
  }, [total]);

  const closed = dragging || cap >= total;

  useEffect(() => {
    if (closed) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setCap((c) => growWindow(c, total));
      },
      // One row early: a sentinel that only fires once it is itself on screen shows
      // an empty gap first, which reads as a stall — the exact thing this is for.
      { rootMargin: "240px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [closed, total]);

  return { cap, shown: dragging ? total : Math.min(cap, total), sentinelRef };
}
