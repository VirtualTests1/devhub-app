/**
 * The settled-history payload: bounded, redacted, read-only.
 *
 * Recovery deliberately carries only work that still needs attention. This
 * payload is the other half — enough of a finished row to know what happened
 * after a restart, without turning localStorage into a log archive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HISTORY_CAP,
  HISTORY_LOG_CHARS,
  captureHistory,
  parseHistory,
  readHistory,
  tailOfLog,
  writeHistory,
  type HistorySourceTask,
} from "../src/lib/download-history.ts";

function task(over: Partial<HistorySourceTask> = {}): HistorySourceTask {
  return {
    id: "t1",
    ref: "owner/repo",
    source: "test",
    startedAt: 1_000,
    endedAt: 2_000,
    status: "done",
    log: ["a", "b"],
    ...over,
  };
}

test("only settled rows enter history; queued, running and failed stay out", () => {
  const rows = captureHistory([
    task({ id: "done", status: "done" }),
    task({ id: "cancelled", status: "cancelled" }),
    task({ id: "failed", status: "failed", failure: "boom" }),
    task({ id: "running", status: "running", endedAt: undefined }),
    task({ id: "queued", status: "queued", endedAt: undefined }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["done", "cancelled"]);
});

test("newest settlement first, capped at HISTORY_CAP", () => {
  const tasks = Array.from({ length: HISTORY_CAP + 5 }, (_, i) =>
    task({ id: `t${i}`, endedAt: 10_000 + i }),
  );
  const rows = captureHistory(tasks);
  assert.equal(rows.length, HISTORY_CAP);
  assert.equal(rows[0]?.id, `t${HISTORY_CAP + 4}`);
  assert.equal(rows[rows.length - 1]?.id, "t5");
});

test("the log tail keeps the end, redacts credentials and stays bounded", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  lines.push("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  const tail = tailOfLog(lines);
  assert.ok(tail.includes("[redacted]"), "a credential shape must not survive into storage");
  assert.ok(!tail.includes("ghp_"), "the raw token must be gone");
  assert.ok(tail.includes("line 29"), "the end of the log is the part that explains a failure");
  assert.ok(!tail.includes("line 0"), "the head is dropped to keep the payload bounded");
  assert.ok(tail.length <= HISTORY_LOG_CHARS);
});

test("a 4,000-character log is cut from the front, never over the cap", () => {
  const tail = tailOfLog(["x".repeat(4_000)]);
  assert.ok(tail.length <= HISTORY_LOG_CHARS, `len=${tail.length}`);
  assert.ok(tail.startsWith("…"), "an explicit truncation marker");
});

test("the payload round-trips through storage and clears when empty", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  writeHistory(
    captureHistory([
      task({ id: "a", status: "done", outcome: { path: "D:/proj/a" } }),
      task({ id: "b", status: "cancelled", failure: "用户取消" }),
    ]),
    storage,
  );
  const back = readHistory(storage);
  assert.equal(back.length, 2);
  assert.equal(back.find((r) => r.id === "a")?.path, "D:/proj/a");
  assert.equal(back.find((r) => r.id === "b")?.failure, "用户取消");
  writeHistory([], storage);
  assert.equal(map.has("devhub.downloads.history.v1"), false, "an empty history removes the key");
});

test("malformed rows are dropped one by one, not thrown", () => {
  const raw = JSON.stringify({
    version: 1,
    entries: [
      { id: "ok", ref: "o/r", source: "s", status: "done", startedAt: 1, endedAt: 2, logTail: "" },
      { id: "bad-status", ref: "o/r", source: "s", status: "running", startedAt: 1, endedAt: 2 },
      { id: "bad-time", ref: "o/r", source: "s", status: "done", startedAt: 1 },
      null,
    ],
  });
  assert.deepEqual(parseHistory(raw).map((r) => r.id), ["ok"]);
  assert.deepEqual(parseHistory("{not json"), []);
  assert.deepEqual(parseHistory(JSON.stringify({ entries: "nope" })), []);
});

test("the queue renders the history section and its actions", () => {
  const src = readFileSync(resolve(process.cwd(), "src/components/DownloadQueue.tsx"), "utf8");
  assert.match(src, /<QueueHistory entries=\{history\} onClear=\{clearHistory\} \/>/);
  assert.match(src, /queue\.historyTitle/);
  assert.match(src, /queue\.historyClear/);
  assert.match(src, /copyLogWithToast\(/);
});
