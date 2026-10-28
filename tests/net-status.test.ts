/**
 * `src/lib/net-status.ts` — the payload guard, the strip's words, and the poll's
 * two races.
 *
 * The Rust probe is unit-tested in `src-tauri/src/netstatus.rs`; this side starts
 * at the IPC seam, so every test drives synthetic payloads and a fake clock. No
 * test needs GitHub, a webview, or a real timer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createNetStatusPoller,
  describeNetStatus,
  NET_POLL_MS,
  parseNetStatus,
  type NetStatusReport,
} from "../src/lib/net-status.ts";
import { tFor, type TFunc } from "../src/lib/i18n.ts";

import { at } from "./helpers/definite.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
      const found = pending.findIndex((p) => p.id === id);
      if (found >= 0) pending.splice(found, 1);
    },
    fire: () => {
      const soonest = pending.shift();
      if (!soonest) throw new Error("fake clock: nothing is scheduled");
      soonest.cb();
    },
  };
}

const zh: TFunc = (key, vars) => tFor("zh-CN", key, vars);
const en: TFunc = (key, vars) => tFor("en", key, vars);

const online: NetStatusReport = {
  state: "online",
  resolved: true,
  connected: true,
  latencyMs: 42,
};
const degraded: NetStatusReport = {
  state: "degraded",
  resolved: true,
  connected: false,
  latencyMs: 2_500,
};
const offline: NetStatusReport = {
  state: "offline",
  resolved: false,
  connected: false,
  latencyMs: null,
};

test("parseNetStatus accepts the three coherent payloads and nothing else", () => {
  assert.deepEqual(parseNetStatus(online), online);
  assert.deepEqual(parseNetStatus(degraded), degraded);
  assert.deepEqual(parseNetStatus(offline), offline);

  const bad: unknown[] = [
    null,
    undefined,
    [],
    "online",
    {},
    { state: "unknown", resolved: false, connected: false, latencyMs: null },
    { state: "offline", resolved: false, connected: false, latencyMs: 0 },
    { state: "offline", resolved: true, connected: false, latencyMs: null },
    { state: "online", resolved: true, connected: false, latencyMs: 12 },
    { state: "online", resolved: true, connected: true, latencyMs: null },
    { state: "degraded", resolved: false, connected: false, latencyMs: 9 },
    { state: "online", resolved: true, connected: true, latencyMs: -1 },
    { state: "online", resolved: true, connected: true, latencyMs: 1.5 },
    { state: "online", resolved: true, connected: true, latencyMs: Number.NaN },
    { state: "online", resolved: true, connected: true, latencyMs: "12" },
  ];
  for (const value of bad) {
    assert.equal(parseNetStatus(value), null, `accepted malformed payload ${JSON.stringify(value)}`);
  }
});

test("describeNetStatus names GitHub, the round trip, and the click contract", () => {
  assert.deepEqual(describeNetStatus(online, zh), {
    label: "GitHub 可达",
    title: "往返 42 ms · 点击重新探测 GitHub",
    tone: "ok",
  });
  assert.deepEqual(describeNetStatus(degraded, zh), {
    label: "GitHub 迟缓",
    title: "往返 2500 ms · 点击重新探测 GitHub",
    tone: "warn",
  });
  assert.deepEqual(describeNetStatus(offline, zh), {
    label: "GitHub 不可达",
    title: "点击重新探测 GitHub",
    tone: "danger",
  });
  assert.deepEqual(describeNetStatus(null, zh), {
    label: "GitHub 待测",
    title: "点击重新探测 GitHub",
    tone: "muted",
  });
  assert.deepEqual(describeNetStatus(online, en), {
    label: "GitHub reachable",
    title: "Round trip 42 ms · Click to re-probe GitHub",
    tone: "ok",
  });
});

test("start probes at once, then schedules the 60-second gap", async () => {
  const clock = fakeClock();
  const calls: boolean[] = [];
  const results: unknown[] = [];
  const poller = createNetStatusPoller({
    probe: async (force) => {
      calls.push(force);
      return online;
    },
    onResult: (value) => results.push(value),
    onError: () => assert.fail("a good answer must not be reported as an error"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  assert.deepEqual(calls, [false], "the first probe is not forced; the backend cache may serve it");
  assert.deepEqual(results, [online]);
  assert.equal(clock.pending.length, 1);
  assert.equal(at(clock.pending, 0).ms, NET_POLL_MS);

  clock.fire();
  await flush();
  assert.deepEqual(calls, [false, false]);
  assert.equal(clock.pending.length, 1);
});

test("hidden pauses the timer, and a visible edge probes immediately", async () => {
  const clock = fakeClock();
  let visible = false;
  const calls: boolean[] = [];
  const poller = createNetStatusPoller({
    probe: async (force) => {
      calls.push(force);
      return online;
    },
    onResult: () => undefined,
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => visible,
  });

  poller.start();
  await flush();
  assert.deepEqual(calls, [], "a hidden mount must not dial the backend");
  assert.equal(clock.pending.length, 0);

  visible = true;
  poller.setVisible(true);
  await flush();
  assert.deepEqual(calls, [false]);
  assert.equal(clock.pending.length, 1);

  const waiting = at(clock.pending, 0).id;
  visible = false;
  poller.setVisible(false);
  assert.deepEqual(clock.cleared, [waiting]);
  assert.equal(clock.pending.length, 0);
});

test("an answer that lands after the window hid delivers but schedules nothing", async () => {
  const clock = fakeClock();
  let visible = true;
  const gate = deferred<NetStatusReport>();
  const results: unknown[] = [];
  const poller = createNetStatusPoller({
    probe: () => gate.promise,
    onResult: (value) => results.push(value),
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => visible,
  });

  poller.start();
  await flush();
  visible = false;
  poller.setVisible(false);
  gate.resolve(online);
  await flush();
  assert.deepEqual(results, [online], "the in-flight answer is still useful");
  assert.equal(clock.pending.length, 0, "but the hidden window does not arm another timer");
});

test("refresh cancels the waiting gap and passes force through", async () => {
  const clock = fakeClock();
  const calls: boolean[] = [];
  const poller = createNetStatusPoller({
    probe: async (force) => {
      calls.push(force);
      return online;
    },
    onResult: () => undefined,
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  const waiting = at(clock.pending, 0).id;
  poller.refresh(true);
  assert.deepEqual(clock.cleared, [waiting]);
  assert.equal(clock.pending.length, 0);

  await flush();
  assert.deepEqual(calls, [false, true]);
  assert.equal(clock.pending.length, 1);
  assert.equal(at(clock.pending, 0).ms, NET_POLL_MS);
});

test("a burst while in flight coalesces into one trailing forced probe", async () => {
  const clock = fakeClock();
  const gates = [deferred<NetStatusReport>(), deferred<NetStatusReport>()];
  const calls: boolean[] = [];
  const results: unknown[] = [];
  const poller = createNetStatusPoller({
    probe: (force) => {
      calls.push(force);
      return at(gates, calls.length - 1).promise;
    },
    onResult: (value) => results.push(value),
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  poller.refresh(true);
  poller.refresh(false);
  poller.refresh(true);
  assert.deepEqual(calls, [false], "no concurrent net_status calls");

  at(gates, 0).resolve(online);
  await flush();
  assert.deepEqual(calls, [false, true], "the queued probe is forced");
  assert.deepEqual(results, [online]);
  assert.equal(clock.pending.length, 0, "the second probe is still in flight");

  at(gates, 1).resolve(degraded);
  await flush();
  assert.deepEqual(results, [online, degraded]);
  assert.equal(clock.pending.length, 1);
});

test("focus and visibility nudges do not stack behind the probe already running", async () => {
  const clock = fakeClock();
  const gate = deferred<NetStatusReport>();
  const calls: boolean[] = [];
  const poller = createNetStatusPoller({
    probe: async (force) => {
      calls.push(force);
      return gate.promise;
    },
    onResult: () => undefined,
    onError: () => assert.fail("unexpected failure"),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  poller.refresh(false);
  poller.refresh(false);
  assert.deepEqual(calls, [false]);

  gate.resolve(online);
  await flush();
  assert.deepEqual(calls, [false], "the running probe already answered the nudge");
  assert.equal(clock.pending.length, 1, "the regular cadence resumes");
});

test("a rejection reports once and the loop keeps its cadence", async () => {
  const clock = fakeClock();
  let fail = true;
  const errors: unknown[] = [];
  const results: unknown[] = [];
  const poller = createNetStatusPoller({
    probe: async () => {
      if (fail) throw new Error("ipc closed");
      return online;
    },
    onResult: (value) => results.push(value),
    onError: (err) => errors.push(err),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  assert.equal(errors.length, 1);
  assert.deepEqual(results, []);
  assert.equal(clock.pending.length, 1);

  fail = false;
  clock.fire();
  await flush();
  assert.equal(errors.length, 1);
  assert.deepEqual(results, [online]);
  assert.equal(clock.pending.length, 1);
});

test("stop mid-flight writes nothing and leaves no timer behind", async () => {
  const clock = fakeClock();
  const gate = deferred<NetStatusReport>();
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const poller = createNetStatusPoller({
    probe: () => gate.promise,
    onResult: (value) => results.push(value),
    onError: (err) => errors.push(err),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    isVisible: () => true,
  });

  poller.start();
  await flush();
  poller.stop();
  gate.reject(new Error("too late"));
  await flush();
  assert.deepEqual(results, []);
  assert.deepEqual(errors, []);
  assert.equal(clock.pending.length, 0);
  assert.throws(() => clock.fire(), /nothing is scheduled/);
});
