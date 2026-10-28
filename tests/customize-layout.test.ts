/**
 * `src/store/customize.ts` — import/export round-trip and the reducer actions.
 *
 * The layout file is the only way a look moves between machines, so
 * `normalise()` is the trust boundary: it is fed JSON that another device wrote,
 * and every field it accepts has to be re-checked rather than trusted from disk
 * (the same rule `wall.ts` states for its own stored prefs).
 *
 * The store is imported through a seeded `localStorage` because its initial
 * state is read at module load — see `tests/helpers/storage.ts` for why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";

import { at, atKey } from "./helpers/definite.ts";

installBrowserGlobals();

type Store = typeof import("../src/store/customize.ts");
const loadModule = (seed?: Record<string, string>) =>
  importSeeded<Store>(import.meta.resolve("../src/store/customize.ts"), seed);

const KEY = "devhub.customize.v1";

test("parseLayout: unparseable input is null", async () => {
  const { parseLayout } = await loadModule();
  for (const bad of ["", "{", "not json", '{"a":']) {
    assert.equal(parseLayout(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("parseLayout: parseable-but-meaningless JSON is accepted as a full reset", async () => {
  const { parseLayout } = await loadModule();
  // The gate is `JSON.parse` throwing, nothing else. `null`, a bare number, a
  // string and an array all parse, so `normalise()` sees a non-matching value
  // and hands back every default — which `importLayout` then spreads over the
  // live state. Consequence: importing a file that contains just `null` is a
  // silent 恢复默认, not an error. Pinned here because 设置 → 界面 has no second
  // check between the dialog and the write.
  for (const junk of ["null", "42", '"text"', "[]", "true"]) {
    const out = parseLayout(junk);
    assert.ok(out !== null, `${junk} parses, so it is not rejected`);
    assert.deepEqual(out.overrides, {});
    assert.equal(out.sidebarWidth, 0);
    // r15-correct-8: a file no longer carries 开发者模式 at all, so there is no
    // `false` to assert — the field is absent, which is the stronger statement.
    assert.equal("devMode" in out, false, `${junk} must not decide 开发者模式`);
  }
});

test("parseLayout: an empty object normalises to the documented defaults", async () => {
  const { parseLayout } = await loadModule();
  const out = parseLayout("{}");
  assert.ok(out !== null);
  assert.deepEqual(out.overrides, {});
  assert.equal("devMode" in out, false, "开发者模式 is not part of a layout file");
  assert.equal(out.sidebarCollapsed, false);
  assert.equal(out.sidebarWidth, 0);
  assert.deepEqual(out.frequentEntries, []);
  assert.equal(out.settingsEntry, "footer");
});

function mustParse<T>(out: T | null, what: string): T {
  assert.ok(out !== null, `parseLayout must accept ${what}, and it returned null`);
  return out;
}

test("parseLayout: the round-9 rename of the 常用 field is still honoured", async () => {
  const { parseLayout } = await loadModule();
  // The old key has to keep working or an existing arrangement is silently
  // discarded the day someone re-imports a pre-rename export.
  const legacy = mustParse(
    parseLayout(JSON.stringify({ frequentRepos: ["a", "b"] })),
    "the legacy frequentRepos key",
  );
  assert.deepEqual(legacy.frequentEntries, ["a", "b"]);

  // And the new key wins when both are present — an export written by a current
  // build must not be overridden by a stale field left in the same file.
  const both = mustParse(
    parseLayout(JSON.stringify({ frequentRepos: ["old"], frequentEntries: ["new"] })),
    "both keys present",
  );
  assert.deepEqual(both.frequentEntries, ["new"]);
});

test("parseLayout: junk inside the 常用 list is filtered, not trusted", async () => {
  const { parseLayout } = await loadModule();
  const out = mustParse(
    parseLayout(JSON.stringify({ frequentEntries: ["ok", 1, null, {}, true, "ok2"] })),
    "a 常用 list with junk entries",
  );
  assert.deepEqual(out.frequentEntries, ["ok", "ok2"]);
});

test("parseLayout: an enum field only accepts its own values", async () => {
  const { parseLayout } = await loadModule();
  assert.equal(
    mustParse(parseLayout(JSON.stringify({ settingsEntry: "titlebar" })), "a known settingsEntry")
      .settingsEntry,
    "titlebar",
  );
  assert.equal(
    mustParse(
      parseLayout(JSON.stringify({ settingsEntry: "sidebar" })),
      "an unknown settingsEntry",
    ).settingsEntry,
    "footer",
    "an unknown 设置入口 falls back rather than rendering nothing",
  );
});

test("parseLayout: usage statistics and resultClick are deliberately not imported", async () => {
  const { parseLayout } = await loadModule();
  // Documented intent ("Import deliberately does not bring another machine's
  // usage counts along") plus one consequence worth seeing written down:
  // `resultClick` is normalised internally but is not in the returned slice, so
  // an imported file cannot change it either.
  const out = mustParse(
    parseLayout(
      JSON.stringify({ usage: { "repo:a": { count: 9, last: 1 } }, resultClick: "browser" }),
    ),
    "a file carrying usage and resultClick",
  );
  assert.equal("usage" in out, false);
  assert.equal("resultClick" in out, false);
});

test("exportLayout → parseLayout preserves everything the exporter writes", async () => {
  const { exportLayout, parseLayout } = await loadModule();
  const c = {
    overrides: { titlebar: { hidden: true }, "view-container": { size: "wide", order: 2 } },
    devMode: true,
    sidebarCollapsed: true,
    sidebarWidth: 244,
    resultClick: "readme",
    usage: {},
    frequentEntries: ["repo:a"],
    settingsEntry: "titlebar",
  };

  const text = exportLayout(c as never);
  const round = mustParse(parseLayout(text), "the export round trip");
  assert.deepEqual(round.overrides, c.overrides);
  assert.equal(round.sidebarCollapsed, true);
  assert.equal(round.sidebarWidth, 244);
  assert.deepEqual(round.frequentEntries, ["repo:a"]);
  assert.equal(round.settingsEntry, "titlebar");

  // r15-correct-8: everything the exporter writes survives, and exactly one
  // thing it used to write no longer does. 开发者模式 is a statement about this
  // machine, not part of a look.
  assert.equal("devMode" in JSON.parse(text), false, "the file must not carry 开发者模式");
  assert.equal("devMode" in round, false, "and the import must not invent it");
});

test("the store reads its initial state from storage, defaults when absent", async () => {
  const fresh = await loadModule();
  assert.deepEqual(fresh.useCustomize.getState().overrides, {});
  assert.equal(fresh.useCustomize.getState().sidebarWidth, 0);

  const seeded = await loadModule({ [KEY]: JSON.stringify({ devMode: true, sidebarWidth: 200 }) });
  assert.equal(seeded.useCustomize.getState().devMode, true);
  assert.equal(seeded.useCustomize.getState().sidebarWidth, 200);

  // Corrupt JSON must not take the app down at import — the try/catch in
  // `load()` is the only thing between a hand-edited key and a blank page.
  const broken = await loadModule({ [KEY]: "{\"devMode\":" });
  assert.equal(broken.useCustomize.getState().devMode, false);
});

test("setOverride writes, merges, and deletes the key once nothing is left", async () => {
  const { useCustomize } = await loadModule();
  const s = useCustomize.getState();

  s.setOverride("titlebar", { hidden: true });
  assert.deepEqual(useCustomize.getState().overrides.titlebar, { hidden: true });

  useCustomize.getState().setOverride("titlebar", { order: 2 });
  assert.deepEqual(useCustomize.getState().overrides.titlebar, { hidden: true, order: 2 });

  // Undoing the last field must remove the entry, not leave `{hidden:false}`
  // behind — that residue is what makes 设置 → 界面 list blocks the user never
  // changed.
  useCustomize.getState().resetElement("titlebar");
  assert.equal("titlebar" in useCustomize.getState().overrides, false);
});

test("setCss treats whitespace-only CSS as no CSS", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().setCss("titlebar", "   ");
  assert.equal("titlebar" in useCustomize.getState().overrides, false);
  useCustomize.getState().setCss("titlebar", "color: red;");
  assert.equal(atKey(useCustomize.getState().overrides, "titlebar").css, "color: red;");
  useCustomize.getState().setCss("titlebar", undefined);
  assert.equal("titlebar" in useCustomize.getState().overrides, false);
});

test("every mutation is persisted, including the reset", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().setSidebarWidth(300);
  // Writes are coalesced (r15-correct-9): a drag burst becomes one localStorage
  // write 250 ms later, so `flushStorage` is the commit hook the assertions below
  // need — without it they would read an empty key, which is not the same as the
  // store forgetting to persist.
  flushStorage();
  const raw = readBack(KEY);
  assert.ok(raw !== null, "an action that only lives in memory is the G5 bug");
  assert.equal(JSON.parse(raw).sidebarWidth, 300);

  useCustomize.getState().resetAll();
  flushStorage();
  const afterReset = mustParse(readBack(KEY), "resetAll must write the key back");
  assert.equal(JSON.parse(afterReset).sidebarWidth, 0);
});

test("importLayout keeps the fields the parsed file does not cover", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().recordUsage("repo:kept");
  const before = atKey(useCustomize.getState().usage, "repo:kept").count;
  useCustomize.getState().importLayout({ devMode: true, overrides: { titlebar: { hidden: true } } });
  const s = useCustomize.getState();
  // r15-correct-8: this used to be `assert.equal(s.devMode, true)`. An import —
  // whatever entry point feeds it — must not be able to switch on click-to-edit,
  // because the user then edits believing that mode was always theirs.
  assert.equal(s.devMode, false, "导入不会开启开发者模式");
  assert.deepEqual(s.overrides, { titlebar: { hidden: true } });
  assert.equal(atKey(s.usage, "repo:kept").count, before, "usage is this device's own history");
});

test("addFrequentEntry is idempotent; setFrequentEntries replaces wholesale", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().addFrequentEntry("a");
  useCustomize.getState().addFrequentEntry("a");
  assert.deepEqual(useCustomize.getState().frequentEntries, ["a"]);
  useCustomize.getState().addFrequentEntry("b");
  assert.deepEqual(useCustomize.getState().frequentEntries, ["a", "b"], "append order is display order");
  useCustomize.getState().setFrequentEntries(["c"]);
  assert.deepEqual(useCustomize.getState().frequentEntries, ["c"]);
  useCustomize.getState().removeFrequentEntry("c");
  assert.deepEqual(useCustomize.getState().frequentEntries, []);
});

test("recordUsage counts up and the table is capped, not unbounded", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().recordUsage("k");
  useCustomize.getState().recordUsage("k");
  assert.equal(atKey(useCustomize.getState().usage, "k").count, 2, "count accumulates");
  assert.ok(atKey(useCustomize.getState().usage, "k").last > 0, "last is stamped");

  // The cap is MAX_USAGE_KEYS = 200. Only the cap is asserted: *which* keys
  // survive is decided by sorting on `Date.now()`, and a 210-action loop can
  // straddle a millisecond boundary, so any tighter assertion here would be a
  // flaky test rather than a description of the behaviour.
  for (let i = 0; i < 210; i += 1) useCustomize.getState().recordUsage(`key-${i}`);
  assert.equal(Object.keys(useCustomize.getState().usage).length, 200);

  useCustomize.getState().clearUsage();
  assert.deepEqual(useCustomize.getState().usage, {});
});

test("elementsWithChanges / pinnedElements read the registry, not the overrides", async () => {
  const { useCustomize, elementsWithChanges, pinnedElements } = await loadModule();
  useCustomize.getState().setOverride("titlebar", { hidden: true });
  const changed = elementsWithChanges(useCustomize.getState());
  assert.deepEqual(changed.map((e) => e.id), ["titlebar"]);
  assert.equal(at(changed, 0).label, "标题栏", "the registry entry, not the id, is what 设置 renders");

  // An id that is not in the registry can never be rendered, so it must not
  // appear in 常用 either — `pinnedElements` walks ELEMENTS, not the override keys.
  useCustomize.getState().setOverride("not-a-real-element", { pinned: true });
  assert.deepEqual(pinnedElements(useCustomize.getState()), []);

  useCustomize.getState().setOverride("projects-toolbar", { pinned: true });
  assert.deepEqual(pinnedElements(useCustomize.getState()).map((e) => e.id), ["projects-toolbar"]);
});

test("pinnedElements 只吃 overrides——窄参数是它能被窄订阅的前提（r16-o2-4）", async () => {
  const { useCustomize, pinnedElements } = await loadModule();
  useCustomize.getState().setOverride("projects-toolbar", { pinned: true });
  const { overrides } = useCustomize.getState();
  // 传一个只有 overrides 的普通对象——签名是 Pick，函数读不到也读不着别的字段。
  // 额外塞一条 frequentEntries 进去（经变量绕过对象字面量的多余属性检查）：如果
  // 哪天有人给它加了「顺便看一眼常用列表」的逻辑，这条断言会先红。
  const poisoned = { overrides, frequentEntries: ["repo:x"] };
  assert.deepEqual(pinnedElements(poisoned).map((e) => e.id), ["projects-toolbar"]);
});

// --- free-layout rect contract (审计 G11) ----------------------------------

test("clampLayout: floors, ceilings, rounding and non-finite input", async () => {
  const { clampLayout, LAYOUT_MIN_W, LAYOUT_MIN_H } = await loadModule();
  // The floors are the gesture's (resize never went below them either); before
  // the clamp the number inputs stored these negatives and the stylesheet
  // builder silently dropped them.
  assert.deepEqual(clampLayout({ x: 0, y: 0, w: -5, h: 0 }), {
    x: 0,
    y: 0,
    w: LAYOUT_MIN_W,
    h: LAYOUT_MIN_H,
  });
  assert.deepEqual(clampLayout({ x: 9e9, y: -9e9, w: 1e9, h: 1e9 }), {
    x: 4096,
    y: -4096,
    w: 8192,
    h: 8192,
  });
  assert.deepEqual(clampLayout({ x: 10.4, y: -10.6, w: 100.2, h: 50.5 }), {
    x: 10,
    y: -11,
    w: 100,
    h: 51,
  });
  assert.deepEqual(clampLayout({ x: NaN, y: Infinity, w: NaN, h: Infinity }), {
    x: 0,
    y: 0,
    w: LAYOUT_MIN_W,
    h: LAYOUT_MIN_H,
  });
});

test("setLayout clamps: the store never holds a rect the stylesheet would drop", async () => {
  const { useCustomize, buildStyleSheet } = await loadModule();
  useCustomize.getState().setLayout("records-list", { x: 5, y: -3, w: -10, h: 0 });
  const l = useCustomize.getState().overrides["records-list"]?.layout;
  assert.deepEqual(l, { x: 5, y: -3, w: 40, h: 20 });

  // And the generated sheet now *shows* the size instead of quietly omitting
  // the declarations — that silent drop was the other half of the bug.
  const css = buildStyleSheet({
    overrides: useCustomize.getState().overrides,
    sidebarWidth: 0,
  });
  assert.match(css, /data-reg-id="records-list"[^{]*\{[^}]*width: 40px/);
  assert.match(css, /data-reg-id="records-list"[^{]*\{[^}]*height: 20px/);
});

test("parseLayout: imported layout rects are clamped at the trust boundary", async () => {
  const { parseLayout } = await loadModule();
  const out = mustParse(
    parseLayout(
      JSON.stringify({
        overrides: { "records-list": { layout: { x: 9e9, y: 1.4, w: -5, h: 20000 } } },
      }),
    ),
    "a file carrying an out-of-range layout rect",
  );
  assert.deepEqual(out.overrides?.["records-list"]?.layout, { x: 4096, y: 1, w: 40, h: 8192 });
});
