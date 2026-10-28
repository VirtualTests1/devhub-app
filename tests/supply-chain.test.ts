/**
 * R3-1 / R3-2 — the supply-chain checkers' CLI contracts, pinned the way
 * tests/checkers.test.ts pins the five original checkers.
 *
 * What is asserted is the COMMAND SURFACE, not the tree's license or advisory
 * contents, and that distinction is the whole reason this file exists:
 *
 *   - `license-report.mjs --check` is called by `pnpm verify` (package.json). It was
 *     moved OUT of `pnpm check` on 2026-10-16: it shells out to `pnpm licenses list
 *     --json`, measured 1.7 s warm, 17.4 s cold, and >180 s while another build line
 *     held the disk — so left inside the gate that runs dozens of times a session it
 *     produced three false failures in one hour. A checker that goes red because the
 *     machine was busy is worse than a slower one, because people learn to re-run until
 *     green. `verify` is the deliberate, once-per-release path and is the right home.
 *     If that script's flags, exit codes or anchoring drift, the chain silently stops
 *     gating licenses while still printing a green summary — which is why the flags and
 *     the exit codes are pinned here, not merely exercised once by hand.
 *   - `audit-report.mjs` must keep its three-state exit policy. Its most dangerous
 *     possible bug is answering 0 when it never got an answer, so the "cannot
 *     determine" path is pinned explicitly.
 *   - Neither test hard-codes what the registry currently says. `pnpm audit` against
 *     this machine's mirror answers "endpoint does not exist" TODAY
 *     (measured 2026-10-16: exit 1 with ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS, and the
 *     same command against https://registry.npmjs.org exits 0 with 217 dependencies
 *     audited). Asserting exit 2 would pin machine configuration instead of script
 *     behaviour — the failure mode this repo already recorded as "测试钉错东西" — so
 *     the audit case asserts the SET of admissible outcomes and the shape of the
 *     message, which stays true whichever way the registry goes.
 *
 * Spawned as subprocesses rather than imported: both checkers run their CLI on
 * import (check-lint.mjs established the same constraint), and a checker's contract
 * is its argv + exit code, which only a subprocess observes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = process.cwd();

function run(name: string, args: string[] = [], cwd = ROOT) {
  // 180 s. The history of this number is the lesson, not the value:
  //   - 30 s (what `tests/checkers.test.ts` used) was exceeded inside `pnpm gate` on
  //     2026-10-16 while six agent sessions shared the box, and
  //     `check-invariants: green from the repo root` failed although the identical
  //     command run alone printed PASS 12 / FAIL 0.
  //   - 90 s then proved the same thing twice more in one hour: `license-report:
  //     --check` failed inside a worktree's `pnpm gate` while a cargo build was
  //     hammering the disk, and passed 10/10 when the very same file was run alone.
  // `pnpm licenses list --json` is measured 1.7 s warm and 17.4 s cold
  // (license-report.mjs header); `pnpm audit` adds a registry round trip with its own
  // 120 s internal timeout. `node --test` runs files concurrently by default, so these
  // spawns compete with ~45 other files for the same disk. A budget that a loaded
  // machine routinely exceeds turns the gate into a coin toss — and a coin-toss gate is
  // worse than no gate, because people learn to re-run until green.
  //
  // A timeout is still reported as a failure (silently skipping would hide a real
  // regression), but with the elapsed time and the cause printed, so the next reader
  // can tell "the checker broke" from "the box was busy" without guessing.
  const started = Date.now();
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts", name), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 180_000,
  });
  const ms = Date.now() - started;
  if (r.error) {
    return {
      status: -1,
      out: `${name}: spawn failed after ${ms} ms (${r.error}). ` +
        `If this is a timeout, the box was busy — re-run this file alone before believing the verdict.`,
    };
  }
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---------------------------------------------------------------------------
// license-report.mjs — the gate that now stands inside `pnpm check`
// ---------------------------------------------------------------------------

test("license-report: --check is accepted and is what `pnpm verify` calls", () => {
  const { status, out } = run("license-report.mjs", ["--check"]);
  assert.equal(status, 0, out);
  assert.match(out, /OK: \d+ entries \/ \d+ name@version, all expressions on the allowlist/);
});

test("license-report: --json emits a parseable verdict with the gate answer in it", () => {
  const { status, out } = run("license-report.mjs", ["--json"]);
  assert.equal(status, 0, out);
  const data = JSON.parse(out) as {
    ok: boolean;
    source: string;
    counts: { entries: number; nameVersionPairs: number; expressions: number };
    allowlist: string[];
    expressions: { expression: string; entries: number; status: string }[];
    violations: unknown[];
  };
  assert.equal(data.ok, true, "a violation must survive into the JSON, not only the table");
  assert.equal(data.violations.length, 0);
  assert.equal(data.source, "pnpm licenses list --json");
  assert.ok(data.counts.entries > 0, "an empty inventory is not a pass — see the coverage floors");
  assert.equal(data.expressions.length, data.counts.expressions);
  for (const id of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "Python-2.0", "Unlicense"]) {
    assert.ok(data.allowlist.includes(id), `allowlist lost ${id}`);
  }
});

test("license-report: --selftest pins the classifier without touching the tree", () => {
  const { status, out } = run("license-report.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /^OK: \d+ license classifier scenarios$/m);
  assert.doesNotMatch(out, /FAIL/);
});

test("license-report: an unrecognised argument is exit 2, never a silent pass", () => {
  const { status, out } = run("license-report.mjs", ["--cheek"]);
  assert.equal(status, 2, out);
  assert.match(out, /unknown argument/);
});

test("license-report: anchored to its own directory (sub-cwd gives the same verdict)", () => {
  const fromRoot = run("license-report.mjs", ["--json"]);
  const fromTests = run("license-report.mjs", ["--json"], resolve(ROOT, "tests"));
  assert.equal(fromRoot.status, fromTests.status, `cwd changed the verdict:\n${fromTests.out}`);
  const pairs = (s: string) => JSON.parse(s).counts.nameVersionPairs as number;
  assert.equal(pairs(fromRoot.out), pairs(fromTests.out), "the two runs inventoried different trees");
});

// ---------------------------------------------------------------------------
// audit-report.mjs — three-state exit policy
// ---------------------------------------------------------------------------

test("audit-report: --selftest pins the parser and the severity threshold", () => {
  const { status, out } = run("audit-report.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /^OK: \d+ audit classifier scenarios$/m);
});

test("audit-report: --severity takes only the documented levels", () => {
  for (const level of ["critical", "high", "moderate", "low", "info"]) {
    // Validation happens before any spawn, so this asserts the parser alone.
    // A live audit run belongs to `pnpm audit:report`, not to the suite.
    const r = run("audit-report.mjs", ["--severity", level, "--selftest"]);
    assert.equal(r.status, 0, `${level}: ${r.out}`);
  }
  const bad = run("audit-report.mjs", ["--severity", "blocker"]);
  assert.equal(bad.status, 2, bad.out);
  assert.match(bad.out, /--severity needs one of/);
});

test("audit-report: --no-fallback answers 0 or 2, and only a real report may answer 0", () => {
  // Deliberately NOT asserting a fixed code: which of the two this mirror gives
  // today is machine state. What must never happen is 1 without advisories, or 0
  // without a report — either would turn "we did not get an answer" into a verdict.
  const { status, out } = run("audit-report.mjs", ["--no-fallback"]);
  assert.ok(status === 0 || status === 2, `unexpected exit ${status}:\n${out}`);
  if (status === 2) {
    assert.match(out, /CANNOT DETERMINE|cannot determine/i);
    assert.doesNotMatch(out, /^OK: no known vulnerabilities/m, "exit 2 must not also print a clean verdict");
    assert.match(out, /ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS|registry-error|unparseable|ECONNREFUSED/, `exit 2 must say why:\n${out}`);
  } else {
    assert.match(out, /^OK: no known vulnerabilities in the installed tree$/m);
  }
});

test("audit-report: an unrecognised argument is exit 2", () => {
  const { status, out } = run("audit-report.mjs", ["--nonsense"]);
  assert.equal(status, 2, out);
  assert.match(out, /unknown argument/);
});

test("audit-report: anchored to its own directory", () => {
  // Same ENOENT-shaped regression check-events.mjs records at :20-26: a checker
  // resolving from the shell's cwd reports on the wrong tree, quietly.
  const fromRoot = run("audit-report.mjs", ["--selftest"]);
  const fromTests = run("audit-report.mjs", ["--selftest"], resolve(ROOT, "tests"));
  assert.equal(fromRoot.status, 0, fromRoot.out);
  assert.equal(fromTests.status, fromRoot.status, fromTests.out);
});
