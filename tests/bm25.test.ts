/**
 * BM25 的打分性质（r20-r2-2）—— 一个手写夹具语料上的离线测试。
 *
 * 这一页没有 fs、没有 DOM、没有网络：语料是下面 `CORPUS` 那十二条字面量。之所以
 * 值得为「一个公式」写七条测试，是它每条都在钉一个**可以被无声改掉的性质**：
 * k1 的饱和、b 的长度惩罚、IDF 取的是哪一支、CJK 到底切不切得开、同分时谁在前。
 * 把它们换成「结果看起来对」的一次快照，改公式的人就再也看不出自己动了哪一条。
 *
 * 夹具刻意做成「除被测性质之外全部相同」：比较两个文档的分数时，字段、词频、
 * 长度、权重都对齐，让唯一变量就是那条测试名字里写着的性质。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BM25_B_DEFAULT,
  BM25_DEFAULT_LIMIT,
  BM25_K1_DEFAULT,
  bm25Idf,
  buildBm25Index,
  dfOf,
  searchBm25,
  tokenize,
  type Bm25Document,
} from "../src/lib/bm25.ts";

import { at, atKey } from "./helpers/definite.ts";

/** Field weights shared by every fixture below: 名称 重于 描述 重于 正文。 */
const WEIGHTS = { name: 3, description: 1, readme: 0.5 };

/**
 * The corpus the ranking tests read.
 *
 * `id` is the canonical slug shape, because that is what the real caller hands over
 * (`local-index.ts`), and the tie-breaking tests depend on ids comparing by code
 * point.
 */
const CORPUS: Bm25Document[] = [
  { id: "github.com/rust-lang/rust-analyzer", fields: { name: "rust analyzer", description: "alpha beta gamma" } },
  { id: "github.com/other/rustbook", fields: { name: "rustbook", description: "alpha beta gamma rust" } },
  { id: "github.com/crates/cargo", fields: { name: "cargo", description: "alpha beta gamma" } },
  { id: "github.com/owner/端口转发", fields: { name: "端口转发工具", description: "端口 分配 与 冲突" } },
  { id: "github.com/owner/proxy", fields: { name: "proxy", description: "端口 健康 检查" } },
  { id: "github.com/owner/empty", fields: { name: "empty", description: "nothing here" } },
  // The long-document pair: identical `code` term frequency, wildly different length.
  { id: "github.com/len/short", fields: { name: "short", description: "code" } },
  { id: "github.com/len/long", fields: { name: "long", description: "code and a great many other words in here" } },
  // The rare/common pair: one document carries both, at the same length and position.
  { id: "github.com/df/both", fields: { name: "both", description: "rare common" } },
  { id: "github.com/df/one", fields: { name: "one", description: "common filler" } },
  { id: "github.com/df/two", fields: { name: "two", description: "common filler" } },
  { id: "github.com/df/three", fields: { name: "three", description: "common filler" } },
];

const index = buildBm25Index(CORPUS, { fieldWeights: WEIGHTS });

/** `id → score` for one query, so an assertion reads about the docs it names. */
function scoresOf(query: string, options = {}): Map<string, number> {
  return new Map(searchBm25(index, query, options).map((h) => [h.id, h.score]));
}

// ---------------------------------------------------------------------------
// 1. 分词：CJK 与 ASCII 词串

test("bm25 分词: 中文按单字产出，ASCII 按词串产出（whitespace 切不开中文）", () => {
  // 「端口健康检查」是**一个**空白分隔单元，那是本模块存在的原因。
  assert.deepEqual(tokenize("端口健康检查"), ["端", "口", "健", "康", "检", "查"]);
  assert.deepEqual(tokenize("dev-hub.rs v2"), ["dev", "hub", "rs", "v2"]);
  assert.deepEqual(tokenize("Rust Analyzer"), ["rust", "analyzer"], "大小写折掉，查询侧同一个函数");
  assert.deepEqual(tokenize("端口 proxy 健康"), ["端", "口", "proxy", "健", "康"]);
  assert.deepEqual(tokenize(""), [], "空串不产出 token，而不是一个空 token");
  assert.deepEqual(tokenize("   ,, -- "), []);
  // 数字是仓库名里的真实检索项（python2、v2），不能和字母混成一类。
  assert.deepEqual(tokenize("py2rocks"), ["py2rocks"], "字母数字连续段是一个词");
  assert.deepEqual(tokenize("2024"), ["2024"]);
});

