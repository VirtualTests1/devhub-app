/**
 * `src/lib/useDismiss.ts` — the focus-return decision (r15-a11y-9).
 *
 * The defect: dismissing a popover dropped focus to `<body>`, and picking an
 * entry unmounted the row that had focus — so each additional pin meant
 * re-tabbing the whole panel. The hook gained an optional `returnFocusTo`, and
 * the guard "only hand focus back when nobody else claimed it" lives in the
 * pure `focusIsLost`, which is what the user clicked a non-focusable region vs.
 * tabbed into a real field comes down to. Pinning the decision is the point:
 * the rAF that reads the live `document` cannot be driven here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { focusIsLost } from "../src/lib/useDismiss.ts";

// A fake document: `focusIsLost` only compares activeElement against body and
// documentElement, so the stub is exactly that shape.
const body = { tag: "body" };
const documentElement = { tag: "html" };
const fakeDoc = (active: unknown) => ({ activeElement: active, body, documentElement });

test("focusIsLost: focus on the body means it was dropped", () => {
  assert.equal(focusIsLost(fakeDoc(body)), true);
});

test("focusIsLost: focus on the document element means it was dropped", () => {
  assert.equal(focusIsLost(fakeDoc(documentElement)), true);
});

test("focusIsLost: a null active element (detached) counts as lost", () => {
  assert.equal(focusIsLost(fakeDoc(null)), true);
});

test("focusIsLost: a real focused element is claimed — do not steal it", () => {
  // The click-away landed on another button, or the picker input kept focus:
  // returning focus to the trigger here would interrupt the user.
  assert.equal(focusIsLost(fakeDoc({ tag: "input" })), false);
});
