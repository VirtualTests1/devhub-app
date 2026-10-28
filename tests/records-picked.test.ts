/**
 * `src/views/records/picked.ts` — the batch-selection set arithmetic of 记录.
 *
 * The panel exists so a filter can end a selection, and this is the part of that
 * contract that can be pinned without a webview: 已选 N and 全选/取消全选 must be
 * membership over the ids the list is *showing*. The failure a screenshot cannot
 * show is the old `picked.size === filtered.length` — a count compared against a
 * list — which said 已选 40 / 取消全选 after a chip switch while every visible row
 * was unchecked, and then handed those invisible ids to 删除所选.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickedCount,
  pickedIsAll,
  prunePicked,
} from "../src/views/records/picked.ts";

test("pickedCount: only counts ids the current result set shows", () => {
  const picked = new Set(["a", "b", "z"]);
  assert.equal(pickedCount(picked, ["a", "b", "c"]), 2, "z was picked under another filter; it is not on screen");
  assert.equal(pickedCount(picked, ["c", "d"]), 0, "nothing on screen is picked");
  assert.equal(pickedCount(picked, []), 0);
  assert.equal(pickedCount(new Set(), ["a"]), 0);
});

test("pickedCount: a duplicate id in the list is counted per row, like the checkboxes", () => {
  // Two rows can only carry one id if the log already holds it twice; both rows
  // render checked from `picked.has(e.id)`, so the count must agree with them.
  const picked = new Set(["a"]);
  assert.equal(pickedCount(picked, ["a", "a", "b"]), 2);
});

test("pickedIsAll: membership, not counts — and an empty list is never 全选", () => {
  assert.equal(pickedIsAll(new Set(["a", "b"]), ["a", "b"]), true);
  assert.equal(pickedIsAll(new Set(["a"]), ["a", "b"]), false, "one short is not all");
  // The bug's shape: picked holds MORE ids than the filter shows, so the old
  // `picked.size === filtered.length` judged the wrong set in both directions —
  // equal counts over different members reads as 全选, and one row short over a
  // longer list reads as not-全选 while every visible row is checked.
  assert.equal(pickedIsAll(new Set(["a", "z"]), ["a", "b"]), false, "equal counts, different members");
  assert.equal(
    pickedIsAll(new Set(["a", "b", "z"]), ["a", "b"]),
    true,
    "membership is over what is SHOWN — an off-screen id neither spoils 全选 (prunePicked removes it) nor counts towards 已选",
  );
  assert.equal(pickedIsAll(new Set(), []), false, "0 rows shown is never 取消全选");
});

test("prunePicked: a filter change takes its ids out of the selection", () => {
  const picked = new Set(["a", "b", "z"]);
  const pruned = prunePicked(picked, ["b", "c"]);
  assert.deepEqual([...pruned], ["b"], "a stays only if it is still on screen");
});

test("prunePicked: an untouched selection returns the SAME set (no re-render by itself)", () => {
  const picked = new Set(["a", "b"]);
  assert.equal(prunePicked(picked, ["a", "b", "c"]), picked, "identity, not just equality — the effect must be a no-op");
  const empty = new Set<string>();
  assert.equal(prunePicked(empty, ["a"]), empty, "an empty selection has nothing to drop");
});

test("prunePicked: the input set is never mutated", () => {
  const picked = new Set(["a", "gone"]);
  prunePicked(picked, ["a"]);
  assert.deepEqual([...picked], ["a", "gone"], "the caller's state object is React's to replace, not ours");
});
