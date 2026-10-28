/**
 * `src/lib/contrast.ts` — 用仓库里已经量过的三个数做独立校验。
 *
 * `src/index.css` 的浅色主题注释记录过：ink 19.3:1、secondary 6.02:1、蓝色按钮
 * 白字 4.74:1。如果 OKLCH→sRGB 的转换写错，这三条会一起偏掉；黑/白 21:1 与
 * #767676 对白 4.54:1 是任何实现都必须复现的锚点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AA_NON_TEXT,
  AA_TEXT,
  AAA_TEXT,
  contrastRatio,
  formatRatio,
  oklchToRgb,
  parseColor,
  relativeLuminance,
} from "../src/lib/contrast.ts";

const token = (l: number, c: number, h: number) => oklchToRgb(l, c, h);
const near = (actual: number, expected: number, tolerance: number, what: string) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual.toFixed(2)}, expected ${expected} ± ${tolerance}`,
  );
};

test("锚点: 黑/白 21:1，#767676 对白 ≈4.54:1", () => {
  const white = token(1, 0, 0);
  const black = token(0, 0, 0);
  near(contrastRatio(white, black), 21, 0.05, "white/black");
  const grey = parseColor("#767676");
  const paper = parseColor("#ffffff");
  assert.ok(grey && paper);
  near(contrastRatio(grey, paper), 4.54, 0.01, "#767676/white");
  assert.equal(relativeLuminance(black), 0);
  assert.equal(relativeLuminance(white), 1);
});

test("与 index.css 浅色主题注释的三个实测数一致", () => {
  const white = token(1, 0, 265); // --n-0
  const ink = token(0.165, 0.008, 265); // --n-900
  const secondary = token(0.5, 0.016, 265); // --n-600
  const blue = token(0.56, 0.185, 258); // --b-600
  near(contrastRatio(ink, white), 19.3, 0.4, "ink on white");
  near(contrastRatio(secondary, white), 6.02, 0.25, "secondary on white");
  near(contrastRatio(white, blue), 4.74, 0.2, "white label on blue");
  assert.ok(contrastRatio(white, blue) >= AA_TEXT, "白字按钮必须过 AA 正文");
});

test("深色主题的主文字与次要文字可读", () => {
  const page = token(0.165, 0.008, 265); // --n-900 background
  const card = token(0.24, 0.012, 265); // --n-800 card
  const fg = token(1, 0, 265); // --n-0
  const muted = token(0.74, 0.014, 265); // --n-400
  assert.ok(contrastRatio(fg, page) >= AAA_TEXT, "主文字应过 AAA");
  assert.ok(contrastRatio(fg, card) >= AAA_TEXT);
  assert.ok(contrastRatio(muted, page) >= AA_TEXT, "次要文字至少 AA");
  assert.ok(contrastRatio(muted, card) >= AA_TEXT);
});

test("对比度对称，裁剪到 1..21", () => {
  const a = token(0.65, 0.19, 25); // danger
  const b = token(1, 0, 0);
  assert.equal(contrastRatio(a, b), contrastRatio(b, a));
  assert.equal(contrastRatio(a, a), 1);
});

test("parseColor: oklch / 百分比 / hex 短长 / rgb; 其它返回 null", () => {
  const direct = parseColor("oklch(1 0 0)");
  assert.deepEqual(direct, { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor("oklch(0.5 0.1 258)"), oklchToRgb(0.5, 0.1, 258));
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor("#1f70de"), { r: 31, g: 112, b: 222 });
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3 });
  assert.equal(parseColor("var(--n-900)"), null);
  assert.equal(parseColor("rgb(300, 0, 0)"), null);
  assert.equal(parseColor("not-a-colour"), null);
});

test("阈值常量与格式化", () => {
  assert.equal(AA_TEXT, 4.5);
  assert.equal(AA_NON_TEXT, 3);
  assert.equal(formatRatio(3.3333), "3.33:1");
});
