// Static invariant checker for DevHub.
//
// Why this file exists next to check-commands.mjs rather than replacing it:
// the project's verification culture is home-grown scripts, because the things
// that actually broke here are not the things a generic linter looks for. This
// one checks the *second-order* promises — "every invoke() has a handler", "the
// a11y attribute did not regress", "nobody grew the escape hatches" — that a
// human has otherwise been carrying in their head between rounds.
//
// Every check is one of four statuses, and the distinction matters (see the
// note in DEVELOPMENT.md about "没跑" vs "通过"):
//
//   PASS     the rule holds
//   FAIL     the rule holds no longer — exit code 1
//   INFO     reported, never fails (a count worth seeing, not a violation)
//   PENDING  the rule is real but deliberately not enforcing yet, because it is
//            blocked on another stream. See PENDING_UNTIL below.
//
// Dependency-free by rule: node:fs, node:path, node:child_process only.
// Run `node scripts/check-invariants.mjs --json` for machine-readable output,
// `--baseline` to print the baseline constants this file is carrying,
// `--hooks-dir <dir>` to evaluate the `hooks-path` row against a directory other
// than the active one (that override is what lets `tests/checkers.test.ts` prove
// both the installed and the absent branch without touching anyone's git config),
// or `--selftest` to run the `tauri-security` and `rust-swallowed-errors`
// classifiers against synthetic inputs (no repo state, no network).
// Exit codes follow the shared checker contract: 0 = no FAIL row, 1 = a FAIL row,
// 2 = usage error (an unrecognised flag is rejected, never ignored).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Root anchoring
// ---------------------------------------------------------------------------
// Every path below (`walk("src")`, `existsSync("src-tauri/src")`, the
// check-commands.mjs subprocess, `eslint.config.js`, `node_modules/eslint`) is
// spelled relative to the repo root, and until now the script only worked when
// the shell's cwd happened to be that root: `node ../scripts/check-invariants.mjs`
// from a subdirectory died on the first `readdirSync("src")` with ENOENT, and a
// workspace-level `pnpm check` from a parent directory would fail the same way.
// Anchor once to the script's own location — the same rule check-docs.mjs
// follows — so the invocation directory no longer decides whether the checks
// can run. `chdir` rather than joining ROOT into every read keeps the *reported*
// paths (`src-tauri/src/lib.rs`) relative, which is what the baseline keys and
// the ratchet messages are written against; the check-commands.mjs subprocess
// inherits this cwd, which it needs because it scans its own paths relatively.
// Regression guard: `tests/checkers.test.ts` runs this file from `tests/`.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

