/**
 * R3-3 — the dist size budget in scripts/check-dist.mjs, pinned as a RATCHET.
 *
 * Why synthetic fixtures instead of the real dist/: the repo's own
 * `pnpm build` output is a moving target owned by other streams, and a test that
 * asserts "the shipped bundle is under 790 kB" fails the moment someone adds a
 * component — which is the check telling the truth about the tree but lying about
 * THIS file's logic. What has to be pinned here is the mechanism: that a ceiling is
 * compared, that exceeding it exits 1 and says by how much, and that the checker
 * anchors on its own directory rather than the caller's cwd (the failure
 * check-events.mjs documents at :20-26 — running from `tests/` used to scan the
 * wrong tree).
 *
 * So each case writes a complete throwaway repository into tmp: a copy of the real
 * checker with only the four ceiling constants rewritten, plus a minimal but
 * structurally valid dist/ (entry html, one js, its map, one css). Both directions
 * are covered — under budget exits 0 and names every budget, over budget exits 1
 * with the overage — because a ratchet whose FAIL path has never run is decoration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { at } from "./helpers/definite.ts";

const CHECKER = resolve(process.cwd(), "scripts", "check-dist.mjs");

const CEILINGS = [
  "JS_TOTAL_MAX_BYTES",
  "CSS_TOTAL_MAX_BYTES",
  "SINGLE_CHUNK_MAX_BYTES",
  "JS_CSS_TOTAL_MAX_BYTES",
  "INITIAL_JS_MAX_BYTES",
];

/**
 * A tmp repo holding the checker with its ceilings replaced by `sizes`.
 *
 * `writeFileSync` of a patched copy rather than a flag, because the ceilings are
 * deliberately compile-time constants: making them overridable at runtime would
 * let any caller mute the ratchet, which is the opposite of what a budget is for.
 */
function makeFixture(ceilings: Record<string, number>, opts: { empty?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "devhub-dist-budget-"));
  let src = readFileSync(CHECKER, "utf8");
  for (const [name, value] of Object.entries(ceilings)) {
    const before = src;
    src = src.replace(new RegExp(`^const ${name} = [\\d_]+;`, "m"), `const ${name} = ${value};`);
    assert.notEqual(src, before, `fixture could not patch the ${name} constant — the declaration form changed`);
  }
  const scriptsDir = join(dir, "scripts");
  const assets = join(dir, "dist", "assets");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(scriptsDir, "check-dist.mjs"), src);
  if (opts.empty) {
    // The no-assets case (r19-B2): an entry that references nothing local, so
    // assets/ stays empty and every budget reads 0 B. Nothing else changes —
    // the checker under test is byte-identical to the other fixtures'.
    writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    return { dir, script: join(scriptsDir, "check-dist.mjs") };
  }
  // Structurally valid: the entry references only files that exist, and the .js has
  // a .map beside it, so the pre-existing sourcemap rules stay satisfied and the
  // ONLY thing able to fail this run is the size budget.
  writeFileSync(
    join(dir, "dist", "index.html"),
    '<!doctype html><html><head><link href="/assets/a.css" rel="stylesheet"></head>' +
      '<body><script type="module" src="/assets/a.js"></script></body></html>',
  );
  writeFileSync(join(assets, "a.js"), "console.log(1);\n//# sourceMappingURL=a.js.map\n");
  writeFileSync(join(assets, "a.js.map"), '{"version":3}');
  writeFileSync(join(assets, "a.css"), "body{margin:0}\n");
  return { dir, script: join(scriptsDir, "check-dist.mjs") };
}

