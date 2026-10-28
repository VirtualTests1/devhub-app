/**
 * Okapi BM25 over an in-memory corpus with weighted fields (r20-R2).
 *
 * ## Why this exists, and why here
 *
 * Local search in this app has never been ranked. 命令面板's `score()` is a three-way
 * if-chain (prefix 3 / substring 2 / subsequence 1) over one concatenated keywords
 * string, so "which repository is actually about what I typed" was answered by the
 * order the backend happened to walk the disk in. The research behind choosing BM25
 * — including the two alternatives this explicitly rejects (tantivy, a `ripgrep`
 * subprocess) and what was *not* measured — is in `docs/local-search-bm25.md`.
 *
 * This module is the scoring function and nothing else. It has no knowledge of
 * repositories, slugs or UI fields (that is `local-index.ts`), it reads no files,
 * and it imports nothing — no DOM, no React, no package. That last part is a hard
 * requirement, not a style preference: `tests/lib-import-graph.test.ts` loads every
 * `src/lib/**` module under Node's type stripping, which refuses `.tsx` outright, so
 * a module that reaches for the renderer becomes un-importable and silently vanishes
 * from the unit tests that were supposed to pin it.
 *
 * ## The three properties that make a ranking worth having
 *
 *   - **term-frequency saturation** (`k1`): a document that says the word 30 times is
 *     not thirty times more relevant than one that says it once. Raw TF-IDF keeps
 *     growing; BM25 bends toward an asymptote, and `k1` is where it bends (the score
 *     for an average-length document reaches half of its ceiling at `tf ≈ k1`).
 *   - **length normalisation** (`b`): a long document has more room to contain the
 *     word by accident. `b = 0` ignores length entirely, `b = 1` discounts it fully.
 *   - **inverse document frequency**: a term in every document discriminates nothing.
 *     The form used here is the one Lucene's `BM25Similarity` documents today —
 *     `ln(1 + (N - df + 0.5) / (df + 0.5))` — and the `1 +` is the load-bearing part:
 *     the classic form goes *negative* once a term is in more than half the corpus,
 *     so a common word would start subtracting from the score instead of adding
 *     nothing to it.
 *
 * ## Fields, and per-field length statistics
 *
 * A document is a bag of named text fields, each with a weight (`name` counting more
 * than `description` is the whole reason a field-level API exists here). A field's
 * length is normalised against the average length of that field **over the documents
 * that actually carry it** — not over every document in the corpus. With 13 documents
 * of which 3 have a README, the corpus-wide average would be ~1/4 of the real one,
 * so those 3 documents would all be penalised as if they were four times too long.
 * A document without the field contributes nothing (its term frequencies are zero),
 * so it needs no placeholder length.
 *
 * ## Determinism
 *
 * Ties break on the document id by **code point**, not by `localeCompare`. The
 * renderer's ICU locale data is not part of the corpus, and a comparator whose
 * output changes with the machine's language settings is a ranking nobody can
 * reproduce — or unit-test on a different box. `Array.prototype.sort` is stable in
 * every engine this app ships on, but the comparator never relies on that either.
 */

/** Lucene's default saturation point; overridable per index. */
export const BM25_K1_DEFAULT = 1.2;

/** Lucene's default length-normalisation strength; overridable per index. */
export const BM25_B_DEFAULT = 0.75;

/** How many hits `searchBm25` returns when the caller does not say. */
export const BM25_DEFAULT_LIMIT = 10;

/** One corpus document: an id plus whatever text fields the caller has. */
export type Bm25Document = {
  id: string;
  fields: Readonly<Record<string, string>>;
};

/** How a field or a query becomes terms. Both sides of one index must use the same one. */
export type Tokenizer = (text: string) => string[];

export type Bm25Options = {
  /** Term-frequency saturation. Negative and non-finite input falls back to the default. */
  k1?: number;
  /** Length normalisation, 0–1. Out-of-range input is clamped, not trusted. */
  b?: number;
  /**
   * Tokenizer override, defaulting to [`tokenize`]. The index owns the choice and
   * [`searchBm25`] reuses it, so a query can never be split differently from the
   * documents it is scored against. Added (r22-R2) so the CJK bakeoff can compare
   * unigram/bigram/trigram on the *real* scorer instead of a look-alike copy; a
   * value that is not a function falls back to the module default rather than
   * making an index that cannot be queried.
   */
  tokenizer?: Tokenizer;
  /**
   * Multiplier per field name. A field with no entry weighs 1; a weight of 0 switches
   * the field off without removing it from the corpus. Junk values (non-finite,
   * negative) fall back to 1 rather than becoming a negative contribution.
   */
  fieldWeights?: Readonly<Record<string, number>>;
};