// ---------------------------------------------------------------------------
// CLI contract (round 17 o3-3)
// ---------------------------------------------------------------------------
// The flags are the same shape every other checker in `pnpm check` uses, and the
// exit codes are the shared contract: 0 = passed, 1 = a FAIL row, 2 = could not
// decide (here, a usage error — an unknown flag). Unknown flags used to be
// ignored silently, which is how a typo'd `--jsno` turns a checker into a no-op
// that still exits green. `--hooks-dir` consumes the following token.
const CLI_KNOWN = new Set(["--json", "--baseline", "--hooks-dir", "--selftest", "--help"]);
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--hooks-dir") {
      i += 1; // its value is the next token, whatever it looks like
      continue;
    }
    if (!CLI_KNOWN.has(argv[i])) {
      console.error(`check-invariants.mjs: unknown argument '${argv[i]}'`);
      console.error("usage: node scripts/check-invariants.mjs [--json] [--baseline] [--hooks-dir <dir>] [--selftest] [--help]");
      process.exit(2);
    }
  }
  if (argv.includes("--help")) {
    console.log(
      "node scripts/check-invariants.mjs [--json] [--baseline] [--hooks-dir <dir>] [--selftest] [--help]\n" +
        "  (no flag)          run every check; exit 0 = all PASS/INFO, 1 = a FAIL row\n" +
        "  --json             machine-readable verdict {ok, counts, checks}\n" +
        "  --baseline         print the ratchet baseline constants this file carries\n" +
        "  --hooks-dir <dir>  evaluate the hooks-path row against <dir>\n" +
        "  --selftest         run the tauri-security and rust-swallowed-errors classifiers over synthetic inputs\n" +
        "exit 2 is reserved for a usage error (an unrecognised flag)",
    );
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
// These numbers are a ratchet, not a style opinion. Each was measured on the
// tree at the time it was committed; a check fails only when a file goes ABOVE
// its own baseline, so existing debt is invisible to new work and a fix that
// lowers a number is free. When you deliberately remove some debt, lower the
// constant — never raise it without saying why in the commit message.
//
// Regenerate the whole set with: node scripts/check-invariants.mjs --baseline

/**
 * `as any` / `as unknown as` / `as never` / `@ts-ignore` occurrences per file.
 *
 * Counted on comment-stripped source: the previous numbers included prose that
 * merely *mentioned* a cast (RecordsView's docblock explaining the `as never`
 * backdoor it removed), so the ratchet was partly made of sentences.
 *
 * Empty as of 2026-10-15, and it was empty because the debt was *paid*, not
 * because nobody looked: the three keys this carried (`src/App.tsx` 1,
 * `src/dialogs/ProjectSettingsDialog.tsx` 2, `src/views/ProjectsView.tsx` 1) all
 * measured 0 on the current tree, while the rule still compared `n > baseline`
 * — so the file had silently gifted back four `as any` re-introductions. The
 * `ratchet-integrity` check below is what makes that state impossible to keep:
 * a baseline key naming a file that measures zero now fails the run.
 */
const ESCAPE_HATCH_BASELINE = {};

/**
 * `.unwrap()` / `.expect(` / `panic!(` / `assert!(` outside `#[cfg(test)]` per
 * Rust file.
 *
 * Production panics are the failure mode this counts. A `.expect()` in a command
 * handler turns one bad directory into a WebView that stopped answering, which is
 * exactly the class of report the round-8 audit was written about.
 *
 * d7-2b (2026-10-15): the regex gained the bare panic/assert macros —
 * `panic!(`, `assert!(`, `assert_eq!(`, `assert_ne!(`, each behind a
 * lookbehind so `debug_assert!(` is not counted twice. Measured with
 * `--baseline` before and after on this exact tree: identical
 * (`src-tauri/src/lib.rs` sat at 1 then, the process-entry `.expect`; r18-o2
 * removed that one too — see the baseline note below) — every
 * macro occurrence lives inside a `#[cfg(test)]` module or a comment, i.e. the
 * production tree really was panic-free and the wider net merely proves it
 * stays that way. No baseline constant moved by that round.
 */
const UNWRAP_BASELINE = {
  // Measured, not assumed: the whole `src-tauri/src` tree has 351 lines matching
  // `.unwrap()`/`.expect(` as of 2026-10-17 (187 when first measured — the test
  // suites grew), but only FOUR of them were ever outside a `#[cfg(test)]`
  // module. The Rust side is already panic-disciplined in production code; the
  // number that looks alarming is a test-fixture count. Verified twice — once by
  // brace-skipping (stripCfgTest) and once by line cutoff at the first
  // `#[cfg(test)]` — and the two agree.
  //
  // 3 → 1 on 2026-10-14: two of the three were `.expect()` written *inside*
  // doc-comments, and the third (`activity.rs` `ts_string`) was a genuine
  // production panic under `panic = "abort"` that round-11 removed.
  //
  // 1 → 0 on 2026-10-17 (r18-o2): the last one was the process-entry
  // `.expect("error while running tauri application")`. A doc-comment here used
  // to argue there was nothing else to do; there is — a match arm prints the
  // builder's error to stderr and exits non-zero, which is strictly more than
  // abort-with-no-reason gives under `panic = "abort"`. Empty baseline: the
  // production tree has no panic channel left, and any new one fails the gate.
};

/**
 * Production sites that explicitly discard a `Result` / a must-use value — the
 * "swallowed error" shapes (round 17 o4-1):
 *
 *   * `let _ = <expr>;` — the value is thrown away, error and all. This is the
 *     dominant shape here, and most of the current ones are deliberate teardown
 *     (`child.kill()` / `child.wait()` / `h.join()` / `remove_dir_all`, where the
 *     only honest reaction is to keep going); the ratchet's job is to stop NEW
 *     ones, not to relitigate the existing ones.
 *   * `#[allow(unused_must_use)]` — the lint silenced by hand (none today).
 *
 * `.ok();` is deliberately NOT counted, and that is a correction, not an
 * omission: `.ok()` turns a `Result` into an `Option`, and the only form that
 * drops it on the floor is the statement one — but no regex can tell a discarded
 * `x.ok();` from the benign `let a = x.ok();` conversion, and every production
 * `.ok();`-terminated line on this tree is the benign form (e.g. `idescan.rs`'s
 * `sub.get_value(...).ok()`). Counting them would have added sites that are not
 * debt, which is how a ratchet earns the right to be dismissed.
 *
 * Production-only, exactly like `rust-unwrap` above and for the same reason: the
 * test tree is full of deliberate `let _ = remove_dir_all(...)` cleanups, and
 * counting those would turn this row into a measure of how much test teardown a
 * file has, not of debt in the shipped code. `stripCfgTest` removes the test
 * modules; `stripComments` keeps a doc comment that merely *mentions* the shape
 * from inflating the count.
 *
 * Direction: a ratchet. A file may not go ABOVE its baseline; paying a file down
 * is free (lower the constant in the same commit — `ratchet-integrity` below
 * forces the entry out once a file reaches 0).
 *
 * Measured with `--baseline` on the tree this row was added to (2026-10-17): 121
 * sites (120 after o4-2 removed the one lint workaround), and every one was read —
 * `child.kill()` / `child.wait()` / `h.join()` /
 * `remove_dir_all` / `remove_file` teardown, `writeln!` into an infallible
 * `String`, a `tx.send` whose receiver may be gone, an ignored window-state
 * `set_*`, or a documented best-effort rollback. The number is large because
 * teardown is large, not because 121 errors are hidden; the row's value is that
 * the NEXT one has to justify itself.
 */
const SWALLOWED_ERROR_BASELINE = {
  "src-tauri/src/activity.rs": 9,
  "src-tauri/src/downloader.rs": 40,
  "src-tauri/src/gitboot.rs": 12,
  "src-tauri/src/idescan.rs": 3,
  // 8 → 7 on 2026-10-17 (o4-2): the `let _ = idx;` at the parallel-batch loop was
  // not an error swallow but a lint workaround for an unused `(usize, &LaunchStep)`
  // tuple, so the dead element was dropped and the workaround with it.
  "src-tauri/src/launch.rs": 7,
  // 37 → 40 on 2026-10-17 (r2 single-instance): the second-instance callback
  // does best-effort `unminimize` / `show` / `set_focus` on the existing window;
  // any of these can fail (window already gone) and the only honest reaction is
  // to keep going. Filed under the ratchet, not removed.
  // 40 → 38 on 2026-10-20 (r21-O1-1): the settings section moved verbatim to
  // settings_cmd.rs — its 2 sites moved with it (see the entry below), nothing
  // was added or removed. The per-file ratchet must follow a mechanical split,
  // or every extraction would read as "new swallowed errors".
  // 38 -> 33 on 2026-10-20 (r21-O1-2): the watch commands and the headless
  // checks moved out of lib.rs; their 5 sites went to headless.rs (see below),
  // nothing added or removed.
  "src-tauri/src/lib.rs": 33,
  // 6 → 2 on 2026-10-24 (r25-R1): the ETag path needed a dozen best-effort temp /
  // sidecar removals. Routing them through one `discard()` helper paid the old 6
  // teardown sites down to that helper, and left `write_etag`'s single best-effort
  // write; the count is what is left after the new work, not an allowance for it.
  "src-tauri/src/ogimage.rs": 2,
  "src-tauri/src/proc.rs": 5,
  "src-tauri/src/search.rs": 1,
  // 2 on 2026-10-20 (r21-O1-1): inherited verbatim from lib.rs when the
  // "Application settings (persisted)" section became this module. The same two
  // deliberate teardown sites, not new debt; the lib.rs entry above was reduced
  // by exactly this amount in the same commit.
  "src-tauri/src/settings_cmd.rs": 2,
  // 5 on 2026-10-20 (r21-O1-2): inherited verbatim from lib.rs with the
  // run_headless_* checks. Same deliberate teardown sites, not new debt; the
  // lib.rs entry was reduced by exactly this amount in the same commit.
  "src-tauri/src/headless.rs": 5,
};

/**
 * The rule, stated once. `let _ = ` also matches a bare-identifier discard
 * (`let _ = idx;`), which is a lint workaround rather than an error swallow — it
 * stays counted rather than special-cased, and the site was removed in o4-2
 * precisely because a workaround that has to exist is a finding in itself.
 */
const SWALLOWED_ERROR = /\blet\s+_\s*(?::[^=;]*)?=|#\[allow\([^)]*unused_must_use[^)]*\)\]/g;

/**
 * Floor for the number of test functions under `src-tauri/src`.
 *
 * Measured 2026-10-16 on this tree, two independent ways that agree:
 * `rg -o '#\[test\]' src-tauri/src` → 210 occurrences across 16 files, and this
 * checker's own comment/string-stripped count → 210 (so nothing today hides in
 * a doc comment or a string literal either). `#[tokio::test…]` → 0 — the count
 * pattern still covers it so the floor keeps working if async tests appear.
 *
 * Direction: FAIL below the floor, free to GROW above it — the same discipline
 * as `ipc-floor`, and the same reason. The ratchets in this file stop *growth*;
 * this one stops *shrinkage*, because nothing else in `pnpm gate` reads the
 * Rust suite: the only consumer of these test functions is `cargo test`, whose
 * entry point at the time this row was added was a CI file this repo has never
 * executed (see .github/workflows/ci.yml's header) plus DEVELOPMENT.md's
 * manual instructions. A deleted `#[test]` used to cost nothing: same green
 * gate, smaller suite.
 *
 * Raising this floor is a deliberate act: re-measure with the `rg` line above,
 * and say in the commit message why the suite grew. Lowering it means a test
 * really was removed — say which one and why that is not a loss.
 */
const RUST_TEST_FLOOR = 210;
// Measured in r20-O3 after `covers.rs` (6 328→6 386) and the three worktree command
// shells left lib.rs: `node -e` split on "\n" over src-tauri/src/lib.rs = 7 734.
// Round 18's extraction of deps.rs is the last time this file got smaller on
// purpose, so the ceiling starts where the two r20-O3 extractions landed it.
// r20-O2 raised this from 7 734 to the measured 7 785, in the commit that also moved
// `insert_bounded` out into `cache.rs`: the file is still 186 lines below where round 20
// started it (7 971 at `f6aa378`), and the growth is two documented constants plus the
// async body of one command. A ceiling that cannot move with a recorded reason is a
// rule people learn to reset; the reason has to be in the diff, which is what this
// comment is.
// Re-measured on 2026-10-18 after the round-20 merges landed on master: 7 823.
// The delta over the previous value is two contributions, neither of them a drift:
// this round's bounded-cache machinery (+51, see the note above) and the concurrent
// line's `searchgrep` command group. The file is still 148 lines below the 7 971 it
// started this round at (`f6aa378`), which is the second half of the rule and the
// reason raising the constant here is not the same thing as letting it slide.
//
// Raised 7823 -> 7832 on 2026-10-19 after the r19/o1-add merge (`10708a4`) landed
// on master: its B1 `list_activity(force)` + the merge's visibility changes
// (`pub(crate)` on the shared `Log` / helpers / `record_activity` so the new
// `cache` / `covers` / `deps` / `stars` modules can call them) net +9 lines.
// The file is still 139 lines below the 7 971 it started this round at
// (`f6aa378`), so the ceiling stays below the round start.
//
// Raised 7832 -> 7863 on 2026-10-19 after the r18-r3-token merge (`f588f96`)
// landed on master: the `verify_github_token` command + its `auth.rs` module
// registration net +31 lines. The file is still 108 lines below the 7 971 it
// started this round at (`f6aa378`), so the ceiling stays below the round start.
// Lowered 7863 -> 6027 on 2026-10-21 (r21-O1 + r21-N4 + r21-R2): the O1
// splits took lib.rs to 5981, N4 added `mod netstatus;` + one handler row
// (+2 -> 5983), then R2 added the process://update notifier wiring
// (+43 -> 6026 today). The ceiling follows the file down so the next round
// starts from the smaller number; raising it again needs its own recorded
// reason, same rule as above.
const LIB_RS_CEILING = 5680; // r34: +4 handler rows and health/secrets module declarations

/**
 * One match = one test function: `#[test]`, `#[tokio::test]`,
 * `#[tokio::test(flavor = "multi_thread")]`, `#[actix_web::test]`.
 *
 * It cannot match `#[cfg(test)]` or `#[cfg_attr(…, test)]` — the pattern
 * demands `test` immediately after `#[` (optionally behind `path::` segments),
 * and `cfg(`/`cfg_attr(` never start with that. `#[should_panic]` and friends
 * are attributes of an already-counted function, not extra tests.
 */
const RUST_TEST_ATTR = /#\[(?:[A-Za-z_][A-Za-z0-9_]*::)*test(?:\s*\([^)]*\))?\]/g;

/**
 * Hardcoded transition durations per tsx file — the motion-token ratchet.
 *
 * The rule this implements: a `.tsx` className must state a duration through a
 * `--motion-*` token, because `src/index.css:305` defines `--motion-scale` and the
 * three skins override it (`1.04` soft at `:745`, `0.44` crisp at `:766`, `0.72`
 * bold at `:788`). A literal `duration-150` therefore ignores the user's chosen
 * skin — the control animates at 150 ms in every one of them.
 *
 * 2026-10-15, the honest version of this baseline. Two things were wrong before:
 *
 *   1. The regex was `/duration-\[|transition-all/`. `duration-[` only ever
 *      matches the **bracket** form, and every bracket form in this tree is
 *      `duration-[var(--motion-…)]`, i.e. the *compliant* spelling. So the rule
 *      counted token uses as violations, could not see `duration-150` at all, and
 *      the 6 hits it reported were 6 acts of compliance.
 *   2. Because of (1) the baseline (3 files x 2) grandfathered nothing real while
 *      22 hardcoded literals sat outside its view entirely.
 *
 * The regex now matches literals (`duration-<number>`, `duration-[150ms]`) and
 * `transition-all`, and never matches `duration-[var(…)]`. Re-baselined from
 * `--baseline` with that regex: 22 sites in 11 files, all of them existing debt
 * (`.tsx` files belong to other streams, so this commit makes the checker see
 * them rather than migrate them). The `motion-token-coverage` line reports the
 * remaining debt on every run; paying a file down to zero makes `ratchet-integrity`
 * demand that its key be deleted, which is what turns the list into real debt
 * rather than a permanent allowance.
 *
 * 2026-10-15: all 11 files paid down to zero — every hardcoded duration was
 * migrated to a `duration-[var(--motion-…)]` token form that honours the skin's
 * `--motion-scale` override, so this table is now empty. `motion-token-coverage`
 * reports PASS (0 remaining); `ratchet-integrity` holds because no key names a
 * live file with non-zero debt.
 */
const MOTION_BASELINE = {};

/**
 * Checks that report a real gap but do not fail yet, and who unblocks them.
 *
 * Flipping one of these to enforcing is a one-line deletion here plus a baseline
 * commit — the check itself already computes the answer.
 *
 * Empty as of 2026-10-15, and it is *not* empty because the rules were dropped.
 * `dialog-a11y` was deferred with the note "wait for `feat/d5-accessibility` to
 * merge"; that branch merged and `src/components/DialogShell.tsx` now carries
 * both `role="dialog"` and `aria-modal`, so the condition it was waiting on has
 * been met. A deferral whose blocker is gone is not a deferral, it is an
 * off-switch: had anyone deleted those two attributes, the run would have printed
 * a non-blocking PENDING instead of a FAIL. The rule is now enforcing, and this
 * table only holds gaps that are still open on the current tree.
 */
const PENDING_UNTIL = {};

// ---------------------------------------------------------------------------
// Ratchet descriptors
// ---------------------------------------------------------------------------
// One entry per file-scoped ratchet. The shape exists so the *same* measurement
// backs the growth rule, the `--baseline` printer, and `ratchet-integrity` below;
// three copies of a regex is how a ratchet and its own regeneration command
// start disagreeing.

/**
 * The motion-token rule, stated once.
 *
 * `MOTION_VIOLATION` is a *violation*: a duration written as a literal the skins
 * cannot rescale. `duration-\d+` is the Tailwind preset form (`duration-150`),
 * `duration-\[\s*\d+(ms|s)?\]` is the arbitrary form (`duration-[200ms]`), and
 * `transition-all` is the layout-animating class `src/index.css:450` records as a
 * previous 24-control mistake. The bracket form that carries a token
 * (`duration-[var(--motion-state)]`) is deliberately NOT a violation, which is the
 * whole point of splitting the two regexes: the old rule matched exactly those
 * compliant uses and counted 6 violations that were 6 correct answers.
 */
const MOTION_VIOLATION = /\bduration-\d+\b|\bduration-\[\s*\d+(?:ms|s)?\]|\btransition-all\b/g;
const MOTION_TOKEN_USE = /\bduration-\[\s*var\(--motion[^)]*\)\]/g;

