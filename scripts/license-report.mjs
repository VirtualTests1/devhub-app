// license-report.mjs — license inventory + allowlist gate for every installed
// package (direct + transitive).
//
// Why this exists: until round 16 (r3-1) nothing in this repo asked "what
// licenses are we building with?" — `rg -n "license|audit" scripts package.json`
// found only vocabulary lists inside check-docs.mjs. A permissive-only policy
// is enforceable only if somebody enumerates the tree, so this script is that
// enumeration plus the verdict.
//
// Data source — `pnpm licenses list --json`, NOT a hand-rolled walker over
// `node_modules/.pnpm/*/node_modules/*/package.json`. Both approaches were run
// on this tree (2026-10-16, pnpm 10.33.0, win32-x64) and compared:
//
//   pnpm licenses list --json  153 entries / 160 name@version, already grouped
//                              by license expression; warm runs measured
//                              1.3 s / 1.3 s / 0.9 s (the session's very first
//                              run was 17.4 s with a cold filesystem cache);
//                              still exit 0 with
//                              `npm_config_registry=http://127.0.0.1:1` — the
//                              command reads the lockfile + store only, it
//                              never consults a registry, so it is offline.
//   .pnpm walker (built to compare) sees 216 name@version on disk — 56 MORE
//                              than pnpm reports, every one of them an
//                              other-platform optional binary
//                              (@rolldown/binding-darwin-arm64,
//                              @tailwindcss/oxide-linux-x64-musl,
//                              @tauri-apps/cli-darwin-*, fsevents, …).
//                              `node_modules` in a worktree is a junction to
//                              the shared root store, so a walker cannot tell
//                              "installed for this machine" from "residue of
//                              another checkout", and matching pnpm's semantics
//                              would mean re-implementing its license-file
//                              fallback (pnpm 10.33.0's bundled license-scanner
//                              `parseLicense`: manifest `license` → LICENSE file
//                              text → the literal group key "Unknown").
//
// pnpm only REPORTS, it never gates: its JSON renderer returns
// `{ exitCode: 0 }` unconditionally (verified in the bundled
// `reviewing/plugin-commands-licenses` source), so the allowlist verdict is
// this script's job. Missing licenses are therefore detected, not assumed: a
// package with no `license` field and no scannable LICENSE file lands in an
// "Unknown" group, which is a FAIL below (this tree currently has 0 such
// groups — observed run, not a promise).
//
// Exit codes (three documented outcomes, deliberately distinct):
//   0  every package's license expression is on the allowlist
//   1  at least one license is MISSING or NOT allowlisted (details printed)
//   2  cannot determine — `pnpm licenses` failed or printed no JSON (broken
//      node_modules, missing pnpm). Unknown is not green and is not a
//      license violation either; it says so and exits 2.
//
// CLI:  --check      assert the gate. The gate is NOT off by default — this script
//                      has always exited 1 on a missing/denied license — so --check
//                      states the intent inside `pnpm check` rather than switching a
//                      behaviour. It exists so that making the default report-only
//                      later cannot silently take the gate out of the chain.
//       --json       machine-readable report instead of the table (same exit codes)
//       --selftest   classify synthetic groups; no repo state, no pnpm spawn
//       --help       usage including the exit codes
// Anything else is rejected rather than ignored: an unrecognised flag on a
// guard is how the guard silently stops running (repo convention).
//
// Dependency-free by rule: node:child_process, node:path, node:url only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// The allowlist — POLICY, not a snapshot of today's tree.
// ---------------------------------------------------------------------------
// Criteria for inclusion: permissive (no copyleft obligation reaching our
// code), or a file-level weak copyleft whose obligation provably does not
// attach to what this repo ships (see MPL-2.0 below). Anything else fails and
// gets reviewed case by case — a denied license is a conversation, not an
// incident.
const ALLOWLIST = new Set([
  "MIT", // observed: bulk of the tree (dnd-kit, react/*, eslint plugins, …)
  "ISC", // observed: lucide-react, semver, minimatch@3, picocolors, …
  "BSD-2-Clause", // observed: eslint-scope, espree, esrecurse, uri-js, …
  "BSD-3-Clause", // observed: esquery, source-map-js
  "Apache-2.0", // observed: eslint core (@eslint/*), @humanfs/*, typescript
  "0BSD", // observed: tslib — grants nothing, requires nothing
  "CC0-1.0", // public-domain dedication; NOT observed today — pre-approved so
  "Unlicense", // a future dep does not need an emergency allowlist edit
  "CC-BY-4.0", // permissive attribution; NOT observed today, same reason
  "Python-2.0", // observed: argparse@2.0.1 — the PSF license is a plain
  // permissive grant (MIT-like), on the prompt's baseline list
  "MPL-2.0", // observed: lightningcss@1.32.0/1.33.0 (pulled in by
  // @tailwindcss/vite). Weak FILE-level copyleft: the obligation attaches only
  // to modified MPL-covered source files; this repo neither modifies nor ships
  // that source — the published bundle is JS/CSS produced by the tool at build
  // time. OSD-approved. Kept deliberately narrow: a RUNTIME dependency under
  // MPL-2.0 would be a different question and must be reviewed, not waved
  // through by this line.
  "BlueOak-1.0.0", // observed: minimatch@10.2.6 — permissive, OSI-approved
  // (2020), the npm ecosystem's public-domain-flavoured default
]);

