#!/usr/bin/env node
/**
 * B3 — pnpm verify manifest: run the `pnpm verify` steps and emit a
 * structured JSON manifest (step name, command, result, timing) to stdout.
 *
 * Usage:
 *   node scripts/verify-manifest.mjs          # run all steps, print JSON
 *   node scripts/verify-manifest.mjs --skip-build  # skip the build step
 *
 * The manifest is the "收口" record that a report can cite: each step's
 * name, exact command, exit status, wall-time, and (on failure) the
 * captured stderr tail.
 */
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const SKIP_BUILD = process.argv.includes("--skip-build");

const STEPS = [
  {
    name: "gate",
    command: "pnpm gate",
    desc: "tsc ×3 + pnpm test + pnpm check (5 checkers)",
  },
  {
    name: "build",
    command: "pnpm build",
    desc: "vite build + tsc (type-checks on the main tsconfig)",
    skipIf: SKIP_BUILD,
  },
  {
    name: "check-dist",
    command: "node scripts/check-dist.mjs",
    desc: "post-build dist sanity + size-budget ratchet",
    skipIf: SKIP_BUILD,
  },
  {
    name: "license-report",
    command: "node scripts/license-report.mjs --check",
    desc: "license inventory vs. allow-list",
  },
  {
    name: "rust-supply",
    command: "node scripts/rust-supply.mjs",
    desc: "Cargo dependency supply-chain check",
  },
];

function runStep(step) {
  const t0 = performance.now();
  const argv = step.command.split(" ");
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 600_000,
    shell: process.platform === "win32",
  });
  const ms = Math.round(performance.now() - t0);
  const ok = r.status === 0;
  const errTail = ok ? "" : (r.stderr || "").slice(-400);
  return {
    step: step.name,
    command: step.command,
    description: step.desc,
    status: ok ? "pass" : "fail",
    exitCode: r.status,
    durationMs: ms,
    ...(errTail ? { stderrTail: errTail } : {}),
  };
}

const manifest = {
  generated: new Date().toISOString(),
  steps: [],
};
let anyFail = false;

for (const step of STEPS) {
  if (step.skipIf) {
    manifest.steps.push({
      step: step.name,
      command: step.command,
      description: step.desc,
      status: "skipped",
      exitCode: null,
      durationMs: 0,
    });
    continue;
  }
  const result = runStep(step);
  manifest.steps.push(result);
  if (result.status === "fail") anyFail = true;
}

manifest.verdict = anyFail ? "FAIL" : "PASS";
console.log(JSON.stringify(manifest, null, 2));
process.exitCode = anyFail ? 1 : 0;
