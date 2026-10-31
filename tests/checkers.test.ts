/**
 * The repo's own verification scripts, pinned as the CLI contracts they are.
 *
 * `pnpm check` stands on these six scripts, yet nothing tested them until now:
 * a checker that crashes reports its failure as an exception (invisible to a
 * reader of the summary line), and a checker run from the wrong directory used
 * to die on `readdirSync("src")`. Only check-invariants.mjs was anchored to the
 * script's own location (d7-2) and only it had a sub-cwd test, while this header
 * implied the whole set was fixed — check-events/registry/commands still resolved
 * from cwd (round 15 d7 anchored them; `cd tests && node ../scripts/check-events.mjs`
 * had been ENOENT). Every checker below is now pinned from BOTH the repo root and a
 * subdirectory, so the anchoring is proven rather than claimed. Each test spawns the
 * script the way an operator would and asserts its documented success line, so a
 * renamed marker or a new non-zero exit fails here first.
 *
 * `process.cwd()` is the repo root when the suite runs (DEVELOPMENT.md 验证矩阵);
 * the sub-cwd cases deliberately break that assumption. Scripts are addressed by
 * absolute path so the *child's* cwd, not the parent's, decides what it scans.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { at } from "./helpers/definite.ts";

const ROOT = process.cwd();

function run(name: string, args: string[] = [], cwd = ROOT) {
  // 180 s, with the same reasoning `tests/supply-chain.test.ts` documents in full:
  // a spawn budget that a busy machine routinely exceeds turns a gate into a coin
  // toss, and this file measured it — `check-invariants: green from the repo root`
  // failed inside `pnpm gate` at 30 s and then at 90 s while cargo/agent work shared
  // the disk, while the identical command run alone printed PASS 12 / FAIL 0.
  // Round 15 recorded the rule this violates (4911e78): a unit test may depend on
  // repository contents, never on "this machine is idle".
  const started = Date.now();
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts", name), ...args], {
    encoding: "utf8",
    cwd,
    timeout: 180_000,
  });
  if (r.error) {
    return {
      status: -1,
      out: `${name}: spawn failed after ${Date.now() - started} ms (${r.error}). ` +
        `If this is a timeout the box was busy — re-run this file alone before believing it.`,
    };
  }
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}


test("check-invariants: green from the repo root", () => {
  const { status, out } = run("check-invariants.mjs");
  assert.equal(status, 0, out);
  // The footer line (`PASS 9  FAIL 0  INFO 2  PENDING 0`), not a table row.
  assert.match(out, /PASS\s+\d+\s+FAIL\s+0\b/, "expected the all-clear footer");
});

test("check-invariants --json: parses, ok:true, named per-check rows", () => {
  const { status, out } = run("check-invariants.mjs", ["--json"]);
  assert.equal(status, 0, out);
  const data = JSON.parse(out) as {
    ok: boolean;
    counts: Record<string, number>;
    checks: { id: string; status: string; count: number; detail: string }[];
  };
  assert.equal(data.ok, true, "a FAIL anywhere must set ok:false");
  assert.equal(data.counts.FAIL, 0);
  // `id` is how the rest of the tooling addresses a row; rust-unwrap is the
  // ratchet whose baseline the d7-2b extension keeps honest.
  const unwrap = data.checks.find((c) => c.id === "rust-unwrap");
  assert.ok(unwrap, "rust-unwrap row missing from the JSON report");
  assert.equal(unwrap.status, "PASS");
  assert.ok(data.checks.every((c) => typeof c.detail === "string" && c.detail.length > 0));
});

test("check-invariants: eslint-runnable is a live signal (installed AND gate-enforced)", () => {
  // Round 15 d2: this row used to print ONLY when eslint was absent, so once the
  // package was installed it vanished from the table — honest caveat turned into no
  // signal. It must now report both that eslint is installed and that the gate runs
  // it, and installed-but-unenforced must be a FAIL, never a silent PASS.
  const { status, out } = run("check-invariants.mjs", ["--json"]);
  assert.equal(status, 0, out);
  const data = JSON.parse(out) as {
    checks: { id: string; status: string; detail: string }[];
  };
  const row = data.checks.find((c) => c.id === "eslint-runnable");
  assert.ok(row, "eslint-runnable row must always be present, not only when the package is missing");
  assert.equal(row.status, "PASS");
  assert.match(row.detail, /installed/i);
  assert.match(row.detail, /enforced by the gate/i);
});

test("check-invariants: rust-test-floor pins the Rust suite size (deletion is a FAIL)", () => {
  // The Rust test count had no floor: `cargo test --lib` lives only in the
  // never-executed CI file, so a deleted `#[test]` was invisible to every gate
  // on this machine. The row must be PRESENT on every run (the eslint-runnable
  // lesson: a signal that vanishes when nobody looks is no signal), must print
  // the floor it compares against, and must count statically — no cargo, which
  // is single-writer here and must stay out of `gate`.
  const { status, out } = run("check-invariants.mjs", ["--json"]);
  assert.equal(status, 0, out);
  const data = JSON.parse(out) as {
    checks: { id: string; status: string; count: number; detail: string }[];
  };
  const row = data.checks.find((c) => c.id === "rust-test-floor");
  assert.ok(row, "rust-test-floor row must be present on every run");
  assert.equal(row.status, "PASS", row.detail);
  const floor = /vs floor (\d+)/.exec(row.detail);
  assert.ok(floor, `the row must state the floor it enforces: ${row.detail}`);
  assert.ok(
    row.count >= Number(floor[1]),
    `count ${row.count} is below the recorded floor ${floor[1]} — the row must FAIL, not pass`,
  );
  assert.match(row.detail, /no cargo run/, "the count must be static: the gate runs without a Rust toolchain");
});

test("check-invariants: test-refs makes every cited test file checkable", () => {
  // `src/lib/worktree-panel.ts` cited tests/worktree-panel.test.ts for six rounds
  // while the file did not exist. The row is only useful if it is present and
  // actually counts citations, so this pins both.
  const { status, out } = run("check-invariants.mjs", ["--json"]);
  assert.equal(status, 0, out);
  const data = JSON.parse(out) as {
    checks: { id: string; status: string; count: number; detail: string }[];
  };
  const row = data.checks.find((c) => c.id === "test-refs");
  assert.ok(row, "test-refs row must be present on every run");
  assert.equal(row.status, "PASS", row.detail);
  assert.ok(row.count > 0, "the row must actually find citations, not pass over an empty set");
  assert.match(row.detail, /all resolve/, "a PASS must say the citations resolve");
});

test("check-invariants: runs from a SUBDIRECTORY (the cwd-independence regression)", () => {
  // Before d7-2 this died with ENOENT on `readdirSync("tests/src")`: the whole
  // file resolved its paths against process.cwd() instead of its own location.
  const { status, out } = run("check-invariants.mjs", [], resolve(ROOT, "tests"));
  assert.equal(status, 0, out);
  assert.match(out, /PASS\s+\d+\s+FAIL\s+0\b/);
});

test("check-docs: every doc reference resolves", () => {
  const { status, out } = run("check-docs.mjs");
  assert.equal(status, 0, out);
  assert.match(out, /OK: every pnpm script/);
});

test("check-events: every event name has a peer on both sides", () => {
  const { status, out } = run("check-events.mjs");
  assert.equal(status, 0, out);
  assert.match(out, /OK: every event name has a peer on both sides/);
  // The floor line prints on green runs too (round 15 d8): the pairwise "OK" above
  // is worthless without it, because two empty maps also produce it.
  assert.match(out, /floors: emitted \d+ >= \d+, listened \d+ >= \d+ — OK/);
});

test("check-registry: no unregistered use, no unexplained dead id", () => {
  const { status, out } = run("check-registry.mjs");
  assert.equal(status, 0, out);
  assert.match(out, /every id the tree references is registered/);
});

test("check-commands: invoked names are registered and the floors hold", () => {
  const { status, out } = run("check-commands.mjs");
  assert.equal(status, 0, out);
  assert.match(out, /invoked from frontend: \d+/);
  // The floor line prints on green runs too — that is part of its contract.
  assert.match(out, /floors: invoked \d+ >= \d+, registered \d+ >= \d+ — OK/);
});

// ---------------------------------------------------------------------------
// cwd-independence for EVERY checker (round 15 d7).
// ---------------------------------------------------------------------------
// check-invariants had a sub-cwd test since d7-2; events/registry/commands were
// still cwd-relative and only this suite proves the anchoring is real. Each runs
// from `tests/` and must produce the same documented success line as from the root
// — otherwise `node ../scripts/<x>.mjs` is ENOENT and `pnpm check` from any other
// working directory is not the green gate it claims to be.
const SUB = resolve(ROOT, "tests");
const SUBCWD = [
  { script: "check-events.mjs", ok: /OK: every event name has a peer on both sides/ },
  { script: "check-registry.mjs", ok: /every id the tree references is registered/ },
  { script: "check-commands.mjs", ok: /floors: invoked \d+ >= \d+, registered \d+ >= \d+ — OK/ },
  { script: "check-docs.mjs", ok: /OK: every pnpm script/ },
  // round 21 o3-1: the compose checker anchors to its own file like the rest; on a
  // machine without docker its success line says SKIPPED instead of claiming the
  // docker layer passed, so the marker is the offline half both variants print.
  { script: "check-compose.mjs", ok: /OK: override structure/ },
];
for (const { script, ok } of SUBCWD) {
  test(`${script}: runs from a SUBDIRECTORY (cwd-independent)`, () => {
    const { status, out } = run(script, [], SUB);
    assert.equal(status, 0, out);
    assert.match(out, ok);
  });
}

// ---------------------------------------------------------------------------
// check-lint.mjs — the ESLint ratchet wired into `pnpm check` (round 15, d1).
// ---------------------------------------------------------------------------
// This is the gate that promotes `exhaustive-deps` / `no-non-null-assertion` to
// "error" without turning the run red: the per-file baseline grandfathers the
// pre-existing src debt and a NEW problem fails. The full tree is exercised live by
// `pnpm check` itself, so these tests must NOT spawn the ~19s `eslint .` per case
// (measured: a cold run, and in-test spawns timed out the gate under parallelism).
// `--selftest` runs the whole verdict against synthetic reports with no subprocess,
// and `--print-root` exposes the cwd-anchoring. Both are cheap and deterministic.

test("check-lint --selftest: the ratchet logic (clean/over/new-file/parse-error) holds", () => {
  const { status, out } = run("check-lint.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /OK: \d+ ratchet self-test scenarios/);
  // Belt-and-braces: the scenarios that MUST fail are named in the output.
  // r18-o2 emptied LINT_BASELINE, and check-lint.mjs swaps the scenario pair by
  // design: with no grandfathered debt, the "grandfather → PASS / over → FAIL"
  // cases cannot exist and the first case becomes "any problem with empty
  // baseline → FAIL" (check-lint.mjs, the `--selftest` branch). Pin the names of
  // the regime that is now live, so a future baseline refill that silently drops
  // the empty-baseline case is caught here.
  assert.match(out, /any problem with empty baseline → FAIL/);
  assert.match(out, /new file → FAIL/);
  assert.match(out, /fatal parse → FAIL/);
  assert.match(out, /clean tree → PASS/);
  assert.match(out, /empty report \(eslint linted nothing\) → FAIL/);
});

test("check-lint --print-root: resolves ROOT and the eslint bin from its own file (cwd-independent)", () => {
  // The ratchet must not let the invocation directory decide what it lints.
  // Run from the repo root and from `tests/`; the resolved ROOT has to be identical.
  const fromRoot = JSON.parse(run("check-lint.mjs", ["--print-root"]).out) as {
    root: string;
    bin: string | null;
  };
  const fromTests = JSON.parse(run("check-lint.mjs", ["--print-root"], resolve(ROOT, "tests")).out) as {
    root: string;
    bin: string | null;
  };
  assert.equal(fromRoot.root, ROOT);
  assert.equal(fromTests.root, ROOT, "sub-cwd run resolved a different ROOT — anchoring regressed");
  assert.notEqual(fromTests.root, resolve(ROOT, "tests"));
  assert.ok(fromTests.bin && fromTests.bin.startsWith(ROOT), "eslint bin must resolve under ROOT");
});

// ---------------------------------------------------------------------------
// check-invariants.mjs — the `hooks-path` row (round 15, d13).
// ---------------------------------------------------------------------------
// docs/worktrees.md sells `.githooks/pre-commit` as the wall that stops a
// `.worktrees/**` file being staged (the "Merge with strategy ort failed"
// incident), but a committed hook enforces nothing until core.hooksPath points at
// it, and this machine has never had that set — measured, the active hooks
// directory holds only *.sample. The row must DETECT that and print the exact
// command, while never failing a gate over a machine-local setting.
//
// Both branches are pinned through `--hooks-dir`, because making the real one
// installed would mean writing git config in the shared main checkout — the thing
// this round is explicitly not allowed to do. The fixture dirs live in the OS temp
// directory, not under `tests/`, so nothing here can become repository content.

const FIXTURES = mkdtempSync(join(tmpdir(), "devhub-hooks-"));

function rowOf(args: string[]) {
  const { status, out } = run("check-invariants.mjs", ["--json", ...args]);
  const data = JSON.parse(out) as {
    ok: boolean;
    counts: Record<string, number>;
    checks: { id: string; status: string; count: number; detail: string }[];
  };
  return { status, data, row: data.checks.find((c) => c.id === "hooks-path") };
}

test("hooks-path: reports INFO (never FAIL) and prints the exact install command", () => {
  const { status, data, row } = rowOf([]);
  assert.ok(row, "hooks-path row must be present on every run, installed or not");
  assert.equal(status, 0, "an uninstalled hook is machine-local state — it must not redden someone else's gate");
  assert.equal(data.ok, true);
  assert.ok(["INFO", "PASS"].includes(row.status), `hooks-path must be INFO or PASS, got ${row.status}`);
  // The install command is required only in the state that asks for it. Measured on
  // 2026-10-16: another line ran the very command this row prints (`git config
  // core.hooksPath .githooks`, repo-local), the guard became reachable, the row turned
  // PASS with a detail that names the reachable hook instead of the fix — and this
  // assertion failed the *success*. A test that reddens the thing it was written to
  // recommend is pinning "nobody has fixed this yet", which is the round-15 recorded
  // failure mode (4911e78), just pointed at machine configuration this time.
  if (row.status === "INFO") {
    assert.match(row.detail, /git config core\.hooksPath \.githooks/, "the row must print the command, not just the gap");
    assert.match(row.detail, /\.githooks[/\\]pre-commit|never run/);
  } else {
    assert.match(row.detail, /pre-commit/, "a PASS must name the hook it verified is reachable");
  }
});

test("hooks-path: PASS when the active hooks directory really has the committed guard", () => {
  const dir = resolve(FIXTURES, "hooks-installed");
  mkdirSync(dir, { recursive: true });
  // The row distinguishes "a file named pre-commit is reachable" from "THE guard
  // is reachable" by content, so the PASS fixture must hold the guard's real bytes —
  // a placeholder body would now (correctly) read as bypassed.
  writeFileSync(resolve(dir, "pre-commit"), readFileSync(resolve(ROOT, ".githooks", "pre-commit"), "utf8"));
  const { status, data, row } = rowOf(["--hooks-dir", dir.replace(/\\/g, "/")]);
  assert.equal(status, 0, row?.detail);
  assert.equal(row?.status, "PASS");
  assert.equal(data.counts.FAIL, 0);
  assert.match(row?.detail ?? "", /pre-commit.*present|reachable/i);
});

test("hooks-path: a pre-commit that is NOT the committed guard is INFO (bypassed), not PASS", () => {
  // The silent-pass shape this row now refuses: git runs SOMETHING, so a naive
  // detector calls it reachable, while the committed worktree guard is off.
  const dir = resolve(FIXTURES, "hooks-bypassed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  const { status, row } = rowOf(["--hooks-dir", dir.replace(/\\/g, "/")]);
  assert.equal(status, 0, "a bypassed hook is still machine-local state and must not redden a gate");
  assert.equal(row?.status, "INFO");
  assert.match(row?.detail ?? "", /not the committed/);
  assert.match(row?.detail ?? "", /git config core\.hooksPath \.githooks/, "the row must still print the fix");
});

test("hooks-path: INFO with *.sample evidence when only samples are present", () => {
  const dir = resolve(FIXTURES, "hooks-samples-only");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "pre-commit.sample"), "x\n");
  const { status, row } = rowOf(["--hooks-dir", dir.replace(/\\/g, "/")]);
  assert.equal(status, 0);
  assert.equal(row?.status, "INFO");
  assert.match(row?.detail ?? "", /1 \*\.sample file\(s\) and no `pre-commit`/);
});

test("hooks-path: an unreadable hooks directory is UNKNOWN, not a silent pass", () => {
  // Silence-as-green is the failure this row exists to refuse: a row that could
  // not look must say so rather than report the rule as satisfied.
  const { status, row } = rowOf(["--hooks-dir", resolve(FIXTURES, "no-such-dir").replace(/\\/g, "/")]);
  assert.equal(status, 0);
  assert.equal(row?.status, "INFO");
  assert.match(row?.detail ?? "", /unknown/i);
});

// ---------------------------------------------------------------------------
// check-docs.mjs — file:line citation guard (round 15, d12) and, since round
// 16 (o3-3), the CI workflow run-line scan sharing the same --selftest.
// ---------------------------------------------------------------------------
// The doc text is being rewritten by another line in parallel, so these tests pin
// the CONTRACT (info never fails, --citations=fail does, the classifier works on
// synthetic sources, an unknown flag is rejected) rather than the current stale
// list. Asserting the list itself would make the docs line's gate go red the second
// they fix a citation.

test("check-docs --selftest: the citation classifier and the CI run-line scanner hold without touching repo state", () => {
  const { status, out } = run("check-docs.mjs", ["--selftest"]);
  assert.equal(status, 0, out);
  assert.match(out, /OK: \d+ citation self-test scenarios/);
  // The scenarios that MUST be caught are named in the output; if one silently
  // stopped firing, a stale `lib.rs:1310`-style citation would go back to unreported.
  for (const scenario of [
    "leading symbol on the wrong line → STALE naming the real line",
    "symbol lives in another file → STALE names that file",
    "line past EOF with no symbol beside it → STALE",
    "positional zip of `a`/`b`/`c` onto `file:2/3/2` → exactly one STALE",
    "ambiguous basename → UNRESOLVED, never a fabricated STALE",
  ]) {
    assert.ok(out.includes(`ok    ${scenario}`), `self-test scenario did not pass or is gone: ${scenario}`);
  }
  // Round 16 (o3-3) extended the same --selftest with check 5's CI run-line
  // scanner; its scenarios are named the same way and must hold for the same
  // reason — a silent regression there would un-report a typo'd `pnpm gtae`
  // in a run: line, which only a real Actions run would ever have noticed.
  assert.match(out, /OK: \d+ ci-run self-test scenarios/);
  for (const scenario of [
    "ci-run: every run: shape is extracted, look-alikes are not",
    "ci-run: pnpm builtins are skipped; scripts are checked directly and via `run`",
    "ci-run: a typo'd pnpm script in a run line is a broken reference, line named",
    "ci-run: node scripts/<path> inside a block scalar is checked, line by line",
    "ci-run: foreign commands (cargo) contribute nothing to either count",
  ]) {
    assert.ok(out.includes(`ok    ${scenario}`), `ci-run self-test scenario did not pass or is gone: ${scenario}`);
  }
  assert.ok(!/^\s+FAIL\s/m.test(out), "no self-test scenario may fail");
});

// The live-tree half of check 5: the count line the real workflow scan prints.
// If the scan vanished, the line would be missing or a bare 0 — either way this
// test names it. The floors are deliberately the MINIMUM shapes the workflow
// must keep carrying (a gate call, a lint call, one node scripts/ check), not
// today's exact totals: adding a run line must not fail the suite, deleting the
// references the checker exists for must.
test("check-docs: ci run refs line reports the live workflow scan", () => {
  const { status, out } = run("check-docs.mjs");
  assert.equal(status, 0, out);
  const m = out.match(
    /ci run refs:\s+(\d+) checked in \.github\/workflows\/ci\.yml \(pnpm (\d+), node scripts (\d+)\)/,
  );
  assert.ok(m, `ci run refs count line is missing or malformed:\n${out}`);
  // noUncheckedIndexedAccess（r19-o2-4）：解构默认值是守卫——正则的三个组 matched
  // 就一定在，缺了会让下面的 >= 2 / >= 1 断言红，而不是把 undefined 拖进运算。
  const [total = 0, pnpm = 0, node = 0] = m.slice(1).map(Number);
  assert.equal(total, pnpm + node, "ci run refs total must be the sum of the two shapes");
  assert.ok(pnpm >= 2, `pnpm script references in run: lines shrank to ${pnpm} (expected >= 2)`);
  assert.ok(node >= 1, `node scripts/ references in run: lines shrank to ${node} (expected >= 1)`);
});

/**
 * The citation rows' contract, as of round 15.
 *
 * These two used to assert `stale > 0` on the live tree - i.e. they pinned the
 * *debt level* rather than the mechanism, on the reasoning "the guard finding zero
 * means it stopped working". That reasoning belongs to the citation self-test above
 * (it feeds synthetic stale citations and names every scenario); as a live-tree
 * assertion it broke the moment the docs line paid the debt off, so the suite failed
 * for having fixed the problem.
 *
 * The contract now: default mode is `fail`, a clean tree exits 0, and
 * `--citations=info` also exits 0 on the same tree. Detection itself stays asserted
 * by the self-test, which does not depend on the tree carrying debt.
 */
