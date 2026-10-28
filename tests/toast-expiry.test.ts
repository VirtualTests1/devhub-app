/**
 * `src/store/toast.ts` — 到期、挤出与那个唯一的计时器。
 *
 * report-error.test.ts 借这个 store 断言 `reportError` 的落点，但它把
 * `window.setInterval` 打桩成一个从不回调的假计时器，只读队列、不看倒计时。于是
 * store 真正的定时行为——每类停留多久、第四条挤掉谁、暂停怎么冻结倒计时、清空后
 * 计时器怎么自停——今天没有任何测试覆盖。这里补上。
 *
 * 全部由两个注入件驱动，和 `poll-loop.test.ts` 一个路子：一个可控的 `Date.now`
 * 和一个捕获回调的假 `window.setInterval`，让「点了一下 tick」成为测试能进入的状态。
 * 计时策略以 store 实际用的为准：单个 250 ms 的 `window.setInterval`，队列空时
 * `window.clearInterval` 自停；`ensureTicker` 用 `ticker !== null` 保证只有一个。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importFresh } from "./helpers/storage.ts";

import { at } from "./helpers/definite.ts";

type Toast = typeof import("../src/store/toast.ts");

// --- 假时钟与假计时器：装进 window，让 store 在 Node 里也能跑定时路径 ----------

// 本文件把 `Date.now` 钉成可控值且不还原：`node --test` 每个测试文件跑在独立进程里，
// 这个桩不会漏到别的文件；store/toast 只依赖 Date.now 与 window.setInterval。
let now = 1_000_000;
Date.now = () => now;

/** 捕获 `window.setInterval` 的回调，好让测试手动「走一格」。 */
function fakeWindow() {
  let id = 0;
  const live = new Map<number, () => void>();
  (globalThis as { window?: unknown }).window = {
    setInterval: (cb: () => void) => {
      const i = ++id;
      live.set(i, cb);
      return i;
    },
    clearInterval: (i: number) => {
      live.delete(i);
    },
  };
  return {
    /** 触发当前活着的 interval 一次（store 只有一个 ticker）。 */
    tick: () => live.forEach((cb) => cb()),
    liveCount: () => live.size,
  };
}

/** 每个用例拿一份全新的 store 模块实例，重置 store 模块级 `nextId` 与 `ticker`，
 *  这样用例之间不共享 id 计数和计时器状态。 */
async function fresh() {
  now = 1_000_000;
  const timers = fakeWindow();
  const mod = await importFresh<Toast>(import.meta.resolve("../src/store/toast.ts"));
  return { mod, timers, state: () => mod.useToast.getState() };
}

const kinds = (mod: Toast) => mod.useToast.getState().items.map((t) => t.kind);
const texts = (mod: Toast) => mod.useToast.getState().items.map((t) => t.text);

// --- 每类停留时长：success 3 s / info 3.5 s / error 6 s ------------------------

test("push: 每类的到期时间 = now + 该类时长，新条目排在最后", async () => {
  const { mod } = await fresh();
  mod.toast.success("s");
  mod.toast.info("i");
  mod.toast.error("e");
  const items = mod.useToast.getState().items;
  assert.deepEqual(texts(mod), ["s", "i", "e"], "最新一条在数组末尾（右下角向上堆）");
  assert.equal(at(items, 0).expiresAt, now + 3000, "success 3 s");
  assert.equal(at(items, 1).expiresAt, now + 3500, "info 3.5 s");
  assert.equal(at(items, 2).expiresAt, now + 6000, "error 6 s，给最多阅读时间");
  assert.ok(at(items, 0).id < at(items, 1).id && at(items, 1).id < at(items, 2).id, "id 单调递增");
});

// --- 上限 3：第四条挤掉最旧的一条 ----------------------------------------------

test("上限 3：第四条把最旧那条挤出去（slice(-MAX_VISIBLE)）", async () => {
  const { mod } = await fresh();
  mod.toast.success("1");
  mod.toast.success("2");
  mod.toast.success("3");
  mod.toast.success("4");
  assert.equal(mod.useToast.getState().items.length, 3, "同屏最多三条");
  assert.deepEqual(texts(mod), ["2", "3", "4"], "丢的是最早那条");
});

test("上限 3：挤出的永远是数组最前那条，与 kind 无关", async () => {
  // 语义存疑但如实钉死：错误不会被成功「保护」，成功也不会因为后面来了错误而多活。
  // 一条 error 排在最前时，它也会被第四条挤掉——「错误给更多阅读时间」只体现在
  // 倒计时时长上，不体现在容量上。未来的修复若要改成「优先丢短提示」，这里会先红。
  const { mod } = await fresh();
  mod.toast.error("e");
  mod.toast.success("a");
  mod.toast.success("b");
  mod.toast.success("c");
  assert.deepEqual(kinds(mod), ["success", "success", "success"], "error 被挤掉了");
  assert.deepEqual(texts(mod), ["a", "b", "c"]);
});

