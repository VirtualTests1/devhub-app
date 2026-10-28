/**
 * `src/lib/motion.ts` 里唯一的纯导出 `motionMs`（此前整个模块无人 import）。
 *
 * 它存在的理由写在 docstring 里：应用皮肤后 `--motion-exit` 是
 * `calc(150ms * var(--motion-scale))`，`getComputedStyle(probe).transitionDuration`
 * 会回一个**未解析**的空串，`parseFloat("")` = NaN——若只信这条路，每个 JS 侧等待都会
 * 悄悄退回默认时长、不再跟皮肤走。所以有第二条从 documentElement 捞原始 token 的退路。
 * 这里把三条路都钉住：没有 DOM 时的 fallback、computed 给得出秒数、以及 calc 没解析时
 * 回读原始 token。用二进制可精确表示的分数（0.25s）避免浮点比较误判。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { motionMs } from "../src/lib/motion.ts";

// motion.ts 里 `window` / `document` / `getComputedStyle` 都是自由引用的全局。
// 用同一个 documentElement 身份对象，好让 getComputedStyle 能区分「探针元素」和「根元素」。
const docEl = {};

function withDom() {
  (globalThis as any).window = {};
  (globalThis as any).document = {
    documentElement: docEl,
    body: { appendChild: () => {} },
    createElement: () => ({ style: {}, remove: () => {} }),
  };
}

/** 探针元素的 transitionDuration，和 documentElement 上该 token 的原始串。 */
function computed(transitionDuration: string, rawTokenValue: string) {
  (globalThis as any).getComputedStyle = (el: unknown) =>
    el === docEl ? { getPropertyValue: () => rawTokenValue } : { transitionDuration };
}

function withoutWindow() {
  delete (globalThis as any).window;
}

test("motionMs: 没有 DOM（window undefined）时直接返回 fallback，绝不返回 NaN", () => {
  withoutWindow();
  assert.equal(motionMs("--motion-exit"), 150, "默认 fallback");
  assert.equal(motionMs("--motion-exit", 999), 999, "自定义 fallback 原样返回");
  assert.equal(motionMs("--whatever", 0), 0, "0 也是合法的 fallback");
});

test("motionMs: computed 给出可解析的秒数时按毫秒返回", () => {
  withDom();
  computed("0.25s", "");
  assert.equal(motionMs("--motion-enter"), 250, "parseFloat('0.25s')=0.25 → round(0.25*1000)=250");
});

test("motionMs: calc 未在引擎里解析出 duration 时，退回读原始 token", () => {
  // 函数存在的核心理由：computed 回空串 → NaN → 不信这条路，转而从 documentElement 上
  // 把原始值捞出来解析。两条写法都要认：以 ms 结尾直接取数，否则按秒 *1000。
  withDom();
  computed("", "150ms");
  assert.equal(motionMs("--motion-exit"), 150, "raw 以 ms 结尾 → parseFloat('150ms')=150");
  computed("", "0.25s");
  assert.equal(motionMs("--motion-exit"), 250, "raw 非 ms → parseFloat('0.25s')*1000=250");
});

test("motionMs: 两条路都读不到数才落到 fallback，且永远是有限数", () => {
  withDom();
  computed("", "不是一串数");
  assert.equal(motionMs("--motion-exit", 175), 175, "垃圾值 → fallback，不给 NaN、不给 0");
  assert.ok(Number.isFinite(motionMs("--motion-exit", 175)), "任何输入都必须是有限毫秒");
});
