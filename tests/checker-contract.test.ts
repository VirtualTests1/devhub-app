/**
 * The CLI contract of the repo's verification scripts, pinned by SPAWNING them.
 *
 * Round 17 (o3-3). `tests/checkers.test.ts` pins what the checkers *decide*; this
 * file pins what they *accept and return* — the flags each one honours and the exit
 * code each one uses. That was never written down, so every reader had to guess
 * from a header comment, and a guess is not a contract: a checker whose exit codes
 * drift from what `pnpm check` assumes turns a red gate green without anyone
 * editing a rule.
 *
 * The unified contract this direction is moving toward:
 *
 *     0 = passed        1 = a FAIL verdict        2 = could not decide
 *
 * and, for a machine consumer, `--json` must be a single JSON document on stdout
 * whose `ok` field agrees with the exit code. Unknown flags are rejected (exit 2),
 * never ignored: an ignored `--jsno` is how a guard silently stops running.
 *
 * Where the repo already meets that contract, the test asserts it EXACTLY. Where a
 * script still does not (see the GAPS note below), the test asserts the weaker,
 * always-true invariant instead — a flag typo must never be reported as a rule
 * FAIL (`exit !== 1`), because that is the one failure mode that misleads: it looks
 * like the code broke rather than the command. Those rows are characterisation, not
 * aspiration; unifying the script should tighten them to `=== 2`.
 *
 * GAPS as measured 2026-10-16 (all spawns below were run by hand first):
 *   - `check-events`, `check-commands`, `check-registry`, `check-lint` do not yet
 *     reject an unknown flag (they ignore it and exit 0). `--json` is missing on
 *     `check-events` and `check-commands`. Fixing those is follow-up work; this file
 *     will fail loudly the day one of them starts exiting 1 on a typo.
 *   - `check-lint`'s flag-ignoring path spawns a full `eslint .` (~1 min), so this
 *     file only exercises its cheap `--selftest`; the measured manual value
 *     (`--zzz` → exit 0) is recorded in the table comment instead of re-run here.
 *   - `check-dist` has no passing mode without a built `dist/`; only its usage-error
 *     contract (exit 2) is asserted.
 *
 * Timeouts: 180 s, matching `tests/checkers.test.ts` and for the same reason it
 * documents — a spawn budget a busy machine routinely exceeds turns the gate into
 * a coin toss. A timeout surfaces here as `status === -1` with a diagnostic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function run(name: string, args: string[] = []) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts", name), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 180_000,
  });
  if (r.error) {
    return {
      status: -1,
      out: `${name} ${args.join(" ")}: spawn failed after ${Date.now() - started} ms (${r.error}). ` +
        "If this is a timeout the box was busy — re-run this file alone before believing it.",
    };
  }
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---------------------------------------------------------------------------
// The two scripts this direction changed already meet the full contract.
// ---------------------------------------------------------------------------

for (const name of ["check-invariants.mjs", "check-docs.mjs"]) {
  test(`${name}: an unknown flag is a usage error (exit 2), never a silent no-op`, () => {
    const { status, out } = run(name, ["--definitely-not-a-flag"]);
    assert.equal(status, 2, `expected exit 2 for a usage error, got ${status}:\n${out}`);
    assert.match(out, /unknown argument/i, "the rejection must name the offending flag");
  });

  test(`${name} --json: one JSON document whose ok agrees with the exit code`, () => {
    const { status, out } = run(name, ["--json"]);
    assert.ok(status === 0 || status === 1, `--json must exit 0 or 1, got ${status}:\n${out}`);
    const data = JSON.parse(out) as { ok: boolean };
    assert.equal(typeof data.ok, "boolean", "the JSON verdict must carry an `ok` boolean");
    assert.equal(data.ok, status === 0, "`ok` must agree with the process exit code");
  });
}

test("check-docs --help: exits 0 and names every flag it accepts", () => {
  const { status, out } = run("check-docs.mjs", ["--help"]);
  assert.equal(status, 0, out);
  // `--src=` joined with check 6 (round 21, o3-2); an unlisted mode switch is a
  // flag operators discover by misreading a report.
  for (const flag of ["--citations=", "--src=", "--selftest", "--rewrite", "--json"]) {
    assert.ok(out.includes(flag), `--help must document ${flag}`);
  }
});

// ---------------------------------------------------------------------------
// check-compose.mjs (round 21, o3-1) — the newest member of the `pnpm check`
// chain, and the first one whose contract has THREE verdict exits (0 pass /
// 1 validation failed / 2 could-not-decide: docker present but answering with an
// environment error, or the .ts module unloadable on this Node). So it does NOT
// join the two-script loop above — that loop asserts `--json` exits 0 or 1,
// which would misread this checker's honest exit 2 as a contract break. What is
// pinned here is the part every checker shares: a flag typo is never a rule FAIL,
// and `--json`'s `ok` always agrees with the exit code for ANY of the three.
// ---------------------------------------------------------------------------

test("check-compose.mjs: an unknown flag is a usage error (exit 2), never a rule FAIL", () => {
  const { status, out } = run("check-compose.mjs", ["--definitely-not-a-flag"]);
  assert.equal(status, 2, `expected exit 2 for a usage error, got ${status}:\n${out}`);
  assert.match(out, /unknown argument/i, "the rejection must name the offending flag");
});

test("check-compose.mjs --json: parses, ok agrees with the exit code, status is one of the three", () => {
  const { status, out } = run("check-compose.mjs", ["--json"]);
  assert.ok(status === 0 || status === 1 || status === 2, `--json must exit 0/1/2, got ${status}:\n${out}`);
  const data = JSON.parse(out) as { ok: boolean; status: string };
  assert.equal(data.ok, status === 0, "`ok` must agree with the process exit code");
  assert.ok(["PASS", "FAIL", "INDETERMINATE"].includes(data.status), `bad status field: ${data.status}`);
  assert.equal(data.status === "PASS", status === 0);
});

test("check-compose.mjs --selftest: the detector scenarios hold without docker", () => {
  const { status, out } = run("check-compose.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /OK: \d+ compose self-test scenarios/);
  assert.ok(!/^\s+FAIL\s/m.test(out), "no self-test scenario may fail");
});

// ---------------------------------------------------------------------------
// Round 17 (r2): check-invariants grew a synthetic self-test for its
// `tauri-security` row (CSP / connect-src / asset-protocol classifier). It is
// pinned here for the same reason check-docs' and check-lint's selftests are:
// the live config is compliant today, so the self-test is the only place the
// DETECTING branches (an `unsafe-eval`, a `*` connect-src, a widened scope) are
// exercised — and it must stay cheap (no repo state, no network, no cargo).
// ---------------------------------------------------------------------------
test("check-invariants --selftest: the security-posture classifier holds without repo state", () => {
  const { status, out } = run("check-invariants.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /OK: \d+ security self-test scenarios/);
  for (const scenario of [
    "the committed posture → 0 violations",
    "`unsafe-eval` in script-src → violation",
    "`unsafe-inline` in script-src → violation",
    "`style-src 'unsafe-inline'` alone is NOT a violation",
    "connect-src `*` → violation",
    "connect-src growing an unreviewed host → violation naming the baseline",
    "assetProtocol.scope `**/*` → repo-root/global violation",
    "assetProtocol.scope `$HOME/**` → repo-root/global violation",
    "a new, non-global scope entry → violation demanding a review",
    "assetProtocol disabled → any scope is vacuous, not a widening",
    "no CSP string → violation (Tauri enables CSP protection only when set)",
  ]) {
    assert.ok(out.includes(`ok    ${scenario}`), `security self-test scenario did not pass or is gone: ${scenario}`);
  }
  assert.ok(!/^\s+FAIL\s/m.test(out), "no self-test scenario may fail");
});

// ---------------------------------------------------------------------------
// The rest of the `pnpm check` chain: characterisation against the contract.
// A flag typo must not masquerade as a rule FAIL (exit 1). Real, honest, and it
// stays true when these scripts are unified to exit 2.
// ---------------------------------------------------------------------------

for (const name of ["check-events.mjs", "check-commands.mjs", "check-registry.mjs"]) {
  test(`${name}: a flag typo is ignored or rejected, but never reported as a rule FAIL`, () => {
    const { status, out } = run(name, ["--definitely-not-a-flag"]);
    assert.notEqual(status, 1, `a typo'd flag must not read as a rule FAIL:\n${out}`);
    assert.ok(status === 0 || status === 2, `expected exit 0 (ignored) or 2 (rejected), got ${status}:\n${out}`);
  });
}

test("check-registry --json: one JSON document whose ok agrees with the exit code", () => {
  const { status, out } = run("check-registry.mjs", ["--json"]);
  assert.ok(status === 0 || status === 1, `--json must exit 0 or 1, got ${status}:\n${out}`);
  const data = JSON.parse(out) as { ok: boolean };
  assert.equal(typeof data.ok, "boolean");
  assert.equal(data.ok, status === 0);
});

test("check-lint --selftest: the ratchet classifier holds (exit 0), no eslint spawn", () => {
  // The plain run (and the flag-typo probe) spawn `eslint .` (~1 min); this file
  // deliberately exercises only the cheap, synthetic path. Manual measurement
  // 2026-10-16: `check-lint.mjs --zzz` → exit 0 (the flag is ignored).
  const { status, out } = run("check-lint.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /self-test scenario/i);
});

// ---------------------------------------------------------------------------
// Supply-chain / packaging checkers (not in `pnpm check`, still tools).
// ---------------------------------------------------------------------------

test("license-report: unknown flag → exit 2; --json parses; --selftest exit 0", () => {
  const bad = run("license-report.mjs", ["--definitely-not-a-flag"]);
  assert.equal(bad.status, 2, bad.out);

  const js = run("license-report.mjs", ["--selftest"]);
  assert.equal(js.status, 0, "the classifier selftest needs no pnpm spawn and must pass");

  const json = run("license-report.mjs", ["--json"]);
  assert.ok(json.status === 0 || json.status === 2, `--json must exit 0 or 2, got ${json.status}:\n${json.out}`);
  if (json.status === 0) {
    // Exit 2 means "pnpm licenses could not be run" — offline/unresolvable, in which
    // case there is no report to parse. When it DOES decide, it must emit JSON.
    JSON.parse(json.out);
  }
});

test("check-dist: only --budgets is accepted; anything else is a usage error (exit 2)", () => {
  const bad = run("check-dist.mjs", ["--definitely-not-a-flag"]);
  assert.equal(bad.status, 2, bad.out);
  // No passing assertion here: without `dist/` the only reachable verdict is exit 1
  // ("run pnpm build first"), and this suite must not depend on a built tree.
  if (!existsSync(resolve(ROOT, "dist"))) {
    const plain = run("check-dist.mjs", []);
    assert.equal(plain.status, 1, "with no dist/ the check must FAIL, not silently pass");
    assert.match(plain.out, /dist\/ does not exist/i);
  }
});
