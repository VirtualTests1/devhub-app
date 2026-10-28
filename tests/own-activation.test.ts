/**
 * `src/lib/useDismiss.ts` — the row-level activation guards (r15-a11y-1/2).
 *
 * The defect: a `role="button"` settings row and a `role="group"` download row
 * both run an action when activated, and both guard the *click* path against
 * controls that already handle their own click — but the *key* path fired
 * unconditionally. Focus sits on the inner Switch / option / chevron / ✕ button,
 * its keydown bubbles to the row, the row calls `preventDefault()` and runs its
 * own action too. On a switch that is flip+flip = nothing happens; on a choice
 * row it picks the focused option *and* cycles; on the queue row pressing ✕
 * removed the task and expanded it in the same keystroke.
 *
 * What is pinned here is the decision itself, which is what the two rows share:
 * an activation key belongs to the row only when it did not originate on a
 * control with its own activation semantics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasOwnActivation, rowOwnsKey } from "../src/lib/useDismiss.ts";

/** Stub of an HTMLElement: the guard only ever calls `closest`. */
function host(matched: unknown) {
  return { closest: (_selector: string) => matched } as unknown as EventTarget;
}

test("hasOwnActivation: a target inside a self-activating control is claimed", () => {
  // The selector match is what `closest` resolves at runtime; the stub returns
  // the element it found (truthy) or null (not found).
  assert.equal(hasOwnActivation(host({ tag: "button" })), true);
  assert.equal(hasOwnActivation(host(null)), false);
});

test("hasOwnActivation: non-elements and elements without closest are ignored", () => {
  assert.equal(hasOwnActivation(null), false);
  assert.equal(hasOwnActivation({} as unknown as EventTarget), false);
});

test("rowOwnsKey: Enter/Space on the row itself belongs to the row", () => {
  const row = host(null); // the row div matches nothing in the selector
  assert.equal(rowOwnsKey(row, "Enter"), true);
  assert.equal(rowOwnsKey(row, " "), true);
});

test("rowOwnsKey: Enter/Space bubbled from an inner control does NOT", () => {
  // This is the whole bug: the key must be left to the control, including its
  // default action — callers skip preventDefault() when this says false, or a
  // Space on the chevron would be cancelled and only toggle the wrong thing.
  const inner = host({ tag: "button" });
  assert.equal(rowOwnsKey(inner, "Enter"), false);
  assert.equal(rowOwnsKey(inner, " "), false);
});

test("rowOwnsKey: activation keys only — arrows and letters are never claimed", () => {
  const row = host(null);
  assert.equal(rowOwnsKey(row, "ArrowDown"), false);
  assert.equal(rowOwnsKey(row, "ContextMenu"), false);
  assert.equal(rowOwnsKey(row, "a"), false);
});
