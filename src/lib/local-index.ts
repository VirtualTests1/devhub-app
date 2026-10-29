/**
 * The local corpus: repository entries the client already holds → a BM25 index.
 *
 * ## What this reads, and what it deliberately does not invent
 *
 * Today the renderer knows a repository as a `RepoRef` (`src/types.ts`) — `host` /
 * `owner` / `repo` and, when the clone is on disk, `local` + `path`. That is the whole
 * payload of `invoke<RepoRef[]>("list_repositories")`, which is what
 * `CommandPalette.tsx` fetches on open and what `App.tsx` hands to every view; and the
 * per-card facts a person typed on *this* device (`alias`, `tags`) live in
 * `store/wall.ts`'s `RepoState`, keyed by the same slug. This module indexes exactly
 * those two things, and nothing that would need a new backend command.
 *
 * `description` and `readmeHeadings` are **optional inputs with no producer yet**: a
 * GitHub description only appears on remote search hits (`RepoHit`), and README text
 * only enters the client when `RepoReadmeDialog` reads one file on demand. They are
 * fields here so the wiring stream can fill them when it decides where the text comes
 * from — an entry that omits them indexes normally, the fields are simply empty. This
 * is stated rather than papered over because an index whose README field is always
 * empty will look like a ranking bug when it is a missing source.
 *
 * ## Boundary rules, because the inputs are not trustworthy
 *
 * Entries reach here from IPC, from `localStorage` and from a wall export another
 * machine wrote. Every field is therefore re-checked (`unknown` in, drop or coerce
 * out), the same rule `sanitiseRepo` in `store/wall.ts` applies to a stored blob and
 * for the same reason: a `null` where a string was promised must not take the feature
 * down, it must cost one document. Nothing in this file throws.
 *
 * Per-document text is also **bounded**. A one-character budget is not a performance
 * tweak here (the corpus is tens of documents) — it is what keeps a hand-edited export
 * carrying a 4 MB "description" from being tokenised on every keystroke.
 *
 * ## Incremental, lazily ranked
 *
 * `updateLocalIndex` patches the document map in time proportional to what it was
 * handed and marks the ranking dirty; the scoring tables are rebuilt on the next
 * search, once. That ordering matters for the real call pattern: a wall refresh
 * re-presents every repository, and re-deriving the postings for each entry would be
 * N rebuilds for one refresh. A burst of updates coalesces into a single rebuild.
 *
 * ## No UI copy lives here
 *
 * `reason` is a field *identifier* (`"name"`, `"description"`, `"readme"`, …), not a
 * sentence. 名称 / 描述 / README 标题 are the wiring stream's dictionary entries to
 * register in `src/lib/i18n.ts`; a Chinese literal in this file would be exactly the
 * debt `tests/zh-hardcode-ratchet.test.ts` exists to catch, and `src/lib/**` is meant
 * to stay copy-free so the strings can reach the 词表 later.
 *
 * No DOM, no React, no package — `tests/lib-import-graph.test.ts` loads every
 * `src/lib/**` module under Node's type stripping.
 */
import {
  buildBm25Index,
  searchBm25,
  type Bm25Document,
  type Bm25Index,
  type Bm25SearchOptions,
} from "./bm25";
import { slugOf } from "./slug";

/** The searchable fields, in the order a reader would list them. */
export type LocalField = "name" | "alias" | "note" | "description" | "readme" | "tags" | "owner" | "path";

/**
 * Per-field multipliers, the one lever that makes "the word is in the repository's
 * *name*" outrank "the word is in a sentence somewhere".
 *
 * `alias` beats `name`: it is a word this person chose for the card, so a hit there is
 * a hit on their own vocabulary. `path` sits lowest — the container path repeats the
 * owner and the repository name already, so a match there is usually the same
 * occurrence counted twice.
 *
 * r25-R3 ran a 175-config grid (7 weight profiles × 5 `k1` × 5 `b`) over the same
 * 48-document / 36-query gold set, with a pre-registered +3% MRR / −0.005 Recall bar
 * on both 18-query folds. No configuration cleared it, so these values stay: the
 * closest candidate (`nameHeavy`) missed fold B by 0.00056, which is inside the
 * discretisation of an 18-query fold. Changing these numbers is a new experiment,
 * not a tune — re-running the grid is what pins the no-go.
 */
export const LOCAL_FIELD_WEIGHTS: Readonly<Record<LocalField, number>> = {
  alias: 3.5,
  note: 3.4,
  name: 3,
  description: 2,
  readme: 1.5,
  tags: 1.5,
  owner: 1.2,
  path: 1,
};

/**
 * Which field wins when two contributed equally.
 *
 * The order is the one a person reading the result row would expect as evidence: the
 * name says more about a repository than its path does, so a name contribution and a
 * path contribution of the same size are reported as the name.
 */
