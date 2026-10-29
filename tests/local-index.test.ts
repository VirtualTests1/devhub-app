/**
 * 本地索引层（`src/lib/local-index.ts`）的离线测试（r20-r2-5）。
 *
 * 夹具刻意长成**应用今天真的拿到的样子**：`list_repositories` 回的是
 * `RepoRef`（host/owner/repo/local/path），卡片上的 `slug` 是 `App.tsx` 那侧
 * `RepoRef & { slug }` 的形状，别名与标签来自 `store/wall.ts` 的 `RepoState`。
 * 没有 mock 后端、没有 fs：这一层的契约就是「给我手上这些东西，我排出一个可搜的语料」。
 *
 * 三组性质各钉一件事：
 *   - **排序与证据**：命中在哪个字段，`reason` 就说哪个字段；同分时的先后是定死的。
 *   - **增量**：`updateLocalIndex` 之后必须搜得到新值、搜不到旧值、删掉的条目消失，
 *     而打分表的重建是**推迟到下一次搜索**的（一次整墙刷新会连发几十条更新）。
 *   - **边界**：畸形输入被丢弃而不是抛错。这一条抄的是 `store/wall.ts` 里
 *     `sanitiseRepo` 的做法——入口处的数据来自 IPC、localStorage 和别人机器的导出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_DESCRIPTION_CHAR_LIMIT,
  LOCAL_FIELD_PRECEDENCE,
  LOCAL_FIELD_WEIGHTS,
  LOCAL_NOTE_CHAR_LIMIT,
  LOCAL_README_HEADING_LIMIT,
  LOCAL_SEARCH_DEFAULT_LIMIT,
  buildLocalIndex,
  createLocalIndex,
  localDocOf,
  localIndexSize,
  reasonOf,
  searchLocal,
  updateLocalIndex,
  type LocalField,
} from "../src/lib/local-index.ts";

import { at } from "./helpers/definite.ts";

/** What `App.tsx` holds per card: the `RepoRef` payload plus the canonical slug. */
const ENTRIES = [
  {
    host: "github.com",
    owner: "tauri-apps",
    repo: "tauri",
    slug: "github.com/tauri-apps/tauri",
    local: "tauri_tauri-apps",
    path: "D:\\项目\\tauri_tauri-apps",
  },
  {
    host: "github.com",
    owner: "vercel",
    repo: "next.js",
    slug: "github.com/vercel/next.js",
    local: "next_js_vercel",
    path: "D:\\项目\\next_js_vercel",
    // An optional field with no producer today — the wiring stream fills it or leaves it.
    description: "React 框架，默认端口 3000",
  },
  {
    host: "github.com",
    owner: "owner",
    repo: "端口转发",
    slug: "github.com/owner/端口转发",
    path: "D:\\项目\\端口转发_owner",
    alias: "我的端口工具",
    tags: ["网络", "代理"],
  },
  {
    host: "github.com",
    owner: "rust-lang",
    repo: "rust-analyzer",
    slug: "github.com/rust-lang/rust-analyzer",
    readmeHeadings: ["Installation", "Configuration", "端口排查"],
    note: "离线笔记：端口排查",
  },
  // Nothing but identity: the shape a freshly-scanned repository has.
  { host: "github.com", owner: "BurntSushi", repo: "ripgrep", slug: "github.com/BurntSushi/ripgrep" },
];

const index = buildLocalIndex(ENTRIES);

// ---------------------------------------------------------------------------
// 1. 建索引与搜索

test("local-index: 客户端已有的条目就能建起索引", () => {
  assert.equal(localIndexSize(index), 5);
  assert.deepEqual(
    [...index.docs.keys()].sort(),
    [...ENTRIES.map((e) => e.slug)].sort(),
    "slug 就是文档主键，与卡片用的同一个身份",
  );
});

