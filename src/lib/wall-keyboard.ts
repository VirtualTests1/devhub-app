/**
 * Arrow-key movement across the project wall (r24-N4-1).
 *
 * The wall is a CSS grid whose column count depends on the window and the chosen
 * density, so "next card" cannot be `index + 1` or `index + columns`: it has to
 * come from the cards' real rectangles. This module does the geometry and nothing
 * else — the view owns focus and the DOM.
 *
 * Movement is clamped, not wrapped. On a forty-card wall, ArrowLeft at the first
 * column jumping to the previous row's last card is disorienting; Home/End exist
 * for the two ends. This matches `nextActive` in the grep list (clamped) rather
 * than the command palette's menu-style wrap.
 *
 * No DOM types beyond a structural rect, so tests can drive a synthetic 3×3 grid.
 */

export type CardRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type WallNavKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function isWallNavKey(key: string): key is WallNavKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

const center = (r: CardRect) => ({
  x: (r.left + r.right) / 2,
  y: (r.top + r.bottom) / 2,
});

/**
 * The index the arrow should land on, or `current` when there is nothing in that
 * direction.
 *
 * Candidate score: primary axis distance + 3× the cross-axis distance. The weight
 * is what keeps ArrowRight inside the same row even when a card two rows down is
 * horizontally closer; cards whose vertical bands overlap get a bonus through the
 * smaller cross distance. Ties fall to the earlier index for determinism.
 */
export function nextCardIndex(
  rects: readonly CardRect[],
  current: number,
  key: WallNavKey,
): number {
  if (rects.length === 0) return -1;
  if (current < 0 || current >= rects.length) return current;
  if (key === "Home") return 0;
  if (key === "End") return rects.length - 1;

  const from = rects[current];
  if (!from) return current;
  const c = center(from);
  let bestAt = current;
  let best = Number.POSITIVE_INFINITY;

  for (let i = 0; i < rects.length; i += 1) {
    if (i === current) continue;
    const rect = rects[i];
    if (!rect) continue;
    const p = center(rect);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let primary: number;
    let cross: number;
    if (key === "ArrowRight") {
      if (dx <= 0) continue;
      primary = dx;
      cross = Math.abs(dy);
    } else if (key === "ArrowLeft") {
      if (dx >= 0) continue;
      primary = -dx;
      cross = Math.abs(dy);
    } else if (key === "ArrowDown") {
      if (dy <= 0) continue;
      primary = dy;
      cross = Math.abs(dx);
    } else {
      if (dy >= 0) continue;
      primary = -dy;
      cross = Math.abs(dx);
    }
    const score = primary + cross * 3;
    if (score < best) {
      best = score;
      bestAt = i;
    }
  }
  return bestAt;
}