test("check-docs: citations are enforced by default - mode is fail and a clean tree exits 0", () => {
  const { status, out } = run("check-docs.mjs");
  assert.equal(status, 0, out);
  assert.match(out, /file:line citations:\s+\d+ parsed, \d+ attributed/);
  assert.match(out, /0 stale/);
  assert.match(out, /\(mode: fail\)/);
  assert.ok(!out.includes("FILE:LINE CITATION AUDIT"), "no audit block on a clean tree: " + out);
});

test("check-docs --citations=info: same clean tree, still exit 0, mode reported as info", () => {
  const { status, out } = run("check-docs.mjs", ["--citations=info"]);
  assert.equal(status, 0, out);
  assert.match(out, /\(mode: info\)/);
});

test("check-docs: an unknown argument is rejected, not ignored", () => {
  // A checker that ignores a flag it does not understand is a checker that quietly
  // stops enforcing the thing the flag was for.
  const { status, out } = run("check-docs.mjs", ["--citations=maybe"]);
  assert.equal(status, 2, out);
  assert.match(out, /unknown argument '--citations=maybe'/);
  assert.match(out, /usage: node scripts\/check-docs\.mjs/);
});

// ---------------------------------------------------------------------------
// scripts/pack-portable.ps1 — the "never package a verification probe" guard
// (round 15, d10).
// ---------------------------------------------------------------------------
// The guard used to grep a hard-coded list of four strings that matched NOTHING in
// this tree (measured: 0 hits), so a release ZIP built while scripts/verify-ui.ps1
// had `src/main.tsx` swapped for the acceptance probe shipped the harness with a
// clean guard report. It now reads scripts/verify/probe-markers.json and
// cross-checks that registry against every probe under scripts/verify/.
//
// The PowerShell side is exercised by hand (`-CheckProbeOnly`, fixtures for
// probe-in-src / probe-in-bundle / missing registry / empty registry / unregistered
// probe / probe without a declaration / leftover backup file); what belongs in the
// gate is the *data* invariant, because that is the part that silently rots when
// someone renames a literal and nobody re-runs a packaging. Mirroring the rule here
// costs four file reads and no subprocess.

