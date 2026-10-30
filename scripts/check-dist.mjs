// check-dist.mjs — post-build sanity for `vite build` output.
//
// Why this exists: `pnpm build` exiting 0 does not mean the shipped bundle is
// usable. Two failures this project has actually hit are invisible to the exit
// code — Rolldown's `sourcemap: "cheap"` silently emitting zero `.map` files
// while reporting success (see the long note in vite.config.ts), and a
// manualChunks split that stops producing vendor chunks without failing the
// build. Both present as "the build passed" followed by an un-diagnosable
// runtime or a size regression.
//
// Run after `pnpm build` (wired into `verify`). Exits non-zero on structural
// breakage — missing entry, dangling asset references, or sourcemaps promised by
// vite.config.ts but absent from disk — and, since round 16 (r3-3), on a bundle-size
// regression past a measured ceiling (see the size-budget block near the bottom of
// this file). Vendor-chunk shape is reported as INFO — the grouping is a perf
// heuristic, not a contract.
//
//   node scripts/check-dist.mjs              structural + size-budget verdict
//   node scripts/check-dist.mjs --budgets    also print today's measurement as
//                                            pasteable ceiling constants
//
// Dependency-free by rule: node:fs, node:path, node:url only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");

// `--budgets` prints the current measurement as ready-to-paste constants. It exists
// because a ratchet nobody can re-measure in one command turns into a number people
// raise by hand from a `stat`, which is how it silently stops being a ratchet.
const flagBudgets = process.argv.slice(2).includes("--budgets");
for (const a of process.argv.slice(2)) {
  if (a !== "--budgets") {
    console.error(`check-dist.mjs: unrecognised argument '${a}' (only --budgets is accepted)`);
    process.exit(2);
  }
}

const broken = [];
const info = [];

if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.error("check-dist.mjs — dist/ does not exist. Run `pnpm build` first.");
  process.exit(1);
}

const indexHtml = join(DIST, "index.html");
if (!existsSync(indexHtml)) {
  console.error("check-dist.mjs — dist/index.html missing; the build produced no entry.");
  process.exit(1);
}

const html = readFileSync(indexHtml, "utf8");

