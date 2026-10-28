/**
 * `src/lib/useDismiss.ts` — `reorderById`, the keyboard-reorder step for the
 * 常用 fixed list (r15-a11y-8).
 *
 * The defect: 固定项 reordering was native `draggable` + pointer handlers with
 * no tabIndex and no key path — a mouse-only verb on a page whose neighbouring
 * 项目墙 already answers keyboard reorder (dnd-kit KeyboardSensor,
 * ProjectsView:539). The row now takes Space-then-Arrows; this is the arithmetic
 * behind one arrow press, kept pure and here in the `.ts` because Node's
 * type-stripping runner refuses `.tsx` and untestable keyboard reducers are the
 * exact defect class this repo keeps re-auditing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reorderById } from "../src/lib/useDismiss.ts";

const wall = ["repo:a", "view:projects", "settings:network", "repo:b"];

test("reorderById: +1 swaps with the next entry, -1 with the previous", () => {
  assert.deepEqual(reorderById(wall, "view:projects", 1), [
    "repo:a",
    "settings:network",
    "view:projects",
    "repo:b",
  ]);
  assert.deepEqual(reorderById(wall, "settings:network", -1), [
    "repo:a",
    "settings:network",
    "view:projects",
    "repo:b",
  ]);
});

test("reorderById: edges are no-ops, not wraps", () => {
  // A keyboard grab at the first row pressing ← must not teleport it to the
  // end — the list has visible order and wrapping would mis-announce 第 N / M.
  assert.deepEqual(reorderById(wall, "repo:a", -1), wall);
  assert.deepEqual(reorderById(wall, "repo:b", 1), wall);
});

test("reorderById: an id that is not in the list leaves it alone", () => {
  // Stale focus (row unmounted between keydown and commit) must not corrupt
  // the array.
  assert.deepEqual(reorderById(wall, "repo:gone", 1), wall);
});

test("reorderById: the input array is never mutated", () => {
  // `setEntries` stores this array into the persisted customize store; a
  // returned alias that a caller later splices would rewrite history.
  const source = [...wall];
  const moved = reorderById(source, "repo:a", 2);
  assert.notEqual(moved, source);
  assert.deepEqual(source, wall);
});

test("reorderById: multi-step drags are associative for the moved row", () => {
  // Two ← presses equal one two-left move: the row lands where the user aimed
  // after announcing each intermediate position.
  const two = reorderById(reorderById(wall, "settings:network", -1), "settings:network", -1);
  assert.deepEqual(two, ["settings:network", "repo:a", "view:projects", "repo:b"]);
});
