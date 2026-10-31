// check-docs.mjs — a SMALL, non-brittle documentation drift guard.
//
// It asserts only what it can verify MECHANICALLY, without parsing prose.
// (Counts are owned by check-invariants.mjs / check-commands.mjs /
// check-registry.mjs — this script never touches them, on purpose: two checkers
// owning the same number is how they start disagreeing.)
//
// Checks:
//   1. every `pnpm <name>` mentioned in the docs is a real script
//      in package.json (pnpm's own builtins like `install`/`exec`/`add` are skipped);
//   2. every `scripts/<path>` mentioned there exists on disk;
//   3. every `src/<file>.<ext>` mentioned there exists on disk;
//   4. every `file.ext:LINE` citation that is attributed to a named symbol points
//      at a line that plausibly CONTAINS that symbol (round 15, d12).
//   5. every `pnpm <script>` / `node scripts/<path>` inside a `run:` line of
//      `.github/workflows/ci.yml` resolves the same way (round 16, o3-3). The
//      workflow is not prose, so it is not in DOCS — it gets its own scan of
//      exactly the two reference shapes a `run:` can carry: a typo'd `pnpm gtae`
//      there was invisible until the workflow first executed on a remote, and
//      this repo has never had one, so nothing else could have caught it.
//   6. every `scripts/<path>.<ext>`, `scripts/<dir>/*` glob, and backticked
//      `pnpm <script>` referenced in SOURCE comments (src/, tests/, scripts/,
//      src-tauri/src/) resolves the same way (round 21, o3-2). Docs get checked
//      because docs lie loudly; source comments lie quietly — `src/lib/compose.ts`
//      claimed `scripts/check-compose.mjs` measured its output for a whole round
//      while the file did not exist (Test-Path → False), and no scanner looked at
//      comments at all. The patterns are deliberately NARROW (measurement in the
//      Check 6 section below), and a deliberate historical reference is exempted
//      with a recorded reason, never silently passed.
//
// Check 4 was introduced as INFO (non-failing) in round 15 and has since been
// PROMOTED: `CITATION_MODE` defaults to "fail", so a stale `file.ext:LINE` now
// reddens the gate. `--citations=info` restores the report-only mode for a single
// run (the escape hatch the footer still prints). This header used to claim the
// default was INFO; it is corrected here because a comment that disagrees with the
// code is exactly how a guard's real state goes unnoticed (round 17 o3-3).
//
// CLI:  --citations=info|fail   override the mode for one run
//       --src=info|fail        same override for check 6 (source-comment refs)
//       --json                  machine-readable verdict (same exit codes)
//       --rewrite / --rewrite=dry  re-derive stale line numbers (write / plan only)
//       --selftest              verify check 4's classifier, check 5's CI
//                               run-line scanner, and check 6's source-comment
//                               scanner against synthetic inputs,
//                               no repo state, no network
// Anything else is rejected rather than ignored (exit 2): an unrecognised flag on
// a checker is how a guard silently stops running.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// The maintained doc. README.md is the public entry point; it is scanned for
// *reference* validity (scripts/paths it names still exist), not for prose
// accuracy.
//
// discoverDocs() still picks up any future top-level docs/*.md, excluding
// docs/archive/** — dated process reports whose citations were true when
// written and are expected to rot. They are history, not contract.
// Public contracts, not just the README. SECURITY.md promises a reporting path,
// AGENTS.md constrains contributors, the portable guide is what a user reads
// before running the binary, and THIRD_PARTY_NOTICES names the supply-chain
// documents. All four are scanned for the same resolvable `pnpm`/`scripts/`/
// `src/` references as the README; a stale command there is as misleading as one
// on the front page.
const ROOT_DOCS = [
  "README.md",
  "SECURITY.md",
  "AGENTS.md",
  "portable/使用说明.md",
  "THIRD_PARTY_NOTICES.md",
];
const ARCHIVE_PREFIX = "docs/archive/";

function discoverDocs() {
  let underDocs = [];
  const child = spawnSync("git", ["ls-files", "-z", "--", "docs/*.md"], { encoding: "utf8", cwd: ROOT, shell: false });
  if (!child.error && child.status === 0) {
    // `docs/*.md` as a git pathspec: `*` does not cross `/`, so this is exactly
    // the top-level docs, and `-z` sidesteps the quoting git applies to non-ASCII
    // names (the archive's are non-ASCII, the top-level ones are not).
    underDocs = (child.stdout || "").split("\0").filter(Boolean);
  } else {
    // No git on PATH (or not a repo): fall back to the non-recursive directory
    // listing, which reaches the same set of files and still cannot see archive/.
    try {
      underDocs = readdirSync(join(ROOT, "docs"), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => posix.join("docs", e.name));
    } catch {
      underDocs = [];
    }
  }
  return [...ROOT_DOCS, ...underDocs.filter((p) => !p.startsWith(ARCHIVE_PREFIX))];
}

const DOCS = discoverDocs();

// pnpm's own subcommands — not project scripts, so never validated as such.
// `outdated` joined the list in round 21 (r21-R2): `pnpm outdated --json` was
// measured working on this machine (docs/deps-ecosystems.md §6 matrix), so the
// doc citing it is a pnpm subcommand reference, not a dangling project script —
// the same class as `list`/`audit`, which were already here.
const PNPM_BUILTINS = new Set([
  "install", "i", "add", "a", "remove", "rm", "uninstall", "run", "exec", "dlx", "x",
  "create", "init", "up", "update", "rebuild", "link", "unlink", "patch", "prune",
  "store", "list", "ls", "why", "doctor", "import", "deploy", "recursive", "m",
  "workspace", "workspaces", "global", "bin", "version", "help", "licenses",
  "audit", "fund", "config", "setup", "dedupe", "fetch", "get", "hash", "outdated",
]);

const scripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts ?? {}));

// Drop `src-tauri` so a Rust path like `src-tauri/src/…` can never leak a bare
// `src/` token into check 3.
const neutralize = (s) => s.replace(/src-tauri/g, "TAURI_NEUTRAL");

const broken = [];
let pnpmChecked = 0;
let scriptsChecked = 0;
let srcChecked = 0;

const stripTail = (s) => s.replace(/[),.;:!\]}'"`]+$/g, "");

// ---------------------------------------------------------------------------
// Check 5 — `run:` lines in .github/workflows/ci.yml.
// ---------------------------------------------------------------------------
// The five docs are prose that references commands; the workflow is the other
// direction — executable commands whose references break silently, because only
// a real Actions run would execute them and this repo has never had a remote
// (see the ci.yml header). Two reference shapes can appear in a `run:`:
// `pnpm <script>` (validated against package.json) and `node scripts/<path>`
// (validated against the filesystem). Everything else in a run line —
// `cargo test`, `rustc --version`, `pnpm exec …` — is a builtin or a foreign
// binary and has no package.json truth to check against.

const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * Every command text in a workflow's `run:` keys, with the line it starts on.
 *
 * YAML-aware only as far as the two shapes this repo uses: `run: <one line>`
 * (including the `- run:` list-item spelling the lint job uses) and the
 * block scalars `run: |` / `run: >`, whose following deeper-indented lines are
 * part of the command. A key that merely CONTAINS `run:` (`run-name:`) or a
 * comment that mentions one (`# run: pnpm ghost`) must not be scanned — they
 * are exactly the look-alikes that would make a scanner cry wolf, so the match
 * is anchored to the start of the line with an optional list dash.
 */
function extractRunCommands(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const out = [];
  let block = null; // { indent, lineNo } while inside a block scalar
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^(\s*(?:- *)?)run:\s*(.*)$/.exec(line);
    if (m) {
      const rest = m[2].trim();
      if (rest === "" || /^[|>][+-]?\d*$/.test(rest)) {
        // Block scalar (or its value indented on the next lines): the command
        // continues on the following deeper-indented lines.
        block = { indent: m[1].length, lineNo: i + 1 };
      } else {
        block = null;
        out.push({ lineNo: i + 1, command: rest });
      }
      continue;
    }
    if (block) {
      if (line.trim() === "") continue; // blank lines stay inside the block
      const indent = line.length - line.trimStart().length;
      if (indent > block.indent) {
        out.push({ lineNo: i + 1, command: line.trim() });
        continue;
      }
      block = null; // de-dented → the block ended; the line itself cannot be a
      // run key (it just failed the anchored pattern above), so dropping it is safe.
    }
  }
  return out;
}

/**
 * Resolve the two reference shapes against their sources of truth.
 *
 * Pure over its inputs (synthetic commands + synthetic script sets), which is
 * what lets `--selftest` pin it without repo state. `pnpm run <script>` is
 * folded into the capture — `run` forwards to a package script just like the
 * bare form — while every other pnpm builtin (install/exec/dlx/…) is skipped by
 * the shared PNPM_BUILTINS list.
 *
 * Returns `{ findings: [{ lineNo, ref, why }], pnpmChecked, nodeChecked }`;
 * formatting the findings into BROKEN REFERENCES lines is the caller's job.
 */
