/**
 * `src/components/CommandPalette.tsx` — the local-search wiring (r21-n2-3):
 * the palette builds a BM25 corpus from wall cards + store overlay + produced
 * extras, blends hits into the ranking, and renders the hit's field evidence.
 *
 * Structural, same harness as `tests/palette-theme-command.test.ts`: `.tsx`
 * cannot be mounted under `--experimental-strip-types` (DEVELOPMENT.md §8.1),
 * so the wiring is pinned at the source level and the behaviour it delegates
 * to (`fusePaletteScores`, `paletteEvidenceOf`, `searchLocal`) has its own pure
 * tests in `tests/palette-hit.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PALETTE = "src/components/CommandPalette.tsx";

/** Code only, line numbers preserved. */
function codeOnly(src: string): string[] {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) {
        kept.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const open = line.indexOf("/*");
    if (open >= 0) {
      const close = line.indexOf("*/", open + 2);
      if (close >= 0) line = line.slice(0, open) + line.slice(close + 2);
      else {
        line = line.slice(0, open);
        inBlock = true;
      }
    }
    const slash = line.indexOf("//");
    kept.push(slash >= 0 ? line.slice(0, slash) : line);
  }
  return kept;
}

const lines = codeOnly(readFileSync(PALETTE, "utf8"));
const code = lines.join("\n");

test("palette-local-search: 语料由卡片 + 墙上状态 + extras 合并建成", () => {
  assert.match(code, /import \{ buildLocalIndex, searchLocal \} from "\.\.\/lib\/local-index"/);
  assert.match(code, /import \{ corpusEntryOf \} from "\.\.\/lib\/corpus"/);
  assert.match(
    code,
    /const entries = repos\.map\(\(r\) => \{/,
    "索引条目逐卡片合并，删除的仓库因此永远不会残留",
  );
  assert.match(code, /corpusEntryOf\(r, wallStates\[slug\], extras\[slug\]\)/);
  assert.match(code, /return buildLocalIndex\(entries\);/);
});

test("palette-local-search: 打开时 prune extras 并发起本地 README 探测", () => {
  assert.match(code, /useCorpus\.getState\(\)\.retain\(repos\.map\(slugOf\)\)/);
  assert.match(
    code,
    /\.loadReadmes\(repos\.map\(\(r\) => \(\{ slug: slugOf\(r\), path: r\.path \?\? null \}\)\)\)/,
    "path 来自 list_repositories 本身，不再多打一次 repo_detail",
  );
});

test("palette-local-search: BM25 命中并入排序，且只作用于带 repoSlug 的项目行", () => {
  assert.match(code, /const bm25Hits = searchLocal\(localIndex, q, \{ limit: 40 \}\)/);
  assert.match(code, /const hit = c\.repoSlug === undefined \? undefined : hitBySlug\.get\(c\.repoSlug\)/);
  // r21-r1-2: this line pinned `s: paletteScoreOf(base, hit)` (the 2–3 band).
  // The rank-fusion experiment measured band-join
  // at MRR@10 0.8750 vs `wsum-40-60` at 0.9213 on the gold set with zero
  // per-query regressions (locked criterion in the bench header), so the memo
  // now scores the two lists through `fusePaletteScores` — the pin follows the
  // value it was guarding ("BM25 blends into the ranking without replacing the
  // if-chain") to the rule that won. The band itself stays pinned in
  // `tests/palette-hit.test.ts`.
  assert.match(
    code,
    /const fused = fusePaletteScores\(rows\);/,
    "分数走 fusePaletteScores（wsum-40-60，两遍：min-max 需要全行）",
  );
  // r24-N1-3: recency is a bounded tie-breaker added after fusion; the query
  // dependency became the parsed query, and recentIds joined the memo deps.
  assert.match(
    code,
    /\.map\(\(row, i\) => \(\{ c: row\.c, s: \(fused\[i\] \?\? 0\) \+ recentBoost\(row\.c\.id, recentIds\) \}\)\)/,
  );
  assert.match(code, /\}, \[commands, parsedQuery, localIndex, recentIds\]\);/);
});

test("palette-local-search: 行内渲染字段标签 + snippet，标识走 data 属性", () => {
  assert.match(code, /data-evidence=\{c\.evidence\.reason\}/);
  assert.match(code, /\{localFieldLabelOf\(c\.evidence\.reason, t\)\}/);
  assert.match(code, /\{c\.evidence\.snippet \? ` · \$\{c\.evidence\.snippet\}` : ""\}/);
});

test("palette-local-search: 命令 memo 的依赖不变（主题/语言新鲜度由既有测试钉住）", () => {
  // The theme test pins this exact dep list; the local-index wiring lives in
  // the *ranked* memo instead, deliberately — commands do not read the corpus.
  assert.match(code, /\}, \[repos, records, onRefresh, onClose, ui, theme, t\]\);/);
});
