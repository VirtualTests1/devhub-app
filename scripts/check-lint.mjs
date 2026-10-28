// check-lint.mjs — the ESLint RATCHET that `pnpm check` (and therefore `pnpm
// gate`) actually calls.
//
// Why a wrapper instead of `eslint .` in the gate: `pnpm lint` runs `eslint .`
// raw, and on this tree that is 10 pre-existing problems, all in `src/**` files
// owned by other streams. A gate that fails on debt is a gate people mute, so the
// gate calls THIS instead: it runs the same eslint, then compares each file's
// problem count against a grandfathered per-file baseline. A file that stays at
// or below its baseline is invisible to the run; a NEW violation, a NEW file with
// a problem, or any parse error fails. That is the "wire lint in without blocking
// on pre-existing debt" contract, and it is the ceiling that lets eslint.config.js
// promote `react-hooks/exhaustive-deps` and `@typescript-eslint/no-non-null-
// assertion` to "error" — the baseline carries the 7 + 3 already there, so the
// promotion is real (a new one fails) rather than a red wall.
//
// This mirrors the per-file ratchets in check-invariants.mjs on purpose: a global
// `--max-warnings N` would let one stream's fix cancel another's regression and
// still pass, and that shift is exactly what a ratchet is supposed to forbid. The
// trade is a number per file, so `--baseline` regenerates the whole set with the
// same eslint invocation the rule uses — the printer and the check cannot drift.
//
// Testability: a cold `eslint .` is ~19s here, so the suite must not spawn it per
// test. The decision is therefore split out: `evaluateLintReport()` takes the
// eslint JSON and returns the verdict with no subprocess. `--report <file>` runs
// that on a saved report, and `--print-root` exposes the root/bin resolution that
// makes the checker cwd-independent. The real run stays in `pnpm check`, so the
// full path is exercised on every gate without the suite paying it four times.
//
// Dependency-free by rule: node:fs, node:path, node:child_process, node:url. It
// does NOT import eslint; it runs the installed CLI as a subprocess (with
// process.execPath against the resolved bin, never the `.bin` shim, so a linked
// worktree's relative-path trap cannot bite), the same way check-invariants.mjs
// shells out to check-commands.mjs.
//
//   node scripts/check-lint.mjs                ratchet verdict (exit 1 on a new problem)
//   node scripts/check-lint.mjs --json         machine-readable
//   node scripts/check-lint.mjs --baseline     print the object to paste below
//   node scripts/check-lint.mjs --report f.json  evaluate a saved eslint JSON (no spawn)
//   node scripts/check-lint.mjs --print-root   print the resolved ROOT + eslint bin
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Root anchoring (regression guard: tests/checkers.test.ts runs this from `tests/`)
// ---------------------------------------------------------------------------
// Resolve everything from this script's own location and pass `cwd: ROOT` to the
// eslint child, so the invocation directory never decides what gets linted. Run
// from a subdirectory, a relative `scripts/check-lint.mjs` + `"."` would lint the
// wrong tree; anchoring makes `node ../scripts/check-lint.mjs` behave identically.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Baseline — measured debt, not an allowance to grow into
// ---------------------------------------------------------------------------
// Measured 2026-10-16 on this tree (`node scripts/check-lint.mjs --baseline`),
// and paid to zero by r18-o2 on 2026-10-17: the last 10 findings across 9 files
// are gone, so the baseline is empty and any new problem fails the gate
// immediately. When you pay one file to zero, delete its key here; `--baseline`
// recomputes the rest. Never raise a number without saying why in the commit
// message.
const LINT_BASELINE = {
  // no problems on this tree — empty baseline
};