// Every local href/src in the entry must resolve on disk. External URLs
// (http/https/data) are the webview's problem, not this script's.
const refs = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]);
let localRefs = 0;
const initialJsRefs = new Set();
for (const ref of refs) {
  if (/^(?:https?:|data:|#|blob:)/.test(ref)) continue;
  const clean = ref.replace(/^\//, "").split("?")[0].split("#")[0];
  if (!clean) continue;
  localRefs++;
  if (clean.endsWith(".js")) initialJsRefs.add(clean);
  if (!existsSync(join(DIST, clean))) {
    broken.push(`index.html references \`${ref}\` — file not found under dist/`);
  }
}

// Sourcemaps: vite.config.ts turns them on deliberately (the report-error
// stack symbolication path depends on them). A build that drops the maps is
// exactly the "cheap" trap, so their absence is a failure, not a note.
const assetsDir = join(DIST, "assets");
const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
const jsAssets = assetFiles.filter((f) => f.endsWith(".js"));
const cssAssets = assetFiles.filter((f) => f.endsWith(".css"));
const jsMaps = assetFiles.filter((f) => f.endsWith(".js.map"));
const cssMaps = assetFiles.filter((f) => f.endsWith(".css.map"));

if (jsAssets.length > 0 && jsMaps.length === 0) {
  broken.push(
    `vite.config.ts sets sourcemap: true but dist/assets has ${jsAssets.length} .js file(s) and 0 .js.map — ` +
      `this is the shape the Rolldown \`cheap\` trap produced (see vite.config.ts build comment)`,
  );
}
// CSS maps are INFO, not FAIL: Rolldown + @tailwindcss/vite do not emit .css.map
// even with `sourcemap: true`. The CSS source lives inside the Tailwind plugin's
// internal pipeline; there is no file on disk for a map to reference. JS maps
// are the ones the report-error symbolication path actually loads.
if (cssAssets.length > 0 && cssMaps.length === 0) {
  info.push(
    `${cssAssets.length} .css file(s) with no .css.map — expected: Rolldown/Tailwind does not emit CSS sourcemaps`,
  );
}

// Vendor split is INFO: manualChunks groups by top-level package. Whether the
// grouping is good is a perf question; whether it still splits at all is worth
// seeing in every build log so a silent config regression is visible.
const vendorJs = jsAssets.filter((f) => f.startsWith("vendor-"));
info.push(
  `assets: ${jsAssets.length} js, ${cssAssets.length} css, ${jsMaps.length}+${cssMaps.length} maps, ` +
    `${vendorJs.length} vendor chunk(s)${vendorJs.length ? ` [${vendorJs.slice(0, 8).join(", ")}${vendorJs.length > 8 ? ", …" : ""}]` : ""}`,
);

// ---------------------------------------------------------------------------
// Size budget — a REGRESSION RATCHET, not a log line
// ---------------------------------------------------------------------------
// The block below used to be "no threshold, this just makes the number visible",
// and that is precisely the failure it needs to prevent: a visible number nobody
// acts on. A 150 kB regression rides in on any commit that adds a dependency or
// removes a `manualChunks` entry, the build still exits 0, and the only thing that
// notices is whoever reads the log — if anyone. vite.config.ts's own 600 kB chunk
// warning cannot cover this: it is a per-chunk warning emitted by the bundler, it
// says nothing about the JS+CSS total, and it does not fail anything.
//
// HOW THE BASELINE WAS MEASURED (do not trust these numbers without re-running it):
//   date    2026-10-16, worktree .worktrees/r16-r3-supply at master c7ab0b2
//   command pnpm build   (= `tsc && vite build`, exit code 0, "✓ built in 3.02s")
//   then    stat over dist/assets/**, exact bytes (22 .js, 1 .css, 21 .js.map)
//   result  .js total 747484 B · .css total 76147 B · js+css 823631 B
//           largest single chunk vendor-react-dom-*.js 206957 B
//   re-checked at de20eca (r3-1/r3-2 only add scripts/, no src change):
//   byte-identical 747484 / 76147 / 823631 / 206957 — the ceiling is not pinned
//   to one commit's accident.
//   re-pinned 2026-10-17 at the r18-o1 gate: measured on the o1 direction branch
//   with master merged in (r17 direction merges, r16-n1-2 panel mount, and four
//   r18-o1 i18n batches all landed since the numbers above). Deliberate raise,
//   same margin ratios as documented below; the commit that raised them says
//   why. Measured .js 885438 B · .css 75101 B · js+css 960539 B · largest single
//   chunk 206957 B (unchanged — vendor-react-dom did not grow).
//   (the .map files are excluded on purpose — they are never fetched by the webview,
//   and they alone are 3342910 B, i.e. 4x the shipped payload. Budgeting them would
//   make the ratchet measure sourcemap verbosity instead of what users download.)
//
//   re-pinned 2026-10-18 at the r19 gate: measured on the consolidated r19 line
//   (o1 i18n finish + B1 refresh + C1-C3 + D1-D3, 96 add/sp dictionary entries in
//   both locales) after `pnpm build`. Deliberate raise, same margin ratios as the
//   baseline below; the commit that raised them says why. Measured .js 936805 B ·
//   .css 76208 B · js+css 1013013 B · largest single chunk AppShell 220930 B.
//
//   TIGHTENED 2026-10-19 at the r21-o1 gate (this commit): measured on
//   feat/o1-1-dist-ratchet at master 436c713. Commands and readings:
//     pnpm build                       exit 0 (tsc + vite 8.3.2, "built in 30.01s")
//     node scripts/check-dist.mjs --budgets   exit 0
//       .js 977312 B · .css 77252 B · js+css 1054564 B
//       largest single chunk vendor-react-dom-*.js 206957 B
//   Ceilings set to the measurement rounded up to the next 100/1000 B — i.e.
//   +0.02%..+0.07% headroom instead of the old +5.6%..+10.3%, per the ratchet
//   discipline below ("tighten the constants toward the measurement"). The
//   numbers above the old constants read 92.0%–98.7% used; now they read ~100%.
//
//   TIGHTENED AGAIN 2026-10-19, r21-o1 O1-2 (after deleting the dead CSS
//   `.truncate-safe` / `.motion-pulse` + `@keyframes pulseOnce` from src/index.css):
//     pnpm build                       exit 0
//     node scripts/check-dist.mjs --budgets   exit 0
//       .js 977312 B (unchanged) · .css 77004 B (was 77252) · js+css 1054316 (was 1054564)
//       largest single chunk vendor-react-dom-*.js 206957 B (unchanged)
//   CSS ceiling and total ceiling ratcheted down by the measured 248 B; the JS and
//   single-chunk ceilings stay where the previous tightening put them because the
//   measurement itself did not move.
//
//   TIGHTENED AGAIN 2026-10-19, r21-o1 O1-3 (cn() no longer pulls clsx +
//   tailwind-merge — see src/lib/utils.ts for the measured equivalence contract):
//     pnpm build                       exit 0
//     node scripts/check-dist.mjs --budgets   exit 0
//       .js 958613 B (was 977312) · .css 77004 B (unchanged) · js+css 1035617 (was 1054316)
//       largest single chunk vendor-react-dom-*.js 206957 B (unchanged)
//       index.html preloads 19 assets (was 21): vendor-tailwind-merge and vendor-clsx
//       are gone from the graph, so the initial payload drops by 27693 B as well.
//   JS ceiling and total ceiling ratcheted down by the measured 18699 B. CSS is
//   byte-identical to the O1-2 measurement (the only CSS-affecting change —
//   utils.ts — is excluded from the Tailwind scan by `@source not` in src/index.css,
//   without which the rule table's own example class names added 3693 B).
//
//   RAISED DELIBERATELY 2026-10-19, r21 integration gate (feature growth, not
//   regression): the r21 feature lines landed after the O1-3 tightening —
//     N1  「在项目中搜索」对话框（src/dialogs/RepoGrepDialog.tsx + src/lib/grep.ts）
//     N2  设置页 Docker 环境面板 + 项目设置 Docker 隔离面板
//     N3  设置页「注册 devhub:// 协议」行（DeepLinkSection + deeplink-register）
//   and the same build carried the r21 merge's i18n keys for all three.
//     pnpm build                       exit 0, built in 2m 2s
//     node scripts/check-dist.mjs --budgets
//       .js 990967 B (was 958613) · .css 77918 (was 77004) · js+css 1068885 (was 1035617)
//       largest single chunk vendor-react-dom-*.js 206957 B (unchanged — the growth
//       is spread across the app chunk and the new lazily-loaded dialog chunks)
//   The single-chunk ceiling therefore does not move; the other three are re-pinned
//   to the measurement with the usual near-zero margin. This is the documented
//   direction of travel for a FEATURE commit (see the re-pinned 2026-10-18 r19 note
//   above): the ceiling tracks reality, and the commit that raises it is where the
//   growth is accounted for. What it is NOT allowed to do is absorb an unexplained
//   +3% — every byte above the O1-3 floor is attributed to the three panels above.
//
//   RE-PINNED 2026-10-20 at the r21 integration gate, after both r21 lines merged
//   (this session's N3/R2/R3 chains + the parallel session's `4000ab0`/`3fef0ce`/
//   `0aa06c7`/`5c69f76`):
//     pnpm build                    exit 0
//     node scripts/check-dist.mjs --budgets
//       .js 988365 B (was 990967, ↓2602) · .css 77948 (was 77918, ↑30)
//       js+css 1066313 (was 1068885, ↓2572) · largest chunk 206957 (unchanged)
//   CSS is the only ceiling that moves UP, by 30 B: the new Tailwind rules come from
//   the r21 panels' utility classes (N3's `DeepLinkSection.tsx`) plus the parallel
//   session's new surfaces (`kv-store`/`corpus`/`palette-hit`/`AddRepoView`), i.e.
//   intended feature growth, not a regression — `git diff fca6e99..HEAD -- src`
//   shows the only src/ edits are those files.
//   JS and the shipped total move DOWN per the RATCHETING DOWN rule below: the
//   parallel session's `5c69f76` rewrote the English word table as a value array
//   (`EN_VALUES`), which removes a second copy of every key from the bundle.
//   The single-chunk ceiling is lowered to the measured value as well (206957 B).
//
//   RE-PINNED 2026-10-21 after the r21-N4 + r21-R2 merges (feature growth, not a
//   regression):
//     N4  live GitHub reachability signal — `src/lib/net-status.ts`, the
//         StatusStrip probe/poll wiring and its i18n labels.
//     R2  `process://update` push — `mergeProcessUpdates`/`applyProcessUpdate`/
//         `subscribeProcessUpdates` in `src/store/processes.ts` plus the App mount
//         and cleanup. The 6 new tests do not ship.
//     pnpm build                    exit 0
//     node scripts/check-dist.mjs --budgets
//       .js 1007366 B (was 988365, +19001) — .css 77948 (unchanged)
//       js+css 1085314 (was 1066313, +19001) — largest chunk 206957 (unchanged)
//   CSS and the single-chunk ceiling do not move: no new Tailwind-only surfaces and
//   no new dependency. The 19 KB is the two features' own code plus their strings;
//   if a later round removes the 2 s fallback poll, that is where a cut can come from.
//
// UNITS: bytes are the unit of record. `kB` here is 1000 bytes, matching what the
// vite build log prints (it reported 206.95 kB for the 206957-byte react-dom chunk),
// so the two outputs are comparable. The previous line printed bytes/1024 under a
// `kB` label, which is KiB — silently 2.4% off the bundler's own number.
//
// HEADROOM: the ceiling is the measured value rounded up with a deliberate margin,
// so ordinary churn (one small component, a few Tailwind utilities) never trips it,
// while a real regression does. Margins chosen: +5.7% JS, +10.3% CSS (single-file
// Tailwind output grows with every class name, so it needs the widest slack),
// +6.3% single chunk, +5.6% total. Since the r21-o1 tightening those margins are
// +0.02%..+0.07% — deliberately near-zero: a ratchet that leaves 5-10% of slack
// re-teaches the next regression that budgets are advisory. If ordinary churn trips
// a ceiling, re-measure with `--budgets` and lower/adjust only with a commit that
// says why.
//
// RATCHETING DOWN: when a real reduction lands, re-measure with the command above
// and LOWER the constant — and say in the commit message what caused the drop.
// `--budgets` prints the current measurement so that is a one-line job.
//
// r22-O4 re-pinned again, and ADDED a fifth budget for the bytes index.html actually
// preloads. Splitting the card dialogs and the shortcut-only surfaces (command palette,
// shortcut help) moves modules out of the entry, but Rolldown also folds some formerly
// shared chunks (Toast, AppShell) into the entry, so the largest single chunk grows even
// though first load shrinks. The old single-chunk number therefore stopped describing
// what the user waits for; `INITIAL_JS_MAX_BYTES` does. Measured on the O4 tree:
// initial JS 772,100 → 675,900 B (−96,200 / −12.5%), total JS 1,016,889 → 1,019,302
// (+2,413 from chunk-boundary duplication), entry 162,874 → 312,752 B.
// 2026-10-24 (r25 final tree): re-pinned after the last 2026-10-22 measurement.
// Since that measurement, three shipped surfaces landed: N3 (App's Deep Link open
// handler), N4 (queue pause/resume row buttons + Pause/Play icons + 7 i18n pairs)
// and R2 (RepoFilesDialog's Channel streaming preview). R1/R3 are Rust/scripts/
// docs only and do not enter `dist`. Measured deltas vs the 2026-10-22 ceilings:
// JS +3,763 B (0.3%), largest chunk +1,507 B (ui-shared, 0.6%), initial JS +2,389 B
// (0.3%); CSS unchanged. This is intentional feature weight, not duplication drift.
// 2026-10-24 (code-point tag order): the `localeCompare` → code-point comparator
// added 5 B locally. CI's build of the same commit measured 4 B above that, so the
// three affected ceilings carry 1 KB of cross-machine headroom; a real regression
// is still far larger than that.
// 2026-10-28 (r27): measured after the ten directions landed — O3 launch-risk
// classifier/UI, O4 tag/tile i18n, N1 branch selection, N2 recent-commit list,
// N3 taskbar attention, and the O1 credential-scrub notice. Rust-only work
// (O1/O2 auth/cancel, R1/R2/R3) does not enter dist. Measured JS +13,051 B,
// CSS +68 B, largest chunk +4,552 B, initial JS +6,380 B; all under 2%.
// 2026-10-28 (r28): the About/update-check page, storage panel, wall facets and
// external-link wrapper add 8,470 B JS, 40 B CSS and 6,481 B to the largest
// chunk (SettingsView now carries AboutSection). Intended feature weight.
// 2026-10-29 (r31): table/task-list rendering, view export, WebView2/About row,
// preflight messages and batch-stop UI. Measured 1,145,471 / 79,782 / 257,827 /
// 1,225,253 / 747,430 B; each constant is the measurement + 1 KB headroom.
// r32: the English dictionary became a lazy chunk. Initial JS fell from
// 747,430 B to 682,319 B (−65,111 B, −8.7%) while total JS rose 12,234 B from
// this round's four new UI surfaces (queue priority/history, Markdown export,
// commit history). The ceiling follows the measurement; the initial-JS number
// is the one that actually describes what a launch downloads.
// r33 (2026-10-30): cross-repo search, the release row, the license overview and
// their 26 dictionary pairs. Measured 1,178,594 / 81,345 / 206,852 / 1,259,939 /
// 687,484 B. The initial-JS growth (+4,141 B) is mostly the default-locale
// dictionary, which must stay synchronous; every new screen is in a lazy chunk.
// r34 (2026-10-30): the health card, secret-scan dialog, search cancel/progress
// and launch-output restore. Measured 1,196,586 / 81,554 / 206,852 / 1,278,140 /
// 690,900 B; the dialog and card are lazy, so the initial growth is the dictionary
// again. Each ceiling is the measurement + 1 KB cross-machine headroom.
const JS_TOTAL_MAX_BYTES = 1_197_610; // measured 1,196,586 B + 1 KB headroom
const CSS_TOTAL_MAX_BYTES = 82_369; // measured 81,554 B on 2026-10-30 (r34) + 1 KB headroom
const SINGLE_CHUNK_MAX_BYTES = 207_876; // measured max 206,852 B (vendor-react-dom) + 1 KB headroom
const JS_CSS_TOTAL_MAX_BYTES = 1_279_164; // measured 1,278,140 B + 1 KB headroom
const INITIAL_JS_MAX_BYTES = 691_924; // measured 690,900 B after r34 + 1 KB headroom

// A chunk is a "single chunk" for the per-file ceiling only if it is actually
// loaded as one unit; sourcemaps are not, so they are excluded above.
const sizeOf = (f) => statSync(join(assetsDir, f)).size;

const jsBytes = jsAssets.reduce((s, f) => s + sizeOf(f), 0);
const cssBytes = cssAssets.reduce((s, f) => s + sizeOf(f), 0);
const totalBytes = jsBytes + cssBytes;
/**
 * Bytes the browser must fetch before the first paint: the entry script plus every
 * modulepreload/style link index.html names. It is not the same as `jsBytes`: lazy
 * chunks are deliberately absent, which is the whole point of the O4 split.
 */
const initialJsBytes = [...initialJsRefs].reduce((s, f) => s + statSync(join(DIST, f)).size, 0);
const largest = [...jsAssets, ...cssAssets]
  .map((f) => ({ f, n: sizeOf(f) }))
  .sort((a, b) => b.n - a.n);
const largestChunk = largest[0] ?? { f: "(none)", n: 0 };

const kB = (n) => `${(n / 1000).toFixed(1)} kB`;
const budgets = [
  { label: "JS total (dist/assets/*.js)", got: jsBytes, max: JS_TOTAL_MAX_BYTES },
  { label: "CSS total (dist/assets/*.css)", got: cssBytes, max: CSS_TOTAL_MAX_BYTES },
  { label: `largest single chunk (${largestChunk.f})`, got: largestChunk.n, max: SINGLE_CHUNK_MAX_BYTES },
  { label: "JS+CSS total shipped", got: totalBytes, max: JS_CSS_TOTAL_MAX_BYTES },
  { label: "initial JS (index.html entry + modulepreload)", got: initialJsBytes, max: INITIAL_JS_MAX_BYTES },
];
const over = budgets.filter((b) => b.got > b.max);

info.push(
  `js+css bytes in dist/assets: ${totalBytes} (${kB(totalBytes)}) — ` +
    `js ${jsBytes} (${kB(jsBytes)}), css ${cssBytes} (${kB(cssBytes)}), ` +
    `largest chunk ${largestChunk.n} (${kB(largestChunk.n)}) [sourcemaps excluded: ${jsMaps.length + cssMaps.length} files]`,
);
for (const b of budgets) {
  const pct = ((b.got / b.max) * 100).toFixed(1);
  info.push(
    `budget ${b.label}: ${b.got} B vs ${b.max} B ceiling (${pct}% used)` +
      (b.got > b.max ? "  OVER BUDGET" : ""),
  );
}
if (!over.length && jsBytes + cssBytes < 0.8 * (JS_TOTAL_MAX_BYTES + CSS_TOTAL_MAX_BYTES)) {
  info.push(
    `headroom: every budget is below 80% of its ceiling. The budget is a ratchet — tighten the constants toward the measurement so the next regression has less room to hide.`,
  );
}
info.push(`index.html local asset refs: ${localRefs} (initial JS ${initialJsBytes} B across ${initialJsRefs.size} module(s))`);

console.log("check-dist.mjs — post-build output sanity");
for (const line of info) console.log(`  INFO  ${line}`);

if (flagBudgets) {
  console.log("\nbudgets as measured now (paste over the constants in this file):");
  console.log(`const JS_TOTAL_MAX_BYTES = ${jsBytes};`);
  console.log(`const CSS_TOTAL_MAX_BYTES = ${cssBytes};`);
  console.log(`const SINGLE_CHUNK_MAX_BYTES = ${largestChunk.n};`);
  console.log(`const JS_CSS_TOTAL_MAX_BYTES = ${totalBytes};`);
  console.log(`const INITIAL_JS_MAX_BYTES = ${initialJsBytes};`);
}

if (broken.length) {
  console.log(`\nBROKEN (${broken.length}):`);
  for (const b of broken) console.log(`  - ${b}`);
  console.log("\nFAIL");
  process.exit(1);
}

if (over.length) {
  console.log(`\nSIZE BUDGET EXCEEDED (${over.length}) — this is a bundle-size regression:`);
  for (const b of over) {
    console.log(
      `  - ${b.label}: ${b.got} B (${kB(b.got)}) vs ${b.max} B (${kB(b.max)}) ceiling ` +
        `— over by ${b.got - b.max} B (${(((b.got - b.max) / b.max) * 100).toFixed(1)}%)`,
    );
  }
  console.log(
    "\n  Baseline was measured on 2026-10-17 from `pnpm build` on the r18-o1 gate tree\n" +
      "  (o1 direction with master merged); see the comment above the constants. If this\n" +
      "  growth is intended, re-measure, raise the\n" +
      "  constant deliberately, and say why in the commit message. `node scripts/check-dist.mjs\n" +
      "  --budgets` prints the current measurement as pasteable constants.",
  );
  console.log("\nFAIL");
  process.exit(1);
}

console.log("\nOK: dist entry resolves, sourcemaps present as configured, all size budgets held");
