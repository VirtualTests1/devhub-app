/**
 * `src/store/processes.ts` — the poll's identity rule.
 *
 * The poll runs every two seconds and feeds the repository wall. Before this
 * helper, every tick wrote a brand-new array into the store whether or not
 * anything changed, so `useLiveProcesses` re-rendered the wall (and re-ran its
 * filter/sort chain) forever — twice a second while idle, with nothing running.
 *
 * The rule is: a tick that only lets time pass is not a change. `elapsedMs` is
 * the one field that always moves, so it is the one field not compared; every
 * other `ProcessState` field is, because each is displayed somewhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sameProcessList, liveElapsedMs } from "../src/store/processes.ts";
import type { ProcessState } from "../src/types.ts";

const proc = (over: Partial<ProcessState> = {}): ProcessState => ({
  pid: 4000,
  label: "npm run dev",
  slug: "github.com/a/b",
  state: "running",
  exitCode: null,
  elapsedMs: 1000,
  stoppable: true,
  suspendable: true,
  ...over,
});

test("sameProcessList: a tick that only advanced elapsedMs is not a change", () => {
  assert.equal(sameProcessList([proc({ elapsedMs: 1000 })], [proc({ elapsedMs: 9100 })]), true);
});

test("sameProcessList: an idle wall (two empty polls) is not a change", () => {
  assert.equal(sameProcessList([], []), true);
});

test("sameProcessList: the same reference is equal without walking it", () => {
  const list = [proc()];
  assert.equal(sameProcessList(list, list), true);
});

test("sameProcessList: a process arriving, leaving or exiting IS a change", () => {
  assert.equal(sameProcessList([], [proc()]), false);
  assert.equal(sameProcessList([proc()], []), false);
  assert.equal(sameProcessList([proc()], [proc({ state: "exited", elapsedMs: 2000 })]), false);
  // The exit code is what 已退出（代码 N） reads, so it must not be merged away.
  assert.equal(
    sameProcessList(
      [proc({ state: "exited", exitCode: 1 })],
      [proc({ state: "exited", exitCode: 0 })],
    ),
    false,
  );
});

test("sameProcessList: what the badge shows is compared — label and slug", () => {
  assert.equal(sameProcessList([proc()], [proc({ label: "pnpm dev" })]), false);
  assert.equal(sameProcessList([proc()], [proc({ slug: "gitee.com/a/b" })]), false);
});

test("sameProcessList: stoppable/suspendable flip without a state change", () => {
  // A process that detaches becomes un-stoppable while still `running`; leaving
  // these out would freeze the strip's 停止 button in its old enabled state.
  assert.equal(sameProcessList([proc()], [proc({ stoppable: false })]), false);
  assert.equal(sameProcessList([proc()], [proc({ suspendable: false })]), false);
});

test("sameProcessList: the same processes in a different order are not equal", () => {
  const a = proc({ pid: 1 });
  const b = proc({ pid: 2 });
  assert.equal(sameProcessList([a, b], [b, a]), false);
});

test("sameProcessList: a re-used pid is a different process", () => {
  assert.equal(sameProcessList([proc({ pid: 1 })], [proc({ pid: 2 })]), false);
});

// The store stopped advancing on an idle tick, so a live clock is derived from
// (reported value, moment it was reported) instead of read per render — `RepoTile`
// depends on this for the 已启动 line in its tooltip.
test("liveElapsedMs: adds the wall time since the value was reported", () => {
  assert.equal(liveElapsedMs(1000, 5000, 8000), 4000);
});

test("liveElapsedMs: at the reported moment it is the reported value", () => {
  assert.equal(liveElapsedMs(1000, 5000, 5000), 1000);
});

test("liveElapsedMs: a clock that reads behind the report never rewinds it", () => {
  // The Rust side times from `Instant`, this side from `Date.now()`; when the
  // re-basing render happens a hair *before* the value it carries, the line must
  // hold its number rather than tick backwards on the tooltip.
  assert.equal(liveElapsedMs(9000, 5000, 4000), 9000);
  assert.equal(liveElapsedMs(0, 5000, 4999), 0);
});