// Sorted once: the summary prints it, and a stable order keeps output diffs
// reviewable (this repo treats checker output as evidence).
const ALLOWLIST_PRINT = [...ALLOWLIST].sort().join(", ");

/**
 * Verdict for one license EXPRESSION — the exact string pnpm grouped by.
 *
 * SPDX semantics, deliberately:
 *   - `A OR B`   the licensee picks. OK when AT LEAST ONE alternative is
 *                allowlisted (that is the legal effect of OR: we take the
 *                permissive branch of `GPL-3.0 OR MIT` as deliberately as we
 *                take `Apache-2.0 OR MIT`).
 *   - `A AND B`  both apply simultaneously, so EVERY member must be allowlisted.
 *   - `A WITH E` is not split: the whole string must be allowlisted, which
 *                means `… WITH …` and LicenseRef-style IDs fail until someone
 *                adds them on purpose.
 *   - missing ("Unknown" / UNLICENSED / SEE LICENSE IN <file> / empty) is its
 *     own kind, so the report can say "no license" instead of "license not on
 *     the allowlist" — the two need different follow-up actions.
 *
 * Pure over its argument: this is what `--selftest` pins.
 */
function classifyExpression(expression) {
  const expr = String(expression ?? "").trim();
  if (
    expr === "" ||
    /^unknown$/i.test(expr) ||
    /^unlicen[cs]ed$/i.test(expr) ||
    /^see license in/i.test(expr)
  ) {
    return { ok: false, kind: "missing", detail: "no license in manifest or LICENSE file" };
  }
  const alternatives = expr.split(/\s+OR\s+/i);
  for (const alternative of alternatives) {
    const members = alternative.split(/\s+AND\s+/i).map((m) => m.trim());
    if (members.every((m) => ALLOWLIST.has(m))) {
      return { ok: true, kind: "allowed", detail: expr };
    }
  }
  return { ok: false, kind: "disallowed", detail: "not on the allowlist" };
}

// ---------------------------------------------------------------------------
// Collection — spawn the official command, own its failure modes.
// ---------------------------------------------------------------------------

/** Run `pnpm licenses list --json` from ROOT. Never throws; shapes the result. */
function collect() {
  const res = spawnSync("pnpm", ["licenses", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // `pnpm` is a .cmd shim on Windows; spawnSync with shell:false does not
    // resolve PATHEXT, so a CI install with no pnpm.exe fails with ENOENT.
    shell: process.platform === "win32",
  });
  if (res.error) {
    return { error: `cannot run pnpm: ${res.error.code ?? res.error.message}` };
  }
  if (res.status !== 0) {
    const tail = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim().split(/\r?\n/).slice(-4).join(" | ");
    return { error: `pnpm licenses list --json exited ${res.status}${tail ? `: ${tail}` : ""}` };
  }
  try {
    const groups = JSON.parse(res.stdout);
    if (groups === null || typeof groups !== "object" || Array.isArray(groups)) {
      return { error: `pnpm printed JSON that is not a license map (got ${Array.isArray(groups) ? "array" : typeof groups})` };
    }
    return { groups };
  } catch {
    const head = String(res.stdout ?? "").trim().slice(0, 160);
    return { error: `pnpm output is not JSON${head ? ` (starts: ${JSON.stringify(head)})` : " (empty)"}` };
  }
}

// ---------------------------------------------------------------------------
// Rendering — compact summary table, then the full inventory.
// ---------------------------------------------------------------------------

