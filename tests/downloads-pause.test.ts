/**
 * 下载队列的暂停/继续（r25-N4）。
 *
 * 规则只有一条：**暂停作用在还没开始的排队行上**。它不碰已经在跑的 git 子进程
 * ——后端没有 suspend 接口，杀掉进程只会留下写了一半的落位目录。所以这里钉三件事：
 *
 *   1. `isPausable` 只认 `queued`，`running`/`done`/`failed` 都不行；
 *   2. `startableTasks` 是调度器的纯选择函数：跳过暂停行、遵守剩余槽位、仍按
 *      「等得最久优先」的服务顺序取人；
 *   3. 暂停行不进入重启恢复——它从未开始，也就没有「上次没下完」可解释。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countByStatus,
  inServiceOrder,
  isPausable,
  startableTasks,
  useDownloads,
  type DownloadTask,
} from "../src/store/downloads.ts";
import { captureRecovered } from "../src/lib/download-recovery.ts";
import { at } from "./helpers/definite.ts";

function task(over: Partial<DownloadTask> & { id: string }): DownloadTask {
  return {
    ref: "owner/repo",
    source: "manual",
    startedAt: 0,
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

test("isPausable: 只有排队行可以暂停", () => {
  assert.equal(isPausable({ status: "queued" }), true);
  for (const status of ["running", "done", "failed"] as const) {
    assert.equal(isPausable({ status }), false, `${status} 没有暂停语义`);
  }
});

test("startableTasks: 跳过暂停行，并保持服务顺序（等得最久优先）", () => {
  // tasks is newest-first on screen; service order is its reverse.
  const newest = task({ id: "newest", startedAt: 3 });
  const middle = task({ id: "middle", startedAt: 2 });
  const oldest = task({ id: "oldest", startedAt: 1 });
  const tasks = [newest, middle, oldest];
  assert.deepEqual(
    inServiceOrder(tasks).map((t) => t.id),
    ["oldest", "middle", "newest"],
  );

  // One slot goes to the oldest waiting row.
  assert.deepEqual(
    startableTasks(tasks, 1).map((t) => t.id),
    ["oldest"],
  );

  // The oldest is held: the slot goes to the next in line, not to the newest.
  at(tasks, 2).paused = true;  assert.deepEqual(
    startableTasks(tasks, 1).map((t) => t.id),
    ["middle"],
  );

  // Two slots skip the held row again.
  assert.deepEqual(
    startableTasks(tasks, 2).map((t) => t.id),
    ["middle", "newest"],
  );
});

test("startableTasks: 只取 queued；槽位为 0/负数/非有限数时不取人", () => {
  const tasks = [
    task({ id: "done", status: "done" }),
    task({ id: "running", status: "running" }),
    task({ id: "failed", status: "failed" }),
    task({ id: "queued", status: "queued" }),
  ];
  assert.deepEqual(
    startableTasks(tasks, 10).map((t) => t.id),
    ["queued"],
  );
  for (const slots of [0, -1, NaN, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(startableTasks(tasks, slots), [], `slots=${String(slots)} must start nothing`);
  }
});

test("countByStatus: paused 是 queued 的子集，不是第五种状态", () => {
  const tally = countByStatus([
    task({ id: "q1" }),
    task({ id: "q2", paused: true }),
    task({ id: "r", status: "running" }),
    task({ id: "d", status: "done" }),
    task({ id: "f", status: "failed" }),
  ]);
  assert.deepEqual(tally, { running: 1, queued: 2, paused: 1, failed: 1, finished: 2 });
});

test("pause/resume: 只改暂停位；running 行暂停是 no-op", () => {
  const running = task({ id: "r", status: "running" });
  const queued = task({ id: "q", status: "queued" });
  // maxParallel=1 and one running row ⇒ resume() finds zero free slots, so this
  // test never reaches `invoke()` (there is no Tauri runtime under node:test).
  useDownloads.setState({ tasks: [queued, running], maxParallel: 1 });

  useDownloads.getState().pause("r");
  assert.equal(at(useDownloads.getState().tasks, 1).paused, undefined, "an in-flight clone cannot be paused");

  useDownloads.getState().pause("q");
  assert.equal(at(useDownloads.getState().tasks, 0).paused, true);

  useDownloads.getState().resume("q");
  assert.equal(at(useDownloads.getState().tasks, 0).paused, false);
  assert.equal(at(useDownloads.getState().tasks, 0).status, "queued", "the free slot belongs to the running row");

  useDownloads.getState().pause("missing");
  assert.equal(useDownloads.getState().tasks.length, 2, "an unknown id is ignored");
});

test("恢复快照跳过暂停行：从未开始就没有「上次没下完」", () => {
  const rows = [
    task({ id: "paused", paused: true }),
    task({ id: "queued" }),
    task({ id: "running", status: "running" }),
  ];
  assert.deepEqual(
    captureRecovered(rows).map((r) => r.id),
    ["queued", "running"],
  );
});
