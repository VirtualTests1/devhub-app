/**
 * `src/lib/ime.ts` — the IME-composition guard behind every Enter-commits-input
 * pair.
 *
 * The whole point is that an Enter which only picks a pinyin candidate must not
 * commit the field. Real browsers signal that two ways (`isComposing` and the
 * legacy `keyCode === 229`), on either the synthetic event or its `nativeEvent`,
 * so the predicate has to honour all four corners without a DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isCommitEnter, isImeComposing } from "../src/lib/ime.ts";

test("isImeComposing: not composing when no signal is present", () => {
  assert.equal(isImeComposing({}), false);
  assert.equal(isImeComposing({ key: "Enter" } as never), false);
});

test("isImeComposing: honours isComposing on the event and on nativeEvent", () => {
  assert.equal(isImeComposing({ isComposing: true }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: true } }), true);
});

test("isImeComposing: honours the legacy keyCode 229 on both layers", () => {
  assert.equal(isImeComposing({ keyCode: 229 }), true);
  assert.equal(isImeComposing({ nativeEvent: { keyCode: 229 } }), true);
});

test("isImeComposing: a real keyCode (Enter=13) is not composition", () => {
  assert.equal(isImeComposing({ keyCode: 13, isComposing: false }), false);
});

test("isCommitEnter: a bare Enter commits", () => {
  assert.equal(isCommitEnter({ key: "Enter" }), true);
});

test("isCommitEnter: Enter during composition does NOT commit", () => {
  assert.equal(isCommitEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(isCommitEnter({ key: "Enter", nativeEvent: { isComposing: true } }), false);
  assert.equal(isCommitEnter({ key: "Enter", keyCode: 229 }), false);
});

test("isCommitEnter: a non-Enter key never commits", () => {
  assert.equal(isCommitEnter({ key: "a" }), false);
  assert.equal(isCommitEnter({ key: "a", isComposing: true }), false);
});
