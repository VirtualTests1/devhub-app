/**
 * The refcounted per-second ticker (`src/lib/ref-ticker.ts`) — the contract the
 * download queue and the process store each used to enforce with a private copy.
 *
 * The scheduler is faked so "one interval, stopped when the last subscriber
 * leaves" is an assertion, not a paragraph. Node cannot drive `window`, and the
 * whole point of `ref-ticker.ts` is that the timer logic no longer needs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRefTicker,
  type IntervalScheduler,
} from "../src/lib/ref-ticker.ts";

/** A scheduler that remembers the callbacks so a test can fire them by hand. */
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

test("ref-ticker: the first subscriber arms the interval, the last one stops it", () => {
  const f = fakeScheduler();
  const ticker = createRefTicker(f.scheduler, 1000);
  assert.equal(ticker.isRunning(), false, "idle before anyone subscribes");
  assert.deepEqual(f.stats(), { started: 0, cleared: 0, live: 0 });

  const off1 = ticker.subscribe(() => {});
  assert.equal(ticker.isRunning(), true);
  assert.equal(f.stats().started, 1);

  const off2 = ticker.subscribe(() => {});
  assert.equal(f.stats().started, 1, "a second subscriber shares the one interval, it does not arm another");

  off1();
  assert.equal(ticker.isRunning(), true, "one subscriber left — the clock must survive it");
  assert.equal(f.stats().cleared, 0);

  off2();
  assert.equal(ticker.isRunning(), false);
  assert.equal(f.stats().cleared, 1, "the last unsubscribe stops the interval");
});

test("ref-ticker: subscribing again after a full teardown arms a fresh interval", () => {
  // A finished download row that unmounts and a new one that mounts must get a
  // live clock back; the old code cleared the handle and set it to null, so a
  // later subscribe started over. Pin that, because "never re-arms" is the
  // failure that reads on screen as a frozen elapsed time.
  const f = fakeScheduler();
  const ticker = createRefTicker(f.scheduler, 1000);
  ticker.subscribe(() => {})();
  assert.equal(f.stats().started, 1);
  assert.equal(f.stats().cleared, 1);

  const versionBefore = ticker.version();
  ticker.subscribe(() => {});
  assert.equal(f.stats().started, 2, "a new interval is created after the previous one was cleared");
  f.fireAll();
  assert.equal(ticker.version(), versionBefore + 1, "the fresh interval ticks the counter");
});

test("ref-ticker: a tick advances the version and notifies every live listener once", () => {
  const f = fakeScheduler();
  const ticker = createRefTicker(f.scheduler, 1000);
  let a = 0;
  let b = 0;
  ticker.subscribe(() => {
    a += 1;
  });
  ticker.subscribe(() => {
    b += 1;
  });
  f.fireAll();
  f.fireAll();
  assert.equal(ticker.version(), 2);
  assert.equal(a, 2);
  assert.equal(b, 2, "both listeners share the one interval's notifies");
});

test("ref-ticker: a listener that unsubscribes during a tick is not called again", () => {
  // The download queue's leaf rows leave mid-notify when a task settles. The
  // old `Set.forEach` skipped a listener deleted during iteration; making that
  // an assertion stops a refactor from switching to an array and calling a dead
  // listener.
  const f = fakeScheduler();
  const ticker = createRefTicker(f.scheduler, 1000);
  let calls = 0;
  let off = () => {};
  off = ticker.subscribe(() => {
    calls += 1;
    off();
  });
  ticker.subscribe(() => {});
  f.fireAll();
  assert.equal(calls, 1, "the self-unsubscribing listener was called exactly once");
  assert.equal(ticker.subscriberCount(), 1, "the other subscriber remains");
  assert.equal(ticker.isRunning(), true);
});

test("ref-ticker: stop() releases the interval regardless of subscriber count", () => {
  // Unmount safety: a provider going away must not depend on every child having
  // unsubscribed in order. `stop()` is the explicit escape hatch and a later
  // subscribe still re-arms.
  const f = fakeScheduler();
  const ticker = createRefTicker(f.scheduler, 1000);
  ticker.subscribe(() => {});
  ticker.stop();
  assert.equal(ticker.isRunning(), false);
  assert.equal(f.stats().cleared, 1);
  assert.equal(ticker.subscriberCount(), 1, "stop() does not silently drop the listeners");

  ticker.stop();
  assert.equal(f.stats().cleared, 1, "stopping an already-stopped ticker clears nothing twice");

  ticker.subscribe(() => {});
  assert.equal(f.stats().started, 2, "subscribing after stop re-arms");
});