// --- 到期：tick 到点后移除未到/已过条目 ----------------------------------------

test("ticker: 到点即移除，未到的留下；边界用 > 而非 >=", async () => {
  const { mod, timers } = await fresh();
  mod.toast.success("will-die"); // expires at now+3000
  const expire = at(mod.useToast.getState().items, 0).expiresAt;

  now = expire - 1;
  timers.tick();
  assert.equal(mod.useToast.getState().items.length, 1, "差 1ms 还没过期，留下");

  now = expire;
  timers.tick();
  assert.equal(mod.useToast.getState().items.length, 0, "expiresAt > now 为假：到点即走");
});

test("ticker: 错误比成功活得久——同一时刻 push，先掉的是成功那条", async () => {
  const { mod, timers } = await fresh();
  mod.toast.success("s"); // +3000
  mod.toast.error("e"); // +6000
  now += 4000; // 越过 success 的 3 s，但还在 error 的 6 s 内
  timers.tick();
  assert.deepEqual(texts(mod), ["e"], "success 已到期，error 还在读");
  now += 3000; // 越过 error 的 6 s
  timers.tick();
  assert.equal(mod.useToast.getState().items.length, 0, "error 随后也到期");
});

// --- 暂停：hover/focus 一次冻结全部倒计时（WCAG 2.2.1） -------------------------

test("ticker: paused 为真时不倒计时，恢复后继续到期", async () => {
  const { mod, timers, state } = await fresh();
  mod.toast.success("s");
  const expire = at(mod.useToast.getState().items, 0).expiresAt;
  mod.useToast.getState().setPaused(true);
  now = expire + 10_000;
  timers.tick();
  assert.equal(state().items.length, 1, "暂停期间一条都不能走");
  assert.equal(state().paused, true);

  mod.useToast.getState().setPaused(false);
  timers.tick();
  assert.equal(state().items.length, 0, "解除暂停后下一次 tick 立刻兑现");
});

// --- 计时器的生命周期：只建一个、空了自停、手动关也会停 ------------------------

test("ensureTicker 幂等：连推三条只装一个 250ms interval", async () => {
  const { mod, timers } = await fresh();
  mod.toast.success("1");
  mod.toast.info("2");
  mod.toast.error("3");
  assert.equal(timers.liveCount(), 1, "第二次/第三次 push 不重复建计时器");
});

test("队列被 tick 清空时 clearInterval 自停", async () => {
  const { mod, timers } = await fresh();
  mod.toast.success("s");
  assert.equal(timers.liveCount(), 1);
  now = at(mod.useToast.getState().items, 0).expiresAt;
  timers.tick();
  assert.equal(mod.useToast.getState().items.length, 0);
  assert.equal(timers.liveCount(), 0, "空队列不留空转计时器");
});

test("dismiss(id)：非空时计时器继续，移除最后一条时才自停", async () => {
  const { mod, timers, state } = await fresh();
  mod.toast.success("a");
  mod.toast.success("b");
  const items = state().items;
  const a = at(items, 0);
  const b = at(items, 1);
  mod.useToast.getState().dismiss(a.id);
  assert.deepEqual(texts(mod), ["b"]);
  assert.equal(timers.liveCount(), 1, "还剩一条：计时器继续跑");
  mod.useToast.getState().dismiss(b.id);
  assert.equal(state().items.length, 0);
  assert.equal(timers.liveCount(), 0, "最后一条走了才自停");
});

test("dismiss 不存在的 id 是无操作，不影响队列也不惊动计时器", async () => {
  const { mod, timers } = await fresh();
  mod.toast.success("a");
  mod.useToast.getState().dismiss(999_999);
  assert.deepEqual(texts(mod), ["a"]);
  assert.equal(timers.liveCount(), 1);
});

test("队列本来就空时，tick 是无操作，不会误停别的定时器", async () => {
  const { mod, timers, state } = await fresh();
  mod.toast.success("a");
  mod.useToast.getState().dismiss(at(state().items, 0).id);
  assert.equal(state().items.length, 0);
  assert.equal(timers.liveCount(), 0, "dismiss 收尾时已自停");
  timers.tick(); // 没有活的回调，调用不应抛错
  assert.equal(state().items.length, 0);
});