test("local-index: 命中名称时 reason 报 name，返回的形状就是那四个键", () => {
  const hits = searchLocal(index, "ripgrep");
  assert.equal(hits.length, 1);
  const hit = at(hits, 0);
  assert.deepEqual(Object.keys(hit).sort(), ["name", "reason", "score", "slug"]);
  assert.equal(hit.slug, "github.com/BurntSushi/ripgrep");
  assert.equal(hit.name, "ripgrep");
  assert.equal(hit.reason, "name");
  assert.ok(hit.score > 0);
});

test("local-index: 中文查询命中名称里带它的卡片", () => {
  const hits = searchLocal(index, "端口");
  assert.ok(hits.length > 0, "界面是中文的，这一条挂了整个功能就没用");
  assert.equal(at(hits, 0).slug, "github.com/owner/端口转发");
});

test("local-index: 别名与名称都含查询词时，报的是别名", () => {
  // Deliberate, and the reason the fixture's alias echoes the name: `alias` is the
  // word this person chose for this card, so a hit there is a hit on their own
  // vocabulary. `LOCAL_FIELD_WEIGHTS.alias` (3.5) therefore sits above `name` (3),
  // and the evidence row should say 别名 rather than 名称.
  const hits = searchLocal(index, "端口");
  assert.equal(at(hits, 0).reason, "alias");
  assert.ok(
    LOCAL_FIELD_WEIGHTS.alias > LOCAL_FIELD_WEIGHTS.name,
    "权重表就是这条结论的来源，改权重等于改这一条",
  );
});

test("local-index: 命中描述 / README 标题时 reason 报的是那个字段", () => {
  const byDescription = searchLocal(index, "框架");
  assert.deepEqual(
    byDescription.map((h) => [h.slug, h.reason]),
    [["github.com/vercel/next.js", "description"]],
    "「框架」只在 next.js 的描述里",
  );
  const byReadme = searchLocal(index, "installation");
  assert.deepEqual(
    byReadme.map((h) => [h.slug, h.reason]),
    [["github.com/rust-lang/rust-analyzer", "readme"]],
  );
  const byAlias = searchLocal(index, "我的");
  assert.deepEqual(
    byAlias.map((h) => [h.slug, h.reason]),
    [["github.com/owner/端口转发", "alias"]],
    "别名是自己起的词，命中它比命中仓库名更像「我要找的就是它」",
  );
  const byTag = searchLocal(index, "代理");
  assert.equal(byTag[0]?.slug, "github.com/owner/端口转发");
  assert.equal(byTag[0]?.reason, "tags");
  const byNote = searchLocal(index, "离线笔记");
  assert.deepEqual(
    byNote.map((h) => [h.slug, h.reason]),
    [["github.com/rust-lang/rust-analyzer", "note"]],
    "a word the user typed in 本地备注 is part of the card's vocabulary",
  );
});

test("local-index: reason 是字段标识，不是句子（界面文案留给 i18n 那批）", () => {
  for (const hit of searchLocal(index, "端口 框架 installation")) {
    assert.match(hit.reason, /^[a-z]+$/, `reason 必须是英文标识: ${hit.reason}`);
    assert.ok(
      (LOCAL_FIELD_PRECEDENCE as readonly string[]).includes(hit.reason),
      `reason 落在登记过的字段集里: ${hit.reason}`,
    );
  }
});

test("local-index: 空查询返回空，不返回整个语料", () => {
  assert.deepEqual(searchLocal(index, ""), []);
  assert.deepEqual(searchLocal(index, "   "), []);
  assert.deepEqual(searchLocal(index, "zzzznotaterm"), []);
});

test("local-index: 只有标识的条目照样可搜（名称 / 拥有者 / 路径）", () => {
  assert.equal(searchLocal(index, "rust-analyzer")[0]?.slug, "github.com/rust-lang/rust-analyzer");
  assert.equal(searchLocal(index, "burntsushi")[0]?.slug, "github.com/BurntSushi/ripgrep");
  const byPath = searchLocal(index, "tauri");
  assert.ok(byPath.length >= 1, "路径里的目录名也算一份证据");
});