function auditRunCommands(commands, { scripts, exists }) {
  const findings = [];
  let pnpmChecked = 0;
  let nodeChecked = 0;
  for (const { lineNo, command } of commands) {
    for (const m of command.matchAll(/\bpnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/g)) {
      const name = m[1];
      if (PNPM_BUILTINS.has(name)) continue;
      pnpmChecked += 1;
      if (!scripts.has(name)) {
        findings.push({ lineNo, ref: `pnpm ${name}`, why: "no such script in package.json" });
      }
    }
    for (const m of command.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9_./-]+)/g)) {
      const p = stripTail(m[1]);
      nodeChecked += 1;
      if (!exists(p)) findings.push({ lineNo, ref: `node ${p}`, why: "path not found" });
    }
  }
  return { findings, pnpmChecked, nodeChecked };
}

// ---------------------------------------------------------------------------
// Check 6 — `scripts/<path>` and `pnpm <script>` references in SOURCE comments.
// ---------------------------------------------------------------------------
// Why this exists (round 21, o3-2): checks 1-3 scan DOCS, check 5 scans the CI
// workflow, and nothing scanned the comments inside the source tree — which is
// where `src/lib/compose.ts:28` spent a whole round claiming that
// `scripts/check-compose.mjs` measured its output while the file did not exist
// (Test-Path → False). A comment is a promise about the repository just like a
// doc sentence is, and a broken one is worse: it is read next to the code it
// misdescribes.
//
// Deliberately NARROW patterns, because a scanner that cries wolf on prose is a
// scanner people learn to dismiss. Measured report-only over this tree
// (2026-10-19, 358 files / 26,835 comment lines, the run that preceded this
// code): the loose doc-shape `scripts/<token>` produced a prose false positive
// ("scripts/paths it names still exist" — this file's own header), and the
// loose `pnpm <word>` produced 17 more ("synthetic pnpm outputs", "pnpm
// spawn", "pnpm walker"). The narrowed shapes — a file extension after
// `scripts/`, a literal `*` for globs, a backtick immediately before `pnpm` —
// left 80 + 4 + 67 real references with exactly ONE dangling (`pnpm gtae`, the
// deliberate typo example this file's header and its selftest narrate), which
// is exempted below with a recorded reason. Comments only, never code:
// `dev.sh` in launch.rs is a runtime path tested against the USER's
// repository (root.join(file)), and `ghost.mjs` lives in the check-5
// selftest fixture — neither is a reference to this tree, and neither is in a
// comment either.
//
// Extraction is line-based and string-aware: a `//` inside a string literal is
// not a comment (a `"/*"` inside one does not open a block either), `//` must
// not follow `:` (so `https://` is not a comment). This is not theoretical —
// the first live run of this check reddened on THIS file, because the selftest
// fixtures below put synthetic comment text inside strings
// (`entriesOf(["// see scripts/<path> …"])`) and the naive scanner read the
// fixture as prose. The cost of being conservative is a rare MISSED comment
// (an apostrophe that does not pair, a multiline template); the cost of the
// alternative is scanning code as prose and reporting references nobody made.
// For a dangling-reference guard the miss is the safe direction — the floor
// below is what catches the pathological version (extraction returning nothing
// at all).

const SRC_ROOTS = ["src", "tests", "scripts", "src-tauri/src"];
// Named SRC_SCAN_EXT, not SRC_EXT: the citation index below already owns an
// `SRC_EXT` string (its extension alternation) — two different notions of
// "which files", so two names.
const SRC_SCAN_EXT = /\.(?:ts|tsx|js|mjs|cjs|rs|ps1|py|json)$/;
const SRC_SCRIPT_REF_RE = /\bscripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|ps1|sh|py|json)\b/g;
const SRC_GLOB_REF_RE = /\bscripts\/[A-Za-z0-9_./*-]*\*[A-Za-z0-9_./*-]*/g;
// Backtick-anchored: `` `pnpm <name>` `` / `` `pnpm run <name>` `` — the house
// style for citing a command. `# run: pnpm ghost` (a backtick that closes an
// EARLIER span) and prose "pnpm outputs" both fall outside this shape by
// construction, which is what replaced 17 false positives with 0.
const SRC_PNPM_REF_RE = /`pnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/g;

// Collapse floors for the same reason check-events/check-commands carry theirs:
// a scan whose extraction silently returns nothing prints "0 dangling" and exits
// green, i.e. total loss of coverage reading as a pass. Measured live 2026-10-19:
// scripts 80 + globs 4, pnpm 67 — floors sit at roughly half, so ordinary churn
// never trips them and a broken extractor always does.
const SRC_SCRIPT_FLOOR = 42;
const SRC_PNPM_FLOOR = 33;

// References that LOOK dangling in source comments but are deliberate
// historical/synthetic narratives — the repo's "recorded reason" pattern from
// check-commands/check-registry: keeping one is a written decision, and the map
// itself is checked — an exemption whose reference no longer occurs anywhere is
// STALE and fails the run (an exemption nobody needs is a cover, not a decision).
const SRC_COMMENT_EXEMPTIONS = {
  // The typo'd script name that gave check 5 its reason to exist: the header
  // comment here and the selftest-pin comment in tests/checkers.test.ts both
  // narrate the `pnpm gtae` run-line typo by name. The name MUST stay absent
  // from package.json — a fixture whose "typo" resolves is no longer the typo it
  // documents — so these two comments are the reference, not a defect.
  "pnpm gtae": "deliberate historical typo example (check 5's origin story + its --selftest fixture); the name must stay absent from package.json",
};

/** Version-controlled source files under SRC_ROOTS with a comment-bearing extension. */
function discoverSourceFiles() {
  const child = spawnSync("git", ["ls-files", "-z", "--", ...SRC_ROOTS], {
    encoding: "buffer",
    cwd: ROOT,
    shell: false,
  });
  let files = [];
  if (!child.error && child.status === 0) {
    files = (child.stdout || Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean);
  } else {
    // No git on PATH (or not a repo): the same walk the fallback in
    // discoverDocs() takes — skip node_modules/target/dist/dot-dirs so an
    // untracked scratch tree can never redden the gate either way.
    const walk = (relDir) => {
      if (!existsSync(join(ROOT, relDir))) return;
      for (const name of readdirSync(join(ROOT, relDir))) {
        const rel = `${relDir}/${name}`;
        const st = statSync(join(ROOT, rel));
        if (st.isDirectory()) {
          if (name === "node_modules" || name === "target" || name === "dist" || name.startsWith(".")) continue;
          walk(rel);
        } else if (SRC_SCAN_EXT.test(name)) files.push(rel);
      }
    };
    for (const r of SRC_ROOTS) walk(r);
  }
  return files.filter((f) => SRC_SCAN_EXT.test(f));
}

/**
 * Comment spans of one source file, with the 1-indexed line each starts on.
 *
 * Handles the four shapes this tree has: `//` line comments (.ts/.tsx/.js/.mjs/
 * .cjs/.rs, incl. `///`/`//!` doc comments), `/* … *` + `/` blocks (incl. JSDoc),
 * `#` line comments (.ps1/.py, incl. `#!/usr/bin/env`), and `<# … #>` blocks
 * (.ps1). The C-like half walks each line with a string state machine — single/
 * double quotes (line-bounded), backtick templates (they may span lines), and
 * Rust char literals recognised narrowly so a lifetime like `&'a` cannot open a
 * phantom string that swallows the trailing comment — so synthetic comment text
 * inside a STRING (every selftest fixture in this file) is never scanned.
 */
