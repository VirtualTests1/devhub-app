/**
 * 仓库标签的数据模型与迁移兼容（需求 N3-1）.
 *
 * Two directions have to hold at once, and only one of them is obvious:
 *
 *   backward  an export / a stored wall written BEFORE tags existed must still read
 *   forward   a wall written WITH tags must still be readable by a build that has
 *             never heard of tags
 *
 * The forward half is the one that cannot be tested by calling today's code, since
 * today's code is the new one. So `legacySanitiseRepo` below is `sanitiseImportedRepo`
 * transcribed from `git show master:src/store/wall-xfer.ts` (the `:93-119` block,
 * verbatim) - the reader that is already shipped on someone else's machine. It is
 * a transcription and not the compiled old binary; what makes it load-bearing is
 * that the shipped reader is a *key whitelist* (`Object.keys(out)` over named
 * fields, no schema comparison, no unknown-key rejection), so `tags` is inert to
 * it. `readStored`'s own sanitiser (`src/store/wall.ts`) has the identical shape.
 * The last two tests pin that shape on the real current function too, using keys
 * that neither version knows, so the property survives the next field as well.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addRepoTag,
  findStoredTag,
  hasRepoTag,
  matchesTagFilter,
  REPO_TAG_LENGTH_LIMIT,
  REPO_TAG_LIMIT,
  removeRepoTag,
  sanitiseTag,
  sanitiseTags,
  tagVocabulary,
} from "../src/store/wall.ts";
import { buildWallXfer, parseWallXfer } from "../src/store/wall-xfer.ts";

import type { RepoState } from "../src/store/wall.ts";

import { atKey } from "./helpers/definite.ts";

// --- sanitiseTag: one tag ---------------------------------------------------

test("sanitiseTag: 首尾与内部空白折叠，纯空白不是标签", () => {
  assert.equal(sanitiseTag("  后端  "), "后端");
  assert.equal(sanitiseTag("rust   edition"), "rust edition", "内部连续空白折成一个空格，避免两个看起来一样的 chip");
  for (const blank of ["", "   ", "\t", "\n", " \t "]) {
    assert.equal(sanitiseTag(blank), null, `${JSON.stringify(blank)} 不是标签`);
  }
});

test("sanitiseTag: 非字符串安全丢弃，超长截断而不是报错", () => {
  for (const junk of [null, undefined, 42, {}, [], true, ["a"]]) {
    assert.equal(sanitiseTag(junk), null);
  }
  const long = "x".repeat(REPO_TAG_LENGTH_LIMIT + 30);
  const cut = sanitiseTag(long);
  assert.equal(cut?.length, REPO_TAG_LENGTH_LIMIT, "超长是截断：打字的人意图清楚，整条丢掉才是坏结果");
});

// --- sanitiseTags: a list ---------------------------------------------------

test("sanitiseTags: 去空、去重、按大小写视为同一个标签", () => {
  assert.deepEqual(sanitiseTags([" 后端 ", "后端", "Rust", "rust", "", "  "]), ["后端", "Rust"]);
});

test("sanitiseTags: 数量上限截断到 REPO_TAG_LIMIT", () => {
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const out = sanitiseTags(many);
  assert.equal(out?.length, REPO_TAG_LIMIT);
  assert.deepEqual(out, many.slice(0, REPO_TAG_LIMIT), "留前 N 个，丢的是后面而不是随机挑");
});

test("sanitiseTags: 混入非法成员只保留合法前缀，不抛异常", () => {
  assert.deepEqual(sanitiseTags(["ok", 7, null, { a: 1 }, "", "第二个"]), ["ok", "第二个"]);
});

test("sanitiseTags: 非数组与空列表都是 null，绝不是 []", () => {
  for (const bad of [undefined, null, "tags", 5, {}, ["", "  "]]) {
    assert.equal(sanitiseTags(bad), null, `${JSON.stringify(bad)} 应当折叠成「没有标签」`);
  }
});

// --- add / remove ----------------------------------------------------------

test("addRepoTag: 追加、拒绝重复、空输入无操作", () => {
  assert.deepEqual(addRepoTag(undefined, "后端"), ["后端"]);
  assert.deepEqual(addRepoTag(["后端"], "后端"), ["后端"]);
  assert.deepEqual(addRepoTag(["后端"], " 后端 "), ["后端"], "大小写与空白都算同一个标签");
  assert.deepEqual(addRepoTag(["后端"], "   "), ["后端"], "空白不该挤掉已有标签");
  assert.deepEqual(addRepoTag(["后端"], 123), ["后端"], "非字符串是 no-op 而不是崩溃");
});

test("addRepoTag: 满了就拒绝新的，而不是把最老的挤掉", () => {
  const full = Array.from({ length: REPO_TAG_LIMIT }, (_, i) => `t${i}`);
  assert.deepEqual(addRepoTag(full, "新标签"), full, "静默丢一个用户还看得见的标签等于替他改了他没动的东西");
});

test("removeRepoTag: 忽略大小写移除，移除最后一个得到 null", () => {
  assert.deepEqual(removeRepoTag(["后端", "Rust"], "rust"), ["后端"]);
  assert.equal(removeRepoTag(["后端"], "后端"), null, "空列表必须是 null，让 store 的清空规则把它整个删掉");
  assert.equal(removeRepoTag(undefined, "后端"), null);
});

test("hasRepoTag:  undefined 列表与大小写", () => {
  assert.equal(hasRepoTag(undefined, "a"), false);
  assert.equal(hasRepoTag(["Rust"], "rust"), true);
  assert.equal(hasRepoTag(["Rust"], "go"), false);
});

test("hasRepoTag: 两边都归一化，脏的存储条目也认得干净的 chip", () => {
  // 只归一化查询侧是半个修复：一条手搓出来的 `" Rust "` 会被 tagVocabulary 数进 chip
  // 计数，却匹配不上任何 chip，筛出来的卡片和 chip 声称的不一致。
  assert.equal(hasRepoTag([" Rust "], "rust"), true);
  assert.equal(hasRepoTag(["Rust"], " RUST "), true);
  assert.equal(findStoredTag(["Rust", " 后端 "], " rust "), "Rust", "返回卡片自己的写法");
  assert.equal(findStoredTag(["Rust"], "   "), null, "空查询不匹配任何东西");
  assert.equal(findStoredTag(undefined, "Rust"), null);
});

// --- vocabulary / filter predicate -----------------------------------------

test("tagVocabulary: 按用量降序，同数按名称，隐藏的卡片也计入", () => {
  const repos: Record<string, RepoState> = {
    a: { tags: ["后端", "rust"] },
    b: { tags: ["后端", "Rust"] },
    c: { tags: ["前端"], hidden: true },
    d: { alias: "没有标签" },
  };
  assert.deepEqual(tagVocabulary(repos), [
    { tag: "rust", count: 2 },
    { tag: "后端", count: 2 },
    { tag: "前端", count: 1 },
  ]);
});

test("matchesTagFilter: 没选标签时不设限，选了就至少命中一个", () => {
  assert.equal(matchesTagFilter(undefined, []), true, "没有 chip 亮着就不该筛掉任何东西");
  assert.equal(matchesTagFilter(["后端"], []), true);
  assert.equal(matchesTagFilter(["后端"], ["后端"]), true);
  assert.equal(matchesTagFilter(["Rust"], ["rust"]), true, "比较忽略大小写");
  assert.equal(matchesTagFilter(["后端"], ["前端"]), false);
  assert.equal(matchesTagFilter(undefined, ["前端"]), false, "无标签的卡片在有 chip 亮着时必须出局");
  assert.equal(matchesTagFilter(["后端", "前端"], ["前端", "别处"]), true, "多 chip 是并集而不是交集");
});

// --- backward: 老文件（没有 tags）-----------------------------------------

test("向后兼容：老导出文件没有 tags 字段，照常读入且不假造标签", () => {
  const legacy = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: { sort: "size", grouped: true },
    repos: {
      "github.com/o/a": { alias: "A", pinned: true, index: 2 },
      "github.com/o/b": { hidden: true },
    },
  });
  const { prefs, repos } = parseWallXfer(legacy);
  assert.equal(prefs.sort, "size");
  assert.deepEqual(repos["github.com/o/a"], { alias: "A", pinned: true, index: 2 });
  assert.equal("tags" in atKey(repos, "github.com/o/a"), false, "缺失不等于空列表：不应凭空造出一个字段");
});

test("向后兼容：tags 为 null / 非数组 / 全是垃圾时不污染条目", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: {},
    repos: {
      nul: { alias: "n", tags: null },
      str: { alias: "s", tags: "后端" },
      junk: { alias: "j", tags: ["", "  ", 3] },
      obj: { alias: "o", tags: { a: 1 } },
      ok: { alias: "k", tags: ["  后端 ", "后端"] },
    },
  });
  const { repos } = parseWallXfer(text);
  assert.deepEqual(repos.nul, { alias: "n" });
  assert.deepEqual(repos.str, { alias: "s" }, "字符串不是列表，整键丢弃");
  assert.deepEqual(repos.junk, { alias: "j" });
  assert.deepEqual(repos.obj, { alias: "o" });
  assert.deepEqual(repos.ok, { alias: "k", tags: ["后端"] });
});

test("向后兼容：只带空 tags 的条目仍按「空」删除，不留一个 {} 占位", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: {},
    repos: { ghost: { tags: [] }, only: { tags: ["后端"] } },
  });
  const { repos } = parseWallXfer(text);
  assert.equal("ghost" in repos, false);
  assert.deepEqual(repos.only, { tags: ["后端"] });
});

// --- forward: 老版本读新文件 -----------------------------------------------

/** `sanitiseImportedRepo` as it exists on master (wall-xfer.ts:93-119), verbatim. */
function legacySanitiseRepo(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.alias === "string" && r.alias.trim() !== "") out.alias = r.alias;
  if (r.pinned === true) out.pinned = true;
  if (r.hidden === true) out.hidden = true;
  if (typeof r.index === "number" && Number.isFinite(r.index)) out.index = r.index;
  if (typeof r.cover === "string" && r.cover !== "") out.cover = r.cover;
  if (r.coverFit === "fit" || r.coverFit === "contain" || r.coverFit === "blur") {
    out.coverFit = r.coverFit;
  }
  if (
    Array.isArray(r.coverFocus) &&
    r.coverFocus.length === 2 &&
    r.coverFocus.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    out.coverFocus = [r.coverFocus[0], r.coverFocus[1]];
  }
  if (r.coverRatio === "2/1" || r.coverRatio === "16/9" || r.coverRatio === "4/3" || r.coverRatio === "1/1") {
    out.coverRatio = r.coverRatio;
  }
  if (r.coverLook === "auto" || r.coverLook === "vivid" || r.coverLook === "flat" || r.coverLook === "mono") {
    out.coverLook = r.coverLook;
  }
  return Object.keys(out).length > 0 ? out : null;
}

