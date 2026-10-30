// A11Y-NAMES — every `<button>` must have an accessible name.
//
// Why this is a separate checker instead of an ESLint rule: the failure this
// catches is not a lint style, it is a control that a screen reader announces as
// just "button". ESLint's JSX a11y plugin would need a new dependency (this repo
// stays dependency-free in scripts by rule), and the codebase already has one
// shared icon vocabulary (lucide), so the shape worth checking is narrow:
//
//   <button ...><X className="h-4 w-4" /></button>          -> unnamed
//   <button ... aria-label={t("...")}><X /></button>         -> named
//   <button ...>{t("...")}</button>                          -> named
//   <button ...><span>{label}</span></button>                -> named
//
// A name may come from `aria-label`, `aria-labelledby`, `title`, or visible
// content. `title` counts because browsers expose it as the accessible name when
// nothing better exists; it is weaker than aria-label, but flagging it here would
// make this checker red on controls that screen readers do name.
//
// Known limit: this is a text scanner, not a JSX AST. It sees one file at a time
// and cannot resolve a component variable (`{Icon}`) to its rendered content, so
// a variable that is really an icon is treated as content (a false pass). The
// failure mode it exists for — a new icon-only button with no label — is static
// and unmistakable, and every current control was checked by hand in r33-D4-1.
//
// Dependency-free: node:fs, node:path only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

/** Every `.tsx` under `src/`, sorted for stable output. */
function tsxFiles(dir = "src") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out.sort();
}

/** Index just past the `>` that closes the tag starting at `from`, or -1. */
function endOfTag(source, from) {
  let quote = null;
  let braces = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") braces += 1;
    else if (c === "}") braces = Math.max(0, braces - 1);
    else if (c === ">" && braces === 0) {
      // `=>` inside an attribute expression is inside braces, so a bare `>` here
      // really ends the tag.
      return i + 1;
    }
  }
  return -1;
}

/** The attribute text of a start tag, excluding the `<button` prefix. */
function attrsOf(tagText) {
  const body = tagText.replace(/^<button\b/, "");
  return body.endsWith("/>") ? body.slice(0, -2) : body.slice(0, -1);
}

const NAMING_ATTR = /\b(aria-label|aria-labelledby|title)\s*=\s*(?:"[^"]+"|'[^']+'|\{[^}]*\})/;

/** True when an expression container is plausibly rendered text. */
function expressionIsText(inner) {
  const text = inner.trim();
  if (!text) return false;
  // Pure JSX (an icon, a fragment of icons, a conditional between icons) is not
  // text. Anything naming `t(`, a quoted string, a template, or a bare value is.
  const withoutJsx = text.replace(/<[^>]*>/g, "");
  if (withoutJsx.trim() === "") return false;
  // A quoted/template literal, a bare value, a member access, or a call
  // (`t(...)`, `diagAction(t, ...)`, `retentionPhrase(d, t)`) all render text.
  // The last form is why this is a call pattern and not `t\(`: a label helper
  // that takes the translator as an argument is still a label.
  return /['"`]|\w+\s*\(|^[A-Za-z_$][\w$.]*$|\.\w+$/.test(withoutJsx);
}

/** The visible content of a button, judged by whether a screen reader would name it. */
function contentIsText(inner) {
  let text = "";
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === "<") {
      // Skip a nested element, tracking braces/quotes the same way as tags.
      const end = endOfTag(inner, i);
      i = end === -1 ? inner.length : end - 1;
      continue;
    }
    if (c === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < inner.length && depth > 0; j += 1) {
        if (inner[j] === "{") depth += 1;
        else if (inner[j] === "}") depth -= 1;
      }
      const expr = inner.slice(i + 1, j - 1);
      if (expressionIsText(expr)) text += " x ";
      i = j - 1;
      continue;
    }
    text += c;
  }
  return text.replace(/\s+/g, " ").trim() !== "";
}

/**
 * Find `<button>` elements with no accessible name.
 *
 * Exported so `tests/a11y-names.test.ts` can pin the classifier with synthetic
 * sources instead of relying on the repo's current file set.
 */
export function findUnnamedButtons(source, file = "<source>") {
  const out = [];
  let index = 0;
  while ((index = source.indexOf("<button", index)) !== -1) {
    const openEnd = endOfTag(source, index);
    if (openEnd === -1) break;
    const tagText = source.slice(index, openEnd);
    const line = source.slice(0, index).split("\n").length;
    const selfClosing = tagText.trimEnd().endsWith("/>");
    const attrs = attrsOf(tagText);
    // `aria-hidden` is a deliberate "not in the accessibility tree" (the
    // split-button backdrop is the one case here): it needs no name because no
    // assistive technology is meant to reach it.
    if (/\baria-hidden\b/.test(attrs)) {
      index = openEnd;
      continue;
    }
    const named = NAMING_ATTR.test(attrs);
    let unnamed = !named;
    if (!named && !selfClosing) {
      const close = source.indexOf("</button>", openEnd);
      if (close === -1) {
        unnamed = true;
      } else {
        const inner = source.slice(openEnd, close);
        unnamed = !contentIsText(inner);
      }
    }
    if (unnamed) {
      const snippet = tagText.replace(/\s+/g, " ").slice(0, 120);
      out.push({ file, line, snippet });
    }
    index = openEnd;
  }
  return out;
}

function selftest() {
  const cases = [
    [`<button type="button"><X /></button>`, 1],
    [`<button type="button" aria-label={t("close")}><X /></button>`, 0],
    [`<button type="button">{t("open")}</button>`, 0],
    [`<button type="button"><span>{label}</span></button>`, 0],
    [`<button type="button" title="Close"><X /></button>`, 0],
    [`<button type="button" onClick={() => go()}>{n}</button>`, 0],
    [`<button type="button"><Icon /></button>`, 1],
    [`<button type="button" />`, 1],
  ];
  let failed = 0;
  for (const [src, expected] of cases) {
    const got = findUnnamedButtons(src).length;
    if (got !== expected) {
      failed += 1;
      console.error(`selftest FAIL: expected ${expected}, got ${got}: ${src}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`selftest OK: ${cases.length} classifier cases`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
  process.exit(0);
}
if (args.some((a) => a !== "--json")) {
  console.error("check-a11y-names.mjs: only --json and --selftest are accepted");
  process.exit(2);
}

const findings = tsxFiles().flatMap((f) => findUnnamedButtons(readFileSync(f, "utf8"), f));
if (args.includes("--json")) {
  console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
} else {
  for (const f of findings) {
    console.error(`${relative(ROOT, f.file)}:${f.line} unnamed button: ${f.snippet}`);
  }
  console.log(
    findings.length
      ? `FAIL: ${findings.length} <button> element(s) have no accessible name`
      : "OK: every <button> has an accessible name (aria-label/labelledby/title or content)",
  );
}
process.exit(findings.length ? 1 : 0);