export const LOCAL_FIELD_PRECEDENCE: readonly LocalField[] = [
  "name",
  "alias",
  "note",
  "description",
  "readme",
  "tags",
  "owner",
  "path",
];

/** How many hits `searchLocal` returns when the caller does not say. */
export const LOCAL_SEARCH_DEFAULT_LIMIT = 20;

/** A description is a sentence; anything longer than this was not meant as one. */
export const LOCAL_DESCRIPTION_CHAR_LIMIT = 2000;

/** A local note is capped at the same length the wall store accepts. */
export const LOCAL_NOTE_CHAR_LIMIT = 2000;

/** README headings: 40 is more than a real file yields, and bounds a hostile array. */
export const LOCAL_README_HEADING_LIMIT = 40;

/** Tags per entry, matching the wall's own cap so an over-long export cannot inflate it. */
export const LOCAL_TAGS_LIMIT = 8;

/** A path is a filesystem fact; a 1024-character one is a payload. */
export const LOCAL_PATH_CHAR_LIMIT = 1024;

/** One indexed document, after parsing. */
export type LocalDoc = {
  slug: string;
  /** The repository name as shown on the card — `RepoRef.repo`, not the slug. */
  name: string;
  fields: Record<LocalField, string>;
};

/** The live index: the corpus, plus the ranking tables when they are up to date. */
export type LocalIndex = {
  /** slug → document. Iteration order is insertion order, and results never depend on it. */
  docs: Map<string, LocalDoc>;
  /** True while `bm25` no longer describes `docs` (see the lazy-rebuild note above). */
  dirty: boolean;
  bm25: Bm25Index | null;
};

export type LocalSearchOptions = {
  limit?: number;
  /** Passed through to the scorer; `b = 0` is the interesting one for a name-only corpus. */
  k1?: number;
  b?: number;
};

export type LocalHit = {
  slug: string;
  name: string;
  score: number;
  /** The field that contributed most to this score — an identifier, never a sentence. */
  reason: LocalField;
};

/** A trimmed non-empty string, or `null`. The only coercion this file performs. */
function text(value: unknown, limit?: number): string | null {
  if (typeof value !== "string") return null;
  const one = value.trim();
  if (one === "") return null;
  return typeof limit === "number" && one.length > limit ? one.slice(0, limit) : one;
}

/**
 * One entry from the outside world → a document, or `null` for "that is not one".
 *
 * The identity rule is strict on purpose: a document must be addressable, so it needs
 * a repository name and a slug. `repo` missing means no name to show and no slug to
 * build, which is a dropped entry rather than a throw — the wall's own
 * `sanitiseRepo` answers the same way, because a card that cannot be named is not
 * worth failing a search over.
 *
 * `path` and `local` are joined into one field: both are directory text, and `local`
 * is the folder name the person may have renamed on disk (`_worktrees` aside).
 */
export function localDocOf(raw: unknown): LocalDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const repo = text(entry.repo);
  if (repo === null) return null;

  const owner = text(entry.owner);
  const host = text(entry.host);
  let slug = text(entry.slug);
  if (slug === null) {
    // `host` is optional in the loose input (a view may hand a `{ owner, repo }` pair),
    // and the app's own documented default for a two-segment ref is `github.com` — see
    // `slugFromRef`. The triple is spelled by `slugOf`, never re-grown here.
    if (owner === null) return null;
    slug = slugOf({ host: host ?? "github.com", owner, repo });
  }

  const fields: Record<LocalField, string> = {
    name: repo,
    alias: text(entry.alias) ?? "",
    note: text(entry.note, LOCAL_NOTE_CHAR_LIMIT) ?? "",
    description: text(entry.description, LOCAL_DESCRIPTION_CHAR_LIMIT) ?? "",
    readme: readmeTextOf(entry.readmeHeadings),
    tags: tagsTextOf(entry.tags),
    owner: owner ?? "",
    path: pathTextOf(entry),
  };

  return { slug, name: repo, fields };
}

/** Headings as an array (or a single string), each item a string, capped. */
function readmeTextOf(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const kept: string[] = [];
  for (const item of list) {
    const one = text(item);
    if (one === null) continue;
    kept.push(one);
    if (kept.length >= LOCAL_README_HEADING_LIMIT) break;
  }
  return kept.join(" ");
}

/** Tag names as words. `store/wall.ts` owns the real 标签 rules; this only reads them. */
function tagsTextOf(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const kept: string[] = [];
  for (const item of raw) {
    const one = text(item);
    if (one === null) continue;
    kept.push(one);
    if (kept.length >= LOCAL_TAGS_LIMIT) break;
  }
  return kept.join(" ");
}

function pathTextOf(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = text(entry.path, LOCAL_PATH_CHAR_LIMIT);
  if (path !== null) parts.push(path);
  const local = text(entry.local, LOCAL_PATH_CHAR_LIMIT);
  if (local !== null && local !== path) parts.push(local);
  return parts.join(" ");
}

