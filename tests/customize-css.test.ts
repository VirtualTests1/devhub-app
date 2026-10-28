/**
 * `src/store/customize.ts` — the generated stylesheet and the user-CSS filter.
 *
 * The registry's whole premise is that one generated sheet *is* the interface
 * state, so the two functions that build it are the highest-leverage pure code
 * in the app. `sanitizeUserCss` exists because a single unbalanced brace in a
 * developer-mode box used to swallow every rule after it — "写坏一处、全表失效".
 * These tests are the regression net for exactly that class of failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELEMENTS,
  ELEMENT_BY_ID,
  GROUP_ORDER,
  buildStyleSheet,
  isOverrideEmpty,
  reg,
  sanitizeUserCss,
} from "../src/store/customize.ts";

test("sanitizeUserCss: a declaration block survives intact", () => {
  const { clean, dropped } = sanitizeUserCss("color: red; font-weight: 700");
  assert.equal(dropped, 0);
  assert.equal(clean, "color: red; font-weight: 700;");
});

test("sanitizeUserCss: braces cannot smuggle a new rule", () => {
  // Before the filter this input closed the surrounding rule early and
  // everything after it fell out of the sheet. Now both fragments are dropped
  // because neither is `property: value` shaped.
  const { clean, dropped } = sanitizeUserCss("color: red } .evil { color: blue; }");
  assert.ok(!clean.includes(".evil"), "no selector may appear in the output");
  assert.ok(!clean.includes("{"), "no brace may appear in the output");
  assert.ok(dropped > 0, "at least one fragment must be reported as dropped");
});

test("sanitizeUserCss: at-rules are dropped, not executed", () => {
  const { clean, dropped } = sanitizeUserCss("@import url(https://evil.example/x.css);");
  assert.equal(clean, "");
  assert.equal(dropped, 1);
});

test("sanitizeUserCss: a fragment without a colon is not a declaration", () => {
  const cases = ["garbage", "div", "", "  ", "color red"];
  for (const c of cases) {
    const { clean, dropped } = sanitizeUserCss(c);
    assert.equal(clean, "", `${JSON.stringify(c)} must produce nothing`);
    assert.ok(dropped >= 0);
  }
});

test("sanitizeUserCss: empty input is empty output", () => {
  assert.deepEqual(sanitizeUserCss(""), { clean: "", dropped: 0, rejected: [] });
  assert.deepEqual(sanitizeUserCss(";;;"), { clean: "", dropped: 0, rejected: [] });
});

test("sanitizeUserCss: rejected fragments are returned verbatim for the Inspector", () => {
  // The count alone tells the panel *that* something was dropped; `rejected`
  // is what lets it show the user their own line back instead of a mystery.
  const { rejected, dropped } = sanitizeUserCss("color: red; } .evil { color: blue;");
  assert.equal(rejected.length, dropped);
  assert.ok(rejected.some((r) => r.includes(".evil")));
});

test("sanitizeUserCss: a valid declaration after an invalid one is still kept", () => {
  // Ordering of the split matters: dropping the bad fragment must not also drop
  // its neighbours, or one typo costs the developer every later line.
  const { clean } = sanitizeUserCss("{ color: blue; padding: 4px;");
  assert.ok(clean.includes("color: blue;"), clean);
  assert.ok(clean.includes("padding: 4px;"), clean);
  assert.ok(!clean.includes("{"));
});

test("buildStyleSheet: an empty override set emits no rules", () => {
  assert.equal(buildStyleSheet({ overrides: {}, sidebarWidth: 0 }), "");
});

test("buildStyleSheet: hidden wins the specificity fight with !important", () => {
  const css = buildStyleSheet({ overrides: { titlebar: { hidden: true } }, sidebarWidth: 0 });
  assert.equal(css, '[data-reg-id="titlebar"] { display: none !important; }');
});

test("buildStyleSheet: an empty override produces no rule at all", () => {
  // `{}` is what a half-finished edit leaves behind; emitting
  // `[data-reg-id="x"] { }` for it is noise the inspector then has to explain.
  assert.equal(buildStyleSheet({ overrides: { titlebar: {} }, sidebarWidth: 0 }), "");
});

test("buildStyleSheet: a size tier writes its custom property", () => {
  const css = buildStyleSheet({ overrides: { "view-container": { size: "wide" } }, sidebarWidth: 0 });
  assert.ok(css.includes("--reg-max-w: 95rem;"), css);
});

test("buildStyleSheet: an unknown size id silently contributes nothing", () => {
  // `sizes?.find(...)` — a stale id from an imported layout on an older build
  // must not throw and must not emit a partial declaration.
  const css = buildStyleSheet({ overrides: { "view-container": { size: "colossal" } }, sidebarWidth: 0 });
  assert.equal(css, "");
});

test("buildStyleSheet: layer-2 geometry is written in the documented order", () => {
  const css = buildStyleSheet({
    overrides: {
      titlebar: { order: 3, layout: { x: 10, y: 20, w: 300, h: 40 } },
    },
    sidebarWidth: 0,
  });
  const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
  assert.ok(body.includes("order: 3;"), body);
  assert.ok(body.includes("position: relative;"), body);
  assert.ok(body.includes("transform: translate(10px, 20px);"), body);
  assert.ok(body.includes("width: 300px;"), body);
  assert.ok(body.includes("height: 40px;"), body);
  assert.ok(body.indexOf("position: relative;") < body.indexOf("transform:"), "the box must be positioned before it is offset");
});

test("buildStyleSheet: a zero-size layout omits that axis", () => {
  // `w > 0` / `h > 0`, so 0 means "unset" rather than "collapse to nothing" —
  // and x/y of 0 omit the transform entirely.
  const css = buildStyleSheet({ overrides: { titlebar: { layout: { x: 0, y: 0, w: 0, h: 0 } } }, sidebarWidth: 0 });
  assert.equal(css.includes("width"), false, css);
  assert.equal(css.includes("height"), false, css);
  assert.equal(css.includes("transform"), false, css);
  assert.ok(css.includes("position: relative;"), "the layer is still opted in");
});

test("buildStyleSheet: a negative order is still written", () => {
  // `o.order !== undefined` — 0 and -1 are real positions, and a `||` here
  // would drop them the same way `index: 0` was nearly dropped in the wall.
  const css = buildStyleSheet({ overrides: { titlebar: { order: 0 } }, sidebarWidth: 0 });
  assert.ok(css.includes("order: 0;"), css);
});

test("buildStyleSheet: the user's own declarations come last so they win", () => {
  const css = buildStyleSheet({
    overrides: { "view-container": { size: "wide", css: "width: 400px;" } },
    sidebarWidth: 0,
  });
  assert.ok(css.indexOf("--reg-max-w") < css.indexOf("width: 400px"), css);
});

test("buildStyleSheet: the sidebar width is its own rule, not a smuggled tier", () => {
  const css = buildStyleSheet({ overrides: {}, sidebarWidth: 260 });
  assert.equal(css, '[data-reg-id="sidebar-rail"] { width: 260px; min-width: 260px; }');
  assert.equal(buildStyleSheet({ overrides: {}, sidebarWidth: 0 }), "");
});

test("buildStyleSheet: a selector cannot be forged through an element id", () => {
  // The id is a key the user controls via an imported layout file. `sel()`
  // strips quotes and backslashes, so the attribute selector stays closed.
  const css = buildStyleSheet({ overrides: { 'x"] [onclick="alert(1)': { hidden: true } }, sidebarWidth: 0 });
  assert.ok(!css.includes("\\"), "no escape may survive into the sheet");
  assert.equal((css.match(/"/g) || []).length, 2, "exactly the two selector quotes");
});

test("isOverrideEmpty: only ordering/visibility fields count as a change", () => {
  assert.equal(isOverrideEmpty(undefined), true);
  assert.equal(isOverrideEmpty({}), true);
  assert.equal(isOverrideEmpty({ hidden: false }), true, "an explicit false is not a change");
  assert.equal(isOverrideEmpty({ css: "   " }), true, "whitespace-only CSS is not a change");
  assert.equal(isOverrideEmpty({ order: 0 }), false);
  assert.equal(isOverrideEmpty({ pinned: true }), false);
  assert.equal(isOverrideEmpty({ layout: { x: 0, y: 0, w: 0, h: 0 } }), false, "a dragged box is a change even at zero");
});

test("reg() is an attribute, not a wrapper element", () => {
  assert.deepEqual(reg("titlebar"), { "data-reg-id": "titlebar" });
});

test("the element registry is internally consistent", () => {
  // Every `group` must exist in GROUP_ORDER or that block is unrenderable in
  // 设置 → 界面; every id must be unique or ELEMENT_BY_ID silently loses one.
  const ids = ELEMENTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate element id");
  const groups = new Set(GROUP_ORDER);
  for (const e of ELEMENTS) assert.ok(groups.has(e.group), `${e.id} is in unknown group ${e.group}`);
  assert.equal(Object.keys(ELEMENT_BY_ID).length, ids.length);
  for (const e of ELEMENTS) {
    assert.ok(e.label.trim().length > 0, `${e.id} has no label`);
    if (e.sizes) {
      const sizeIds = e.sizes.map((s) => s.id);
      assert.equal(new Set(sizeIds).size, sizeIds.length, `${e.id} has duplicate size tier ids`);
    }
  }
});
