/**
 * `src/store/ui.ts` — 未知 view id 的回退（r16-o2-3）。
 *
 * 常用页的 `view:` 固定项是 imported/persisted JSON，`FrequentView.openEntry`
 * 只能 `go(entry.id as ViewId)`。App.tsx 按已知视图一个分支一个分支地渲染、
 * 没有 default：`projects-v2` 或 round 9 删掉的 `appearance` 之类的名字过去会把
 * 主区域渲染成空白——不抛错、不报 toast、历史里还多了一条指向不存在页面的条目。
 * `readNav` 早就有「存储里的死 id 直接丢弃」的规则，现在 `go` / `setView` 在进门
 * 处走同一条规则，并把落点说出来。
 *
 * toast store 要用 window.setInterval 自启 ticker，Node 里没有 window——装一个
 * 从不回调的假计时器（toast-expiry.test.ts 同款），队列照常可读。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { VIEW_LABEL, useUI, type ViewId } from "../src/store/ui.ts";
import { useToast } from "../src/store/toast.ts";

import { at } from "./helpers/definite.ts";

// 模块体里就装好：toast 只在测试回调里 push，而回调跑在模块体之后。
(globalThis as { window?: unknown }).window = {
  setInterval: () => 1,
  clearInterval: () => {},
};

const reset = () => {
  useUI.setState({ view: "projects", history: [{ view: "projects" }], pointer: 0 });
  useToast.setState({ items: [] });
};

beforeEach(reset);

const toastTexts = () => useToast.getState().items.map((t) => t.text);

test("go(): 未知 id 落到默认视图，历史里不留下死 id，toast 说出落点", () => {
  useUI.setState({ view: "records", history: [{ view: "records" }], pointer: 0 });
  useUI.getState().go("projects-v2" as ViewId);

  const s = useUI.getState();
  assert.equal(s.view, "projects", "未知名字回到落地页");
  assert.deepEqual(
    s.history.map((d) => d.view),
    ["records", "projects"],
    "推入的是回退后的目标，不是那个不存在的页面",
  );
  assert.ok(
    s.history.every((d) => d.view in VIEW_LABEL),
    "历史里不允许出现任何没有分支渲染的 view id",
  );
  const texts = toastTexts();
  assert.equal(texts.length, 1, "回退必须说出来，而不是悄悄发生");
  assert.match(at(texts, 0), /projects-v2/, "toast 里带着那个认不出的名字");
  assert.match(at(texts, 0), /项目/, "toast 里带着实际落点的名字");
});

test("go(): 已知 id 一切照旧，不惊动 toast", () => {
  useUI.getState().go("add");
  const s = useUI.getState();
  assert.equal(s.view, "add");
  assert.equal(s.pointer, 1);
  assert.deepEqual(toastTexts(), [], "有效导航不该有多余的提示");
});

test("go(): 目标回退成当前页时不推新条目，但仍然报错", () => {
  useUI.getState().go("junk" as ViewId);
  const s = useUI.getState();
  assert.equal(s.view, "projects");
  assert.equal(s.history.length, 1, "落回原地就是一次 no-op 导航，不追加");
  assert.equal(toastTexts().length, 1, "名字认不出这件事本身仍要说出来");
});

test("setView(): 未知 id 同样回退，且被改写的条目跟着落点走", () => {
  useUI.getState().setView("appearance" as ViewId);
  const s = useUI.getState();
  assert.equal(s.view, "projects");
  assert.equal(s.history.length, 1, "setView 不推历史（它是副作用跳转）");
  assert.equal(at(s.history, 0).view, "projects", "指针下的条目必须命名屏幕上真正的页面");
  assert.match(toastTexts().join("\n"), /appearance/);
});

test("setView(): 已知 id 不触发回退", () => {
  useUI.getState().setView("settings");
  const s = useUI.getState();
  assert.equal(s.view, "settings");
  assert.deepEqual(toastTexts(), []);
});
