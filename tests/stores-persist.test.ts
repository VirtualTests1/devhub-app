/**
 * `src/store/landing.ts` and `src/store/wall.ts` — the two persisted reducers
 * whose whole job is list hygiene (trim, dedupe, refuse junk from disk).
 *
 * `landing.ts` remembers only *explicit* 落位 overrides, which is the difference
 * between a useful dropdown and one full of the same computed path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";

import { atKey } from "./helpers/definite.ts";

installBrowserGlobals();

/** `readBack` reports "nothing stored" as null, which is a legitimate answer for the
 *  helper and not one these assertions can consume. Narrowing it here keeps the failure
 *  message specific to the key that came back empty. */
function nonNull(v: string | null, key: string): string {
  assert.notEqual(v, null, `${key} must have been written back`)
  // `assert.notEqual` does not narrow; `assert.ok` is the declared assertion.
  assert.ok(v !== null, `${key} must have been written back`)
  return v
}



type Landing = typeof import("../src/store/landing.ts");
type Wall = typeof import("../src/store/wall.ts");

const LANDING_KEY = "devhub.landing.v1";
const WALL_KEY = "devhub.wall.v1";

test("landing: first run is an empty history", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  assert.deepEqual(useLanding.getState().history, []);
});

test("landing: a remembered path is trimmed and prepended", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  useLanding.getState().remember("  D:\\项目\\opus  ");
  assert.deepEqual(useLanding.getState().history, ["D:\\项目\\opus"], "surrounding spaces are not part of the path");
});

test("landing: blank input is refused rather than stored as an entry", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  for (const blank of ["", "   ", "\t", "\n"]) {
    useLanding.getState().remember(blank);
  }
  assert.deepEqual(useLanding.getState().history, [], "a dropdown of empty rows is the bug");
});

test("landing: re-picking a path moves it to the front instead of duplicating it", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  useLanding.getState().remember("a");
  useLanding.getState().remember("b");
  useLanding.getState().remember("a");
  assert.deepEqual(useLanding.getState().history, ["a", "b"], "most recent first, exactly once");
});

test("landing: the list is capped at 8 entries", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  for (let i = 0; i < 15; i += 1) useLanding.getState().remember(`p${i}`);
  const h = useLanding.getState().history;
  assert.equal(h.length, 8);
  assert.equal(h[0], "p14", "newest first");
  assert.equal(h[7], "p7", "the oldest survivors are the 7 most recent before it");
});

test("landing: a corrupt stored value degrades to empty, not to a crash", async () => {
  const broken = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"), { [LANDING_KEY]: "[1,2," });
  assert.deepEqual(broken.useLanding.getState().history, []);

  // `JSON.parse` succeeding is not the same as the shape being usable.
  const notArray = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"), { [LANDING_KEY]: '{"a":1}' });
  assert.deepEqual(notArray.useLanding.getState().history, []);

  const junkItems = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"), {
    [LANDING_KEY]: JSON.stringify(["ok", 5, null, "", "  ", {}]),
  });
  assert.deepEqual(junkItems.useLanding.getState().history, ["ok"], "only non-blank strings survive");
});

test("landing: every remember is written back to storage", async () => {
  const { useLanding } = await importSeeded<Landing>(import.meta.resolve("../src/store/landing.ts"));
  useLanding.getState().remember("D:\\x");
  assert.deepEqual(JSON.parse(nonNull(readBack(LANDING_KEY), LANDING_KEY)), ["D:\\x"]);
});

test("wall: stored preferences are re-checked against the tables, not trusted", async () => {
  // readStored() validates `sort`/`filter`/`density` against SORTS/FILTERS/
  // WALL_DENSITIES precisely because "a stored id that no longer exists would
  // silently do nothing in the CSS".
  const bad = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"), {
    [WALL_KEY]: JSON.stringify({ prefs: { sort: "nope", filter: "also-nope", density: "huge", grouped: true } }),
  });
  const s = bad.useWall.getState();
  assert.equal(s.sort, "name");
  assert.equal(s.filter, "all");
  assert.equal(s.density, "standard");
  assert.equal(s.grouped, true, "a boolean is not an id and is kept as-is");
});

