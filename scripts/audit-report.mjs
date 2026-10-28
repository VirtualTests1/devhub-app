// audit-report.mjs — dependency vulnerability audit, wrapping `pnpm audit --json`.
//
// Why this exists: the repo had no audit command at all (`rg -n "license|audit"
// scripts package.json` → only vocabulary lists in check-docs.mjs), and a
// vulnerable transitive dependency is exactly the class of regression nobody
// notices until it is reported. `pnpm audit` already does the querying; what
// was missing is an EXIT-CODE CONTRACT that distinguishes three states this
// project insists on keeping apart:
//
//   0  clean — the registry answered and reported 0 advisories
//   1  known vulnerabilities — severity counts + package names printed
//   2  CANNOT DETERMINE — the registry could not answer (offline, endpoint
//      missing, garbage output). Not green (that would lie), not red-with-
//      packages (there are none to name): a third, documented outcome.
//
// Everything below about pnpm's behaviour was verified on this machine
// (2026-10-16, pnpm 10.33.0, win32-x64), not assumed:
//
//   * `pnpm audit --json` against the CONFIGURED registry
//     (https://registry.npmmirror.com) exits 1 with a parseable error object:
//       {"error":{"code":"ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS","message":
//        "The audit endpoint (at https://registry.npmmirror.com/-/npm/v1/security/audits/quick) is doesn't exist."}}
//     — a mirror that does not implement the audit endpoint. This is the
//     motivating real-world failure: a naive `pnpm audit` wrapper would report
//     it as "vulnerabilities found" (exit 1) forever, or swallow it green.
//   * The same command with `--registry=https://registry.npmjs.org` exits 0
//     with a real report (observed: advisories {}, metadata.vulnerabilities all
//     0, totalDependencies 217) — so a fallback attempt turns "mirror can't
//     answer" into an actual verdict on this machine.
//   * Exit-code semantics come from pnpm's own bundled source
//     (lockfile/plugin-commands-audit/lib/audit.js): in JSON mode it returns
//     `exitCode: Object.keys(advisories).length > 0 ? 1 : 0`; registry errors
//     are thrown (→ error JSON, exit 1) unless --ignore-registry-errors is
//     passed. So pnpm's exit 1 is AMBIGUOUS — error OR vulnerabilities — and
//     only the payload can tell them apart. That ambiguity is precisely why
//     this wrapper parses output instead of trusting $LASTEXITCODE.
//   * Docs verified: https://pnpm.io/10.x/cli/audit (10.x = our version) and
//     https://pnpm.io/cli/audit (latest), fetched 2026-10-16 — `--json` shape,
//     `--audit-level`, `--ignore-registry-errors` semantics.
//
// The lockfile is never written: `pnpm audit` without `--fix`/`--ignore` is
// read-only, and `git status --porcelain` after real runs stayed empty
// (re-verified in every sub-direction's report).
//
// CLI:  --no-fallback  do not retry against the official npm registry when the
//                      configured one fails (useful to exercise the exit-2 path
//                      deterministically, and for air-gapped setups where the
//                      fallback would just waste a timeout)
//       --severity <l> FAIL only at this severity or worse (critical|high|moderate|
//                      low|info). Default `low` counts every advisory, so the flag
//                      can only ever loosen an explicit run, never the default gate.
//                      Everything found is printed regardless of the threshold.
//       --selftest     classify synthetic pnpm outputs; no spawn, no network
//       --help         usage including the exit codes
// Anything else is rejected rather than ignored (repo convention).
//
// Dependency-free by rule: node:child_process, node:path, node:url only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Retry target when the configured registry cannot answer: the official npm
// registry, whose audit endpoint is the one pnpm's quick-audit protocol speaks
// (observed working above — exit 0 with a 217-dependency report).
const FALLBACK_REGISTRY = "https://registry.npmjs.org";

const SEVERITIES = ["critical", "high", "moderate", "low", "info"];

/**
 * Classify one `pnpm audit --json` stdout. Pure over its argument: this is
 * what `--selftest` pins.
 *
 *   report         a real audit payload (has `advisories`) — the verdict comes
 *                  from its contents
 *   registry-error pnpm could not get an answer — `{"error":{code,message}}`
 *   unparseable    neither shape: empty output, truncated JSON, a pnpm usage
 *                  error on stderr… anything this script refuses to guess about
 */
