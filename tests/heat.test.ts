/**
 * r18-N4 — the GitHub heat layer: formatting rules, the badge's honesty rule, and the
 * ordering guard on the store.
 *
 * Two things here are deliberately *not* tested through the UI: the badge wording rule
 * (`★~` for a number nobody confirmed) and the 30-name batch cap. Both are pure logic in
 * `src/lib/heat.ts`, which is exactly why that file exists instead of the rules living in
 * `RepoTile.tsx`, where the Node runner could not reach them (it cannot strip `.tsx` —
 * the reason is written into `src/lib/wall-derive.ts`'s header).
 *
 * The cap is pinned **across the language boundary**: the frontend constant and the Rust
 * `HEAT_BATCH_CAP` must agree, because the UI's promise is "the tiles past the cap will
 * not fill in". A test that only reads the TypeScript would pass while the Rust said 40.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HEAT_UI_CAP, formatStars, heatBadgeOf, heatNames, heatSlug, indexHeat } from "../src/lib/heat.ts";
import { createHeatStore, type HeatFetcher } from "../src/store/heat.ts";
import { tierSortCards } from "../src/lib/wall-derive.ts";
import type { RepoHeat } from "../src/types.ts";

const heat = (slug: string, stars: number, source: RepoHeat["source"] = "fresh"): RepoHeat => ({
  slug,
  stars,
  forks: 0,
  source,
});

/** Lets a response be landed exactly when the test wants it, so "later" is a state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resumes the awaiting `load` continuations before the next assertion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("heat: 星标数按区间压缩，1–999 保持精确", () => {
  assert.equal(formatStars(0), "0");
  assert.equal(formatStars(999), "999");
  assert.equal(formatStars(1000), "1k");
  assert.equal(formatStars(1500), "1.5k");
  assert.equal(formatStars(10_000), "10k");
  assert.equal(formatStars(25_400), "25k");
  assert.equal(formatStars(1_200_000), "1.2M");
  assert.equal(formatStars(2_500_000_000), "2.5B");
  // Garbage in, "0" out: a NaN star count must not render `NaNk` on a card.
  assert.equal(formatStars(Number.NaN), "0");
  assert.equal(formatStars(-5), "0");
});

test("heat: 未确认的数字带 ~，确认过的不带", () => {
  assert.equal(heatBadgeOf(undefined), null, "no answer means no badge");
  assert.equal(heatBadgeOf(heat("a/b", 1200, "fresh"))!.text, "1.2k");
  assert.equal(heatBadgeOf(heat("a/b", 1200, "fresh"))!.unconfirmed, false);
  // A 304 is the *server* confirming the copy we hold — that counts as confirmed.
  assert.equal(heatBadgeOf(heat("a/b", 1200, "revalidated"))!.unconfirmed, false);
  assert.equal(heatBadgeOf(heat("a/b", 1200, "cached"))!.unconfirmed, true);
  assert.equal(heatBadgeOf(heat("a/b", 1200, "failed"))!.unconfirmed, true);
  // 0 is a fact, not an absence: GitHub answers 0 for a repository nobody starred.
  assert.equal(heatBadgeOf(heat("a/b", 0, "fresh"))!.text, "0");
  // A failed round that holds nothing at all stays silent rather than showing `★0`.
  assert.equal(heatBadgeOf(heat("a/b", 0, "failed")), null);
});

test("heat: 批次上限与 Rust 侧 HEAT_BATCH_CAP 必须是同一个数", () => {
  const rs = readFileSync("src-tauri/src/heat.rs", "utf8");
  const declared = /pub const HEAT_BATCH_CAP: usize = (\d+);/.exec(rs)?.[1];
  assert.ok(declared, "src-tauri/src/heat.rs no longer declares HEAT_BATCH_CAP in the shape this test can read");
  assert.equal(
    HEAT_UI_CAP,
    Number(declared),
    `前端会发 ${HEAT_UI_CAP} 个名字而后端只处理 ${declared} 个：多出来的磁贴永远不填，且没有任何地方说明原因`,
  );
});

test("heat: 名字表按墙的顺序取，跳过不完整的，截到上限", () => {
  assert.equal(heatSlug("octocat", "Hello-World"), "octocat/Hello-World");
  const cards = Array.from({ length: HEAT_UI_CAP + 10 }, (_, i) => ({ owner: `o${i}`, repo: `r${i}` }));
  const names = heatNames(cards);
  assert.equal(names.length, HEAT_UI_CAP);
  assert.equal(names[0], "o0/r0", "the first tiles are the ones most likely to be looked at");
  assert.equal(names[HEAT_UI_CAP - 1], `o${HEAT_UI_CAP - 1}/r${HEAT_UI_CAP - 1}`);
  assert.deepEqual(heatNames([{ owner: "", repo: "x" }, { owner: "y", repo: "" }]), [], "an incomplete identity is not askable");
});

test("heat: indexHeat 忽略空 slug，不忽略 0 星", () => {
  const idx = indexHeat([heat("a/b", 0), { ...heat("c/d", 5), slug: "" }]);
  assert.deepEqual(Object.keys(idx), ["a/b"]);
});

test("heat: 排序把「没问过」排在「0 星」之后", () => {
  const cards = [
    { slug: "h/a/b", repo: "b", owner: "a" },
    { slug: "h/c/d", repo: "d", owner: "c" },
    { slug: "h/e/f", repo: "f", owner: "e" },
  ];
  const by = tierSortCards(cards, {
    sort: "stars",
    usage: {},
    metaBySlug: {},
    heatByOwnerRepo: { "a/b": heat("a/b", 0, "fresh"), "c/d": heat("c/d", 500, "cached") },
  });
  assert.deepEqual(by.map((c) => c.repo), ["d", "b", "f"], "500 星标 → 0 星标 → 从未取到");
  // No heat map at all must not throw, and must leave the name order intact.
  const bare = tierSortCards(cards, { sort: "stars", usage: {}, metaBySlug: {} });
  assert.deepEqual(bare.map((c) => c.repo), ["b", "d", "f"], "ties break by name, so a poll tick cannot reshuffle");
});

test("heat: 同一批名字在途时重复问，被丢弃而不是排队", async () => {
  let calls = 0;
  const gate = deferred<RepoHeat[]>();
  const fetcher: HeatFetcher = () => {
    calls += 1;
    return gate.promise;
  };
  const s = createHeatStore(fetcher);
  void s.getState().load(["a/b"]);
  void s.getState().load(["a/b"]);
  assert.equal(calls, 1, "墙的重绘会反复触发同一个批次，GitHub 不该看到两次");
  gate.resolve([heat("a/b", 1)]);
  await flush();
  assert.equal(s.getState().loading, false);
  assert.equal(s.getState().lastCount, 1);
});

test("heat: 早出发的那个响应整批作废，不能盖住晚出发的", async () => {
  const first = deferred<RepoHeat[]>();
  const second = deferred<RepoHeat[]>();
  const queue = [first.promise, second.promise];
  let n = 0;
  const s = createHeatStore(() => queue[n++]!);

  const a = s.getState().load(["a/b"]);
  await flush();
  const b = s.getState().load(["c/d"]);

  // The *second* request answers first; the older one is then discarded wholesale.
  second.resolve([heat("c/d", 20)]);
  await flush();
  assert.equal(s.getState().bySlug["c/d"]!.stars, 20);
  first.resolve([heat("a/b", 10), heat("c/d", 999)]);
  await Promise.all([a, b]);
  assert.equal(s.getState().bySlug["c/d"]!.stars, 20, "一个更旧的响应不能把较新的数字盖回去");
  assert.equal(
    s.getState().bySlug["a/b"],
    undefined,
    "整批作废是选出来的行为：晚的那一批就是墙当前显示的那一批，旧批次里独有的行下一次重绘会再问到",
  );
});

test("heat: 取数失败不弹任何窗，只让磁贴不显示数字", async () => {
  const s = createHeatStore(() => Promise.reject(new Error("找不到 curl")));
  await s.getState().load(["a/b"]);
  const state = s.getState();
  assert.equal(Object.keys(state.bySlug).length, 0);
  assert.equal(state.loading, false, "失败的批之后必须结束 loading，否则下一次普通请求永远进不去");
});
