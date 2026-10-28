/**
 * `src/lib/poll-loop.ts` — a poll that is still cancellable while a request is
 * in flight.
 *
 * The bug these pin (round 12, 让失败可见 8.4) was `RepoPortPanel`'s loop:
 * `timer` was assigned after the `await`, so the effect's
 * `clearTimeout(timer)` cleared `0` when the component unmounted mid-request.
 * The request landed, scheduled the next tick, and nothing in the tree still
 * held that timer id — an unstoppable 3 s poll against the backend, with another
 * one stacked under it the next time the panel opened.
 *
 * Everything here is driven by an injected fake clock, because the whole reason
 * `schedule` / `unschedule` are parameters instead of `window.setTimeout` is that
 * this file has to be testable where `.tsx` components cannot be.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createPollLoop } from "../src/lib/poll-loop.ts";

import { at } from "./helpers/definite.ts";

/** Lets the `await` inside the loop resume before the next assertion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A controllable settlement, so "mid-flight" is a state a test can be in. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      const at = pending.findIndex((p) => p.id === id);
      if (at >= 0) pending.splice(at, 1);
    },
    /** Runs the next scheduled tick, the way a real timer would. */
    fire: () => {
      const soonest = pending.shift();
      if (!soonest) throw new Error("fake clock: nothing is scheduled");
      soonest.cb();
    },
  };
}

/** Records what the loop reported, so a test can assert "no callback landed". */
function spy<T>(values: T[] = []) {
  const seen: T[] = values;
  return { seen, note: (v: T) => seen.push(v) };
}

test("start: probes at once, then reschedules after the gap", async () => {
  const clock = fakeClock();
  const starts: number[] = [];
  const results = spy<string[]>();
  const loop = createPollLoop<string[]>({
    everyMs: 3000,
    probe: async () => ["api:3000"],
    onStart: () => starts.push(3000),
    onResult: results.note,
    onError: () => assert.fail("must not report a success as a failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  await flush();
  assert.deepEqual(starts, [3000], "one onStart, before the first probe");
  assert.deepEqual(results.seen, [["api:3000"]]);
  assert.equal(clock.pending.length, 1, "the next tick is scheduled");
  assert.equal(at(clock.pending, 0).ms, 3000);
});

test("a rejected probe is reported and the loop keeps going", async () => {
  const clock = fakeClock();
  const errors = spy<unknown>();
  const loop = createPollLoop<string[]>({
    everyMs: 1000,
    probe: async () => {
      throw new Error("命令不存在");
    },
    onStart: () => undefined,
    onResult: () => assert.fail("no answer to report"),
    onError: errors.note,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  await flush();
  assert.match(String((errors.seen[0] as Error).message), /命令不存在/);
  assert.equal(clock.pending.length, 1, "one failure must not end the polling");

  clock.fire();
  await flush();
  assert.equal(errors.seen.length, 2, "the second tick fails the same way and still says so");
  assert.equal(clock.pending.length, 1);
});

test("stop mid-request: the in-flight tick lands nowhere and schedules nothing", async () => {
  // This is the orphan-loop test. The request is still out when the component
  // goes away; the answer arriving afterwards must not be able to write state or
  // start another poll, because no cleanup holds that timer any more.
  const clock = fakeClock();
  const gate = deferred<string[]>();
  const results = spy<string[]>();
  const errors = spy<unknown>();
  let starts = 0;
  const loop = createPollLoop<string[]>({
    everyMs: 3000,
    probe: () => gate.promise,
    onStart: () => {
      starts += 1;
    },
    onResult: results.note,
    onError: errors.note,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  await flush();
  assert.equal(clock.pending.length, 0, "still in flight — nothing scheduled yet");

  loop.stop();
  gate.resolve(["api:3000"]);
  await flush();
  assert.deepEqual(results.seen, [], "no state write on a stopped run");
  assert.equal(errors.seen.length, 0);
  assert.equal(clock.pending.length, 0, "and no next tick — the old code scheduled one here");
  assert.equal(starts, 1);
});

test("stop mid-request also works when the request rejects", async () => {
  const clock = fakeClock();
  const gate = deferred<string[]>();
  const errors = spy<unknown>();
  const loop = createPollLoop<string[]>({
    everyMs: 3000,
    probe: () => gate.promise,
    onStart: () => undefined,
    onResult: () => assert.fail("no answer"),
    onError: errors.note,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  loop.stop();
  gate.reject("后端断开");
  await flush();
  assert.deepEqual(errors.seen, [], "a stopped run reports nothing");
  assert.equal(clock.pending.length, 0);
});

test("stop clears the timer that is already waiting", async () => {
  const clock = fakeClock();
  const loop = createPollLoop<string[]>({
    everyMs: 500,
    probe: async () => [],
    onStart: () => undefined,
    onResult: () => undefined,
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  await flush();
  assert.equal(clock.pending.length, 1, "the settled state between two probes");
  const waiting = at(clock.pending, 0).id;
  loop.stop();
  assert.deepEqual(clock.cleared, [waiting], "the pending gap is the thing being cancelled");
  assert.equal(clock.pending.length, 0);
  assert.throws(() => clock.fire(), /nothing is scheduled/, "nothing left to fire");
});

test("start is idempotent — a double call cannot double the poll rate", async () => {
  const clock = fakeClock();
  let probes = 0;
  const loop = createPollLoop<string[]>({
    everyMs: 1000,
    probe: async () => {
      probes += 1;
      return [];
    },
    onStart: () => undefined,
    onResult: () => undefined,
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  loop.start();
  await flush();
  assert.equal(probes, 1);
  assert.equal(clock.pending.length, 1);
});

test("a probe that throws before returning a promise is still just a failure", async () => {
  const clock = fakeClock();
  const errors = spy<unknown>();
  const loop = createPollLoop<string[]>({
    everyMs: 1000,
    // Not `async`: a synchronous throw, the way a bad argument or a dead IPC
    // binding arrives.
    probe: () => {
      throw new Error("slug 为空");
    },
    onStart: () => undefined,
    onResult: () => assert.fail("no answer"),
    onError: errors.note,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  loop.start();
  await flush();
  assert.match(String((errors.seen[0] as Error).message), /slug 为空/);
  assert.equal(clock.pending.length, 1, "the panel keeps probing instead of freezing on 检查中");
});
