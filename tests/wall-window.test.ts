/**
 * `src/lib/wall-window.ts` — the cap the 项目墙 renders under (r20-O1-1).
 *
 * The three properties that make the window safe to put in front of drag-reorder:
 * the cap clamps to the list length (an over-large cap means the sentinel never
 * stops observing and the wall quietly mounts everything), it never shrinks on a
 * grow (a 200-card list that arrives after filtering must still paint one step),
 * and a short list is fully visible without any scroll at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WALL_WINDOW_MIN,
  WALL_WINDOW_STEP,
  fitWindow,
  growWindow,
  windowGroups,
} from "../src/lib/wall-window.ts";

test("windowGroups: one budget across sections, not one per section", () => {
  const groups: [string, number[]][] = [
    ["alice", [1, 2, 3]],
    ["bob", [4, 5, 6]],
    ["carol", [7, 8, 9]],
  ];
  assert.deepEqual(windowGroups(groups, 4), [
    ["alice", [1, 2, 3]],
    ["bob", [4]],
  ]);
  assert.deepEqual(windowGroups(groups, 0), [], "a zero budget renders no section at all");
  assert.deepEqual(windowGroups(groups, 99), groups, "an open budget is the whole wall");
  // Forty one-card owners under a 48-step window must not become 48 × 40 tiles.
  const many: [string, number[]][] = Array.from({ length: 40 }, (_, i) => [
    `o${i}`,
    [i],
  ] as [string, number[]]);
  const shown = windowGroups(many, 48);
  assert.equal(
    shown.reduce((n, [, items]) => n + items.length, 0),
    40,
    "every card fits inside one step, so all forty sections stay visible",
  );
});

test("growWindow: one step at a time, clamped to what actually exists", () => {
  assert.equal(growWindow(0, 200), WALL_WINDOW_STEP);
  assert.equal(growWindow(WALL_WINDOW_STEP, 200), WALL_WINDOW_STEP * 2);
  assert.equal(growWindow(192, 200), 200, "the last partial step must land exactly on total");
  assert.equal(growWindow(200, 200), 200, "a full wall must not grow past itself");
  assert.equal(growWindow(500, 200), 200, "a cap left over from a longer list comes down");
});

test("growWindow: non-finite input falls back to one step, never NaN", () => {
  // A `cap` that became NaN somewhere upstream would otherwise freeze the wall at
  // zero cards — `slice(0, NaN)` is an empty array and the sentinel can never grow
  // a NaN cap. This is the difference between a blank 项目 and a visible one.
  assert.equal(growWindow(Number.NaN, 90), WALL_WINDOW_STEP);
  assert.equal(growWindow(Number.POSITIVE_INFINITY, 90), 90);
});

test("fitWindow: a shortened list takes the cap with it, a lengthened one does not", () => {
  assert.equal(fitWindow(96, 40), 40);
  assert.equal(fitWindow(96, 300), 96, "the window must not jump to 300 because the list grew");
  assert.equal(fitWindow(0, 12), 12, "a cold cap still shows the whole short list");
  assert.equal(fitWindow(48, 0), 0, "no cards, no cap");
});

test("fitWindow: a list shorter than one step is never windowed", () => {
  // The filter box produces this constantly. Anything below the step has to be on
  // screen immediately — waiting for a scroll event that will never come is a bug,
  // not a performance choice.
  for (const total of [1, 7, WALL_WINDOW_MIN - 1]) {
    assert.equal(fitWindow(WALL_WINDOW_MIN, total), total);
  }
  assert.equal(fitWindow(WALL_WINDOW_MIN, WALL_WINDOW_MIN + 1), WALL_WINDOW_MIN);
});
