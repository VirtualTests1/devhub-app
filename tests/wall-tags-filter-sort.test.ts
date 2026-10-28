/**
 * 标签与筛选、排序的交互（需求 N3-3）.
 *
 * ## What is testable, and what is not
 *
 * The eight tier comparators live inside `src/views/ProjectsView.tsx` (a `.tsx`),
 * which `node --test` cannot load - the rule `tests/lib-import-graph.test.ts` exists
 * to enforce and `tests/wall-selectors.test.ts` documents. So this file cannot
 * assert "按大小 sorts a tagged wall the same way". What it *can* assert, and does,
 * is the half that lives in the store and is where a tag could plausibly break the
 * order: `applyOverlay` (置顶 → 运行中 → 拖拽序号) and `matchesTagFilter`, composed.
 * A tier list is simulated by feeding a pre-ordered array, which is exactly the
 * contract `applyOverlay` documents - "applied to an already tier-sorted list".
 *
 * The two properties worth nailing are the ones a user would feel:
 *   - tagging a card must not move it, and un-tagging must not move it;
 *   - filtering by tag must preserve the relative order the overlay produced,
 *     never re-rank what is left.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addRepoTag,
  applyOverlay,
  matchesTagFilter,
  removeRepoTag,
  REPO_TAG_LIMIT,
  sanitiseTags,
  tagVocabulary,
} from "../src/store/wall.ts";

import type { RepoState } from "../src/store/wall.ts";

import { atKey } from "./helpers/definite.ts";

type Card = { slug: string };
const order = (list: Card[]) => list.map((c) => c.slug);
const running = (...slugs: string[]) => ({ has: (s: string) => slugs.includes(s) });

/** The `matched` pipeline from the view: tag chips first, then the overlay. */
function wall(tierSorted: Card[], states: Record<string, RepoState>, active: string[]) {
  const matched = tierSorted.filter((c) => matchesTagFilter(states[c.slug]?.tags, active));
  return applyOverlay(matched, states);
}

test("打标签不移动卡片：覆盖层的结果与打标签前逐项一致", () => {
  const tier = [{ slug: "a" }, { slug: "b" }, { slug: "c" }];
  const before = applyOverlay(tier, { a: { index: 2 }, b: { index: 0 }, c: { index: 1 } });
  const after = applyOverlay(
    tier,
    { a: { index: 2, tags: ["后端"] }, b: { index: 0, tags: ["前端"] }, c: { index: 1 } },
  );
  assert.deepEqual(order(after), order(before), "标签是分类字段，不是顺序字段");
});

test("按标签筛选保持覆盖层顺序，绝不把剩下的重排", () => {
  const states: Record<string, RepoState> = {
    a: { tags: ["后端"], pinned: true },
    b: { tags: ["前端"], index: 0 },
    c: { tags: ["后端"] },
    d: { tags: [] },
    e: { alias: "没有标签" },
  };
  // 名称序 a..e；覆盖层把 a 置顶、b 拖到 0 号位。
  const tier = [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }, { slug: "e" }];
  const unfiltered = order(wall(tier, states, []));
  assert.deepEqual(unfiltered, ["a", "b", "c", "d", "e"], "a 置顶在前，b 的序号 0 排其它未编号之前");

  assert.deepEqual(order(wall(tier, states, ["后端"])), ["a", "c"], "命中项保持原有相对次序");
  assert.deepEqual(order(wall(tier, states, ["前端"])), ["b"]);
  assert.deepEqual(
    order(wall(tier, states, ["后端", "前端"])),
    ["a", "b", "c"],
    "多 chip 是并集，且仍按覆盖层次序而不是按 chip 点选次序",
  );
  // A card whose tags sanitise to nothing is a card with no tags: `tags: []` must
  // not become a chip that matches itself.
  assert.deepEqual(order(wall(tier, states, ["不存在"])), []);
});

test("空 chip 选择不设限：筛选结果与不筛一致（含无标签卡片）", () => {
  const states: Record<string, RepoState> = { a: { tags: ["后端"] }, b: {} };
  const tier = [{ slug: "b" }, { slug: "a" }];
  assert.deepEqual(order(wall(tier, states, [])), ["b", "a"]);
});

test("运行中的浮起在标签筛选之后仍然成立", () => {
  const states: Record<string, RepoState> = { a: { tags: ["后端"] }, b: { tags: ["后端"] } };
  const tier = [{ slug: "a" }, { slug: "b" }];
  const filtered = applyOverlay(
    tier.filter((c) => matchesTagFilter(states[c.slug]?.tags, ["后端"])),
    states,
    running("b"),
  );
  assert.deepEqual(order(filtered), ["b", "a"], "运行中 > 拖拽序号，标签筛选不改这条");
});

test("摘掉最后一个标签后卡片不会残留在结果里，也不会留下占位条目", () => {
  const states: Record<string, RepoState> = { a: { tags: ["后端"], alias: "A" } };
  const left = removeRepoTag(atKey(states, "a").tags, "后端");
  assert.equal(left, null);
  const next: RepoState = { ...states.a };
  if (left) next.tags = left;
  else delete next.tags;
  assert.deepEqual(next, { alias: "A" }, "alias 必须活下来");
  assert.deepEqual(order(wall([{ slug: "a" }], { a: next }, ["后端"])), []);
});

test("上限截断不影响筛选：被截掉的标签不再命中，留下的照样命中", () => {
  const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const kept = sanitiseTags(many);
  assert.equal(kept?.length, REPO_TAG_LIMIT);
  assert.equal(matchesTagFilter(kept, ["t0"]), true);
  assert.equal(matchesTagFilter(kept, ["t11"]), false, "第 8 个之后的标签不存在，因此也不该被筛出来");
  assert.deepEqual(tagVocabulary({ a: { tags: many } }).map((c) => c.tag), kept);
});

test("大小写与空白：打上的标签和筛选的 chip 认得彼此", () => {
  let tags = addRepoTag(undefined, "  Backend ");
  assert.deepEqual(tags, ["Backend"]);
  assert.equal(matchesTagFilter(tags, ["backend"]), true);
  assert.equal(matchesTagFilter(tags, [" BACKEND "]), true, "chip 文案来自词汇，可能带空白");
  tags = addRepoTag(tags, "BACKEND");
  assert.deepEqual(tags, ["Backend"], "同名的另一种写法不该变成第二个标签");
});

test("词汇与筛选对同一份 store 数据给出同一答案（chip 数字不会骗人）", () => {
  const states: Record<string, RepoState> = {
    a: { tags: ["后端", "Rust"] },
    b: { tags: ["rust"] },
    c: { tags: ["前端"] },
  };
  const vocab = tagVocabulary(states);
  for (const { tag, count } of vocab) {
    const hits = Object.keys(states).filter((slug) =>
      matchesTagFilter(states[slug]?.tags, [tag]),
    );
    assert.equal(hits.length, count, `chip「${tag}」写着 ${count}，实际筛出 ${hits.length}`);
  }
  assert.deepEqual(
    vocab.map((v) => v.tag),
    ["Rust", "前端", "后端"],
    "Rust/rust 合成一个词（所以它 count 2 排最前），写法取第一次出现的那个；同数按码点序",
  );
});