// ---------------------------------------------------------------------------
// Locate the installed eslint CLI
// ---------------------------------------------------------------------------
// Deliberately resolved from ROOT, not the shell PATH: in a linked worktree
// `node_modules` is a junction into the shared root store, and `node_modules/
// eslint` is itself a symlink into `.pnpm`; `process.execPath` + the real bin JS
// sidesteps the `.bin` relative-entry-point problem entirely.
export function resolveEslintBin(root = ROOT) {
  const candidates = [
    join(root, "node_modules", "eslint", "bin", "eslint.js"),
    join(root, "..", "node_modules", "eslint", "bin", "eslint.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// Turn an eslint-reported path into the baseline key style ("src/App.tsx").
// Absolute paths under ROOT are made relative; a path already given relative to
// ROOT (the `--report` fixture case) is normalised to forward slashes; anything
// that would escape ROOT is left as-is so a stray absolute path shows up verbatim
// rather than being silently folded into a baseline key.
function keyFor(absOrRel) {
  const r = isAbsolute(absOrRel) ? relative(ROOT, absOrRel) : absOrRel;
  const posix = r.split(sep).join("/");
  return posix.startsWith("..") ? absOrRel.split(sep).join("/") : posix;
}

// ---------------------------------------------------------------------------
// The verdict, with no subprocess: eslint JSON in, decision out
// ---------------------------------------------------------------------------
export function evaluateLintReport(report, baseline = LINT_BASELINE) {
  const found = {};
  const fatal = [];
  for (const fileReport of report) {
    const rel = keyFor(fileReport.filePath);
    const msgs = fileReport.messages ?? [];
    if (msgs.length) found[rel] = msgs.length;
    for (const m of msgs) {
      if (m.fatal) fatal.push(`${rel}:${m.line}:${m.column} ${m.message}`);
    }
  }

  // A file that fails to parse is not "grandfathered debt" — eslint never analysed
  // it, so its count cannot be trusted and the whole file is a blind spot. Fail
  // unconditionally regardless of baseline; check-invariants.mjs's ratchet-integrity
  // row is the precedent for "a zero you cannot verify is a failure, not a pass".
  const violations = [];
  for (const [file, n] of Object.entries(found)) {
    const base = baseline[file];
    if (base === undefined) {
      if (n > 0) violations.push(`${file}: new problem file with ${n} (not in baseline — run --baseline after paying it down)`);
      continue;
    }
    if (n > base) violations.push(`${file}: ${base} → ${n}`);
  }

  const totalNow = Object.values(found).reduce((s, n) => s + n, 0);
  const totalBase = Object.values(baseline).reduce((s, n) => s + n, 0);
  const failed = violations.length > 0 || fatal.length > 0;
  return { found, fatal, violations, totalNow, totalBase, failed, baselineKeys: Object.keys(baseline).length };
}

function printText(v, { enforcedBy = "" } = {}) {
  console.log("check-lint.mjs — ESLint ratchet (lint is enforced by the gate through this file)");
  console.log(
    `eslint: ${v.totalNow} problem(s) across ${Object.keys(v.found).length} file(s); ` +
      `baseline grandfathered ${v.totalBase} across ${v.baselineKeys} file(s)${enforcedBy ? ` [${enforcedBy}]` : ""}`,
  );
  if (v.fatal.length) {
    console.log("PARSE ERRORS (the file was never analysed, so it is a blind spot — never grandfathered):");
    for (const f of v.fatal) console.log(`  - ${f}`);
  }
  if (v.violations.length) {
    console.log("RATCHET VIOLATIONS (a NEW problem, or a problem in a file that used to be clean):");
    for (const x of v.violations) console.log(`  - ${x}`);
    console.log("Run `pnpm lint` for the full message, or lower a number only after paying real debt.");
  }
  if (!v.failed) {
    console.log("OK: no lint problem exceeds its file baseline and nothing fails to parse");
  }
}

function printJson(v) {
  console.log(
    JSON.stringify(
      {
        ok: !v.failed,
        status: v.failed ? "FAIL" : "PASS",
        totalNow: v.totalNow,
        totalBaseline: v.totalBase,
        filesWithProblems: Object.keys(v.found).length,
        baselineEntries: v.baselineKeys,
        fatal: v.fatal,
        violations: v.violations,
      },
      null,
      2,
    ),
  );
}

function printBaseline(v) {
  // Printed from the SAME measurement the rule uses, so `--baseline` can never
  // disagree with the check the way a hand-restated regex does (the lesson written
  // into check-invariants.mjs's --baseline block).
  const lines = Object.entries(v.found)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, n]) => `  ${JSON.stringify(f)}: ${n},`);
  console.log("const LINT_BASELINE = {");
  console.log(lines.join("\n") || "  // no problems on this tree — empty baseline");
  console.log("};");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const asBaseline = argv.includes("--baseline");
const asPrintRoot = argv.includes("--print-root");
const reportIdx = argv.indexOf("--report");
const reportFile = reportIdx >= 0 ? argv[reportIdx + 1] : null;

// `--selftest` drives `evaluateLintReport` with synthetic eslint reports so the
// ratchet's four behaviours (grandfather / over-baseline / new-file / parse-error)
// are pinned WITHOUT spawning the ~19s `eslint .` — the full tree is exercised for
// real once per gate by `pnpm check`. Scenarios are derived from the live
// LINT_BASELINE, so re-basing (the integrator regenerates it after the src streams
// merge) cannot quietly turn this self-test vacuous: if the baseline is empty the
// grandfather/over scenarios are skipped rather than silently passing.
if (argv.includes("--selftest")) {
  const mkFile = (filePath, n, fatal = false) => ({
    filePath,
    messages: fatal
      ? [{ ruleId: null, fatal: true, severity: 2, line: 1, column: 1, message: "Parsing error" }]
      : Array.from({ length: n }, (_, i) => ({ ruleId: `r${i}`, severity: 2, line: 1, column: 1, message: "x" })),
  });
  const baseKeys = Object.keys(LINT_BASELINE);
  // A file path that cannot be a baseline key (a name --baseline would never emit).
  const NEW_FILE = "src/__check_lint_selftest_new__.tsx";
  const scenarios = [];
  if (baseKeys.length) {
    const k = baseKeys[0];
    const b = LINT_BASELINE[k];
    scenarios.push(["grandfather at baseline → PASS", [mkFile(k, b)], false]);
    scenarios.push(["over baseline → FAIL", [mkFile(k, b + 1)], true]);
    scenarios.push(["pay-down below baseline → PASS", [mkFile(k, Math.max(0, b - 1))], false]);
    // A fatal in a within-baseline file must STILL fail: the count alone would pass.
    scenarios.push(["fatal parse → FAIL", [mkFile(k, Math.min(b, 1), true)], true]);
  } else {
    // No grandfathered debt at all: a single problem in any file is a new violation.
    scenarios.push(["any problem with empty baseline → FAIL", [mkFile(NEW_FILE, 1)], true]);
    scenarios.push(["fatal parse → FAIL", [mkFile("src/App.tsx", 1, true)], true]);
  }
  scenarios.push(["new file → FAIL", [mkFile(NEW_FILE, 1)], true]);
  scenarios.push(["clean tree → PASS", [], false]);

  let ok = true;
  for (const [name, rep, expectFail] of scenarios) {
    const v = evaluateLintReport(rep);
    const pass = v.failed === expectFail;
    ok = ok && pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}  (failed=${v.failed}, expected=${expectFail})`);
  }
  if (ok) {
    console.log(`OK: ${scenarios.length} ratchet self-test scenarios behaved as documented`);
    process.exit(0);
  }
  console.log("SELFTEST FAILED — the ratchet no longer matches its own contract");
  process.exit(1);
}

// `--print-root` proves cwd-independence without running eslint: the script must
// resolve the repo root and the eslint bin from its own location, never from
// process.cwd(). Cheap on purpose so the suite can pin the anchoring.
if (asPrintRoot) {
  const bin = resolveEslintBin();
  console.log(JSON.stringify({ root: ROOT, cwd: process.cwd(), bin, binExists: bin !== null }, null, 2));
  process.exit(0);
}

// `--report <file>` evaluates a saved eslint JSON report — the whole ratchet with
// no subprocess, so a fixture can drive green / new-violation / parse-error paths.
if (reportFile) {
  if (!existsSync(reportFile)) {
    console.log(asJson ? JSON.stringify({ ok: false, status: "FAIL", detail: `--report file not found: ${reportFile}` }) : `FAIL  --report file not found: ${reportFile}`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch (e) {
    console.log(`FAIL  --report file is not valid eslint JSON: ${e.message}`);
    process.exit(1);
  }
  const v = evaluateLintReport(report);
  if (asJson) printJson(v);
  else if (asBaseline) printBaseline(v);
  else printText(v, { enforcedBy: "offline report" });
  process.exit(v.failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// The real run
// ---------------------------------------------------------------------------
const bin = resolveEslintBin();

// --- eslint not installed: this is a real failure state, never silence ------
// (check-invariants.mjs's `eslint-runnable` row reports the same fact; the gate
// itself must not read a missing linter as a pass.)
if (!bin) {
  const detail =
    "eslint is not installed (node_modules/eslint/bin/eslint.js not found), so the lint " +
    "ratchet cannot run. Install in the ROOT checkout, never in a linked worktree " +
    "(shared node_modules junction): pnpm add -D eslint @typescript-eslint/parser " +
    "@typescript-eslint/eslint-plugin eslint-plugin-react-hooks";
  console.log(asJson ? JSON.stringify({ ok: false, status: "FAIL", detail }, null, 2) : `FAIL  ${detail}`);
  process.exit(1);
}

const child = spawnSync(process.execPath, [bin, ".", "-f", "json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (child.error) {
  const detail = `could not run eslint: ${child.error.message}`;
  console.log(asJson ? JSON.stringify({ ok: false, status: "FAIL", detail }, null, 2) : `FAIL  ${detail}`);
  process.exit(1);
}

// exit 2 = eslint itself failed (config would not load, bad CLI args). That is not
// a lint finding; it means the ratchet has NO coverage, so treat it as a failure of
// the check, not a pass. (0 = clean, 1 = findings — both produce JSON we parse.)
if (child.status === 2) {
  const detail = `eslint exited 2 — the config could not be loaded, so nothing was linted:\n${(child.stderr || "").trim()}`;
  console.log(asJson ? JSON.stringify({ ok: false, status: "FAIL", detail }, null, 2) : `FAIL  ${detail}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(child.stdout);
} catch {
  const detail =
    `eslint did not emit parseable JSON (exit ${child.status}). Its stdout began:\n` +
    `${(child.stdout || "").slice(0, 400)}`;
  console.log(asJson ? JSON.stringify({ ok: false, status: "FAIL", detail }, null, 2) : `FAIL  ${detail}`);
  process.exit(1);
}

const v = evaluateLintReport(report);

if (asBaseline) {
  printBaseline(v);
  process.exit(0);
}
if (asJson) printJson(v);
else printText(v);

process.exit(v.failed ? 1 : 0);
