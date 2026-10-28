/**
 * The wall's derivation pipeline (`src/lib/wall-derive.ts`) — the filter, the
 * eight tier comparators and the owner grouping that used to sit inside
 * `views/ProjectsView.tsx` and were therefore untestable.
 *
 * `tests/wall-selectors.test.ts:5-9` records that gap by name; these are the
 * assertions it could not make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterWallCards,
  groupCardsByOwner,
  matchWallCard,
  tierSortCards,
  type WallCard,
  type WallMatchContext,
} from "../src/lib/wall-derive.ts";
import type { RepoMeta } from "../src/types.ts";

import { at } from "./helpers/definite.ts";

const card = (owner: string, repo: string, extra: Partial<WallCard> = {}): WallCard => ({
  slug: `github.com/${owner}/${repo}`,
  owner,
  repo,
  ...extra,
});

/** A full `RepoMeta` with only the compared fields spelled out per test. */
const meta = (slug: string, extra: Partial<RepoMeta> = {}): RepoMeta => ({
  slug,
  installedAt: 0,
  sizeBytes: 0,
  language: null,
  category: "unknown",
  hasCache: false,
  ...extra,
});

const ctx = (over: Partial<WallMatchContext> = {}): WallMatchContext => ({
  query: "",
  filter: "all",
  states: {},
  usage: {},
  running: { has: () => false },
  activeTags: [],
  ...over,
});

const order = (list: WallCard[]) => list.map((c) => c.repo);

// --- match: search -----------------------------------------------------------

test("matchWallCard:搜索命中名称、别名、拥有者、磁盘路径与标签里的任意一处", () => {
  const c = card("acme", "backend", { path: "/dev/acme/backend" });
  assert.equal(matchWallCard(c, ctx({ query: "back" })), true, "名称");
  assert.equal(matchWallCard(c, ctx({ query: "ACME" })), true, "拥有者，且大小写不敏感");
  assert.equal(matchWallCard(c, ctx({ query: "/dev/" })), true, "磁盘路径");
  assert.equal(
    matchWallCard(c, ctx({ query: "服务端", states: { [c.slug]: { alias: "服务端" } } })),
    true,
    "别名——卡片显示的是它，搜索就该搜得到它",
  );
  assert.equal(
    matchWallCard(c, ctx({ query: "后端", states: { [c.slug]: { tags: ["后端", "缓存"] } } })),
    true,
    "标签加入 haystack",
  );
  assert.equal(matchWallCard(c, ctx({ query: "没有这段" })), false);
});

// --- match: tag ∩ filter -----------------------------------------------------

test("matchWallCard:标签与筛选相交，而不是被运行中短路", () => {
  // The exact defect the view's comment warned about: an `if (filter === …) return`
  // placed before the tag test would make 标签 silently lose to 运行中.
  const running = { has: (slug: string) => slug.includes("running") };
  const tagged = card("acme", "running-tagged");
  const bare = card("acme", "running-bare");
  const onlyTags = ctx({ activeTags: ["后端"], running });
  assert.equal(matchWallCard(tagged, onlyTags), false, "运行中但没这个标签 → 不通过");
  assert.equal(matchWallCard(bare, onlyTags), false, "没标签 → 不通过");

  const withTag = ctx({
    activeTags: ["后端"],
    states: { [bare.slug]: { tags: ["后端"] } },
    running,
  });
  assert.equal(matchWallCard(bare, withTag), true, "两个条件都满足才通过");
});

test("matchWallCard:标签是 OR、空选择放行一切", () => {
  const c = card("acme", "x");
  const states = { [c.slug]: { tags: ["后端", "缓存"] } };
  assert.equal(matchWallCard(c, ctx({ activeTags: [] })), true, "没有选中任何 chip 就没有意见");
  assert.equal(matchWallCard(c, ctx({ activeTags: ["缓存"], states })), true, "命中其一即可");
  assert.equal(
    matchWallCard(c, ctx({ activeTags: ["前端", "缓存"], states })),
    true,
    "多 chip 是 OR 不是 AND",
  );
  assert.equal(matchWallCard(c, ctx({ activeTags: ["前端"], states })), false);
  assert.equal(matchWallCard(c, ctx({ activeTags: ["前端"] })), false, "卡片无标签 + 有 chip → 不通过");
});

test("matchWallCard:打开过 / 未打开过按记录是否存在", () => {
  const c = card("acme", "x");
  assert.equal(matchWallCard(c, ctx({ filter: "opened" })), false);
  assert.equal(matchWallCard(c, ctx({ filter: "unopened" })), true);
  const usage = { [`repo:${c.slug}`]: { count: 1, last: 1 } };
  assert.equal(matchWallCard(c, ctx({ filter: "opened", usage })), true);
  assert.equal(matchWallCard(c, ctx({ filter: "unopened", usage })), false);
});