test("local-index: 权重表覆盖每个字段，且名称重于描述重于路径", () => {
  for (const field of LOCAL_FIELD_PRECEDENCE) {
    assert.equal(typeof LOCAL_FIELD_WEIGHTS[field], "number", `${field} 有权重`);
    assert.ok(LOCAL_FIELD_WEIGHTS[field] > 0);
  }
  assert.ok(LOCAL_FIELD_WEIGHTS.name > LOCAL_FIELD_WEIGHTS.description);
  assert.ok(LOCAL_FIELD_WEIGHTS.description > LOCAL_FIELD_WEIGHTS.path);
});

// ---------------------------------------------------------------------------
// 2. top-k 与参数透传

test("local-index: limit 生效，默认档是登记过的那一个", () => {
  const wide = buildLocalIndex(
    Array.from({ length: LOCAL_SEARCH_DEFAULT_LIMIT + 5 }, (_, i) => ({
      host: "github.com",
      owner: "o",
      repo: `widget${String(i).padStart(3, "0")}`,
      // A term every document carries, so the default cap is what limits the list —
      // `host` is identity, not a field, so querying "github" here would find nothing.
      description: "shared text in every entry",
    })),
  );
  assert.equal(searchLocal(wide, "widget000").length, 1, "精确名只有一个");
  assert.equal(searchLocal(wide, "shared").length, LOCAL_SEARCH_DEFAULT_LIMIT, "没写 limit 走默认档");
  assert.equal(searchLocal(wide, "shared", { limit: 3 }).length, 3);
  assert.equal(searchLocal(wide, "shared", { limit: 40 }).length, 25, "k 大于语料就是全给");
  assert.deepEqual(searchLocal(wide, "shared", { limit: 0 }), []);
});

test("local-index: b / k1 透传到打分器", () => {
  // Two documents whose only difference is the length of the field carrying the term.
  const pair = buildLocalIndex([
    { host: "github.com", owner: "o", repo: "shorty", description: "zeta" },
    { host: "github.com", owner: "o", repo: "longy", description: "zeta and quite a number of other words" },
  ]);
  const normal = searchLocal(pair, "zeta");
  assert.ok(
    (at(normal, 0).score as number) > (at(normal, 1).score as number),
    "默认 b 下长的那篇应当被压一分",
  );
  const flat = searchLocal(pair, "zeta", { b: 0 });
  assert.equal(at(flat, 0).score, at(flat, 1).score, "b=0 时长度比影响完全无效");
  assert.equal(searchLocal(pair, "zeta", { b: Number.NaN }).length, 2, "认不出的参数回落，不是清空结果");
});

// ---------------------------------------------------------------------------
// 3. 增量更新

test("local-index: update 之后搜得到新值、搜不到旧值", () => {
  const live = buildLocalIndex([
    { host: "github.com", owner: "o", repo: "proj", slug: "github.com/o/proj", description: "最初的描述" },
  ]);
  assert.equal(searchLocal(live, "最初")[0]?.slug, "github.com/o/proj");

  updateLocalIndex(live, [
    { host: "github.com", owner: "o", repo: "proj", slug: "github.com/o/proj", description: "后来改成的说明" },
  ]);
  assert.deepEqual(searchLocal(live, "最初"), [], "旧文本不该还能搜到");
  assert.equal(searchLocal(live, "说明")[0]?.slug, "github.com/o/proj");
  assert.equal(localIndexSize(live), 1, "同一 slug 是覆盖，不是多出一篇");
});

