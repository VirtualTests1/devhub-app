/**
 * The queue's preflight decision (r31-O2).
 *
 * Filesystem facts come from Rust; this file pins what the queue does with
 * them: a long path or an occupied directory without Overwrite refuses before
 * git, free space is reported rather than guessed, and an explicit overwrite
 * lets an occupied target through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  preflightFailureText,
  preflightPassedLine,
  preflightProblem,
} from "../src/lib/download-preflight.ts";
import type { DownloadPreflight } from "../src/types.ts";

const facts = (over: Partial<DownloadPreflight> = {}): DownloadPreflight => ({
  target: "D:/项目/tool_owner",
  occupied: false,
  empty: false,
  freeBytes: 2 * 1024 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024 * 1024,
  pathError: null,
  ...over,
});

test("preflight: path error wins, then occupied without overwrite", () => {
  assert.equal(preflightProblem(facts({ pathError: "too long" }), true), "path");
  assert.equal(preflightProblem(facts({ occupied: true }), false), "occupied");
  assert.equal(preflightProblem(facts({ occupied: true }), true), null);
  assert.equal(preflightProblem(facts(), false), null);
});

test("preflight: refusal text names the target and the two ways forward", () => {
  const text = preflightFailureText(facts({ occupied: true }), false);
  assert.ok(text?.includes("D:/项目/tool_owner"), text ?? "");
  assert.ok(text?.includes("覆盖"), text ?? "");
  assert.equal(preflightFailureText(facts(), false), null);
  assert.ok(preflightFailureText(facts({ pathError: "x" }), false)?.includes("x"));
});

test("preflight: a passed line reports the free space in binary units", () => {
  const line = preflightPassedLine(facts());
  assert.ok(line.includes("2.00 GB"), line);
  assert.ok(line.includes("D:/项目/tool_owner"), line);
  const unknown = preflightPassedLine(facts({ freeBytes: null }));
  assert.ok(unknown.includes("未知"), unknown);
});

test("wiring: the queue asks preflight before download and handles cancellation", () => {
  const store = readFileSync("src/store/downloads.ts", "utf8");
  assert.match(store, /invoke<DownloadPreflight>\("download_preflight"/);
  assert.match(store, /preflightFailureText\(facts, pick\.overwrite \?\? false\)/);
  assert.match(store, /checking: true/);
  assert.match(store, /if \(task\.checking\)/);
  assert.match(store, /const res = await invoke<DownloadOutcome>\("download_repo"/);
});