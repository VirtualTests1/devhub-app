/**
 * `src/shell/StatusStrip.tsx` — the strip is a row of controls, not one big button.
 *
 * The defect (r15-correct-11): the whole row was a `<div role="button" tabIndex={0}>`
 * that *contained* the 运行中 toggle and the 下载 `<button>`. Anything inside an
 * element with the button role is presentational to assistive technology — the
 * nested controls' names, their `aria-expanded`, and the 停止 / 队列 actions they open
 * were not merely hard to reach, they were absent from the accessibility tree. Two
 * hand-rolled `onKeyDown` handlers re-implemented Enter/Space on top of that, and the
 * row itself was a tab stop competing with its own children for the same keystroke.
 *
 * The restructure keeps both mouse and keyboard behaviour: the row became a
 * `role="group"` (still click-anywhere, now guarded by `hasOwnActivation` so a click
 * on a child cannot also fire the row), the disclosure moved onto a real `<button>`
 * around the 链路 segment, and 运行中 stopped pretending to be a div.
 *
 * Structural pinning again — `.tsx` cannot be mounted under `--experimental-strip-types`
 * (DEVELOPMENT.md §8.1), same shape as `tests/statusstrip-pill-contrast.test.ts` and
 * `tests/repos-seq-guard.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { at } from "./helpers/definite.ts";

const STRIP = "src/shell/StatusStrip.tsx";

/** Code only, line numbers preserved: this house quotes the dead markup in comments. */
function codeOnly(src: string): string[] {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) {
        kept.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const open = line.indexOf("/*");
    if (open >= 0) {
      const close = line.indexOf("*/", open + 2);
      if (close >= 0) line = line.slice(0, open) + line.slice(close + 2);
      else {
        line = line.slice(0, open);
        inBlock = true;
      }
    }
    const slash = line.indexOf("//");
    kept.push(slash >= 0 ? line.slice(0, slash) : line);
  }
  return kept;
}

const lines = codeOnly(readFileSync(STRIP, "utf8"));
const code = lines.join("\n");

/** The tag an attribute block belongs to: nearest `<x` at or before `index`. */
function tagOwning(index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const m = at(lines, i).match(/<(\/?)([a-zA-Z][\w.]*)/);
    if (m) return at(m, 2);
  }
  return "";
}

/** Every line index matching `pattern`, with the element that owns it. */
function ownedBy(pattern: RegExp) {
  const out: { text: string; tag: string; n: number }[] = [];
  lines.forEach((text, i) => {
    if (pattern.test(text)) out.push({ text, tag: tagOwning(i), n: i + 1 });
  });
  return out.map(({ text, tag, n }) => ({ line: text.trim(), tag, n }));
}

test("状态条外层是 group，不是把子控件吞掉的 button", () => {
  assert.doesNotMatch(code, /role="button"/, "a role=button ancestor makes its descendants presentational");
  assert.match(code, /role="group"/, "the row must announce itself as a group of controls");
  // r16-n2-2: the group's name resolves through `lib/i18n.ts` (`strip.ariaGroup`),
  // so the attribute is an expression now — this pins the wiring, and the
  // zh-CN wording of that entry is pinned byte for byte in tests/i18n.test.ts.
  assert.match(code, /aria-label=\{t\("strip\.ariaGroup"\)\}/,
    "and name that group, since a group has no content of its own");
});

test("三个控件都是真 <button>，辅助技术读得到", () => {
  const expanded = ownedBy(/aria-expanded=\{/);
  assert.equal(expanded.length, 2, "链路 opens 环境详情, 运行中 opens 进程列表");
  for (const e of expanded) {
    assert.equal(e.tag, "button", `${e.line} (:${e.n}) must sit on a real <button>, was inside ${e.tag}`);
  }
  for (const id of ["status-seg-link", "status-seg-active", "status-seg-download"]) {
    const hits = ownedBy(new RegExp(`reg\\("${id}"\\)`));
    assert.equal(hits.length, 1, `${id} is rendered once`);
    assert.equal(at(hits, 0).tag, "button", `${id} must be a <button>, not a div/span wearing one`);
  }
});

test("行本身不再是抢 Enter 的第二个焦点停靠，键交回浏览器", () => {
  // The row used to be `tabIndex={0}` + its own `onKeyDown`, next to two children
  // that each hand-rolled the same keys and called `stopPropagation`.
  assert.doesNotMatch(code, /onKeyDown/, "Enter/Space belong to the <button>s now");
  assert.doesNotMatch(code, /e\.key === "Enter"/, "no re-implementation of activation keys left in the strip");
  assert.doesNotMatch(code, /tabIndex=\{0\}/, "the group is not a tab stop; its controls are");
});

test("鼠标契约不变：点行内任意处仍能开合，点子控件不会二次触发", () => {
  assert.match(code, /if \(hasOwnActivation\(e\.target\)\) return/,
    "the row's click-anywhere toggle has to yield to a child's own activation");
  assert.match(code, /import \{[^}]*hasOwnActivation[^}]*\} from "\.\.\/lib\/useDismiss"/,
    "using the shared guard the settings/queue rows use, not a local copy");
  // Each control still stops its own click from reaching the row.
  const stops = lines.filter((l) => /e\.stopPropagation\(\)/.test(l)).length;
  assert.ok(stops >= 3, `链路 / 运行中 / 下载 each guard their click, saw ${stops}`);
});

test("上一轮的非颜色状态线索一条没丢", () => {
  // Colour alone used to be how the strip said "running" / "spinning" / "open";
  // these are the channels that carry the same facts for everyone else.
  const required = [
    /\(open \|\| runOpen\) && "rotate-180"/, // popover open/closed, shape not hue
    /aria-expanded=\{open\}/, // …and the same fact in the a11y tree
    /aria-expanded=\{runOpen\}/,
    /animate-pulse/, // 运行中 breathes
    /animate-spin/, // 下载中 spins
    /role="img"[\s\S]{0,80}p\.state === "suspended" \? t\("strip\.stateSuspended"\) : t\("strip\.stateRunning"\)/, // per-process state named in words (r18-o1-4: zh wording pinned in tests/i18n.test.ts §5h)
    /aria-label=\{t\("strip\.stopAllAria", \{ n: running\.length \}\)\}/, // the count stays in the accessible name (r18-o1-4 wired; wording pinned in §5h)
    // r16-n2-2: the label is `strip.downloadFailed` + `dlFailed` now (zh wording
    // pinned in tests/i18n.test.ts); key and identifier must still be paired here.
    /t\("strip\.downloadFailed", \{ n: dlFailed \}\)/, // the failure count is in the label, not only in red
  ];
  for (const re of required) assert.match(code, re, `lost a non-colour cue: ${re}`);
});