test("local-index: 重建打分表是推迟的，一次刷新只重建一次", () => {
  // `buildLocalIndex` does not rank eagerly either: a wall refresh writes tens of
  // entries, and rebuilding the posting tables per entry would be one rebuild per
  // write instead of one per burst. The contract is "update marks dirty, search
  // rebuilds and clears".
  const fresh = createLocalIndex();
  assert.equal(fresh.dirty, true);
  assert.equal(fresh.bm25, null);
  updateLocalIndex(fresh, ENTRIES);
  assert.equal(fresh.dirty, true, "更新只标脏");
  assert.equal(fresh.bm25, null, "更新没有顺手重建打分表");
  const hits = searchLocal(fresh, "端口");
  assert.equal(fresh.dirty, false, "搜索时才重建，并清脏");
  assert.ok(fresh.bm25 !== null);
  assert.ok(hits.length > 0);

  const built = buildLocalIndex(ENTRIES);
  assert.equal(built.dirty, true, "build 走的是同一条不预打分的路");
  assert.equal(searchLocal(built, "端口").length, hits.length, "同一份条料，两种建法名次一致");
  assert.equal(built.dirty, false);
});

test("local-index: 连发多条更新，最后一次搜索看到全部", () => {
  const live = createLocalIndex();
  for (const entry of ENTRIES) updateLocalIndex(live, [entry]);
  assert.equal(localIndexSize(live), ENTRIES.length);
  for (const needle of ["tauri", "next", "端口", "installation", "ripgrep"]) {
    assert.ok(searchLocal(live, needle).length > 0, `${needle} 应在同一次重建后可搜`);
  }
});

test("local-index: 删掉的仓库要么显式摘掉，要么整墙重建", () => {
  const live = buildLocalIndex(ENTRIES);
  updateLocalIndex(live, [], { removedSlugs: ["github.com/vercel/next.js", 42, "", null] });
  assert.equal(localIndexSize(live), 4, "非字符串的 slug 被忽略，不是删掉一切");
  assert.deepEqual(searchLocal(live, "框架"), [], "已经不在墙上的项目不该还出现在结果里");
});

test("local-index: 同一次调用里 slug 重复，后写的赢", () => {
  const live = buildLocalIndex([
    { owner: "o", repo: "first", slug: "dup" },
    { owner: "o", repo: "second", slug: "dup" },
  ]);
  assert.equal(localIndexSize(live), 1);
  assert.equal(live.docs.get("dup")?.name, "second");
  assert.deepEqual(searchLocal(live, "first"), [], "被覆盖掉的那一份不该还留在语料里");
});

// ---------------------------------------------------------------------------
// 4. 边界：畸形输入丢弃，不抛错

test("local-index: 条目列表本身畸形也不炸", () => {
  for (const bad of [undefined, null, "not a list", 42, {}]) {
    const live = buildLocalIndex(bad as unknown as unknown[]);
    assert.equal(localIndexSize(live), 0);
    assert.deepEqual(searchLocal(live, "anything"), []);
  }
});

test("local-index: 认不出的条目被丢弃，认得出的照常入库", () => {
  const junk = [
    null,
    undefined,
    "a bare string",
    42,
    [],
    {},
    { owner: "o", host: "github.com" }, // 没有 repo：没有身份
    { repo: "", owner: "o" },
    { repo: 42, owner: "o" },
    { repo: "real", owner: "o" },
  ];
  const live = buildLocalIndex(junk);
  assert.equal(localIndexSize(live), 1, "十条里只有最后一条是仓库");
  assert.equal([...live.docs.keys()][0], "github.com/o/real");
  assert.equal(localDocOf(junk[6]), null, "有 owner 没 repo：没有身份");
  assert.ok(localDocOf(junk[9]) !== null, "最后一条是真的仓库");
});

test("local-index: 非字符串字段不进语料，也不会变成「undefined」这个词", () => {
  const live = buildLocalIndex([
    {
      host: "github.com",
      owner: "o",
      repo: "widget",
      description: null,
      alias: 7,
      tags: "not-an-array",
      readmeHeadings: { nested: true },
      path: { deep: "object" },
      local: ["array", "of", "strings"],
    },
  ]);
  const doc = live.docs.get("github.com/o/widget");
  assert.ok(doc, "身份在就入库");
  assert.deepEqual(doc.fields, {
    name: "widget",
    alias: "",
    note: "",
    description: "",
    readme: "",
    tags: "",
    owner: "o",
    path: "",
  });
  assert.deepEqual(searchLocal(live, "undefined"), []);
  assert.deepEqual(searchLocal(live, "null"), []);
  assert.deepEqual(searchLocal(live, "object"), []);
});

