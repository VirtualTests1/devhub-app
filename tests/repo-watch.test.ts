/**
 * r18-R1 — the reload gate that sits between `repo://changed` and a wall reload.
 *
 * The failure this pins is the one the coalescer was written to prevent, re-created one
 * layer up: the backend folds a burst into one notification, but the reload it triggers
 * (`list_repositories` + the metadata walk) takes longer than the next notification, so
 * without folding three batches during one `npm install` queue three full walks.
 *
 * One in flight, at most one waiting — not a queue. A queue would remember every change,
 * and a *refresh* must not: the newest read already contains all of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createReloadGate } from "../src/lib/repo-watch.ts";

import { at } from "./helpers/definite.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("gate: 第一次请求立刻开始，后来的折叠成「跑完再跑一次」", async () => {
  let runs = 0;
  const gate1 = deferred();
  const gate2 = deferred();
  const blockers = [gate1, gate2];
  const gate = createReloadGate(() => {
    runs += 1;
    return at(blockers, Math.min(runs - 1, blockers.length - 1)).promise;
  });

  assert.equal(gate.request(), "started");
  assert.equal(gate.request(), "queued");
  assert.equal(gate.request(), "queued");
  assert.equal(runs, 1, "在途期间不该开第二次");
  assert.equal(gate.isQueued(), true);

  gate1.resolve();
  await flush();
  assert.equal(runs, 2, "三次请求只该补跑一次");
  assert.equal(gate.isQueued(), false, "补跑之后队列是空的，不是留着历史的第三次");

  gate2.resolve();
  await flush();
  assert.equal(runs, 2);
  assert.equal(gate.isRunning(), false);
});

test("gate: 失败也必须释放，否则监听器会「悄悄不再工作」", async () => {
  let runs = 0;
  const gate = createReloadGate(() => {
    runs += 1;
    return Promise.reject(new Error("list_repositories 失败"));
  });
  gate.request();
  await flush();
  assert.equal(gate.isRunning(), false, "一次失败的刷新不能把闸门永远关着");
  gate.request();
  await flush();
  assert.equal(runs, 2, "失败之后仍然接受下一次变更");
});

test("gate: 同步抛错同样释放闸门，并且把错误留给调用方", async () => {
  const gate = createReloadGate(() => {
    throw new Error("刷新函数本身坏了");
  });
  assert.throws(() => gate.request(), /刷新函数本身坏了/);
  assert.equal(gate.isRunning(), false);
});

test("gate: 空闲时的连续请求各自独立开始", async () => {
  let runs = 0;
  const gate = createReloadGate(() => {
    runs += 1;
  });
  assert.equal(gate.request(), "started");
  await flush();
  assert.equal(gate.request(), "started");
  await flush();
  assert.equal(runs, 2);
});
