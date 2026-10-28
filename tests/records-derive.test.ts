/**
 * The 记录页's filter pipeline (`src/lib/records-derive.ts`) — the predicate that
 * used to be inline in `views/RecordsView.tsx`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterRecordEntries,
  matchRecordEntry,
  recordCutoff,
  type RecordFilterEntry,
} from "../src/lib/records-derive.ts";

const entry = (over: Partial<RecordFilterEntry> = {}): RecordFilterEntry => ({
  tag: "config",
  ts: 1_000_000,
  action: "改设置",
  detail: "",
  slug: "",
  path: "",
  source: "",
  ...over,
});

test("recordCutoff:全部（0 秒）= 无下界，不是「现在」", () => {
  // The reversed ternary would put the cutoff at `now` and hide the whole history.
  assert.equal(recordCutoff(0, 1_700_000_000_000), Number.MIN_SAFE_INTEGER);
  assert.equal(recordCutoff(3600, 1_700_000_000_000), 1_699_996_400, "now 的整秒减窗口");
});

test("matchRecordEntry:类别 chip 精确比较，全部放行", () => {
  const e = entry({ tag: "download" });
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: Number.MIN_SAFE_INTEGER, query: "" }), true);
  assert.equal(matchRecordEntry(e, { tag: "download", cutoff: Number.MIN_SAFE_INTEGER, query: "" }), true);
  assert.equal(matchRecordEntry(e, { tag: "config", cutoff: Number.MIN_SAFE_INTEGER, query: "" }), false);
});

test("matchRecordEntry:时间下界排除更早的记录，等于下界的留下", () => {
  const e = entry({ ts: 500 });
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 500, query: "" }), true, "边界包含");
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 501, query: "" }), false);
});

test("matchRecordEntry:空搜索放行，搜索命中八个字段里的任意一处", () => {
  const e = entry({ action: "删除项目", detail: "旧目录", target: "config.searchDebounceMs" });
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 0, query: "   " }), true, "空白搜索等于没搜");
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 0, query: "删除" }), true, "action");
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 0, query: "旧目录" }), true, "detail");
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 0, query: "debounce" }), true, "target，大小写不敏感");
  assert.equal(matchRecordEntry(e, { tag: "all", cutoff: 0, query: "没有这段" }), false);
});

test("matchRecordEntry:缺字段的记录不会因为 toLowerCase 抛错", () => {
  // The old inline version filtered the haystack on `!!f` precisely so a row with
  // no `before`/`after` did not call `.toLowerCase()` on `undefined`.
  const sparse: RecordFilterEntry = { tag: "all", ts: 1, action: "唯一有值的字段" };
  assert.equal(matchRecordEntry(sparse, { tag: "all", cutoff: 0, query: "唯一" }), true);
  assert.equal(matchRecordEntry(sparse, { tag: "all", cutoff: 0, query: "x" }), false);
});

test("filterRecordEntries:一次过滤保持顺序", () => {
  const list = [
    entry({ ts: 10, tag: "download", action: "下载" }),
    entry({ ts: 20, tag: "config", action: "改设置" }),
    entry({ ts: 30, tag: "download", action: "再下载" }),
  ];
  const out = filterRecordEntries(list, { tag: "download", cutoff: 0, query: "" });
  assert.deepEqual(out.map((e) => e.ts), [10, 30]);
});
