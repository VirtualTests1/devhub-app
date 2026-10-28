/**
 * 下载取消的队列语义（r27-O2）。
 *
 * 取消是两段式的：前端先记 `cancelRequested`（按钮进入「取消中…」），后端杀掉
 * 进程树后以失败收尾。这里钉住收尾时的判定：
 *
 *   - 取消请求 + 失败 ⇒ `cancelled`，不计入 `doneSeq`（墙不该刷新）；
 *   - 取消请求 + 成功 ⇒ `done`，因为克隆真的落盘了，谎称取消比晚到更糟；
 *   - `cancelled` 属于「已完成」一侧：保留上界、清除已完成、恢复快照都按它算；
 *   - 非 running 行调用 cancel 不改变任何状态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countByStatus,
  useDownloads,
  type DownloadTask,
} from "../src/store/downloads.ts";
import { boundQueueTasks } from "../src/lib/queue-retention.ts";
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
    status: "running",
    lastLine: "",
    ...over,
  };
}

test("finish: 取消请求 + 失败 ⇒ cancelled，failure 清空且不增加 doneSeq", () => {
  const t = task({ id: "c1", cancelRequested: true });
  useDownloads.setState({ tasks: [t], maxParallel: 1 });
  const before = useDownloads.getState().doneSeq;

  useDownloads.getState().finish("c1", null, "已取消");

  const row = at(useDownloads.getState().tasks, 0);
  assert.equal(row.status, "cancelled");
  assert.equal(row.failure, null, "内部错误串不是用户可见的失败原因");
  assert.equal(row.cancelRequested, false);
  assert.equal(useDownloads.getState().doneSeq, before, "取消没有移动磁盘上的任何仓库");
});

test("finish: 取消请求 + 成功 ⇒ done（调用是真的赢了竞态）", () => {
  const t = task({ id: "c2", cancelRequested: true });
  useDownloads.setState({ tasks: [t], maxParallel: 1 });
  const before = useDownloads.getState().doneSeq;
  const outcome = {
    layer: "direct" as const,
    path: "D:/项目/x",
    attempts: [],
    degraded: false,
    viaThirdParty: false,
  };

  useDownloads.getState().finish("c2", outcome as never, null);

  const row = at(useDownloads.getState().tasks, 0);
  assert.equal(row.status, "done");
  assert.equal(useDownloads.getState().doneSeq, before + 1);
});

test("countByStatus / boundQueueTasks / 恢复快照都把 cancelled 当已完成", () => {
  const cancelled = task({ id: "c", status: "cancelled" });
  const done = task({ id: "d", status: "done" });
  const running = task({ id: "r" });

  const tally = countByStatus([cancelled, done, running]);
  assert.deepEqual(tally, { running: 1, queued: 0, paused: 0, failed: 0, finished: 2 });

  // Cap 1 keeps the newer of the two finished rows and never drops the active one.
  const bounded = boundQueueTasks([cancelled, done, running], { cap: 1 });
  assert.deepEqual(bounded.map((t) => t.id), ["c", "r"]);

  assert.deepEqual(
    captureRecovered([cancelled, done, running]).map((t) => t.id),
    ["r"],
    "a cancelled row has nothing left to recover",
  );
});

test("cancel: 非 running 行是 no-op", () => {
  for (const status of ["queued", "done", "failed", "cancelled"] as const) {
    const t = task({ id: status, status });
    useDownloads.setState({ tasks: [t], maxParallel: 1 });
    useDownloads.getState().cancel(status);
    assert.equal(
      at(useDownloads.getState().tasks, 0).cancelRequested,
      undefined,
      `${status} 不该进入取消中`,
    );
  }
});
