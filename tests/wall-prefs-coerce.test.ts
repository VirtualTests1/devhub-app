/**
 * `coerceWallPref` in `src/store/wall.ts` — the validator the view-context
 * bridge uses instead of `ctx[key] as never`.
 *
 * Pins that a valid context passes through, a wrong-typed or unknown value is
 * dropped, and a non-boolean `grouped` is refused (so `"no"` / `1` can't sneak
 * in as truthy).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceWallPref } from "../src/store/wall.ts";

test("coerceWallPref: known values pass through unchanged", () => {
  assert.deepEqual(
    coerceWallPref({ sort: "size", filter: "running", grouped: true, density: "large" }),
    { sort: "size", filter: "running", grouped: true, density: "large" },
  );
});

test("coerceWallPref: unknown / wrong-typed values are dropped", () => {
  assert.deepEqual(coerceWallPref({ sort: "garbage" }), {});
  assert.deepEqual(coerceWallPref({ filter: 42 }), {});
  assert.deepEqual(coerceWallPref({ density: "huge" }), {});
});

test("coerceWallPref: non-boolean grouped is refused", () => {
  assert.deepEqual(coerceWallPref({ grouped: "no" }), {});
  assert.deepEqual(coerceWallPref({ grouped: 1 }), {});
  assert.deepEqual(coerceWallPref({ grouped: false }), { grouped: false });
});

test("coerceWallPref: valid keys kept, missing keys absent, extra keys ignored", () => {
  const out = coerceWallPref({ sort: "recent", junk: "x", grouped: false });
  assert.equal(out.sort, "recent");
  assert.equal(out.grouped, false);
  assert.equal("filter" in out, false);
  assert.equal("density" in out, false);
});
