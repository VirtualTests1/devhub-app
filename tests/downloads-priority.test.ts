/**
 * 优先下载 is a scheduling rule, not a visual reorder.
 *
 * The queue displays newest-first and serves oldest-first, so "move it up" is
 * not a coherent instruction. The flag is: marked queued rows are served before
 * unmarked ones, and within each group the longest-waiting row still goes first.
 * These tests pin that rule, the paused-row exemption, and the recovery payload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { startableTasks, type DownloadTask } from "../src/store/downloads.ts";
import { captureRecovered, parseRecovered, writeRecovered, readRecovered } from "../src/lib/download-recovery.ts";

function task(id: string, over: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id,
    ref: `owner/${id}`,
    source: "test",
    startedAt: 1,
    log: [],
    stages: [],
    progress: null,
    outcome: null,
    failure: null,
    status: "queued",
    lastLine: "",
    ...over,
  };
}

test("priority rows are served first; oldest-first still holds inside each group", () => {
  // Display array: newest first. Service order is a, b, c.
  const tasks = [
    task("c", { startedAt: 3 }),
    task("b", { startedAt: 2, priority: true }),
    task("a", { startedAt: 1 }),
  ];
  assert.deepEqual(
    startableTasks(tasks, 1).map((t) => t.id),
    ["b"],
    "the marked row takes the only slot",
  );
  assert.deepEqual(
    startableTasks(tasks, 2).map((t) => t.id),
    ["b", "a"],
    "the unmarked group keeps its oldest-first order",
  );
});

test("a paused priority row is still invisible to the scheduler", () => {
  const tasks = [task("a"), task("b", { priority: true, paused: true })];
  assert.deepEqual(startableTasks(tasks, 2).map((t) => t.id), ["a"]);
});

test("the flag on a running or settled row has no scheduling effect", () => {
  const tasks = [
    task("run", { status: "running", priority: true }),
    task("done", { status: "done", priority: true }),
    task("queued"),
  ];
  assert.deepEqual(startableTasks(tasks, 3).map((t) => t.id), ["queued"]);
  assert.deepEqual(startableTasks(tasks, 0), []);
});

test("a queued row's priority survives the recovery payload", () => {
  const recovered = captureRecovered([task("a", { priority: true }), task("b")]);
  assert.equal(recovered.find((r) => r.ref === "owner/a")?.priority, true);
  assert.equal(recovered.find((r) => r.ref === "owner/b")?.priority, undefined);

  const parsed = parseRecovered(JSON.stringify({ version: 2, tasks: recovered }));
  assert.equal(parsed.find((r) => r.ref === "owner/a")?.priority, true);

  const store = new Map<string, string>();
  writeRecovered(recovered, {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  });
  assert.equal(readRecovered({
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  }).find((r) => r.ref === "owner/a")?.priority, true);
});

test("a failed row does not carry a priority flag into recovery", () => {
  const recovered = captureRecovered([task("a", { status: "failed", failure: "boom", priority: true })]);
  assert.equal(recovered[0]?.priority, undefined, "only a queued row can be prioritised");
});

test("the queue row and menu actually expose the toggle", () => {
  const src = readFileSync(resolve(process.cwd(), "src/components/DownloadQueue.tsx"), "utf8");
  assert.match(src, /setPriority\(id, task\.priority !== true\)/, "the toggle must be wired, not decorative");
  assert.match(src, /aria-pressed=\{task\.priority === true\}/, "the flag is a toggle for assistive tech");
  assert.match(src, /queue\.menuPriority/, "the context menu offers the same action");
  assert.match(src, /<Flag\b/, "the control is visible");
});
