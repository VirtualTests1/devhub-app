/**
 * `src/lib/useSettingsAutosave.ts` — the debounce / coalesce engine behind 设置.
 *
 * The bug these pin (r15-correct-1): `SettingsView`'s `save` is a plain function
 * declared in the component body, so it is a new function object on every render.
 * The hook built `flush` with `useCallback([save])` and the unmount effect
 * depended on `flush`, so every keystroke (setX → re-render → new `save`) tore the
 * effect down and ran its cleanup — `clearTimeout(timer); void flush()` — which
 * submitted the pending patch *immediately*. The 800 ms window never opened, and
 * the backend took one `save_settings` invoke per character.
 *
 * The engine now resolves `save` through a getter at flush time, so a changing
 * writer identity is not an event the scheduler reacts to at all. That is what
 * "N rapid sets produce one save" below actually tests: the burst swaps the
 * function between every keystroke, exactly like the real view does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAutosaveEngine, type SettingsSaveFn } from "../src/lib/useSettingsAutosave.ts";

import { at } from "./helpers/definite.ts";

/** Lets the `await` inside a flush resume before the next assertion. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let nextId = 0;
  const pending: { id: number; cb: () => void; ms: number }[] = [];
  const cleared: number[] = [];
  return {
    pending,
    cleared,
    schedule: (cb: () => void, ms: number) => {
      const id = ++nextId;
      pending.push({ id, cb, ms });
      return id;
    },
    unschedule: (id: number) => {
      cleared.push(id);
      // 局部名避开模块级 `at`（helpers/definite.ts 的索引断言）——Shadow 合法，但是陷阱。
      const pos = pending.findIndex((p) => p.id === id);
      if (pos >= 0) pending.splice(pos, 1);
    },
    fire: () => {
      const soonest = pending.shift();
      if (!soonest) throw new Error("fake clock: nothing is scheduled");
      soonest.cb();
    },
  };
}

function recorder() {
  const calls: Record<string, unknown>[] = [];
  const save: SettingsSaveFn = async (patch) => {
    calls.push({ ...(patch as Record<string, unknown>) });
  };
  return { calls, save };
}

test("N rapid saveSoon calls coalesce into one save", async () => {
  const clock = fakeClock();
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  for (const ch of "https://ghproxy.test".split("")) engine.saveSoon({ mirror: ch });

  assert.equal(clock.pending.length, 1, "a burst arms exactly one trailing timer");
  assert.equal(at(clock.pending, 0).ms, 800, "the documented coalescing window is 800ms");
  assert.deepEqual(rec.calls, [], "nothing is written before the window closes");

  clock.fire();
  await tick();
  assert.equal(rec.calls.length, 1, "twenty keystrokes must not become twenty invokes");
  assert.deepEqual(
    rec.calls[0],
    { mirror: "t" },
    "last value per field wins, so the merged patch carries the final character",
  );
});

test("a re-render replacing `save` mid-burst does not flush the pending write", async () => {
  // The regression, encoded directly: each keystroke re-renders 设置 and hands the
  // hook a new `save`. The old hook treated that as a reason to tear down its
  // effect, whose cleanup flushed — one invoke per character.
  const clock = fakeClock();
  const rec = recorder();
  let writer = rec.save;
  const engine = createAutosaveEngine({
    getSave: () => writer,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  for (let i = 0; i < 12; i += 1) {
    writer = async (patch, opts) => rec.save(patch, opts); // a fresh identity, as a re-render makes
    engine.saveSoon({ root: `D:\\p${i}` });
  }

  assert.deepEqual(rec.calls, [], "not one save landed during the burst");
  assert.equal(clock.pending.length, 1, "and the timer was never cancelled by the churn");

  clock.fire();
  await tick();
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0], { root: "D:\\p11" }, "the newest value is what lands");
});

test("queued state reports the window and clears when it closes", async () => {
  const clock = fakeClock();
  const seen: boolean[] = [];
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    onQueuedChange: (q) => seen.push(q),
  });

  assert.equal(engine.isQueued(), false);
  engine.saveSoon({ a: 1 });
  assert.equal(engine.isQueued(), true, "the header can say 已排队 while the window is open");
  clock.fire();
  await tick();
  assert.equal(engine.isQueued(), false);
  assert.deepEqual(seen, [true, false], "reported once each way, not once per keystroke");
});

test("saveNow cancels a waiting debounce and submits once, not twice", async () => {
  const clock = fakeClock();
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  engine.saveSoon({ a: 1 });
  await engine.saveNow({ b: 2 });

  assert.equal(clock.pending.length, 0, "the debounce is cancelled, not left to fire");
  assert.equal(clock.cleared.length, 1, "and it was cancelled by id, not silently dropped");
  assert.deepEqual(rec.calls, [{ a: 1, b: 2 }], "the queued value rides along with the click");

  await tick();
  assert.equal(rec.calls.length, 1, "and the cancelled timer must not write a second time");
  assert.equal(clock.pending.length, 0);
});

test("commitSoon submits the window early (失焦 / 回车)", async () => {
  const clock = fakeClock();
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  engine.saveSoon({ a: 1 });
  engine.commitSoon();
  await tick();
  assert.deepEqual(rec.calls, [{ a: 1 }]);
  assert.equal(clock.pending.length, 0);
});

test("discardPending drops the queued value without writing it", async () => {
  const clock = fakeClock();
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  engine.saveSoon({ a: 1 });
  engine.discardPending();
  await tick();
  assert.deepEqual(rec.calls, [], "an external payload overriding a local pending value wins");
  assert.equal(engine.isQueued(), false);
});

test("dispose flushes what is still queued (切走页面不丢改动)", async () => {
  const clock = fakeClock();
  const rec = recorder();
  const engine = createAutosaveEngine({
    getSave: () => rec.save,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  engine.saveSoon({ a: 1 });
  engine.dispose();
  await tick();
  assert.deepEqual(rec.calls, [{ a: 1 }]);
});

test("a rejected save returns the patch to the queue instead of losing it", async () => {
  const clock = fakeClock();
  let attempt = 0;
  const kept: Record<string, unknown>[] = [];
  const engine = createAutosaveEngine({
    getSave: () => async (patch) => {
      attempt += 1;
      kept.push({ ...(patch as Record<string, unknown>) });
      if (attempt === 1) throw new Error("后端拒绝");
    },
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  engine.saveSoon({ a: 1 });
  clock.fire();
  await tick();
  assert.equal(attempt, 1, "no immediate retry — a down backend must not spin");
  assert.equal(engine.isQueued(), true, "the edit is still pending, not silently dropped");
  assert.equal(clock.pending.length, 0, "and nothing self-reschedules behind it");

  await engine.saveNow({ b: 2 });
  assert.equal(attempt, 2, "the next intent is what retries it");
  assert.deepEqual(kept[1], { a: 1, b: 2 }, "the refused edit rides along instead of being lost");
});

test("an edit arriving mid-save runs right after it rather than racing it", async () => {
  const clock = fakeClock();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });

  const engine = createAutosaveEngine({
    getSave: () => async (patch) => {
      order.push(JSON.stringify(patch));
      if (order.length === 1) await gate;
    },
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  // Not awaited: the first write is still in flight, which is the state under test.
  const inFlight = engine.saveNow({ a: 1 });
  engine.saveSoon({ c: 3 });
  await engine.saveNow({ b: 2 }); // arrives while the first is in flight
  release();
  await inFlight;
  await tick();

  assert.equal(order.length, 2, "the single-flight guard folded the overlapping writes into one follow-up");
  assert.equal(order[0], JSON.stringify({ a: 1 }));
  assert.deepEqual(JSON.parse(at(order, 1)), { c: 3, b: 2 }, "and the merged patch kept both edits");
});