const RATCHETS = [
  {
    id: "escape-hatches",
    what: "as any / as unknown as / as never / @ts-ignore",
    files: () => TS_FILES,
    measure: (f) => countAll(stripComments(read(f)), /\bas any\b|\bas unknown as\b|\bas never\b|@ts-ignore/g),
    baseline: () => ESCAPE_HATCH_BASELINE,
    violationLabel: "new escape hatch",
  },
  {
    id: "rust-unwrap",
    what: "production .unwrap() / .expect( / panic!( / assert!(",
    files: () => RUST_FILES,
    measure: (f) =>
      countAll(
        stripComments(stripCfgTest(read(f)), { rust: true }),
        /\.unwrap\(\)|\.expect\(|(?<![A-Za-z0-9_])panic!\(|(?<![A-Za-z0-9_])assert!\(|(?<![A-Za-z0-9_])assert_eq!\(|(?<![A-Za-z0-9_])assert_ne!\(/g,
      ),
    baseline: () => UNWRAP_BASELINE,
    violationLabel: "new production unwrap/expect/panic/assert",
  },
  {
    id: "motion-tokens",
    what: "hardcoded duration / transition-all",
    files: () => TSX_FILES,
    measure: (f) => countAll(stripComments(read(f)), MOTION_VIOLATION),
    baseline: () => MOTION_BASELINE,
    violationLabel: "new hardcoded duration",
  },
  {
    id: "rust-swallowed-errors",
    what: "production let _ = <expr> / #[allow(unused_must_use)]",
    files: () => RUST_FILES,
    // Same lexer options as `rust-unwrap`: strip `#[cfg(test)]` modules (this is a
    // production measure) and comments (a doc line naming the shape is not a site).
    measure: (f) =>
      countAll(stripComments(stripCfgTest(read(f)), { rust: true }), SWALLOWED_ERROR),
    baseline: () => SWALLOWED_ERROR_BASELINE,
    violationLabel: "new swallowed error site",
  },
];

function runRatchet(rule) {
  const grew = [];
  let total = 0;
  const found = {};
  for (const f of rule.files()) {
    const n = rule.measure(f);
    if (n === 0) continue;
    found[f] = n;
    total += n;
    const base = rule.baseline()[f] ?? 0;
    if (n > base) grew.push(`${f}: ${base} → ${n}`);
  }
  return { grew, total, found };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function walk(dir, filter) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (filter(name)) out.push(p.replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

const read = (f) => readFileSync(f, "utf8");
const TS_FILES = walk("src", (n) => /\.(ts|tsx)$/.test(n));
const TSX_FILES = TS_FILES.filter((f) => f.endsWith(".tsx"));
const RUST_FILES = existsSync("src-tauri/src")
  ? walk("src-tauri/src", (n) => n.endsWith(".rs"))
  : [];

function countAll(text, re) {
  let n = 0;
  for (const _m of text.matchAll(re)) n += 1;
  return n;
}

/**
 * Removes comments so the prose-scan rules cannot fire on documentation.
 *
 * This checker exists to catch a real defect class, and it earned that right by
 * being precise — a rule that counts the words "as any" inside a JSDoc paragraph
 * is the same `/^[a-z0-9_]+$/` mistake that made `check-commands.mjs` report a live
 * command as MISSING (see DEVELOPMENT.md §8.3, fixed in 936b1d7). A ratchet people
 * learn to dismiss is worse than no ratchet. String literals are tracked so a URL
 * (`https://…`) is not mistaken for a line comment, and comment contents are
 * replaced by nothing rather than by filler, so line numbers stay usable.
 *
 * Deliberately not a parser: a regex literal containing a quote could confuse it
 * (`.replace(/"/g, …)`), which is acceptable for a heuristic that only ever makes
 * the count go down on real code.
 *
 * `rust: true` matters more than it looks. Rust uses two characters this lexer
 * otherwise treats as string delimiters, and neither is a string:
 *
 *   * a backtick, which only ever appears inside a comment — the Rust docs convention
 *     of writing `` `code` `` inside `///` left an odd number of them per file, the
 *     lexer went looking for a closing backtick, and every `//` comment crossed was
 *     emitted as *code*. `activity.rs` then scored 1 production `.unwrap()` from a
 *     comment explaining why a call site does **not** use one.
 *   * a lifetime tick (`MutexGuard<'static, ()>`, `'_`, `'a`), which opens a string
 *     that closes hundreds of lines later — and a swallowed region hides real code,
 *     which is the unsafe direction for a ratchet.
 *
 * So in Rust mode a backtick is inert and a single quote opens a string only when it
 * really is a char literal (`'a'`, `'
'`, `'\'`, `'''`).
 *
 * Two opt-in options exist for one caller — the `rust-test-floor` row — and both
 * default OFF so every measurement above stays byte-identical to what the three
 * existing ratchets were baselined against:
 *
 *   * `blankStrings: true` keeps only the newlines inside string literals instead
 *     of their text. That row counts test attributes, and a `#[test]` *written
 *     inside* a fixture string or a doc example would inflate the number — and a
 *     FLOOR's unsafe direction is inflation, because an inflated count masks a
 *     deleted test.
 *   * `rawStrings: true` teaches the lexer Rust's raw strings, whose contents are
 *     not C-escaped. Measured defect without it: `netpath.rs:323`
 *     `s.strip_prefix(r"\\?\UNC\")` ends in `\"`, which this lexer reads as an
 *     escaped quote — the mode flips to "string" there and stays (nearly) to
 *     end of file, so the eight `#[test]` at `netpath.rs:394-462` land inside
 *     string territory. String text is KEPT, so the unwrap ratchet never lost a
 *     production line to this (re-measured with `rawStrings` on: `lib.rs` stays
 *     at 1, every other file at 0) — but with `blankStrings` on it would DELETE
 *     those eight from the count (measured 202 vs 210), so the counting row
 *     switches raw-string handling on.
 */
/**
 * True when the tick at `i` really opens a Rust char literal rather than a lifetime.
 * A char literal is `'` + one escaped-or-plain character + `'`; a lifetime is `'` +
 * an identifier and no closing tick.
 */
function isCharLiteral(src, i) {
  const a = src[i + 1];
  if (a === undefined) return false;
  if (a === "\\") return src[i + 2] !== undefined && src[i + 3] === "'";
  if (a === "'") return src[i + 2] === "'"; // the char literal for a quote itself
  return src[i + 2] === "'";
}
/**
 * The hash count of the raw-string prefix whose opening quote sits at `i`
 * (`r"…"`, `r#"…"#`, `br#"…"#`, `cr"…"`), or null when the quote just opens an
 * ordinary string. Look-behind over the token: optional `b`/`c`, then `r`, then
 * the `#`s — and the token must start at a non-identifier boundary, so an
 * identifier that merely ends in `r` before a string can never be mistaken for
 * the prefix.
 */
function rawPrefix(src, i) {
  let hashes = 0;
  let j = i - 1;
  while (j >= 0 && src[j] === "#") {
    hashes += 1;
    j -= 1;
  }
  if (j < 0 || src[j] !== "r") return null;
  if (j > 0 && (src[j - 1] === "b" || src[j - 1] === "c")) {
    if (j - 1 > 0 && /[A-Za-z0-9_]/.test(src[j - 1])) return null; // `…br` is an identifier
  } else if (j > 0 && /[A-Za-z0-9_]/.test(src[j - 1])) {
    return null; // identifier ending in r, not a raw-string token
  }
  return hashes;
}
/**
 * Index of the closing quote of the raw string opened at `q` with `hashes`
 * hashes — the quote must be followed by exactly that many `#`s. Raw strings
 * have no escapes, so an interior `"` is content unless the hashes follow it
 * (that is precisely what a C-style lexer gets wrong). An unterminated one runs
 * to end-of-file: swallowing a tail can only UNDERCOUNT, and for a floor an
 * undercount is a false alarm — never a silent pass.
 */
function rawEnd(src, q, hashes) {
  for (let i = q + 1; i < src.length; i += 1) {
    if (src[i] !== '"') continue;
    let closes = true;
    for (let h = 0; h < hashes; h += 1) {
      if (src[i + 1 + h] !== "#") {
        closes = false;
        break;
      }
    }
    if (closes) return i;
  }
  return src.length - 1;
}
function stripComments(src, { rust = false, blankStrings = false, rawStrings = false } = {}) {
  let out = "";
  let mode = "code";
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        i += 1;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i += 1;
        continue;
      }
      if (rawStrings && c === '"') {
        const hashes = rawPrefix(src, i);
        if (hashes !== null) {
          const end = rawEnd(src, i, hashes);
          if (blankStrings) {
            // Line numbers stay usable: only the newlines survive the blanking.
            for (let t = i; t <= end; t += 1) if (src[t] === "\n") out += "\n";
          } else {
            out += src.slice(i, end + 1);
          }
          i = end;
          continue;
        }
      }
      let opened = false;
      if (c === '"') {
        mode = "dq";
        opened = true;
      } else if (c === "'" && !rust) {
        mode = "sq";
        opened = true;
      } else if (c === "'" && rust && isCharLiteral(src, i)) {
        mode = "sq";
        opened = true;
      } else if (c === "`" && !rust) {
        mode = "tpl";
        opened = true;
      }
      if (!opened || !blankStrings) out += c;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        i += 1;
        continue;
      }
      if (c === "\n") out += c;
      continue;
    }
    // inside a string literal: keep it, honour escapes, close on the quote
    if (c === "\\") {
      if (!blankStrings) out += c + (n ?? "");
      else if (n === "\n") out += "\n";
      i += 1;
      continue;
    }
    if ((mode === "dq" && c === '"') || (mode === "sq" && c === "'") || (mode === "tpl" && c === "`")) {
      mode = "code";
    }
    if (blankStrings) {
      if (c === "\n") out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust: strip #[cfg(test)] modules so the unwrap count is production-only
// ---------------------------------------------------------------------------

/**
 * Removes every `#[cfg(test)]` item from a Rust source string.
 *
 * Line-based with brace tracking, because the attribute and the `mod` it guards
 * are the only shapes actually used here. Comments and string literals can
 * contain braces, so a real parser would be better — but the failure mode of
 * this approximation is counting *more* test code as production, which makes
 * the baseline stricter rather than silently greener. That direction is the
 * safe one, so the shortcut is stated rather than hidden.
 */
function stripCfgTest(text) {
  const lines = text.split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*#\[cfg\(?[^)]*test[^)]*\)?\]\s*$/.test(lines[i])) {
      // Walk forward to the item this guards, then skip its whole brace block.
      let j = i + 1;
      while (j < lines.length && !lines[j].includes("{")) j += 1;
      if (j >= lines.length) {
        i += 1;
        continue;
      }
      let depth = 0;
      for (; j < lines.length; j += 1) {
        depth += countAll(lines[j], /{/g);
        depth -= countAll(lines[j], /}/g);
        if (depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const results = [];

function record(id, status, count, detail, extra) {
  results.push({ id, status, count, detail, ...extra });
}

// (a) + (b) — IPC contract. Delegated to check-commands.mjs on purpose: it owns
// the invoke()/generate_handler! parsing, and duplicating the parser here is how
// two files start disagreeing about what "registered" means. Called as a
// subprocess so `pnpm check` runs exactly one entry point while still reusing
// its verdict, rather than asking the operator to remember both.
function checkIpc() {
  const child = spawnSync(process.execPath, ["scripts/check-commands.mjs"], {
    encoding: "utf8",
    shell: false,
  });
  const out = (child.stdout || "") + (child.stderr || "");

  // If the script itself died for a reason unrelated to the rule, that is NOT a
  // pass. Report it as a failure of this check so nobody reads silence as green.
  if (child.error) {
    record("ipc-contract", "FAIL", 0, `could not run check-commands.mjs: ${child.error.message}`);
    record("ipc-unused", "FAIL", 0, "unavailable — check-commands.mjs did not run, so no reason was recorded for any dead command");
    record("ipc-floor", "FAIL", 0, "unavailable — check-commands.mjs did not run, so coverage was never compared against its floor");
    return;
  }

  const invoked = /invoked from frontend: (\d+)/.exec(out);
  const registered = /registered:\s+(\d+)/.exec(out);
  const missing = /MISSING \(invoked, not registered\): (.+)/.exec(out);
  const deadHard = /UNUSED \(registered, no frontend caller, NOT allowlisted\): (.+)/.exec(out);
  const staleCover = /ALLOWLIST STALE \(needs no cover any more\): (.+)/.exec(out);
  const allowlisted = /registered but not invoked: (.+?) — all allowlisted above with a reason/.exec(out);
  const floors = /floors: invoked (\d+) >= (\d+), registered (\d+) >= (\d+) — (OK|VIOLATED)/.exec(out);

  if (!invoked || !registered) {
    record("ipc-contract", "FAIL", 0, "check-commands.mjs output did not match its documented format");
    return;
  }

  // Cross-check every name it reports as missing before believing it.
  //
  // This used to downgrade a *false* alarm: `check-commands.mjs` collected
  // registrations with `/^[a-z0-9_]+$/`, which silently dropped any written as
  // `module::command`, so `fonts::list_system_fonts` showed up as MISSING while
  // being wired up. That filter was fixed (it now keeps `:` and takes the last
  // path segment the way Tauri exposes it), so a name in `missing` that IS
  // present in `generate_handler!` no longer means "false alarm" — it means the
  // parser regressed. Re-verify it either way and fail loudly on the regression
  // instead of printing the excuse that made the old branch dead.
  const handlerSrc = existsSync("src-tauri/src/lib.rs") ? read("src-tauri/src/lib.rs") : "";
  const handlerBlock = handlerSrc.split("generate_handler![")[1] ?? "";
  // Round 13 (d7-3): every name list below comes from splitting a line that
  // prints a marker when it is empty. "none" (and now "(none)") is that marker,
  // not a command name; filtering it here is the defensive half of the fix -
  // the producer no longer emits the ambiguous form.
  const namesOf = (m) =>
    m
      ? m[1]
          .split(/,\s*/)
          .map((s) => s.trim())
          .filter((s) => s && s !== "none" && s !== "(none)")
      : [];
  const claimedMissing = namesOf(missing);
  const phantom = claimedMissing.filter((n) =>
    handlerBlock
      .split(/[\n,]/)
      .some((line) => line.trim().replace(/,$/, "") === n || line.trim().endsWith(`::${n}`)),
  );
  const realMissing = claimedMissing.filter((n) => !phantom.includes(n));

  const failed =
    realMissing.length > 0 ||
    phantom.length > 0 ||
    // A non-zero exit this run cannot attribute to a rule it parses is still a
    // non-zero exit: the gate must not read as green because the subprocess grew
    // a verdict line this file has never heard of.
    (child.status !== 0 && !(deadHard || staleCover || (floors && floors[5] === "VIOLATED")));
  let detail;
  if (realMissing.length) {
    detail = `invoked names not in generate_handler!: ${realMissing.join(", ")}`;
  } else if (phantom.length) {
    detail =
      `check-commands.mjs reported these as missing but they ARE in generate_handler!: ${phantom.join(", ")}. ` +
      "Its registration filter has regressed to dropping `mod::command` entries — fix check-commands.mjs, do not trust this line.";
  } else if (child.status !== 0) {
    detail = "check-commands.mjs exited non-zero without naming any missing command";
  } else {
    detail = `${invoked[1]} invoked names are all in generate_handler! (${registered[1]} registered)`;
  }
  record("ipc-contract", failed ? "FAIL" : "PASS", Number(invoked[1]), detail);

  // Reverse direction: FAIL, not INFO.
  //
  // This used to be INFO with the reasoning "the headless `--*-check` probes and
  // the mirror plumbing are Rust-side commands no frontend invoke() site has any
  // reason to name". The reasoning was sound for *some* commands and useless as a
  // status: it applied to all of them, so a command nobody could find a caller for
  // was printed in a voice that could never redden a run. `check-commands.mjs` now
  // demands a written reason per command (`RUST_ONLY_COMMANDS`) and this mirrors
  // that verdict — and it also mirrors the anti-rot rule, because an exemption that
  // no longer covers anything is exactly the stale-baseline failure mode the
  // `ratchet-integrity` row below exists to catch.
  const unexplained = namesOf(deadHard);
  const stale = namesOf(staleCover);
  const exempt = namesOf(allowlisted);
  record(
    "ipc-unused",
    unexplained.length || stale.length ? "FAIL" : "PASS",
    unexplained.length + stale.length,
    unexplained.length || stale.length
      ? [
          unexplained.length ? `no reason recorded for: ${unexplained.join(", ")}` : "",
          stale.length ? `allowlist entry needs no cover: ${stale.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" | ")
      : `${exempt.length} command(s) registered without a frontend caller, each with a reason recorded in check-commands.mjs${exempt.length ? `: ${exempt.join(", ")}` : ""}`,
  );

  // Coverage floor, mirrored from check-commands.mjs: the number it compared
  // against is printed on green runs too, so a red run can be read without
  // opening either file.
  record(
    "ipc-floor",
    !floors || floors[5] === "VIOLATED" ? "FAIL" : "PASS",
    floors ? Number(floors[1]) : 0,
    floors
      ? `invoked ${floors[1]} vs floor ${floors[2]}, registered ${floors[3]} vs floor ${floors[4]} — a collapse of either count is the wrapper-refactor / renamed-marker / wrong-directory failure, not a pass`
      : "check-commands.mjs printed no floor line — the coverage assertion is missing, which is itself the failure mode it guards",
  );
}
checkIpc();

// (b2) — the Rust suite's size floor.
//
// The ratchets below fail when a number goes UP (new debt); this row fails when
// a count goes DOWN. Nothing else in `pnpm gate` reads the Rust test suite: the
// only consumer of a `#[test]` function is `cargo test`, whose entry point was
// (at the time this row was added) a CI file this repo has never executed
// (.github/workflows/ci.yml's header) plus DEVELOPMENT.md's dot-source-env.ps1
// instructions — i.e. a manual step no gate runs. So deleting a test was
// silent: same green gate, smaller suite, and the next person to run cargo
// simply sees fewer tests with no idea one was removed on purpose.
//
// `ipc-floor` pins the invoked/registered IPC counts for exactly this reason;
// this is the Rust counterpart, measured the same way — statically, over
// `src-tauri/src`, never by invoking cargo (cargo is single-writer on this
// machine: shared CARGO_TARGET_DIR, docs/worktrees.md / README 验证 — and a
// gate entry that needs a Rust toolchain stops being runnable on a
// frontend-only box).
//
// The measure is comment- AND string-blind (see stripComments's options): a
// doc line or a fixture string that merely *mentions* `#[test]` must not inflate
// the number, because the unsafe direction for a floor is inflation — an
// inflated count masks a deletion instead of catching it.
function checkRustTestFloor() {
  if (!RUST_FILES.length) {
    record("rust-test-floor", "FAIL", 0, "src-tauri/src not found — ran from the wrong directory?");
    return;
  }
  let n = 0;
  for (const f of RUST_FILES) {
    n += countAll(stripComments(read(f), { rust: true, blankStrings: true, rawStrings: true }), RUST_TEST_ATTR);
  }
  record(
    "rust-test-floor",
    n < RUST_TEST_FLOOR ? "FAIL" : "PASS",
    n,
    `${n} #[test]-style test attribute(s) vs floor ${RUST_TEST_FLOOR} — a drop below the floor is deleted tests, not a refactor; ` +
      "static count over src-tauri/src (comments and string literals stripped, no cargo run)",
  );
}
checkRustTestFloor();

// (b2b) — a source comment that names a test file must name one that exists.
//
// `src/lib/worktree-panel.ts` carried "pinned by tests/worktree-panel.test.ts" from
// round 16 until 2026-10-22 while no such file existed. Nothing noticed, because the
// guards that read comments look for scripts/ and docs/ paths, not test citations.
// A comment is a claim; this row makes the claim checkable without running the suite.
//
// Scope is source comments/strings in `src`, `src-tauri/src` and `scripts` — the
// places a future reader takes as evidence. `docs/` references are already covered by
// check-docs.mjs, and `tests/` itself is excluded so a helper in a test does not have
// to cite a real file just to describe a fixture.
const TEST_REF = /\btests\/[A-Za-z0-9._-]+\.test\.ts\b/g;
function checkTestRefs() {
  const files = [
    ...TS_FILES,
    ...RUST_FILES,
    ...walk("scripts", (n) => /\.(mjs|js|ts)$/.test(n)),
  ];
  const refs = new Set();
  const missing = [];
  for (const f of files) {
    for (const m of read(f).matchAll(TEST_REF)) {
      const ref = m[0];
      refs.add(ref);
      if (!existsSync(ref)) missing.push(`${f} → ${ref}`);
    }
  }
  record(
    "test-refs",
    missing.length ? "FAIL" : "PASS",
    refs.size,
    missing.length
      ? `${missing.length} reference(s) name a test file that does not exist: ${missing.join("; ")}`
      : `${refs.size} distinct tests/*.test.ts citation(s) in src/scripts all resolve — a comment that claims a test pins it must be checkable`,
  );
}
checkTestRefs();

// (b3) — the lib.rs ceiling (r20-O3-3).
//
// `rust-test-floor` guards a count that must not go DOWN; this one guards the file
// that grew to 7 971 lines while every round added commands to it. Round 18's report
// recorded "其余命令仍在 lib.rs" as a 遗留风险 and extracted exactly one module (deps.rs,
// 6062783) — after which nothing stopped the next 40 commands from landing in the same
// file, because no gate looked at its size. A ceiling is the cheapest thing that can
// make that a build failure instead of a review comment: extraction is never
// demanded, growth is.
//
// The number is a LINE COUNT, not a command count, because the failure mode is the
// whole file being unreadable, not the registry being large. It is measured with
// `split("\n")` on purpose: a trailing newline counts as one more line than `wc -l`
// reports on some tools, and a ratchet that depends on which counter you used is a
// ratchet that gets "fixed" by reformatting.
function checkLibRsCeiling() {
  const file = "src-tauri/src/lib.rs";
  if (!existsSync(file)) {
    record("lib-rs-ceiling", "FAIL", 0, `${file} no longer exists`);
    return;
  }
  const n = read(file).split("\n").length;
  record(
    "lib-rs-ceiling",
    n > LIB_RS_CEILING ? "FAIL" : "PASS",
    n,
    `${n} lines in ${file} vs ceiling ${LIB_RS_CEILING} — raising the ceiling requires a recorded reason in the commit that does it, and the file must still be smaller than the round started it at`,
  );
}
checkLibRsCeiling();

// (b3b) — the two webview boundaries that are declared in JSON, not code.
//
// `capabilities/default.json` is the only place the page's IPC surface is
// granted, and a capability set drifts silently: nothing fails when a broad
// permission set is added back "to make the dialog work". Round 33 narrowed
// opener from its default set (open-url + reveal-item-in-dir + default urls) to
// open-url alone: the webview never calls reveal, and the reveal the app does
// use is a Rust call the ACL does not gate. The CSP had the opposite problem -
// `connect-src` named api.github.com/github.com from a version of the app whose
// page never made an HTTP request; every GitHub call is a Rust `curl`
// subprocess. Both are asserted here so neither can quietly grow back.
function checkTauriBoundaries() {
  const capFile = "src-tauri/capabilities/default.json";
  const confFile = "src-tauri/tauri.conf.json";
  if (!existsSync(capFile) || !existsSync(confFile)) {
    record("tauri-boundaries", "FAIL", 0, "capabilities or tauri.conf.json is missing");
    return;
  }
  const cap = read(capFile);
  const conf = read(confFile);
  const forbidden = [
    "opener:default",
    "opener:allow-open-path",
    "opener:allow-reveal-item-in-dir",
  ].filter((p) => cap.includes(`"${p}"`));
  const openUrl =
    cap.includes('"opener:allow-open-url"') && cap.includes('"opener:allow-default-urls"');
  const cspMatch = /"csp"\s*:\s*"([^"]*)"/.exec(conf);
  const csp = cspMatch ? cspMatch[1] : "";
  const cspProblems = [];
  if (!cspMatch) cspProblems.push("tauri.conf.json has no CSP");
  if (!csp.includes("connect-src 'self'")) cspProblems.push("connect-src is not 'self'");
  if (/connect-src[^;]*https:\/\//.test(csp)) {
    cspProblems.push("connect-src names a remote origin");
  }
  const problems = [
    ...forbidden.map((p) => `capability still grants ${p}`),
    ...(openUrl ? [] : ["opener:allow-open-url + allow-default-urls are not both granted"]),
    ...cspProblems,
  ];
  record(
    "tauri-boundaries",
    problems.length ? "FAIL" : "PASS",
    problems.length,
    problems.length
      ? problems.join("; ")
      : "opener grants open-url only (no page-side reveal/path opening); CSP connect-src is self-only",
  );
}
checkTauriBoundaries();

// (b4) — every map-shaped in-process cache must bound itself (r20-O2-3).
//
// Round 11's report and round 18's both recorded the same finding in different words:
// a cache that is only ever consulted on read grows for the life of the process.
// `heat.rs` and `search.rs` got this right (CAP + retain on write); the two maps in
// `lib.rs` did not, and nothing in the gate could tell anyone. This row is the
// difference between "we noticed twice" and "it cannot happen silently".
//
// The rule is deliberately mechanical: a file that declares a `HashMap` behind a
// `Mutex` must also contain a capacity constant (`*_CAP: usize`) or an eviction call
// (`.retain(`) — the two shapes the correct modules already use. It is a heuristic over
// text, not an AST, and it is allowed to be: the failure mode it guards is a brand-new
// unbounded map, which always shows up as a fresh `HashMap` declaration in a file that
// has no bound. `Mutex<Option<...>>` single-slot snapshots are not maps and are skipped.
function findUnboundedCaches(source) {
  const lines = source.split("\n");
  const declaresMap = lines.some((l) => /Mutex<\s*HashMap</.test(l) || /OnceLock<\s*Mutex<\s*HashMap</.test(l));
  if (!declaresMap) return [];
  const bounded = /_CAP\s*:\s*usize\s*=/.test(source) || /\.retain\(/.test(source);
  if (bounded) return [];
  const at = lines.findIndex(
    (l) => /Mutex<\s*HashMap</.test(l) || /OnceLock<\s*Mutex<\s*HashMap</.test(l),
  );
  return [`${at + 1}`];
}

function checkRustCacheBounds() {
  if (!RUST_FILES.length) {
    record("rust-cache-bounds", "FAIL", 0, "src-tauri/src not found — ran from the wrong directory?");
    return;
  }
  const offenders = [];
  for (const f of RUST_FILES) {
    const hits = findUnboundedCaches(read(f));
    for (const line of hits) offenders.push(`${f}:${line}`);
  }
  if (offenders.length === 0) {
    record(
      "rust-cache-bounds",
      "PASS",
      0,
      "every file declaring a Mutex<HashMap> also carries a *_CAP constant or a .retain() eviction",
    );
    return;
  }
  record(
    "rust-cache-bounds",
    "FAIL",
    offenders.length,
    `unbounded in-process cache map(s): ${offenders.join(", ")} — add a capacity plus write-time eviction (the shape heat.rs and search.rs already use)`,
  );
}
checkRustCacheBounds();

// (c) — dialog semantics. Enforcing: `PENDING_UNTIL["dialog-a11y"]` was removed
// once the branch it waited on merged and both attributes landed (see that table).
function checkDialogA11y() {
  const file = "src/components/DialogShell.tsx";
  if (!existsSync(file)) {
    record("dialog-a11y", "FAIL", 0, `${file} no longer exists`);
    return;
  }
  const src = read(file);
  // r20-O4 extended the pair to four: the two attributes this row has always
  // demanded, plus the two mechanisms that make the modal actually exclusive —
  // `applyModalInert` (a Tab trap alone leaves what is behind the scrim in the
  // a11y tree and programmatically focusable) and `aria-describedby` (the subtitle
  // is the sentence that says *which* repository the dialog is about).
  const missing = ["role=\"dialog\"", "aria-modal", "applyModalInert", "aria-describedby"].filter(
    (needle) => !src.includes(needle),
  );
  // r20-O4-3: the command palette is the app's second modal layer and had the same
  // gap. Checking both files in one row is the point — a rule that only covers
  // DialogShell is how the palette drifted for fifteen rounds.
  const paletteFile = "src/components/CommandPalette.tsx";
  if (existsSync(paletteFile)) {
    const palette = read(paletteFile);
    for (const needle of ["role=\"dialog\"", "aria-modal", "applyModalInert"]) {
      if (!palette.includes(needle)) missing.push(`CommandPalette:${needle}`);
    }
  }
  if (missing.length === 0) {
    record(
      "dialog-a11y",
      "PASS",
      0,
      "role=dialog, aria-modal, inert wiring and aria-describedby present in DialogShell; inert wiring present in CommandPalette",
    );
    return;
  }
  // No entry in PENDING_UNTIL can rescue a missing attribute any more: a
  // regression here is a FAIL. The path stays generic so re-opening the rule as
  // PENDING is still a one-line edit in one place, and the reason it is not
  // PENDING today is measured above, not asserted below.
  const pending = PENDING_UNTIL["dialog-a11y"];
  record(
    "dialog-a11y",
    pending ? "PENDING" : "FAIL",
    missing.length,
    `missing ${missing.join(" and ")}${pending ? ` — not enforcing until: ${pending}` : ""}`,
  );
}
checkDialogA11y();

// (d)-(f) — the three file-scoped ratchets.
for (const rule of RATCHETS) {
  const { grew, total, found } = runRatchet(rule);
  if (rule.id === "rust-unwrap" && !RUST_FILES.length) {
    record(rule.id, "FAIL", 0, "src-tauri/src not found — ran from the wrong directory?");
    continue;
  }
  record(
    rule.id,
    grew.length ? "FAIL" : "PASS",
    total,
    grew.length
      ? `${rule.violationLabel}: ${grew.join("; ")}${rule.id === "motion-tokens" ? " — every one of these ignores the skin's --motion-scale" : ""}`
      : `all within baseline (${Object.keys(found).length} files)`,
  );
}

// (f2) — motion-token coverage.
//
// The ratchet above answers "did anyone ADD a hardcoded duration". This answers
// the question the ratchet cannot: how much of the app still ignores the user's
// `--motion-scale` skin setting (`src/index.css:305`, overridden to 1.04 / 0.44 /
// 0.72 at `:745` / `:766` / `:788`). INFO while debt exists — the per-file
// baseline is what blocks — and it names the files so the migration has a punch
// list instead of a number. When the last site is tokenised this flips to PASS,
// and `ratchet-integrity` will then refuse to let the baseline keep a key whose
// file measures 0, so the two checks together force the debt list to stay real.
function checkMotionCoverage() {
  const sites = [];
  let hardcoded = 0;
  let tokenised = 0;
  for (const f of TSX_FILES) {
    const src = stripComments(read(f));
    const n = countAll(src, MOTION_VIOLATION);
    tokenised += countAll(src, MOTION_TOKEN_USE);
    if (n) {
      hardcoded += n;
      sites.push(`${f} ${n}`);
    }
  }
  record(
    "motion-token-coverage",
    hardcoded ? "INFO" : "PASS",
    hardcoded,
    hardcoded
      ? `${hardcoded} hardcoded duration(s) in ${sites.length} file(s) still bypass --motion-scale (tokenised uses: ${tokenised}): ${sites.join(", ")}`
      : `no hardcoded duration left; ${tokenised} tokenised use(s)`,
  );
}
checkMotionCoverage();

// (g) — ratchet integrity: a baseline key must still describe live debt.
//
// Why this check exists at all: the three ratchets above only fail when a file
// goes ABOVE its baseline, so a baseline entry whose debt has been paid — or
// whose file has been renamed or deleted — never fires again. It stops being a
// ceiling and silently becomes an allowance. `ESCAPE_HATCH_BASELINE` had rotted
// exactly that way (three keys, every one measuring 0, i.e. four free
// re-introductions), and nothing in the run said so. Now a stale key is a FAIL
// that names the file, the number it now measures, and the one command that
// recomputes the whole set.
function checkRatchetIntegrity() {
  const stale = [];
  for (const rule of RATCHETS) {
    const baseline = rule.baseline();
    const present = new Set(rule.files());
    for (const [file, base] of Object.entries(baseline)) {
      if (!present.has(file)) {
        stale.push(`${rule.id}: baseline names ${file}, which this run does not see (deleted, renamed, or empty)`);
        continue;
      }
      const now = rule.measure(file);
      if (now === 0) {
        stale.push(
          `${rule.id}: baseline says ${file} carries ${base} of ${rule.what}, it now measures 0 — the entry is a free allowance, not a ratchet`,
        );
      }
    }
  }
  record(
    "ratchet-integrity",
    stale.length ? "FAIL" : "PASS",
    stale.length,
    stale.length
      ? `${stale.length} stale baseline entr(ies) — re-baseline with \`node scripts/check-invariants.mjs --baseline\` and lower the constant: ${stale.join(" | ")}`
      : `all ${RATCHETS.reduce((n, r) => n + Object.keys(r.baseline()).length, 0)} baseline entries name a live file with non-zero debt`,
  );
}
checkRatchetIntegrity();

// (h) — suppression comments, and whether anything enforces them.
//
// `eslint-config` only COUNTS `eslint-disable` sites (measured this round: 5 in
// src/, all react-hooks/exhaustive-deps) and states whether a config file exists.
// Counting is all it can do without running ESLint, and an orphan disable (one
// matching no problem) cannot be told from a load-bearing one by counting — that
// distinction is `linterOptions.reportUnusedDisableDirectives`, now set in
// eslint.config.js and enforced because the gate runs eslint through
// scripts/check-lint.mjs.
//
// `eslint-runnable` is the honest companion. It used to be an INFO that only
// appeared when the `eslint` package was ABSENT ("eslint.config.js exists but the
// package is not installed") — a row written for the not-yet-installed state and
// silent once it was installed, i.e. it went from "honest caveat" to "no signal at
// all". It now always records the two facts a reader actually needs: is eslint
// installed, and is it ENFORCED by the gate. Installed-but-not-enforced is a FAIL,
// because a linter the gate ignores is the decorative-green case this row exists to
// refuse. Enforcement is read from package.json (does the `check` / `gate` script
// run scripts/check-lint.mjs), not asserted here, so re-wiring lint updates this
// row by itself.
function checkEslintConfigured() {
  const configs = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"];
  const present = configs.filter((c) => existsSync(c));
  const installed = existsSync(join("node_modules", "eslint", "bin", "eslint.js"));
  const sites = [];
  for (const f of TS_FILES) {
    const src = read(f);
    const n = countAll(src, /eslint-disable/g);
    if (n) sites.push(`${f} (${n})`);
  }
  if (!present.length && sites.length) {
    record(
      "eslint-config",
      "FAIL",
      sites.length,
      `${sites.reduce((s, x) => s + Number(x.match(/\((\d+)\)/)[1]), 0)} eslint-disable comment(s) with no ESLint config to enforce them: ${sites.join(", ")}`,
    );
    return;
  }
  record(
    "eslint-config",
    "PASS",
    sites.length,
    present.length
      ? `config present (${present.join(", ")}); ${sites.length} file(s) carry suppressions`
      : "no suppressions and no config — nothing to enforce",
  );

  // Read the gate wiring straight from package.json so this row cannot drift from
  // the scripts the repo actually runs.
  let gateRunsLint = false;
  let enforcedBy = "";
  try {
    const pkg = JSON.parse(read("package.json"));
    const s = pkg.scripts ?? {};
    const check = String(s.check || "");
    const gate = String(s.gate || "");
    // check-lint is the ratchet; it is wired in when `check` (which `gate` calls)
    // runs it, or when `gate` names it directly.
    if (/check-lint\.mjs/.test(check)) {
      gateRunsLint = true;
      enforcedBy = "pnpm check → scripts/check-lint.mjs";
    } else if (/check-lint\.mjs/.test(gate)) {
      gateRunsLint = true;
      enforcedBy = "pnpm gate → scripts/check-lint.mjs";
    } else if (/\beslint\b/.test(gate) || /\beslint\b/.test(check)) {
      gateRunsLint = true;
      enforcedBy = "pnpm gate/check runs eslint directly";
    }
  } catch {
    // A package.json we cannot read is itself a reason the enforcement claim is
    // unverifiable — leave gateRunsLint false and let the row say so.
  }

  if (installed && gateRunsLint && present.length) {
    record(
      "eslint-runnable",
      "PASS",
      sites.length,
      `eslint installed (bin present) and enforced by the gate (${enforcedBy}, a per-file ratchet); ` +
        "`pnpm lint` is the raw full-debt view — a NEW problem past its file baseline, or an orphan eslint-disable, fails the gate",
    );
  } else if (installed && !gateRunsLint && present.length) {
    record(
      "eslint-runnable",
      "FAIL",
      sites.length,
      "eslint is installed but NOT run by `pnpm check`/`gate` — a lint regression sails through green. Wire it in (scripts/check-lint.mjs is the ratchet that adds it without blocking on pre-existing debt).",
    );
  } else if (!installed && present.length) {
    record(
      "eslint-runnable",
      gateRunsLint ? "FAIL" : "INFO",
      sites.length,
      gateRunsLint
        ? "the gate claims to run eslint but the `eslint` package is missing (node_modules/eslint/bin/eslint.js not found) — the ratchet subprocess will fail the run. Install in the ROOT checkout, never a linked worktree (shared node_modules junction)."
        : `eslint.config.js exists but the \`eslint\` package is not installed, so \`pnpm lint\` cannot run and these ${sites.reduce((s, x) => s + Number(x.match(/\((\d+)\)/)[1]), 0)} suppressions are unenforced: ${sites.join(", ")}. Install in the ROOT checkout — never a linked worktree (shared node_modules junction).`,
    );
  } else {
    record("eslint-runnable", "INFO", 0, "no eslint config present — nothing installed or enforced, and nothing to enforce");
  }
}
checkEslintConfigured();

// ---------------------------------------------------------------------------
// (i) — is the git hook that is supposed to guard this tree actually reachable?
// ---------------------------------------------------------------------------
// docs/worktrees.md presents `.githooks/pre-commit` (refuse to stage anything
// under `.worktrees/` or `.wt/`) as the thing that stops a cross-stream staged
// file from breaking a merge — the failure it prevents is "Merge with strategy
// ort failed" discovered only when the merge dies. The hook file is committed,
// but a committed hook enforces nothing until `core.hooksPath` points at it, and
// on this machine that setting has never been applied: measured, the active hooks
// directory is the main checkout's `.git/hooks` and it holds nothing but
// `*.sample`. So the guard docs describe as a wall has run exactly zero times.
//
// Detection is read-only by design. `git config` is off-limits for this round's
// agents (setting it here would change a machine-local config that belongs to
// whoever owns the box), and reading the config files by hand would get the
// global/XDG/system precedence wrong anyway. `git rev-parse --git-path hooks` asks
// git the only question that matters — "where will you look for hooks" — and it
// honours core.hooksPath (verified in a scratch repo) while also resolving the
// shared `commondir` correctly for a linked worktree, which manual parsing would
// get wrong. The row then prints the command, it does not run it.
//
// INFO when the hook is not reachable, never FAIL: whether a machine-local git
// setting is applied is not a property of this branch, and a row that failed
// every gate until someone acted on it would just teach everyone to ignore the
// table (the same reasoning `eslint-runnable` carries). PASS when it IS applied.
const HOOKS_DIR_OVERRIDE = (() => {
  const i = process.argv.indexOf("--hooks-dir");
  return i > -1 ? process.argv[i + 1] : null;
})();

/**
 * The state of the active hooks directory, as one of four verdicts.
 *
 * `installed` = the ACTIVE directory really holds the committed guard (on this
 * repo, `.githooks/pre-commit` reached through `core.hooksPath`). `bypassed` is
 * the subtler failure and the reason this row can tell them apart: a `pre-commit`
 * IS reachable, but its bytes are not the committed guard's, so git runs some
 * other hook and the wall in docs/worktrees.md is silently off. The earlier
 * detector called any file named `pre-commit` a PASS, which made "reachable" and
 * "the guarding hook is what is reachable" the same sentence; they are not.
 */
function detectHooksState(hooksDir) {
  if (!hooksDir) return { kind: "unknown", detail: "git could not resolve a hooks directory" };
  let names = [];
  try {
    names = readdirSync(hooksDir);
  } catch (e) {
    return { kind: "unknown", detail: `hooks directory \`${hooksDir}\` is not readable (${e.code || e.message})` };
  }
  const real = names.filter((n) => n === "pre-commit");
  const samples = names.filter((n) => n.endsWith(".sample"));
  if (!real.length) {
    return {
      kind: "absent",
      hooksDir,
      real,
      samples,
      detail:
        `\`${hooksDir}\` holds ${samples.length} *.sample file(s) and no \`pre-commit\` — ` +
        "git has no hook to run, so the committed guard has never executed",
    };
  }
  // A `pre-commit` exists; it is the guard only if it is byte-for-byte the file
  // this repo commits. Anything else is a hook the repo does not own.
  let sameAsGuard = false;
  try {
    sameAsGuard =
      existsSync(".githooks/pre-commit") &&
      readFileSync(join(hooksDir, "pre-commit"), "utf8") === readFileSync(".githooks/pre-commit", "utf8");
  } catch {
    sameAsGuard = false;
  }
  if (sameAsGuard) {
    return { kind: "installed", hooksDir, real, samples, detail: `\`pre-commit\` present in \`${hooksDir}\`` };
  }
  return {
    kind: "bypassed",
    hooksDir,
    real,
    samples,
    detail:
      `\`${hooksDir}\` holds a \`pre-commit\`, but its content is not the committed \`.githooks/pre-commit\` — ` +
      "git would run a hook this repo does not own, so the worktree guard is silently off",
  };
}

function checkHooksPath() {
  const repoHasHook = existsSync(".githooks/pre-commit");
  let hooksDir = HOOKS_DIR_OVERRIDE;
  if (!hooksDir) {
    const child = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8", shell: false });
    const raw = (child.stdout || "").trim();
    if (child.error || child.status !== 0 || !raw) {
      record(
        "hooks-path",
        "INFO",
        0,
        "cannot resolve the active hooks directory (`git rev-parse --git-path hooks` failed — no git on PATH, or not a repo), " +
          `so the ${repoHasHook ? ".githooks/pre-commit guard is committed but its reachability is unknown" : "repo ships no .githooks/pre-commit at all"}`,
      );
      return;
    }
    hooksDir = raw; // git prints it relative to the cwd this script already anchored to ROOT
  }
  const st = detectHooksState(hooksDir);

  // Every non-unknown verdict prints the install command, because `core.hooksPath`
  // is repo-local config that git does NOT distribute: it is applied in THIS
  // checkout only, so any fresh clone has to re-run it by hand even while this
  // row here reads PASS. A green row that hid that would be the exact
  // "known-but-not-enforced" trap this round exists to close.
  const enableHint = "(repo-local setting, not distributed by git — a fresh clone must re-run:  git config core.hooksPath .githooks)";

  if (st.kind === "installed") {
    record("hooks-path", "PASS", 1, `worktree guard is reachable: ${st.detail}  ${enableHint}`);
    return;
  }
  if (st.kind === "unknown") {
    record("hooks-path", "INFO", 0, `hooks reachability unknown: ${st.detail}`);
    return;
  }
  if (st.kind === "bypassed") {
    record("hooks-path", "INFO", 0, `${st.detail}. Point git at the committed guard:  git config core.hooksPath .githooks`);
    return;
  }
  record(
    "hooks-path",
    "INFO",
    0,
    (repoHasHook
      ? "`.githooks/pre-commit` is committed but NOT reachable, so the worktree guard in docs/worktrees.md has never run. " +
        "Enable it in this checkout (repo-local, never global) with:  git config core.hooksPath .githooks"
      : "`.githooks/pre-commit` is missing from the tree AND the active hooks directory has no pre-commit — " +
        "restore the hook first, then:  git config core.hooksPath .githooks") +
      `  (${st.detail})`,
  );
}
checkHooksPath();

// ---------------------------------------------------------------------------
// (j) — is the license gate actually inside the chain, and is it still runnable?
// ---------------------------------------------------------------------------
// Same shape as `eslint-runnable` above, for the same reason: a checker that exists
// on disk but is not wired into `pnpm check` is decoration, and the row reads the
// wiring out of package.json instead of asserting it, so re-wiring updates this row
// by itself (round-16 r3-1/r3-4 wired `scripts/license-report.mjs --check` in as the
// sixth script in `check`).
//
// It also refuses the opposite failure, which is the one a green table hides best:
// the file present and wired but its classifier quietly broken. `license-report
// --selftest` is run here as the probe — it needs no pnpm spawn and no network, so
// the row stays cheap and cannot inherit `pnpm licenses`' cold-cache cost (measured
// 1.7 s warm, 17.4 s on a cold filesystem cache; check-invariants runs three times
// under tests/checkers.test.ts, each with a 30 s kill timeout, and embedding a
// 17-second subprocess here is how a gate becomes a flake).
//
// The INVENTORY verdict itself is not re-derivable here on purpose, and does not
// need to be: the `check` chain runs `license-report.mjs --check` as its own next
// step, so an off-list license reddens the chain where it is printed in full. This
// row's job is the meta-question the chain cannot ask itself — "is that step still
// wired, present, and intact" — and `eslint-runnable` above is the precedent for
// answering exactly that question by reading package.json rather than re-running
// the tool.
//
// FAIL when wired-but-missing, wired-but-broken, or the classifier selftest fails.
// INFO only for the state this branch cannot resolve: no node_modules (a fresh clone
// before install), which is a machine state, not a property of the commit.
function checkSupplyChainLicenseGate() {
  const script = "scripts/license-report.mjs";
  const scriptPresent = existsSync(script);
  let pkgScripts = null;
  try {
    pkgScripts = JSON.parse(read("package.json")).scripts ?? {};
  } catch {
    record("license-gate", "FAIL", 0, "package.json cannot be parsed, so the license gate's wiring into `check` is unverifiable");
    return;
  }
  // `verify` counts as wired. Round 16 moved this gate out of `check` on 2026-10-16
  // (measured: the `pnpm licenses list --json` underneath it is 1.7 s warm, 17.4 s cold,
  // and >180 s while a concurrent build line held the disk — three false failures inside
  // one hour, in a chain a session runs dozens of times). Its homes are now `pnpm verify`
  // (the deliberate pre-release path) and an explicit CI step, so what this row enforces
  // is "the gate exists and is reachable from a real chain", not "it is on the per-merge
  // path". Reading only check/gate would have failed the very move it was meant to allow,
  // which is how a guard becomes a reason to delete the guard.
  const checkChain = `${pkgScripts.check || ""} ${pkgScripts.gate || ""}`;
  const chain = `${checkChain} ${pkgScripts.verify || ""}`;
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wired = new RegExp(escaped).test(chain);
  const onMergePath = new RegExp(escaped).test(checkChain);
  const asksTheGate = wired && /--check\b/.test(chain);

  if (!scriptPresent) {
    record(
      "license-gate",
      wired ? "FAIL" : "INFO",
      0,
      wired
        ? `\`check\`/\`gate\` names ${script} but the file is gone — the chain will die on it. Restore the script or remove the wiring; do not leave the two disagreeing.`
        : `${script} is absent and not wired in — dependency licenses are not being checked at all`,
    );
    return;
  }
  if (!wired) {
    record(
      "license-gate",
      "FAIL",
      0,
      `${script} exists but is NOT run by \`pnpm check\`/\`gate\`/\`verify\`, so a copyleft dependency merges green. Wire it in — round-16 r3-4 had it at the end of the \`check\` chain and the same round moved it to \`verify\` plus an explicit CI step once its subprocess cost was measured; either home is acceptable while neither is empty.`,
    );
    return;
  }

  const child = spawnSync(process.execPath, [script, "--selftest"], { encoding: "utf8", cwd: ".", shell: false, timeout: 60_000 });
  if (child.error || child.status === null) {
    record(
      "license-gate",
      "FAIL",
      0,
      `wired into the chain but it did not run (${child.error ? child.error.code ?? child.error.message : "killed — no exit code"}); a gate that cannot execute has no verdict`,
    );
    return;
  }
  if (child.status !== 0) {
    record(
      "license-gate",
      "FAIL",
      0,
      `${script} --selftest exited ${child.status} — the allowlist classifier itself is broken (${String(child.stdout || child.stderr || "").trim().split(/\r?\n/).slice(-1)[0] || "no output"}). Every license verdict from this gate is now untrustworthy.`,
    );
    return;
  }
  const scenarios = Number(/OK: (\d+) license classifier scenarios/.exec(child.stdout || "")?.[1] ?? 0);
  if (scenarios === 0) {
    record(
      "license-gate",
      "FAIL",
      0,
      `${script} --selftest exited 0 but printed no scenario count — a probe that reports success without saying what it checked is the silent-pass shape this repo refuses`,
    );
    return;
  }
  const allowlistSize = (read(script).match(/^\s{2}"[A-Za-z0-9][^"\n]*",/gm) || []).length;
  record(
    "license-gate",
    "PASS",
    scenarios,
    `${script} wired into ${onMergePath ? "pnpm check/gate (the per-merge path)" : "pnpm verify only (pre-release path + an explicit CI step; moved out of the check chain on 2026-10-16 because its subprocess was measured too slow for a chain a session runs dozens of times)"}${asksTheGate ? " with --check (its exit code gates that chain)" : " WITHOUT --check (it reports; its exit code is not what gates)"}` +
      `; classifier intact (${scenarios} synthetic allow/deny scenarios, ~${allowlistSize} allowlist entries in source). ` +
      "The inventory over the installed tree is produced by that next chain step (`pnpm license:report`), source: `pnpm licenses list --json`, offline.",
  );
}
checkSupplyChainLicenseGate();

// ---------------------------------------------------------------------------
// (j2) — the SBOM generator: script, wiring and the vendored spec it reads.
// ---------------------------------------------------------------------------
// Round 18 (R2). `scripts/sbom.mjs` enforces its own shape by reading the *vendored*
// CycloneDX 1.6 schema at run time rather than hardcoding constraints, so the failure this
// row guards against is the silent one: the script, the wiring or the vendored spec drifting
// apart until `pnpm verify` "generates a BOM" from a generator that no longer exists, or from
// a schema whose version the generator no longer matches. Nothing here re-runs the generator
// (that is `verify`'s job and `tests/sbom.test.ts`'s job); this row costs three stat calls and
// two JSON parses.
function checkSbomGenerator() {
  const script = "scripts/sbom.mjs";
  const schemaFile = join("vendor", "cyclonedx", "bom-1.6.schema.json");
  const spdxFile = join("vendor", "cyclonedx", "spdx.schema.json");
  let pkgScripts = null;
  try {
    pkgScripts = JSON.parse(read("package.json")).scripts ?? {};
  } catch {
    record("sbom-gate", "FAIL", 0, "package.json cannot be parsed, so the SBOM step's wiring is unverifiable");
    return;
  }
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wired = new RegExp(escaped).test(pkgScripts.verify || "");
  if (!existsSync(script)) {
    record(
      "sbom-gate",
      wired ? "FAIL" : "INFO",
      0,
      wired
        ? `\`verify\` names ${script} but the file is gone — restore the generator or remove the wiring, do not leave the two disagreeing.`
        : `${script} is absent and not wired in — the project publishes no bill of materials`,
    );
    return;
  }
  if (!wired) {
    record("sbom-gate", "FAIL", 0, `${script} exists but no \`verify\` step runs it — nothing produces a BOM before a release`);
    return;
  }
  const scriptSrc = read(script);
  const declared = /export const SPEC_VERSION = "([^"]+)"/.exec(scriptSrc)?.[1] ?? null;
  const schema = existsSync(schemaFile) ? JSON.parse(read(schemaFile)) : null;
  const spdx = existsSync(spdxFile) ? JSON.parse(read(spdxFile)) : null;
  const problems = [];
  if (!schema) problems.push(`${schemaFile} is missing — the generator reads every constraint it enforces from that file, so without it it can only exit 2 ("cannot determine")`);
  if (!spdx) problems.push(`${spdxFile} is missing — an unrecognised license token must fall back to \`expression\`, which needs the vendored SPDX id list to decide`);
  if (!declared) problems.push(`${script} no longer declares \`export const SPEC_VERSION\`, so the version it emits cannot be compared to the vendored schema`);
  if (schema && declared) {
    const schemaVersion = /\/schema\/bom-([0-9.]+)\.schema\.json$/.exec(schema.$id ?? "")?.[1] ?? null;
    if (!schemaVersion) problems.push(`${schemaFile} has an unexpected $id (${schema.$id}) — its version cannot be derived`);
    else if (schemaVersion !== declared) problems.push(`generator emits specVersion ${declared} while the vendored schema is ${schemaVersion} — they drifted`);
  }
  const spdxIds = spdx?.enum?.length ?? spdx?.items?.enum?.length ?? 0;
  if (spdx && spdxIds === 0) problems.push(`${spdxFile} parses but carries no license id enumeration`);
  if (problems.length) {
    record("sbom-gate", "FAIL", problems.length, problems.join("; "));
    return;
  }
  record(
    "sbom-gate",
    "PASS",
    spdxIds,
    `${script} emits CycloneDX ${declared} and is wired into \`pnpm verify\` with --check; constraints are read at run time from ${schemaFile} (its \`$id\` is ${schema.$id}) and license ids are validated against ${spdxIds} entries in ${spdxFile}. ` +
      "No component inventory is produced here — that is what verify's step and tests/sbom.test.ts do.",
  );
}
checkSbomGenerator();

// ---------------------------------------------------------------------------
// (k) — Tauri 2 security posture: the CSP / connect-src / asset-protocol ratchet.
// ---------------------------------------------------------------------------
// Added round 17 (r2), out of the official-docs study recorded in
// docs/security-posture.md. What this row refuses is the three ways the posture
// actually gets weakened without anyone editing a rule:
//
//   1. `'unsafe-eval'` (or `'unsafe-inline'` in `script-src`) creeping into
//      `app.security.csp`. Tauri's CSP page says the policy "can be used to
//      reduce or prevent impact of common web based vulnerabilities like
//      cross-site-scripting (XSS)" and that a developer "should make it as
//      restricted as possible" (https://v2.tauri.app/security/csp/, fetched
//      2026-10-17). Those tokens are exactly what removes that mitigation, so
//      they are pinned by token.
//   2. `connect-src` becoming `*`, or quietly growing an unreviewed host. The
//      allow-list below is the MEASURED `src-tauri/tauri.conf.json` value on
//      2026-10-17; anything outside it fails the run and asks for a constant
//      edit — which is the review gate, not a formality.
//   3. `assetProtocol.scope` widening from "the cached cover images" to the repo
//      root or the whole filesystem. Tauri documents `**/*` and `$HOME/**` as
//      its "Highly permissive configuration (use with extreme care)" and advises
//      preferring "narrow directories" (https://v2.tauri.app/security/asset-protocol/,
//      fetched 2026-10-17).
//
// `style-src 'unsafe-inline'` is deliberately NOT a violation: the measured CSP
// keeps it only there, so the rule forbids `unsafe-inline` in `script-src`
// alone. Dependency-free like every other row here — it reads one JSON file and
// does no network or cargo work.

/**
 * The security posture, as measured on this tree on 2026-10-17.
 *
 * Not style preferences: each entry is the current `src-tauri/tauri.conf.json`
 * value, and the check fails when the config grows BEYOND it. Relaxing any list
 * is a deliberate act — edit the constant in the same commit as the config, and
 * say in the commit message which review approved the wider value.
 */
const SECURITY_BASELINE = {
  /**
   * `connect-src` tokens. Never `*`; every host must be named here.
   *
   * r33-D3 narrowed this from `['self', api.github.com, github.com]`: every GitHub
   * request is a Rust `curl` subprocess, so the page never needed either origin.
   * The `tauri-boundaries` row fails if a remote origin comes back; this list is
   * the second lock on the same door.
   */
  connectSrc: ["'self'"],
  /**
   * `assetProtocol.scope`, exactly the four cached-cover globs. Any other entry
   * — and any repo-root / global shape — is a widening.
   */
  assetScope: [
    "**/cache/covers/*.png",
    "**/cache/covers/*.jpg",
    "**/cache/covers/*.webp",
    "**/cache/covers/*.gif",
  ],
  /** Tokens that must never appear anywhere in the CSP. */
  forbiddenAnywhere: ["unsafe-eval"],
  /** Tokens that must not appear in `script-src` specifically (unsafe-eval is covered above). */
  forbiddenInScriptSrc: ["unsafe-inline"],
};

/** One token as a policy value compares: `'self'` and `self` are the same source. */
const cspToken = (t) => t.replace(/^'+|'+$/g, "").toLowerCase();

/** `"a 'b'; c 'd'"` → `{ directives: { a: ["'b'"], c: ["'d'"] }, all: ["'b'", "'d'"] }`. */
function parseCsp(csp) {
  const directives = {};
  const all = [];
  for (const part of String(csp).split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    const values = tokens.slice(1);
    directives[name] = (directives[name] || []).concat(values);
    all.push(...values);
  }
  return { directives, all };
}

/**
 * A scope pattern that exposes the repo root or the whole filesystem. The
 * baseline equality check below already rejects these; naming the shape is what
 * makes the message actionable (Tauri's own docs call it the "highly permissive"
 * configuration).
 */
function isGlobalScopePattern(p) {
  const s = String(p).trim();
  if (["*", "**", "**/*", "*/**", "**/**", "/", "/**", "/**/*"].includes(s)) return true;
  if (/^\$HOME(\/\*\*(\/\*)?)?$/.test(s)) return true; // `$HOME` / `$HOME/**` / `$HOME/**/*`
  if (/^\$[A-Z_]+$/.test(s)) return true; // a bare base directory (e.g. `$APPCACHE`)
  if (/^[A-Za-z]:[\\/]?\*{0,3}$/.test(s)) return true; // `C:` / `C:/` / `C:/*`
  return false;
}

/**
 * The verdict for a parsed `tauri.conf.json`, as `{ violations, facts }`.
 *
 * Pure over its argument, which is what lets `--selftest` pin every branch
 * against synthetic configs (no repo state, no network, no cargo).
 */
function auditTauriSecurity(conf) {
  const violations = [];
  const sec = (conf && conf.app && conf.app.security) || {};
  const csp = sec.csp;
  const facts = { cspPresent: false, connectSrc: null, scriptSrc: null, assetEnabled: false, assetScope: [] };

  if (typeof csp !== "string" || !csp.trim()) {
    violations.push(
      "no CSP is configured (`app.security.csp` is missing or empty) — Tauri only enables CSP protection when it is set",
    );
  } else {
    facts.cspPresent = true;
    const { directives, all } = parseCsp(csp);
    for (const bad of SECURITY_BASELINE.forbiddenAnywhere) {
      if (all.some((t) => cspToken(t) === bad)) {
        violations.push(`the CSP contains '${bad}' — that removes the XSS mitigation Tauri's CSP exists for`);
      }
    }
    const scriptSrc = directives["script-src"] || [];
    facts.scriptSrc = scriptSrc;
    for (const bad of SECURITY_BASELINE.forbiddenInScriptSrc) {
      if (scriptSrc.some((t) => cspToken(t) === bad)) {
        violations.push(`script-src contains '${bad}' — executable script sources must not be widened this way`);
      }
    }
    const connect = directives["connect-src"];
    if (!connect) {
      violations.push(
        "connect-src is not declared — an explicit allow-list is the policy this repo pins (default-src 'self' would silently take over)",
      );
    } else {
      facts.connectSrc = connect;
      for (const t of connect) {
        if (cspToken(t) === "*") {
          violations.push("connect-src is `*` — any host may be contacted; it must be an explicit allow-list");
          continue;
        }
        if (!SECURITY_BASELINE.connectSrc.some((b) => cspToken(b) === cspToken(t))) {
          violations.push(
            `connect-src allows \`${t}\`, which is outside the baseline [${SECURITY_BASELINE.connectSrc.join(" ")}] — ` +
              "widening a whitelist must change SECURITY_BASELINE and pass a review",
          );
        }
      }
    }
  }

  const ap = sec.assetProtocol || {};
  facts.assetEnabled = ap.enable === true;
  if (facts.assetEnabled) {
    const scope = ap.scope;
    const allows = Array.isArray(scope)
      ? scope
      : scope && typeof scope === "object" && Array.isArray(scope.allow)
        ? scope.allow
        : null;
    if (!allows || !allows.length) {
      violations.push("assetProtocol is enabled but its scope grants no path — the protocol is on with nothing to serve");
    } else {
      facts.assetScope = allows;
      for (const p of allows) {
        if (SECURITY_BASELINE.assetScope.includes(p)) continue;
        if (isGlobalScopePattern(p)) {
          violations.push(
            `assetProtocol.scope \`${p}\` widens the protocol to the repo root / the whole filesystem — only the cached-cover globs belong in the baseline`,
          );
        } else {
          violations.push(
            `assetProtocol.scope \`${p}\` is not in the baseline [${SECURITY_BASELINE.assetScope.join(", ")}] — a new exposed path needs a review and a constant change`,
          );
        }
      }
    }
  }
  return { violations, facts };
}

function checkTauriSecurity() {
  const file = "src-tauri/tauri.conf.json";
  if (!existsSync(file)) {
    record("tauri-security", "FAIL", 0, `${file} not found — the CSP / asset-protocol posture cannot be read`);
    return;
  }
  let conf;
  try {
    conf = JSON.parse(read(file));
  } catch (e) {
    record("tauri-security", "FAIL", 0, `${file} is not valid JSON (${e.message}) — the posture is unverifiable`);
    return;
  }
  const { violations } = auditTauriSecurity(conf);
  record(
    "tauri-security",
    violations.length ? "FAIL" : "PASS",
    violations.length,
    violations.length
      ? `security posture relaxed: ${violations.join(" | ")}`
      : "CSP has no 'unsafe-eval' and script-src no 'unsafe-inline' (style-src keeps it, by measured need); " +
        `connect-src is the explicit allow-list [${SECURITY_BASELINE.connectSrc.join(" ")}] and never \`*\`; ` +
        `assetProtocol.scope is the ${SECURITY_BASELINE.assetScope.length} cached-cover globs [${SECURITY_BASELINE.assetScope.join(", ")}] and nothing broader. ` +
        "Widening any list requires editing SECURITY_BASELINE in scripts/check-invariants.mjs AND a review — the constant is the review checkpoint.",
  );
}
checkTauriSecurity();

/**
 * `--selftest` — the classifier, pinned without repo state.
 *
 * The live config is compliant today, so asserting "the run is PASS" would only
 * prove the tree has not moved. What must not regress is the AUDIT: whether an
 * `unsafe-eval`, a `*` connect-src, an added host or a widened scope pattern is
 * caught — and, just as important, that a legitimate `style-src 'unsafe-inline'`
 * is NOT. Those branches live here, over synthetic configs.
 */
function runSecuritySelftest() {
  const coverScope = [...SECURITY_BASELINE.assetScope];
  const mk = (over) => {
    const base = {
      app: {
        security: {
          csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset:; connect-src 'self'",
          assetProtocol: { enable: true, scope: coverScope },
        },
      },
    };
    return over ? over(base) : base;
  };

  const cases = [
    { name: "the committed posture → 0 violations", conf: mk(), want: 0 },
    {
      name: "`unsafe-eval` in script-src → violation",
      conf: mk((c) => ((c.app.security.csp = c.app.security.csp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")), c)),
      want: 1,
      expect: "unsafe-eval",
    },
    {
      name: "`unsafe-inline` in script-src → violation",
      conf: mk((c) => ((c.app.security.csp = c.app.security.csp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), c)),
      want: 1,
      expect: "script-src contains 'unsafe-inline'",
    },
    { name: "`style-src 'unsafe-inline'` alone is NOT a violation", conf: mk(), want: 0 },
    {
      name: "connect-src `*` → violation",
      conf: mk((c) => ((c.app.security.csp = "default-src 'self'; script-src 'self'; connect-src *"), c)),
      want: 1,
      expect: "is `*`",
    },
    {
      name: "connect-src growing an unreviewed host → violation naming the baseline",
      conf: mk((c) => ((c.app.security.csp += " https://evil.example"), c)),
      want: 1,
      expect: "outside the baseline",
    },
    {
      name: "assetProtocol.scope `**/*` → repo-root/global violation",
      conf: mk((c) => ((c.app.security.assetProtocol.scope = ["**/*"]), c)),
      want: 1,
      expect: "repo root",
    },
    {
      name: "assetProtocol.scope `$HOME/**` → repo-root/global violation",
      conf: mk((c) => ((c.app.security.assetProtocol.scope = ["$HOME/**"]), c)),
      want: 1,
      expect: "repo root",
    },
    {
      name: "a new, non-global scope entry → violation demanding a review",
      conf: mk((c) => ((c.app.security.assetProtocol.scope = [...coverScope, "$APPCACHE/**/*"]), c)),
      want: 1,
      expect: "not in the baseline",
    },
    {
      name: "assetProtocol disabled → any scope is vacuous, not a widening",
      conf: mk((c) => ((c.app.security.assetProtocol = { enable: false, scope: ["**/*"] }), c)),
      want: 0,
    },
    {
      name: "no CSP string → violation (Tauri enables CSP protection only when set)",
      conf: mk((c) => (delete c.app.security.csp, c)),
      want: 1,
      expect: "no CSP is configured",
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const { violations } = auditTauriSecurity(c.conf);
    const problems = [];
    if (violations.length !== c.want) {
      problems.push(`expected ${c.want} violation(s), got ${violations.length}: ${JSON.stringify(violations)}`);
    }
    if (c.expect && !violations.join(" | ").includes(c.expect)) {
      problems.push(`no violation mentions "${c.expect}" (got: ${violations.join(" | ") || "none"})`);
    }
    if (problems.length) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${problems.join("; ")}`);
    } else {
      console.log(`  ok    ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} security self-test scenario(s) broken`
      : `\nOK: ${cases.length} security self-test scenarios`,
  );
  return failed;
}

/**
 * `--selftest` for the `rust-swallowed-errors` classifier.
 *
 * The live tree is already pinned by its baseline, so asserting "the run is PASS"
 * would only prove the tree has not moved. What must not regress is the
 * CLASSIFIER — which shapes count as a discarded value, and, just as important,
 * that the ordinary bindings do NOT. Those branches live here, over synthetic
 * text, with no repo state and no cargo.
 */
function runSwallowSelftest() {
  const cases = [
    { name: "`let _ = foo();` counts", line: "let _ = foo();", want: 1 },
    {
      name: "a typed discard `let _: Result<(), E> = foo();` counts",
      line: "let _: Result<(), E> = foo();",
      want: 1,
    },
    {
      name: "the lint silencing `#[allow(unused_must_use)]` counts",
      line: "#[allow(unused_must_use)]",
      want: 1,
    },
    // The look-alikes that must NOT count — these are the false positives that
    // would make the row noise.
    { name: "a bound `let x = foo();` does not count", line: "let x = foo();", want: 0 },
    {
      name: "a named `let _detect_guard = m.lock().ok();` does not count",
      line: "let _detect_guard = m.lock().ok();",
      want: 0,
    },
    {
      name: "a benign `.ok()` conversion ending a `let` does not count",
      line: 'let install: Option<String> = sub.get_value("InstallLocation").ok();',
      want: 0,
    },
    {
      name: "`?`-propagation `.ok()?` does not count",
      line: "let r = parse(&s).ok()?;",
      want: 0,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = countAll(c.line, SWALLOWED_ERROR);
    if (got !== c.want) {
      failed++;
      console.log(`  FAIL  ${c.name}\n        expected ${c.want} match(es), got ${got}`);
    } else {
      console.log(`  ok    ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} swallowed-error self-test scenario(s) broken`
      : `\nOK: ${cases.length} swallowed-error self-test scenarios`,
  );
  return failed;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const asJson = process.argv.includes("--json");
const asBaseline = process.argv.includes("--baseline");

// `--selftest` short-circuits everything else: it is a synthetic probe, not a
// verdict about this tree, so it must not print a table that reads like one.
// Handled here (after the constants and functions exist) rather than in the CLI
// block above, which runs before `SECURITY_BASELINE` is initialised.
if (process.argv.includes("--selftest")) {
  // Each classifier prints its own summary; the exit code aggregates them so one
  // broken scenario set fails the run either way.
  const securityFailed = runSecuritySelftest();
  const swallowFailed = runSwallowSelftest();
  process.exit(securityFailed + swallowFailed ? 1 : 0);
}

if (asBaseline) {
  // Prints one baseline object per ratchet, measured with the *same* function the
  // rules use. This block used to restate each regex inline, which meant the
  // command people were told to run after paying down debt could disagree with
  // the check it was supposed to be feeding.
  const out = {};
  for (const rule of RATCHETS) {
    const m = {};
    for (const f of rule.files()) {
      const n = rule.measure(f);
      if (n) m[f] = n;
    }
    out[rule.id] = m;
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const counts = { PASS: 0, FAIL: 0, INFO: 0, PENDING: 0 };
for (const r of results) counts[r.status] += 1;

if (asJson) {
  console.log(JSON.stringify({ ok: counts.FAIL === 0, counts, checks: results }, null, 2));
} else {
  const head = ["STATUS", "CHECK", "COUNT", "DETAIL"];
  const rows = results.map((r) => [r.status, r.id, String(r.count), r.detail]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (row) => row.map((cell, i) => (i === 3 ? cell : cell.padEnd(widths[i]))).join("  ");

  console.log("DevHub 静态不变量检查");
  console.log(line(head));
  console.log("-".repeat(widths[0] + widths[1] + widths[2] + widths[3] + 6));
  for (const row of rows) console.log(line(row));
  console.log("-".repeat(widths[0] + widths[1] + widths[2] + widths[3] + 6));
  console.log(
    `PASS ${counts.PASS}  FAIL ${counts.FAIL}  INFO ${counts.INFO}  PENDING ${counts.PENDING}` +
      (counts.PENDING ? "   (PENDING 是已知缺口，未阻断；见 PENDING_UNTIL)" : ""),
  );
}

if (counts.FAIL > 0) process.exitCode = 1;
