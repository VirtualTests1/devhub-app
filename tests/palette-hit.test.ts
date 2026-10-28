/**
 * r21-n2-3 — the palette's hit-evidence layer (`lib/palette-hit.ts`): label
 * resolution (dictionary word or English fallback), the snippet window, the
 * name-suppression rule and the BM25/if-chain score blend. r21-r1-2 adds the
 * fusion rule (`fusePaletteScores`, wsum-40-60) that replaced the band-join in
 * production — the band-join (`paletteScoreOf`) stays pinned below because the
 * bench still measures it as the baseline every run.
 *
 * The translator is a fake (`[key]`), because the real `t` needs the whole
 * dictionary and this module's decisions are about *which* key, not about the
 * translations themselves — the dictionary has its own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PALETTE_BM25_SCORE_FLOOR,
  PALETTE_FUSION_BASE_WEIGHT,
  PALETTE_FUSION_BM25_WEIGHT,
  PALETTE_SNIPPET_CHARS,
  fusePaletteScores,
  hitSnippetOf,
  localFieldLabelOf,
  paletteEvidenceOf,
  paletteScoreOf,
} from "../src/lib/palette-hit.ts";
import {
  buildLocalIndex,
  searchLocal,
  type LocalField,
  type LocalHit,
} from "../src/lib/local-index.ts";
import type { TFunc, TranslationKey } from "../src/lib/i18n.ts";

import { at } from "./helpers/definite.ts";

const t: TFunc = (key: TranslationKey) => `[${key}]`;

const hit = (slug: string, reason: LocalField, score = 1): LocalHit => ({
  slug,
  name: slug.split("/").pop() ?? slug,
  score,
  reason,
});

// ---------------------------------------------------------------------------
// 1. 标签：词表优先，英文兜底

test("palette-hit: 有词表项的字段走词表键（可被测试看到）", () => {
  assert.equal(localFieldLabelOf("name", t), "[wall.sort.name]");
  assert.equal(localFieldLabelOf("description", t), "[wall.sort.desc]");
  assert.equal(localFieldLabelOf("readme", t), "[readme.settingsRow]");
  assert.equal(localFieldLabelOf("tags", t), "[wall.tagChips.label]");
  assert.equal(localFieldLabelOf("owner", t), "[wall.sort.owner]");
});

test("palette-hit: 词表没有的字段回落到英文标识，不编造、不硬编码中文", () => {
  assert.equal(localFieldLabelOf("alias", t), "alias");
  assert.equal(localFieldLabelOf("path", t), "path");
  for (const field of ["alias", "path"] as const) {
    assert.match(localFieldLabelOf(field, t), /^[a-z]+$/, "兜底标签是 ASCII 标识");
  }
});

// ---------------------------------------------------------------------------
// 2. snippet：围绕首个命中 token 开窗

test("palette-hit: snippet 围绕命中词开窗，两端省略号标出裁剪", () => {
  const text = `${"前文 ".repeat(40)}端口排查 ${"后文 ".repeat(40)}`;
  const snippet = hitSnippetOf(text, "端口");
  assert.ok(snippet !== null);
  assert.ok(snippet.includes("端口"), "命中词必须在窗口里");
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), "两侧都被裁过");
  assert.ok((snippet?.length ?? 0) <= PALETTE_SNIPPET_CHARS + 2, "窗口有上限");
});

test("palette-hit: 开头的命中不加前省略号；多词查询取首个命中的 token", () => {
  const snippet = hitSnippetOf("Installation guide for rust-analyzer", "installation missing");
  assert.equal(snippet, "Installation guide for rust-analyzer");
});

test("palette-hit: 没有 token 逐字命中时展示开头（bag-of-chars 的降级展示）", () => {
  const snippet = hitSnippetOf("完全不相关的句子", "zzz");
  assert.equal(snippet, "完全不相关的句子");
});

test("palette-hit: 空字段 / 非字符串 → null（渲染层不显示省略号占位）", () => {
  assert.equal(hitSnippetOf("", "x"), null);
  assert.equal(hitSnippetOf("   ", "x"), null);
  assert.equal(hitSnippetOf(null, "x"), null);
  assert.equal(hitSnippetOf(42, "x"), null);
});

// ---------------------------------------------------------------------------
// 3. evidence：name 不做徽标，其余字段带 snippet

test("palette-hit: reason=name 不给证据（行里已经印着名字）", () => {
  const index = buildLocalIndex([{ host: "github.com", owner: "o", repo: "proj" }]);
  assert.equal(paletteEvidenceOf(index.docs, hit("github.com/o/proj", "name"), "proj"), null);
});

test("palette-hit: description/readme 命中带字段标识与 snippet", () => {
  const index = buildLocalIndex([
    {
      host: "github.com",
      owner: "vercel",
      repo: "next.js",
      description: "The React Framework for the Web",
      readmeHeadings: ["Installation", "Configuration"],
    },
  ]);
  const byDesc = paletteEvidenceOf(
    index.docs,
    hit("github.com/vercel/next.js", "description"),
    "react",
  );
  assert.deepEqual(byDesc, { reason: "description", snippet: "The React Framework for the Web" });
  const byReadme = paletteEvidenceOf(
    index.docs,
    hit("github.com/vercel/next.js", "readme"),
    "configuration",
  );
  assert.equal(byReadme?.reason, "readme");
  assert.ok(byReadme?.snippet?.includes("Configuration"));
});

test("palette-hit: 文档已不在索引时给 null（重建与命中列表之间的缝）", () => {
  const index = buildLocalIndex([]);
  assert.equal(paletteEvidenceOf(index.docs, hit("github.com/o/gone", "description"), "x"), null);
});

// ---------------------------------------------------------------------------
// 4. 排序：BM25 补在 if 链看不见的字段上，落在 2–3 档

test("palette-hit: 无命中时分数原样；有命中时落在 2–3 档且随 BM25 分单调", () => {
  assert.equal(paletteScoreOf(3, undefined), 3);
  assert.equal(paletteScoreOf(-1, undefined), -1);
  assert.ok(PALETTE_BM25_SCORE_FLOOR <= paletteScoreOf(-1, hit("s", "description", 0.001)));
  const weak = paletteScoreOf(-1, hit("s", "description", 1));
  const strong = paletteScoreOf(-1, hit("s", "description", 8));
  const huge = paletteScoreOf(-1, hit("s", "description", 10_000));
  assert.ok(weak < strong, "BM25 分更高 → 档内更高");
  assert.ok(strong < huge && huge < 3, "封顶仍在前缀匹配之下");
  assert.ok(weak > 2 - Number.EPSILON, "命中至少压过子序列匹配");
});

test("palette-hit: 基础分更高的行不被弱 BM25 命中压过（max 语义）", () => {
  assert.equal(paletteScoreOf(3, hit("s", "description", 1)), 3, "前缀匹配 3 保持");
  assert.ok(paletteScoreOf(2, hit("s", "tags", 0.5)) >= 2, "子串匹配 2 只升不降");
  assert.ok(paletteScoreOf(1, hit("s", "tags", 5)) > 2, "子序列 1 被命中抬进 2+ 档");
});

// ---------------------------------------------------------------------------
// 4b. 融合（r21-r1-2）：wsum-40-60 —— 金标准实验选中的生产规则

test("fusePaletteScores: 两侧都无证据的行得 0，输出与输入逐位对齐", () => {
  const out = fusePaletteScores([
    { base: -1, hit: undefined },
    { base: 0, hit: undefined },
  ]);
  assert.deepEqual(out, [0, 0]);
  assert.equal(out.length, 2, "index-aligned：调用方按位取分");
});

test("fusePaletteScores: 无 BM25 命中时保序 if 链（min-max 是单调变换）", () => {
  const fused = fusePaletteScores([
    { base: 3, hit: undefined },
    { base: 2, hit: undefined },
    { base: 1, hit: undefined },
  ]);
  // min=1 / max=3 → 3→1、2→0.5、1→0，各自乘 0.4。
  const prefix = at(fused, 0);
  const substring = at(fused, 1);
  const subsequence = at(fused, 2);
  assert.equal(prefix, PALETTE_FUSION_BASE_WEIGHT);
  assert.equal(substring, PALETTE_FUSION_BASE_WEIGHT * 0.5);
  assert.equal(subsequence, 0);
  assert.ok(prefix > substring && substring > subsequence, "保序：前缀 > 子串 > 子序列");
});

test("fusePaletteScores: 无 if 链证据时保序 BM25（分值仍是 min-max 归一）", () => {
  const fused = fusePaletteScores([
    { base: -1, hit: hit("a", "description", 1) },
    { base: -1, hit: hit("b", "description", 9) },
  ]);
  assert.equal(at(fused, 0), 0, "最低分归一化为 0");
  assert.equal(at(fused, 1), PALETTE_FUSION_BM25_WEIGHT);
});

test("fusePaletteScores: 强 BM25 证据压过纯前缀行（实验测到的翻案点）", () => {
  // band-join 下前缀 3 永远在 2–3 档之上；融合下 BM25 满档 0.6 > 前缀纯 0.4。
  const flip = fusePaletteScores([
    { base: 3, hit: undefined },
    { base: -1, hit: hit("b", "readme", 7) },
  ]);
  assert.ok(at(flip, 1) > at(flip, 0), "BM25 满档证据 > 无 BM25 的前缀行");
  // 但弱 BM25 打不过前缀行：档内名次仍由证据强度决定。
  const keep = fusePaletteScores([
    { base: 3, hit: undefined },
    { base: -1, hit: hit("a", "description", 1) },
    { base: -1, hit: hit("b", "description", 11) },
  ]);
  assert.equal(at(keep, 1), 0, "最弱命中归一化为 0");
  assert.ok(at(keep, 0) > at(keep, 1), "前缀纯分 0.4 > 弱命中的 0");
  assert.ok(at(keep, 2) > at(keep, 0), "强命中 0.6 仍压过前缀纯分 —— 证据强度说了算");
});

test("fusePaletteScores: 单值列表归一化为 1 —— 只有一行证据时它就是满档", () => {
  assert.deepEqual(fusePaletteScores([{ base: 2, hit: undefined }]), [PALETTE_FUSION_BASE_WEIGHT]);
  assert.deepEqual(fusePaletteScores([{ base: -1, hit: hit("s", "tags", 0.001) }]), [
    PALETTE_FUSION_BM25_WEIGHT,
  ]);
  // 两半都缺席才是 0；半缺席不稀释另一半（norm 计算不看缺席行）。
  const both = at(fusePaletteScores([{ base: 3, hit: hit("s", "tags", 5) }]), 0);
  assert.equal(both, PALETTE_FUSION_BASE_WEIGHT + PALETTE_FUSION_BM25_WEIGHT, "满档 + 满档 = 1");
  assert.ok(both <= 1, "上界 1：两半各自归一化后不会越界");
});

// ---------------------------------------------------------------------------
// 5. 端到端片段：从生产字段到证据（与 n2-1/n2-2 的语料同一条合并路）

test("palette-hit-e2e: 吸收来的描述命中，证据带 reason 与包含查询词的 snippet", () => {
  const index = buildLocalIndex([
    {
      host: "github.com",
      owner: "vercel",
      repo: "next.js",
      description: "React 框架，默认端口 3000",
    },
  ]);
  const hits = searchLocal(index, "框架");
  const evidence = paletteEvidenceOf(index.docs, at(hits, 0), "框架");
  assert.equal(evidence?.reason, "description");
  assert.ok(evidence?.snippet?.includes("框架"));
});
