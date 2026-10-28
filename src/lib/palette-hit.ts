/**
 * Palette hit evidence (r21-n2-3): what a BM25 `reason` looks like to a person.
 *
 * `searchLocal` answers with a field *identifier* (`"description"`, `"readme"`,
 * …) precisely so no UI copy lives in `lib/local-index.ts`. This module is the
 * thin, pure bridge between that identifier and the row the palette renders:
 * which dictionary entry spells it, and which slice of the matched field is
 * worth showing as a snippet. The JSX stays in `CommandPalette.tsx`; everything
 * a Node test can decide is here (the runner cannot import `.tsx`).
 *
 * ## Labels: existing dictionary entries first, English fallback second
 *
 * `src/lib/i18n.ts` is owned by another stream this round, so no key may be
 * added. Three of the seven fields already have entries that say exactly the
 * right word in both languages — `wall.sort.name` (名称/Name),
 * `wall.sort.desc` (描述/Description), `wall.sort.owner` (拥有者/Owner) — plus
 * `wall.tagChips.label` (标签/Tags) and `readme.settingsRow` (README). The two
 * that do not (`alias`, `path`) fall back to short ASCII identifiers; a
 * technical tag in the row beats either a wrong dictionary word or a Chinese
 * literal in `.tsx` (which `tests/zh-hardcode-ratchet.test.ts` would catch).
 * When the i18n stream registers 别名 / 路径, this table grows by two lines.
 *
 * ## Ranking: BM25 complements the if-chain, fused per query (r21-r1-2)
 *
 * The palette's own `score()` only ever compares label/keywords — it cannot
 * find a word that exists solely in a description or a README heading. A BM25
 * hit therefore joins the ranking through [`fusePaletteScores`]: each list is
 * min-max normalised *for the query at hand*, then combined as
 * `0.4·norm(base) + 0.6·norm(hit)`. The weights and the rule itself are the
 * `wsum-40-60` strategy that won the offline comparison against the earlier
 * band-join — the rank-fusion experiment (locked margin criterion, per-query
 * results). Two scales
 * are never added raw: normalising is what keeps a ten-token BM25 magnitude
 * from drowning the if-chain's integers.
 *
 * [`paletteScoreOf`] — the earlier "BM25 sits in the 2–3 band below a prefix
 * match" rule — is kept as the measured *baseline* (strategy `band-join`): the
 * bench still ranks it every run, and `tests/palette-hit.test.ts` pins its
 * semantics so the baseline cannot drift underneath the comparison.
 */
import { tokenize } from "./bm25";
import type { TFunc, TranslationKey } from "./i18n";
import { type LocalDoc, type LocalField, type LocalHit } from "./local-index";

/** Dictionary entry per field, or `null` when the dictionary has no such word
 *  yet (see the module note: `alias` and `path` are the two today). */
const LABEL_KEYS: Readonly<Record<LocalField, TranslationKey | null>> = {
  name: "wall.sort.name",
  alias: null,
  description: "wall.sort.desc",
  readme: "readme.settingsRow",
  tags: "wall.tagChips.label",
  owner: "wall.sort.owner",
  path: null,
};

/** English identifiers for the fields the dictionary does not name. Short,
 *  ASCII, and deliberately not sentences — same rule as `reason` itself. */
const LABEL_FALLBACK: Readonly<Record<LocalField, string>> = {
  name: "name",
  alias: "alias",
  description: "desc",
  readme: "README",
  tags: "tags",
  owner: "owner",
  path: "path",
};

/** The visible label for a hit field: dictionary word when one exists, the
 *  English identifier otherwise. */
export function localFieldLabelOf(field: LocalField, t: TFunc): string {
  const key = LABEL_KEYS[field];
  return key === null ? LABEL_FALLBACK[field] : t(key);
}

/** How many characters of evidence a row may show. Short enough that the
 *  repository name still fits next to it on a 38 rem panel. */
export const PALETTE_SNIPPET_CHARS = 72;

/**
 * The window of `fieldText` around the first query token that occurs in it.
 *
 * Tokenisation is `bm25.ts`'s own, so a CJK query looks for the same single
 * characters the index matched — searching the raw multi-token query string
 * would demand adjacency the bag-of-chars score never required. If no token
 * occurs verbatim (possible when the hit scored on characters that lowercasing
 * split), the head of the field is shown — the user still learns what the
 * repository says about itself.
 *
 * `null` for an empty field: the caller renders no snippet rather than an ellipsis.
 */