function parseAuditOutput(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { kind: "unparseable", preview: "(empty output)" };
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { kind: "unparseable", preview: raw.slice(0, 160) };
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.error && typeof obj.error === "object") {
      return { kind: "registry-error", code: String(obj.error.code ?? "?"), message: String(obj.error.message ?? "") };
    }
    if (obj.advisories && typeof obj.advisories === "object") {
      return { kind: "report", advisories: obj.advisories, metadata: obj.metadata ?? {} };
    }
  }
  return { kind: "unparseable", preview: raw.slice(0, 160) };
}

/**
 * The verdict over one report: `{ vulnerable, counts, packages, total }`.
 *
 * Both signals are consulted, and EITHER one being non-zero goes red — pnpm's
 * own exit code only looks at `advisories`, but with the default
 * `--audit-level low` nothing is filtered out, so the two counts agree today;
 * if they ever disagree, the safe direction is red, never a false green.
 * `counts` comes from `metadata.vulnerabilities` (pnpm's own summary block).
 */
function summarizeReport(report) {
  const entries = Object.entries(report.advisories ?? {});
  const meta = report.metadata?.vulnerabilities ?? {};
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, Number(meta[s]) || 0]));
  const metaTotal = SEVERITIES.reduce((n, s) => n + counts[s], 0);
  const packages = entries
    .map(([, a]) => ({
      severity: String(a?.severity ?? "?"),
      module: String(a?.module_name ?? "?"),
      versions: String(a?.vulnerable_versions ?? "?"),
      patched: a?.patched_versions == null ? null : String(a.patched_versions),
      title: String(a?.title ?? ""),
      url: String(a?.url ?? ""),
    }))
    .sort((x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity));
  return { vulnerable: entries.length > 0 || metaTotal > 0, counts, packages, advisoryCount: entries.length, metaTotal };
}

/**
 * How many findings are at or above a severity threshold.
 *
 * `SEVERITIES` is ordered most-severe-first, so "at or above" means a LOWER index,
 * and the slice starts at the threshold rather than ending at it. Getting that
 * inverted is the classic threshold bug: it makes `--severity critical` report
 * every `info` advisory, or `--severity low` report only critical ones.
 *
 * Two sources are consulted and the LARGER wins, then anything with a severity this
 * script does not recognise is added on top:
 *   - `metadata.vulnerabilities` — pnpm's own per-severity summary block;
 *   - the `advisories` array itself — the ground truth the summary is derived from.
 * They normally agree (measured: the clean report against npmjs carries 0 in every
 * metadata bucket and an empty `advisories`), but if they ever disagree the safe
 * direction is to count MORE, never to let a missing summary block hide a finding.
 * An unrecognised severity string counts as a hit for the same reason — a field
 * whose meaning is unknown is not evidence of absence.
 */
function countAtOrAbove(summary, threshold) {
  const idx = SEVERITIES.indexOf(threshold);
  const rank = (s) => SEVERITIES.indexOf(String(s).toLowerCase());
  // SEVERITIES is most-severe-first, so "at or above the threshold" is the PREFIX
  // ending at the threshold index — `slice(0, idx + 1)`, not `slice(idx)`. The first
  // draft of this line wrote `slice(idx)` and `--severity critical` summed every
  // bucket including `info`; the selftest case named "threshold direction" is there
  // to keep that from coming back.
  const fromMeta = SEVERITIES.slice(0, idx + 1).reduce((n, s) => n + (summary.counts[s] || 0), 0);
  const fromAdvisories = summary.packages.filter((p) => rank(p.severity) >= 0 && rank(p.severity) <= idx).length;
  const unrecognised = summary.packages.filter((p) => rank(p.severity) < 0).length;
  return { hit: Math.max(fromMeta, fromAdvisories) + unrecognised, fromMeta, fromAdvisories, unrecognised };
}

// ---------------------------------------------------------------------------
// Spawning — one attempt = one `pnpm audit --json` (plus optional registry).
// ---------------------------------------------------------------------------

function runAuditAttempt(args) {
  const res = spawnSync("pnpm", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    timeout: 120_000, // a hanging registry must become "cannot determine", not a hung gate
  });
  if (res.error) return { kind: "unparseable", preview: `cannot run pnpm: ${res.error.code ?? res.error.message}` };
  const parsed = parseAuditOutput(res.stdout);
  // pnpm's exit code is deliberately NOT trusted (see header): what matters is
  // the payload. Keep the code in the record so a mismatch is visible.
  return { ...parsed, exitCode: res.status };
}

