/**
 * The corpus extras layer (r21-n2): the two optional `local-index` fields,
 * `description` and `readmeHeadings`, and where their text actually comes from.
 *
 * ## What fills which field, and at what network cost
 *
 * `readmeHeadings` (this commit): **zero network**. The clone is on disk, so the
 * producer reads it the same way `RepoReadmeDialog` does — `list_repositories`
 * already carries each card's `path`, and `read_text_file` reads one UTF-8 file
 * inside the container's roots. Note for readers arriving from the r21 brief:
 * `repo_readme(full_name)` is **not** that command — it fetches from GitHub for
 * the 添加页 preview (`lib.rs:5938`, `AddRepoView.tsx:653`), useless for a clone
 * that is already here and wrong for an offline machine. The local path is
 * `read_text_file` against `README_CANDIDATES`, probe order included.
 *
 * `description` (r21-n2-2): absorbed from flows that **already paid** for it —
 * remote search hits (`search_repositories` → `RepoHit`) and star pages
 * (`list_starred_repos` → same `RepoHit` shape). No new request is ever issued
 * for a description; the honest cost of that choice is coverage, stated next to
 * [`absorbDescriptions`] below.
 *
 * ## Why the decisions live here
 *
 * Same split as `lib/readme.ts` vs `RepoReadmeDialog`: the Node test runner
 * cannot import a `.tsx` and the store's fetch loop is untestable without an
 * injected probe, so "how many bytes of README become headings", "which card
 * fields merge into one index entry" and "which extra slugs survive a wall
 * shrink" are all pure decisions in this file. No DOM, no React, no Tauri —
 * `tests/lib-import-graph.test.ts` loads every `src/lib/**` module under Node's
 * type stripping.
 *
 * ## Caps are the existing ones, not new inventions
 *
 * The README text is cut with `capUtf8`'s byte budget (`README_MAX_BYTES`, the
 * same 256 KB the dialog renders), heading count is `LOCAL_README_HEADING_LIMIT`
 * (already enforced again downstream by `localDocOf`), and a description passes
 * through `localDocOf`'s `LOCAL_DESCRIPTION_CHAR_LIMIT`. A second, tighter cap
 * here would be a second truth source; the index layer's caps are the contract.
 */
import { parseMarkdown, type MdBlock, type MdInline } from "./markdown";
import { LOCAL_README_HEADING_LIMIT } from "./local-index";
import { README_MAX_BYTES, capUtf8 } from "./readme";

/**
 * The optional texts one repository may gain beyond the wall's own payload.
 *
 * Both keys are optional and independently absent: a machine that never opened
 * the 添加页 has no description, a clone without a README has no headings, and
 * either absence must index normally (see `localDocOf`: an omitted field is
 * empty, never an error).
 */
export type CorpusExtras = {
  description?: string;
  readmeHeadings?: string[];
};

/** The slice of a wall card this layer reads. Structural on purpose. */
export type CorpusCard = {
  host: string;
  owner: string;
  repo: string;
  path?: string | null;
  local?: string | null;
  /** `RepoRef.description` when some flow already filled it on the ref itself. */
  description?: string | null;
};

/** The slice of `store/wall.ts`'s `RepoState` this layer reads. */
export type CorpusState = {
  alias?: string;
  tags?: string[];
  /** The local note typed on the card (r30-N2); searchable like the alias. */
  note?: string;
};

/** Inline nodes → the plain words a heading (or its badges) actually reads as. */
function inlineTextOf(nodes: readonly MdInline[]): string {
  const parts: string[] = [];
  const walk = (list: readonly MdInline[]): void => {
    for (const node of list) {
      if (node.type === "text" || node.type === "code") parts.push(node.text);
      else if (node.type === "image") parts.push(node.alt);
      else if (node.type === "strong" || node.type === "em" || node.type === "link") walk(node.children);
    }
  };
  walk(nodes);
  // Concatenate, then collapse: the parser keeps the spaces around an inline
  // node as written (`DevHub **套件**` yields "DevHub " + "套件"), so joining
  // with a separator would double every inter-word space.
  return parts.join("").replace(/\s+/g, " ").trim();
}

function headingTexts(blocks: readonly MdBlock[], out: string[]): void {
  for (const block of blocks) {
    if (out.length >= LOCAL_README_HEADING_LIMIT) return;
    if (block.type === "heading") {
      const text = inlineTextOf(block.inline).trim();
      if (text !== "") out.push(text);
    } else if (block.type === "quote") {
      // A quote can wrap a heading (`> ## like this`); real READMEs do this
      // rarely, but dropping the subtree silently would make the cap the only
      // limit a reader can reason about.
      headingTexts(block.blocks, out);
    }
  }
}

/**
 * One README file's text → its heading texts, in document order, capped.
 *
 * Non-strings answer `[]` rather than throwing: the input crosses IPC, and a
 * `null` README must cost one empty field, not a failed palette open. The byte
 * cut lands before parsing (a hostile 4 MB file must not be tokenised) and uses
 * the dialog's own `capUtf8` rule, so a multi-byte character straddling the
 * limit is dropped whole rather than decoded as U+FFFD — the same cut
 * `RepoReadmeDialog` shows, which is why the index and the preview never
 * disagree about where the file ends.
 */
export function readmeHeadingsOf(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  const capped = capUtf8(raw, README_MAX_BYTES).text;
  const out: string[] = [];
  headingTexts(parseMarkdown(capped), out);
  return out;
}

