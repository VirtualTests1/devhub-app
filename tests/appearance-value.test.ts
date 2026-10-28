/**
 * `src/store/appearance.ts` — the value describer, the font table, the 模版 store.
 *
 * `describeAppearanceValue` is what makes 记录 say "深浅色：浅色" instead of
 * "theme: light" — 需求 6's complaint verbatim — and it is the only place that
 * knows the mapping, so a field added to `Appearance` without a label here shows
 * the raw id to the user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AMBIENCES,
  APPEARANCE_LABEL,
  SCALE_DENSITIES,
  FALLBACK_FAMILIES,
  FAMILY_DISPLAY,
  FONT_SCALES,
  TEMPLATE_KEYS,
  TYPE_SCALES,
  WEIGHT_CHOICES,
  coerceAppearance,
  describeAppearanceValue,
  familyDisplay,
  resolveTheme,
  sanitizeTemplateValues,
  useAppearance,
} from "../src/store/appearance.ts";
import { SKINS } from "../src/store/ui.ts";

test("describeAppearanceValue: booleans read as 开/关", () => {
  assert.equal(describeAppearanceValue("covers", true), "开");
  assert.equal(describeAppearanceValue("covers", false), "关");
  // The boolean branch runs before the label table, so it wins for any key.
  assert.equal(describeAppearanceValue("showScrollbar", false), "关");
});

test("describeAppearanceValue: the empty font is 系统默认, not a blank cell", () => {
  assert.equal(describeAppearanceValue("fontFamily", ""), "系统默认");
  assert.equal(describeAppearanceValue("fontFamily", null), "系统默认", "null coerces through String(v ?? \"\")");
  assert.equal(describeAppearanceValue("fontFamily", undefined), "系统默认");
  // A named family shows both the Chinese name and the real CSS name, because
  // the value that goes into `font-family` is the latter.
  assert.equal(describeAppearanceValue("fontFamily", "Microsoft YaHei"), "微软雅黑（Microsoft YaHei）");
});

test("describeAppearanceValue: a pixel value carries its unit", () => {
  assert.equal(describeAppearanceValue("uiFontPx", 16), "16 px");
  // No label table for this key, so anything passes through — including the
  // string "16" from a hand-edited localStorage blob.
  assert.equal(describeAppearanceValue("uiFontPx", "16"), "16 px");
});

test("describeAppearanceValue: enum ids become the words the settings UI uses", () => {
  assert.equal(describeAppearanceValue("theme", "light"), "浅色");
  assert.equal(describeAppearanceValue("theme", "dark"), "深色");
  assert.equal(describeAppearanceValue("theme", "system"), "跟随系统");
  assert.equal(describeAppearanceValue("fontScale", "md"), "标准");
  assert.equal(describeAppearanceValue("density", "normal"), "标准");
  assert.equal(describeAppearanceValue("scale", "relaxed"), "舒展");
  assert.equal(describeAppearanceValue("ambience", "static"), "静态");
  assert.equal(describeAppearanceValue("fontWeight", "bold"), "加粗");
  assert.equal(describeAppearanceValue("recordTimeFormat", "hms"), "时分秒");
  // 皮肤 labels come from the skin table, so the two cannot drift apart.
  for (const s of SKINS) assert.equal(describeAppearanceValue("skin", s.id), s.label);
});

test("describeAppearanceValue: 0 columns is 自动, not zero", () => {
  assert.equal(describeAppearanceValue("gridColumns", 0), "自动");
  assert.equal(describeAppearanceValue("gridColumns", 3), "3 列");
});

test("describeAppearanceValue: an unknown value falls back to the raw id", () => {
  // An imported 模版 from a newer build may carry an id this build does not
  // know. Showing "colossal" is worse than showing nothing, but it is what the
  // code does — and it must not throw.
  assert.equal(describeAppearanceValue("fontScale", "colossal"), "colossal");
});

test("describeAppearanceValue: a missing value reads differently per key shape", () => {
  // Two different fallbacks exist and this pins both, because the asymmetry is
  // easy to mistake for a bug while editing: an *unlabelled* key says （无）,
  // while a *labelled* key looks its table up under the string form of the
  // missing value and leaks the literal word into 记录.
  assert.equal(describeAppearanceValue("showRepoPath", undefined), "（无）");
  assert.equal(describeAppearanceValue("hideDesc", null), "（无）");
  assert.equal(describeAppearanceValue("theme", undefined), "undefined");
  assert.equal(describeAppearanceValue("theme", null), "null");
});

test("every Appearance field has a 记录 label, and every default is describable", () => {
  // The invariant that breaks silently: add a field to `Appearance` + `DEFAULTS`
  // and forget `APPEARANCE_LABEL`, and recordChange writes the raw key name.
  // `TEMPLATE_KEYS` is `Object.keys(DEFAULTS)` by construction, so comparing
  // the label set against it covers both tables at once.
  const fields = [...TEMPLATE_KEYS].sort();
  assert.deepEqual(Object.keys(APPEARANCE_LABEL).sort(), fields);

  // A fresh store *is* DEFAULTS (nothing in localStorage), so this walks the
  // real shipped values rather than a copy of them.
  const current = useAppearance.getState();
  for (const key of TEMPLATE_KEYS) {
    const described = describeAppearanceValue(key, current[key]);
    assert.ok(described.length > 0, `${key} describes to nothing`);
    assert.notEqual(described, "undefined", `${key} would show the raw word in 记录`);
  }
  // Spot-check the defaults this report depends on.
  assert.equal(describeAppearanceValue("theme", current.theme), "浅色");
  assert.equal(describeAppearanceValue("showScrollbar", current.showScrollbar), "关");
});

test("the picker tables are unique-id and non-empty", () => {
  for (const table of [FONT_SCALES, WEIGHT_CHOICES, AMBIENCES, TYPE_SCALES, SCALE_DENSITIES, SKINS]) {
    const ids = table.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate id in a picker table");
    for (const t of table) assert.ok(t.label.trim().length > 0, `${t.id} has no label`);
  }
  // The root font size is what 字号档位 actually changes. Spelled out because
  // `find` answers `| undefined`: the old one-liner would have thrown a TypeError
  // instead of a named failure if the `md` scale were ever removed.
  const md = FONT_SCALES.find((f) => f.id === "md");
  assert.ok(md !== undefined, "字号档位 must contain md — 界面字号 depends on it");
  assert.equal(md.rootPx, 16);
});

test("familyDisplay: mapped families localise, everything else is passed through", () => {
  assert.equal(familyDisplay("SimSun"), "宋体");
  assert.equal(familyDisplay("Microsoft JhengHei"), "微軟正黑體");
  assert.equal(familyDisplay("Cascadia Mono"), "Cascadia Mono", "no invented translation for a mono family");
  assert.equal(familyDisplay(""), "");
  for (const f of FALLBACK_FAMILIES) assert.equal(typeof familyDisplay(f), "string");
  assert.ok(FALLBACK_FAMILIES.includes("Microsoft YaHei"), "the 中文 default must be in the offline list");
  // The localisation table is only worth its bytes where the display name
  // differs from the CSS name; a self-mapping entry is dead weight that makes
  // the table look maintained when it is not.
  for (const [css, display] of Object.entries(FAMILY_DISPLAY)) {
    assert.ok(css.length > 0 && display.length > 0, "no empty family name");
    assert.notEqual(css, display, `${css} maps to itself — drop the entry`);
  }
});

test("resolveTheme: an explicit choice beats the OS", () => {
  assert.equal(resolveTheme("dark"), "dark");
  assert.equal(resolveTheme("light"), "light");
});

test("resolveTheme: system follows the media query, and defaults to dark", () => {
  const win = globalThis as { window?: { matchMedia?: (q: string) => { matches: boolean } } };
  const original = win.window;
  try {
    win.window = { matchMedia: () => ({ matches: true }) };
    assert.equal(resolveTheme("system"), "light");
    win.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(resolveTheme("system"), "dark");
    // No `matchMedia` at all must not throw — the `?.` is load-bearing.
    win.window = {};
    assert.equal(resolveTheme("system"), "dark");
  } finally {
    win.window = original;
  }
});

test("sanitizeTemplateValues keeps only known keys — and only valid values", () => {
  const out = sanitizeTemplateValues({
    theme: "light",
    uiFontPx: 15,
    notATemplateField: "x",
    length: 999,
  });
  assert.equal("notATemplateField" in out, false, "an imported blob cannot invent fields");
  assert.equal("length" in out, false, "only the 22 known keys are candidates");
  assert.equal(out.theme, "light");
  assert.equal(out.uiFontPx, 15);
  assert.equal(Object.getPrototypeOf(out) === Object.prototype, true, "the result is a plain object");

  // Round 13 (d4-3): values are validated now. The previous pin said the
  // opposite ("applies it as-is and the CSS simply ignores it") — that was a
  // documented choice, and it was wrong: `load()` checked one field,
  // template import / export restore checked none, so a hand-edited
  // localStorage blob or an imported 模版 could put `theme: "blue"` or
  // `gridColumns: 99` into the store and into `applyAppearance`'s data
  // attributes. Every other persisted store in this repo validates per field.
  // An out-of-enum value is dropped rather than stored: a template written by a
  // newer build lands on this version's default for that field, which is the
  // same thing the CSS would have done with the junk value anyway.
  assert.equal(sanitizeTemplateValues({ theme: "chartreuse" }).theme, undefined);
  assert.equal(sanitizeTemplateValues({ gridColumns: 99 }).gridColumns, undefined);
  assert.equal(sanitizeTemplateValues({ uiFontPx: 8 }).uiFontPx, undefined);
  assert.equal(sanitizeTemplateValues({ covers: "yes" }).covers, undefined);
  assert.equal(sanitizeTemplateValues({ skin: "soft" }).skin, "soft", "a valid value still passes");

  for (const junk of [null, undefined, 0, "", "text", [], 42]) {
    assert.deepEqual(sanitizeTemplateValues(junk), {}, `${String(junk)} must yield nothing`);
  }
});

test("coerceAppearance: a stored blob is validated field by field", () => {
  // No blob at all → the defaults, not a crash and not a partial object.
  assert.equal(coerceAppearance(null).theme, "light");
  // Unparseable text and wrong-shaped JSON degrade to defaults too: a corrupt
  // preference must not cost the user their whole appearance.
  assert.equal(coerceAppearance("{not json").theme, "light");
  assert.equal(coerceAppearance("null").theme, "light");
  assert.equal(coerceAppearance("[]").theme, "light");
  assert.equal(coerceAppearance("42").theme, "light");

  // A valid blob round-trips untouched.
  const good = JSON.stringify({ theme: "dark", skin: "crisp", gridColumns: 3, covers: false });
  const dark = coerceAppearance(good);
  assert.equal(dark.theme, "dark");
  assert.equal(dark.skin, "crisp");
  assert.equal(dark.gridColumns, 3);
  assert.equal(dark.covers, false);

  // Each illegal field falls back to ITS OWN default; the legal fields beside
  // it survive. This is the case the old load() missed: it only re-checked
  // uiFontPx, so `{"theme":"blue"}` used to land in the store verbatim.
  const mixed = coerceAppearance(
    JSON.stringify({ theme: "blue", skin: "neon", gridColumns: 99, uiFontPx: 8, hideDesc: true }),
  );
  assert.equal(mixed.theme, "light", "illegal enum → default");
  assert.equal(mixed.skin, "soft", "illegal enum → default");
  assert.equal(mixed.gridColumns, 0, "out-of-range int → default");
  assert.equal(mixed.hideDesc, true, "the legal field beside them is kept");

  // The one scale-aware fallback that predates this round: a corrupt px under a
  // valid 档位 reads as that 档位's preset, not the global 16.
  const sm = coerceAppearance(JSON.stringify({ fontScale: "sm", uiFontPx: 99 }));
  assert.equal(sm.fontScale, "sm");
  assert.equal(sm.uiFontPx, FONT_SCALES.find((s) => s.id === "sm")?.rootPx);

  // Legacy `font` enum migration still runs, and its result is validated like
  // any other value.
  const legacy = coerceAppearance(JSON.stringify({ font: "yahei" }));
  assert.equal(legacy.fontFamily, "Microsoft YaHei");
  assert.equal("font" in legacy, false, "the legacy key is consumed, not carried");
  const legacyJunk = coerceAppearance(JSON.stringify({ font: "no-such-preset" }));
  assert.equal(legacyJunk.fontFamily, "");
});
