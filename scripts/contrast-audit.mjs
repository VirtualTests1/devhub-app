// Contrast audit for the two shipped themes (r24-R3-2).
//
// Reads the tokens out of src/index.css rather than a hard-coded copy: a palette
// change must move the audit with it. Arithmetic comes from src/lib/contrast.ts,
// which is independently checked against known ratios in tests/contrast.test.ts.
//
// Exit contract, same as every checker here: 0 = no FAIL, 1 = a pair below its
// threshold, 2 = usage error (unknown flag / unreadable CSS).
//
//   node --experimental-strip-types --import ./tests/helpers/register.mjs \
//     scripts/contrast-audit.mjs [--json]
import { readFileSync } from "node:fs";
import { contrastRatio, formatRatio, parseColor, AA_NON_TEXT, AA_TEXT } from "../src/lib/contrast.ts";

const argv = process.argv.slice(2);
const KNOWN = new Set(["--json", "--help"]);
for (const flag of argv) {
  if (!KNOWN.has(flag)) {
    console.error(`contrast-audit.mjs: unknown argument '${flag}'`);
    console.error("usage: node scripts/contrast-audit.mjs [--json]");
    process.exit(2);
  }
}
if (argv.includes("--help")) {
  console.log("usage: node scripts/contrast-audit.mjs [--json]");
  process.exit(0);
}

const CSS_PATH = "src/index.css";
let css;
try {
  css = readFileSync(CSS_PATH, "utf8");
} catch (error) {
  console.error(`cannot read ${CSS_PATH}: ${error.message}`);
  process.exit(2);
}

/** Strip block comments so a commented-out token cannot enter the map. */
const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

function blockAfter(headerRe) {
  const m = headerRe.exec(clean);
  if (!m) return "";
  const open = clean.indexOf("{", m.index);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === "{") depth += 1;
    else if (clean[i] === "}") {
      depth -= 1;
      if (depth === 0) return clean.slice(open + 1, i);
    }
  }
  return "";
}

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const root = declarations(blockAfter(/:root\s*\{/));
const theme = declarations(blockAfter(/@theme\s*\{/));
const light = declarations(blockAfter(/\[data-theme="light"\]\s*\{/));

/** Resolve `var(--x)` chains against `vars`; returns null when a token is absent. */
function resolve(value, vars, depth = 0) {
  if (depth > 8) return null;
  const m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]+)?\)$/i.exec(value.trim());
  if (!m) return value;
  const next = vars[m[1]];
  return next === undefined ? null : resolve(next, vars, depth + 1);
}

const darkVars = { ...root, ...theme };
const lightVars = { ...root, ...theme, ...light };

/** Text pairs: threshold 4.5 (WCAG 1.4.3 normal text). */
const TEXT_PAIRS = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["card-foreground", "card"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["primary-foreground", "primary"],
  ["success", "background"],
  ["success", "card"],
  ["warning", "background"],
  ["warning", "card"],
  ["danger", "background"],
  ["danger", "card"],
  ["info", "background"],
  ["info", "card"],
];

/** Non-text pairs: threshold 3 (1.4.11 / focus indicator). */
const NON_TEXT_PAIRS = [["ring", "background"]];

/** Reported, never failed: hairlines are decorative, not component boundaries. */
const INFO_PAIRS = [
  ["border", "card"],
  ["border", "background"],
];

function ratioOf(vars, fg, bg) {
  const fgValue = resolve(vars[`--color-${fg}`] ?? "", vars);
  const bgValue = resolve(vars[`--color-${bg}`] ?? "", vars);
  if (fgValue === null || bgValue === null) return null;
  const a = parseColor(fgValue);
  const b = parseColor(bgValue);
  if (!a || !b) return null;
  return contrastRatio(a, b);
}

const rows = [];
let failed = 0;
for (const [themeName, vars] of [
  ["dark", darkVars],
  ["light", lightVars],
]) {
  for (const [fg, bg] of TEXT_PAIRS) {
    const ratio = ratioOf(vars, fg, bg);
    if (ratio === null) {
      rows.push({ theme: themeName, fg, bg, ratio: null, kind: "text", status: "FAIL", why: "token unresolved" });
      failed += 1;
      continue;
    }
    const ok = ratio >= AA_TEXT;
    if (!ok) failed += 1;
    rows.push({ theme: themeName, fg, bg, ratio, kind: "text", status: ok ? "PASS" : "FAIL", why: `>= ${AA_TEXT}` });
  }
  for (const [fg, bg] of NON_TEXT_PAIRS) {
    const ratio = ratioOf(vars, fg, bg);
    const ok = ratio !== null && ratio >= AA_NON_TEXT;
    if (!ok) failed += 1;
    rows.push({
      theme: themeName,
      fg,
      bg,
      ratio,
      kind: "non-text",
      status: ok ? "PASS" : "FAIL",
      why: `>= ${AA_NON_TEXT}`,
    });
  }
  for (const [fg, bg] of INFO_PAIRS) {
    rows.push({
      theme: themeName,
      fg,
      bg,
      ratio: ratioOf(vars, fg, bg),
      kind: "info",
      status: "INFO",
      why: "decorative hairline",
    });
  }
}

if (argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failed === 0, failed, rows }, null, 2));
} else {
  console.log("theme  pair                              ratio     need      status");
  for (const row of rows) {
    const pair = `${row.fg} on ${row.bg}`.padEnd(34);
    const ratio = (row.ratio === null ? "—" : formatRatio(row.ratio)).padStart(9);
    console.log(`${row.theme.padEnd(6)} ${pair} ${ratio}  ${row.why.padEnd(8)}  ${row.status}`);
  }
  console.log(
    failed
      ? `\nFAIL: ${failed} pair(s) below threshold (WCAG 2.2 1.4.3 text / 1.4.11 non-text)`
      : `\nOK: all text pairs >= ${AA_TEXT}, non-text pairs >= ${AA_NON_TEXT} (${rows.length} checks)`,
  );
}
process.exit(failed === 0 ? 0 : 1);