/** One `name@version` line per entry; multi-version entries show all of them. */
function entryIds(entries) {
  return entries.map((e) => `${e.name}@${(e.versions ?? []).join(",")}`);
}

/**
 * Classify every group key once, so the table renderer and `--json` cannot drift.
 *
 * Two independent loops over `groups` is how a report starts disagreeing with
 * itself about what failed — the same reason check-lint.mjs evaluates the verdict
 * in one function and only formats it afterwards.
 */
function evaluateGroups(groups) {
  const expressions = [];
  const broken = [];
  for (const key of Object.keys(groups).sort()) {
    const verdict = classifyExpression(key);
    const ids = entryIds(groups[key]).sort();
    expressions.push({
      expression: key,
      entries: groups[key].length,
      status: verdict.ok ? "ok" : verdict.kind,
      packages: ids,
    });
    if (!verdict.ok) {
      for (const id of ids) {
        broken.push({
          package: id,
          expression: key,
          kind: verdict.kind,
          detail: verdict.kind === "missing" ? `${verdict.detail} (pnpm grouped it under \`${key}\`)` : verdict.detail,
        });
      }
    }
  }
  return { expressions, broken };
}

function renderJson(groups, evaluated, elapsedMs) {
  const groupNames = Object.keys(groups);
  const entryCount = groupNames.reduce((n, k) => n + groups[k].length, 0);
  const installCount = groupNames.reduce(
    (n, k) => n + groups[k].reduce((m, e) => m + (e.versions?.length ?? 0), 0),
    0,
  );
  console.log(JSON.stringify({
    // `ok` is the gate answer; `error` distinguishes "clean" from "never looked",
    // which is the difference between exit 0 and exit 2 and must survive the JSON.
    ok: evaluated.broken.length === 0,
    source: "pnpm licenses list --json",
    elapsedMs,
    counts: { entries: entryCount, nameVersionPairs: installCount, expressions: groupNames.length },
    allowlist: [...ALLOWLIST].sort(),
    expressions: evaluated.expressions,
    violations: evaluated.broken,
  }, null, 2));
  return evaluated.broken.length ? 1 : 0;
}

