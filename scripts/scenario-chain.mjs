#!/usr/bin/env node
/**
 * D1 — CDP scenario chain runner.
 *
 * Runs a sequence of CDP scenario modules against a live DevHub window and
 * reports a combined verdict. Each scenario is a `scripts/scenarios/*.mjs`
 * module that default-exports `async (cdp) => ({ verdict, ... })`.
 *
 * Usage:
 *   node scripts/scenario-chain.mjs [--port 9222]
 *   node scripts/scenario-chain.mjs --only baseline,wall-drag
 *
 * The chain stops at the first FAIL and reports which scenario tripped.
 * INFORMATIONAL scenarios (verdict = "INFORMATIONAL") do not fail the chain.
 *
 * This is the "e2e 场景串联脚本" from the r19 plan (D1): instead of
 * `verify-fixes.ps1` running each scenario in a separate process, this
 * script drives them all in one CDP session, which is faster and keeps
 * the app state warm between scenarios.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// CLI

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? args[portArg + 1] : process.env.CDP_PORT || "9222";
const onlyArg = args.indexOf("--only");
const onlyFilter = onlyArg >= 0 ? args[onlyArg + 1].split(",").map((s) => s.trim()) : null;

const scenariosDir = resolve("scripts", "scenarios");
const EXCLUDE = new Set(["smoke", "download-wait", "debug-settle-wall"]);

function listScenarios() {
  const files = readdirSync(scenariosDir).filter(
    (f) => f.endsWith(".mjs") && !f.startsWith("smoke") && !EXCLUDE.has(f.replace(".mjs", "")),
  );
  if (onlyFilter) {
    return files.filter((f) => onlyFilter.includes(f.replace(".mjs", "")));
  }
  return files;
}

// ---------------------------------------------------------------------------
// CDP connection (reuses the same protocol as cdp.mjs)

async function connectCdp() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const app =
    pages.find((t) => /tauri|localhost|127\.0\.0\.1/.test(t.url) && !t.url.startsWith("devtools://")) ??
    pages[0];
  if (!app) throw new Error("no CDP page target found — is the app running with --remote-debugging-port?");
  const ws = new WebSocket(app.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => ws.onopen = r);
  const evaluate = (js) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, (m) => {
        if (m.error) rej(new Error(m.error.message));
        else res(m.result?.result?.value);
      });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: js, awaitPromise: true, returnByValue: true } }));
    });
  return {
    evaluate,
    close: () => ws.close(),
  };
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const files = listScenarios();
  if (files.length === 0) {
    console.error("No scenarios to run. Check --only filter.");
    process.exit(2);
  }

  console.log(`Running ${files.length} CDP scenarios on port ${port}:\n`);
  const cdp = await connectCdp();
  const results = [];
  let chainFailed = false;

  for (const f of files) {
    const name = f.replace(".mjs", "");
    const url = pathToFileURL(join(scenariosDir, f)).href;
    const mod = await import(url);
    const run = mod.default;
    try {
      const result = await run(cdp);
      const verdict = result?.verdict ?? "UNKNOWN";
      const ok = verdict === "PASS" || verdict === "INFORMATIONAL";
      results.push({ name, verdict, ok });
      console.log(`  ${ok ? "✓" : "✗"} ${name}: ${verdict}`);
      if (verdict === "FAIL" && !chainFailed) {
        chainFailed = true;
        console.log(`\nChain stopped at ${name} (FAIL). Remaining scenarios skipped.`);
        break;
      }
    } catch (e) {
      results.push({ name, verdict: "ERROR", ok: false });
      console.log(`  ✗ ${name}: ERROR — ${e.message}`);
      chainFailed = true;
      console.log(`\nChain stopped at ${name} (ERROR). Remaining scenarios skipped.`);
      break;
    }
  }

  cdp.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const skipped = files.length - results.length;

  console.log(`\n--- Chain summary ---`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);
  if (skipped > 0) console.log(`  skipped: ${skipped}`);
  console.log(`  verdict: ${chainFailed ? "FAIL" : "PASS"}`);

  // Machine-readable output for CI.
  console.log(JSON.stringify({ passed, failed, skipped, verdict: chainFailed ? "FAIL" : "PASS" }));
  process.exitCode = chainFailed ? 1 : 0;
}

main().catch((e) => {
  console.error(`chain runner error: ${e.message}`);
  process.exit(2);
});
