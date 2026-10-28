/**
 * `src/dialogs/launch/step-keys.ts` — row identity for the step editor.
 *
 * The defect (round 12, 让失败可见 8.5): `StepsEditor.tsx:34` keyed rows by array
 * index while `move()` swapped the rows underneath, and each row holds a
 * controlled `<input value={s.name}>`. React keys by identity, so it kept the DOM
 * node in the *slot*: after 上移/下移 the caret and an in-progress IME composition
 * stayed in the row the step had just left. The user typing 中文 into step 2 and
 * pressing 下移 once could end up with the preedit string in step 1.
 *
 * What is pinned here is the two halves of the fix: the id travels with the step
 * through a reorder, and the id never leaves React — not into `confirm_launch_steps`,
 * not into the `dirtySteps` comparison that decides whether 启动 is safe to reuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { LaunchStep } from "../src/types.ts";
import { moveStep, withoutKeys, withKeys } from "../src/dialogs/launch/step-keys.ts";

import { at } from "./helpers/definite.ts";

/** The shape `repo_detail` answers, key order included — `launch.rs:627` order. */
function loaded(...names: string[]): LaunchStep[] {
  return names.map((name) => ({
    name,
    command: `npm run ${name}`,
    cwd: "",
    parallel: false,
  }));
}

test("withKeys: every row gets its own id, and the marker objects stay untouched", () => {
  const source = loaded("安装依赖", "启动");
  const keyed = withKeys(source);
  assert.equal(keyed.length, 2);
  assert.notEqual(at(keyed, 0).uid, at(keyed, 1).uid);
  assert.equal(typeof at(keyed, 0).uid, "number");
  // The arrays handed to React are copies: nothing can reach the stored step list
  // by mutating a row, because the rows the editor holds are not those objects.
  assert.equal((source[0] as { uid?: number }).uid, undefined);
});

test("withKeys: re-running it keeps the ids the rows already have", () => {
  // Called on load, on 添加步骤, on 模板 and on 取消 — each of those must leave
  // the rows on screen as they were, or the inputs remount and the caret jumps,
  // which is the bug this whole item is about.
  const first = withKeys(loaded("a", "b"));
  const again = withKeys(first);
  assert.deepEqual(
    again.map((s) => s.uid),
    first.map((s) => s.uid),
  );
});

test("withKeys: a field edit carries the id along, which is what keeps the caret", () => {
  const step = at(withKeys(loaded("安装")), 0);
  // Exactly what `update()` does: `{ ...s, ...patch }`. The patch is
  // `Partial<LaunchStep>` and cannot contain `uid`, so the spread preserves it.
  const patched = { ...step, name: "安装依赖" };
  assert.equal(patched.uid, step.uid);
  assert.equal(patched.name, "安装依赖");
});

test("moveStep: the id travels with the step, not with the slot", () => {
  const rows = withKeys(loaded("安装依赖", "启动", "检查"));
  const a = at(rows, 0);
  const b = at(rows, 1);
  const c = at(rows, 2);
  const after = moveStep([a, b, c], 0, 1);
  assert.deepEqual(
    after.map((s) => s.uid),
    [b.uid, a.uid, c.uid],
  );
  assert.deepEqual(
    after.map((s) => s.name),
    ["启动", "安装依赖", "检查"],
  );
  // The row that moved into index 1 is still keyed by its own uid. With `key={i}`
  // it was keyed by the slot, so React handed that input node — caret and IME
  // preedit included — to whichever step landed there.
  assert.equal(after[0], b);
  assert.equal(after[1], a);
});

test("moveStep: out of range is a no-op, not a throw", () => {
  const steps = withKeys(loaded("启动"));
  assert.equal(moveStep(steps, 0, -1), steps, "上移 at the top returns the same list");
  assert.equal(moveStep(steps, 0, 1), steps, "下移 at the bottom returns the same list");
  assert.equal(moveStep(steps, 3, -1), steps, "a stale index cannot corrupt the list");
});

test("moveStep: the input array is not mutated", () => {
  const steps = withKeys(loaded("a", "b"));
  const snapshot = steps.map((s) => s.name);
  moveStep(steps, 0, 1);
  assert.deepEqual(steps.map((s) => s.name), snapshot);
});

test("withoutKeys: the four real fields and nothing else", () => {
  const step = at(withKeys(loaded("启动")), 0);
  const wire = at(withoutKeys([step]), 0);
  assert.deepEqual(Object.keys(wire), ["name", "command", "cwd", "parallel"]);
  assert.equal(wire.name, "启动");
});

test("withoutKeys: a load/save round trip is byte-identical to what came in", () => {
  // `dirtySteps` is a JSON.stringify comparison, and key order is part of that
  // string. If stripping reordered the fields, every panel would open as
  // 「有未保存修改」 and 一键启动 would rewrite a marker that never changed.
  const source = loaded("安装依赖", "启动");
  assert.equal(JSON.stringify(withoutKeys(withKeys(source))), JSON.stringify(source));
});

test("withKeys: an unsaved draft is still dirty after the id is stripped", () => {
  const source = loaded("启动");
  const draft = withKeys(source).map((s) => ({ ...s, command: "pnpm dev" }));
  assert.notEqual(JSON.stringify(withoutKeys(draft)), JSON.stringify(source));
});
