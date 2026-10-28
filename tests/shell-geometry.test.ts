/**
 * `src/shell/geometry.ts` — the navigation rail's px widths as a function of
 * 界面字号.
 *
 * These numbers used to be sampled off the document with `getComputedStyle` during
 * render, so they were a forced layout per render *and* stale after a font change
 * (the shell applies appearance through an imperative subscription and does not
 * re-render for it). Deriving them is arithmetic, so arithmetic gets the tests: the
 * three assertions that matter are the px the rail was measured at under the
 * standard font, that every width follows the root font size, and that junk falls
 * back to the standard size instead of to `NaN`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RAIL_REM, railWidths, rootFontPx } from "../src/shell/geometry.ts";

/** The 12-22 px band the store accepts for 界面字号 (`APPEARANCE_VALUE_CHECKS`). */
const LEGAL_FONT_PX = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

test("rootFontPx: a legal 界面字号 is its own px", () => {
  assert.equal(rootFontPx(22), 22);
  assert.equal(rootFontPx(16), 16);
});

test("rootFontPx: junk falls back to the standard size, never to NaN", () => {
  for (const junk of [undefined, null, NaN, 0, -16, "16", Number.POSITIVE_INFINITY, {}]) {
    assert.equal(rootFontPx(junk), 16, `junk ${String(junk)} must resolve to the standard 16px`);
  }
});

test("railWidths: at the standard root the rail is 52 / 148 / 340 px", () => {
  assert.deepEqual(railWidths(16), { collapsed: 52, min: 148, max: 340 });
});

test("railWidths: every width follows the root font size", () => {
  const base = railWidths(16);
  const big = railWidths(22);
  assert.ok(big.collapsed > base.collapsed, "a bigger font must not keep the old collapsed rail");
  assert.ok(big.min > base.min, "the drag clamp has to move with the root too");
  assert.ok(big.max > base.max);
  // rem multiples, rounded — so each one is within a pixel of the exact product.
  assert.equal(big.collapsed, Math.round(RAIL_REM.collapsed * 22));
  assert.equal(big.min, Math.round(RAIL_REM.min * 22));
  assert.equal(big.max, Math.round(RAIL_REM.max * 22));
});

test("railWidths: collapsed < min < max across the whole legal band", () => {
  for (const px of LEGAL_FONT_PX) {
    const rail = railWidths(px);
    assert.ok(
      rail.collapsed < rail.min && rail.min < rail.max,
      `at ${px}px the rail geometry is out of order: ${JSON.stringify(rail)}`,
    );
  }
});

test("railWidths: the collapsed rail is never narrower than its own icons", () => {
  // The icons are 16 px (`h-4 w-4`) inside a button with no horizontal padding when
  // collapsed; a rail below the icon width clips it.
  for (const px of LEGAL_FONT_PX) {
    assert.ok(railWidths(px).collapsed >= 16, `collapsed rail ${railWidths(px).collapsed}px at ${px}px`);
  }
});