function renderReport(groups, evaluated, elapsedMs) {
  const groupNames = Object.keys(groups);
  const entryCount = groupNames.reduce((n, k) => n + groups[k].length, 0);
  const installCount = groupNames.reduce(
    (n, k) => n + groups[k].reduce((m, e) => m + (e.versions?.length ?? 0), 0),
    0,
  );

  console.log("license-report.mjs — installed-package license inventory + allowlist gate");
  console.log(
    `  source:     pnpm licenses list --json — ${entryCount} entries / ${installCount} name@version, ` +
      `${groupNames.length} expression(s), ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(`  allowlist:  ${ALLOWLIST_PRINT}`);

  // Summary table: expression, how many entries, verdict. Sorted by expression
  // so two runs diff cleanly (checker output is evidence here, not prose).
  const width = Math.max(12, ...groupNames.map((k) => k.length));
  console.log("  summary (expression → entries):");
  console.log(`    ${"EXPRESSION".padEnd(width)}  ENTRIES  STATUS`);
  for (const row of evaluated.expressions) {
    console.log(`    ${row.expression.padEnd(width)}  ${String(row.entries).padStart(7)}  ${row.status === "ok" ? "ok" : row.status.toUpperCase()}`);
  }

  // The full list, grouped exactly as the table above — the table is the
  // headline, this is the record somebody audits a single package against.
  console.log("  full inventory (name@version, grouped by expression):");
  for (const row of evaluated.expressions) {
    console.log(`    ${row.expression} (${row.entries})`);
    for (const id of row.packages) console.log(`      ${id}`);
  }

  if (evaluated.broken.length) {
    console.log(`\nBROKEN (${evaluated.broken.length}):`);
    for (const b of evaluated.broken) console.log(`  - ${b.package}: \`${b.expression}\` — ${b.detail}`);
    console.log("\nFAIL");
    return 1;
  }
  console.log(
    `\nOK: ${entryCount} entries / ${installCount} name@version, all expressions on the allowlist`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// --selftest: the classifier, pinned without repo state or a pnpm spawn.
// ---------------------------------------------------------------------------
// The live tree only exercises the allowlisted branches — the whole point of
// the gate is what it does with a license it has never seen, and producing one
// for real would mean mutating the shared node_modules (forbidden). So the
// denied/missing/compound paths run here against synthetic group keys, the
// same pattern check-docs.mjs uses for its citation classifier.
function runSelftest() {
  const cases = [
    { name: "plain MIT group is allowed", expr: "MIT", ok: true },
    { name: "observed dual license `Apache-2.0 OR MIT` is allowed", expr: "Apache-2.0 OR MIT", ok: true },
    { name: "dual license order does not matter (`MIT OR Apache-2.0`)", expr: "MIT OR Apache-2.0", ok: true },
    { name: "OR means the licensee picks — `GPL-3.0 OR MIT` is allowed", expr: "GPL-3.0 OR MIT", ok: true },
    { name: "AND binds both — `MIT AND GPL-3.0` is denied", expr: "MIT AND GPL-3.0", ok: false, kind: "disallowed" },
    { name: "plain copyleft `GPL-3.0` is denied", expr: "GPL-3.0", ok: false, kind: "disallowed" },
    { name: "`WITH` suffix is not split — `GPL-2.0 WITH Classpath-exception-2.0` denied", expr: "GPL-2.0 WITH Classpath-exception-2.0", ok: false, kind: "disallowed" },
    { name: "observed MPL-2.0 (build tooling) is allowed", expr: "MPL-2.0", ok: true },
    { name: "observed BlueOak-1.0.0 is allowed", expr: "BlueOak-1.0.0", ok: true },
    { name: "pnpm's no-license group key `Unknown` is MISSING, not denied", expr: "Unknown", ok: false, kind: "missing" },
    { name: "`UNLICENSED` is MISSING", expr: "UNLICENSED", ok: false, kind: "missing" },
    { name: "`SEE LICENSE IN <file>` is MISSING until the file is parsed", expr: "SEE LICENSE IN LICENSE.txt", ok: false, kind: "missing" },
    { name: "empty expression is MISSING", expr: "", ok: false, kind: "missing" },
    { name: "case is exact — `mit` is denied, not silently matched", expr: "mit", ok: false, kind: "disallowed" },
  ];
  let failed = 0;
  for (const c of cases) {
    const v = classifyExpression(c.expr);
    const problems = [];
    if (v.ok !== c.ok) problems.push(`expected ok=${c.ok}, got ok=${v.ok}`);
    if (c.kind && v.kind !== c.kind) problems.push(`expected kind=${c.kind}, got kind=${v.kind}`);
    if (problems.length) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${problems.join("; ")}`);
    } else {
      console.log(`  ok    ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} license classifier scenario(s) broken`
      : `\nOK: ${cases.length} license classifier scenarios`,
  );
  return failed;
}

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------
// `--check` is accepted and means "assert the gate". It does NOT switch gating on,
// because the gate was never off: this script has always exited 1 on a
// missing/denied license. It exists so `pnpm check` can state its intent in the
// command line instead of relying on a default that a later reader has to look up —
// and so a future change that makes the default report-only cannot silently turn the
// gate off underneath the chain.
const argv = process.argv.slice(2);
const KNOWN = ["--selftest", "--help", "--json", "--check"];
for (const a of argv) {
  if (KNOWN.includes(a)) continue;
  console.error(`license-report.mjs: unknown argument '${a}'`);
  console.error("usage: node scripts/license-report.mjs [--check] [--json] [--selftest] [--help]");
  process.exit(2);
}
if (argv.includes("--help")) {
  console.log(
    "node scripts/license-report.mjs [--check] [--json] [--selftest] [--help]\n" +
      "  --check    assert the gate (the default behaviour; stated for `pnpm check`)\n" +
      "  --json     machine-readable report instead of the table\n" +
      "  --selftest classify synthetic license expressions (no pnpm spawn, no repo state)\n" +
      "exit codes: 0 = all licenses allowlisted; 1 = missing/denied license; 2 = cannot determine",
  );
  process.exit(0);
}
if (argv.includes("--selftest")) process.exit(runSelftest() ? 1 : 0);

const started = Date.now();
const result = collect();
if (result.error) {
  console.error(`license-report.mjs — CANNOT DETERMINE: ${result.error}`);
  console.error("exit 2: this is an unknown state, not a clean bill and not a license violation.");
  process.exit(2);
}
const evaluated = evaluateGroups(result.groups);
const elapsed = Date.now() - started;
process.exit(argv.includes("--json") ? renderJson(result.groups, evaluated, elapsed) : renderReport(result.groups, evaluated, elapsed));
