/**
 * Taskbar attention policy (r27-N3).
 *
 * The decision is pure and the wiring is source-contracted: the actual Windows
 * flash needs a real window, so the thing that can be proved here is exactly the
 * part with product rules — focused/disabled are silent, failure is never
 * throttled, success is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ATTENTION_MIN_GAP_MS,
  decideAttention,
} from "../src/lib/completion-attention.ts";

test("focused or disabled never asks for attention", () => {
  for (const input of [
    { focused: true, enabled: true, outcome: "failure" as const },
    { focused: false, enabled: false, outcome: "failure" as const },
  ]) {
    const d = decideAttention({ ...input, now: 1000, lastAt: 0 });
    assert.deepEqual(d, { level: "none", lastAt: 0 });
  }
});

test("a failure is critical even inside the success throttle window", () => {
  const d = decideAttention({
    focused: false,
    enabled: true,
    outcome: "failure",
    now: 1000,
    lastAt: 999,
  });
  assert.deepEqual(d, { level: "critical", lastAt: 1000 });
});

test("success flashes once, then stays quiet for the gap", () => {
  const first = decideAttention({
    focused: false,
    enabled: true,
    outcome: "success",
    now: 10_000,
    lastAt: 0,
  });
  assert.deepEqual(first, { level: "informational", lastAt: 10_000 });

  const tooSoon = decideAttention({
    focused: false,
    enabled: true,
    outcome: "success",
    now: 10_000 + ATTENTION_MIN_GAP_MS - 1,
    lastAt: first.lastAt,
  });
  assert.deepEqual(tooSoon, { level: "none", lastAt: 10_000 });

  const later = decideAttention({
    focused: false,
    enabled: true,
    outcome: "success",
    now: 10_000 + ATTENTION_MIN_GAP_MS,
    lastAt: first.lastAt,
  });
  assert.equal(later.level, "informational");
});

test("wiring: one hook, one setting, one capability", () => {
  const hook = readFileSync("src/lib/use-completion-attention.ts", "utf8");
  assert.match(hook, /requestUserAttention\(/);
  assert.match(hook, /useAttention\.getState\(\)\.enabled/);
  assert.match(hook, /document\.hasFocus\(\)/);
  const app = readFileSync("src/App.tsx", "utf8");
  assert.match(app, /useCompletionAttention\(\)/);
  const iface = readFileSync("src/components/InterfaceRegistry.tsx", "utf8");
  assert.match(iface, /settings-row-attention/);
  const cap = readFileSync("src-tauri/capabilities/default.json", "utf8");
  assert.match(cap, /core:window:allow-request-user-attention/);
  const batch = readFileSync("src/components/BatchBar.tsx", "utf8");
  assert.match(batch, /onSettled\?\.\(action\.id, sum\.ok, sum\.total\)/);
  const wall = readFileSync("src/views/ProjectsView.tsx", "utf8");
  assert.match(wall, /requestCompletionAttention\(ok === total \? "success" : "failure"\)/);
});
