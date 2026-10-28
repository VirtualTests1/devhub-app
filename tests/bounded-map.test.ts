/**
 * `src/lib/bounded-map.ts` — the fan-out 批量更新 depends on.
 *
 * `Promise.all` over a selection is right for the three local verbs and wrong for
 * a `git pull`: forty selected cards would mean forty simultaneous git processes
 * against one remote. The cap is the only protection, so the three things that
 * would silently break it get pinned here — peak in-flight, input order (a result
 * list that re-orders itself names the wrong repository), and the junk-limit
 * cases that a caller can hand it by accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mapBounded } from "../src/lib/bounded-map.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("mapBounded: never exceeds the width, and still uses it", async () => {
  let inflight = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await mapBounded(items, 3, async (i) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await sleep(5);
    inflight -= 1;
    return i * 2;
  });
  assert.equal(peak, 3, "a width of 3 should actually run 3 at a time");
  assert.deepEqual(out, items.map((i) => i * 2));
});

test("mapBounded: results are in input order, not completion order", async () => {
  // The slow one is first. A `.push()`-per-completion implementation would return
  // ["fast", "slow"] and the caller would print the wrong name next to the wrong
  // repository — the exact failure mode a result list cannot survive.
  const out = await mapBounded(
    [{ name: "slow", ms: 30 }, { name: "fast", ms: 1 }],
    2,
    async (item) => {
      await sleep(item.ms);
      return item.name;
    },
  );
  assert.deepEqual(out, ["slow", "fast"]);
});

test("mapBounded: a width of 1 is sequential", async () => {
  const started: number[] = [];
  const out = await mapBounded([1, 2, 3], 1, async (n) => {
    started.push(n);
    await sleep(1);
    return n;
  });
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(out, [1, 2, 3]);
});

test("mapBounded: nothing selected is nothing to run", async () => {
  let calls = 0;
  const out = await mapBounded([], 4, async () => {
    calls += 1;
    return 1;
  });
  assert.equal(calls, 0);
  assert.deepEqual(out, []);
});

test("mapBounded: junk widths degrade to one at a time, never to zero", async () => {
  for (const limit of [0, -3, NaN]) {
    const out = await mapBounded(["a", "b", "c"], limit, async (s) => s.toUpperCase());
    // An unrunnable cap that silently returned [] would report "3 成功" over an
    // empty list; the honest degradation is to do the work, one at a time.
    assert.deepEqual(out, ["A", "B", "C"], `limit ${String(limit)}`);
  }
});

test("mapBounded: a width larger than the list starts the whole list at once", async () => {
  let peak = 0;
  let inflight = 0;
  await mapBounded([1, 2, 3], 99, async (n) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await sleep(2);
    inflight -= 1;
    return n;
  });
  assert.equal(peak, 3);
});

test("mapBounded: a rejected worker rejects the call, like Promise.all", async () => {
  // Deliberate. `BatchBar` catches per item and turns a throw into `{ ok: false }`
  // *before* it reaches here, so a rejection that survives to `mapBounded` is a
  // bug in the caller — swallowing it into a hole in the array would make the
  // batch's "N/M 成功" claim unverifiable.
  let message = "";
  try {
    await mapBounded(
      [1, 2],
      2,
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      },
    );
  } catch (err) {
    message = err instanceof Error ? err.message : "非 Error 的拒绝";
  }
  assert.match(message, /boom/);
});
