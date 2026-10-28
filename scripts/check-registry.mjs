// Cross-checks the element registry (src/store/customize.ts ELEMENTS) against
// the DOM ids the source tree actually uses.
//
// Why this exists: 开发者模式's whole premise is that every manageable block is
// registered (`reg("id")` / `regId="id"` → `data-reg-id`). Two failure modes
// have both been reported in audits (开发者模式审计_20261009.md G1/G3) and both
// are invisible without counting:
//
//   USED-BUT-UNREGISTERED  the DOM carries the id but the registry does not, so
//                          the Inspector cannot address the block and 界面管理
//                          never offers it. (G3; partially backfilled by hand in
//                          customize.ts「登记补齐」.)
//   REGISTERED-BUT-UNUSED  the registry offers a switch that no node consumes,
//                          so toggling it changes nothing. (G1.)
//
// Statuses follow scripts/check-invariants.mjs: used-but-unregistered is FAIL
// (exit 1, a real dead control path). REGISTERED-BUT-UNUSED is now FAIL too
// (2026-10-15), not the INFO it used to be: an id the Inspector cannot address is
// a switch the user can toggle with no effect, which is the G1 defect this file
// was written for. The reason it was INFO — "removing an entry rewrites what
// users may have stored in their overrides" — is real, so it moved into
// `KNOWN_DEAD` below, where keeping such an entry must be a written decision
// rather than a status. `--allowlist <id> …` prints the line to paste.
//
// A registered id counts as USED when it appears in a *usage position* outside
// the registry file: `reg("…")`, `regId="…"` / `headerId="…"` /
// `data-reg-id="…"`, or a static `reg(` template call. Runtime-built ids
// (`reg(\`block-${x}\`)`) cannot be resolved to a name by any static scan, so the
// old file also exempted a registered id whenever its literal turned up ANYWHERE
// in `src/` as a quoted string — measured on this tree: 496 distinct string
// literals, i.e. a second vocabulary large enough to swallow any dead entry.
// That made "registered but unused" unfalsifiable: the metric could only ever
// report what the literal scan happened not to know about, and it could never be
// wrong in the interesting direction.
//
// The broad exemption is gone. To keep the trade honest rather than hidden, the
// run now prints how many ids the old rule would have exempted, so anyone
// comparing the two numbers sees exactly what the tighter rule exposes. On this
// tree the answer is zero: all 133 registered ids are found by the usage
// positions, so the exemption was pure cover, and `dead` can genuinely fire.
//
// Dependency-free by rule: node:fs, node:path only.
// Run `node scripts/check-registry.mjs --json` for machine-readable output.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Root anchoring (round 15 d7): `readFileSync("src/store/customize.ts")` (:55) and
// `walk("src")` (:77) were cwd-relative, so `cd tests && node ../scripts/check-registry.mjs`
// threw ENOENT. See check-events.mjs's header for the full rationale; this file uses
// the same chdir(ROOT) fix, and `tests/checkers.test.ts` runs it from `tests/`.
process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));

const asJson = process.argv.includes("--json");
// `--allowlist <id> <id> …` records why an id must stay registered with no
// consumer; the ids land in KNOWN_DEAD below.
const allowlistArgs = process.argv.includes("--allowlist")
  ? process.argv.slice(process.argv.indexOf("--allowlist") + 1).filter((a) => !a.startsWith("-"))
  : [];

// --- registered ids -------------------------------------------------------
const registrySrc = readFileSync("src/store/customize.ts", "utf8");
const elementsBlock = registrySrc.match(/export const ELEMENTS[^=]*=\s*\[([\s\S]*?)\n\];/);
if (!elementsBlock) {
  console.error("check-registry: cannot locate `export const ELEMENTS = [` in src/store/customize.ts");
  process.exit(1);
}
// Nested `sizes:[{id:"sm",…}]` tier objects live inside ELEMENTS entries; their
// ids are tiers, not DOM ids, so strip those sub-arrays before scanning. (`narrow`
// / `wide` were the first false positives this caught.)
const tierStripped = elementsBlock[1].replace(/sizes:\s*\[[\s\S]*?\]/g, "");
// `\bid:` not `^\s*id:` — many entries are single-line (`{ id: "sidebar-nav", … }`).
const registered = new Set([...tierStripped.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));

// --- ids used by the tree -------------------------------------------------
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|css)$/.test(f)) files.push(p);
  }
};
walk("src");

