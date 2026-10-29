/**
 * Download diagnostics: the kind a failure belongs to, the remedy that follows,
 * the redaction of credential shapes, and the report's bounds.
 *
 * These are the decisions the queue's copy button and the failed card's hint
 * both depend on. The UI halves are pinned by source reading at the bottom,
 * because Node cannot render `.tsx`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDownloadDiagnostics,
  classifyDownloadFailure,
  failureHintText,
  failureInfoOf,
  kindCounts,
  redactSecrets,
  type DiagnosticTask,
} from "../src/lib/download-diagnostics.ts";

const task = (over: Partial<DiagnosticTask> = {}): DiagnosticTask => ({
  ref: "owner/repo",
  source: "添加页",
  status: "failed",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  failure: "fatal: unable to access ...",
  log: ["line one", "line two"],
  ...over,
});

test("classify: the concrete symptom picks the kind, and cancellation wins first", () => {
  assert.equal(classifyDownloadFailure("操作已取消"), "cancelled");
  assert.equal(classifyDownloadFailure("fatal: Authentication failed for 'https://github.com/x'"), "auth");
  assert.equal(classifyDownloadFailure("remote: Repository not found."), "notFound");
  assert.equal(classifyDownloadFailure("fatal: No space left on device"), "disk");
  assert.equal(classifyDownloadFailure("目标目录已存在且非空"), "target");
  assert.equal(classifyDownloadFailure("fatal: unable to access 'https://…': Recv failure: Connection was reset"), "network");
  assert.equal(classifyDownloadFailure("API rate limit exceeded"), "network");
  assert.equal(classifyDownloadFailure("fatal: not a git repository (or any parent)"), "git");
  assert.equal(classifyDownloadFailure("something nobody expected"), "unknown");
  assert.equal(classifyDownloadFailure("", []), "unknown");
});

test("classify: the log tail can supply the symptom when the failure text is vague", () => {
  assert.equal(classifyDownloadFailure("下载失败", ["fatal: could not resolve host: github.com"]), "network");
  assert.equal(classifyDownloadFailure(null, ["fatal: No space left on device"]), "disk");
  assert.equal(classifyDownloadFailure("", ["Authentication failed"]), "auth");
});

test("kind → label and advice keys are stable, and the one-line hint resolves", () => {
  const info = failureInfoOf("fatal: Authentication failed");
  assert.equal(info.kind, "auth");
  assert.equal(info.labelKey, "diag.kind.auth");
  assert.equal(info.hintKey, "diag.hint.auth");
  const hint = failureHintText("fatal: Authentication failed");
  assert.ok(hint.includes("凭据/权限"), hint);
  assert.ok(hint.includes("令牌"), hint);
});

test("kindCounts counts only failures", () => {
  const counts = kindCounts([
    task({ failure: "Authentication failed" }),
    task({ failure: "Authentication failed" }),
    task({ failure: "No space left on device" }),
    task({ status: "done", failure: null }),
  ]);
  assert.equal(counts.get("auth"), 2);
  assert.equal(counts.get("disk"), 1);
  assert.equal(counts.size, 2);
});

test("redaction removes credential shapes without eating ordinary log text", () => {
  const text = [
    "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "x-access-token:secret-value@github.com",
    "Authorization: Bearer abc.def.ghi",
    "password: hunter2",
    "the token was rejected", // no value after a separator: kept as a sentence
  ].join("\n");
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(!redacted.includes("github_pat_11ABCDEFG"));
  assert.ok(!redacted.includes("secret-value"));
  assert.ok(!redacted.includes("abc.def.ghi"));
  assert.ok(!redacted.includes("hunter2"));
  assert.ok(redacted.includes("the token was rejected"));
  assert.ok(redacted.includes("[redacted]"));
});

test("report: counts, failure sections, log tail bounds and no secrets", () => {
  const text = buildDownloadDiagnostics(
    [
      task({
        ref: "good/repo",
        status: "done",
        failure: null,
        targetDir: "D:\\项目\\good",
      }),
      task({
        ref: "bad/repo",
        failure: "fatal: Authentication failed for https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r",
        log: ["one", "two", "three", "four"],
        branch: "main",
      }),
    ],
    {
      appVersion: "9.9.9",
      platform: "test-platform",
      now: new Date("2026-10-29T12:00:00Z"),
      logLines: 2,
    },
  );
  assert.ok(text.startsWith("DevHub 下载诊断"), text);
  assert.ok(text.includes("9.9.9"));
  assert.ok(text.includes("test-platform"));
  assert.ok(text.includes("2026-10-29T12:00:00.000Z"));
  assert.ok(text.includes("共 2"));
  assert.ok(text.includes("bad/repo"));
  assert.ok(text.includes("main"));
  assert.ok(text.includes("凭据/权限"));
  assert.ok(text.includes("one") === false, "the log tail keeps only the last two lines");
  assert.ok(text.includes("three") && text.includes("four"));
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(text.includes("[redacted]"));
});

test("report: no failures states that instead of ending at the header", () => {
  const text = buildDownloadDiagnostics([task({ status: "done", failure: null, log: [] })], {
    appVersion: "1",
    platform: "p",
  });
  assert.ok(text.includes("没有失败任务"));
});

test("report: character ceiling is enforced with an explicit truncation notice", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(80)}`);
  const text = buildDownloadDiagnostics([task({ log: long })], {
    appVersion: "1",
    platform: "p",
    maxChars: 400,
    logLines: 200,
  });
  assert.ok(text.length < 500, `bounded report, got ${text.length}`);
  assert.ok(text.includes("（诊断已截断）"));
});

test("UI wiring: failed cards explain the kind and the queue can copy the report", () => {
  const progress = readFileSync("src/components/DownloadProgress.tsx", "utf8");
  const queue = readFileSync("src/components/DownloadQueue.tsx", "utf8");
  assert.match(progress, /failureInfoOf\(failure, log\)/);
  assert.match(progress, /t\("dl\.failureHint"/);
  assert.match(queue, /buildDownloadDiagnostics\(useDownloads\.getState\(\)\.tasks/);
  assert.match(queue, /t\("queue\.copyDiagnostics"\)/);
  assert.match(queue, /navigator\.clipboard\.writeText\(text\)/);
});
