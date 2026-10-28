/**
 * `src/store/wall.ts` — the ordering overlay.
 *
 * The overlay is the whole 排序 story: 置顶 → 运行中 → dragged index → tier order.
 * Its comparator is the one piece of the wall that is pure, and it is also the
 * piece that round 9 (需求 1 "排序功能无法使用") rewrote, so it is worth locking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyOverlay, slugOf, WALL_DENSITIES, WALL_DENSITY_MIN, FILTERS, SORTS } from "../src/store/wall.ts";

type Card = { slug: string };
const cards = (...slugs: string[]): Card[] => slugs.map((slug) => ({ slug }));
const running = (...slugs: string[]) => ({ has: (s: string) => slugs.includes(s) });

test("slugOf matches the backend's canonical slug byte for byte", () => {
  assert.equal(slugOf({ host: "github.com", owner: "joeseesun", repo: "opus" }), "github.com/joeseesun/opus");
  // The slug is also the 常用 usage key and the join key against `RepoMeta`; a
  // different separator here silently disconnects all three.
  assert.equal(slugOf({ host: "gitee.com", owner: "a", repo: "b" }), "gitee.com/a/b");
});

test("applyOverlay: pinned floats to the front regardless of dragged index", () => {
  const out = applyOverlay(
    cards("a", "b", "c"),
    { a: { index: 0 }, c: { pinned: true, index: 9 } },
  );
  assert.deepEqual(out.map((c) => c.slug), ["c", "a", "b"]);
});

test("applyOverlay: running outranks a dragged index, but never 置顶", () => {
  const out = applyOverlay(
    cards("a", "b", "c", "d"),
    { a: { index: 0 }, b: { index: 1 }, c: { pinned: true, index: 5 } },
    running("d"),
  );
  assert.deepEqual(out.map((c) => c.slug), ["c", "d", "a", "b"]);
});

test("applyOverlay: without a running set, the running tier is skipped entirely", () => {
  // The `running?` parameter is what makes this a no-op rather than a crash:
  // passing nothing must not reorder anything against the index.
  const out = applyOverlay(cards("a", "b", "c"), { c: { index: 0 } });
  assert.deepEqual(out.map((c) => c.slug), ["c", "a", "b"]);
});

test("applyOverlay: unindexed cards keep the tier order they arrived in", () => {
  // This is the stability promise in the doc comment. Two cards with no index
  // compare as MAX_SAFE_INTEGER - MAX_SAFE_INTEGER = 0, so Array.sort's own
  // stability is what decides — and a poll tick must not shuffle them.
  const out = applyOverlay(cards("z", "y", "x"), {});
  assert.deepEqual(out.map((c) => c.slug), ["z", "y", "x"]);

  const twice = applyOverlay(cards("z", "y", "x"), {});
  assert.deepEqual(twice.map((c) => c.slug), ["z", "y", "x"], "repeatable, not a coin flip");
});

test("applyOverlay: indexed block precedes unindexed block", () => {
  // A repository downloaded afterwards has no index and lands *after* the
  // dragged ones, in tier order — not at the front, which is what made a fresh
  // clone look like it had been pinned.
  const out = applyOverlay(cards("new", "a", "b", "c"), { a: { index: 1 }, b: { index: 0 } });
  assert.deepEqual(out.map((c) => c.slug), ["b", "a", "new", "c"]);
});

test("applyOverlay: index 0 is not treated as absent", () => {
  // `sa.index ?? MAX` only rescues null/undefined, so 0 has to win. A `||` here
  // would silently send the first dragged card to the back of the wall.
  const out = applyOverlay(cards("a", "b"), { a: { index: 0 }, b: { index: 1 } });
  assert.deepEqual(out.map((c) => c.slug), ["a", "b"]);
});

test("applyOverlay: does not mutate the caller's array", () => {
  const input = cards("b", "a");
  const snapshot = input.map((c) => c.slug);
  applyOverlay(input, { a: { pinned: true } });
  assert.deepEqual(input.map((c) => c.slug), snapshot);
});

test("applyOverlay: hidden/cover fields are ordering-inert", () => {
  // Only pinned/index participate. If a future field leaked into the comparator
  // the wall would reorder on a cover change, which the user never asked for.
  const out = applyOverlay(cards("a", "b"), { a: { hidden: true, cover: "x.png", alias: "别名" } });
  assert.deepEqual(out.map((c) => c.slug), ["a", "b"]);
});

test("the 排序 / 筛选 / 密度 tables agree with the persisted value space", () => {
  // readStored() re-checks stored ids against exactly these three tables and
  // falls back when one is missing — so a table entry without a distinct id is
  // the bug that makes a stored preference unrestorable.
  const ids = (t: { id: string }[]) => t.map((x) => x.id);
  for (const t of [SORTS, FILTERS, WALL_DENSITIES]) {
    assert.equal(new Set(ids(t)).size, ids(t).length, "ids must be unique");
  }
  assert.deepEqual(new Set(Object.keys(WALL_DENSITY_MIN)), new Set(ids(WALL_DENSITIES)));
  // 标准 is the value the stylesheet measured, and 宽松 is the skin's own big
  // cover — swapping them is a silent re-layout at the minimum window width.
  assert.equal(WALL_DENSITY_MIN.compact, "168px");
  assert.equal(WALL_DENSITY_MIN.standard, "232px");
  assert.equal(WALL_DENSITY_MIN.large, "380px");
});

// --- 读回磁盘：prefs 与 repos 都不是可信输入 --------------------------------

type WallStore = typeof import("../src/store/wall.ts");
const { installBrowserGlobals, importSeeded } = await import("./helpers/storage.ts");
installBrowserGlobals();
const KEY = "devhub.wall.v1";
const loadWall = (seed: Record<string, string>) =>
  importSeeded<WallStore>(import.meta.resolve("../src/store/wall.ts"), seed);

test("readStored: junk prefs fall back field by field, not wholesale", async () => {
  const mod = await loadWall({
    [KEY]: JSON.stringify({
      prefs: { sort: "astrological-sign", filter: 7, grouped: "yes", density: "gigantic" },
    }),
  });
  const s = mod.useWall.getState();
  assert.equal(s.sort, "name");
  assert.equal(s.filter, "all");
  assert.equal(s.density, "standard");
  // `?? DEFAULT` would have kept `"yes"` — a truthy string that renders the
  // 按拥有者分段 toggle stuck on. Booleans get an explicit typeof check.
  assert.equal(s.grouped, false);
});

test("readStored: repo entries are re-checked field by field; junk is dropped", async () => {
  const mod = await loadWall({
    [KEY]: JSON.stringify({
      repos: {
        "github.com/good/repo": { pinned: true, index: 3, alias: "好仓库" },
        "github.com/bad/repo": { pinned: "yes", index: "abc", alias: 42, hidden: 1 },
        "github.com/junk/repo": "not-an-object",
        "github.com/empty/repo": {},
      },
    }),
  });
  const repos = mod.useWall.getState().repos;
  assert.deepEqual(repos["github.com/good/repo"], { pinned: true, index: 3, alias: "好仓库" });
  // Everything in the bad entry has the wrong type; the structural-empty check
  // in setRepo only understands undefined/false, so unsanitised junk would
  // have survived there forever.
  assert.equal("github.com/bad/repo" in repos, false);
  assert.equal("github.com/junk/repo" in repos, false);
  assert.equal("github.com/empty/repo" in repos, false);
});

test("readStored: cover fields keep their enums and numeric pairs", async () => {
  const mod = await loadWall({
    [KEY]: JSON.stringify({
      repos: {
        a: { cover: "C:\\pics\\a.png", coverFit: "blur", coverFocus: [0.3, 0.7], coverRatio: "16/9", coverLook: "mono" },
        b: { coverFit: "warp", coverFocus: [0.1, "x"], coverRatio: "7/5", coverLook: "neon" },
      },
    }),
  });
  const repos = mod.useWall.getState().repos;
  assert.deepEqual(repos.a, {
    cover: "C:\\pics\\a.png",
    coverFit: "blur",
    coverFocus: [0.3, 0.7],
    coverRatio: "16/9",
    coverLook: "mono",
  });
  // The enums and the pair are all-or-nothing: every field in b fails its
  // check, so the entry vanishes rather than carrying a half-valid
  // coverFocus into object-position.
  assert.equal("b" in repos, false);
});
