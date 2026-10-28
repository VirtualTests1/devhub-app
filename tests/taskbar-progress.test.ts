/**
 * `src/lib/taskbar-progress.ts` — 一个窗口只有一条任务栏进度。
 *
 * 队列可能同时跑三个下载，所以这里钉的是“应用整体”的口径：平均百分比、未知即
 * indeterminate、错误只在队列里没有活动任务时显示。节流只压进度帧，状态切换不被压。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldPushTaskbar,
  taskbarChanged,
  taskbarProgressOf,
  taskbarTasksFrom,
  TASKBAR_MIN_INTERVAL_MS,
  type TaskbarTask,
} from "../src/lib/taskbar-progress.ts";

const t = (status: TaskbarTask["status"], percent: number | null = null): TaskbarTask => ({ status, percent });

test("没有未完成的任务：有失败 → error，否则隐藏", () => {
  assert.deepEqual(taskbarProgressOf([t("done"), t("done")]), { status: "none" });
  assert.deepEqual(taskbarProgressOf([t("done"), t("failed")]), { status: "error", progress: 100 });
  assert.deepEqual(taskbarProgressOf([]), { status: "none" });
});

test("只有排队：0% normal（任务栏说明“有活但还没开始”）", () => {
  assert.deepEqual(taskbarProgressOf([t("queued"), t("queued")]), { status: "normal", progress: 0 });
});

test("单个运行：有百分比就用，没有就 indeterminate", () => {
  assert.deepEqual(taskbarProgressOf([t("running", 42)]), { status: "normal", progress: 42 });
  assert.deepEqual(taskbarProgressOf([t("running", null)]), { status: "indeterminate" });
});

test("多个运行：全部已知才平均，任一未知就 indeterminate", () => {
  assert.deepEqual(taskbarProgressOf([t("running", 10), t("running", 30)]), {
    status: "normal",
    progress: 20,
  });
  assert.deepEqual(taskbarProgressOf([t("running", 10), t("running", null)]), {
    status: "indeterminate",
  });
});

test("完成/失败的行不影响正在运行的进度", () => {
  assert.deepEqual(taskbarProgressOf([t("running", 50), t("failed"), t("done")]), {
    status: "normal",
    progress: 50,
  });
});

test("百分比钳位到 0–100，并四舍五入", () => {
  assert.deepEqual(taskbarProgressOf([t("running", 150)]), { status: "normal", progress: 100 });
  assert.deepEqual(taskbarProgressOf([t("running", -5)]), { status: "normal", progress: 0 });
  assert.deepEqual(taskbarProgressOf([t("running", 33.4)]), { status: "normal", progress: 33 });
});

test("taskbarChanged: 状态或数字任一变化才算变化", () => {
  assert.equal(taskbarChanged(null, { status: "none" }), true);
  assert.equal(taskbarChanged({ status: "normal", progress: 10 }, { status: "normal", progress: 10 }), false);
  assert.equal(taskbarChanged({ status: "normal", progress: 10 }, { status: "normal", progress: 11 }), true);
  assert.equal(taskbarChanged({ status: "none" }, { status: "error", progress: 100 }), true);
});

test("shouldPush: 进度帧按 250ms 节流，状态切换立即通过", () => {
  const normal10 = { status: "normal" as const, progress: 10 };
  const normal11 = { status: "normal" as const, progress: 11 };
  const error = { status: "error" as const, progress: 100 };
  assert.equal(shouldPushTaskbar(null, normal10, 0, 0), true, "首帧必须发出");
  assert.equal(shouldPushTaskbar(normal10, normal11, 100, 0), false, "间隔不足的进度变化被压");
  assert.equal(
    shouldPushTaskbar(normal10, normal11, TASKBAR_MIN_INTERVAL_MS, 0),
    true,
    "到达间隔后放行",
  );
  assert.equal(shouldPushTaskbar(normal10, error, 100, 0), true, "错误是状态切换，不节流");
  assert.equal(shouldPushTaskbar(normal11, normal11, 1_000, 0), false, "同一个值不重复推");
});


test("taskbarTasksFrom: 百分比来自 git 进度行（与面板同一个解析器）", () => {
  const rows = taskbarTasksFrom([
    { status: "running", progress: { message: "Receiving objects:  45% (1/2), 3.40 MiB/s" } },
    { status: "running", progress: { message: "remote: Counting objects" } },
    { status: "queued" },
  ]);
  assert.deepEqual(rows, [
    { status: "running", percent: 45 },
    { status: "running", percent: null },
    { status: "queued", percent: null },
  ]);
  assert.deepEqual(taskbarProgressOf(rows), { status: "indeterminate" });
});