/** One scored document. `fieldScores` is the evidence: which field earned what. */
export type Bm25Hit = {
  id: string;
  score: number;
  /** Field name → that field's contribution, containing only the fields that scored > 0. */
  fieldScores: Record<string, number>;
};

/**
 * Query-time options. A key that is **present** overrides the index's own parameter
 * even when its value is nonsense (nonsense falls back to the module default); omit
 * the key to keep what the index was built with. Callers that forward values from
 * their own optional parameters must therefore test the type, not just pass through —
 * `local-index.ts` does.
 */
export type Bm25SearchOptions = Bm25Options & {
  /** Maximum number of hits. 0 means 0 hits; absent means `BM25_DEFAULT_LIMIT`. */
  limit?: number;
};

/**
 * Field term statistics for one document. `tf` maps term → occurrences **in that
 * field**; `length` is the number of tokens the field produced (sum of all tf).
 *
 * Exported because `Bm25Index` exposes them, and a reader of an index (a test, or
 * `local-index.ts`) should be able to name what it is holding.
 */
export type FieldStats = { length: number; tf: Map<string, number> };

export type DocRecord = { id: string; fields: Map<string, FieldStats> };

/**
 * An built index. Its fields are exposed for inspection (and for the tests that pin
 * the IDF form), but they are read-only by convention: mutate by rebuilding, or by
 * `local-index.ts`'s upsert path, never in place.
 */
export type Bm25Index = {
  readonly k1: number;
  readonly b: number;
  readonly fieldWeights: Readonly<Record<string, number>>;
  /** Document count `N` — the denominator of the IDF form. */
  readonly docCount: number;
  /** Field name → average length over the documents that carry a non-empty value. */
  readonly avgFieldLength: ReadonlyMap<string, number>;
  /** The splitter this index was built with and that every query is scored with. */
  readonly tokenizer: Tokenizer;
  /** Term → the ids of the documents containing it in *any* field (document frequency). */
  readonly postings: ReadonlyMap<string, readonly string[]>;
  /** id → the document, kept so scoring can read per-field term frequencies. */
  readonly docs: ReadonlyMap<string, DocRecord>;
};

/**
 * The IDF Lucene documents today: `ln(1 + (N - df + 0.5) / (df + 0.5))`.
 *
 * Exported because "which IDF" is the single most quietly-contested detail of BM25 —
 * several published variants differ only here — so the form this index uses should be
 * assertable directly rather than inferred from a ranking.
 *
 * Answers, for `N = 4`: a term in every document scores `ln(1 + 0.5/4.5)` (small but
 * never negative), a term in one document scores `ln(1 + 3.5/1.5)` (much bigger).
 */
export function bm25Idf(docCount: number, df: number): number {
  const n = Math.max(0, docCount);
  const d = Math.min(Math.max(0, df), n);
  return Math.log(1 + (n - d + 0.5) / (d + 0.5));
}

/**
 * Han-range code points, as single characters.
 *
 * The UI is Chinese, so the tokeniser is the part that decides whether any of this
 * works: `text.split(/\s+/)` turns 「端口健康检查」 into **one** token, which no query
 * can match. So CJK is emitted per character, while ASCII stays in word runs
 * (`[a-z0-9]+`, which is what repository names, owners and paths are made of).
 * Single characters rather than the bigram Lucene/Elasticsearch use for CJK: a
 * bigram index needs a separate unigram path (their `output_unigrams` option) before
 * a one-character query finds anything, and here the index side and the query side
 * must be the *same* function with no dependency on a segmenter. The honest cost is
 * in `docs/local-search-bm25.md` §3: matching is bag-of-characters, so 「端口」 also
 * matches a document carrying 端 and 口 in unrelated sentences — it just ranks below
 * a document that carries both in its name.
 *
 * Ranges — U+3400–U+4DBF (Extension A), U+4E00–U+9FFF (the Unified Ideographs block),
 * U+F900–U+FAFF (Compatibility Ideographs) — written as one alternation, so the CJK
 * branch yields exactly one character per match while the ASCII branch yields a whole
 * run.
 * Kana and Hangul are deliberately absent — this corpus is repository
 * names, owners, on-disk paths and the odd Chinese description, and adding a script
 * is a two-class change here rather than a redesign. Non-ASCII Latin letters (an
 * accented `é` in an owner name) fall through as separators, which is the same
 * treatment a hyphen already gets.
 */