function runScript(script: string, args: string[] = [], cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, timeout: 30_000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const ALL_1 = Object.fromEntries(CEILINGS.map((n) => [n, 10]));
const ALL_BIG = Object.fromEntries(CEILINGS.map((n) => [n, 10_000_000]));

test("check-dist budget: under ceiling exits 0 and reports every budget line", () => {
  const { script } = makeFixture(ALL_BIG);
  const { status, out } = runScript(script);
  assert.equal(status, 0, out);
  assert.match(out, /OK: dist entry resolves, sourcemaps present as configured, all size budgets held/);
  for (const label of ["JS total", "CSS total", "largest single chunk", "JS+CSS total shipped", "initial JS"]) {
    // Escaped: the labels contain `+`, `(` and `.`, and a label that silently stops
    // matching is a test that quietly asserts nothing.
    const pattern = `budget ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    assert.match(out, new RegExp(pattern), `missing budget line for ${label} in:\n${out}`);
  }
  assert.doesNotMatch(out, /SIZE BUDGET EXCEEDED/);
});

test("check-dist budget: over ceiling FAILS with exit 1 and prints current vs ceiling", () => {
  const { script } = makeFixture(ALL_1);
  const { status, out } = runScript(script);
  assert.equal(status, 1, `an over-budget bundle must not exit 0:\n${out}`);
  assert.match(out, /SIZE BUDGET EXCEEDED \(\d+\)/);
  assert.match(out, /vs \d+ B \(\d+\.\d kB\) ceiling/);
  assert.match(out, /over by \d+ B/);
  // The whole point of a ratchet: it tells you the number you hit and the number
  // you may not pass, in the same breath, or the reader has to go find the source.
  assert.match(out, /js \d+ \(\d+\.\d kB\), css \d+ \(\d+\.\d kB\)/);
});

test("check-dist budget: the ceilings in the real file are above the measured baseline", () => {
  // Guards against the quietest way to break a ratchet — accidentally editing a
  // constant down to something the current build already exceeds, which turns the
  // gate red for a reason that has nothing to do with the change under review.
  const src = readFileSync(CHECKER, "utf8");
  for (const name of CEILINGS) {
    const m = new RegExp(`^const ${name} = ([\\d_]+);`, "m").exec(src);
    assert.ok(m, `check-dist.mjs no longer declares ${name} as a numeric literal`);
    const value = Number(at(m, 1).replace(/_/g, ""));
    assert.ok(value >= 1000, `${name} = ${value} is below 1 kB — a real bundle cannot fit`);
  }
});

test("check-dist --budgets: prints every ceiling as pasteable source", () => {
  const { script } = makeFixture(ALL_BIG);
  const { status, out } = runScript(script, ["--budgets"]);
  assert.equal(status, 0, out);
  for (const name of CEILINGS) {
    assert.match(out, new RegExp(`const ${name} = \\d+;`), `--budgets did not print ${name} in pasteable form:\n${out}`);
  }
});

test("check-dist: an unrecognised argument is rejected with exit 2, not ignored", () => {
  // A checker that silently accepts a typo'd flag is a checker that silently stops
  // running — the rule check-docs.mjs states for itself.
  const { status, out } = runScript(CHECKER, ["--budget-typo"]);
  assert.equal(status, 2, out);
  assert.match(out, /unrecognised argument/);
});

// ---------------------------------------------------------------------------
// r19-B2: the comparison itself, at its edges.
//
// The fixtures above are far from the line (ceiling 1 vs ceiling 10M), so they
// pin the exit codes but not the comparison. `over` is a strict `got > max`,
// which makes EQUALITY the pass boundary — the one value a casual `>=` rewrite
// would flip — and max+1 the fail boundary. Byte-exact fixtures pin both.

/** Ceilings sized to the exact fixtures below, so every budget sits on the line. */
const AT = { JS_TOTAL_MAX_BYTES: 100, CSS_TOTAL_MAX_BYTES: 50, SINGLE_CHUNK_MAX_BYTES: 100, JS_CSS_TOTAL_MAX_BYTES: 150 };

test("check-dist budget: got == ceiling passes (the boundary a >= rewrite would flip)", () => {
  const { dir, script } = makeFixture(AT);
  // Byte-exact: 100 js + 50 css. All four budgets read got == max, and a strict
  // `>` must pass every one of them. The map is found by readdir (it only needs
  // to exist), and its size is unbudgeted, so it does not shift the boundary.
  writeFileSync(join(dir, "dist", "assets", "a.js"), "x".repeat(100));
  writeFileSync(join(dir, "dist", "assets", "a.js.map"), "{}");
  writeFileSync(join(dir, "dist", "assets", "a.css"), "y".repeat(50));
  const { status, out } = runScript(script);
  assert.equal(status, 0, `equality must pass a strict > comparison:\n${out}`);
  assert.match(out, /100\.0% used/);
  assert.doesNotMatch(out, /OVER BUDGET/);
});

test("check-dist budget: one byte over one ceiling fails, and only over budgets are named", () => {
  const { dir, script } = makeFixture(AT);
  // js 101/100 and js+css 151/150 are over; css 50/50 sits exactly on the line
  // and must NOT be named in the exceeded block — a per-budget verdict, not a
  // single tripwire, is what tells the reader WHICH regression landed.
  writeFileSync(join(dir, "dist", "assets", "a.js"), "x".repeat(101));
  writeFileSync(join(dir, "dist", "assets", "a.js.map"), "{}");
  writeFileSync(join(dir, "dist", "assets", "a.css"), "y".repeat(50));
  const { status, out } = runScript(script);
  assert.equal(status, 1, out);
  const exceeded = /SIZE BUDGET EXCEEDED \(\d+\)[\s\S]*/.exec(out)?.[0] ?? "";
  assert.match(exceeded, /JS total/);
  // Anchored to the line form: the exceeded block also names `JS+CSS total`,
  // whose text contains the substring "CSS total".
  assert.doesNotMatch(exceeded, /^  - CSS total/m);
});

test("check-dist budget: no assets at all reads 0 B, names the (none) chunk, and passes", () => {
  // The missing-field case: dist/ exists with an entry that references nothing
  // local, so assets/ stays empty. Every reduce runs over an empty list and the
  // largest-chunk spread is empty — the `?? { f: "(none)", n: 0 }` fallback. A
  // NaN or a crash here would take the whole gate down on a case that is legal
  // as far as this checker's own structural rules go.
  const { script } = makeFixture(AT, { empty: true });
  const { status, out } = runScript(script);
  assert.equal(status, 0, out);
  assert.match(out, /largest single chunk \(\(none\)\): 0 B vs \d+ B ceiling \(0\.0% used\)/);
  assert.match(out, /js 0 \(0\.0 kB\), css 0 \(0\.0 kB\)/);
  assert.doesNotMatch(out, /OVER BUDGET/);
});

test("check-dist: anchors on its own directory, so a sub-cwd invocation sees the same tree", () => {
  // The regression check-events.mjs records at :20-26: paths resolved against the
  // SHELL's cwd died with ENOENT when a checker was run from `tests/`. Addressed by
  // absolute path so the CHILD's cwd, not this process's, is what could break it.
  const fromRoot = runScript(CHECKER);
  const fromTests = runScript(CHECKER, [], resolve(process.cwd(), "tests"));
  assert.equal(fromRoot.status, fromTests.status, `cwd changed the verdict:\n${fromRoot.out}\n---\n${fromTests.out}`);
  // No build on disk (the normal state of a linked worktree, which never runs
  // `pnpm build`): there is no tree to anchor to, so the property cannot be observed
  // here at all. Reported as skipped with the reason printed, never as a pass —
  // DEVELOPMENT.md's 「没跑」不等于「通过」, and the version of this test that asserted
  // on whatever dist happened to be on disk is what made the gate depend on which
  // worktree last built.
  if (/dist\/ does not exist/.test(fromRoot.out)) {
    console.log("  SKIPPED: no dist/ in this checkout — anchoring cannot be observed without a build");
    return;
  }
  const grab = (s: string) => /js\+css bytes in dist\/assets: (\d+)/.exec(s)?.[1] ?? "(none)";
  assert.notEqual(grab(fromRoot.out), "(none)", `the size line was not printed at all:\n${fromRoot.out}`);
  assert.equal(grab(fromRoot.out), grab(fromTests.out), "the two runs measured different totals — one of them scanned a different tree");
  // What is deliberately NOT asserted here: that the bundle on disk obeys the
  // ceilings. `pnpm gate` does not build, so `dist/` is whatever some earlier
  // command left behind — possibly from a different worktree, since every worktree
  // here shares one repo. Measured on 2026-10-16: with a fresh `pnpm build` at
  // master the four budgets read 95.3 / 90.7 / 94.1 / 95.2 % of ceiling, while a
  // leftover `dist/` from another tree put `index-*.js` at 247779 B and this very
  // test failed as a "bundle-size regression" that no source had caused. That is the
  // round-15 recorded failure mode of pinning an artefact instead of a mechanism
  // (`c0dde6e`), and a gate whose verdict depends on which worktree last ran a build
  // cannot be trusted in either direction. The real budget check belongs to
  // `pnpm verify`, which builds first and therefore measures what it claims to.
});
