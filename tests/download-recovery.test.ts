/**
 * 恢复数据只含“未完成”、只读一次、坏数据逐行丢弃。这三条任何一条做错，
 * 都会让重启后的队列说假话（把历史当进行中，或把用户没要求的下载重新排队）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  captureRecovered,
  DOWNLOAD_RECOVERY_CAP,
  DOWNLOAD_RECOVERY_KEY,
  parseRecovered,
  readRecovered,
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

test("capture: 只保留 queued/running，去掉日志与进度，按原顺序、带上限", () => {
  const tasks = [
    task({ id: "run", status: "running" }),
    task({ id: "done", status: "done" }),
    task({ id: "q", status: "queued", targetDir: " D:/x ", overwrite: true }),
    task({ id: "fail", status: "failed" }),
  ];
  assert.deepEqual(captureRecovered(tasks), [
    { id: "run", ref: "owner/repo", source: "添加页", startedAt: 1_000 },
    {
      id: "q",
      ref: "owner/repo",
      source: "添加页",
      targetDir: "D:/x",
      overwrite: true,
      startedAt: 1_000,
    },
  ]);
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
  assert.deepEqual(parsed, [{ id: "recovered-0", ref: "a/b", source: "s", startedAt: 1 }]);
});

test("write/read: 空集合删除 key，非空往返保真", () => {
  const storage = fakeStorage();
  const rows = [{ id: "x", ref: "a/b", source: "s", startedAt: 9 }];
  writeRecovered(rows, storage);
  assert.deepEqual(readRecovered(storage), rows);
  writeRecovered([], storage);
  assert.equal(storage.map.has(DOWNLOAD_RECOVERY_KEY), false);
});

test("take: 读一次就清除，避免下次启动把历史又当恢复项", () => {
  const storage = fakeStorage(JSON.stringify({ version: 1, tasks: [{ ref: "a/b", source: "s", startedAt: 1 }] }));
  const first = takeRecovered(storage);
  assert.equal(first.length, 1);
  assert.equal(storage.map.has(DOWNLOAD_RECOVERY_KEY), false);
  assert.deepEqual(takeRecovered(storage), []);
});
