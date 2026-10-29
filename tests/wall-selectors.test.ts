/**
 * `src/store/wall.ts` 的排序/筛选选择器——补 `wall-overlay.test.ts` 没钉的那几面。
 *
 * 先说清楚「选择器」到底在哪：`SortId`/`FilterId` 这两个 id 集在 :57-68 声明，八个
 * tier 的**比较器却写在 `views/ProjectsView.tsx:236-276`**（一个 `.tsx`）。按
 * `tests/lib-import-graph.test.ts` 立的规矩，Node 跑不了 `.tsx`，所以「按大小/安装时间
 * 怎么排」这一层在这里根本不可测；能测的纯选择器只有 `applyOverlay`（把已按 tier 排好
 * 的列表再叠上 置顶→运行中→拖拽序号 的覆盖层）。这个文件就专门钉 `applyOverlay` 里
 * `wall-overlay.test.ts` 还没走到的角落，以及那两个 id 集本身。
 *
 * 跨语言对照（只读，不跑 cargo）：`src-tauri/src/lib.rs` 的 `mod tests` 里**没有**任何
 * 覆盖层/排序测试——它跟墙沾边的只有删除守卫 `the_delete_guard_allows_...`（:6181-6208）
 * 断言的 `!href.slug().is_empty()`，那是路径自洽性，不是顺序。也就是说 `applyOverlay`
 * 的次序契约只在 TS 侧被钉住，这份文件加上 `wall-overlay.test.ts` 是它唯一的锁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyOverlay,
  coerceWallPref,
  FILTERS,
  slugOf,
  SORTS,
  WALL_DENSITIES,
} from "../src/store/wall.ts";

type Card = { slug: string; tier?: number };
const cards = (...slugs: string[]): Card[] => slugs.map((slug) => ({ slug }));
const running = (...slugs: string[]) => ({ has: (s: string) => slugs.includes(s) });
const order = (out: Card[]) => out.map((c) => c.slug);

// --- 相等 key 的稳定性：Array.sort 稳定是这套次序的地基 ------------------------
// `wall-overlay.test.ts` 已证「未编号卡片保持到达顺序」。这里钉的是每一个 rank 内部
// 打平时也一样稳：poll tick 每 250ms 重排一次，打平若不稳就会肉眼可见地乱跳。

test("applyOverlay: 两个置顶、都无序号——保持到达顺序（pinned 块打平稳定）", () => {
  const out = applyOverlay(cards("p1", "p2", "x"), { p1: { pinned: true }, p2: { pinned: true } });
  assert.deepEqual(order(out), ["p1", "p2", "x"], "p1 先到就先，不是抛硬币");
  // 反向输入也应各自保持，证明稳的是「到达顺序」而非某个巧合。
  assert.deepEqual(order(applyOverlay(cards("p2", "p1", "x"), { p1: { pinned: true }, p2: { pinned: true } })), ["p2", "p1", "x"]);
});

test("applyOverlay: 两个运行中——保持到达顺序（running 块打平稳定）", () => {
  const out = applyOverlay(cards("r1", "r2", "y"), {}, running("r1", "r2"));
  assert.deepEqual(order(out), ["r1", "r2", "y"]);
});

test("applyOverlay: 相同序号——保持到达顺序（index 块打平稳定）", () => {
  // ia - ib = 0 时比较器返回 0，靠的是 Array.sort 自身的稳定性。两张卡都被赋予同一个
  // 序号（理论上不该发生，但 dnd 半途或导入叠加能造出来），谁前谁后必须是确定值。
  const out = applyOverlay(cards("a", "b", "c"), { a: { index: 4 }, b: { index: 4 } });
  assert.deepEqual(order(out), ["a", "b", "c"], "同序号 a 先到在前，c 无序号垫底");
});

// --- 整张次序格：置顶 → 运行中 → 序号 → tier 一次跑通 ---------------------------

test("applyOverlay: 四个 rank 同场竞技，一次断言整条次序", () => {
  // P2 是「置顶且带序号5」，P1 是「置顶无序号(=MAX)」——同属置顶块，块内再按序号，
  // 所以 P2 先于 P1。R1 只「运行中」不置顶，rank 高于任何带序号的非运行卡，故排在
  // 两个 pinned 之后、I0/I1 之前。I0<I1 按序号，U 无序号垫底、保持到达位。
  const out = applyOverlay(
    cards("P1", "P2", "R1", "I0", "I1", "U"),
    { P1: { pinned: true }, P2: { pinned: true, index: 5 }, I0: { index: 0 }, I1: { index: 1 } },
    running("R1"),
  );
  assert.deepEqual(order(out), ["P2", "P1", "R1", "I0", "I1", "U"]);
});

// --- hidden × pinned：覆盖层不筛隐藏，分工在视图 -------------------------------

test("applyOverlay: hidden 与顺序彻底无关——被隐藏的置顶卡照样浮到最前", () => {
  // 这是「store 排序、视图过滤」的职责切分：ProjectsView 先 `cards.filter(!hidden)`
  // 再交给 overlay。所以单看 applyOverlay，hidden:true 不降级、不移除。钉住它，免得
  // 有人误以为 overlay 会顺手把隐藏卡沉底，从而在两处各过滤一次互相打架。
  const out = applyOverlay(cards("h", "n"), { h: { pinned: true, hidden: true } });
  assert.deepEqual(order(out), ["h", "n"], "h 既 hidden 又 pinned：overlay 只看 pinned，仍置顶");
});

test("applyOverlay: hidden 单独出现绝不改变顺序", () => {
  const out = applyOverlay(cards("a", "b", "c"), { a: { hidden: true }, b: { hidden: true } });
  assert.deepEqual(order(out), ["a", "b", "c"]);
});

// --- id 集（:57-68）：表的取值就是类型并集，validator 必须全表通过 -------------

test("SORTS / FILTERS / 密度的 id 恰好等于声明的 id 集", () => {
  // 比较器与 readStored() 都按字符串 id 分派；表里加/减一行而类型没跟上（或反过来），
  // 就是「存了个 CSS 里根本不存在的档位、静默不生效」那个老 bug 的近亲。逐字钉住取值。
  // 11 档 = 基础 8 + frequent（r19-C2 本线）+ desc（r19-C2 o1-add 线）+ stars（r18-N4 master 线）。
  assert.deepEqual(SORTS.map((s) => s.id), ["name", "recent", "frequent", "owner", "installed", "size", "language", "category", "cache", "desc", "stars"]);
  assert.deepEqual(FILTERS.map((f) => f.id), ["all", "opened", "unopened", "running"]);
  assert.deepEqual(WALL_DENSITIES.map((d) => d.id), ["compact", "standard", "large"]);
});

test("coerceWallPref 对整张 id 集全通过，对表外的近似值全丢弃", () => {
  for (const s of SORTS) assert.equal(coerceWallPref({ sort: s.id }).sort, s.id, `sort ${s.id} 应被接受`);
  for (const f of FILTERS) assert.equal(coerceWallPref({ filter: f.id }).filter, f.id, `filter ${f.id} 应被接受`);
  for (const d of WALL_DENSITIES) assert.equal(coerceWallPref({ density: d.id }).density, d.id, `density ${d.id} 应被接受`);
  // 差一点点的值不属于并集：不能因为前缀相同就放行。
  assert.equal(coerceWallPref({ sort: "installedx" }).sort, undefined);
  assert.equal(coerceWallPref({ filter: "opened2" }).filter, undefined);
  assert.equal(coerceWallPref({ density: "medium" }).density, undefined);
});

// --- 与 Rust 删除守卫共享的那条 slug 不变式（读 lib.rs:6196 得来，不跑 cargo）--

test("slugOf 对合法仓库永不产出空串——对齐 lib.rs:6196 的 !href.slug().is_empty()", () => {
  // Rust 侧 `the_delete_guard_allows_...` 依赖 slug 非空来保证 parent/prune 自洽；
  // 前端这边 slugOf 是同一个 slug 的来源，钉一条最直接的对应。不跑 cargo，只镜像断言。
  const slug = slugOf({ host: "github.com", owner: "carol", repo: "marked_only" });
  assert.ok(slug.length > 0, "slug 不能为空");
  assert.equal(slug, "github.com/carol/marked_only");
});

test("facets: language/category intersect with search and tags; missing metadata never matches", async () => {
  const { filterWallCards } = await import("../src/lib/wall-derive.ts");
  const cards = [
    { slug: "a", repo: "alpha", owner: "o", path: "D:/a" },
    { slug: "b", repo: "beta", owner: "o", path: "D:/b" },
    { slug: "c", repo: "gamma", owner: "o", path: "D:/c" },
  ];
  const ctx = {
    query: "",
    filter: "all" as const,
    states: { a: { tags: ["web"] }, b: { tags: ["web"] } },
    usage: {},
    running: { has: () => false },
    activeTags: ["web"],
    metaBySlug: {
      a: { language: "Rust", category: "rust" } as never,
      b: { language: "Python", category: "python" } as never,
    },
    language: "Rust",
    category: "",
  };
  assert.deepEqual(filterWallCards(cards, ctx).map((c) => c.slug), ["a"]);
  assert.deepEqual(
    filterWallCards(cards, { ...ctx, language: "", category: "python" }).map((c) => c.slug),
    ["b"],
  );
  assert.deepEqual(filterWallCards(cards, { ...ctx, language: "Rust", category: "python" }), []);
  // c has no metadata: it must never be pulled into a facet result.
  assert.deepEqual(
    filterWallCards(cards, { ...ctx, activeTags: [], language: "Rust" }).map((c) => c.slug),
    ["a"],
  );
});
