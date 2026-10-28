/**
 * `src/lib/queue-retention.ts` — 「删历史，不删工作」的边界。
 *
 * The failure this prevents is a long session silently accumulating every finished
 * download (and its bounded-but-large log). The failure it must NOT introduce is a
 * still-running task disappearing because it was enqueued long ago.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DownloadTask } from "../src/store/downloads.ts";
import { boundQueueTasks, finishedCount, QUEUE_FINISHED_CAP } from "../src/lib/queue-retention.ts";

function task(id: string, status: DownloadTask["status"]): DownloadTask {
  return {
    id,
    ref: `owner/${id}`,
    source: "test",
    startedAt: 0,
    log: [],
    stages: [],
    progress: null,
    outcome: null,
    failure: null,
    status,
    lastLine: "",
  };
}

test("活跃任务永不删除，即使排在很后面且已完成很多", () => {
  const tasks = [
    ...Array.from({ length: 60 }, (_, i) => task(`done-${i}`, "done")),
    task("running-old", "running"),
    task("queued-old", "queued"),
  ];
  const kept = boundQueueTasks(tasks, { cap: 5 });
  assert.deepEqual(kept.map((t) => t.id), [
    "done-0",
    "done-1",
    "done-2",
    "done-3",
    "done-4",
    "running-old",
    "queued-old",
  ]);
});

test("完成行按“最新优先”保留 cap 条；失败与完成一起计数", () => {
  const tasks = [
    task("d1", "done"),
    task("f1", "failed"),
    task("d2", "done"),
    task("f2", "failed"),
  ];
  assert.deepEqual(boundQueueTasks(tasks, { cap: 2 }).map((t) => t.id), ["d1", "f1"]);
  assert.equal(finishedCount(tasks), 4);
});

test("keep 指定的刚完成任务即使超出 cap 也保留（不能刚完成就消失）", () => {
  const tasks = [
    task("d1", "done"),
    task("d2", "done"),
    task("just", "done"),
  ];
  assert.deepEqual(
    boundQueueTasks(tasks, { cap: 2, keep: "just" }).map((t) => t.id),
    ["d1", "d2", "just"],
    "keep 只在其它行之后追加，不挤掉别的最新行",
  );
});

test("cap 为 0 时只保留活跃任务；负数被钳到 0", () => {
  const tasks = [task("d", "done"), task("r", "running")];
  assert.deepEqual(boundQueueTasks(tasks, { cap: 0 }).map((t) => t.id), ["r"]);
  assert.deepEqual(boundQueueTasks(tasks, { cap: -3 }).map((t) => t.id), ["r"]);
});

test("默认上限是有名字的常量", () => {
  assert.equal(QUEUE_FINISHED_CAP, 50);
  const tasks = Array.from({ length: 70 }, (_, i) => task(`d-${i}`, "done"));
  assert.equal(boundQueueTasks(tasks).length, 50);
});
