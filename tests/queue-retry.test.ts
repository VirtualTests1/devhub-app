/**
 * 失败任务批量重试（r28-N2）。
 *
 * Resetting a failed row in place keeps its ref/targetDir/branch and avoids the
 * duplicate-row race a "dismiss then add" batch would create. The scheduler is
 * intentionally left with zero slots in this test, so no Tauri invoke runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useDownloads, type DownloadTask } from "../src/store/downloads.ts";
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
    status: "failed",
    lastLine: "",
    ...over,
  };
}

test("retryFailed: resets only failed rows and preserves retry inputs", () => {
  const failed = task({
    id: "f1",
    ref: "a/b",
    branch: "feature/x",
    targetDir: "D:/x",
    failure: "boom",
    interrupted: true,
    endedAt: 5,
  });
  const done = task({ id: "d1", status: "done", endedAt: 6 });
  const running = task({ id: "r1", status: "running" });
  useDownloads.setState({ tasks: [failed, done, running], maxParallel: 0 });

  assert.equal(useDownloads.getState().retryFailed(), 1);
  const after = useDownloads.getState().tasks;
  assert.equal(at(after, 0).status, "queued");
  assert.equal(at(after, 0).failure, null);
  assert.equal(at(after, 0).outcome, null);
  assert.equal(at(after, 0).branch, "feature/x");
  assert.equal(at(after, 0).targetDir, "D:/x");
  assert.equal(at(after, 0).interrupted, false);
  assert.ok(at(after, 0).log.some((l) => l.includes("重新排队")));
  assert.equal(at(after, 1).status, "done", "done rows are untouched");
  assert.equal(at(after, 2).status, "running", "running rows are untouched");
  assert.equal(useDownloads.getState().retryFailed(), 0, "nothing left to retry");
});

test("queue header exposes retry-failed only through the store action", () => {
  const src = readFileSync("src/components/DownloadQueue.tsx", "utf8");
  assert.match(src, /const retryFailed = useDownloads\(\(s\) => s\.retryFailed\)/);
  assert.match(src, /tally\.failed > 0/);
  assert.match(src, /t\("queue\.retryFailed", \{ n: tally\.failed \}\)/);
  assert.match(src, /const n = retryFailed\(\)/);
});
