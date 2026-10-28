/**
 * `src/store/customize.ts` — the sidebar drag must not hammer localStorage.
 *
 * The bug these pin (r15-correct-9): the drag handle calls `setSidebarWidth` on
 * every `pointermove` (`Sidebar.tsx:183-186`), and `persist()` wrote the whole
 * record synchronously each time — every block override plus up to 200 `usage`
 * keys serialised from scratch, 60 times a second, for a value only the last one
 * of which can ever be read. `src/lib/storage.ts` was written for exactly this
 * storm in `wall.ts` / `appearance.ts`; this store simply never used it.
 *
 * The assertions count real `setItem` calls, by wrapping the helper's fake
 * `Storage` with a counter and delegating — `storage.ts` looks `localStorage` up
 * at flush time, so the wrapper is what runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";

installBrowserGlobals();

type Store = typeof import("../src/store/customize.ts");
const KEY = "devhub.customize.v1";

/** Installs a counting wrapper over the helper's fake `localStorage`. */
function spyOnWrites(): { writes: () => number; keys: () => string[]; restore: () => void } {
  const real = globalThis.localStorage;
  const seen: string[] = [];
  const wrapper: Storage = {
    get length() {
      return real.length;
    },
    key: (i) => real.key(i),
    getItem: (k) => real.getItem(k),
    setItem: (k, v) => {
      seen.push(k);
      real.setItem(k, v);
    },
    removeItem: (k) => real.removeItem(k),
    clear: () => real.clear(),
  };
  (globalThis as { localStorage: Storage }).localStorage = wrapper;
  return {
    writes: () => seen.length,
    keys: () => seen,
    restore: () => {
      (globalThis as { localStorage: Storage }).localStorage = real;
    },
  };
}

/** Fresh module instance against empty storage, so each test starts unarranged. */
const loadModule = (seed?: Record<string, string>) =>
  importSeeded<Store>(import.meta.resolve("../src/store/customize.ts"), seed);

test("a drag burst writes once, not once per pointermove", async () => {
  const spy = spyOnWrites();
  try {
    const { useCustomize } = await loadModule();
    useCustomize.getState().setSidebarWidth(0);
    flushStorage();
    const baseline = spy.writes();

    // One 12 px drag, sampled the way a real gesture fires.
    for (let px = 240; px < 272; px += 1) useCustomize.getState().setSidebarWidth(px);

    assert.equal(spy.writes(), baseline, "nothing is written during the gesture at all");

    flushStorage();
    assert.equal(spy.writes(), baseline + 1, "the whole burst collapses into a single write");
    assert.equal(JSON.parse(readBack(KEY) ?? "{}").sidebarWidth, 271, "and it carries the last value");
  } finally {
    spy.restore();
  }
});

test("coalescing does not lose the arrangement: overrides and usage land too", async () => {
  const spy = spyOnWrites();
  try {
    const { useCustomize } = await loadModule();
    const s = useCustomize.getState();
    for (let i = 0; i < 40; i += 1) {
      s.setOverride("titlebar", { hidden: true });
      s.recordUsage(`repo:r${i}`);
      s.setSidebarWidth(200 + i);
    }
    assert.equal(spy.writes(), 0, "80 mutations, no synchronous write");

    flushStorage();
    assert.equal(spy.writes(), 1, "one trailing flush for the burst");

    const written = JSON.parse(readBack(KEY) ?? "{}");
    assert.equal(written.sidebarWidth, 239, "the final width is what persisted");
    assert.equal(Object.keys(written.usage).length, 40, "and the usage table is complete");
    assert.equal(typeof written.overrides.titlebar, "object", "the block override survived");
  } finally {
    spy.restore();
  }
});

test("a width that is committed with an explicit action is still on disk after a flush", async () => {
  const { useCustomize } = await loadModule();
  useCustomize.getState().setSidebarWidth(317);
  useCustomize.getState().setOverride("titlebar", { hidden: true });
  flushStorage();
  const raw = readBack(KEY);
  assert.ok(raw !== null, "the drag path shares the writer with every other action");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sidebarWidth, 317);
  assert.deepEqual(parsed.overrides.titlebar, { hidden: true });
});

test("the record is never written as a partial: each flush carries the whole state", async () => {
  const spy = spyOnWrites();
  try {
    const { useCustomize } = await loadModule();
    useCustomize.getState().setSidebarWidth(250);
    useCustomize.getState().resetAll();
    flushStorage();
    assert.equal(spy.writes(), 1, "last value per key wins, so the reset is what lands");
    assert.equal(JSON.parse(readBack(KEY) ?? "{}").sidebarWidth, 0);
  } finally {
    spy.restore();
  }
});

test("customize routes through the shared writer, not a direct setItem", async () => {
  // Structural cover for the one thing a burst cannot show in a unit test: that
  // the store asked the coalescing module rather than keeping its own write, so a
  // future `persist` edit cannot quietly go back to synchronous storage.
  const source = (await import("node:fs")).readFileSync("src/store/customize.ts", "utf8");
  assert.match(source, /scheduleStorageWrite\(STORAGE_KEY, JSON\.stringify\(c\)\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\(STORAGE_KEY/);
});
