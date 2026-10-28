/**
 * `src/lib/number-keys.ts` — the shared ↑↓/Page/Home/End/Enter handler for
 * `type="number"` fields.
 *
 * The app's keyboard tests dispatch synthetic KeyboardEvents, which never
 * trigger the browser's native spin-button default action — so anything left
 * to the UA is untestable and effectively absent. This handler exists so the
 * stepping is explicit code the tests can drive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { numberKeyHandler } from "../src/lib/number-keys.ts";

const key = (k: string, shift = false) =>
  ({ key: k, shiftKey: shift, preventDefault: () => {}, target: { value: "50" } }) as unknown as React.KeyboardEvent;

test("ArrowUp/ArrowDown step by `step`, clamped to [min, max]", () => {
  const seen: number[] = [];
  const h = numberKeyHandler({ min: 0, max: 100, step: 10, apply: (n) => seen.push(n) });
  h(key("ArrowUp"));
  h(key("ArrowDown"));
  // cur=50 both times because target.value never changes in this stub.
  assert.deepEqual(seen, [60, 40]);
});

test("Shift+Arrow and PageUp/PageDown multiply the step by 10", () => {
  const seen: number[] = [];
  const h = numberKeyHandler({ min: 0, max: 1000, step: 100, apply: (n) => seen.push(n) });
  h(key("ArrowUp", true));
  h(key("PageDown"));
  // cur=50 both times (target.value is a fixed stub): 50+1000→1000, 50-1000→0.
  assert.deepEqual(seen, [1000, 0]);
});

test("Home/End jump to min/max", () => {
  const seen: number[] = [];
  const h = numberKeyHandler({ min: 12, max: 22, step: 1, apply: (n) => seen.push(n) });
  h(key("Home"));
  h(key("End"));
  assert.deepEqual(seen, [12, 22]);
});

test("Enter calls commit and is preventDefault-ed", () => {
  let committed = 0;
  let prevented = false;
  const h = numberKeyHandler({
    min: 0,
    max: 10,
    step: 1,
    apply: () => {},
    commit: () => committed++,
  });
  h({ key: "Enter", shiftKey: false, preventDefault: () => (prevented = true), target: { value: "3" } } as unknown as React.KeyboardEvent);
  assert.equal(committed, 1);
  assert.equal(prevented, true);
});

test("other keys are ignored entirely", () => {
  const seen: number[] = [];
  let prevented = false;
  const h = numberKeyHandler({ min: 0, max: 100, step: 1, apply: (n) => seen.push(n) });
  h({ key: "a", shiftKey: false, preventDefault: () => (prevented = true), target: { value: "50" } } as unknown as React.KeyboardEvent);
  assert.deepEqual(seen, []);
  assert.equal(prevented, false);
});
