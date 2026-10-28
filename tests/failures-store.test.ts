/**
 * `src/store/failures.ts` — the persisted failure history (r18 N1).
 *
 * The store's whole job is list hygiene under pressure: a failing poll can fire
 * every few seconds, a rejection can carry a novel's worth of text, and every
 * reload reads the JSON an older build wrote. So the tests below exercise the
 * rules the panel depends on — cap, fold, refuse-junk, persist — and the fact
 * that each `record` is on disk before the next render.
 *
 * Time is injected (`record(kind, verb, text, at)`) rather than faked: the fold
 * window is arithmetic, and arithmetic reads better as literals than as timers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";

import { at } from "./helpers/definite.ts";

installBrowserGlobals();

type Failures = typeof import("../src/store/failures.ts");

const KEY = "devhub.failures.v1";
const STORE = import.meta.resolve("../src/store/failures.ts");

/** `readBack` reports "nothing stored" as null; narrowing keeps the failure
 *  message specific to the key that came back empty. */
function nonNull(v: string | null, key: string): string {
  assert.ok(v !== null, `${key} must have been written back`);
  return v;
}

function stored(): ReturnType<Failures["normalizeEntries"]> {
  return JSON.parse(nonNull(readBack(KEY), KEY));
}

const T0 = 1_700_000_000_000;

test("failures: first run is an empty history", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  assert.deepEqual(useFailures.getState().entries, []);
});

test("failures: a recorded failure lands newest-first with count 1, and is on disk", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("command", "保存失败", "后端未返回原因", T0);
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    at: T0,
    kind: "command",
    verb: "保存失败",
    text: "后端未返回原因",
    count: 1,
  });
  assert.deepEqual(stored(), entries, "the history is local-first: disk sees every record");
});

test("failures: same kind+verb+text inside the fold window bumps count instead of a row", async () => {
  const { useFailures, FOLD_MS } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("runtime", "运行失败", "端口被占用", T0);
  useFailures.getState().record("runtime", "运行失败", "端口被占用", T0 + 3_000);
  useFailures.getState().record("runtime", "运行失败", "端口被占用", T0 + FOLD_MS);
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, 1, "three events, one row");
  assert.equal(at(entries, 0).count, 3);
  assert.equal(at(entries, 0).at, T0 + FOLD_MS, "`at` tracks the latest occurrence");
  assert.equal(at(stored(), 0).count, 3, "the folded count is what got persisted");
});

test("failures: one millisecond past the fold window starts a new row", async () => {
  const { useFailures, FOLD_MS } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("runtime", "运行失败", "端口被占用", T0);
  useFailures.getState().record("runtime", "运行失败", "端口被占用", T0 + FOLD_MS + 1);
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, 2, "the window closes exactly at FOLD_MS");
  assert.equal(at(entries, 0).count, 1);
  assert.equal(at(entries, 1).count, 1);
});

test("failures: a backwards clock never folds into a younger head row", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("command", "保存失败", "网络错误", T0);
  useFailures.getState().record("command", "保存失败", "网络错误", T0 - 5_000);
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, 2, "arrival order wins when the clock disagrees");
  assert.equal(at(entries, 0).at, T0 - 5_000);
});

test("failures: kind, verb or text differing means a separate row", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("command", "保存失败", "网络错误", T0);
  useFailures.getState().record("runtime", "保存失败", "网络错误", T0);
  useFailures.getState().record("command", "运行失败", "网络错误", T0);
  useFailures.getState().record("command", "保存失败", "磁盘已满", T0);
  assert.equal(useFailures.getState().entries.length, 4);
});

test("failures: the list is capped at 50, oldest falling off", async () => {
  const { useFailures, FAILURE_CAP } = await importSeeded<Failures>(STORE);
  for (let i = 0; i < FAILURE_CAP + 5; i += 1) {
    useFailures.getState().record("command", "保存失败", `错误 ${i}`, T0 + i * 60_000);
  }
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, FAILURE_CAP);
  assert.equal(at(entries, 0).text, `错误 ${FAILURE_CAP + 4}`, "newest first");
  assert.equal(at(entries, FAILURE_CAP - 1).text, "错误 5", "the five oldest are gone");
  assert.equal(stored().length, FAILURE_CAP, "the cap is what got persisted");
});

