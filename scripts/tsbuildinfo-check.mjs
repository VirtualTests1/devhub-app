#!/usr/bin/env node
/**
 * G2 — tsbuildinfo incremental check.
 *
 * Measures the wall-time of `tsc --noEmit` with and without the
 * incremental cache (the `*.tsbuildinfo` file). The ratio
 * `cold / warm` is the "speedup" that `incremental: true` buys.
 *
 * Usage:
 *   node scripts/tsbuildinfo-check.mjs
 *
 * Output: a single JSON object with `cold`, `warm`, `speedup` and a
 * human-readable `verdict` ("PASS" when warm < 25% of cold, "INFO"
 * otherwise). The check is non-blocking: it reports, it does not gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(".");
const TSC = ["tsc", "--noEmit"];

function timeRun(label, removeCache = false) {
  if (removeCache) {
    // Remove any *.tsbuildinfo in the repo root to force a cold run.
    for (const f of [
      resolve(REPO_ROOT, "tsconfig.tsbuildinfo"),
      resolve(REPO_ROOT, "tsconfig.tests.tsbuildinfo"),
      resolve(REPO_ROOT, "tsconfig.node.tsbuildinfo"),
    ]) {
      if (existsSync(f)) rmSync(f);
    }
  }
  const t0 = performance.now();
  const r = spawnSync("pnpm", ["exec", ...TSC], {
    encoding: "utf8",
    timeout: 300_000,
  });
  const ms = Math.round(performance.now() - t0);
  const ok = r.status === 0;
  console.log(`  ${label}: ${ms} ms (exit ${r.status})`);
  if (!ok && r.stderr) console.log(`    stderr: ${r.stderr.slice(-300)}`);
  return { ms, ok };
}

console.log("G2 — tsbuildinfo incremental check\n");

const cold = timeRun("cold (no cache)", true);
const warm = timeRun("warm (cached)", false);

const speedup = cold.ms > 0 ? cold.ms / warm.ms : Infinity;
const verdict = warm.ms < 0.25 * cold.ms ? "PASS" : "INFO";

const result = {
  coldMs: cold.ms,
  warmMs: warm.ms,
  speedup: Number.isFinite(speedup) ? speedup.toFixed(1) : "∞",
  verdict,
  note:
    verdict === "PASS"
      ? "warm cache is < 25% of cold — incremental is working"
      : "warm cache is ≥ 25% of cold — check tsbuildinfo integrity",
};
console.log(`\nG2 result: ${JSON.stringify(result, null, 2)}`);
process.exitCode = 0; // non-blocking
