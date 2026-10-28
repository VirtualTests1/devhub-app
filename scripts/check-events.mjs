// Cross-checks every Tauri event name emitted in Rust against the names the
// frontend listens for, and the other way round.
//
// This is the same class of defect `check-commands.mjs` exists for: a name typed
// on one side only, which no compiler can see and which fails as *silence* rather
// than as an error. A progress event nobody receives is a dialog that never moves;
// a listener nobody fires is a subscription that quietly outlives its feature.
//
// Event names are matched across line breaks on purpose: both sides format the
// string onto its own line (`listen(\n  "git-bootstrap://progress", …`) in
// App.tsx, and a single-line regex would report a live listener as missing.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Root anchoring (round 15 d7). Every path below — `walkSources("src-tauri/src")`,
// `walkSources("src")` — was resolved against the shell's cwd, so
// `cd tests && node ../scripts/check-events.mjs` died with ENOENT on
// `tests/src-tauri/src` and exited 1 (measured). check-invariants.mjs had fixed this
// for itself (and for check-commands.mjs, which it spawns after chdir) at d7-2, but
// events/registry/commands each kept the cwd-relative reads; the suite header claimed
// all five were anchored when only one was. Anchor once to the script's own location
// and chdir, exactly like check-invariants, so the *reported* paths stay relative
// ("src/App.tsx") while the resolution does not depend on the invocation directory.
// Regression guard: `tests/checkers.test.ts` runs this from `tests/`.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

const walkSources = (dir, ext) => {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (ext.test(f)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

const emitRe = /\.emit\s*\(\s*"([^"]+)"/g;
// Round 13 (d7-2): the old pattern was `/\blisten\b[\s\S]{0,160}?"([^"]+)"/`
// with a `://` filter on the captured name, and both halves were wrong in the
// unsafe direction. The window let a match cross statements (any quoted string
// within 160 characters of the word "listen" counted), and the `://` filter
// silently dropped every event name that does not look like a URL — so the day
// someone emits `"repo-updated"`, a live listener is dropped from `listened`
// and this checker prints FIRED BUT NOT RECEIVED for a listener that exists.
// A checker that cries wolf on healthy code is a checker people learn to
// dismiss. The call form below requires the actual API shape: `listen(` or
// `listen<...>(` with the channel name as the first argument, in a file that
// imports the event module at all.
const eventModuleImportRe = /from\s*"@tauri-apps\/api\/event"/;
const listenRe = /\blisten\s*(?:<[^<>]*>)?\s*\(\s*"([^"]+)"/g;

const emitted = new Map();
for (const f of walkSources("src-tauri/src", /\.rs$/)) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(emitRe)) {
    if (!emitted.has(m[1])) emitted.set(m[1], f);
  }
}

const listened = new Map();
for (const f of walkSources("src", /\.(ts|tsx)$/)) {
  const src = readFileSync(f, "utf8");
  // Only files that import the Tauri event module can hold a real listener;
  // the word "listen" in prose or in a local variable (`listening` ports) is
  // not a subscription.
  if (!eventModuleImportRe.test(src)) continue;
  for (const m of src.matchAll(listenRe)) {
    if (!listened.has(m[1])) listened.set(m[1], f);
  }
}

const unheard = [...emitted.keys()].filter((n) => !listened.has(n));
const dead = [...listened.keys()].filter((n) => !emitted.has(n));

// ---------------------------------------------------------------------------
// Coverage floors — "the parse produced a plausible amount of coverage"
// ---------------------------------------------------------------------------
// NOT a debt ratchet. The peer check above is pairwise: it can only complain about
// a name that one side has and the other lacks. If BOTH maps silently go empty —
// the Rust `.emit("…")` regex stops matching (a `format!`-built channel name, a
// renamed call site), the webview `listen` scan stops matching (a `listen` moved
// behind a helper, so :40's in-file `@tauri-apps/api/event` import guard drops the
// whole file), or this runs from the wrong directory — then `unheard` and `dead`
// are both empty, and the OLD verdict was `OK: every event name has a peer on both
// sides` / exit 0. Total loss of coverage reading as a pass. check-commands.mjs
// already refuses this with INVOKED/REGISTERED floors; these are the same idea for
// events. Set just under the measured 4 / 4 so ordinary churn (adding or removing
// one event) never trips them, while a collapse (0, or the both-empty failure) does.
const EMIT_FLOOR = 3;
const LISTEN_FLOOR = 3;
const floorOk = emitted.size >= EMIT_FLOOR && listened.size >= LISTEN_FLOOR;

console.log(`emitted from Rust:  ${emitted.size}`);
console.log(`listened in webview: ${listened.size}`);
console.log(
  `floors: emitted ${emitted.size} >= ${EMIT_FLOOR}, listened ${listened.size} >= ${LISTEN_FLOOR} — ${floorOk ? "OK" : "VIOLATED"}`,
);
if (unheard.length) {
  console.log("FIRED BUT NOT RECEIVED (progress the user can never see):");
  for (const n of unheard) console.log(`  ${n}  <- ${emitted.get(n)}`);
}
if (dead.length) {
  console.log("LISTENED BUT NEVER FIRED (a subscription to a dead channel):");
  for (const n of dead) console.log(`  ${n}  <- ${listened.get(n)}`);
}
if (!floorOk) {
  console.log(
    `FLOOR VIOLATION: the scan found far fewer event names than this app carries (${emitted.size} emitted / ${listened.size} listened). ` +
      "Either the parsers stopped seeing the code (a `format!`-built channel name, a `listen` behind a helper, running from the wrong directory) or events really were deleted — lower the floor in this file and say why in the commit message. A pair-wise 'OK' here would be meaningless because both maps are empty.",
  );
}
if (floorOk && !unheard.length && !dead.length) {
  console.log("OK: every event name has a peer on both sides");
}
if (unheard.length || dead.length || !floorOk) process.exitCode = 1;
