/**
 * The visibility gate that keeps second-level clocks off a hidden window.
 *
 * The scheduler and the visibility source are faked so the two facts that matter
 * are assertions: hiding clears the real interval, and showing arms exactly one
 * again (with an optional immediate catch-up tick).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createVisibilityInterval, type IntervalScheduler, type VisibilitySource } from "../src/lib/visibility.ts";
import { createRefTicker } from "../src/lib/ref-ticker.ts";

function fakeScheduler() {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  let started = 0;
  let cleared = 0;
  const scheduler: IntervalScheduler = {
    setInterval(cb) {
      started += 1;
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    clearInterval(handle) {
      cleared += 1;
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    fireAll: () => [...callbacks.values()].forEach((cb) => cb()),
    stats: () => ({ started, cleared, live: callbacks.size }),
  };
}

function fakeVisibility(initiallyHidden = false) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    hidden: () => hidden,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    hide() {
      hidden = true;
      for (const cb of [...listeners]) cb();
    },
    show() {
      hidden = false;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.size,
  };
}

test("visibility interval: hidden clears the handle, visible arms exactly one", () => {
  const sched = fakeScheduler();
  const vis = fakeVisibility();
  let ticks = 0;
  const clock = createVisibilityInterval(() => {
    ticks += 1;
  }, 1000, sched.scheduler, vis.source);

  clock.start();
  assert.equal(clock.isRunning(), true);
  assert.deepEqual(sched.stats(), { started: 1, cleared: 0, live: 1 });

  vis.hide();
  assert.equal(clock.isRunning(), false);
  assert.equal(sched.stats().live, 0, "a hidden window holds no interval");
  sched.fireAll();
  assert.equal(ticks, 0, "nothing can fire after the handle was cleared");

  vis.show();
  assert.equal(clock.isRunning(), true);
  assert.equal(sched.stats().started, 2, "returning arms a fresh interval, not a duplicate");
  sched.fireAll();
  assert.equal(ticks, 1);
  clock.stop();
  assert.equal(sched.stats().live, 0);
  assert.equal(vis.listenerCount(), 0, "stop unsubscribes from visibility");
});

test("visibility interval: fireOnResume makes the first visible frame true", () => {
  const sched = fakeScheduler();
  const vis = fakeVisibility();
  let ticks = 0;
  const clock = createVisibilityInterval(
    () => {
      ticks += 1;
    },
    1000,
    sched.scheduler,
    vis.source,
    { fireOnResume: true },
  );
  clock.start();
  vis.hide();
  vis.show();
  assert.equal(ticks, 1, "one catch-up callback on the way back");
  sched.fireAll();
  assert.equal(ticks, 2, "the interval still runs afterwards");
  clock.stop();
});

test("visibility interval: starting hidden arms nothing until visible", () => {
  const sched = fakeScheduler();
  const vis = fakeVisibility(true);
  let ticks = 0;
  const clock = createVisibilityInterval(() => {
    ticks += 1;
  }, 1000, sched.scheduler, vis.source);
  clock.start();
  assert.equal(clock.isRunning(), false);
  assert.equal(sched.stats().started, 0);
  vis.show();
  assert.equal(clock.isRunning(), true);
  sched.fireAll();
  assert.equal(ticks, 1);
  clock.stop();
});

test("visibility interval: start is idempotent and stop while hidden cannot be resurrected", () => {
  const sched = fakeScheduler();
  const vis = fakeVisibility();
  const clock = createVisibilityInterval(() => {}, 1000, sched.scheduler, vis.source);
  clock.start();
  clock.start();
  assert.equal(sched.stats().started, 1);
  vis.hide();
  clock.stop();
  assert.equal(vis.listenerCount(), 0);
  vis.show();
  assert.equal(sched.stats().live, 0, "a stopped owner stays stopped across visibility changes");
});

test("ref ticker: hidden pauses the shared clock and visible catches up once", () => {
  const sched = fakeScheduler();
  const vis = fakeVisibility();
  const ticker = createRefTicker(sched.scheduler, 1000, vis.source);
  let calls = 0;
  ticker.subscribe(() => {
    calls += 1;
  });
  assert.equal(ticker.isRunning(), true);
  vis.hide();
  assert.equal(ticker.isRunning(), false);
  assert.equal(calls, 0);

  vis.show();
  assert.equal(ticker.isRunning(), true);
  assert.equal(calls, 1, "the return tick re-renders the visible clock immediately");
  assert.equal(ticker.version(), 1);
  sched.fireAll();
  assert.equal(ticker.version(), 2);
  assert.equal(calls, 2);
});