export function extractComments(text, ext) {
  const out = [];
  const lines = text.split(/\r?\n/);
  if (ext === ".ps1" || ext === ".py") {
    let inBlock = false;
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      if (ext === ".ps1" && inBlock) {
        out.push({ lineNo, text: line });
        if (line.includes("#>")) inBlock = false;
        return;
      }
      if (ext === ".ps1" && line.trim().startsWith("<#")) {
        out.push({ lineNo, text: line });
        inBlock = !line.includes("#>");
        return;
      }
      const hash = line.indexOf("#");
      if (hash >= 0) out.push({ lineNo, text: line.slice(hash) });
    });
    return out;
  }

  const isRust = ext === ".rs";
  // Rust: `'…'` only counts as a literal when it looks like one (a bounded char
  // literal), so `&'a str` / `<'a>` leave the line scannable. JS-ish: `'…'` is a
  // normal line-bounded string.
  const rustCharAt = (line, k) => /^'(?:\\.|[^\\']){1,8}'/.exec(line.slice(k));
  let inBlock = false; // the ONLY state that may span lines — comments are unambiguous
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let k = 0;
    // String state is LINE-LOCAL on purpose: a backtick inside a regex literal
    // (`const SRC_PNPM_REF_RE = /`pnpm …`/g`) is not a template, and a state
    // machine that believed it would swallow every comment that follows —
    // measured on this file, where line 287's `pnpm gtae` went unreported until
    // the reset was added. A multiline template's interior line may therefore
    // look like a comment; the `:` guard below keeps `https://` out, and the
    // cost of the residual miss/false-hit is documented in the section header.
    while (k < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", k);
        if (end === -1) {
          out.push({ lineNo, text: line.slice(k) });
          return;
        }
        out.push({ lineNo, text: line.slice(k, end + 2) });
        inBlock = false;
        k = end + 2;
        continue;
      }
      const ch = line[k];
      // `:` before `//` means a URL (only reachable on a template-interior line
      // now — real strings are consumed above), never a comment.
      if (ch === "/" && line[k + 1] === "/" && line[k - 1] !== ":") {
        out.push({ lineNo, text: line.slice(k) });
        return;
      }
      if (ch === "/" && line[k + 1] === "*") {
        inBlock = true;
        k += 2;
        continue;
      }
      if (ch === "`" || ch === '"' || (ch === "'" && (isRust ? rustCharAt(line, k) !== null : true))) {
        if (isRust && ch === "'") {
          k += rustCharAt(line, k)[0].length;
          continue;
        }
        const q = ch;
        let j = k + 1;
        let closed = false;
        while (j < line.length) {
          if (line[j] === "\\") { j += 2; continue; }
          if (line[j] === q) { closed = true; break; }
          j += 1;
        }
        if (closed) { k = j + 1; continue; }
        return; // unterminated at EOL (or a multiline template) — swallow the rest
      }
      k += 1;
    }
  });
  return out;
}

/**
 * Resolve the comment shapes against their sources of truth. Pure over its
 * inputs (comment entries + injected resolvers + an exemption map), which is
 * what lets `--selftest` pin it without repo state.
 *
 * Returns counts, every DANGLING reference (file:line named), the exempted
 * subset, the UNEXEMPTED findings (the caller's failure list), and any STALE
 * exemption (a key no longer dangling anywhere — the allowlist lying about
 * still being needed).
 */
export function auditSourceComments(entries, { exists, isDir, scripts, exemptions }) {
  const out = { scriptRefs: 0, globRefs: 0, pnpmRefs: 0, dangling: [], findings: [], exempted: [], stale: [] };
  for (const { file, lineNo, text } of entries) {
    for (const m of text.matchAll(SRC_SCRIPT_REF_RE)) {
      out.scriptRefs += 1;
      if (!exists(m[0])) out.dangling.push({ file, line: lineNo, ref: m[0] });
    }
    for (const m of text.matchAll(SRC_GLOB_REF_RE)) {
      out.globRefs += 1;
      // The doc-scan glob rule: a wildcard is checked up to its directory prefix.
      const target = m[0].slice(0, m[0].indexOf("*")).replace(/\/+$/, "");
      if (!target || !isDir(target)) out.dangling.push({ file, line: lineNo, ref: m[0] });
    }
    for (const m of text.matchAll(SRC_PNPM_REF_RE)) {
      const name = m[1];
      if (PNPM_BUILTINS.has(name)) continue;
      out.pnpmRefs += 1;
      if (!scripts.has(name)) out.dangling.push({ file, line: lineNo, ref: `pnpm ${name}` });
    }
  }
  const danglingSet = new Set(out.dangling.map((d) => d.ref));
  for (const d of out.dangling) {
    if (Object.prototype.hasOwnProperty.call(exemptions, d.ref)) out.exempted.push(d);
    else out.findings.push(d);
  }
  for (const key of Object.keys(exemptions)) {
    if (!danglingSet.has(key)) out.stale.push(key);
  }
  return out;
}

/**
 * Check 6's scanner, pinned without repo state — the live tree is exercised by
 * the real run; what must not regress is the DETECTING side: which line shapes
 * count as comments, the narrowed patterns (bare prose about pnpm output text,
 * and code strings, are NOT references), the exemption covering exactly what it
 * names, and the stale-exemption rule.
 */