const registryPath = join("src", "store", "customize.ts");
const used = new Map(); // id -> first file that mentions it
// Usage positions, no shared alternation so the quotes stay unambiguous:
//   reg("id")                          — direct call
//   regId="id" | regId: "id"           — JSX prop or object literal (Sidebar NAV)
//   headerId="id"                      — ViewHeader prop → AppShell calls reg()
//   data-reg-id="id"                   — raw attribute / CSS selector
//   reg(`id`)                          — a STATIC template call (no `${}` inside)
const USAGE_CALL = /reg\(\s*"([a-z0-9-]+)"/g;
const USAGE_PROP = /(?:regId|headerId|data-reg-id)[=:]\s*"([a-z0-9-]+)"/g;
// Static template call only: `reg(`block-foo`)`. A `${}` inside is a runtime name
// no static scan can resolve, and that is what `--allowlist` is for.
const USAGE_TEMPLATE = /reg\(\s*`([a-z0-9-]+)`/g;
for (const f of files) {
  if (f === registryPath) continue;
  const src = readFileSync(f, "utf8");
  for (const re of [USAGE_CALL, USAGE_PROP, USAGE_TEMPLATE]) {
    for (const m of src.matchAll(re)) {
      if (!used.has(m[1])) used.set(m[1], f);
    }
  }
}

// Registered ids that must stay registered without a consumer, with the reason.
// Empty today, measured: the strict scan above already accounts for all 133 ids,
// so there is nothing to excuse. Add an entry — or `--allowlist <id> "reason"`,
// which prints the line to paste — rather than re-widening the literal exemption.
//
// An entry here that no longer needs cover (the id got wired up, or it left
// ELEMENTS altogether) is itself a failure: a stale exemption is the same rot the
// baseline constants in check-invariants.mjs had, and it is why that file grew a
// `ratchet-integrity` row.
const KNOWN_DEAD = {};

// What the old blanket literal exemption would have hidden. Computed so the
// comparison is auditable rather than asserted: an id with no usage position
// whose literal does appear somewhere in `src/` is exactly the case the old rule
// swallowed silently.
const literalsOutsideRegistry = new Set();
for (const f of files) {
  if (f === registryPath) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/"([a-z][a-z0-9-]*)"/g)) literalsOutsideRegistry.add(m[1]);
}
const noUsage = [...registered].filter((id) => !used.has(id));
const hiddenByOldRule = noUsage.filter((id) => literalsOutsideRegistry.has(id)).sort();
const dead = noUsage.filter((id) => !(id in KNOWN_DEAD)).sort();
const staleCovers = Object.keys(KNOWN_DEAD).filter((id) => used.has(id) || !registered.has(id)).sort();

const unregistered = [...used.entries()]
  .filter(([id]) => !registered.has(id))
  .sort((a, b) => a[0].localeCompare(b[0]));

// `--allowlist <id> …` is a printer, not a verdict: it hands over the exact line
// to paste into KNOWN_DEAD above, so recording a reason costs one edit and does
// not require reading this file first.
if (allowlistArgs.length) {
  for (const id of allowlistArgs) {
    const why = registered.has(id) ? "REASON — why this switch must stay offered to users" : "(not currently registered — nothing to excuse)";
    console.log(`  "${id}": ${JSON.stringify(why)},`);
  }
  process.exit(0);
}

// Round 17 o3-3: the shared checker contract wants `--json` to carry the verdict
// itself (`ok`), not just the evidence — a consumer that has to re-derive `ok`
// from the arrays can disagree with the exit code, and then the gate and the
// machine reading it are telling different stories. `ok` is the same value the
// exit code is derived from, computed once.
const failed = unregistered.length + dead.length + staleCovers.length > 0;
const report = {
  ok: !failed,
  registered: registered.size,
  used: used.size,
  unregistered: unregistered.map(([id, file]) => ({ id, file })),
  registeredButUnused: dead,
  staleAllowlistEntries: staleCovers,
  // The count the previous rule would have reported instead. Non-zero means the
  // two rules disagree, and the disagreement is in the "looks clean" direction.
  exemptedByOldLiteralRule: hiddenByOldRule,
  stringLiteralsScanned: literalsOutsideRegistry.size,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`registry: ${registered.size} registered, ${used.size} distinct ids referenced by the tree`);
  console.log(
    `usage scan: strict positions only; the old blanket "any string literal in src/" exemption ` +
      `matched ${literalsOutsideRegistry.size} distinct literals and would have hidden ${hiddenByOldRule.length} dead entr(ies)`,
  );
  // `unregistered` is built from `used.entries()`, so each item is a `[id, file]`
  // **tuple**, not a record. Destructuring `{ id, file }` printed
  // `used but unregistered: "undefined" (first seen: undefined)` for the first time in
  // r20-N1, when a new dialog introduced the first genuinely unregistered id — the
  // printer bug hid behind the fact that the row had been green for every previous round.
  for (const [id, file] of unregistered) {
    console.log(`FAIL  used but unregistered: "${id}" (first seen: ${file})`);
  }
  for (const id of dead) {
    console.log(`FAIL  registered, no consumer, no recorded reason: "${id}"`);
  }
  for (const id of staleCovers) {
    console.log(
      `FAIL  KNOWN_DEAD entry needs no cover: "${id}" (${used.has(id) ? "it is referenced by the tree again" : "it is no longer registered"}) — delete the line`,
    );
  }
  if (!dead.length && !staleCovers.length && !unregistered.length) {
    console.log("every id the tree references is registered; no dead entry without a recorded reason");
  }
  if (hiddenByOldRule.length) {
    console.log("  ids the OLD rule alone would have hidden: " + hiddenByOldRule.join(", "));
  }
}

process.exit(failed ? 1 : 0);
