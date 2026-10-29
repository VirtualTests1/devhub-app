/**
 * Recovery keeps each row's real history: queued rows restore paused, running
 * rows restore as interrupted failures, failed rows restore with their reason.
 * Nothing starts automatically, and bad payloads lose rows rather than throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureRecovered,
  DOWNLOAD_RECOVERY_CAP,
  DOWNLOAD_RECOVERY_KEY,
  parseRecovered,
  readRecovered,
  RECOVERY_FAILURE_MAX,
  takeRecovered,
  writeRecovered,
  type RecoverySourceTask,
} from "../src/lib/download-recovery.ts";

const task = (over: Partial<RecoverySourceTask> = {}): RecoverySourceTask => ({
  id: "t1",
  ref: "owner/repo",
  source: "添加页",
  startedAt: 1_000,
  status: "running",
  ...over,
});

function fakeStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(DOWNLOAD_RECOVERY_KEY, seed);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("capture: queued/running/failed 保留状态，done/cancelled 丢弃", () => {
  const tasks = [
    task({ id: "run", status: "running", ref: "run/repo" }),
    task({ id: "done", status: "done", ref: "done/repo" }),
    task({ id: "q", status: "queued", ref: "q/repo", targetDir: " D:/x ", overwrite: true }),
    task({ id: "fail", status: "failed", ref: "bad/repo", failure: "鉴权失败", endedAt: 2_000 }),
    task({ id: "cancel", status: "cancelled", ref: "cancel/repo" }),
  ];
  assert.deepEqual(captureRecovered(tasks), [
    { id: "run", ref: "run/repo", source: "添加页", startedAt: 1_000, status: "running" },
    {
      id: "q",
      ref: "q/repo",
      source: "添加页",
      targetDir: "D:/x",
      overwrite: true,
      startedAt: 1_000,
      status: "queued",
    },
    {
      id: "fail",
      ref: "bad/repo",
      source: "添加页",
      startedAt: 1_000,
      status: "failed",
      failure: "鉴权失败",
      endedAt: 2_000,
    },
  ]);
});

test("capture: 同一 ref 优先保留仍有工作的行（失败行不挤掉排队行）", () => {
  const rows = captureRecovered([
    task({ id: "failed", status: "failed", failure: "timeout" }),
    task({ id: "queued", status: "queued" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "queued");
  assert.equal(rows[0]?.status, "queued");
});

test("capture: 暂停的排队行仍保留（恢复后由 store 置为暂停）", () => {
  const rows = captureRecovered([task({ id: "held", status: "queued", paused: true })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "queued");
});

test("capture: 条数上限与空 ref 过滤", () => {
  const many = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, ref: `o/r${i}` }));
  assert.equal(captureRecovered(many).length, DOWNLOAD_RECOVERY_CAP);
  assert.deepEqual(captureRecovered([task({ ref: "   " })]), []);
});

test("parse: 损坏 JSON/非数组/缺字段逐行丢弃，重复 ref 只留第一行", () => {
  assert.deepEqual(parseRecovered("{"), []);
  assert.deepEqual(parseRecovered(JSON.stringify({ version: 1 })), []);
  assert.deepEqual(parseRecovered(JSON.stringify({ version: 1, tasks: [null, 7, {}] })), []);
  const parsed = parseRecovered(
    JSON.stringify({
      version: 1,
      tasks: [
        { ref: "a/b", source: "s", startedAt: 1 },
        { ref: "a/b", source: "s2", startedAt: 2 },
        { ref: "c/d", source: 7, startedAt: 3 },
      ],
    }),
  );
  assert.deepEqual(parsed, [
    { id: "recovered-0", ref: "a/b", source: "s", startedAt: 1, status: "running" },
  ]);
});

test("parse: v1 行按 running 处理；v2 保留 queued/failed 与失败原因", () => {
  const v2 = parseRecovered(
    JSON.stringify({
      version: 2,
      savedAt: 9,
      tasks: [
        { id: "q", ref: "a/q", source: "s", startedAt: 1, status: "queued" },
        {
          id: "f",
          ref: "a/f",
          source: "s",
          startedAt: 2,
          status: "failed",
          failure: `  ${"x".repeat(RECOVERY_FAILURE_MAX + 20)}  `,
          endedAt: 3,
        },
        { id: "r", ref: "a/r", source: "s", startedAt: 4, status: "pruned" },
      ],
    }),
  );
  assert.equal(v2[0]?.status, "queued");
  assert.equal(v2[1]?.status, "failed");
  assert.equal(v2[1]?.endedAt, 3);
  assert.ok((v2[1]?.failure?.length ?? 0) <= RECOVERY_FAILURE_MAX);
  assert.ok(v2[1]?.failure?.endsWith("…"));
  assert.equal(v2[2]?.status, "running", "an unknown status must not become queued");
});

test("write/read: 空集合删除 key，非空往返保真", () => {
  const storage = fakeStorage();
  const rows = [
    { id: "x", ref: "a/b", source: "s", startedAt: 9, status: "queued" as const },
    { id: "y", ref: "c/d", source: "s", startedAt: 10, status: "failed" as const, failure: "no" },
  ];
  writeRecovered(rows, storage);
  assert.deepEqual(readRecovered(storage), rows);
  assert.equal(JSON.parse(storage.map.get(DOWNLOAD_RECOVERY_KEY) ?? "{}").version, 2);
  writeRecovered([], storage);
  assert.equal(storage.map.has(DOWNLOAD_RECOVERY_KEY), false);
});

test("take: 读一次就清除，避免下次启动把历史又当恢复项", () => {
  const storage = fakeStorage(
    JSON.stringify({ version: 1, tasks: [{ ref: "a/b", source: "s", startedAt: 1 }] }),
  );
  const first = takeRecovered(storage);
  assert.equal(first.length, 1);
  assert.equal(storage.map.has(DOWNLOAD_RECOVERY_KEY), false);
  assert.deepEqual(takeRecovered(storage), []);
});
