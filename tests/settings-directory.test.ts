/**
 * `src/views/settings/helpers.ts` — the merged 项目目录 list rules and the
 * number-field clamp.
 *
 * These are the two pieces of 设置 logic that are pure and load-bearing:
 * get the dedupe wrong and a directory disappears from the list after a root
 * switch; get the clamp wrong and a half-typed number reaches disk and only
 * explodes later inside the parallel-download loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { clampInt, directoryRowsOf, DIRECTORY_KIND_LABEL, DIRECTORY_KIND_HINT } from "../src/views/settings/helpers";

test("directoryRowsOf: 当前 always sorts first, then extra, then recent", () => {
  const rows = directoryRowsOf({
    current: "C:\\work\\main",
    extra: ["C:\\work\\extra1", "C:\\work\\extra2"],
    recent: ["C:\\work\\old1", "C:\\work\\old2"],
  });
  assert.deepEqual(rows.map((r) => r.kind), [
    "current",
    "extra",
    "extra",
    "recent",
    "recent",
  ]);
  // 同段内保留登记顺序。
  assert.deepEqual(rows.map((r) => r.path), [
    "C:\\work\\main",
    "C:\\work\\extra1",
    "C:\\work\\extra2",
    "C:\\work\\old1",
    "C:\\work\\old2",
  ]);
});

test("directoryRowsOf: a path present as two kinds keeps the stronger identity", () => {
  // 主目录后来又被加进附加目录：只留一行，身份是 当前。
  const rows = directoryRowsOf({
    current: "C:\\work",
    extra: ["C:\\work", "C:\\other"],
    recent: [],
  });
  assert.deepEqual(rows, [
    { kind: "current", path: "C:\\work" },
    { kind: "extra", path: "C:\\other" },
  ]);
});

test("directoryRowsOf: dedupe is case-insensitive, user casing preserved", () => {
  const rows = directoryRowsOf({ current: "c:\\WORK", extra: ["C:\\work", "D:\\x"], recent: [] });
  assert.equal(rows.length, 2);
  // value 保留用户实际写过的那份大小写（首次登记的那份）。
  assert.deepEqual(rows[0], { kind: "current", path: "c:\\WORK" });
});

test("directoryRowsOf: blank entries are dropped, whitespace trimmed", () => {
  const rows = directoryRowsOf({
    current: "   ",
    extra: ["  C:\\a  ", "", "C:\\a"],
    recent: ["\t"],
  });
  assert.deepEqual(rows, [{ kind: "extra", path: "C:\\a" }]);
});

test("directoryRowsOf: weak earlier identity does not shadow a later stronger one", () => {
  // 历史目录与主目录同路径时，主目录身份赢（登记顺序先 recent 再 current
  // 不可能——current 永远先登记；此用例锁的是排序后的段内顺序不互相吞并）。
  const rows = directoryRowsOf({
    current: "C:\\main",
    extra: [],
    recent: ["c:\\main", "D:\\old"],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.path]), [
    ["current", "C:\\main"],
    ["recent", "D:\\old"],
  ]);
});

test("clampInt: clamps into the row's declared range", () => {
  assert.equal(clampInt("9", 0, 6, 3), 6);
  assert.equal(clampInt("-4", 0, 6, 3), 0);
  assert.equal(clampInt("3.9", 0, 6, 3), 3);
});

test("clampInt: non-numeric text falls back, half-typed digits stay valid", () => {
  // Number("") === 0（有限值）：空框提交时落到范围下限，而不是 fallback。
  assert.equal(clampInt("", 0, 6, 3), 0);
  // "-" 转不成数字，走 fallback。
  assert.equal(clampInt("-", 0, 6, 3), 3);
  // 在打 "90" 途中打出 "9"：截断取整后仍被钳在范围内，而不是 NaN。
  assert.equal(clampInt("9", 0, 6, 3), 6);
  assert.equal(clampInt("abc", 1, 6, 3), 3);
});

test("kind catalog: every kind has a label and a hint", () => {
  for (const kind of ["current", "extra", "recent"] as const) {
    assert.ok(DIRECTORY_KIND_LABEL[kind]);
    assert.ok(DIRECTORY_KIND_HINT[kind]);
  }
});
