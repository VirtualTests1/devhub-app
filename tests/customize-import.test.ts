/**
 * `src/store/customize.ts` — the import/restore trust boundary, all of it.
 *
 * `normalise()` is the single gate every untrusted layout JSON passes through
 * (an imported file, and this machine's own hand-editable `localStorage` key).
 * It clamped `layout` and nothing else, because a bad rect is the failure that
 * shows up on screen. The rest failed silently (r15-correct-8):
 *
 *   - `order` went into the generated stylesheet as `order: ${o.order};`, so a
 *     file (or a stored key) holding a string wrote arbitrary CSS declarations
 *     into the app's own sheet — the one place disk reaches the CSS parser;
 *   - `usage` was taken as-is, so `prev.count + 1` over a stored `"9"` produced
 *     `"91"`, over `null` produced NaN, and a `last` that was not a number broke
 *     the `b[1] - a[1]` sort that trims the table to 200 keys;
 *   - `devMode` travelled in the export and was applied on import, so loading
 *     somebody else's file switched on click-to-edit on this machine.
 *
 * The rule is the one `settings-xfer` and `wall-xfer` already follow: known
 * fields are coerced to their declared type or dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";

import { atKey } from "./helpers/definite.ts";

installBrowserGlobals();

type Store = typeof import("../src/store/customize.ts");
const loadModule = (seed?: Record<string, string>) =>
  importSeeded<Store>(import.meta.resolve("../src/store/customize.ts"), seed);

const KEY = "devhub.customize.v1";

// ---------------------------------------------------------------------------
// order: the field that reached the CSS parser
// ---------------------------------------------------------------------------

test("coerceOrder: only a finite integer, and 0 / negatives stay real positions", async () => {
  const { coerceOrder } = await loadModule();
  assert.equal(coerceOrder(0), 0, "0 is a position, not an absence");
  assert.equal(coerceOrder(-3), -3);
  assert.equal(coerceOrder(2.6), 3, "rounded, because `order` is an integer property");
  assert.equal(coerceOrder(1e9), 1000, "a fat-fingered exponent is clamped, not honoured");
  for (const junk of [undefined, null, NaN, Infinity, "3", "1; color: red", true, {}, []]) {
    assert.equal(coerceOrder(junk), undefined, `${JSON.stringify(junk)} is not an order`);
  }
});

test("a hostile `order` writes no declaration into the generated stylesheet", async () => {
  const { buildStyleSheet } = await loadModule();
  const injected = "1; position: fixed; inset: 0; background: #000";
  const css = buildStyleSheet({
    overrides: { titlebar: { order: injected as unknown as number } },
    sidebarWidth: 0,
  });
  assert.equal(css, "", "the generator refuses the value outright rather than interpolating it");
  assert.doesNotMatch(css, /position: fixed/, "no arbitrary declaration reaches the sheet");
  assert.doesNotMatch(css, /order:/);

  // And a legitimate one still works, so this is not a blanket disable.
  const ok = buildStyleSheet({ overrides: { titlebar: { order: 4 } }, sidebarWidth: 0 });
  assert.match(ok, /order: 4;/);
});

test("an imported hostile `order` is dropped at the gate, not at the render", async () => {
  const { parseLayout } = await loadModule();
  const out = parseLayout(
    JSON.stringify({ overrides: { titlebar: { order: "1; color: red" }, add: { order: 2 } } }),
  );
  assert.ok(out !== null);
  assert.equal(out.overrides?.titlebar, undefined, "an entry whose only field is junk disappears");
  assert.deepEqual(out.overrides?.add, { order: 2 }, "the good entry is untouched");
});

// ---------------------------------------------------------------------------
// the rest of the override fields
// ---------------------------------------------------------------------------

test("coerceOverride: booleans are booleans, tiers are known tiers, rects are clamped", async () => {
  const { coerceOverride } = await loadModule();
  assert.deepEqual(coerceOverride("titlebar", { hidden: "false" }), {}, "a string is not a switch");
  assert.deepEqual(coerceOverride("titlebar", { hidden: true }), { hidden: true });
  assert.deepEqual(coerceOverride("titlebar", { pinned: false }), { pinned: false }, "false is a real value");

  // `view-container` declares narrow/md/wide/full; an id it does not know would
  // produce no tier at all, so it is dropped the way wall.ts drops a dead sort id.
  assert.deepEqual(coerceOverride("view-container", { size: "wide" }), { size: "wide" });
  assert.deepEqual(coerceOverride("view-container", { size: "enormous" }), {});
  assert.deepEqual(coerceOverride("view-container", { size: 3 }), {});

  assert.deepEqual(coerceOverride("records-list", { layout: { x: 9e9, y: 0, w: 10, h: 10 } }), {
    layout: { x: 4096, y: 0, w: 40, h: 20 },
  });

  for (const junk of [null, undefined, 5, "x", [], true]) {
    assert.deepEqual(coerceOverride("titlebar", junk), {}, `${String(junk)} is not an override`);
  }
});

test("coerceOverrides drops the entries that coerce to nothing", async () => {
  const { coerceOverrides } = await loadModule();
  assert.deepEqual(
    coerceOverrides({
      titlebar: { hidden: "yes" },
      "view-panel": { hidden: true },
      bogus: 42,
    }),
    { "view-panel": { hidden: true } },
  );
  assert.deepEqual(coerceOverrides("not an object"), {});
  assert.deepEqual(coerceOverrides(null), {});
  assert.deepEqual(coerceOverrides([1, 2]), {}, "an array is not a map of overrides");
});

// ---------------------------------------------------------------------------
// usage: the table arithmetic runs on
// ---------------------------------------------------------------------------

test("coerceUsage keeps only rows that can be counted and sorted", async () => {
  const { coerceUsage } = await loadModule();
  assert.deepEqual(coerceUsage({ "repo:a": { count: 9, last: 123 } }), {
    "repo:a": { count: 9, last: 123 },
  });
  assert.deepEqual(coerceUsage({ "repo:a": { count: "9", last: 1 } }), {}, "a string count is dropped");
  assert.deepEqual(coerceUsage({ "repo:a": { count: null, last: 1 } }), {});
  assert.deepEqual(coerceUsage({ "repo:a": { count: 1, last: "yesterday" } }), {}, "an unsortable `last` is dropped");
  assert.deepEqual(coerceUsage({ "repo:a": { count: -2, last: 1 } }), {}, "a negative count is not a count");
  assert.deepEqual(coerceUsage({ "repo:a": "9" }), {}, "a bare number is not a usage row");
  assert.deepEqual(coerceUsage(null), {});
  assert.deepEqual(coerceUsage([]), {});

  const counted = coerceUsage({ "repo:a": { count: 2.9, last: 1 } });
  assert.equal(atKey(counted, "repo:a").count, 2, "counts are integers");
});

test("the usage table is trimmed at the gate, so an import cannot grow it without bound", async () => {
  const { coerceUsage } = await loadModule();
  const big: Record<string, { count: number; last: number }> = {};
  for (let i = 0; i < 500; i += 1) big[`k${i}`] = { count: 1, last: i };
  const out = coerceUsage(big);
  assert.equal(Object.keys(out).length, 200);
  assert.equal(atKey(out, "k499").count, 1, "the newest keys are the ones kept");
  assert.equal("k0" in out, false, "and the oldest are dropped");
});

test("a stored usage row that is junk no longer poisons the counter", async () => {
  // The concrete regression: `prev.count + 1` over a hand-edited `"9"` produced
  // the string `"91"`, and over anything non-numeric produced NaN — both then
  // persisted again, so the key never recovered.
  const seeded = await loadModule({
    [KEY]: JSON.stringify({ usage: { "repo:a": { count: "9", last: 1 }, "repo:b": { count: 3, last: 2 } } }),
  });
  const s = seeded.useCustomize.getState();
  assert.deepEqual(Object.keys(s.usage), ["repo:b"], "the junk row is dropped on load");

  s.recordUsage("repo:a");
  assert.equal(atKey(seeded.useCustomize.getState().usage, "repo:a").count, 1, "and the key restarts cleanly");

  seeded.useCustomize.getState().recordUsage("repo:b");
  const b = atKey(seeded.useCustomize.getState().usage, "repo:b");
  assert.equal(b.count, 4, "a valid row still accumulates");
  assert.ok(b.last > 0);
});

test("a hostile usage table cannot break the trim sort", async () => {
  // `last: "x"` used to survive into the table, after which `b[1] - a[1]` is NaN,
  // the sort compares nothing, and an arbitrary 200 keys were kept.
  const seeded = await loadModule({
    [KEY]: JSON.stringify({ usage: { "a": { count: 1, last: "x" }, "b": { count: 1, last: 5 } } }),
  });
  assert.deepEqual(Object.keys(seeded.useCustomize.getState().usage), ["b"]);
  for (let i = 0; i < 205; i += 1) seeded.useCustomize.getState().recordUsage(`k${i}`);
  const u = seeded.useCustomize.getState().usage;
  assert.equal(Object.keys(u).length, 200, "the cap still holds");
  for (const v of Object.values(u)) {
    assert.equal(Number.isInteger(v.count), true, "every count is an integer");
    assert.equal(Number.isFinite(v.last), true, "every last is a number");
  }
});

// ---------------------------------------------------------------------------
// devMode / usage never travel through a file
// ---------------------------------------------------------------------------

test("exportLayout omits devMode, and parseLayout cannot supply it", async () => {
  const { exportLayout, parseLayout } = await loadModule();
  const c = {
    overrides: {},
    devMode: true,
    sidebarCollapsed: false,
    sidebarWidth: 0,
    resultClick: "fill" as const,
    usage: {},
    frequentEntries: [] as string[],
    settingsEntry: "footer" as const,
  };

  const text = exportLayout(c);
  assert.equal("devMode" in JSON.parse(text), false, "开发者模式 is not part of a look");
  const parsed = parseLayout(text);
  assert.ok(parsed !== null);
  assert.equal("devMode" in parsed, false);
  assert.equal("usage" in parsed, false, "统计是这台设备自己的历史");
});

test("importLayout ignores devMode and usage even when a caller passes them", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().recordUsage("repo:mine");
  const before = atKey(useCustomize.getState().usage, "repo:mine").count;

  useCustomize.getState().importLayout({
    devMode: true,
    usage: { "repo:theirs": { count: 999, last: 1 } },
    overrides: { titlebar: { hidden: "no" as unknown as boolean, order: 1 } },
  });
  const s = useCustomize.getState();
  assert.equal(s.devMode, false, "importing a file must not turn on click-to-edit");
  assert.equal(s.usage["repo:theirs"], undefined, "nor import another machine's counts");
  assert.equal(atKey(s.usage, "repo:mine").count, before, "and this device's own history survives");
  assert.deepEqual(s.overrides, { titlebar: { order: 1 } }, "the good field still lands");
});

test("the local storage key keeps its own devMode — only a file is refused", async () => {
  // The distinction matters: 开发者模式 is a real local switch, persisted so it
  // survives a restart. What the fix removes is a *file* setting it.
  const seeded = await loadModule({ [KEY]: JSON.stringify({ devMode: true, sidebarWidth: 240 }) });
  assert.equal(seeded.useCustomize.getState().devMode, true);
  assert.equal(seeded.useCustomize.getState().sidebarWidth, 240);
});

test("a hand-edited sidebarWidth is coerced rather than trusted", async () => {
  const { buildStyleSheet } = await loadModule();
  const seeded = await loadModule({ [KEY]: JSON.stringify({ sidebarWidth: -600 }) });
  assert.equal(seeded.useCustomize.getState().sidebarWidth, 0, "a negative rail width is not a width");

  seeded.useCustomize.getState().setSidebarWidth(300);
  flushStorage();
  const raw = readBack(KEY);
  assert.ok(raw !== null, "and the store still writes its own value back");
  assert.equal(JSON.parse(raw).sidebarWidth, 300);
  assert.match(buildStyleSheet({ overrides: {}, sidebarWidth: 300 }), /width: 300px/);
});