test("bm25 分词: 非 ASCII 拉丁字母按分隔符处理（写清楚，不是漏了）", () => {
  // The documented consequence: an owner named `Müller` indexes as `m` + `ller`.
  // Pinned so a later change to the range table is a visible decision, not a silent
  // improvement nobody noticed.
  assert.deepEqual(tokenize("Müller"), ["m", "ller"]);
});

// ---------------------------------------------------------------------------
// 2. 字段权重：名称命中胜过描述命中

test("bm25: 名称命中的文档排在描述命中之前", () => {
  // rust-analyzer carries `rust` in `name`, rustbook carries it in `description`.
  // The gap between the two is the field weight (3 vs 1) — the length effect on top
  // of it is far too small to flip the order, which is what the assertion pins: an
  // occurrence in a *name* is a stronger signal than one buried in prose.
  const scores = scoresOf("rust");
  const byName = scores.get("github.com/rust-lang/rust-analyzer");
  const byDescription = scores.get("github.com/other/rustbook");
  assert.ok(byName !== undefined && byDescription !== undefined, "both documents must match");
  assert.ok(
    byName > byDescription,
    `名称权重应当压过描述权重: name=${byName} description=${byDescription}`,
  );
});

test("bm25: 字段分数带回来的正是真正命中的那个字段", () => {
  const hit = at(searchBm25(index, "rust", { limit: 1 }), 0);
  assert.ok(hit, "there is a top hit");
  assert.equal(hit.id, "github.com/rust-lang/rust-analyzer");
  assert.ok(atKey(hit.fieldScores, "name") > 0, "名称那一路有分数，界面才说得出「匹配在名称」");
  assert.equal(hit.fieldScores.description, undefined, "没命中的字段不出现在证据里");
});

test("bm25: 权重为 0 等于把这个字段关掉", () => {
  const muted = buildBm25Index(CORPUS, { fieldWeights: { ...WEIGHTS, description: 0 } });
  // `rust` still sits in rustbook's description; with that field weighted 0 the
  // document must drop out of the ranking entirely rather than score a small positive.
  const ids = searchBm25(muted, "rust", { limit: 50 }).map((h) => h.id);
  assert.deepEqual(ids, ["github.com/rust-lang/rust-analyzer"]);
});

// ---------------------------------------------------------------------------
// 3. IDF：稀有词压过常见词

test("bm25 IDF: 用的是今天工程上那一支（带 1 + 的非负形式）", () => {
  // ln(1 + (N - df + 0.5)/(df + 0.5)) — pinned as numbers so a switch to the classic
  // form (which goes negative past df > N/2) cannot be folded in as a drive-by.
  assert.equal(bm25Idf(4, 1), Math.log(1 + (4 - 1 + 0.5) / (1 + 0.5)));
  assert.ok(Math.abs(bm25Idf(4, 1) - 1.2039728043259361) < 1e-12, bm25Idf(4, 1).toString());
  // A term in every document: small, and above all **not negative**.
  assert.ok(bm25Idf(4, 4) > 0);
  assert.ok(Math.abs(bm25Idf(4, 4) - Math.log(1 + 0.5 / 4.5)) < 1e-12);
  // df beyond N (a hand-built index) cannot flip the sign either.
  assert.ok(bm25Idf(3, 9) >= 0, "df 越界也夹回非负");
});

test("bm25: 稀有词比常见词贡献更多分数，即使词频与长度完全一样", () => {
  // `both` carries `rare` (df 1) and `common` (df 4) in the same field, tf 1 each;
  // the three other documents carry `common` too. Same document, same field, same
  // tf, same length → the only difference between the two queries is IDF.
  const rare = scoresOf("rare").get("github.com/df/both");
  const common = scoresOf("common").get("github.com/df/both");
  assert.ok(rare !== undefined && common !== undefined);
  assert.ok(rare > common, `稀有词应当更值钱: rare=${rare} common=${common}`);
  assert.equal(dfOf(index, "rare"), 1);
  assert.equal(dfOf(index, "common"), 4, "每篇都含的词 df 等于文档数");
});

// ---------------------------------------------------------------------------
// 4. 长度归一化：b