const TOKEN_RE = /[a-z0-9]+|[㐀-䶿一-鿿豈-﫿]/g;

/**
 * Lower-cased ASCII word runs and single CJK characters.
 *
 * `toLowerCase()` rather than `toLocaleLowerCase()`: the locale-aware form is allowed
 * to map `İ` to `i̇` depending on the browser's language, and a tokeniser whose output
 * depends on the machine is a ranking that cannot be reproduced.
 *
 * Exported because `local-index.ts` (and any later caller that wants to highlight the
 * matched terms) must use exactly this splitting, not a look-alike — the same
 * single-source rule that made `slugOf` live in one file.
 *
 * This remains production's splitter. `Bm25Options.tokenizer` exists so the r22-R2
 * CJK bakeoff can score the real formula with another segmentation; adopting a
 * different default is a separate decision because it also re-opens the command
 * palette's fusion experiment (see `docs/r22-cjk-tokenization.md` §5).
 */
export function tokenize(text: string): string[] {
  if (typeof text !== "string") return [];
  const lowered = text.toLowerCase();
  const out: string[] = [];
  for (const match of lowered.matchAll(TOKEN_RE)) out.push(match[0]);
  return out;
}

/** `k1` accepts any non-negative finite number; anything else is the default. */
function saneK1(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return BM25_K1_DEFAULT;
  return raw;
}

/** `b` is a fraction of the length correction, so it is clamped into 0–1. */
function saneB(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return BM25_B_DEFAULT;
  return Math.min(1, Math.max(0, raw));
}

/** Weights are multipliers: a nonsense one is dropped back to 1, never negated. */
function saneWeight(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 1;
  return raw;
}

/**
 * How many hits to hand back.
 *
 * `Infinity` means "everything" (a caller exporting a full ranking), an absent or
 * NaN value means the default, and any other number is clamped into 0..n — a caller
 * that computed `list.length - 1` on an empty list asked for 0 rows, and quietly
 * receiving the default ten is how a bug like that stays invisible.
 */
function saneLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return BM25_DEFAULT_LIMIT;
  if (raw === Infinity) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(raw));
}

/** A tokenizer value that can actually be called, or the module default. */
function saneTokenizer(raw: unknown): Tokenizer {
  return typeof raw === "function" ? (raw as Tokenizer) : tokenize;
}

/** One document's per-field term statistics, or `null` when the input is not a document. */
function fieldStatsOf(doc: Bm25Document, tok: Tokenizer): Map<string, FieldStats> | null {
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.id !== "string" || doc.id === "") return null;
  if (!doc.fields || typeof doc.fields !== "object") return null;
  const fields = new Map<string, FieldStats>();
  for (const [name, value] of Object.entries(doc.fields)) {
    // A non-string field is absent, not `"undefined"`: stringifying junk would put the
    // words `null` and `undefined` into the corpus, where a query for "null" then finds
    // every document that never had that field.
    if (typeof value !== "string") continue;
    const tokens = tok(value);
    if (tokens.length === 0) continue;
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    fields.set(name, { length: tokens.length, tf });
  }
  return fields;
}

/**
 * Build the scoring tables for a corpus.
 *
 * Documents whose id is not a usable string are dropped rather than fatal — the same
 * "junk in, drop; never throw at a boundary" rule the wall store applies to a stored
 * blob. A repeated id **replaces** the earlier document (upsert semantics), so a
 * caller that re-presents one repository never scores it twice.
 *
 * Empty input yields an index with `docCount = 0`, which answers every query with no
 * hits instead of dividing by a zero average length.
 */
