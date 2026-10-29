/**
 * Crash-report wiring (r30-R3): the next start asks once, the diagnostics card
 * reads the same file, and neither path invents an upload.
 *
 * The Rust side has its own unit tests for writing, reading and bounding the
 * report; this file pins the two frontend ends that Node can read as source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { tFor } from "../src/lib/i18n.ts";

const APP = readFileSync("src/App.tsx", "utf8");
const SECTION = readFileSync("src/views/settings/FailureHistorySection.tsx", "utf8");
const RUST = readFileSync("src-tauri/src/crash.rs", "utf8");

test("App: reads the report once and de-duplicates the toast by timestamp", () => {
  assert.match(APP, /invoke<CrashReport \| null>\("last_crash"\)/);
  assert.match(APP, /devhub\.crash\.toastSeen\.v1/);
  assert.match(APP, /t\("crash\.detected", \{ time: when \}\)/);
  assert.match(APP, /\.catch\(\(\) => undefined\)/, "a missing report is not a user-facing error");
});

test("diagnostics panel: shows, copies and clears the report through real commands", () => {
  assert.match(SECTION, /invoke<CrashReport \| null>\("last_crash"\)/);
  assert.match(SECTION, /invoke\("clear_crash"\)/);
  assert.match(SECTION, /redactSecrets\(report\.message\)/);
  assert.match(SECTION, /t\("crash\.copy"\)/);
  assert.match(SECTION, /t\("crash\.clear"\)/);
  assert.match(SECTION, /confirmDestructive\(t\("crash\.clearConfirm"\)/);
  assert.match(SECTION, /navigator\.clipboard\.writeText/);
});

test("Rust: one hook, bounded fields, atomic write and the two commands", () => {
  assert.match(RUST, /Once/);
  assert.match(RUST, /std::panic::set_hook/);
  assert.match(RUST, /Backtrace::force_capture\(\)/);
  assert.match(RUST, /write_atomic/);
  assert.match(RUST, /pub fn last_crash/);
  assert.match(RUST, /pub fn clear_crash/);
  assert.match(RUST, /MESSAGE_MAX/);
  assert.match(RUST, /BACKTRACE_MAX/);
});

test("copy uses plain product words in both languages", () => {
  assert.equal(tFor("zh-CN", "crash.title"), "上次运行异常退出");
  assert.equal(tFor("en", "crash.copy"), "Copy report");
  assert.equal(tFor("zh-CN", "crash.clear"), "清除报告");
});