test("wall: a corrupt payload falls back to every default", async () => {
  const broken = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"), { [WALL_KEY]: "}}not json{{" });
  const s = broken.useWall.getState();
  assert.equal(s.sort, "name");
  assert.deepEqual(s.repos, {});
});

test("wall: setPref, pin and hide are persisted", async () => {
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));
  useWall.getState().setPref("sort", "size");
  useWall.getState().togglePin("github.com/o/r");
  useWall.getState().toggleHidden("github.com/o/r2");
  // Writes are coalesced (round 11, 落盘合批): a burst becomes one localStorage
  // write 250 ms later. `flushStorage` is the commit hook the module exposes for
  // exactly this — without it the read-back below would see nothing pending.
  flushStorage();
  const written = JSON.parse(nonNull(readBack(WALL_KEY), WALL_KEY));
  assert.equal(written.prefs.sort, "size");
  assert.equal(written.repos["github.com/o/r"].pinned, true);
  assert.equal(written.repos["github.com/o/r2"].hidden, true);
});

test("wall: setPref does NOT clear the dragged indices — resetOrder does", async () => {
  // The doc comment at the top of wall.ts promises "a chosen tier now clears
  // the indices", and the store itself does not do it: `ProjectsView.tsx:526`
  // pairs `resetOrder()` with `setPref("sort", v)` at the call site. Measured
  // here so the split is written down rather than assumed — any second caller
  // (the 设置 page, the command palette, a restored history context) that
  // forgets the reset silently reproduces 需求 1 "排序功能无法使用".
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));
  useWall.getState().applyOrder(["github.com/o/a", "github.com/o/b"]);
  assert.equal(atKey(useWall.getState().repos, "github.com/o/a").index, 0);

  useWall.getState().setPref("sort", "installed");
  assert.equal(
    atKey(useWall.getState().repos, "github.com/o/a").index,
    0,
    "the reducer keeps the overlay; clearing it is not its job today",
  );

  useWall.getState().resetOrder();
  // `resetOrder` strips the field and drops the entry when nothing is left, so
  // an entry that only carried a position disappears rather than lingering as
  // `{}` — the same residue rule `setRepo` applies.
  assert.equal("github.com/o/a" in useWall.getState().repos, false);
  assert.equal("github.com/o/b" in useWall.getState().repos, false);
});

test("wall: setRepo deletes an entry structurally, and keeps a cover-only one", async () => {
  // The comment in `setRepo` records the old bug: the emptiness test enumerated
  // alias/pinned/hidden/index by hand, so a 封面-only entry matched "empty" and
  // was deleted on the spot. Emptiness is now `every value is undefined/false`.
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));

  useWall.getState().setRepo("a", { cover: "D:\\img.png", coverFit: "contain" });
  assert.equal(atKey(useWall.getState().repos, "a").cover, "D:\\img.png", "a cosmetic field is still a change");

  useWall.getState().setRepo("a", { cover: undefined, coverFit: undefined });
  assert.equal("a" in useWall.getState().repos, false, "nothing left means the key goes");

  useWall.getState().setRepo("b", { pinned: true });
  useWall.getState().setRepo("b", { pinned: false });
  assert.equal("b" in useWall.getState().repos, false, "an off boolean is empty, not a residue");

  useWall.getState().setRepo("c", { index: 0 });
  assert.equal(atKey(useWall.getState().repos, "c").index, 0, "0 is a real position, not absent");

  useWall.getState().setRepo("d", { alias: "别名" });
  assert.equal(atKey(useWall.getState().repos, "d").alias, "别名", "an empty-looking string field is still set");
  useWall.getState().setRepo("d", { alias: "" });
  assert.equal(atKey(useWall.getState().repos, "d").alias, "", "the store does not invent a default for alias");
});

test("wall: resetOrder drops positions but keeps 置顶", async () => {
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));
  useWall.getState().applyOrder(["a", "b"]);
  useWall.getState().togglePin("a");
  useWall.getState().resetOrder();
  const s = useWall.getState();
  assert.equal(atKey(s.repos, "a").index, undefined, "position is gone");
  assert.equal(atKey(s.repos, "a").pinned, true, "置顶 is a per-item state, not an ordering mode");
});