/** An empty index — useful as the target of the first `updateLocalIndex`. */
export function createLocalIndex(): LocalIndex {
  return { docs: new Map<string, LocalDoc>(), dirty: true, bm25: null };
}

/**
 * Parse entries into documents and upsert them.
 *
 * Duplicate slugs inside one call: the **later** entry wins. That is the same rule
 * `buildBm25Index` applies to a repeated id, and it is the direction a refresh needs —
 * the fresher payload is the one that arrives last, and keeping the first would freeze
 * a stale description into the corpus while the wall moved on.
 */
export function updateLocalIndex(
  index: LocalIndex,
  entries: readonly unknown[],
  options: { removedSlugs?: readonly unknown[] } = {},
): LocalIndex {
  const list = Array.isArray(entries) ? entries : [];
  for (const raw of list) {
    const doc = localDocOf(raw);
    if (doc === null) continue;
    index.docs.set(doc.slug, doc);
  }
  // Deletions come as slugs rather than as entries, because the caller's refresh
  // already knows which repositories left the wall and a deleted card must not keep
  // matching a search forever (`updateLocalIndex` alone cannot tell "unchanged" from
  // "gone").
  const dropped = options.removedSlugs;
  if (Array.isArray(dropped)) {
    for (const raw of dropped) {
      const slug = text(raw);
      if (slug !== null) index.docs.delete(slug);
    }
  }
  index.dirty = true;
  return index;
}

/** Fresh from a list of entries. Equivalent to an update over an empty index. */
export function buildLocalIndex(entries: readonly unknown[]): LocalIndex {
  return updateLocalIndex(createLocalIndex(), entries);
}

export function localIndexSize(index: LocalIndex): number {
  return index.docs.size;
}

function asBm25Document(doc: LocalDoc): Bm25Document {
  // Only non-empty fields go in: an empty field would join the field-name set and
  // take part in that field's average length as a zero, diluting it for the documents
  // that really do carry the field (see the note in `bm25.ts`).
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(doc.fields) as [LocalField, string][]) {
    if (value !== "") fields[name] = value;
  }
  return { id: doc.slug, fields };
}

/** Re-derive the scoring tables if something changed. One rebuild per burst. */
function ranked(index: LocalIndex): Bm25Index {
  if (index.bm25 === null || index.dirty) {
    const documents: Bm25Document[] = [];
    for (const doc of index.docs.values()) documents.push(asBm25Document(doc));
    index.bm25 = buildBm25Index(documents, { fieldWeights: LOCAL_FIELD_WEIGHTS });
    index.dirty = false;
  }
  return index.bm25;
}

/**
 * Rank the corpus for `query`.
 *
 * The `reason` is the field with the largest contribution, ties broken by
 * `LOCAL_FIELD_PRECEDENCE` — so the same corpus always reports the same evidence, and
 * the row a test pins is the row the user sees.
 */
export function searchLocal(
  index: LocalIndex,
  query: string,
  options: LocalSearchOptions = {},
): LocalHit[] {
  // An empty corpus answers nothing — `searchBm25` already returns [] for that, and
  // it is the branch a first-run wall (before 项目目录 was scanned) lands in.
  const bm25 = ranked(index);

  const searchOptions: Bm25SearchOptions = {
    limit: options.limit ?? LOCAL_SEARCH_DEFAULT_LIMIT,
  };
  // Forward an override only when it is a number: passing an explicit `undefined`
  // would reach the scorer as "override present" and reset the index's own parameter
  // to the module default instead of leaving the index in charge.
  if (typeof options.k1 === "number") searchOptions.k1 = options.k1;
  if (typeof options.b === "number") searchOptions.b = options.b;

  const hits = searchBm25(bm25, query, searchOptions);
  const out: LocalHit[] = [];
  for (const hit of hits) {
    const doc = index.docs.get(hit.id);
    if (!doc) continue;
    out.push({
      slug: doc.slug,
      name: doc.name,
      score: hit.score,
      reason: reasonOf(hit.fieldScores),
    });
  }
  return out;
}

/** The best field to show as evidence, in the documented precedence order. */
export function reasonOf(fieldScores: Readonly<Record<string, number>>): LocalField {
  let best: LocalField = "name";
  let bestValue = -Infinity;
  let bestRank = LOCAL_FIELD_PRECEDENCE.length;
  for (const [name, value] of Object.entries(fieldScores)) {
    const field = name as LocalField;
    const rank = LOCAL_FIELD_PRECEDENCE.indexOf(field);
    if (rank < 0) continue;
    if (value > bestValue || (value === bestValue && rank < bestRank)) {
      best = field;
      bestValue = value;
      bestRank = rank;
    }
  }
  return best;
}
