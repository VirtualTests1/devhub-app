/**
 * The command palette's matching rule, as a pure function (r21-R1-2).
 *
 * ## Why this file exists
 *
 * Until this round the rule lived as a module-private `function score()` inside
 * `CommandPalette.tsx` — unreachable by the test suite, because `.tsx` cannot be
 * loaded under Node's type stripping (`tests/helpers/ts-resolver.mjs` only tries
 * `.ts`). The result was that no comparison against `score()` was
 * possible, because there was nothing to call. Extracting it changed no behaviour —
 * the body below is character-for-character the one `CommandPalette.tsx` shipped —
 * and `tests/palette-score.test.ts` pins that behaviour so the rule cannot drift
 * unnoticed.
 *
 * ## The rule itself
 *
 * A three-way if-chain over one concatenated string, returning:
 *
 * | 命中方式 | 分值 | 例 |
 * |---|---|---|
 * | 前缀 | 3 | `re` → `refresh scan …` |
 * | 子串 | 2 | `scan` → `refresh scan …` |
 * | 子序列 | 1 | `zjx` → `最近使用` |
 * | 未命中 | -1 | `zzz` → 大多数行 |
 *
 * The subsequence branch is deliberate: it is what lets an initialism-style query
 * (`zjx`) find a Chinese label whose characters `includes()` would never match.
 * `0` means "empty needle" (an empty query shows the default slice rather than
 * scoring every row), which is why the caller filters on `s > 0`.
 *
 * Comparison is case-insensitive on both sides via `toLowerCase()`, not
 * `toLocaleLowerCase()` — a locale-sensitive fold would make the ranking depend on
 * the machine's language settings.
 *
 * No DOM, no React, no package: `tests/lib-import-graph.test.ts` loads every
 * `src/lib/**` module under Node's type stripping.
 */

/**
 * Score `needle` against `hay`: 3 prefix / 2 substring / 1 subsequence / -1 miss /
 * 0 empty needle.
 */
export function score(hay: string, needle: string): number {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (h.startsWith(n)) return 3;
  if (h.includes(n)) return 2;
  // subsequence match, so "zjx" still finds "最近使用"
  let i = 0;
  for (const ch of h) if (ch === n[i]) i++;
  return i === n.length ? 1 : -1;
}

/**
 * The score one palette row gets: the better of its label and its keywords.
 *
 * Extracted with `score` because it is the row-level rule — the palette calls
 * `Math.max(score(label), score(keywords))` and so does the bake-off, and a
 * hand-written copy in the bench script is precisely the second-source drift
 * `tests/single-source.test.ts` exists to catch. Rows scoring ≤ 0 are filtered out
 * by the caller (an empty needle scores 0, a miss scores -1).
 */
export function scoreRow(label: string, keywords: string, query: string): number {
  return Math.max(score(label, query), score(keywords, query));
}
