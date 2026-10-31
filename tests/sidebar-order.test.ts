/**
 * The pure half of the sidebar's keyboard reorder (Alt+↑/↓).
 *
 * The wiring lives in `Sidebar.tsx`, which the Node type-stripping runner cannot
 * import; the boundary decisions (first item, last item, no-op) live here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { moveItem } from "../src/lib/sidebar-order.ts";

test("moveItem: moves one slot in either direction", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "c", "b"]);
});

test("moveItem: out-of-range and same-index moves are copies, not mutations", () => {
  const items = ["a", "b", "c"];
  for (const [from, to] of [
    [0, -1],
    [0, 3],
    [-1, 0],
    [3, 0],
    [1, 1],
  ]) {
    const out = moveItem(items, from as number, to as number);
    assert.deepEqual(out, items, `move ${from}->${to} must be a no-op`);
    assert.notEqual(out, items, "a no-op still returns a new array");
  }
  assert.deepEqual(items, ["a", "b", "c"], "the input is never mutated");
});

test("moveItem: identity of untouched items is preserved for the caller's equality check", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  const out = moveItem([a, b, c], 0, 2);
  assert.deepEqual(out.map((x) => x.id), ["b", "c", "a"]);
  assert.equal(out[0], b);
  assert.equal(out[1], c);
  assert.equal(out[2], a);
});
