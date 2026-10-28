/**
 * r21-n2-2 — the description producer: absorbing `RepoHit.description` from
 * flows that already paid for it (`search_repositories`,
 * `list_starred_repos`), keyed by wall slug, with the degradation path pinned:
 * a corpus with no description for a card indexes and searches exactly as
 * before — the absent field is empty, never an error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CORPUS_DESCRIPTION_CAP,
  absorbDescriptions,
  corpusEntryOf,
  type CorpusExtras,
} from "../src/lib/corpus.ts";
import { buildLocalIndex, searchLocal } from "../src/lib/local-index.ts";
import { createCorpusStore } from "../src/store/corpus.ts";
import { slugOf } from "../src/lib/slug.ts";

import { at } from "./helpers/definite.ts";

const hit = (fullName: string, description: string) => ({ fullName, description });

// ---------------------------------------------------------------------------
// 1. absorbDescriptions：纯函数

test("corpus-desc: 有效命中按墙 slug 归档，同键后写赢", () => {
  const first = absorbDescriptions({}, [hit("vercel/next.js", "React 框架")]);
  assert.deepEqual(first["github.com/vercel/next.js"], { description: "React 框架" });
  const second = absorbDescriptions(first, [hit("vercel/next.js", "更新后的描述")]);
  assert.deepEqual(second["github.com/vercel/next.js"], { description: "更新后的描述" });
  assert.equal(first["github.com/vercel/next.js"]?.description, "React 框架", "不原地改 prev");
});

test("corpus-desc: 畸形行被跳过——形状不对、名字不对、空描述都不进语料", () => {
  const out = absorbDescriptions({}, [
    null,
    undefined,
    "a string",
    42,
    [],
    {},
    hit("", "x"),
    hit("justname", "x"),
    hit("a/b/c", "x"),
    hit("owner/", "x"),
    hit("owner/repo", ""),
    hit("owner/repo", "   "),
    { description: "没有名字" },
    { fullName: "owner/repo" },
    hit("owner/repo", "有效"),
  ]);
  assert.deepEqual(Object.keys(out), ["github.com/owner/repo"]);
  assert.deepEqual(out["github.com/owner/repo"], { description: "有效" });
});

test("corpus-desc: 全是垃圾行时返回原引用（store 据此不 bump rev）", () => {
  const prev: Record<string, CorpusExtras> = { "github.com/a/b": { description: "旧" } };
  assert.equal(absorbDescriptions(prev, []), prev);
  assert.equal(absorbDescriptions(prev, [null, {}, hit("x", "")]), prev);
});

test("corpus-desc: 超过上限按插入顺序裁掉最老的", () => {
  let map: Record<string, CorpusExtras> = {};
  map = absorbDescriptions(map, [hit("o/one", "1"), hit("o/two", "2"), hit("o/three", "3")], 2);
  assert.deepEqual(Object.keys(map).sort(), ["github.com/o/three", "github.com/o/two"]);
  assert.equal(CORPUS_DESCRIPTION_CAP >= 100, true, "默认档远大于任何真实墙");
});

// ---------------------------------------------------------------------------
// 2. store 方法与 rev 语义

test("corpus-desc-store: 命中写入 extras 并 bump rev；垃圾行不 bump", async () => {
  const store = createCorpusStore(async () => {
    throw new Error("读取失败 (missing)");
  });
  const before = store.getState().rev;
  store.getState().absorbDescriptions([hit("o/proj", "描述文本")]);
  assert.equal(store.getState().rev, before + 1);
  assert.deepEqual(store.getState().extras["github.com/o/proj"], { description: "描述文本" });
  store.getState().absorbDescriptions([null, {}, hit("x", "")]);
  assert.equal(store.getState().rev, before + 1, "没有新信息就不重建索引");
});

test("corpus-desc-store: retain 会把吸收来的描述一起 prune（仓库离开墙面）", () => {
  const store = createCorpusStore(async () => {
    throw new Error("读取失败 (missing)");
  });
  store.getState().absorbDescriptions([hit("o/keep", "留"), hit("o/gone", "走")]);
  store.getState().retain(["github.com/o/keep"]);
  assert.deepEqual(Object.keys(store.getState().extras), ["github.com/o/keep"]);
});

// ---------------------------------------------------------------------------
// 3. 端到端：吸收 → 合并 → 检索命中 / 缺失降级

test("corpus-desc-e2e: slug 关联后，仅存在于描述里的词能以 reason=description 被搜到", () => {
  const store = createCorpusStore(async () => {
    throw new Error("读取失败 (missing)");
  });
  store.getState().absorbDescriptions([hit("vercel/next.js", "React 框架，默认端口 3000")]);
  const card = { host: "github.com", owner: "vercel", repo: "next.js", path: null };
  const slug = slugOf(card);
  const entries = [corpusEntryOf(card, undefined, store.getState().extras[slug])];
  const index = buildLocalIndex(entries);
  const hits = searchLocal(index, "框架");
  assert.equal(at(hits, 0).slug, slug);
  assert.equal(at(hits, 0).reason, "description");
});

test("corpus-desc-e2e: 缓存缺失（没搜过/导过）时语料无该字段，检索不报错、名称照常命中", () => {
  const store = createCorpusStore(async () => {
    throw new Error("读取失败 (missing)");
  });
  // The search cache expired / never held this repository: absorb saw nothing.
  const card = { host: "github.com", owner: "burntsushi", repo: "ripgrep", path: null };
  const slug = slugOf(card);
  assert.equal(store.getState().extras[slug], undefined);
  const entries = [corpusEntryOf(card, undefined, store.getState().extras[slug])];
  const index = buildLocalIndex(entries);
  assert.deepEqual(searchLocal(index, "框架"), [], "没有描述就不在描述里命中，但不抛错");
  assert.equal(at(searchLocal(index, "ripgrep"), 0).slug, slug, "名称字段照常工作");
});

test("corpus-desc-e2e: 同一批卡片里有描述与无描述并存，索引照常建成", () => {
  const store = createCorpusStore(async () => {
    throw new Error("读取失败 (missing)");
  });
  store.getState().absorbDescriptions([hit("vercel/next.js", "React 框架")]);
  const cards = [
    { host: "github.com", owner: "vercel", repo: "next.js" },
    { host: "github.com", owner: "burntsushi", repo: "ripgrep" },
  ];
  const index = buildLocalIndex(
    cards.map((c) => corpusEntryOf(c, undefined, store.getState().extras[slugOf(c)])),
  );
  assert.equal(searchLocal(index, "框架").length, 1);
  assert.equal(searchLocal(index, "ripgrep").length, 1);
});
