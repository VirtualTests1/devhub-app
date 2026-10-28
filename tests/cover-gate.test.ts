/**
 * `src/lib/cover-gate.ts` — the burst cap in front of `fetch_cover` (r20-O1-2).
 *
 * Three things have to be true or the gate is worse than no gate: it must actually
 * bound concurrency, it must release the slot when the task rejects (a leaked slot
 * deadlocks every later cover for the session), and queued work must still run in
 * the order it arrived.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { COVER_MAX_INFLIGHT, coverSlotsInUse, withCoverSlot } from "../src/lib/cover-gate.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("withCoverSlot: never exceeds the limit, and still fills it", async () => {
  let peak = 0;
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      withCoverSlot(async () => {
        peak = Math.max(peak, coverSlotsInUse());
        await sleep(4);
        return i;
      }),
    ),
  );
  assert.ok(peak <= COVER_MAX_INFLIGHT, `peak in-flight was ${peak}`);
  assert.equal(peak, COVER_MAX_INFLIGHT, "a queue nobody drains is not a measured limit");
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("withCoverSlot: a rejection releases the slot", async () => {
  const before = coverSlotsInUse();
  await assert.rejects(() =>
    withCoverSlot(async () => {
      throw new Error("curl died");
    }),
  );
  assert.equal(coverSlotsInUse(), before, "a failed task must not keep its slot");
  // The proof is that the next caller is not stuck behind it.
  assert.equal(await withCoverSlot(async () => "ran"), "ran");
});

test("withCoverSlot: queued callers run once a slot frees", async () => {
  const order: string[] = [];
  const slow = withCoverSlot(async () => {
    await sleep(20);
    order.push("slow");
  }, 1);
  const after = withCoverSlot(async () => {
    order.push("after");
  }, 1);
  await Promise.all([slow, after]);
  assert.deepEqual(order, ["slow", "after"]);
});
