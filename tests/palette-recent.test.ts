/**
 * `src/lib/palette-recent.ts` — the shelf order and the tie-break bonus.
 *
 * The two rules worth pinning: corrupt storage degrades to an empty list (never
 * throws into the palette's mount), and recency is a tie-breaker, not a
 * relevance override (the boost is bounded and only added after a text match).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PALETTE_RECENT_KEY,
  PALETTE_RECENT_MAX,
  parseRecent,
  pushRecent,
  rankByRecent,
  readRecent,
  recentBoost,
} from "../src/lib/palette-recent.ts";

function fakeStorage(seed?: string) {
  let value = seed ?? null;
  return {
    get value() {
      return value;
    },
    getItem: (key: string) => (key === PALETTE_RECENT_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === PALETTE_RECENT_KEY) value = next;
    },
  };
}

test("parseRecent: 损坏 JSON / 非数组 / 非字符串项一律降级，不抛", () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent(""), []);
  assert.deepEqual(parseRecent("{"), []);
  assert.deepEqual(parseRecent("null"), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent('["act-refresh", 7, "  ", "act-refresh", "act-theme"]'), [
    "act-refresh",
    "act-theme",
  ]);
});

test("parseRecent: 上限与去重同时生效，顺序保留", () => {
  const many = Array.from({ length: 10 }, (_, i) => `id-${i}`);
  const parsed = parseRecent(JSON.stringify(many));
  assert.equal(parsed.length, PALETTE_RECENT_MAX);
  assert.deepEqual(parsed, many.slice(0, PALETTE_RECENT_MAX));
});

test("readRecent: 存储抛异常时返回空列表（面板必须还能打开）", () => {
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {},
  };
  assert.deepEqual(readRecent(throwing as never), []);
});

test("pushRecent: 新 id 置顶、旧的去重、写回同一 key", () => {
  const storage = fakeStorage(JSON.stringify(["act-theme", "act-refresh"]));
  const next = pushRecent("act-refresh", storage);
  assert.deepEqual(next, ["act-refresh", "act-theme"]);
  assert.equal(storage.value, JSON.stringify(next), "排序必须持久化，否则下次打开又回旧顺序");
  const empty = pushRecent("   ", storage);
  assert.deepEqual(empty, next, "空 id 不改动");
});

test("pushRecent: 满了以后挤掉最旧的一条", () => {
  const storage = fakeStorage(JSON.stringify(Array.from({ length: PALETTE_RECENT_MAX }, (_, i) => `id-${i}`)));
  const next = pushRecent("new", storage);
  assert.equal(next.length, PALETTE_RECENT_MAX);
  assert.equal(next[0], "new");
  assert.equal(next.includes(`id-${PALETTE_RECENT_MAX - 1}`), false);
});

test("recentBoost: 只在命中列表内给分，越新越高，列表外为 0", () => {
  const ids = ["a", "b", "c"];
  assert.ok(recentBoost("a", ids) > recentBoost("b", ids));
  assert.ok(recentBoost("b", ids) > recentBoost("c", ids));
  assert.equal(recentBoost("z", ids), 0);
  assert.equal(recentBoost("a", []), 0);
  assert.ok(recentBoost("a", ids) <= 0.06, "recency 只能是 tie-break，不能压过相关性");
});

test("rankByRecent: 已知项按最近序，未知项保持原相对顺序", () => {
  const rows = [{ id: "x" }, { id: "a" }, { id: "y" }, { id: "b" }];
  assert.deepEqual(rankByRecent(rows, ["b", "a"]).map((r) => r.id), ["b", "a", "x", "y"]);
  assert.deepEqual(rankByRecent(rows, []).map((r) => r.id), ["x", "a", "y", "b"]);
});