test("向前兼容：老 reader 吃下带 tags 的新 payload，不抛错且其余字段原样保留", () => {
  const modern = buildWallXfer({
    sort: "recent",
    filter: "all",
    grouped: false,
    density: "compact",
    repos: {
      "github.com/o/a": { alias: "A", pinned: true, tags: ["后端", "Rust"] },
      "github.com/o/b": { tags: ["前端"] },
    },
  });
  const parsed = JSON.parse(JSON.stringify(modern)) as {
    repos: Record<string, unknown>;
  };
  const kept = legacySanitiseRepo(parsed.repos["github.com/o/a"]);
  assert.deepEqual(kept, { alias: "A", pinned: true }, "tags 对老代码是未知键：忽略，不是报错");
  // The one entry whose ONLY field is tags vanishes for the old build. That is
  // the graceful degradation being asserted: the wall still loads, the card just
  // carries no per-device state. It must not throw, and it must not become a
  // half-parsed object.
  assert.equal(legacySanitiseRepo(parsed.repos["github.com/o/b"]), null);
});

test("向前兼容：新导出文件的顶层形状未变，老 parseWallXfer 的入口检查照样通过", () => {
  const x = buildWallXfer({
    sort: "name",
    filter: "all",
    grouped: false,
    density: "standard",
    repos: { a: { tags: ["x"] } },
  });
  assert.equal(x.format, "devhub-wall", "老 reader 的第一道闸门");
  assert.equal(x.version, 1, "未升版本：加一个可选键不是破坏性变更，升版本反而让老代码有理由拒绝");
  assert.equal(Array.isArray(x.repos), false, "老 reader 要求 repos 是对象");
  assert.deepEqual(Object.keys(x).sort(), ["format", "prefs", "repos", "version"]);
});