test("failures: blank or lifeless input is refused, not rendered as a nameless row", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("command", "", "有原因没动词", T0);
  useFailures.getState().record("command", "保存失败", "   ", T0);
  useFailures.getState().record("command", "保存失败", "网络错误", Number.NaN);
  assert.deepEqual(useFailures.getState().entries, []);
  assert.equal(readBack(KEY), null, "nothing worth saying means nothing written");
});

test("failures: a corrupt or junk persisted payload degrades to what is usable", async () => {
  const broken = await importSeeded<Failures>(STORE, { [KEY]: "[1,2," });
  assert.deepEqual(broken.useFailures.getState().entries, [], "unparseable JSON is empty");

  const notArray = await importSeeded<Failures>(STORE, { [KEY]: '{"a":1}' });
  assert.deepEqual(notArray.useFailures.getState().entries, []);

  const junkRows = await importSeeded<Failures>(STORE, {
    [KEY]: JSON.stringify([
      { at: T0, kind: "command", verb: "保存失败", text: "网络错误", count: 2 },
      null,
      5,
      { at: "昨天", kind: "command", verb: "v", text: "t" },
      { at: T0, kind: "explosion", verb: "v", text: "t" },
      { at: T0, kind: "command", verb: "  ", text: "t" },
      { at: T0, kind: "command", verb: "v", text: "" },
      { at: -3, kind: "command", verb: "v", text: "t" },
    ]),
  });
  const entries = junkRows.useFailures.getState().entries;
  assert.equal(entries.length, 1, "drop, don't repair: only the intact row survives");
  assert.deepEqual(entries[0], { at: T0, kind: "command", verb: "保存失败", text: "网络错误", count: 2 });
});

test("failures: junk count coerces to 1, lengths are capped on read", async () => {
  const { useFailures, TEXT_MAX, VERB_MAX } = await importSeeded<Failures>(STORE, {
    [KEY]: JSON.stringify([
      { at: T0, kind: "command", verb: "v".repeat(200), text: "t".repeat(2_000), count: 0 },
      { at: T0 + 1, kind: "command", verb: "v", text: "t", count: 2.9 },
    ]),
  });
  const rows = useFailures.getState().entries;
  const first = at(rows, 0);
  const second = at(rows, 1);
  assert.equal(first.text.length, TEXT_MAX, "a novel in the cause column is clipped, not kept");
  assert.equal(first.verb.length, VERB_MAX);
  assert.equal(first.count, 1, "a count below 1 means at least once, so 1");
  assert.equal(second.count, 2, "fractional counts floor to whole occurrences");
});

test("failures: an oversized stored list is truncated to the newest cap", async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    at: T0 - i,
    kind: "command",
    verb: "保存失败",
    text: `错误 ${i}`,
    count: 1,
  }));
  const { useFailures, FAILURE_CAP } = await importSeeded<Failures>(STORE, {
    [KEY]: JSON.stringify(rows),
  });
  assert.equal(useFailures.getState().entries.length, FAILURE_CAP);
  assert.equal(at(useFailures.getState().entries, 0).text, "错误 0", "the stored order is preserved");
});

test("failures: clear empties the history and persists the empty list", async () => {
  const { useFailures } = await importSeeded<Failures>(STORE);
  useFailures.getState().record("rejection", "后台任务", "Unhandled: boom", T0);
  useFailures.getState().clear();
  assert.deepEqual(useFailures.getState().entries, []);
  assert.equal(nonNull(readBack(KEY), KEY), "[]", "clearing must survive a reload, or the row comes back");
});

test("failures: the pure helpers agree with the store about junk and folding", async () => {
  const { normalizeEntries, foldEntry, makeEntry, FOLD_MS } = await importSeeded<Failures>(STORE);

  assert.deepEqual(normalizeEntries("not an array"), []);
  assert.equal(normalizeEntries([{ at: T0, kind: "command", verb: "v", text: "t" }]).length, 1);

  assert.equal(makeEntry("command", "v", "t", 0), null, "epoch 0 is not a plausible arrival");
  assert.equal(makeEntry("command", "v", "t", Number.POSITIVE_INFINITY), null);

  const head = { at: T0, kind: "command" as const, verb: "v", text: "t", count: 2 };
  const folded = foldEntry([head], { ...head, count: 1, at: T0 + FOLD_MS });
  assert.deepEqual(folded, [{ ...head, at: T0 + FOLD_MS, count: 3 }]);
  const separate = foldEntry([head], { ...head, count: 1, at: T0 + FOLD_MS + 1 });
  assert.equal(separate.length, 2);
});
