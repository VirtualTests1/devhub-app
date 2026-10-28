/**
 * `rangeOf` in `src/store/selection.ts` — the only arithmetic in the 项目墙
 * multi-select, and the part where an off-by-one selects one card too many so
 * the batch then acts on a repository nobody meant to touch. The zustand store
 * around it is a singleton; this file pins the pure function the Shift-click
 * path (`extendTo`) delegates to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { rangeOf } from "../src/store/selection.ts";

import { at } from "./helpers/definite.ts";

const wall = ["github.com/a/one", "github.com/b/two", "github.com/c/three", "github.com/d/four", "github.com/e/five"];

test("rangeOf: empty list or unknown ends yield no range", () => {
  assert.deepEqual(rangeOf([], "a", "b"), []);
  // Both ends missing, and one-missing-each-side: extendTo treats an empty
  // block as "not a range", so a stale anchor degrades instead of guessing.
  assert.deepEqual(rangeOf(wall, "nope", "also-nope"), []);
  assert.deepEqual(rangeOf(wall, at(wall, 0), "nope"), []);
  assert.deepEqual(rangeOf(wall, "nope", at(wall, 4)), []);
});

test("rangeOf: a single card is a range of one", () => {
  assert.deepEqual(rangeOf(wall, at(wall, 2), at(wall, 2)), [at(wall, 2)]);
  assert.deepEqual(rangeOf(["only"], "only", "only"), ["only"]);
});

test("rangeOf: inclusive block, identical in both click directions", () => {
  // Inclusive on both ends — the click target itself is part of the range.
  assert.deepEqual(rangeOf(wall, at(wall, 1), at(wall, 3)), [at(wall, 1), at(wall, 2), at(wall, 3)]);
  // Shift-clicking upward walks the very same block, not a different one.
  assert.deepEqual(rangeOf(wall, at(wall, 3), at(wall, 1)), [at(wall, 1), at(wall, 2), at(wall, 3)]);
  // The whole wall, and one step short of it at each end.
  assert.deepEqual(rangeOf(wall, at(wall, 0), at(wall, 4)), wall);
  assert.deepEqual(rangeOf(wall, at(wall, 0), at(wall, 3)), wall.slice(0, 4));
});