test("matchWallCard:运行中查的是实时进程集合", () => {
  const c = card("acme", "x");
  assert.equal(matchWallCard(c, ctx({ filter: "running" })), false);
  assert.equal(matchWallCard(c, ctx({ filter: "running", running: { has: () => true } })), true);
});

test("filterWallCards 保持输入顺序，只丢掉不匹配的", () => {
  const visible = [card("acme", "a"), card("acme", "b"), card("acme", "c")];
  const usage = { [`repo:${at(visible, 1).slug}`]: { count: 1, last: 1 } };
  const out = filterWallCards(visible, ctx({ filter: "opened", usage }));
  assert.deepEqual(order(out), ["b"]);
});

// --- tier sort ---------------------------------------------------------------

test("tierSortCards:name 按名称升序", () => {
  const list = [card("acme", "c"), card("acme", "a"), card("acme", "b")];
  assert.deepEqual(order(tierSortCards(list, { sort: "name", usage: {}, metaBySlug: {} })), ["a", "b", "c"]);
});

test("tierSortCards:owner 先按拥有者再按名称", () => {
  const list = [card("zeta", "a"), card("acme", "b"), card("acme", "a")];
  const out = tierSortCards(list, { sort: "owner", usage: {}, metaBySlug: {} });
  assert.deepEqual(out.map((c) => `${c.owner}/${c.repo}`), ["acme/a", "acme/b", "zeta/a"]);
});

test("tierSortCards:recent 最新的在前，没有记录的垫底", () => {
  const list = [card("acme", "old"), card("acme", "never"), card("acme", "new")];
  const usage = {
    [`repo:${at(list, 0).slug}`]: { last: 100 },
    [`repo:${at(list, 2).slug}`]: { last: 900 },
  };
  assert.deepEqual(order(tierSortCards(list, { sort: "recent", usage, metaBySlug: {} })), [
    "new",
    "old",
    "never",
  ]);
});

// --- tier sort: 常用优先（r19-C2 注入的第九档）--------------------------------

const DAY = 86_400_000;

test("tierSortCards:frequent 按衰减分排序——今天一次胜过上月五次", () => {
  // 这正是选 usageScore 而不是裸 count 的理由，与 常用 页共享同一条公式：
  // count/(1+daysAgo)。nowMs 注入，测试钉死时钟而不是跟午夜赛跑。
  const now = 10_000 * DAY;
  const monthly5 = card("acme", "monthly5");
  const today1 = card("acme", "today1");
  const usage = {
    [`repo:${monthly5.slug}`]: { count: 5, last: now - 30 * DAY },
    [`repo:${today1.slug}`]: { count: 1, last: now },
  };
  const out = tierSortCards([monthly5, today1], { sort: "frequent", usage, metaBySlug: {}, nowMs: now });
  assert.deepEqual(order(out), ["today1", "monthly5"], "5/(1+30)≈0.16 < 1/(1+0)=1");
});

test("tierSortCards:frequent 没有记录或记录残缺的垫底，打平按名称", () => {
  const now = 10_000 * DAY;
  const zz = card("acme", "zz");
  const half = card("acme", "half");
  const list = [zz, card("acme", "never"), card("acme", "aa"), half];
  const usage = {
    [`repo:${zz.slug}`]: { count: 2, last: now - DAY },
    // half 只有一半字段：残缺记录拿 0 分，不得用 half-written 数据抢前排。
    [`repo:${half.slug}`]: { count: 99 },
  };
  const out = tierSortCards(list, { sort: "frequent", usage, metaBySlug: {}, nowMs: now });
  // zz 有分（2/(1+1)=1）独占前排；三个零分卡（never/half/无记录的 aa）打平按名称。
  assert.deepEqual(order(out), ["zz", "aa", "half", "never"]);
});

test("tierSortCards:frequent 不传 nowMs 也能排（默认时钟只影响衰减不影响序）", () => {
  // 同一分钟内的两次调用，序对任何 now 都一致——除非测试恰好跨天，所以
  // 这条只钉「有默认值、不抛错、序确定」，衰减的数值由上一条钉。
  const usage = {
    [`repo:${card("acme", "a").slug}`]: { count: 3, last: Date.now() - DAY },
    [`repo:${card("acme", "b").slug}`]: { count: 1, last: Date.now() - 400 * DAY },
  };
  const out = tierSortCards([card("acme", "a"), card("acme", "b")], { sort: "frequent", usage, metaBySlug: {} });
  assert.deepEqual(order(out), ["a", "b"]);
});

