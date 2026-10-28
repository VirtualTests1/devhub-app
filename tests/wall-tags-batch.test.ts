/**
 * 批量打标签 / 批量去标签的纯函数（需求 N3-3）.
 *
 * `BatchBar` owns the fan-out and the per-item reporting; the view owns the store
 * write. What sits between them - what landed, what the cap refused, how much work
 * a card actually has for this verb - is `applyTagsTo` / `stripTagsFrom` /
 * `tagWorkFor` / `tagRemovalWorkFor` here, in the store module, for the two reasons
 * this repository already uses for the split: a `.tsx` is unreachable from Node
 * (`tests/lib-import-graph.test.ts`), and `BatchBar`'s own contract is that a batch
 * must be able to say *which* repositories did not do the whole thing. A claim like
 * "9 成功" computed by arithmetic on lengths rather than on the refused list is the
 * kind of claim these tests exist to make checkable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPO_TAG_LIMIT,
  applyTagsTo,
  stripTagsFrom,
  tagRemovalWorkFor,
  tagWorkFor,
} from "../src/store/wall.ts";
import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";

installBrowserGlobals();

type Wall = typeof import("../src/store/wall.ts");
const WALL_KEY = "devhub.wall.v1";
const resolveWall = () => import.meta.resolve("../src/store/wall.ts");

const full = (n = REPO_TAG_LIMIT) => Array.from({ length: n }, (_, i) => `t${i}`);

// --- appliesTo: the number that decides disabled-vs-enabled -----------------

test("tagWorkFor: 没有 chip 就是零工作，而不是「对全部卡片做没有效果的事」", () => {
  assert.equal(tagWorkFor(["后端"], []), 0, "未选标签时按钮必须禁用，这是 BatchBar 唯一的禁用依据");
  assert.equal(tagWorkFor(undefined, []), 0);
});

test("tagWorkFor: 已有的标签不计、上限封顶计入", () => {
  assert.equal(tagWorkFor(["后端"], ["后端"]), 0, "本来就有：没有要做的事");
  assert.equal(tagWorkFor(["后端"], ["后端", "Rust"]), 1);
  assert.equal(tagWorkFor(undefined, ["后端", "Rust"]), 2);
  assert.equal(tagWorkFor(full(), ["新标签"]), 0, "满了就没有工作，而不是工作完再丢掉一个");
  assert.equal(tagWorkFor(full(REPO_TAG_LIMIT - 2), ["a", "b", "c"]), 2, "只算装得下的那两个");
});

test("tagWorkFor: 大小写与空白按同一套规则，重复 chip 不重复计工", () => {
  assert.equal(tagWorkFor(["Rust"], ["rust"]), 0);
  assert.equal(tagWorkFor(["Rust"], [" RUST "]), 0);
  assert.equal(tagWorkFor([], ["后端", "后端"]), 1, "词汇里不会出现两次，工数也不能出现两次");
});

test("tagRemovalWorkFor: 只数真在这张卡上的标签", () => {
  assert.equal(tagRemovalWorkFor(["后端", "Rust"], ["后端"]), 1);
  assert.equal(tagRemovalWorkFor(["后端"], ["前端"]), 0, "没有的东西谈不上移除");
  assert.equal(tagRemovalWorkFor(undefined, ["前端"]), 0);
  assert.equal(tagRemovalWorkFor(["Rust"], ["rust"]), 1, "RUST 和 rust 是同一个标签");
  assert.equal(tagRemovalWorkFor(["后端", "Rust"], ["后端", "Rust", "前端"]), 2);
});

// --- applyTagsTo: what landed, what was refused -----------------------------

test("applyTagsTo: 一次加上多个，顺序按点选顺序报告", () => {
  const r = applyTagsTo(["已有"], ["后端", "Rust", "已有"]);
  assert.deepEqual(r.added, ["后端", "Rust"]);
  assert.deepEqual(r.refused, [], "本来就有的既不算加上也不算被拒");
  assert.deepEqual(r.next, ["已有", "后端", "Rust"]);
});

test("applyTagsTo: 上限只挡住后面的，前面的照常落地", () => {
  const r = applyTagsTo(full(REPO_TAG_LIMIT - 1), ["装得下", "装不下"]);
  assert.deepEqual(r.added, ["装得下"]);
  assert.deepEqual(r.refused, ["装不下"]);
  assert.equal(r.next?.length, REPO_TAG_LIMIT);
  assert.equal(r.next?.includes("装不下"), false);
});

test("applyTagsTo: 一个都装不下时 added 为空，界面才有依据说「一个也没加上」", () => {
  const r = applyTagsTo(full(), ["新"]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.refused, ["新"]);
  assert.deepEqual(r.next, full(), "next 必须原样，不能是个被截短过的列表");
});

test("applyTagsTo: 全部本来就有时 added/refused 双空", () => {
  const r = applyTagsTo(["a", "b"], ["a", "b"]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.next, ["a", "b"]);
});

test("applyTagsTo: 非法输入既不算加上也不算被拒", () => {
  const r = applyTagsTo(["留下"], ["  ", 42 as unknown as string, null as unknown as string, "加上"]);
  assert.deepEqual(r.added, ["加上"]);
  assert.deepEqual(r.refused, [], "垃圾不是「被上限挡住」，报成挡住会撒一个关于容量的谎");
  assert.deepEqual(r.next, ["留下", "加上"]);
});

test("applyTagsTo: 空白与大小写不同的同一标签合并成一次", () => {
  const r = applyTagsTo([], ["后端", " 后端 ", "BACKEND", "backend"]);
  assert.deepEqual(r.added, ["后端", "BACKEND"], "去重是忽略大小写的，只剩两个");
  assert.deepEqual(r.refused, []);
});

// --- stripTagsFrom ---------------------------------------------------------

test("stripTagsFrom: 只摘掉真在的，最后一个摘掉后 next 为 null", () => {
  // `removed` is the card's own spelling, because that is the string that left it -
  // echoing the clicked chip back would print `rust` about a card that read `Rust`.
  assert.deepEqual(stripTagsFrom(["后端", "Rust"], ["rust", "并不在"]), {
    next: ["后端"],
    removed: ["Rust"],
  });
  assert.deepEqual(stripTagsFrom(["后端"], ["后端"]), { next: null, removed: ["后端"] });
  assert.deepEqual(stripTagsFrom(undefined, ["后端"]), { next: null, removed: [] });
  assert.deepEqual(stripTagsFrom(["a"], ["  ", 7 as unknown as string]), { next: ["a"], removed: [] });
  assert.deepEqual(
    stripTagsFrom(["a", "b"], ["a", "A"]).removed,
    ["a"],
    "同一个标签点了两次也只摘一次，报告不能数出两个",
  );
});

test("stripTagsFrom: 移除全部 chip 得到 null，条目才会按既有清空规则消失", () => {
  const { next } = stripTagsFrom(["a", "b"], ["a", "b"]);
  assert.equal(next, null, "留一个 [] 会让这张卡带着空字段继续占存储和一个导出条目");
});

// --- the write these pure functions feed ----------------------------------

test("批量一步的效果落到磁盘上就是纯函数的结果（不靠界面补一遍）", async () => {
  const { useWall, applyTagsTo, tagWorkFor } = await importSeeded<Wall>(resolveWall());
  const picked = "github.com/o/batch";
  const untouched = "github.com/o/off-wall";
  useWall.getState().setRepo(picked, { alias: "B" });
  useWall.getState().setRepo(untouched, { alias: "O" });

  const chips = ["后端", "Rust"];
  // One card of the selection, one step - exactly what `BatchBar` calls per item.
  const tags = useWall.getState().repos[picked]?.tags;
  assert.equal(tagWorkFor(tags, chips), 2, "两张空白标签的位置，所以这一步有活干");
  const { next, added } = applyTagsTo(tags, chips);
  useWall.getState().setRepo(picked, { tags: next ?? undefined });
  assert.equal(added.length, 2);
  flushStorage();
  const written = JSON.parse(readBack(WALL_KEY) ?? "{}") as {
    repos: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(written.repos[picked], { alias: "B", tags: ["后端", "Rust"] });
  assert.deepEqual(written.repos[untouched], { alias: "O" }, "没选中的卡片不该被顺手打上新标签");
});

test("批量去标签把最后一个摘掉后，条目整体消失而不是留 tags:[]", async () => {
  const { useWall, stripTagsFrom } = await importSeeded<Wall>(resolveWall());
  const slug = "github.com/o/drop";
  useWall.getState().setRepo(slug, { tags: ["后端"] });
  const { next } = stripTagsFrom(useWall.getState().repos[slug]?.tags, ["后端"]);
  useWall.getState().setRepo(slug, { tags: next ?? undefined });
  flushStorage();
  const written = JSON.parse(readBack(WALL_KEY) ?? "{}") as { repos: Record<string, unknown> };
  assert.equal(slug in written.repos, false);
});

// --- batch -> filter, the loop the feature is actually for ------------------

test("appliesTo 的工数就是这一步真会做的事（按钮不会为假原因禁用）", () => {
  const cases: { tags: string[] | undefined; chips: string[] }[] = [
    { tags: undefined, chips: [] },
    { tags: undefined, chips: ["a"] },
    { tags: ["a"], chips: ["a"] },
    { tags: ["a"], chips: ["a", "b", "b"] },
    { tags: full(), chips: ["c"] },
    { tags: full(REPO_TAG_LIMIT - 3), chips: ["c", "d", "e", "f"] },
    { tags: full(), chips: ["a"] },
    { tags: ["A", "b"], chips: ["a", "B", "zz"] },
  ];
  for (const { tags, chips } of cases) {
    const add = applyTagsTo(tags, chips);
    assert.equal(tagWorkFor(tags, chips), add.added.length, `加了 ${JSON.stringify(chips)}`);
    const strip = stripTagsFrom(tags, chips);
    assert.equal(tagRemovalWorkFor(tags, chips), strip.removed.length, `去了 ${JSON.stringify(chips)}`);
    // 有活干 ⇔ 按钮可点，两边必须是同一个判断。
    assert.equal(tagWorkFor(tags, chips) > 0, add.added.length > 0);
  }
});

test("加上再去掉回到原点，去掉不存在的标签不动任何字节", () => {
  const start: string[] | undefined = ["后端", "Rust"];
  const added = applyTagsTo(start, ["前端", "临时"]);
  assert.deepEqual(added.added, ["前端", "临时"]);
  const back = stripTagsFrom(added.next, ["并不在", "临时", "前端"]);
  assert.deepEqual(back.removed, ["临时", "前端"], "报告按点选顺序，不存在的不在里面");
  assert.deepEqual(back.next, start, "去掉刚加上的两个，卡片回到原样");
});

test("批量打上标签之后，按该标签筛选立刻把卡片筛出来（不需要重载）", async () => {
  const { useWall, applyTagsTo, matchesTagFilter, tagVocabulary } = await importSeeded<Wall>(
    resolveWall(),
  );
  const chips = ["后端"];
  const picked = ["github.com/o/a", "github.com/o/b", "github.com/o/c"];
  for (const slug of picked) useWall.getState().setRepo(slug, { alias: slug });

  // Nothing carries the tag yet, so a chip for it would not even be on screen.
  assert.deepEqual(tagVocabulary(useWall.getState().repos), []);
  assert.equal(
    picked.filter((s) => matchesTagFilter(useWall.getState().repos[s]?.tags, chips)).length,
    0,
  );

  for (const slug of picked.slice(0, 2)) {
    const { next } = applyTagsTo(useWall.getState().repos[slug]?.tags, chips);
    useWall.getState().setRepo(slug, { tags: next ?? undefined });
  }

  const states = useWall.getState().repos;
  assert.deepEqual(tagVocabulary(states), [{ tag: "后端", count: 2 }], "chip 的计数就是刚打上的两张");
  assert.deepEqual(
    picked.filter((s) => matchesTagFilter(states[s]?.tags, chips)),
    picked.slice(0, 2),
    "第三张没被打上，就必须留在筛选结果之外",
  );
});