test("local-index: 字段内容按上限截断，载荷不能把每次击键变重", () => {
  const padding = "filler ".repeat(400);
  const sentinel = "beyondthelimit";
  const live = buildLocalIndex([
    {
      owner: "o",
      repo: "bigdesc",
      description: `${padding}${sentinel}`,
    },
    {
      owner: "o",
      repo: "manyheadings",
      readmeHeadings: Array.from({ length: LOCAL_README_HEADING_LIMIT + 10 }, (_, i) =>
        i === LOCAL_README_HEADING_LIMIT ? "latentsentinel" : `heading${i}`,
      ),
    },
    {
      owner: "o",
      repo: "bignote",
      note: `${padding}${sentinel}`,
    },
  ]);
  const big = live.docs.get("github.com/o/bigdesc");
  assert.equal(big?.fields.description.length, LOCAL_DESCRIPTION_CHAR_LIMIT, "描述按字符上限切");
  assert.equal(live.docs.get("github.com/o/bignote")?.fields.note.length, LOCAL_NOTE_CHAR_LIMIT);
  assert.deepEqual(searchLocal(live, sentinel), [], "上限之后的内容没有进语料");
  assert.ok(
    searchLocal(live, "filler").some((h) => h.slug === "github.com/o/bigdesc"),
    "上限之内照常可搜",
  );
  const many = live.docs.get("github.com/o/manyheadings");
  assert.equal(
    many?.fields.readme.split(" ").length,
    LOCAL_README_HEADING_LIMIT,
    "README 标题只取前 N 条",
  );
  assert.deepEqual(searchLocal(live, "latentsentinel"), []);
  assert.equal(searchLocal(live, "heading0")[0]?.slug, "github.com/o/manyheadings");
});

test("local-index: slug 缺省时按 lib/slug 的规则补全，host 缺失落回 github.com", () => {
  const live = buildLocalIndex([
    { owner: "o", repo: "nohost" },
    { host: "git.example.cn", owner: "o", repo: "selfhosted" },
    { slug: "written/verbatim/slug", repo: "slugonly" },
  ]);
  assert.deepEqual(
    [...live.docs.keys()],
    ["github.com/o/nohost", "git.example.cn/o/selfhosted", "written/verbatim/slug"],
    "已有 slug 一律原样采用：它是卡片与后端共用的身份，不该在这里被重新拼",
  );
});

test("local-index: 两次相同的搜索给出逐字段一致的结果", () => {
  const a = searchLocal(index, "端口 框架 installation 代理");
  const b = searchLocal(buildLocalIndex(ENTRIES), "端口 框架 installation 代理");
  assert.deepEqual(a, b, "重建索引不该改变名次");
  assert.deepEqual(a, searchLocal(index, "端口 框架 installation 代理"));
});

test("local-index: reasonOf 取最大贡献的字段，同分按登记的先后", () => {
  assert.equal(reasonOf({ name: 1, description: 1 }), "name");
  assert.equal(reasonOf({ description: 2, name: 1 }), "description");
  assert.equal(reasonOf({ path: 5, readme: 5 }), "readme", "README 标题排在路径之前");
  assert.equal(reasonOf({}), "name", "没有任何证据时落回名称，不返回 undefined");
  assert.equal(reasonOf({ bogusfield: 99 }), "name", "没登记的字段名不会变成 reason");
  for (const field of LOCAL_FIELD_PRECEDENCE) {
    const f: LocalField = field;
    assert.equal(reasonOf({ [f]: 1 }), f);
  }
});
