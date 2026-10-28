/**
 * `src/lib/wall-keyboard.ts` — 项目墙方向键的几何。
 *
 * 网格列数随窗口与密度改变，所以“下一张”只能由卡片真实矩形算。这里钉住三件事：
 * 同行优先（垂直距离加权）、方向为空时停住不绕回、Home/End 直达两端。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isWallNavKey, nextCardIndex, type CardRect } from "../src/lib/wall-keyboard.ts";

/** A 3×3 grid: 100×80 cards, 10 px gaps. */
function grid3x3(): CardRect[] {
  const out: CardRect[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const left = col * 110;
      const top = row * 90;
      out.push({ left, top, right: left + 100, bottom: top + 80, width: 100, height: 80 });
    }
  }
  return out;
}

test("isWallNavKey: 只认六个键，别的键不拦", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const) {
    assert.equal(isWallNavKey(key), true);
  }
  assert.equal(isWallNavKey("Tab"), false);
  assert.equal(isWallNavKey(" "), false);
  assert.equal(isWallNavKey("ArrowDown2"), false);
});

test("3×3 中心：四个方向各到同行/同列的邻居", () => {
  const rects = grid3x3();
  assert.equal(nextCardIndex(rects, 4, "ArrowRight"), 5);
  assert.equal(nextCardIndex(rects, 4, "ArrowLeft"), 3);
  assert.equal(nextCardIndex(rects, 4, "ArrowDown"), 7);
  assert.equal(nextCardIndex(rects, 4, "ArrowUp"), 1);
});

test("边缘：方向为空时停在原地，不绕行", () => {
  const rects = grid3x3();
  assert.equal(nextCardIndex(rects, 0, "ArrowLeft"), 0);
  assert.equal(nextCardIndex(rects, 2, "ArrowRight"), 2);
  assert.equal(nextCardIndex(rects, 0, "ArrowUp"), 0);
  assert.equal(nextCardIndex(rects, 6, "ArrowDown"), 6);
});

test("Home / End 直达首尾，空列表返回 -1", () => {
  const rects = grid3x3();
  assert.equal(nextCardIndex(rects, 4, "Home"), 0);
  assert.equal(nextCardIndex(rects, 4, "End"), 8);
  assert.equal(nextCardIndex([], 0, "ArrowRight"), -1);
  assert.equal(nextCardIndex(rects, -1, "ArrowRight"), -1);
});

test("下一行更近也不抢：垂直距离加权让 ArrowRight 留在本行", () => {
  // Same 3 columns, but row 1 is shifted right by 40 px. From card 0 the
  // horizontally-nearest card is row 1 col 0 (dx 40, dy 90), but the same-row
  // card 1 (dx 110, dy 0) wins because the cross-axis term is weighted.
  const rects = grid3x3().map((r, i) =>
    i >= 3 && i < 6 ? { ...r, left: r.left + 40, right: r.right + 40 } : r,
  );
  assert.equal(nextCardIndex(rects, 0, "ArrowRight"), 1);
});

test("不同行高：ArrowDown 选择水平距离最近的下一行卡片", () => {
  const rects: CardRect[] = [
    { left: 0, top: 0, right: 100, bottom: 80, width: 100, height: 80 },
    { left: 110, top: 0, right: 210, bottom: 80, width: 100, height: 80 },
    { left: 0, top: 130, right: 100, bottom: 210, width: 100, height: 80 },
    { left: 110, top: 130, right: 210, bottom: 210, width: 100, height: 80 },
  ];
  assert.equal(nextCardIndex(rects, 0, "ArrowDown"), 2);
  assert.equal(nextCardIndex(rects, 1, "ArrowDown"), 3);
});
