/**
 * Batch stop wiring (r31-O3): the bar offers 停止后续 while a verb runs, passes
 * the stop check into `mapBounded`, and keeps unstarted rows separate from
 * failures in both the result list and the taskbar cue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BAR = readFileSync("src/components/BatchBar.tsx", "utf8");
const PROJECTS = readFileSync("src/views/ProjectsView.tsx", "utf8");

test("bar: cancel sets the ref, mapBounded receives it, skipped rows are distinct", () => {
  assert.match(BAR, /cancelRef\.current = true/);
  assert.match(BAR, /shouldStop: \(\) => cancelRef\.current/);
  assert.match(BAR, /skipped: true/);
  assert.match(BAR, /sum\.skipped\.length/);
  assert.match(BAR, /t\("batch\.stopQueued"\)/);
  assert.match(BAR, /t\("batch\.stoppingQueued"\)/);
  assert.match(BAR, /t\("batch\.skippedCount"/);
});

test("view: a stopped batch does not request the failure attention cue", () => {
  assert.match(PROJECTS, /onSettled=\{\(id, ok, total, skipped\)/);
  assert.match(PROJECTS, /id === "update" && skipped === 0/);
});