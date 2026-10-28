/**
 * `effectiveStepsOf` in `src/dialogs/launch/effectiveSteps.ts` — the step list
 * a launch marker effectively represents. It mirrors a Rust helper (the same
 * decision spelled twice, once per language), so the frontend half is pinned
 * here: a marker with steps uses them, a marker with only a legacy single
 * `command` synthesises one 启动 step, and everything else is "no steps".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { effectiveStepsOf } from "../src/dialogs/launch/effectiveSteps.ts";
import type { LaunchConfig, RepoDetail } from "../src/types.ts";

// Only `launch` is read, so the other RepoDetail fields get a shell value —
// a full literal would pin fields this function promises not to look at.
const detail = (launch: LaunchConfig | null): RepoDetail => ({ launch } as RepoDetail);

const cfg = (over: Partial<LaunchConfig>): LaunchConfig => ({
  command: "",
  cwd: "",
  userConfirmed: false,
  kind: null,
  steps: [],
  ...over,
});

test("effectiveStepsOf: no launch config means no steps", () => {
  assert.deepEqual(effectiveStepsOf(detail(null)), []);
});

test("effectiveStepsOf: explicit steps win over the single command", () => {
  const steps = [
    { name: "安装依赖", command: "pnpm install", cwd: "", parallel: false },
    { name: "启动", command: "pnpm dev", cwd: "C:/repos/x", parallel: true },
  ];
  const out = effectiveStepsOf(detail(cfg({ command: "npm run dev", steps })));
  // Same array, not a copy — the dialog edits these in place afterwards.
  assert.equal(out, steps);
});

test("effectiveStepsOf: a legacy single command synthesises one 启动 step", () => {
  const out = effectiveStepsOf(detail(cfg({ command: "npm run dev", cwd: "C:/repos/x" })));
  assert.deepEqual(out, [{ name: "启动", command: "npm run dev", cwd: "C:/repos/x", parallel: false }]);
});

test("effectiveStepsOf: an empty or whitespace command is not a step", () => {
  // The whitespace case is the real one: `command.trim()` is what stops a
  // marker whose command is `"   "` from launching an empty shell.
  assert.deepEqual(effectiveStepsOf(detail(cfg({ command: "" }))), []);
  assert.deepEqual(effectiveStepsOf(detail(cfg({ command: "   " }))), []);
});