const VERIFY_DIR = resolve(ROOT, "scripts", "verify");

test("probe markers: the packager reads a registry, not a hard-coded list", () => {
  const ps = readFileSync(resolve(ROOT, "scripts", "pack-portable.ps1"), "utf8");
  assert.match(ps, /verify\\probe-markers\.json/, "guard must load the registry file");
  assert.match(ps, /\$markers\s*=\s*@\(\$registry\.markers\)/, "registry markers must drive the scan");
  // The dead list itself, and nothing resembling it, must be gone from the guard.
  for (const dead of ["'SKIN RESULT'", "'ACCEPTANCE RESULT'", "'RESULT PASS'", "'data-case='"]) {
    assert.ok(
      !new RegExp(`foreach\\s*\\(\\$probe\\s+in\\s+@\\(.*${dead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(ps),
      `the guard still hard-codes ${dead} — the decorative four-string list is back`,
    );
  }
});

test("probe markers: registry exists, is non-empty, and every entry is a bundler-surviving literal", () => {
  const raw = JSON.parse(readFileSync(resolve(VERIFY_DIR, "probe-markers.json"), "utf8")) as { markers?: unknown };
  assert.ok(Array.isArray(raw.markers), "probe-markers.json needs a `markers` array");
  const markers = raw.markers as string[];
  assert.ok(markers.length > 0, "an empty registry turns the guard into no guard at all");
  for (const m of markers) {
    assert.equal(typeof m, "string");
    assert.ok(m.trim().length > 0, "a blank marker matches everything and guards nothing");
    // A marker must be a plain literal, never a fragment of a template string:
    // `RESULT ${x ? "PASS" : "FAIL"}` is exactly why 'RESULT PASS' measured 0 hits.
    assert.ok(!m.includes("${"), `marker ${m} looks template-interpolated`);
    assert.ok(/[A-Za-z]/.test(m), `marker ${m} is not distinctive enough to be a probe identity`);
  }
});

test("probe markers: every probe declares a marker and that marker is registered", () => {
  const probes = readdirSync(VERIFY_DIR).filter((f) => f.endsWith(".tsx"));
  assert.ok(probes.length > 0, "scripts/verify/ holds the acceptance probes this guard exists for");
  const markers = (
    JSON.parse(readFileSync(resolve(VERIFY_DIR, "probe-markers.json"), "utf8")) as { markers: string[] }
  ).markers;
  for (const name of probes) {
    const src = readFileSync(resolve(VERIFY_DIR, name), "utf8");
    const decl = /DEVHUB_PROBE_MARKER\s*=\s*["']([^"']+)["']/.exec(src);
    assert.ok(decl, `scripts/verify/${name} declares no DEVHUB_PROBE_MARKER literal, so the packager cannot detect it`);
    assert.ok(
      markers.includes(at(decl, 1)),
      `scripts/verify/${name} emits '${decl[1]}' which is not registered in probe-markers.json`,
    );
    assert.ok(
      src.includes(`"${decl[1]}"`) || src.includes(`'${decl[1]}'`),
      `marker '${decl[1]}' must appear as a quoted literal (a comment is stripped by the bundler)`,
    );
  }
});


test("check-docs --rewrite=dry: prints a TSV plan and writes nothing", () => {
  // Why the flag exists on the guard at all: every direction that edits `lib.rs` or
  // `downloader.rs` shifts a dozen `file:line` citations, and on 2026-10-16 that
  // re-derivation was done three separate times by hand, eight doc lines at a time.
  // The guard already computes the right number — it prints it in the STALE detail —
  // so the only gap was saying it in a form nobody has to transcribe.
  //
  // Only the DRY mode is exercised, deliberately: `--rewrite` writes to the repository,
  // and a test that invokes a writing mode can turn someone's in-progress docs edit into
  // a surprise. So the assertions are about the plan's SHAPE and about the tree being
  // untouched — never about how many citations are stale right now, because a count
  // here would fail the moment a citation is fixed. That is the same reasoning that
  // gives the classifier a --selftest instead of assertions against the live docs.
  const docs = ["README.md"];
  const before = docs.map((d) => readFileSync(resolve(ROOT, d), "utf8"));
  const { status, out } = run("check-docs.mjs", ["--rewrite=dry"]);
  assert.equal(status, 0, out);
  assert.match(out, /^check-docs --rewrite=dry \(nothing written\)$/m, out);
  assert.match(out, /^# plan: \d+ citation\(s\)/m, out);
  for (const line of out.split("\n")) {
    if (!line.includes("\t")) continue;
    const f = line.split("\t");
    assert.equal(f.length, 4, `plan row is not 4 tab-separated fields: ${line}`);
    assert.match(at(f, 2), /:\d+$/, `old citation carries no line number: ${line}`);
    assert.match(at(f, 3), /:\d+$/, `suggested citation carries no line number: ${line}`);
    assert.notEqual(at(f, 2), at(f, 3), `a plan row that would change nothing: ${line}`);
    assert.equal(at(f, 2).split(":")[0], at(f, 3).split(":")[0], `a plan row that changes the file: ${line}`);
  }
  docs.forEach((d, i) => {
    assert.equal(readFileSync(resolve(ROOT, d), "utf8"), before[i], `${d} was modified by --rewrite=dry`);
  });
});