function runSourceScanSelftest() {
  const noScripts = new Set(); // nothing resolves unless a case says otherwise
  const ghostExists = (p) => p === "scripts/real.mjs";
  const isDir = (p) => p === "scripts" || p === "scripts/verify";
  const base = { exists: ghostExists, isDir, scripts: noScripts, exemptions: {} };
  const entriesOf = (lines, file = "src/x.ts") => lines.map((t, i) => ({ file, lineNo: i + 1, text: t }));

  const cases = [
    {
      name: "src-scan: a dangling scripts/ reference in a // comment is caught, line named",
      run: () => {
        const a = auditSourceComments(entriesOf(["// see scripts/ghost.mjs for it"]), base);
        return a.findings.length === 1 && a.findings[0].ref === "scripts/ghost.mjs" && a.findings[0].line === 1
          ? [] : [`got ${JSON.stringify(a.findings)}`];
      },
    },
    {
      name: "src-scan: the same path in CODE (a string, not a comment) is not scanned",
      run: () => {
        const spans = extractComments('const p = "scripts/ghost.mjs";', ".ts");
        const a = auditSourceComments(spans.map((s) => ({ file: "src/x.ts", lineNo: s.lineNo, text: s.text })), base);
        return a.scriptRefs === 0 && a.findings.length === 0 ? [] : [`refs=${a.scriptRefs} findings=${a.findings.length}`];
      },
    },
    {
      name: "src-scan: prose `pnpm outputs` (no backticks) is not a script reference; `pnpm run x` is",
      run: () => {
        const a = auditSourceComments(entriesOf(["// synthetic pnpm outputs land here", "// run `pnpm run ghost` to see"]), base);
        const out = [];
        if (a.pnpmRefs !== 1) out.push(`pnpmRefs=${a.pnpmRefs}, expected 1`);
        if (a.findings.length !== 1 || a.findings[0].ref !== "pnpm ghost") out.push(`findings=${JSON.stringify(a.findings)}`);
        return out;
      },
    },
    {
      name: "src-scan: a recorded exemption covers exactly the ref it names, nothing else",
      run: () => {
        const ex = { "pnpm gtae": "historical typo example" };
        const a = auditSourceComments(entriesOf(["// a typo'd `pnpm gtae` is narrated here", "// and `pnpm nope` is not"]), { ...base, exemptions: ex });
        const out = [];
        if (a.dangling.length !== 2) out.push(`dangling=${a.dangling.length}`);
        if (a.exempted.length !== 1 || a.exempted[0].ref !== "pnpm gtae") out.push(`exempted=${JSON.stringify(a.exempted)}`);
        if (a.findings.length !== 1 || a.findings[0].ref !== "pnpm nope") out.push(`findings=${JSON.stringify(a.findings)}`);
        if (a.stale.length !== 0) out.push(`stale=${JSON.stringify(a.stale)}`);
        return out;
      },
    },
    {
      name: "src-scan: an exemption whose reference is gone is STALE, not quietly kept",
      run: () => {
        const a = auditSourceComments(entriesOf(["// nothing dangling here"]), { ...base, exemptions: { "scripts/old.mjs": "was historical" } });
        return a.stale.length === 1 && a.stale[0] === "scripts/old.mjs" ? [] : [`stale=${JSON.stringify(a.stale)}`];
      },
    },
    {
      name: "src-scan: ps1 `#` comments and globs are scanned (dir-prefix rule)",
      run: () => {
        const a = auditSourceComments(
          entriesOf(["# runs scripts/verify/*.tsx probes", "# reads scripts/verify/missing.json"], "scripts/x.ps1"),
          base,
        );
        const out = [];
        if (a.globRefs !== 1) out.push(`globRefs=${a.globRefs}`);
        if (a.findings.some((f) => f.ref.startsWith("scripts/verify/*.tsx"))) out.push("an existing glob dir was reported dangling");
        if (!a.findings.some((f) => f.ref === "scripts/verify/missing.json")) out.push("a missing .json ref was not caught");
        return out;
      },
    },
    {
      name: "src-scan: extractComments reads //, /* */, # and URL-lookalikes correctly",
      run: () => {
        const out = [];
        const js = extractComments(["const u = \"https://x\"; // real scripts/a.mjs", "/* block", "   scripts/b.mjs", "*/ code"].join("\n"), ".ts");
        // 4 spans: the line comment, then each of the three block-comment lines.
        if (js.length !== 4) out.push(`.ts comment spans=${js.length}, expected 4`);
        if (!js.some((c) => c.text.includes("scripts/a.mjs"))) out.push("the line comment after a URL was lost");
        if (!js.some((c) => c.text.includes("scripts/b.mjs"))) out.push("the block-comment body was lost");
        const ps1 = extractComments(["Write-Host hi # scripts/c.ps1"].join("\n"), ".ps1");
        if (ps1.length !== 1 || !ps1[0].text.includes("scripts/c.ps1")) out.push(`ps1 # comment extraction wrong: ${JSON.stringify(ps1)}`);
        return out;
      },
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const problems = c.run();
    if (problems.length) {
      failed += 1;
      console.log(`  FAIL  ${c.name}\n        ${problems.join("; ")}`);
    } else {
      console.log(`  ok    ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} source-scan self-test scenario(s) broken`
      : `\nOK: ${cases.length} source-scan self-test scenarios`,
  );
  return failed;
}

// ---------------------------------------------------------------------------
// Check 4 — `file.ext:LINE` citations and the symbol they are attributed to.
// ---------------------------------------------------------------------------
// Why this exists: check 2/3 only prove a cited PATH exists. `lib.rs` has existed
// for the whole life of this project while the line numbers pointing into it have
// drifted on every backend merge — REQUIREMENTS.md still cites `lib.rs:1310` for
// `create_repo_venv`, which moved to `lib.rs:1467`. A reader who follows a stale
// citation lands in the middle of an unrelated function and has no way to know the
// doc is lying, which is exactly how a doc becomes untrustworthy without ever
// being "wrong" in a way any existing check notices.
//
// Deliberately conservative: it only reports a citation STALE when a symbol was
// attributed to it with confidence, and it never claims to know what a line
// "should" say. The test is "does the cited line, or one of the two after it,
// contain that identifier" — the shape a function/const definition or a
// `#[tauri::command]`-attributed definition actually has.

/** Mode for check 4: "info" reports and passes, "fail" reports and fails. */
let CITATION_MODE = "fail";

/** Mode for check 6 (source-comment references): same two values, default "fail". */
let SRC_MODE = "fail";

const SRC_EXT = "(?:rs|tsx|jsx|ts|js|mjs|cjs|json|css|scss)";
// `lib.rs:1310`, `src/lib/fonts.ts:23`, `components/ContextMenu.tsx:96`,
// `lib.rs:1274/1285/1314` (a positional list) and the bare `` `:705` `` form that
// inherits the file from the last citation seen on the same doc line.
const CITE_RE = new RegExp(
  String.raw`(?<file>(?:[\w.@-]+\/)*[\w.@-]+\.${SRC_EXT})(?::(?<lines>\d+(?:\s*\/\s*\d+)*))?` +
    String.raw`|` +
    String.raw`:(?<bare>\d+)`,
  "g",
);

// Identifiers that are prose, not symbols, and would otherwise be "attributed".
const IDENT_STOP = new Set([
  "the", "and", "for", "with", "see", "line", "src", "run", "fn", "ok", "id", "js", "ts", "mjs",
  "rs", "css", "json", "code", "file", "path", "name", "true", "false", "null", "let", "const",
  "pub", "use", "api", "ui", "app", "one", "two", "all", "not", "was", "are", "its", "this",
  "that", "from", "have", "will", "same", "only", "note", "test", "tests", "grep",
]);

const identRe = (s) => new RegExp(String.raw`\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`);

/** The set of source files a citation can point at, indexed by rel path and by
 *  basename. Content is read lazily, only for files that are actually cited. */
function makeSourceIndex(walkRoots) {
  const relSet = new Set();
  const byBase = new Map();
  const add = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return;
    relSet.add(rel);
    const base = posix.basename(rel);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  };
  for (const r of walkRoots) {
    const abs = join(ROOT, r.dir);
    if (!existsSync(abs)) continue;
    const walk = (relDir) => {
      for (const name of readdirSync(join(ROOT, relDir))) {
        const rel = `${relDir}/${name}`;
        const st = statSync(join(ROOT, rel));
        if (st.isDirectory()) {
          if (name === "node_modules" || name === "target" || name === "dist" || name.startsWith(".")) continue;
          walk(rel);
        } else if (new RegExp(String.raw`\.${SRC_EXT}$`).test(name)) {
          add(rel);
        }
      }
    };
    if (r.dir === ".") {
      // Top level only: package.json / vite.config.ts / tsconfig*.json are cited
      // by name, and a recursive walk of "." would re-enter every source root.
      for (const name of readdirSync(ROOT)) {
        const st = statSync(join(ROOT, name));
        if (st.isFile() && new RegExp(String.raw`\.${SRC_EXT}$`).test(name)) add(name);
      }
    } else {
      walk(r.dir);
    }
  }
  const lineCache = new Map();
  const lines = (rel) => {
    if (!lineCache.has(rel)) lineCache.set(rel, (read(rel) || "").split(/\r?\n/));
    return lineCache.get(rel);
  };
  // A cited path is relative to the repo root in docs, but the root is not always
  // spelled out: `components/ContextMenu.tsx` means `src/components/…` and a bare
  // `lib.rs` means `src-tauri/src/lib.rs`. Try the literal path, then the usual
  // prefixes, then a unique basename. Anything ambiguous or missing is reported as
  // UNRESOLVED, never as stale — the guard must not invent a location.
  const resolve = (cited) => {
    const c = cited.replace(/^\.\//, "");
    if (relSet.has(c)) return c;
    for (const prefix of ["src/", "src-tauri/src/", "scripts/"]) {
      if (relSet.has(prefix + c)) return prefix + c;
    }
    const hits = byBase.get(posix.basename(c)) || [];
    return hits.length === 1 ? hits[0] : null;
  };
  // "The doc says lib.rs:1314, but `validate_interpreter` is not in lib.rs at all"
  // is only actionable if the guard can say where it IS. Costs a full read of the
  // indexed sources for that one symbol, and results are cached per symbol.
  const locateCache = new Map();
  const locate = (symbol, excludeRel) => {
    const key = `${symbol}|${excludeRel || ""}`;
    if (locateCache.has(key)) return locateCache.get(key);
    let hit = null;
    for (const rel of relSet) {
      if (rel === excludeRel) continue;
      const def = defLineOf(lines(rel), symbol);
      if (def) {
        hit = { rel, line: def };
        break;
      }
    }
    locateCache.set(key, hit);
    return hit;
  };
  return { resolve, lines, locate };
}

/**
 * Symbols a citation is attributed to, read off the doc line around it.
 * Returns [{ symbol, lineNo }] — one entry per cited line number when the doc
 * zips a `/`-separated symbol list onto a `/`-separated line list.
 *
 * The windows are normalised first: a citation is almost always written inside
 * backticks (`` `lib.rs:2` ``), so the raw text on either side starts/ends with
 * the citation's own backtick, and patterns anchored on `` `symbol` `` would never
 * line up. Stripping the backtick runs that hug the citation is what makes the
 * "symbol before" and "symbol after" shapes actually fire — measured: without it,
 * `create_repo_venv`（`lib.rs:1310`） attributed nothing at all.
 */
function attributeSymbols(docLine, matchStart, matchEnd, citedLines) {
  const rawBefore = docLine.slice(Math.max(0, matchStart - 140), matchStart);
  const rawAfter = docLine.slice(matchEnd, matchEnd + 140);
  const before = rawBefore.replace(/[`\s]+$/, "");
  const after = rawAfter.replace(/^[`\s]+/, "");
  const out = [];
  const clean = (s) => (s && !IDENT_STOP.has(s.toLowerCase()) ? s : null);

  // (a) `lib.rs:1118 venv_dir_for` / `launch.rs:1996` `trash_repo` — symbol trails it.
  const trail = /^([A-Za-z_][A-Za-z0-9_]{2,})/.exec(after);
  if (trail && clean(trail[1])) {
    return [{ symbol: trail[1], lineNo: citedLines[0] }];
  }

  // (b) `` `list_pythons`/`set_python_choice`/`validate_interpreter`，`lib.rs:1274/1285/1314` ``
  //     — a backticked slash-list of identifiers, zipped positionally onto the
  //     backticked slash-list of line numbers. Only when the counts match; a
  //     mismatch is not an attribution, it is a guess.
  if (citedLines.length > 1) {
    const listRun = /((?:`([A-Za-z_][A-Za-z0-9_]{2,})`\s*\/?\s*){2,})[^\w`]{0,8}$/.exec(before);
    if (listRun) {
      const names = [...listRun[1].matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)].map((m) => m[1]);
      if (names.length === citedLines.length && names.every((n) => clean(n))) {
        return names.map((symbol, i) => ({ symbol, lineNo: citedLines[i] }));
      }
    }
  }

  // (c) `` `create_repo_venv`（`lib.rs:1310`） `` — backticked symbol just before.
  const lead = /`([A-Za-z_][A-Za-z0-9_]{2,})`[^\w`]{0,6}$/.exec(before);
  if (lead && clean(lead[1])) {
    return [{ symbol: lead[1], lineNo: citedLines[0] }];
  }

  // (d) bare identifier before, un-backticked: `see create_venv at launch.rs:991`.
  const lead3 = /(?:^|[\s(（，,、>》:：/`])([A-Za-z_][A-Za-z0-9_]{2,})[\s]*$/.exec(before);
  if (lead3 && clean(lead3[1])) {
    out.push({ symbol: lead3[1], lineNo: citedLines[0] });
  }
  return out;
}

/** Definition-line patterns for a symbol, in one file's lines. */
function defLineOf(src, symbol) {
  const q = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pats = [
    new RegExp(String.raw`^\s*(?:#\[.*\]\s*)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+${q}\s*[(<]`),
    new RegExp(String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static|let|mut)\s+${q}\b`),
    new RegExp(String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+${q}\b`),
    new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let)\s+${q}\s*[=:(]`),
    new RegExp(String.raw`^\s*(?:export\s+)?(?:interface|type|class|enum|struct)\s+${q}\b`),
    new RegExp(String.raw`^\s*(?:\w+:\s+)?${q}\s*:\s*(?:async\s*)?\(`),
    // A struct field / object property: `pub venv_path: Option<String>,`. Docs cite
    // these as often as functions (`marker 的 venv_path`), and without this pattern
    // the report can only say "first mention", which is not an address.
    new RegExp(String.raw`^\s*(?:pub(?:\([^)]*\))?\s+|readonly\s+|mut\s+)?${q}\s*:\s*[A-Za-z_[(&].*[,;]?\s*$`),
  ];
  for (let i = 0; i < src.length; i++) {
    if (pats.some((p) => p.test(src[i]))) return i + 1;
  }
  return null;
}

/** Where the symbol is defined in this file; falls back to a bare mention (as a
 *  negative line number so the report can say so), or null when absent. */
function findSymbolLine(index, rel, symbol) {
  const src = index.lines(rel);
  const def = defLineOf(src, symbol);
  if (def) return def;
  const mention = src.findIndex((l) => identRe(symbol).test(l));
  return mention >= 0 ? -(mention + 1) : null;
}

/** Run check 4 over the given docs. Pure over (docTexts, index) — self-testable. */
function auditCitations(docTexts, index) {
  const findings = [];
  let cited = 0;
  let attributed = 0;
  let unresolved = 0;

  const push = (o) => findings.push(o);
  const pastEof = (n, src) => n > src.length;

  for (const { doc, text } of docTexts) {
    const docLines = text.split(/\r?\n/);
    docLines.forEach((line, li) => {
      let lastRel = null;
      for (const m of line.matchAll(CITE_RE)) {
        const whole = m[0];
        const start = m.index;
        const end = start + whole.length;

        // Bare `` `:705` `` — inherits the file of the previous citation on the line.
        if (m.groups.bare !== undefined) {
          if (!lastRel) continue;
          cited++;
          const n = Number(m.groups.bare);
          if (pastEof(n, index.lines(lastRel))) {
            push({ doc, docLine: li + 1, citation: whole, symbol: null, rel: lastRel, kind: "stale", lineNo: n,
              detail: `line ${n} is past the end of \`${lastRel}\` (${index.lines(lastRel).length} lines)` });
          }
          continue;
        }

        const rel = index.resolve(m.groups.file);

        // A path with no `:LINE` is check 2/3's business (existence), not this one's.
        if (m.groups.lines === undefined) {
          if (rel) lastRel = rel;
          continue;
        }
        if (!rel) {
          unresolved++;
          push({ doc, docLine: li + 1, citation: whole, symbol: null, rel: null, kind: "unresolved",
            detail: `no single source file matches \`${m.groups.file}\` — the guard will not guess which one was meant` });
          continue;
        }
        lastRel = rel;
        cited++;

        const src = index.lines(rel);
        const citedLines = m.groups.lines
          .split("/")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
        const attrs = attributeSymbols(line, start, end, citedLines);

        if (!attrs.length) {
          // Nothing confidently attributed to it: only an out-of-range line number
          // can be called a defect, since there is no symbol to locate.
          for (const n of citedLines) {
            if (pastEof(n, src)) {
              push({ doc, docLine: li + 1, citation: whole, symbol: null, rel, kind: "stale", lineNo: n,
                detail: `line ${n} is past the end of \`${rel}\` (${src.length} lines), and no symbol is named beside it` });
            }
          }
          continue;
        }

        for (const { symbol, lineNo } of attrs) {
          attributed++;
          if (pastEof(lineNo, src)) {
            push({ doc, docLine: li + 1, citation: whole, symbol, rel, kind: "stale", lineNo, suggest: null,
              detail: `line ${lineNo} is past the end of \`${rel}\` (${src.length} lines)` });
            continue;
          }
          // The cited line and the two after it: docs cite the definition, and a
          // `#[tauri::command]` / attribute / decorator line above the item is the
          // normal shape in this tree, so the item name legitimately sits at +1.
          const window = src.slice(lineNo - 1, lineNo + 2).join("\n");
          if (identRe(symbol).test(window)) continue;
          const actual = findSymbolLine(index, rel, symbol);
          const elsewhere = actual === null || actual < 0 ? index.locate(symbol, rel) : null;
          const mentionNote =
            actual !== null && actual < 0
              ? ` — in \`${rel}\` it is only MENTIONED (line ${-actual}), never defined`
              : "";
          const where = elsewhere
            ? `\`${symbol}\` is defined at \`${elsewhere.rel}:${elsewhere.line}\`${
                actual === null ? ` and is not in \`${rel}\` at all` : mentionNote
              }`
            : actual === null
              ? `\`${symbol}\` does not occur anywhere in the indexed sources`
              : actual < 0
                ? `first mention in \`${rel}\` is line ${-actual} (not a definition line)`
                : `defined at \`${rel}:${actual}\``;
          push({ doc, docLine: li + 1, citation: whole, symbol, rel, kind: "stale", lineNo,
            // Where the symbol actually lives, when the audit could work that out.
            // `--rewrite` only trusts this field, which is why it is set here and not
            // parsed back out of `detail` — a number recovered from prose is a number
            // that can silently be the wrong one.
            suggest: actual !== null && actual > 0 ? actual
              : elsewhere ? elsewhere.line : null,
            detail: `${where}; cited line reads: ${src[lineNo - 1].trim().slice(0, 88) || "(blank)"}` });
        }
      }
    });
  }
  return { findings, cited, attributed, unresolved };
}

