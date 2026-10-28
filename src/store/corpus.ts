/**
 * The corpus extras store (r21-n2): per-slug `description` / `readmeHeadings`
 * for the local BM25 index (`lib/local-index.ts`), fed by producers that never
 * issue a request of their own.
 *
 * ## Shape, and why a store
 *
 * Same reasoning as `store/heat.ts`: the data outlives any one surface (the
 * command palette builds an index from it on every open), it arrives
 * asynchronously from at least two producers, and component state would lose it
 * the moment the palette closed. The fetcher is injected (`createCorpusStore`)
 * so the loop — candidate order, missing-file short circuit, anti-stale prune —
 * is testable without a Tauri runtime, exactly like the heat store's
 * `HeatFetcher`.
 *
 * ## Readme producer (r21-n2-1): local only, once per slug per session
 *
 * `loadReadmes` takes the cards the palette already holds (`list_repositories`
 * carries `path`) and probes `README_CANDIDATES` through `read_text_file` —
 * zero network. Two rules keep it from becoming a storm: a slug is attempted
 * **once** per session (`readmeTried`, including "no README here"), and probes
 * run through `mapBounded` at [`CORPUS_README_PARALLEL`], the same N-at-once
 * discipline `BatchBar` uses for local commands. A candidate that
 * `read_text_file` refuses with `(missing)` is the normal "try the next
 * spelling" case (`lib/readme.ts:isMissingFileReason`); any other refusal is
 * swallowed with a recorded reason — a repository the guard distrusts must
 * cost an empty field, never a broken palette.
 *
 * ## Description producer (r21-n2-2): absorb, never fetch
 *
 * `absorbDescriptions` files `RepoHit` rows the app **already paid for** — a
 * remote search (`search_repositories`) and a star page (`list_starred_repos`)
 * both return `{ fullName, description }` — under the wall slug. Zero requests
 * are issued for a description; the coverage that costs ("only repositories
 * this user has searched or starred") and the rejected alternatives
 * (`repo_heat_many` would need a Rust parse extension) are recorded in
 * `lib/corpus.ts:absorbDescriptions`, next to the code that enforces them.
 *
 * ## Anti-stale, both halves
 *
 * The index merge is card-driven (`corpusEntryOf` is called per current card),
 * so a deleted repository can never contribute text to a search. `retain`
 * prunes the store itself to the slugs still on the wall, so the maps —
 * including `readmeTried` — do not grow with come-and-go repositories.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { mapBounded } from "../lib/bounded-map";
import { swallow } from "../lib/report-error";
import { README_CANDIDATES, isMissingFileReason } from "../lib/readme";
import { absorbDescriptions as absorbInto, pruneExtras, readmeHeadingsOf, type CorpusExtras } from "../lib/corpus";

/** How many README probes may be in flight at once. Local reads, but N dialogs
 *  open at once should not turn into N×4 simultaneous IPC round trips. */
export const CORPUS_README_PARALLEL = 3;

/** One candidate file read: the absolute file path is handed to the probe, which
 *  throws on any refusal — the store decides missing-vs-fatal from the reason. */
export type ReadmeProbe = (filePath: string) => Promise<string>;

/** The cards `loadReadmes` accepts: identity plus the on-disk directory. */
export type ReadmeCard = { slug: string; path?: string | null };

type CorpusState = {
  /** slug → the optional texts. Absent key = "never got this repository's extras". */
  extras: Record<string, CorpusExtras>;
  /** slug → true once a README probe has been attempted (found, missing or refused). */
  readmeTried: Record<string, true>;
  /** Bumped on every write so a memo keyed on the store rebuilds exactly then. */
  rev: number;
  loadReadmes: (cards: readonly ReadmeCard[]) => Promise<void>;
  /** File already-paid-for `RepoHit` rows by wall slug. See `lib/corpus.ts`. */
  absorbDescriptions: (hits: readonly unknown[]) => void;
  retain: (slugs: readonly string[]) => void;
};

/** A store whose probe is injected — the shape the tests use; the app singleton
 *  at the bottom of this file passes the real `read_text_file` invoke. */
export function createCorpusStore(probe: ReadmeProbe) {
  return create<CorpusState>((set, get) => ({
    extras: {},
    readmeTried: {},
    rev: 0,

    loadReadmes: async (cards) => {
      const list = Array.isArray(cards) ? cards : [];
      const todo = list.filter((c) => {
        if (!c || typeof c.slug !== "string" || c.slug === "") return false;
        if (get().readmeTried[c.slug]) return false;
        return typeof c.path === "string" && c.path !== "";
      });
      if (todo.length === 0) return;
      // Mark first, then fetch: the wall effect refires on new card identities,
      // and two palette opens one millisecond apart must not launch the same
      // probe chain twice — same "pending key" idea as `store/heat.ts`'s load.
      const tried = { ...get().readmeTried };
      for (const card of todo) tried[card.slug] = true;
      set({ readmeTried: tried, rev: get().rev + 1 });

      await mapBounded(todo, CORPUS_README_PARALLEL, async (card) => {
        const base = (card.path as string).replace(/[\\/]+$/, "");
        let headings: string[] | null = null;
        for (const name of README_CANDIDATES) {
          try {
            const raw = await probe(`${base}/${name}`);
            headings = readmeHeadingsOf(raw);
            break;
          } catch (e) {
            const reason = String(e);
            // Missing is the normal "try the next spelling" case; anything else
            // (outside the roots / denied / not UTF-8) is recorded, ends the
            // chain for this repository, and must not surface as a palette
            // failure — the slug is already in readmeTried, so it will not be
            // retried this session either.
            if (isMissingFileReason(reason)) continue;
            swallow(e, `corpus: README probe refused for ${card.slug}`);
            break;
          }
        }
        if (headings === null || headings.length === 0) return;
        const extras = { ...get().extras, [card.slug]: { ...get().extras[card.slug], readmeHeadings: headings } };
        set({ extras, rev: get().rev + 1 });
      });
    },

    absorbDescriptions: (hits) => {
      // Pure merge in `lib/corpus.ts`; the store only decides whether the map
      // actually moved (reference identity — `absorbInto` answers `prev` when
      // every row was junk), so a search that returned nothing does not bump
      // `rev` and rebuild the palette's index for no reason.
      const next = absorbInto(get().extras, hits);
      if (next !== get().extras) set({ extras: next, rev: get().rev + 1 });
    },

    retain: (slugs) => {
      const keep = Array.isArray(slugs) ? slugs : [];
      const extras = pruneExtras(get().extras, keep);
      const alive = new Set(keep);
      const tried: Record<string, true> = {};
      for (const slug of Object.keys(get().readmeTried)) {
        if (alive.has(slug)) tried[slug] = true;
      }
      set({ extras, readmeTried: tried, rev: get().rev + 1 });
    },
  }));
}

/**
 * The app's store: probes through `read_text_file`, the same command
 * `RepoReadmeDialog` uses, so nothing new is registered and the container-root
 * guard applies to the index exactly as it does to the preview.
 */
export const useCorpus = createCorpusStore((filePath) => invoke<string>("read_text_file", { path: filePath }));
