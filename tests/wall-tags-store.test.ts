/**
 * 标签在 `src/store/wall.ts` 里的装载与落盘（需求 N3-1 / N3-3）.
 *
 * The import path gets its own file because it is a *different* reader from
 * `wall-xfer.ts`: `readStored()` runs against this device's localStorage, which may
 * hold a blob written by a build from before tags, and `persist()` is what decides
 * whether an edit survives the next launch. Both are exercised through the real
 * store via `tests/helpers/storage.ts`, not against the pure functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { flushStorage } from "../src/lib/storage.ts";
import { REPO_TAG_LIMIT } from "../src/store/wall.ts";

import { atKey } from "./helpers/definite.ts";

type Repo = typeof import("../src/store/wall.ts");

installBrowserGlobals();

const WALL_KEY = "devhub.wall.v1";
const resolveWall = () => import.meta.resolve("../src/store/wall.ts");

function stored(key: string): Record<string, unknown> {
  flushStorage();
  const raw = readBack(key);
  assert.ok(raw !== null, `${key} should have been written`);
  return JSON.parse(raw) as Record<string, unknown>;
}

function reposOf(key: string): Record<string, Record<string, unknown>> {
  return (stored(key).repos ?? {}) as Record<string, Record<string, unknown>>;
}

// --- readStored: the old-blob path -----------------------------------------

test("装载：老 storage 里没有任何 tags，照常读出不报错", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall(), {
    [WALL_KEY]: JSON.stringify({
      prefs: { sort: "size", filter: "opened", grouped: true, density: "large" },
      repos: { a: { alias: "A", pinned: true, index: 1 }, b: { hidden: true } },
    }),
  });
  const s = useWall.getState();
  assert.equal(s.sort, "size");
  assert.deepEqual(s.repos.a, { alias: "A", pinned: true, index: 1 });
  assert.equal("tags" in atKey(s.repos, "a"), false, "缺失的标签不是空数组");
});

test("装载：tags 经过与导入同一套净化（去空、去重、截断、丢非法）", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const { useWall } = await importSeeded<Repo>(resolveWall(), {
    [WALL_KEY]: JSON.stringify({
      repos: {
        dedupe: { tags: [" 后端 ", "后端", "Rust", "rust"] },
        capped: { tags: many },
        junk: { tags: [1, null, "", {}, "留下"] },
        wrongType: { alias: "A", tags: "不是数组" },
        emptyList: { alias: "A", tags: [] },
      },
    }),
  });
  const r = useWall.getState().repos;
  assert.deepEqual(atKey(r, "dedupe").tags, ["后端", "Rust"]);
  assert.equal(atKey(r, "capped").tags?.length, REPO_TAG_LIMIT);
  assert.deepEqual(atKey(r, "junk").tags, ["留下"]);
  assert.deepEqual(r.wrongType, { alias: "A" }, "非数组整键丢弃，alias 不受牵连");
  assert.deepEqual(r.emptyList, { alias: "A" }, "空列表折成「无此键」");
});

test("装载：只有 tags 的条目算有内容，只有空 tags 的条目才算空", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall(), {
    [WALL_KEY]: JSON.stringify({ repos: { tagged: { tags: ["后端"] }, ghost: { tags: [] } } }),
  });
  const r = useWall.getState().repos;
  assert.deepEqual(r.tagged, { tags: ["后端"] });
  assert.equal("ghost" in r, false, "tags:[] 净化后没有字段，条目不该占位");
});

// --- setRepo: the write path ----------------------------------------------

test("落盘：setRepo 写入 tags 会按既有惯例持久化", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  useWall.getState().setRepo("github.com/o/a", { tags: ["后端", "Rust"] });
  assert.deepEqual(reposOf(WALL_KEY)["github.com/o/a"], { tags: ["后端", "Rust"] });
});

test("落盘：清空最后一个标签是删键，不是留一个 tags:[]", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  const slug = "github.com/o/a";
  useWall.getState().setRepo(slug, { alias: "A", tags: ["后端"] });
  useWall.getState().setRepo(slug, { tags: [] });
  assert.deepEqual(reposOf(WALL_KEY)[slug], { alias: "A" }, "alias 是别的事实，不该被清标签带走");
  assert.equal("tags" in (reposOf(WALL_KEY)[slug] ?? {}), false);
});

test("落盘：一个只剩空 tags 的条目整体消失，不留 {} 占位", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  const slug = "github.com/o/only";
  useWall.getState().setRepo(slug, { tags: ["后端"] });
  assert.ok(slug in reposOf(WALL_KEY));
  useWall.getState().setRepo(slug, { tags: [] });
  assert.equal(slug in reposOf(WALL_KEY), false, "结构性清空规则同样适用于 tags");
});

test("落盘：undefined 的 tags 同样被当作关闭，不留幽灵键", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  const slug = "github.com/o/ghost";
  useWall.getState().setRepo(slug, { alias: "A", tags: ["后端"] });
  useWall.getState().setRepo(slug, { tags: undefined });
  const written = atKey(reposOf(WALL_KEY), slug);
  assert.deepEqual(written, { alias: "A" });
  assert.equal("tags" in written, false, "JSON 会丢掉 undefined，但内存里的键要一起清掉");
});

test("落盘：写入侧不重复净化，但数量与空白由纯函数把关", async () => {
  const { useWall, addRepoTag, removeRepoTag } = await importSeeded<Repo>(resolveWall());
  const slug = "github.com/o/flow";
  let tags: string[] | undefined;
  for (const raw of ["后端", " 后端 ", "Rust", "", "前端", "前端"]) {
    tags = addRepoTag(tags, raw) ?? undefined;
  }
  useWall.getState().setRepo(slug, { tags });
  assert.deepEqual(reposOf(WALL_KEY)[slug], { tags: ["后端", "Rust", "前端"] });
  tags = removeRepoTag(tags, "rust") ?? undefined;
  useWall.getState().setRepo(slug, { tags });
  assert.deepEqual(reposOf(WALL_KEY)[slug], { tags: ["后端", "前端"] });
});

// --- the other reducers must not lose tags -------------------------------

test("applyOrder 剥序号时保留 tags：一次拖拽不该改掉用户打的标签", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall(), {
    [WALL_KEY]: JSON.stringify({ repos: { a: { index: 4, tags: ["后端"] }, b: { index: 9 } } }),
  });
  useWall.getState().applyOrder(["b", "a"]);
  const r = useWall.getState().repos;
  assert.equal(atKey(r, "a").index, 1);
  assert.deepEqual(atKey(r, "a").tags, ["后端"], "标签不是顺序字段，和 alias 一样要活下来");
  assert.deepEqual(reposOf(WALL_KEY).a, { tags: ["后端"], index: 1 });
});

test("resetOrder / unhideAll 只剥自己管的那个字段", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall(), {
    [WALL_KEY]: JSON.stringify({
      repos: { a: { index: 2, tags: ["后端"] }, b: { hidden: true, tags: ["前端"] } },
    }),
  });
  useWall.getState().resetOrder();
  assert.deepEqual(useWall.getState().repos.a, { tags: ["后端"] });
  useWall.getState().unhideAll();
  assert.deepEqual(useWall.getState().repos.b, { tags: ["前端"] });
});

test("togglePin / toggleHidden 用 spread 合并，不会覆盖 tags", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  const slug = "github.com/o/keep";
  useWall.getState().setRepo(slug, { tags: ["后端"] });
  useWall.getState().togglePin(slug);
  useWall.getState().toggleHidden(slug);
  assert.deepEqual(useWall.getState().repos[slug], { tags: ["后端"], pinned: true, hidden: true });
});

test("导入（applyXfer）把 tags 一并换过来，并原样落盘", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  useWall.getState().applyXfer({ sort: "size" }, { a: { tags: ["后端"], pinned: true } });
  const s = useWall.getState();
  assert.equal(s.sort, "size");
  assert.deepEqual(s.repos.a, { tags: ["后端"], pinned: true });
  assert.deepEqual(reposOf(WALL_KEY).a, { tags: ["后端"], pinned: true });
});

test("resetAll 连 tags 一起回到出厂状态", async () => {
  const { useWall } = await importSeeded<Repo>(resolveWall());
  useWall.getState().setRepo("a", { tags: ["后端"] });
  useWall.getState().resetAll();
  assert.deepEqual(useWall.getState().repos, {});
  assert.deepEqual(reposOf(WALL_KEY), {}, "落盘的也不能残");
});