function formatFindings(findings) {
  return {
    stale: findings.filter((f) => f.kind === "stale"),
    unresolved: findings.filter((f) => f.kind === "unresolved"),
  };
}

// ---------------------------------------------------------------------------
// --selftest: the classifier, pinned without repo state.
// ---------------------------------------------------------------------------
// The real docs are being edited by another line right now, so a test that
// asserted "these exact citations are stale" would break the moment they fix one.
// What must not regress is the CLASSIFIER — attribution shapes, the ±2 line
// window, the positional zip, out-of-range, wrong-file, ambiguity. Those live in
// memory here, over synthetic sources, and cost nothing.
function makeMemoryIndex(files) {
  const rels = Object.keys(files);
  const byBase = new Map();
  for (const rel of rels) {
    const b = posix.basename(rel);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(rel);
  }
  const lineCache = new Map();
  const lines = (rel) => {
    if (!lineCache.has(rel)) lineCache.set(rel, (files[rel] || "").split("\n"));
    return lineCache.get(rel);
  };
  const resolve = (cited) => {
    const c = cited.replace(/^\.\//, "");
    if (files[c] !== undefined) return c;
    for (const prefix of ["src/", "src-tauri/src/", "scripts/"]) {
      if (files[prefix + c] !== undefined) return prefix + c;
    }
    const hits = byBase.get(posix.basename(c)) || [];
    return hits.length === 1 ? hits[0] : null;
  };
  const locate = (symbol, excludeRel) => {
    for (const rel of rels) {
      if (rel === excludeRel) continue;
      const def = defLineOf(lines(rel), symbol);
      if (def) return { rel, line: def };
    }
    return null;
  };
  return { resolve, lines, locate };
}

function runCitationSelftest() {
  const rustLib = [
    "# line 1",
    "pub fn alpha() {}",
    "pub fn unrelated() {}",
    "#[tauri::command]",
    "async fn beta() {}",
    "// end",
    "// the command above calls venv_thing, which lives in launch.rs",
  ].join("\n");
  const launchRs = ["# line 1", "pub fn child_env() {}", "pub fn venv_thing() {}"].join("\n");
  const panelTsx = ["// 1", "export function onSubmit() {}"].join("\n");
  const files = {
    "src-tauri/src/lib.rs": rustLib,
    "src-tauri/src/launch.rs": launchRs,
    "src/components/Panel.tsx": panelTsx,
    "src-tauri/src/a/dup.rs": "// dup A\nfn shared_name() {}",
    "src-tauri/src/b/dup.rs": "// dup B\nfn shared_name() {}",
  };
  const index = makeMemoryIndex(files);

  const cases = [
    {
      name: "trailing symbol on the right line → PASS",
      doc: "see `lib.rs:2 alpha` for the thing",
      stale: 0,
      symbols: [],
    },
    {
      name: "leading symbol on the wrong line → STALE naming the real line",
      doc: "命令 `beta`（`lib.rs:2`）",
      stale: 1,
      symbols: ["beta"],
      expect: "defined at `src-tauri/src/lib.rs:5",
    },
    {
      name: "attribute line above the item counts (the ±2 window) → PASS",
      doc: "`lib.rs:4 beta`",
      stale: 0,
      symbols: [],
    },
    {
      name: "symbol lives in another file → STALE names that file",
      doc: "`child_env`（`lib.rs:3`）",
      stale: 1,
      symbols: ["child_env"],
      expect: "is defined at `src-tauri/src/launch.rs:2` and is not in `src-tauri/src/lib.rs` at all",
    },
    {
      name: "line past EOF with no symbol beside it → STALE",
      doc: "见 `lib.rs:9999`",
      stale: 1,
      symbols: [null],
      expect: "past the end",
    },
    {
      name: "symbol only MENTIONED in the cited file, defined elsewhere → STALE says both",
      doc: "（`venv_thing`，`lib.rs:3`）",
      stale: 1,
      symbols: ["venv_thing"],
      expect: "is defined at `src-tauri/src/launch.rs:3` — in `src-tauri/src/lib.rs` it is only MENTIONED",
    },
    {
      name: "positional zip of `a`/`b`/`c` onto `file:2/3/2` → exactly one STALE",
      doc: "（`alpha`/`unrelated`/`beta`，`lib.rs:2/3/2`）",
      stale: 1,
      symbols: ["beta"],
      expect: "defined at `src-tauri/src/lib.rs:5",
    },
    {
      name: "bare `:NNN` inherits the file seen earlier on the line",
      doc: "`launch.rs:2 child_env`，另见 `:88`",
      stale: 1,
      symbols: [null],
      expect: "past the end of `src-tauri/src/launch.rs`",
    },
    {
      name: "path relative to src/ resolves; unattributed in-range line → PASS",
      doc: "界面 `src/components/Panel.tsx:2` 与 `components/Panel.tsx:2` 同一处",
      stale: 0,
      symbols: [],
    },
    {
      name: "ambiguous basename → UNRESOLVED, never a fabricated STALE",
      doc: "`dup.rs:2 shared_name`",
      stale: 0,
      symbols: [],
      unresolved: 1,
    },
    {
      name: "a path with no line number is not this check's business",
      doc: "lib.rs 与 launch.rs 都在 src-tauri/src 下",
      stale: 0,
      symbols: [],
      unresolved: 0,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const { findings } = auditCitations([{ doc: "SELFTEST.md", text: c.doc }], index);
    const { stale, unresolved } = formatFindings(findings);
    const problems = [];
    if (stale.length !== c.stale) problems.push(`expected ${c.stale} stale, got ${stale.length}: ${JSON.stringify(stale.map((s) => s.symbol))}`);
    if (c.unresolved !== undefined && unresolved.length !== c.unresolved)
      problems.push(`expected ${c.unresolved} unresolved, got ${unresolved.length}`);
    for (const want of c.symbols) {
      if (want === null) continue;
      if (!stale.some((f) => f.symbol === want)) problems.push(`no stale finding attributed to ${want}`);
    }
    if (c.expect) {
      const all = findings.map((f) => f.detail).join(" | ");
      if (!all.includes(c.expect)) problems.push(`no finding contains "${c.expect}" (got: ${all || "none"})`);
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
      ? `\nFAIL: ${failed}/${cases.length} citation self-test scenario(s) broken`
      : `\nOK: ${cases.length} citation self-test scenarios`,
  );
  return failed;
}

/**
 * Check 5's scanner, pinned without repo state — the same contract as above:
 * the live workflow is exercised by the real run (tests/checkers.test.ts reads
 * the `ci run refs:` line it prints), while what must not regress is the
 * PARSER: which keys count as run commands, builtins vs scripts, block scalars,
 * and the look-alikes (`run-name:`, comments) that would make the scan cry wolf.
 *
 * The scenario's expected line numbers are the 1-indexed lines of the fixture
 * below — they are asserted, so editing the fixture means re-deriving them.
 */
function runCiSelftest() {
  const workflow = [
    "jobs:",
    "  web:",
    "    steps:",
    "      - name: install",
    "        run: pnpm install --frozen-lockfile", // line 5: builtin, never checked
    "      - name: a real script",
    "        run: pnpm gate", // line 7: resolves
    "      - name: a typo'd script",
    "        run: pnpm gtae", // line 9: must become a finding
    "      - name: run-form forwarding",
    "        run: pnpm run build", // line 11: `run` forwards, build resolves
    "      - name: block scalar",
    "        run: |", // line 13: block starts
    "          node scripts/check-dist.mjs", // line 14: resolves
    "          node scripts/ghost.mjs", // line 15: must become a finding
    "          cargo test --lib", // line 16: foreign binary, counts nothing
    "      - name: key that only looks like run",
    "        run-name: pnpm phantom", // line 18: NOT a run key
    "      - name: comment that only looks like run",
    "        # run: pnpm phantom", // line 20: NOT a run line
    "      - run: pnpm lint", // line 21: list-item run key, resolves
  ].join("\n");

  const commands = extractRunCommands(workflow);
  const { findings, pnpmChecked, nodeChecked } = auditRunCommands(commands, {
    scripts: new Set(["gate", "build", "lint"]),
    exists: (p) => p === "scripts/check-dist.mjs",
  });
  const refs = findings.map((f) => `${f.lineNo}:${f.ref}`).sort();
  const lineNos = commands.map((c) => c.lineNo).join(",");

  const cases = [
    {
      name: "ci-run: every run: shape is extracted, look-alikes are not",
      ok: commands.length === 8 && !JSON.stringify(commands).includes("phantom"),
      got: `extracted ${commands.length} command(s) from lines [${lineNos}]`,
    },
    {
      name: "ci-run: pnpm builtins are skipped; scripts are checked directly and via `run`",
      ok: pnpmChecked === 4 && !findings.some((f) => f.ref.startsWith("pnpm install")),
      got: `pnpmChecked=${pnpmChecked}, findings: ${refs.join(", ") || "none"}`,
    },
    {
      name: "ci-run: a typo'd pnpm script in a run line is a broken reference, line named",
      ok: refs.includes("9:pnpm gtae"),
      got: `findings: ${refs.join(", ") || "none"}`,
    },
    {
      name: "ci-run: node scripts/<path> inside a block scalar is checked, line by line",
      ok: nodeChecked === 2 && refs.includes("15:node scripts/ghost.mjs") && !refs.some((r) => r.includes("check-dist")),
      got: `nodeChecked=${nodeChecked}, findings: ${refs.join(", ") || "none"}`,
    },
    {
      name: "ci-run: foreign commands (cargo) contribute nothing to either count",
      ok: pnpmChecked + nodeChecked === 6 && findings.length === 2,
      got: `pnpm=${pnpmChecked} node=${nodeChecked} findings=${findings.length}`,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    if (c.ok) {
      console.log(`  ok    ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${c.name}\n        ${c.got}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} ci-run self-test scenario(s) broken`
      : `\nOK: ${cases.length} ci-run self-test scenarios`,
  );
  return failed;
}

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
for (const a of argv) {
  if (
    a === "--selftest" || a === "--citations=info" || a === "--citations=fail" ||
    a === "--src=info" || a === "--src=fail" ||
    a === "--help" || a === "--rewrite" || a === "--rewrite=dry" || a === "--json"
  ) continue;
  console.error(`check-docs.mjs: unknown argument '${a}'`);
  console.error("usage: node scripts/check-docs.mjs [--citations=info|fail] [--src=info|fail] [--selftest] [--rewrite[=dry]] [--json] [--help]");
  process.exit(2);
}
if (argv.includes("--help")) {
  console.log(
    "node scripts/check-docs.mjs [--citations=info|fail] [--src=info|fail] [--selftest] [--rewrite[=dry]] [--json]\n" +
      "  --citations=fail  make a stale file:line citation fail the run (default: fail since round 17)\n" +
      "  --src=info        make check 6 (source-comment scripts/pnpm refs) report-only for one run\n" +
      "                    (default: fail; the escape hatch a parallel line mid-write can use)\n" +
      "  --rewrite         rewrite the line number of every STALE citation the audit could\n" +
      "                    attribute to a named symbol, then exit (re-run to verify)\n" +
      "  --rewrite=dry     print that plan as TSV (doc, doc line, old, new) and write nothing\n" +
      "  --selftest        check the citation classifier, the CI run-line scanner and\n" +
      "                    the source-comment scanner against synthetic inputs,\n" +
      "                    repo state unused\n" +
      "  --json            machine-readable verdict (same exit codes: 0 pass / 1 fail)",
  );
  process.exit(0);
}
if (argv.includes("--citations=fail")) CITATION_MODE = "fail";
if (argv.includes("--citations=info")) CITATION_MODE = "info";
// Check 6's mode. Same shape as CITATION_MODE: default "fail" (dangling source
// references are exactly the defect this check was added to catch — a default of
// info would have shipped the check as a no-op), `--src=info` the per-run hatch.
if (argv.includes("--src=fail")) SRC_MODE = "fail";
if (argv.includes("--src=info")) SRC_MODE = "info";
if (argv.includes("--selftest")) {
  // The three self-tests report their own summary lines and return a failure
  // count; the process exit code aggregates them so one broken scenario set
  // fails the run either way.
  const citationFailed = runCitationSelftest();
  const ciFailed = runCiSelftest();
  const srcFailed = runSourceScanSelftest();
  process.exit(citationFailed + ciFailed + srcFailed ? 1 : 0);
}

const index = makeSourceIndex([{ dir: "src-tauri/src" }, { dir: "src" }, { dir: "scripts" }, { dir: "tests" }, { dir: "." }]);

const docTexts = [];

for (const doc of DOCS) {
  if (!existsSync(join(ROOT, doc))) {
    broken.push(`${doc}: referenced doc file does not exist`);
    continue;
  }
  const text = read(doc);
  docTexts.push({ doc, text });

  // (1) pnpm scripts
  for (const m of text.matchAll(/\bpnpm\s+([A-Za-z][\w:-]*)/g)) {
    const name = m[1];
    if (PNPM_BUILTINS.has(name)) continue;
    pnpmChecked++;
    if (!scripts.has(name)) broken.push(`${doc}: \`pnpm ${name}\` — no such script in package.json`);
  }

  // (2) scripts/<path>
  const raw = text;
  for (const m of raw.matchAll(/scripts\/[A-Za-z0-9_./-]+/g)) {
    let p = stripTail(m[0]);
    if (p === "scripts/" || p === "scripts") continue;
    scriptsChecked++;
    let target = p;
    if (p.includes("*")) {
      // glob: verify the directory prefix up to the wildcard exists
      target = p.slice(0, p.indexOf("*")).replace(/\/+$/, "");
      if (!target) continue;
      const ok = existsSync(join(ROOT, target)) && statSync(join(ROOT, target)).isDirectory();
      if (!ok) broken.push(`${doc}: \`scripts\` glob \`${p}\` — directory \`${target}\` not found`);
    } else {
      if (!existsSync(join(ROOT, target))) broken.push(`${doc}: \`${p}\` — path not found`);
    }
  }

  // (3) src/<file>
  const noTauri = neutralize(text);
  for (const m of noTauri.matchAll(/\bsrc\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|json)\b/g)) {
    const p = stripTail(m[0]);
    srcChecked++;
    if (!existsSync(join(ROOT, p))) broken.push(`${doc}: \`${p}\` — source file not found`);
  }
}

// (4) file:line citations, attributed to a named symbol.
const audit = auditCitations(docTexts, index);
const { stale, unresolved } = formatFindings(audit.findings);

// ---------------------------------------------------------------------------
// --rewrite / --rewrite=dry — re-derive the line numbers a stale citation names.
// ---------------------------------------------------------------------------
// Why this is a flag on the guard rather than a script someone writes when they
// need it: every direction that edits `lib.rs`/`downloader.rs` shifts a dozen
// citations, and on 2026-10-16 that job was done three times in one session by
// hand-editing eight doc lines each time — the same arithmetic, three times, with
// room to mistype. The guard already knows the answer (it prints it in the STALE
// detail); what it lacked was a way to say it in a machine-readable form.
//
// Only `f.suggest` is trusted, and only for citations the audit attributed to a
// named symbol. `past EOF`, unattributed and unresolved findings are reported and
// left alone: re-deriving a line number is safe, inventing one is not.
//
// `--rewrite` writes; `--rewrite=dry` prints the same plan as TSV and touches
// nothing, which is what makes the path testable from `pnpm test` without the test
// mutating the repository.
if (argv.includes("--rewrite") || argv.includes("--rewrite=dry")) {
  const write = argv.includes("--rewrite");
  const plan = [];
  for (const f of stale) {
    if (!f.suggest) continue;
    // The docs are inconsistent about whether they spell a citation with the bare
    // file name (`launch.rs:2188`) or the indexed path (`src-tauri/src/launch.rs:2188`),
    // and `f.rel` is always the latter. Matching only the full path silently dropped
    // every bare-name citation — measured on the first real use, which reported
    // "rewrote 0" while a stale citation was sitting right there. Try the full path
    // first, then the basename, and rewrite whichever one the doc actually contains.
    const names = [f.rel, posix.basename(f.rel)];
    const shown = names.find((n) => f.citation.includes(`${n}:${f.lineNo}`));
    if (!shown) continue;
    plan.push({ doc: f.doc, docLine: f.docLine, tok: `${shown}:${f.lineNo}`, rep: `${shown}:${f.suggest}` });
  }
  const byDoc = new Map();
  for (const p of plan) {
    if (!byDoc.has(p.doc)) byDoc.set(p.doc, []);
    byDoc.get(p.doc).push(p);
  }
  let changed = 0;
  let skipped = 0;
  for (const [doc, list] of byDoc) {
    if (!existsSync(doc)) continue;
    const lines = readFileSync(doc, "utf8").split("\n");
    let touchedThisDoc = 0;
    for (const p of list) {
      const i = p.docLine - 1;
      if (i < 0 || i >= lines.length) { skipped++; continue; }
      // The digit guard is not decoration: `downloader.rs:12` is a substring of the
      // `downloader.rs:1241` on the very next citation, and a blind `split/join`
      // would rewrite the wrong one and then report the file as clean.
      const re = new RegExp(`${p.tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "g");
      const hits = lines[i].match(re) || [];
      if (hits.length > 1) { skipped++; continue; }
      if (hits.length === 0) { skipped++; continue; }
      const next = lines[i].replace(re, p.rep);
      if (next !== lines[i]) {
        lines[i] = next;
        changed++;
        touchedThisDoc++;
      }
    }
    if (write && touchedThisDoc) writeFileSync(doc, lines.join("\n"));
  }
  if (write) {
    console.log(`check-docs --rewrite: rewrote ${changed} citation(s) across ${byDoc.size} doc(s); ${skipped} left for a human`);
    console.log("re-run `node scripts/check-docs.mjs` — the numbers it prints are now the ones it checked");
  } else {
    console.log("check-docs --rewrite=dry (nothing written)");
    for (const p of plan) console.log(`${p.doc}\t${p.docLine}\t${p.tok}\t${p.rep}`);
    console.log(`# plan: ${plan.length} citation(s), ${skipped} would be left for a human`);
  }
  process.exit(0);
}

// (5) CI workflow run: lines — see the Check 5 section above for why this file,
// why only `run:` lines, and why the two reference shapes.
let ciPnpm = 0;
let ciNode = 0;
let ciPresent = true;
if (!existsSync(join(ROOT, CI_WORKFLOW))) {
  // A deleted workflow has no run lines left to typo, so absence is not a
  // broken reference — but the count line must SAY it saw no file rather than
  // print a bare 0 that reads as "scanned everything, found nothing".
  ciPresent = false;
} else {
  const ci = auditRunCommands(extractRunCommands(read(CI_WORKFLOW)), {
    scripts,
    exists: (p) => existsSync(join(ROOT, p)),
  });
  ciPnpm = ci.pnpmChecked;
  ciNode = ci.nodeChecked;
  for (const f of ci.findings) {
    broken.push(`${CI_WORKFLOW}:${f.lineNo}: \`${f.ref}\` — ${f.why}`);
  }
}

// (6) source-comment references — patterns, narrowing measurements, and the
// exemption live in the Check 6 section above. The live half: read every
// comment span of every version-controlled source file, resolve against
// package.json + the filesystem, apply the recorded-reason exemptions, and
// enforce the collapse floors so an extractor that returns nothing cannot
// report "0 dangling" as a pass.
const srcFiles = discoverSourceFiles();
const srcEntries = [];
for (const f of srcFiles) {
  const ext = f.slice(f.lastIndexOf("."));
  for (const c of extractComments(read(f), ext)) srcEntries.push({ file: f, lineNo: c.lineNo, text: c.text });
}
const srcAudit = auditSourceComments(srcEntries, {
  exists: (p) => existsSync(join(ROOT, p)),
  isDir: (p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isDirectory(),
  scripts,
  exemptions: SRC_COMMENT_EXEMPTIONS,
});
const srcScriptsTotal = srcAudit.scriptRefs + srcAudit.globRefs;
const srcFloorOk = srcScriptsTotal >= SRC_SCRIPT_FLOOR && srcAudit.pnpmRefs >= SRC_PNPM_FLOOR;
const srcFloorMsg =
  `source scan floor violated: scripts refs ${srcScriptsTotal} (floor ${SRC_SCRIPT_FLOOR}), pnpm refs ${srcAudit.pnpmRefs} (floor ${SRC_PNPM_FLOOR}). ` +
  "The scan found far fewer references than this tree carries, so comment extraction or the scan face itself collapsed — " +
  "and an empty scan reporting 0 dangling would be total loss of coverage reading as a pass. If the tree genuinely " +
  "shrank below the floor, lower the constants in this file and say why in the commit message.";
if (SRC_MODE === "fail") {
  for (const d of srcAudit.findings) {
    const why = d.ref.startsWith("pnpm ")
      ? "no such script in package.json"
      : d.ref.includes("*")
        ? "glob directory prefix not found"
        : "path not found";
    broken.push(`${d.file}:${d.line}: \`${d.ref}\` — dangling reference in a source comment (${why})`);
  }
  for (const key of srcAudit.stale) {
    broken.push(
      `${key}: exemption in SRC_COMMENT_EXEMPTIONS is STALE — no source comment references it anymore ` +
        "(an exemption nobody needs is a cover; delete the entry in the same commit that removes the narrative)",
    );
  }
  if (!srcFloorOk) broken.push(srcFloorMsg);
}

// `--json` — the same verdict, machine-readable. It is emitted BEFORE the human
// report and short-circuits it, so `--json` output is always exactly one JSON
// document on stdout. Exit code is identical to the human path (round 17 o3-3
// unifies the checker contract: 0 pass / 1 FAIL / 2 usage error).
const jsonFail = broken.length > 0 || (stale.length > 0 && CITATION_MODE === "fail");
if (argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        ok: !jsonFail,
        docs: DOCS,
        counts: {
          pnpmScriptRefs: pnpmChecked,
          scriptsPathRefs: scriptsChecked,
          srcFileRefs: srcChecked,
          ciPnpmRefs: ciPnpm,
          ciNodeRefs: ciNode,
          citationsParsed: audit.cited,
          citationsAttributed: audit.attributed,
          citationsStale: stale.length,
          citationsUnresolved: unresolved.length,
          srcFilesScanned: srcFiles.length,
          srcScriptRefs: srcAudit.scriptRefs,
          srcGlobRefs: srcAudit.globRefs,
          srcPnpmRefs: srcAudit.pnpmRefs,
          srcDangling: srcAudit.dangling.length,
          srcExempted: srcAudit.exempted.length,
          srcUnexempted: srcAudit.findings.length,
          srcExemptionsStale: srcAudit.stale.length,
          srcFloorOk,
        },
        citationMode: CITATION_MODE,
        srcMode: SRC_MODE,
        ciPresent,
        srcDangling: srcAudit.dangling.map((d) => ({ file: d.file, line: d.line, ref: d.ref })),
        srcFindings: srcAudit.findings.map((d) => ({ file: d.file, line: d.line, ref: d.ref })),
        srcExempted: srcAudit.exempted.map((d) => ({ file: d.file, line: d.line, ref: d.ref })),
        srcStaleExemptions: srcAudit.stale,
        broken,
        stale: stale.map((f) => ({ doc: f.doc, docLine: f.docLine, citation: f.citation, symbol: f.symbol ?? null, detail: f.detail })),
        unresolved: unresolved.map((f) => ({ doc: f.doc, docLine: f.docLine, citation: f.citation, detail: f.detail })),
      },
      null,
      2,
    ),
  );
  process.exit(jsonFail ? 1 : 0);
}

console.log("check-docs.mjs — documentation reference guard");
console.log(`  docs scanned:            ${DOCS.join(", ")}`);
console.log(`  pnpm <script> refs:      ${pnpmChecked} checked against package.json (${scripts.size} scripts)`);
console.log(`  scripts/<path> refs:     ${scriptsChecked} checked against the filesystem`);
console.log(`  src/<file> refs:         ${srcChecked} checked against the filesystem`);
console.log(
  ciPresent
    ? `  ci run refs:             ${ciPnpm + ciNode} checked in ${CI_WORKFLOW} (pnpm ${ciPnpm}, node scripts ${ciNode})`
    : `  ci run refs:             ${CI_WORKFLOW} not present — no run lines to scan`,
);
console.log(
  `  source comment refs:     ${srcScriptsTotal + srcAudit.pnpmRefs} checked in ${srcFiles.length} source files ` +
    `(scripts ${srcAudit.scriptRefs}, globs ${srcAudit.globRefs}, pnpm ${srcAudit.pnpmRefs}); ` +
    `${srcAudit.dangling.length} dangling → ${srcAudit.findings.length} unexempted (${srcAudit.exempted.length} with a recorded reason), ` +
    `${srcAudit.stale.length} stale exemption(s); floors scripts ${srcScriptsTotal}>=${SRC_SCRIPT_FLOOR} / pnpm ${srcAudit.pnpmRefs}>=${SRC_PNPM_FLOOR} ` +
    `${srcFloorOk ? "OK" : "VIOLATED"} (mode: ${SRC_MODE})`,
);
console.log(
  `  file:line citations:     ${audit.cited} parsed, ${audit.attributed} attributed to a named symbol, ` +
    `${stale.length} stale, ${unresolved.length} unresolved (mode: ${CITATION_MODE})`,
);

if (stale.length || unresolved.length) {
  console.log(
    `\nFILE:LINE CITATION AUDIT (${CITATION_MODE.toUpperCase()}` +
      `${CITATION_MODE === "info" ? " — non-failing this round" : ""})`,
  );
  for (const f of stale) {
    console.log(
      `  STALE   ${f.doc}:${f.docLine}  \`${f.citation}\`` +
        `${f.symbol ? ` → ${f.symbol}` : " → (no symbol named beside it)"}\n          ${f.detail}`,
    );
  }
  for (const f of unresolved) {
    console.log(`  UNSURE  ${f.doc}:${f.docLine}  \`${f.citation}\`\n          ${f.detail}`);
  }
  if (CITATION_MODE === "info") {
    console.log(
      "\n  INFO on purpose: the docs line is rewriting this text in parallel right now, and a hard\n" +
        "  failure over citations nobody has had a chance to fix would break THEIR gate. The list\n" +
        "  above is the input that line needs.\n" +
        "  Promote it once STALE is empty — either form works, the second is permanent:\n" +
        "    node scripts/check-docs.mjs --citations=fail\n" +
        '    edit scripts/check-docs.mjs:  let CITATION_MODE = "info"  ->  "fail"' +
        "  (then `pnpm check` fails on a stale citation)\n" +
        "  A stale citation is not a style note: following it lands the reader in the middle of an\n" +
        "  unrelated function, which is how a doc stops being trustworthy one merge at a time.",
    );
  }
}

// The check-6 counterpart of the citation INFO block above: in `--src=info` the
// same findings are printed and pass, and the block says which command restores
// enforcement — never a silent swallow.
if (SRC_MODE === "info" && (srcAudit.findings.length || srcAudit.stale.length || !srcFloorOk)) {
  console.log("\nSOURCE COMMENT REFERENCES (INFO — non-failing this run; `--src=fail` restores enforcement):");
  for (const d of srcAudit.findings) console.log(`  DANGLING  ${d.file}:${d.line}  \`${d.ref}\``);
  for (const key of srcAudit.stale) console.log(`  STALE EXEMPTION  ${key}`);
  if (!srcFloorOk) console.log(`  FLOOR VIOLATED  ${srcFloorMsg}`);
}

if (broken.length) {
  console.log(`\nBROKEN REFERENCES (${broken.length}):`);
  for (const b of broken) console.log(`  - ${b}`);
  console.log("\nFAIL");
  process.exit(1);
}

if (stale.length && CITATION_MODE === "fail") {
  console.log(`\nFAIL: ${stale.length} stale file:line citation(s) (see the audit above)`);
  process.exit(1);
}

console.log(
  "\nOK: every pnpm script / scripts path / src path named in the docs resolves, " +
    "and so does every reference made in a source comment",
);