/**
 * One wall card + this device's overlay + extras → a `local-index` entry.
 *
 * The merge order is deliberate: a description absorbed from a GitHub hit wins
 * over the (almost always empty) `RepoRef.description`, and both lose to nothing
 * — an absent extra simply does not write the key, so `localDocOf` applies its
 * own trim/cap rules to whatever did arrive. `alias` / `tags` come from
 * `store/wall.ts`'s `RepoState`, keyed by the same slug; this function reads
 * them rather than re-deriving them because the wall owns 标签 semantics.
 */
export function corpusEntryOf(
  card: CorpusCard,
  state: CorpusState | undefined,
  extras: CorpusExtras | undefined,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    host: card.host,
    owner: card.owner,
    repo: card.repo,
  };
  if (card.path != null) entry.path = card.path;
  if (card.local != null) entry.local = card.local;
  if (state?.alias != null) entry.alias = state.alias;
  if (state?.note != null) entry.note = state.note;
  if (state?.tags != null) entry.tags = state.tags;
  const description = extras?.description ?? card.description ?? null;
  if (description != null) entry.description = description;
  if (extras?.readmeHeadings != null) entry.readmeHeadings = extras.readmeHeadings;
  return entry;
}

/**
 * Keep only the extras whose slug is still on the wall.
 *
 * Anti-stale, half one of two: the index itself is card-driven (`corpusEntryOf`
 * merges per current card, so a deleted repository can never contribute text),
 * and this prunes the *store* so an hour of palette opens does not accumulate
 * extras for repositories that left the wall. Same direction as
 * `updateLocalIndex`'s `removedSlugs`, one layer earlier.
 */
export function pruneExtras<T>(extras: Record<string, T>, keep: readonly string[]): Record<string, T> {
  const alive = new Set(keep);
  const out: Record<string, T> = {};
  for (const [slug, value] of Object.entries(extras)) {
    if (alive.has(slug)) out[slug] = value;
  }
  return out;
}

/**
 * How many extras entries a description absorb may leave behind.
 *
 * Search pages and star pages hand over up to a hundred rows at a time and the
 * user can run many queries; without a cap the map would grow with every
 * *looked-at* repository, including the ones never downloaded. 500 is far above
 * any real wall and far below "unbounded session state".
 */
export const CORPUS_DESCRIPTION_CAP = 500;

/**
 * GitHub hit rows → the next extras map, keyed by wall slug.
 *
 * ## Why absorption rather than a fetch (r21-n2-2 selection)
 *
 * Every candidate was checked against "does it spend a request the user did not
 * ask for":
 *
 *   - `repo_readme(full_name)` — rejected before the cost matters: it fetches
 *     from GitHub (`lib.rs:5938`), the opposite of what the brief presumed;
 *   - `repo_heat_many` — its `/repos/{owner}/{repo}` response *does* carry a
 *     description, but `heat.rs:parse_heat` does not keep it, so the zero-cost
 *     version needs a Rust change (Heat gains a field and loses `Copy`). Right
 *     long-term fix, wrong session: this worktree has no warm cargo target and
 *     a cold crate build is measured in tens of minutes (see the r20 BM25
 *     doc's tantivy section for the same ledger). Recorded as the upgrade path;
 *   - **absorb, don't ask**: `search_repositories` and `list_starred_repos`
 *     already returned `RepoHit.description` for rows the user chose to look
 *     at. Filing those costs zero requests.
 *
 * The price is coverage, and it is honest: a description lands only for
 * repositories this user has searched or starred on this machine. A repository
 * cloned straight from a pasted URL has none — `localDocOf` treats the absent
 * field as empty, so search degrades to the name/alias/tags fields and never
 * errors on the miss.
 *
 * Input rows are `RepoHit`-shaped (`{ fullName, description }`); `fullName` is
 * GitHub's `owner/repo` and is filed under `github.com/${fullName}` — the wall
 * slug — because hits always come from `api.github.com`, and the codebase
 * already joins them that way (`StarImportPanel.isOwned`). One key space, one
 * lookup (`extras[slugOf(card)]`), and no host guessing beyond the host the hit
 * literally arrived from. `owner/repo` with anything other than two non-empty
 * segments is skipped rather than fabricated into a key no card can hold.
 * Junk rows (missing name, blank description, wrong shape) are skipped, and the
 * same key overwriting is "freshest wins", matching `updateLocalIndex`.
 * Returns `prev` unchanged when nothing valid arrived, so a caller can compare
 * references to decide whether to write.
 */
export function absorbDescriptions(
  prev: Record<string, CorpusExtras>,
  hits: readonly unknown[],
  cap: number = CORPUS_DESCRIPTION_CAP,
): Record<string, CorpusExtras> {
  const list = Array.isArray(hits) ? hits : [];
  const out = { ...prev };
  let changed = false;
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const hit = raw as Record<string, unknown>;
    const fullName = typeof hit.fullName === "string" ? hit.fullName.trim() : "";
    const description = typeof hit.description === "string" ? hit.description.trim() : "";
    if (description === "") continue;
    // `owner/repo` exactly: one slash, two non-empty segments. Anything else is
    // not an addressable GitHub repository and must not become a map key that
    // no card can ever look up.
    const segments = fullName.split("/");
    if (segments.length !== 2 || segments.some((s) => s === "")) continue;
    out[`github.com/${fullName}`] = { ...out[`github.com/${fullName}`], description };
    changed = true;
  }
  if (!changed) return prev;
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : CORPUS_DESCRIPTION_CAP;
  const keys = Object.keys(out);
  if (keys.length > limit) {
    // Object key order is insertion order: the oldest entries are the least
    // recently absorbed, which is the right side to trim.
    for (const key of keys.slice(0, keys.length - limit)) delete out[key];
  }
  return out;
}
