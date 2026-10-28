import { FONT_SCALES } from "../store/appearance";

/**
 * Rail geometry — the navigation rail's widths in px.
 *
 * The rail is sized in multiples of the root font size, because that is what the
 * rest of the chrome is sized in: at the default 16 px root the three multiples
 * below resolve to the 52 / 148 / 340 px the rail was measured at, and a 20-22 px
 * 界面字号 does not leave the collapsed rail narrower than its own icons.
 *
 * The root those multiples resolve against is `uiFontPx` — exactly the value
 * `applyAppearance` writes to `documentElement.style.fontSize`. `shell/Sidebar.tsx`
 * used to read it back with `getComputedStyle` *during render*, which cost a forced
 * layout on every render of the rail and, worse, went stale: the shell applies
 * appearance through an imperative subscription and does not re-render for it, so
 * changing 界面字号 left the collapsed width and both drag clamps on the previous
 * font's px until something else happened to re-render the rail. The rail now
 * subscribes to `uiFontPx` and calls `railWidths`, so the geometry follows the root
 * font size on the same tick the setting does.
 *
 * A `.ts` module rather than a couple of lines inside the rail because this is the
 * one piece of the shell's layout that is arithmetic with a fallback rule worth
 * pinning, and the Node test layer cannot import a `.tsx` (DEVELOPMENT.md §8.1).
 */

/** Collapsed width, minimum drag width and maximum drag width, in rem. */
export const RAIL_REM = { collapsed: 3.25, min: 9.25, max: 21.25 } as const;

/**
 * The 标准 档位's root size — the same number as the store's `DEFAULTS.uiFontPx`,
 * taken from the 档位 table rather than written out again so the two cannot drift.
 */
const STANDARD_ROOT_PX = FONT_SCALES.find((s) => s.id === "md")?.rootPx ?? 16;

/**
 * What a 界面字号 value resolves to in px.
 *
 * Junk (a value that never passed the store's 12-22 check, or nothing at all from a
 * test that mounts the rail without a store) falls back to the standard size rather
 * than to `NaN`, which would make the rail unmeasurable and the drag clamps useless.
 */
export function rootFontPx(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : STANDARD_ROOT_PX;
}

/** The rail's three widths for one root font size, rounded to whole pixels. */
export function railWidths(value: unknown): {
  collapsed: number;
  min: number;
  max: number;
} {
  const px = rootFontPx(value);
  return {
    collapsed: Math.round(RAIL_REM.collapsed * px),
    min: Math.round(RAIL_REM.min * px),
    max: Math.round(RAIL_REM.max * px),
  };
}