test("向前兼容：真实 parseWallXfer 忽略它不认识的任何键（下一个字段也一样）", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    totallyNew: { should: "be ignored" },
    prefs: { sort: "size", brandNewPref: 99 },
    repos: { a: { alias: "A", stars: 5, tags: ["后端"], nested: { deep: [1, 2] } } },
  });
  const { prefs, repos } = parseWallXfer(text);
  assert.equal(prefs.sort, "size");
  assert.equal("brandNewPref" in prefs, false);
  assert.deepEqual(repos.a, { alias: "A", tags: ["后端"] });
});

test("未知键不会把条目挤成 null：tags 之外的字段仍然成立", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: {},
    repos: { a: { futureOnlyField: true } },
  });
  const { repos } = parseWallXfer(text);
  assert.equal("a" in repos, false, "只有未知键的条目对老代码就是空条目，静默跳过而不是崩");
});

test("buildWallXfer 原样带上 tags，parseWallXfer 再走一遍净化（往返一致）", () => {
  const repos: Record<string, RepoState> = {
    a: { tags: ["后端", "Rust"], pinned: true },
    b: { tags: ["  去空格 "] },
  };
  const x = buildWallXfer({ sort: "name", filter: "all", grouped: false, density: "standard", repos });
  const back = parseWallXfer(JSON.stringify(x));
  assert.deepEqual(back.repos.a, { tags: ["后端", "Rust"], pinned: true });
  assert.deepEqual(back.repos.b, { tags: ["去空格"] });
});