test("bm25: 同样的词频，长文档被扣分", () => {
  // `short` is a 1-token description, `long` a 9-token one, both with tf(`code`) = 1
  // and the same `name` length of one token.
  const scores = scoresOf("code");
  const short = scores.get("github.com/len/short");
  const long = scores.get("github.com/len/long");
  assert.ok(short !== undefined && long !== undefined, "两篇都命中 code");
  assert.ok(short > long, `短文档应当排在前面: short=${short} long=${long}`);
});

test("bm25: b=0 关掉长度惩罚，b=1 打满", () => {
  // The property that makes `b` mean something: at b=0 the length ratio must not
  // enter the score at all, so the two documents come out level; at b=1 the gap
  // widens versus the default. Query-time overrides are the point of exposing `b`
  // per search rather than only per index.
  const level = searchBm25(index, "code", { b: 0, limit: 50 });
  const byId = new Map(level.map((h) => [h.id, h.score]));
  assert.equal(
    byId.get("github.com/len/short"),
    byId.get("github.com/len/long"),
    "b=0 时长度比影响完全无效",
  );
  const soft = scoresOf("code", { b: BM25_B_DEFAULT });
  const hard = scoresOf("code", { b: 1 });
  const ratio = (s: Map<string, number>) =>
    (s.get("github.com/len/long") as number) / (s.get("github.com/len/short") as number);
  assert.ok(ratio(hard) < ratio(soft), "b 越大，长文档被压得越狠");
});

test("bm25: k1 让词频饱和，加参数可以覆盖", () => {
  const corpus = [
    { id: "a", fields: { name: "widget", description: "grep grep grep grep grep grep grep grep" } },
    { id: "b", fields: { name: "widget", description: "grep" } },
  ];
  const idx = buildBm25Index(corpus, { fieldWeights: { name: 1, description: 1 } });
  const eight = at(searchBm25(idx, "grep", { limit: 10 }), 0);
  assert.equal(eight.id, "a", "tf 高的一篇还是更高分");
  // …but not eight times higher: the marginal gain flattens, which is the whole
  // reason this is BM25 and not TF-IDF. With no saturation it would be exactly 8x.
  const one = at(searchBm25(idx, "grep", { limit: 10 }), 1);
  assert.ok(eight.score < one.score * 8, "词频的边际收益必须递减");
  // k1 = 0 collapses the term-frequency term to a boolean "present or not": equal
  // lengths here (the two descriptions differ, so use a same-length pair).
  const flat = buildBm25Index(
    [
      { id: "x", fields: { name: "aa bb", description: "" } },
      { id: "y", fields: { name: "aa cc", description: "" } },
    ],
    { fieldWeights: { name: 1 } },
  );
  assert.equal(searchBm25(flat, "aa", { k1: 0, limit: 10 }).length, 2);
  assert.equal(BM25_K1_DEFAULT, 1.2, "默认值与 Lucene 的默认一致");
  assert.equal(BM25_B_DEFAULT, 0.75);
});

// ---------------------------------------------------------------------------
// 5. 中文查询真的能命中

test("bm25: 查「端口」命中名称里带它的文档，并排在只描述里带它的文档之前", () => {
  const hits = searchBm25(index, "端口", { limit: 10 });
  assert.ok(hits.length > 0, "CJK 查询不能因为分不出来而永远为空");
  assert.equal(at(hits, 0).id, "github.com/owner/端口转发", "名称里两个字都在的排第一");
  assert.ok(atKey(at(hits, 0).fieldScores, "name") > 0);
  assert.ok(
    hits.some((h) => h.id === "github.com/owner/proxy"),
    "描述里含「端口」的也应被召回（单字分词的召回面）",
  );
});

test("bm25: 单字分词不要求相邻，这一点是有意的（钉住代价，不是钉住优点）", () => {
  // 「端」和「口」分别出现在两句里的文档也会得分 —— 这是 §3 里那条诚实的代价。
  // 它应当**得分更低**，而不是不出现在结果里；写成测试是为了将来收紧成邻近匹配时
  // 这条必须一起改，而不是被「顺手优化」掉。
  const corpus = [
    { id: "far", fields: { name: "终端", description: "这个工具负责开口与合口" } },
    { id: "near", fields: { name: "端口", description: "端口管理" } },
  ];
  const idx = buildBm25Index(corpus, { fieldWeights: { name: 3, description: 1 } });
  const scores = new Map(searchBm25(idx, "端口", { limit: 10 }).map((h) => [h.id, h.score]));
  assert.ok(scores.has("far"), "分开出现也算命中");
  assert.ok((scores.get("near") as number) > (scores.get("far") as number), "但相邻的那篇更高分");
});

