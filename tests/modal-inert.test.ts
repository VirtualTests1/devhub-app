/**
 * `src/lib/modal-inert.ts` (r20-O4-1).
 *
 * The rule under test is that `inert` and `aria-hidden` move together and that the
 * set of elements touched is exactly the set restored. Both halves matter: inertiing
 * too much makes the open dialog unreachable, and a restore that over-reaches
 * re-enables something the app had deliberately disabled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyModalInert, type InertableElement } from "../src/lib/modal-inert.ts";

type Fake = InertableElement & {
  name: string;
  attrs: Map<string, string>;
  /** What the *document* would have had before this call. */
  wasInert: boolean;
};

function el(name: string, opts: { inert?: boolean; layer?: string } = {}): Fake {
  const attrs = new Map<string, string>();
  const node: Fake = {
    name,
    attrs,
    wasInert: opts.inert === true,
    inert: opts.inert === true,
    dataset: opts.layer ? { layer: opts.layer } : {},
    setAttribute: (k, v) => {
      attrs.set(k, v);
    },
    removeAttribute: (k) => {
      attrs.delete(k);
    },
  };
  return node;
}

test("applyModalInert: siblings are inert AND hidden, the dialog itself is not", () => {
  const shell = el("shell");
  const strip = el("strip");
  const scrim = el("scrim", { layer: "scrim" });
  const restore = applyModalInert([shell, strip, scrim], scrim);

  assert.notEqual(scrim.inert, true, "the scrim must stay live — its dialog is the point");
  assert.equal(shell.inert, true);
  assert.equal(shell.attrs.get("aria-hidden"), "true");
  assert.equal(strip.inert, true);
  assert.equal(strip.attrs.get("aria-hidden"), "true");

  restore();
  assert.equal(shell.inert, false, "restore un-marks, it does not leave the flag set");
  assert.equal(shell.attrs.has("aria-hidden"), false);
  assert.equal(strip.attrs.has("aria-hidden"), false);
});

test("applyModalInert: another open dialog's scrim stays reachable", () => {
  // Two dialogs stacked: the inner one must not disable the outer one's subtree, or the
  // outer dialog's buttons would be focusable-by-nothing while still on screen.
  const outer = el("outer", { layer: "scrim" });
  const inner = el("inner", { layer: "scrim" });
  const shell = el("shell");
  applyModalInert([shell, outer, inner], inner);
  assert.equal(outer.inert, false);
  assert.equal(shell.inert, true);
});

test("applyModalInert: a sibling that was already inert is not restored", () => {
  const disabled = el("disabled", { inert: true });
  const live = el("live");
  const restore = applyModalInert([disabled, live], el("scrim"));
  restore();
  assert.equal(disabled.inert, true, "someone else disabled it, someone else re-enables it");
  assert.equal(disabled.attrs.has("aria-hidden"), false, "and no attribute of ours was left behind");
  assert.equal(live.inert, false);
});

test("applyModalInert: an empty sibling list is a no-op, not a throw", () => {
  const scrim = el("scrim", { layer: "scrim" });
  const restore = applyModalInert([], scrim);
  // Calling it directly is the assertion: a throw fails the test on its own, and the
  // postcondition says the restore touched nothing.
  restore();
  assert.equal(scrim.attrs.has("aria-hidden"), false);
});
