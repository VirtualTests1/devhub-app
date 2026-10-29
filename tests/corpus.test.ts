/**
 * r21-n2-1 — the readmeHeadings producer: pure extraction (`lib/corpus.ts`) and
 * the injected-probe store loop (`store/corpus.ts`), plus the end-to-end shape
 * this whole direction exists for: producer → `corpusEntryOf` →
 * `buildLocalIndex` → `searchLocal` hit, and the anti-stale half when a card
 * leaves the wall.
 *
 * No Tauri, no network: the probe is a fake, exactly like `tests/heat.test.ts`'s
 * `HeatFetcher`. The missing-file reason is the token `read_text_file` really
 * answers with (`(missing)`, per `lib/readme.ts:isMissingFileReason`), so the
 * fake refuses the way the backend refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  corpusEntryOf,
  pruneExtras,
  readmeHeadingsOf,
  type CorpusExtras,
} from "../src/lib/corpus.ts";
import {
  LOCAL_README_HEADING_LIMIT,
  buildLocalIndex,
  searchLocal,
} from "../src/lib/local-index.ts";
import { createCorpusStore } from "../src/store/corpus.ts";

import { at } from "./helpers/definite.ts";

const missing = (path: string) => new Error(`路径不存在或无法解析：${path} (missing)`);

// ---------------------------------------------------------------------------
// 1. readmeHeadingsOf：README 文本 → 标题数组

test("corpus: 标题按文档顺序抽出，行内格式摊成纯文本", () => {
  const md = [
    "# DevHub **套件**",
    "",
    "intro paragraph",
    "",
    "## 安装 `cargo`",
    "",
    "### 端口排查",
    "",
    "#### API — [文档](https://example.com)",
  ].join("\n");
  assert.deepEqual(readmeHeadingsOf(md), ["DevHub 套件", "安装 cargo", "端口排查", "API — 文档"]);
});

test("corpus: 引用块里的标题也算（> ## 的写法真实存在）", () => {
  assert.deepEqual(readmeHeadingsOf("> ## quoted heading\n\ntext"), ["quoted heading"]);
});

test("corpus: 非字符串与空串给 []，不抛错（入口跨 IPC）", () => {
  for (const bad of [null, undefined, 42, {}, [], ""]) {
    assert.deepEqual(readmeHeadingsOf(bad), []);
  }
});

test("corpus: 标题数量按 LOCAL_README_HEADING_LIMIT 截断，文档深处的哨兵词进不来", () => {
  const many = Array.from(
    { length: LOCAL_README_HEADING_LIMIT + 5 },
    (_, i) => `## heading${i}`,
  );
  many.splice(LOCAL_README_HEADING_LIMIT, 0, "## latentsentinel");
  const out = readmeHeadingsOf(many.join("\n\n"));
  assert.equal(out.length, LOCAL_README_HEADING_LIMIT);
  assert.ok(!out.includes("latentsentinel"), "上限之后的标题不进语料");
  assert.equal(out[0], "heading0");
});

test("corpus: 超过 README_MAX_BYTES 的文件按字节上限切，尾部标题进不来", () => {
  // The byte cut is `capUtf8`'s (the dialog's own 256 KB rule): everything past
  // it — including a heading that only exists in the tail — must not be indexed.
  const filler = "filler ".repeat(40000); // ≈ 280 KB of plain paragraphs
  const md = `# Head\n\n${filler}\n\ntailheading\n`;
  const out = readmeHeadingsOf(md);
  assert.deepEqual(out, ["Head"], "上限之外的 tailheading 不在标题里");
});

// ---------------------------------------------------------------------------
// 2. corpusEntryOf / pruneExtras：合并与防 stale

const CARD = {
  host: "github.com",
  owner: "o",
  repo: "proj",
  path: "D:\\项目\\proj_o",
  local: "proj_o",
};

test("corpus: 条目合并卡片 + 墙上状态 + extras，缺席的字段不写键", () => {
  const entry = corpusEntryOf(
    CARD,
    { alias: "我的", note: "部署前先备份", tags: ["网络"] },
    { readmeHeadings: ["安装"] },
  );
  assert.deepEqual(entry, {
    host: "github.com",
    owner: "o",
    repo: "proj",
    path: "D:\\项目\\proj_o",
    local: "proj_o",
    alias: "我的",
    note: "部署前先备份",
    tags: ["网络"],
    readmeHeadings: ["安装"],
  });
  const bare = corpusEntryOf(
    { host: "github.com", owner: "o", repo: "bare" },
    undefined,
    undefined,
  );
  assert.deepEqual(bare, { host: "github.com", owner: "o", repo: "bare" });
});

test("corpus: extras 的 description 优先于卡片自带的（吸收来的更新鲜）", () => {
  const entry = corpusEntryOf(
    { ...CARD, description: "卡片上的旧描述" },
    undefined,
    { description: "搜索结果里的描述" },
  );
  assert.equal(entry.description, "搜索结果里的描述");
});

test("corpus: pruneExtras 只留还活着的 slug", () => {
  const extras: Record<string, CorpusExtras> = {
    "github.com/o/keep": { readmeHeadings: ["a"] },
    "github.com/o/gone": { readmeHeadings: ["b"] },
  };
  assert.deepEqual(pruneExtras(extras, ["github.com/o/keep"]), {
    "github.com/o/keep": { readmeHeadings: ["a"] },
  });
  assert.deepEqual(pruneExtras(extras, []), {});
});

// ---------------------------------------------------------------------------
// 3. store：注入探针的 README 读取循环

test("corpus-store: 第一个存在的拼写胜出，路径尾部分隔符被剥掉", async () => {
  const seen: string[] = [];
  const store = createCorpusStore(async (p) => {
    seen.push(p);
    if (p.endsWith("/readme.md")) return "## 安装步骤";
    throw missing(p);
  });
  await store.getState().loadReadmes([{ slug: "github.com/o/a", path: "D:\\项目\\a_o\\" }]);
  assert.deepEqual(seen, [
    "D:\\项目\\a_o/README.md",
    "D:\\项目\\a_o/readme.md",
  ], "README.md 先试；missing 才轮到下一个拼写");
  assert.deepEqual(store.getState().extras["github.com/o/a"]?.readmeHeadings, ["安装步骤"]);
  assert.equal(store.getState().readmeTried["github.com/o/a"], true);
});

test("corpus-store: 四个拼写都 missing → 不写 extras，且本会话不再重试", async () => {
  let calls = 0;
  const store = createCorpusStore(async (p) => {
    calls++;
    throw missing(p);
  });
  const cards = [{ slug: "github.com/o/noreadme", path: "D:\\项目\\noreadme" }];
  await store.getState().loadReadmes(cards);
  assert.equal(calls, 4, "README_CANDIDATES 四个拼写各试一次");
  assert.equal(store.getState().extras["github.com/o/noreadme"], undefined);
  await store.getState().loadReadmes(cards);
  assert.equal(calls, 4, "readmeTried 挡住第二次：没有 README 的仓库不再探");
});

test("corpus-store: 非 missing 的拒绝（越界/拒绝访问）吞掉、终止链条、不写 extras", async () => {
  let calls = 0;
  const store = createCorpusStore(async (p) => {
    calls++;
    throw new Error(`路径不在容器根内：${p} (denied)`);
  });
  await store.getState().loadReadmes([{ slug: "github.com/o/denied", path: "D:\\elsewhere\\x" }]);
  assert.equal(calls, 1, "非 missing 是致命拒绝，不再试后续拼写");
  assert.equal(store.getState().extras["github.com/o/denied"], undefined);
  assert.equal(store.getState().readmeTried["github.com/o/denied"], true);
});

test("corpus-store: 没有 path 的卡片与畸形输入直接跳过，不发探针", async () => {
  let calls = 0;
  const store = createCorpusStore(async () => {
    calls++;
    return "# x";
  });
  await store.getState().loadReadmes([
    { slug: "github.com/o/nopath", path: null },
    { slug: "github.com/o/emptypath", path: "" },
    { slug: "", path: "D:\\项目\\x" },
    null as unknown as { slug: string; path: string },
  ]);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 4. 端到端：生产者 → builder → 检索命中；防 stale

test("corpus-e2e: README 标题进了语料，能以 reason=readme 被搜到", async () => {
  const store = createCorpusStore(async (p) => {
    if (p.endsWith("README.md")) return "# Overview\n\n## 端口排查手册\n";
    throw missing(p);
  });
  const card = { slug: "github.com/o/portkit", path: "D:\\项目\\portkit_o" };
  await store.getState().loadReadmes([card]);
  const entries = [
    corpusEntryOf(
      { host: "github.com", owner: "o", repo: "portkit", path: card.path },
      undefined,
      store.getState().extras[card.slug],
    ),
  ];
  const index = buildLocalIndex(entries);
  const hits = searchLocal(index, "端口");
  assert.equal(at(hits, 0).slug, "github.com/o/portkit");
  assert.equal(at(hits, 0).reason, "readme", "证据行必须说 README，不是名称");
});

test("corpus-e2e: 仓库离开墙面后，重建的索引搜不到它的标题，extras 也被 prune", async () => {
  // Different headings per repository, via the path the probe receives.
  const probing = createCorpusStore(async (p) => {
    if (!p.endsWith("README.md")) throw missing(p);
    return p.includes("stay_o") ? "## 共同特征\n" : "## 离开特征\n";
  });
  const stay = { slug: "github.com/o/stay", path: "D:\\项目\\stay_o" };
  const leave = { slug: "github.com/o/leave", path: "D:\\项目\\leave_o" };
  await probing.getState().loadReadmes([stay, leave]);
  const entryOf = (slug: string, path: string, repo: string) =>
    corpusEntryOf({ host: "github.com", owner: "o", repo, path }, undefined, probing.getState().extras[slug]);
  const both = buildLocalIndex([
    entryOf(stay.slug, stay.path, "stay"),
    entryOf(leave.slug, leave.path, "leave"),
  ]);
  assert.equal(at(searchLocal(both, "离开"), 0).slug, leave.slug);

  // The wall refresh no longer lists `leave`: rebuild from the surviving cards
  // only — the deleted repository must not keep matching.
  const after = buildLocalIndex([entryOf(stay.slug, stay.path, "stay")]);
  assert.deepEqual(searchLocal(after, "离开"), [], "删掉的仓库不得残留命中");
  assert.equal(at(searchLocal(after, "共同"), 0).slug, stay.slug, "留下的仓库照常可搜");

  // The store's own maps shrink with the wall, so hours of opens do not
  // accumulate extras for repositories that left.
  probing.getState().retain([stay.slug]);
  assert.deepEqual(Object.keys(probing.getState().extras), [stay.slug]);
  assert.deepEqual(Object.keys(probing.getState().readmeTried), [stay.slug]);
});