function attemptLabel(index, total, what) {
  return `attempt ${index}${total > 1 ? `/${total}` : ""} (${what})`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCounts(summary) {
  return `severity counts: ${SEVERITIES.map((s) => `${s} ${summary.counts[s]}`).join(", ")}`;
}

function renderVulnerable(summary) {
  console.log(`  ${renderCounts(summary)}`);
  const names = [...new Set(summary.packages.map((p) => `${p.module}@${p.versions}`))];
  console.log(`  packages affected (${names.length}): ${names.join(", ")}`);
  console.log("  advisories:");
  for (const p of summary.packages) {
    const patched = p.patched === null ? "no fix published" : `patched in ${p.patched}`;
    console.log(
      `    ${p.severity.toUpperCase().padEnd(8)} ${p.module} ${p.versions} — ${p.title || "(no title)"} [${patched}]${p.url ? ` ${p.url}` : ""}`,
    );
  }
}

function cannotDetermine(records) {
  console.log("audit-report.mjs — CANNOT DETERMINE (this is a distinct outcome, not clean and not red):");
  for (const r of records) {
    const tail =
      r.kind === "registry-error"
        ? `${r.code} — ${r.message}`
        : r.kind === "unparseable"
          ? `unparseable output: ${r.preview}`
          : `kind=${r.kind}`;
    console.log(`  ${r.label}: pnpm exit ${r.exitCode ?? "?"}; ${tail}`);
  }
  console.log("exit 2: no verdict is possible without a registry answer — rerun when the registry is reachable.");
}

// ---------------------------------------------------------------------------
// --selftest: parsing + verdict logic pinned without network or repo state.
// ---------------------------------------------------------------------------
// The live tree audits CLEAN, so the vulnerable and registry-error branches
// never execute here; producing them for real would need a vulnerable install
// (mutating the shared node_modules — forbidden) or a broken registry (attempt
// 1's npmmirror run does exactly that, and is exercised live via
// `node scripts/audit-report.mjs --no-fallback`). Synthetic payloads keep the
// classifier itself honest in between.
function runSelftest() {
  const clean = JSON.stringify({
    actions: [],
    advisories: {},
    muted: [],
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, totalDependencies: 217 },
  });
  const dirty = JSON.stringify({
    actions: [],
    advisories: {
      "GHSA-xxxx-aaaa-1111": {
        module_name: "lodash",
        severity: "critical",
        title: "prototype pollution",
        vulnerable_versions: "<4.17.21",
        patched_versions: ">=4.17.21",
        url: "https://github.com/advisories/GHSA-xxxx-aaaa-1111",
        findings: [],
        cves: ["CVE-2020-8203"],
      },
      "GHSA-yyyy-bbbb-2222": {
        module_name: "minimist",
        severity: "low",
        title: "prototype pollution",
        vulnerable_versions: "<1.2.6",
        patched_versions: ">=1.2.6",
        url: "https://github.com/advisories/GHSA-yyyy-bbbb-2222",
        findings: [],
        cves: [],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 1 }, totalDependencies: 217 },
  });
  const endpointMissing = JSON.stringify({
    error: { code: "ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS", message: "The audit endpoint (at https://registry.npmmirror.com/-/npm/v1/security/audits/quick) is doesn't exist." },
  });

  const cases = [
    {
      name: "clean report (advisories {}) is exit 0 — observed live against npmjs",
      run: () => {
        const p = parseAuditOutput(clean);
        const s = p.kind === "report" ? summarizeReport(p) : null;
        return p.kind === "report" && s && s.vulnerable === false && s.packages.length === 0;
      },
    },
    {
      name: "advisories → exit 1 path: counts + package names extracted, critical sorted first",
      run: () => {
        const p = parseAuditOutput(dirty);
        const s = p.kind === "report" ? summarizeReport(p) : null;
        return (
          !!s &&
          s.vulnerable &&
          s.advisoryCount === 2 &&
          s.counts.critical === 1 &&
          s.counts.low === 1 &&
          s.packages[0].module === "lodash" &&
          s.packages[0].patched === ">=4.17.21" &&
          s.packages.length === 2
        );
      },
    },
    {
      name: "metadata counts alone (advisories filtered) still cannot go green",
      run: () => {
        const p = parseAuditOutput(JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } } }));
        const s = p.kind === "report" ? summarizeReport(p) : null;
        return !!s && s.vulnerable === true;
      },
    },
    {
      name: "npmmirror endpoint error JSON is registry-error, not a vulnerability report",
      run: () => {
        const p = parseAuditOutput(endpointMissing);
        return p.kind === "registry-error" && p.code === "ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS";
      },
    },
    {
      name: "threshold direction: SEVERITIES is most-severe-first, so --severity critical counts ONLY critical",
      run: () => {
        const s = summarizeReport(parseAuditOutput(dirty));
        // dirty = 1 critical + 1 low.
        // If the slice were reversed, `critical` would count the low advisory too.
        return (
          countAtOrAbove(s, "critical").hit === 1 &&
          countAtOrAbove(s, "high").hit === 1 &&
          countAtOrAbove(s, "moderate").hit === 1 &&
          countAtOrAbove(s, "low").hit === 2 &&
          countAtOrAbove(s, "info").hit === 2
        );
      },
    },
    {
      name: "threshold default is `low`, i.e. every advisory still fails the run",
      run: () => {
        const s = summarizeReport(parseAuditOutput(dirty));
        return countAtOrAbove(s, "low").hit === s.advisoryCount && s.advisoryCount === 2;
      },
    },
    {
      name: "sub-threshold findings can go green, but only when nothing heavier exists",
      run: () => {
        const minor = JSON.stringify({
          advisories: {
            "1": { module_name: "left-pad", severity: "low", vulnerable_versions: "*", title: "x", url: "" },
            "2": { module_name: "qa", severity: "info", vulnerable_versions: "*", title: "y", url: "" },
          },
          metadata: { vulnerabilities: { info: 1, low: 1, moderate: 0, high: 0, critical: 0 } },
        });
        const s = summarizeReport(parseAuditOutput(minor));
        return s.vulnerable === true && countAtOrAbove(s, "critical").hit === 0 && countAtOrAbove(s, "low").hit === 1;
      },
    },
    {
      name: "an unrecognised severity is counted as a hit, never as absence",
      run: () => {
        const weird = JSON.stringify({
          advisories: { "1": { module_name: "x", severity: "apocalyptic", vulnerable_versions: "*", title: "", url: "" } },
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
        });
        const s = summarizeReport(parseAuditOutput(weird));
        return countAtOrAbove(s, "critical").hit === 1;
      },
    },
    {
      name: "metadata and advisories disagree -> the LARGER count wins",
      run: () => {
        const skewed = JSON.stringify({
          advisories: {},
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0 } },
        });
        const s = summarizeReport(parseAuditOutput(skewed));
        return countAtOrAbove(s, "high").hit === 3 && countAtOrAbove(s, "critical").hit === 0;
      },
    },
    {
      name: "empty output is unparseable (cannot determine)",
      run: () => parseAuditOutput("").kind === "unparseable",
    },
    { name: "non-JSON garbage is unparseable, previewed not trusted", run: () => parseAuditOutput("ERROR Unknown option").kind === "unparseable" },
    { name: "JSON without advisories/error is unparseable, not silently clean", run: () => parseAuditOutput(JSON.stringify({ metadata: {} })).kind === "unparseable" },
    { name: "null / non-object payloads are unparseable", run: () => parseAuditOutput("null").kind === "unparseable" && parseAuditOutput("[]").kind === "unparseable" },
  ];

  let failed = 0;
  for (const c of cases) {
    let ok = false;
    try {
      ok = c.run() === true;
    } catch {
      ok = false;
    }
    if (ok) {
      console.log(`  ok    ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} audit classifier scenario(s) broken`
      : `\nOK: ${cases.length} audit classifier scenarios`,
  );
  return failed;
}

// ---------------------------------------------------------------------------
// CLI contract + main
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let noFallback = false;
// Threshold for FAILING the run, not for seeing the findings: every advisory is
// always printed. Default `low` = every severity counts, i.e. today's behaviour with
// nothing filtered, so adding the flag cannot quietly weaken the existing gate.
let minSeverity = "low";
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--severity") {
    const v = String(argv[i + 1] ?? "").toLowerCase();
    if (!SEVERITIES.includes(v)) {
      console.error(`audit-report.mjs: --severity needs one of ${SEVERITIES.join("|")}, got ${JSON.stringify(argv[i + 1] ?? "")}`);
      process.exit(2);
    }
    minSeverity = v;
    i += 1;
    continue;
  }
  if (a === "--no-fallback" || a === "--selftest" || a === "--help") continue;
  console.error(`audit-report.mjs: unknown argument '${a}'`);
  console.error("usage: node scripts/audit-report.mjs [--no-fallback] [--severity <level>] [--selftest] [--help]");
  process.exit(2);
}
if (argv.includes("--help")) {
  console.log(
    "node scripts/audit-report.mjs [--no-fallback] [--severity <level>] [--selftest] [--help]\n" +
      "  (default)        try the configured registry, then fall back to the official npm registry\n" +
      "  --no-fallback    only the configured registry — its failure then exits 2 (cannot determine)\n" +
      `  --severity <lvl>  FAIL only at this severity or worse (${SEVERITIES.join("|")}; default low,\n` +
      "                    which counts every advisory). Findings below it are still printed.\n" +
      "  --selftest       classify synthetic pnpm audit outputs (no spawn, no network)\n" +
      "exit codes: 0 = clean; 1 = known vulnerabilities; 2 = cannot determine (registry/network)",
  );
  process.exit(0);
}
if (argv.includes("--selftest")) process.exit(runSelftest() ? 1 : 0);
noFallback = argv.includes("--no-fallback");