export function hitSnippetOf(fieldText: unknown, query: string, maxLen: number = PALETTE_SNIPPET_CHARS): string | null {
  if (typeof fieldText !== "string") return null;
  const text = fieldText.trim();
  if (text === "") return null;
  const width = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : PALETTE_SNIPPET_CHARS;
  const lower = text.toLowerCase();
  let at = -1;
  for (const token of tokenize(query)) {
    const i = lower.indexOf(token);
    if (i >= 0) {
      at = i;
      break;
    }
  }
  if (at < 0) at = 0;
  // Start a third of a window before the match, so the term is not glued to
  // the left edge when there is context to show.
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const slice = text.slice(start, end).trim();
  if (slice === "") return null;
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/** What the row shows as evidence: the field identifier plus the snippet to
 *  render next to its label. `snippet` is `null` when the field carries no
 *  text worth a window (possible for `path`-only hits on exotic cards). */
export type PaletteEvidence = { reason: LocalField; snippet: string | null };

/**
 * A BM25 hit → the evidence a row should render, or `null`.
 *
 * `null` for `reason: "name"`: the row already prints the repository name, and
 * a "name: name" badge would be noise. Also `null` when the document has left
 * the index between search and render (the index is rebuilt per keystroke; the
 * hit list is a memo input, not a subscription).
 */
export function paletteEvidenceOf(
  docs: ReadonlyMap<string, LocalDoc>,
  hit: LocalHit,
  query: string,
): PaletteEvidence | null {
  if (hit.reason === "name") return null;
  const field = docs.get(hit.slug)?.fields[hit.reason];
  if (field === undefined || field === "") return null;
  return { reason: hit.reason, snippet: hitSnippetOf(field, query) };
}

/** A BM25 hit ranks inside [2, 3): above a substring match, below an exact
 *  prefix match. No hit → the if-chain's own score, unchanged.
 *
 *  Historical note (r21-r1-2): this was the palette's production blending rule
 *  until the rank-fusion experiment replaced it in the `ranked` memo. It stays
 *  exported because that experiment scores it as the
 *  `band-join` baseline on every run and because its semantics are pinned —
 *  the baseline a comparison is made against must not move. */
export const PALETTE_BM25_SCORE_FLOOR = 2;

/**
 * Combine the if-chain score with an optional BM25 hit (band-join baseline).
 *
 * The normalisation (`score / 20`, capped at 0.99) keeps the hit monotonic in
 * the BM25 magnitude — among BM25 hits, stronger evidence still wins — while
 * the whole band stays under a prefix match. The divisor is a ranking choice,
 * not a measured constant; it exists so ten-token queries cannot escape the
 * band, and it is pinned by `tests/palette-hit.test.ts` rather than by any
 * claim about BM25's numeric range.
 */
export function paletteScoreOf(base: number, hit: LocalHit | undefined): number {
  if (!hit) return base;
  const normalised = Math.max(0, hit.score) / 20;
  return Math.max(base, PALETTE_BM25_SCORE_FLOOR + Math.min(0.99, normalised));
}

// ---------------------------------------------------------------------------
// Fusion: the strategy the gold-set experiment selected (r21-r1-2)

/** Weight on the if-chain half of the fused score — the measured winner is
 *  `wsum-40-60` (locked criterion, § r1-2). */
export const PALETTE_FUSION_BASE_WEIGHT = 0.4;

/** Weight on the BM25 half of the fused score (same source as above). */
export const PALETTE_FUSION_BM25_WEIGHT = 0.6;

/** One row's inputs to the fusion: the if-chain score and the optional BM25
 *  hit for the same query. Both halves are absent-able, and absence scores 0. */
export type PaletteFusionInput = { base: number; hit: LocalHit | undefined };

/**
 * Per-query min-max normalisation of one list, then the fixed-weight sum.
 *
 * Norms follow exactly what the bench's `normMapOf` does over each full list:
 * the population is the rows present in that list (base > 0 for the if-chain,
 * hit present for BM25 — `searchLocal` never returns a 0 score), a single
 * distinct value normalises to 1, and a row *absent* from a list scores 0 in
 * it. An all-zero result means "neither list has evidence for this row", which
 * the caller drops the same way it dropped `s <= 0` before.
 *
 * Returning numbers index-aligned with `inputs` (rather than per-row `f(x)`)
 * is deliberate: min-max needs every row of the query first, so the two-pass
 * shape is the smallest honest form of this rule.
 *
 * Measured on the gold set against the band-join it replaces
 * (`docs/r21-rank-fusion.md`): Recall@10 unchanged at 0.9907, MRR@10
 * 0.8750 → 0.9213, no query's first-hit rank regressed.
 */
export function fusePaletteScores(inputs: readonly PaletteFusionInput[]): number[] {
  let minBase = Infinity;
  let maxBase = -Infinity;
  let minHit = Infinity;
  let maxHit = -Infinity;
  for (const input of inputs) {
    if (input.base > 0) {
      if (input.base < minBase) minBase = input.base;
      if (input.base > maxBase) maxBase = input.base;
    }
    const hitScore = input.hit?.score;
    if (hitScore !== undefined) {
      if (hitScore < minHit) minHit = hitScore;
      if (hitScore > maxHit) maxHit = hitScore;
    }
  }

  const out: number[] = [];
  for (const input of inputs) {
    const normBase =
      input.base > 0 ? (maxBase > minBase ? (input.base - minBase) / (maxBase - minBase) : 1) : 0;
    const hitScore = input.hit?.score;
    const normBm25 =
      hitScore !== undefined ? (maxHit > minHit ? (hitScore - minHit) / (maxHit - minHit) : 1) : 0;
    out.push(PALETTE_FUSION_BASE_WEIGHT * normBase + PALETTE_FUSION_BM25_WEIGHT * normBm25);
  }
  return out;
}