export function buildBm25Index(
  documents: readonly Bm25Document[],
  options: Bm25Options = {},
): Bm25Index {
  const tokenizer = saneTokenizer(options.tokenizer);
  const docs = new Map<string, DocRecord>();
  for (const doc of Array.isArray(documents) ? documents : []) {
    const fields = fieldStatsOf(doc, tokenizer);
    if (!fields) continue;
    docs.set(doc.id, { id: doc.id, fields });
  }

  // Field lengths are averaged over the documents that carry the field — see the
  // header. The weight table starts from the declared weights, so a field that no
  // document carries still has a weight (and contributes nothing); fields that only
  // show up in the corpus get the default 1 below.
  const fieldWeights: Record<string, number> = {};
  for (const [name, weight] of Object.entries(options.fieldWeights ?? {})) {
    fieldWeights[name] = saneWeight(weight);
  }
  const lengthSum = new Map<string, number>();
  const lengthCount = new Map<string, number>();
  const postings = new Map<string, string[]>();

  for (const record of docs.values()) {
    const seenTerms = new Set<string>();
    for (const [name, stats] of record.fields) {
      if (!(name in fieldWeights)) fieldWeights[name] = 1;
      lengthSum.set(name, (lengthSum.get(name) ?? 0) + stats.length);
      lengthCount.set(name, (lengthCount.get(name) ?? 0) + 1);
      for (const term of stats.tf.keys()) seenTerms.add(term);
    }
    for (const term of seenTerms) {
      const bucket = postings.get(term);
      if (bucket) bucket.push(record.id);
      else postings.set(term, [record.id]);
    }
  }

  const avgFieldLength = new Map<string, number>();
  for (const [name, sum] of lengthSum) {
    const count = lengthCount.get(name) ?? 0;
    avgFieldLength.set(name, count > 0 ? sum / count : 0);
  }

  return {
    k1: saneK1(options.k1),
    b: saneB(options.b),
    fieldWeights,
    docCount: docs.size,
    avgFieldLength,
    postings,
    docs,
    tokenizer,
  };
}

/** `document frequency` of a term: the postings list length is exactly that. */
export function dfOf(index: Bm25Index, term: string): number {
  return index.postings.get(term)?.length ?? 0;
}

/**
 * Rank the corpus against `query`.
 *
 * Query terms are de-duplicated: the score is a sum *over the query's terms*, so a
 * user who types `rust rust` would otherwise double that term's contribution and
 * push an irrelevant document above one that matches two different words.
 *
 * Documents scoring exactly 0 are not returned — with the non-negative IDF form a 0
 * can only mean "no query term occurred", and a caller that shows 40 rows of 0 has
 * turned a ranking into a listing.
 *
 * Sorting is score-descending, then id ascending by code point (§ header), so two
 * runs over the same corpus produce the same list in the same order.
 */
export function searchBm25(
  index: Bm25Index,
  query: string,
  options: Bm25SearchOptions = {},
): Bm25Hit[] {
  if (index.docCount === 0) return [];
  const terms = [...new Set(index.tokenizer(query))];
  if (terms.length === 0) return [];

  // Per-index parameters may be overridden at query time (the UI will want to try
  // `b = 0` for a corpus of one-line names without rebuilding anything).
  const k1 = "k1" in options ? saneK1(options.k1) : index.k1;
  const b = "b" in options ? saneB(options.b) : index.b;
  const weights = options.fieldWeights ?? index.fieldWeights;
  const limit = saneLimit(options.limit);

  const totals = new Map<string, { score: number; fields: Map<string, number> }>();

  for (const term of terms) {
    const ids = index.postings.get(term);
    if (!ids) continue;
    const idf = bm25Idf(index.docCount, ids.length);
    for (const id of ids) {
      const record = index.docs.get(id);
      if (!record) continue;
      for (const [field, stats] of record.fields) {
        const tf = stats.tf.get(term);
        if (!tf) continue;
        const weight = saneWeight(weights[field]);
        if (weight === 0) continue;
        const avg = index.avgFieldLength.get(field) ?? 0;
        // A zero average is impossible here (the field exists on this document, so it
        // was counted), but guarding the division keeps a hand-built index from
        // producing NaN — and NaN would silently sort nowhere.
        const norm = avg > 0 ? stats.length / avg : 1;
        const contribution = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + b * norm)) * weight;
        const hit = totals.get(id) ?? { score: 0, fields: new Map<string, number>() };
        hit.score += contribution;
        hit.fields.set(field, (hit.fields.get(field) ?? 0) + contribution);
        totals.set(id, hit);
      }
    }
  }

  const hits: Bm25Hit[] = [];
  for (const [id, entry] of totals) {
    if (!(entry.score > 0)) continue;
    const fieldScores: Record<string, number> = {};
    for (const [field, value] of entry.fields) {
      if (value > 0) fieldScores[field] = value;
    }
    hits.push({ id, score: entry.score, fieldScores });
  }

  hits.sort((a, b2) => {
    if (b2.score !== a.score) return b2.score - a.score;
    return a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0;
  });

  return hits.slice(0, limit);
}