// ---------------------------------------------------------------------------
// 6. 空查询、top-k、确定性

test("bm25: 空查询（含纯标点）什么都不返回", () => {
  assert.deepEqual(searchBm25(index, "", { limit: 10 }), []);
  assert.deepEqual(searchBm25(index, "   ", { limit: 10 }), []);
  assert.deepEqual(searchBm25(index, "…——•", { limit: 10 }), []);
  assert.deepEqual(searchBm25(index, "notaterm", { limit: 10 }), [], "查不到也是空，不是全部");
});

test("bm25: top-k 尊重 k，且不改变相对顺序", () => {
  const all = searchBm25(index, "common", { limit: Infinity });
  assert.equal(all.length, 4, "语料里四篇都含 common");
  assert.equal(searchBm25(index, "common", { limit: 2 }).length, 2);
  assert.equal(searchBm25(index, "common", { limit: 1 }).length, 1);
  assert.deepEqual(searchBm25(index, "common", { limit: 0 }), [], "k=0 是「我要 0 条」，不是「默认 10 条」");
  // The default cap only shows on a corpus bigger than it, so build one: 12 documents
  // that all match, and check exactly `BM25_DEFAULT_LIMIT` come back.
  const wide = buildBm25Index(
    Array.from({ length: 12 }, (_, i) => ({ id: `d${String(i).padStart(2, "0")}`, fields: { name: "widget" } })),
  );
  assert.equal(searchBm25(wide, "widget").length, BM25_DEFAULT_LIMIT, "没写 k 时按默认档截断");
  assert.equal(searchBm25(wide, "widget", { limit: Infinity }).length, 12);
  assert.deepEqual(
    searchBm25(index, "common", { limit: 3 }).map((h) => h.id),
    all.slice(0, 3).map((h) => h.id),
    "截断取前缀，不是重新排一遍",
  );
  assert.deepEqual(searchBm25(index, "common", { limit: -5 }), [], "负的 k 夹到 0，不悄悄变成默认 10 条");
  assert.deepEqual(searchBm25(index, "common", { limit: Number.NEGATIVE_INFINITY }), []);
});

test("bm25: 同分按 doc id 的码点先后，不用 localeCompare", () => {
  // Two documents with byte-identical fields: their scores must come out equal, so
  // the tie-break is all the caller sees. Code point puts `a/B` before `a/b`
  // (U+0042 < U+0062); the renderer's collator does the opposite in ICU's default
  // order, and a ranking whose ties break differently per machine locale is a
  // ranking no test on another box can reproduce.
  const tied = buildBm25Index(
    [
      { id: "z/a/b", fields: { name: "widget" } },
      { id: "z/a/B", fields: { name: "widget" } },
      { id: "z/A", fields: { name: "widget" } },
    ],
    { fieldWeights: { name: 1 } },
  );
  const ids = searchBm25(tied, "widget", { limit: 10 }).map((h) => h.id);
  assert.deepEqual(ids, ["z/A", "z/a/B", "z/a/b"]);
  assert.ok(
    new Set(searchBm25(tied, "widget", { limit: 10 }).map((h) => h.score)).size === 1,
    "三篇的分数本来就该相同",
  );
});

test("bm25: 两次搜索、重建两次索引，结果逐字段一致", () => {
  const again = buildBm25Index(CORPUS, { fieldWeights: WEIGHTS });
  assert.deepEqual(searchBm25(index, "端口 rust", { limit: 10 }), searchBm25(index, "端口 rust", { limit: 10 }));
  assert.deepEqual(searchBm25(again, "端口 rust", { limit: 10 }), searchBm25(index, "端口 rust", { limit: 10 }));
  // Repeated query terms are de-duplicated, so typing a word twice cannot buy rank.
  assert.deepEqual(searchBm25(index, "rust", { limit: 10 }), searchBm25(index, "rust rust rust", { limit: 10 }));
});