test("tierSortCards:installed / size 大者在前，未测量者垫底", () => {
  const list = [card("acme", "small"), card("acme", "unknown"), card("acme", "big")];
  const metaBySlug = {
    [at(list, 0).slug]: meta(at(list, 0).slug, { installedAt: 1, sizeBytes: 10 }),
    [at(list, 2).slug]: meta(at(list, 2).slug, { installedAt: 9, sizeBytes: 999 }),
  };
  assert.deepEqual(order(tierSortCards(list, { sort: "size", usage: {}, metaBySlug })), [
    "big",
    "small",
    "unknown",
  ]);
  assert.deepEqual(order(tierSortCards(list, { sort: "installed", usage: {}, metaBySlug })), [
    "big",
    "small",
    "unknown",
  ]);
});

test("tierSortCards:language / category 字母序，未知语言垫底而不是抢头名", () => {
  const list = [card("acme", "a"), card("acme", "b"), card("acme", "c")];
  const metaBySlug = {
    [at(list, 0).slug]: meta(at(list, 0).slug, { language: "Rust", category: "rust" }),
    [at(list, 1).slug]: meta(at(list, 1).slug, { language: "Go", category: "go" }),
  };
  assert.deepEqual(order(tierSortCards(list, { sort: "language", usage: {}, metaBySlug })), [
    "b",
    "a",
    "c",
  ]);
  assert.deepEqual(order(tierSortCards(list, { sort: "category", usage: {}, metaBySlug })), [
    "b",
    "a",
    "c",
  ]);
});

test("tierSortCards:cache 把带缓存的排前面", () => {
  const list = [card("acme", "cold"), card("acme", "warm")];
  const metaBySlug = { [at(list, 1).slug]: meta(at(list, 1).slug, { hasCache: true }) };
  assert.deepEqual(order(tierSortCards(list, { sort: "cache", usage: {}, metaBySlug })), [
    "warm",
    "cold",
  ]);
});

test("tierSortCards:相等键用名称打平，且不修改输入数组", () => {
  const list = [card("acme", "b"), card("acme", "a")];
  const copy = [...list];
  const out = tierSortCards(list, { sort: "size", usage: {}, metaBySlug: {} });
  assert.deepEqual(order(out), ["a", "b"], "两个未测量的卡片按名称打平，不是抛硬币");
  assert.deepEqual(list, copy, "输入未被原地排序");
  assert.notEqual(out, list, "返回的是副本");
});

// --- C2: desc sort -------------------------------------------------------------

test("tierSortCards:desc 按描述字母序（不区分大小写），空/缺描述沉底，同级按名称打平", () => {
  const list = [
    card("acme", "zeta", { description: "Backend service" }),
    card("acme", "alpha", { description: "Frontend app" }),
    card("acme", "mid", { description: "cli tool" }),
    card("acme", "empty", { description: "" }),
    card("acme", "none"),
  ];
  const out = tierSortCards(list, { sort: "desc", usage: {}, metaBySlug: {} });
  const repos = out.map((c) => c.repo);
  // "Backend service" (b), "cli tool" (c), "Frontend app" (f) — case-insensitive.
  // The two no-description cards sink to the bottom, in name order (empty, none).
  assert.equal(repos[0], "zeta", "Backend service (b) sorts first");
  assert.equal(repos[1], "mid", "cli tool (c) sorts second");
  assert.equal(repos[2], "alpha", "Frontend app (f) sorts third");
  assert.equal(repos[3], "empty", "empty-string description sinks, name order");
  assert.equal(repos[4], "none", "absent description sinks last, name order");
});

test("tierSortCards:desc 不修改输入数组", () => {
  const list = [
    card("acme", "b", { description: "bee" }),
    card("acme", "a", { description: "ant" }),
  ];
  const copy = [...list];
  const out = tierSortCards(list, { sort: "desc", usage: {}, metaBySlug: {} });
  assert.deepEqual(list, copy, "input not mutated");
  assert.notEqual(out, list, "returns a copy");
});

// --- group -------------------------------------------------------------------

test("groupCardsByOwner:按拥有者折叠，组序是首见顺序", () => {
  const sorted = [card("zeta", "z1"), card("acme", "a1"), card("zeta", "z2")];
  const groups = groupCardsByOwner(sorted);
  assert.deepEqual(
    groups.map(([owner, cards]) => [owner, cards.map((c) => c.repo)]),
    [
      ["zeta", ["z1", "z2"]],
      ["acme", ["a1"]],
    ],
    "组内保持到达顺序，组间保持首见顺序",
  );
});