console.log("audit-report.mjs — dependency vulnerability audit (wraps `pnpm audit --json`)");
if (minSeverity !== "low") {
  console.log(`  threshold:  FAIL on ${minSeverity} or worse; lesser findings are reported but do not fail this run`);
}

const attempts = [{ label: attemptLabel(1, noFallback ? 1 : 2, "configured registry"), args: ["audit", "--json"] }];
if (!noFallback) {
  attempts.push({ label: attemptLabel(2, 2, `fallback ${FALLBACK_REGISTRY}`), args: ["audit", "--json", `--registry=${FALLBACK_REGISTRY}`] });
}

const records = [];
for (const attempt of attempts) {
  const result = runAuditAttempt(attempt.args);
  if (result.kind === "report") {
    const summary = summarizeReport(result);
    const at = countAtOrAbove(summary, minSeverity);
    if (at.hit === 0) {
      const depTotal = result.metadata?.totalDependencies ?? "?";
      console.log(`  ${attempt.label}: exit ${result.exitCode}, 0 advisories`);
      console.log(`  ${renderCounts(summary)} (metadata: ${depTotal} dependencies audited)`);
      console.log("OK: no known vulnerabilities in the installed tree");
      process.exit(0);
    }
    console.log(`  ${attempt.label}: exit ${result.exitCode}, ${summary.advisoryCount} advisory(ies)`);
    renderVulnerable(summary);
    // Below-threshold findings stay visible on purpose. A `--severity critical` run
    // that printed nothing about 40 moderate advisories would read as "the tree is
    // clean" to anyone who did not also open the flags — so the count is stated, then
    // the threshold that let them through.
    const below = summary.advisoryCount + summary.metaTotal - at.hit;
    if (summary.vulnerable && at.hit > 0 && below > 0) {
      console.log(
        `  NOTE: ${below} finding(s) are below the --severity ${minSeverity} threshold and did not contribute to this failure.`,
      );
    }
    console.log(
      `\nFAIL: ${at.hit} finding(s) at ${minSeverity} or worse ` +
        `(advisories: ${summary.advisoryCount}, metadata counts: ${summary.metaTotal}) ` +
        `— fix via \`pnpm update\`/overrides, see https://pnpm.io/cli/audit`,
    );
    process.exit(1);
  }
  // Not a verdict: remember why, try the next attempt (if any).
  records.push({ ...attempt, ...result });
  console.log(
    `  ${attempt.label}: exit ${result.exitCode ?? "?"} — ` +
      `${result.kind === "registry-error" ? `${result.code} (registry did not answer)` : `unparseable: ${result.preview}`}` +
      `${records.length < attempts.length ? "; trying next attempt" : ""}`,
  );
}

cannotDetermine(records);
process.exit(2);