test("wall: unhideAll and resetAll have different scopes", async () => {
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));
  useWall.getState().toggleHidden("a");
  useWall.getState().togglePin("b");
  useWall.getState().unhideAll();
  assert.equal(useWall.getState().repos["a"], undefined);
  assert.equal(atKey(useWall.getState().repos, "b").pinned, true, "unhide must not touch pins");

  useWall.getState().resetAll();
  const s = useWall.getState();
  assert.deepEqual(s.repos, {});
  assert.equal(s.sort, "name");
  assert.equal(s.density, "standard");
});

// ---------------------------------------------------------------------------
// r16-o2-2 — 拖拽写的是「整面墙的一条编号」，不是筛选子集的另一套编号。
//
// 缺陷：onDragEnd 曾把 `applyOverlay(tierSorted, …)` 这个**筛选后的可见子集**
// 交给 applyOrder，于是只有可见块被重新编号 0..n-1，被筛掉的卡片还揣着上一次
// 拖拽的编号；清掉筛选的瞬间两套编号交错插进同一段序号空间，卡片跳位，用户的
// 手工顺序被一次它没参与的拖拽静默改写。
// ---------------------------------------------------------------------------

test("wall: applyOrder 点名整段序列时，序列外的旧序号被剥掉而不是插进来", async () => {
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"), {
    [WALL_KEY]: JSON.stringify({
      repos: {
        a: { index: 7, pinned: true },
        b: { index: 8 },
        c: { index: 3, alias: "别名" },
        d: { index: 9 },
      },
    }),
  });

  // 一次「带搜索的拖拽」只点名了可见的两张卡。
  useWall.getState().applyOrder(["b", "a"]);
  const s = useWall.getState();
  assert.equal(atKey(s.repos, "b").index, 0, "被拖动的块拿到新序列的开头");
  assert.equal(atKey(s.repos, "a").index, 1);
  assert.equal(atKey(s.repos, "a").pinned, true, "序号之外的字段随条目原样保留");
  assert.equal(
    atKey(s.repos, "c").index,
    undefined,
    "序列外的旧序号必须剥掉：留着它就会插进 0/1 之间，清掉筛选后两套编号交错",
  );
  assert.equal(atKey(s.repos, "c").alias, "别名", "别名不是顺序字段，不能被这条规则顺手清掉");
  assert.equal("d" in s.repos, false, "只剩 index 的条目按结构性清空规则消失，不留 {}");

  flushStorage();
  const written = JSON.parse(nonNull(readBack(WALL_KEY), WALL_KEY));
  assert.equal(written.repos.a.index, 1, "新序列要落盘");
  assert.equal(written.repos.c?.index, undefined, "剥掉的序号也不能再写回磁盘");
});

test("wall: 整段序列落成一条 0..n-1 连号，每张卡恰好占一个位置", async () => {
  const { useWall } = await importSeeded<Wall>(import.meta.resolve("../src/store/wall.ts"));
  useWall.getState().setRepo("github.com/o/a", { alias: "A" });
  useWall.getState().setRepo("github.com/o/b", { pinned: true });
  useWall.getState().setRepo("github.com/o/c", { hidden: true });

  // ProjectsView 的 onDragEnd 现在交来的正是这样一条序列：moved 块在前，
  // 其余卡片（含被筛掉、被隐藏的）按当前相对顺序垫后，整体连号。
  useWall.getState().applyOrder(["github.com/o/b", "github.com/o/a", "github.com/o/c"]);
  const s = useWall.getState();
  const slugs = ["github.com/o/b", "github.com/o/a", "github.com/o/c"];
  assert.deepEqual(
    slugs.map((slug) => atKey(s.repos, slug).index),
    [0, 1, 2],
    "连号且覆盖整段序列——第二套编号在这份状态里没有任何存活空间",
  );
  assert.equal(atKey(s.repos, "github.com/o/b").pinned, true, "连号不吞掉置顶");
  assert.equal(atKey(s.repos, "github.com/o/c").hidden, true, "连号不吞掉隐藏");
});