// ---------------------------------------------------------------------------
// 7. 边界：进来的是垃圾也得活着出来

test("bm25: 畸形文档被丢弃而不是抛错", () => {
  const junk = [
    null,
    { id: "", fields: { name: "no id" } },
    { id: 42, fields: { name: "numeric id" } },
    { id: "ok" },
    { id: "ok2", fields: { name: null, description: "real text" } },
    { id: "dup", fields: { name: "first" } },
    { id: "dup", fields: { name: "second" } },
  ] as unknown as Bm25Document[];
  const idx = buildBm25Index(junk, { fieldWeights: { name: 1, description: 1 } });
  assert.equal(idx.docCount, 2, "只有 ok2 与 dup 两条活下来");
  // `null` 没有 id、空 id、数字 id、没有 fields 的都掉出去；`name: null` 那篇仍然有效
  // （描述是它的文本），重复 id 只留一篇（后写的替换先写的）。
  assert.equal(idx.docs.has("dup"), true);
  assert.equal(idx.docs.get("dup")?.fields.get("name")?.tf.get("second"), 1, "同 id 以最后一次写入为准");
  assert.equal(idx.docs.get("ok2")?.fields.has("name"), false, "非字符串字段不进语料，也不进「undefined」这个词");
  assert.deepEqual(searchBm25(idx, "undefined", { limit: 10 }), [], "字段缺失不该变成可搜到的词");
  assert.deepEqual(buildBm25Index([], {}).docCount, 0);
  assert.deepEqual(searchBm25(buildBm25Index([], {}), "anything", { limit: 10 }), []);
});

test("bm25: 参数传垃圾回到默认值，不产生 NaN 分数", () => {
  const idx = buildBm25Index(CORPUS, { k1: NaN, b: 99, fieldWeights: { name: -3, description: NaN } });
  assert.equal(idx.k1, BM25_K1_DEFAULT, "认不出的 k1 回落默认");
  // `b` is a fraction, so an out-of-range one is *clamped* rather than dropped: 99
  // means "punish length as hard as the formula allows", which is a readable intent,
  // whereas NaN has none. Negative weights are not an intent — they would subtract
  // from a score — so those fall back to 1 instead.
  assert.equal(idx.b, 1, "b 越界夹到 1，不是夹回 0.75");
  const hits = searchBm25(idx, "rust", { limit: 10 });
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(Number.isFinite(h.score) && h.score > 0, `分数必须是正有限数: ${h.id} ${h.score}`);
  }
  assert.equal(
    searchBm25(idx, "rust", { limit: 10, k1: -1, b: Number.NaN }).length,
    hits.length,
    "查询时的垃圾参数同样回落，不是变成 0 条",
  );
});

test("bm25 分词器选项: 索引与查询复用同一个 splitter，垃圾值回落默认", () => {
  // r22-R2: the CJK bakeoff needs to score the *real* formula with another
  // segmentation. The index owns the tokenizer so a query can never be split
  // differently from the documents it is compared against.
  const bigram = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g)) {
      const run = [...m[0]];
      if (run.length === 1 || /^[a-z0-9]+$/.test(m[0])) out.push(m[0]);
      else {
        for (let i = 0; i + 1 < run.length; i += 1) {
          const a = run[i];
          const b = run[i + 1];
          if (a !== undefined && b !== undefined) out.push(a + b);
        }
      }
    }
    return out;
  };
  const docs = [
    { id: "health", fields: { name: "端口健康检查" } },
    { id: "other", fields: { name: "端口分配" } },
  ];
  const idx = buildBm25Index(docs, { tokenizer: bigram });
  assert.equal(idx.tokenizer, bigram, "索引记住自己用的 splitter");
  assert.deepEqual(
    searchBm25(idx, "健康检查").map((h) => h.id),
    ["health"],
    "查询侧用同一切分：二元组命中 '健康'/'康检'/'检查'，'端口分配' 不该得分",
  );
  const fallback = buildBm25Index(docs, { tokenizer: 42 as unknown as (t: string) => string[] });
  assert.deepEqual(
    searchBm25(fallback, "端口").map((h) => h.id).sort(),
    ["health", "other"],
    "不是函数的 splitter 回落默认单字切分，索引仍可查询",
  );
});
