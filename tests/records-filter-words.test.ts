/**
 * `src/views/records/filter-words.ts` — the sentence the 记录 no-match panel prints.
 *
 * The panel exists because there was no way back from it; this function is the part
 * of it that can be pinned without a webview: the conditions have to be named with
 * the labels the chips render, never with the ids the log stores. A screenshot of a
 * matching list cannot show that failure, so it gets a test that walks every id in
 * `constants.ts` and asserts the raw id is absent from the output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterWordsOf,
  hasActiveFilter,
} from "../src/views/records/filter-words.ts";
import { RANGES, TAGS } from "../src/views/records/constants.ts";

test("filter words: nothing chosen is nothing to name", () => {
  assert.equal(filterWordsOf("all", "all", ""), "");
  assert.equal(filterWordsOf("all", "all", "   "), "");
  assert.equal(hasActiveFilter("all", "all", "  "), false);
});

test("filter words: each axis is named in the chip's own words", () => {
  assert.equal(filterWordsOf("appearance", "all", ""), "类别「外观」");
  assert.equal(filterWordsOf("all", "7d", ""), "时间「7 天」");
  assert.equal(filterWordsOf("all", "all", "  venv "), "搜索「venv」");
});

test("filter words: all three read as one sentence, in bar order", () => {
  assert.equal(filterWordsOf("launch", "1d", "api"), "类别「启动」 · 时间「今天」 · 搜索「api」");
});

test("filter words: no stored id ever reaches the界面", () => {
  for (const t of TAGS) {
    if (t.id === "all") continue;
    const words = filterWordsOf(t.id, "all", "");
    assert.ok(words.includes(t.label), `${t.id} must render as 「${t.label}」`);
    assert.ok(!words.includes(t.id), `${t.id} leaked its id into "${words}"`);
  }
  for (const r of RANGES) {
    if (r.id === "all") continue;
    const words = filterWordsOf("all", r.id, "");
    assert.ok(words.includes(r.label), `${r.id} must render as 「${r.label}」`);
    assert.ok(!words.includes(r.id), `${r.id} leaked its id into "${words}"`);
  }
});

test("filter words: a chip the bar never renders still reads as a sentence", () => {
  // An old log can carry a tag id the current chip row no longer lists; the panel
  // must degrade to a generic noun rather than printing the id.
  assert.equal(filterWordsOf("webhook", "all", ""), "类别「已选类别」");
  assert.equal(filterWordsOf("all", "5m", ""), "时间「已选时间」");
});

test("hasActiveFilter: it follows exactly what the panel offers to clear", () => {
  assert.equal(hasActiveFilter("all", "all", ""), false);
  assert.equal(hasActiveFilter("clear", "all", ""), true);
  assert.equal(hasActiveFilter("all", "90d", ""), true);
  assert.equal(hasActiveFilter("all", "all", "x"), true);
  for (const t of TAGS) {
    if (t.id === "all") continue;
    assert.equal(hasActiveFilter(t.id, "all", ""), true, t.id);
  }
  for (const r of RANGES) {
    if (r.id === "all") continue;
    assert.equal(hasActiveFilter("all", r.id, ""), true, r.id);
  }
});
