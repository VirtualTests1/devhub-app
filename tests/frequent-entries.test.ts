/**
 * `src/views/frequent/entries.ts` — 固定项的序列化与那份唯一的可信列表。
 *
 * These functions lived in `settingsCatalog.tsx` until r16-o2-3, where nothing
 * could assert them: Node's runner cannot parse JSX, so the whole contract —
 * what a stored string parses to, what a legacy bare slug means, what happens
 * to the empty and the half-written — sat untested behind a `.tsx`. The page
 * that broke (two divergent lists; see `canonicalEntries`) broke exactly here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalEntries, entryId, parseEntry } from "../src/views/frequent/entries.ts";

import { at } from "./helpers/definite.ts";

// --- entryId / parseEntry: 一条存储字符串的往返 --------------------------------

test("entryId: kind 前缀 + 冒号 + id，三种 kind 一个规则", () => {
  assert.equal(entryId("repo", "github.com/a/b"), "repo:github.com/a/b");
  assert.equal(entryId("view", "records"), "view:records");
  assert.equal(entryId("settings", "appearance"), "settings:appearance");
});

test("parseEntry: 带前缀的往返无损", () => {
  assert.deepEqual(parseEntry("repo:github.com/a/b"), { kind: "repo", id: "github.com/a/b" });
  assert.deepEqual(parseEntry("view:settings"), { kind: "view", id: "settings" });
  assert.deepEqual(parseEntry("settings:appearance"), { kind: "settings", id: "appearance" });
  // 前缀里的 kind 必须原样保留，不能因为 kind 名单外的字符被降级成 repo。
  assert.deepEqual(parseEntry("view:records"), { kind: "view", id: "records" });
});

test("parseEntry: round-9 之前的裸 slug 仍是 repo，升级不清空用户排好的页面", () => {
  assert.deepEqual(parseEntry("github.com/a/b"), { kind: "repo", id: "github.com/a/b" });
  // `local:C:\\x` 这种带冒号的 slug 走文档写明的兜底：整个值当 repo id，而不是丢掉。
  assert.deepEqual(parseEntry("local:C:\\x"), { kind: "repo", id: "local:C:\\x" });
});

test("parseEntry: 空串与只剩前缀的一律解析不出（null 而非假条目）", () => {
  assert.equal(parseEntry(""), null);
  assert.equal(parseEntry("   "), null, "纯空白同样丢弃");
  assert.equal(parseEntry("repo:"), null);
  assert.equal(parseEntry("view:"), null);
  assert.equal(parseEntry("settings:"), null);
  // 解析得出的 id 会 trim：存储里的手抖空格不该变成一个看不见的 id。
  assert.deepEqual(parseEntry(" view:records "), { kind: "view", id: "records" });
});

// --- canonicalEntries: 页面唯一允许读的那份列表 -------------------------------

test("canonicalEntries: parse → 丢弃解析不出的 → 按存储顺序保序", () => {
  const out = canonicalEntries(["repo:github.com/a/b", "view:records", "settings:token"]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["repo:github.com/a/b", "view:records", "settings:token"],
  );
  assert.equal(at(out, 0).entry.kind, "repo");
  assert.equal(at(out, 1).entry.kind, "view");
});

test("canonicalEntries: 裸 slug 与它的 repo: 前缀是一件事，去重后保留 canonical id", () => {
  // 这就是 FrequentView 的 key 撞车与键盘重排 no-op：同一项在导入的列表里
  // 以两种形态并存，旧代码按原始字符串下标渲染出两张卡。
  const out = canonicalEntries(["github.com/a/b", "repo:github.com/a/b"]);
  assert.equal(out.length, 1);
  assert.equal(at(out, 0).id, "repo:github.com/a/b", "裸形态被折叠成 canonical id");
  assert.deepEqual(at(out, 0).entry, { kind: "repo", id: "github.com/a/b" });
});

test("canonicalEntries: 空输入与全是垃圾都给出空列表，而不是抛错", () => {
  assert.deepEqual(canonicalEntries([]), []);
  assert.deepEqual(canonicalEntries(["", "   ", "repo:"]), []);
});

test("canonicalEntries: 顺序即存储顺序，去重不重排", () => {
  const out = canonicalEntries(["settings:token", "view:records", "settings:token", "view:add"]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["settings:token", "view:records", "view:add"],
    "重复项被吃掉，但后出现的重复不把先出现的挤到后面",
  );
});
