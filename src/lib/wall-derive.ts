/**
 * The 项目墙's derivation pipeline — filter, tier sort, group — as pure functions.
 *
 * ## Why this moved out of the view (r17-o2-3)
 *
 * All of this used to be inline in `views/ProjectsView.tsx`: the eight tier
 * comparators at `:398-442`, the match predicate at `:362-386`, and the grouping
 * at `:484-493`. That file is a `.tsx`, and the Node test runner refuses to strip
 * types from JSX, so **none of it was reachable from a unit test** — an existing
 * test file says so in as many words: `tests/wall-selectors.test.ts:5-9` records
 * that "按大小/安装时间怎么排" could only be pinned via `applyOverlay`, because
 * the comparators sat in a view.
 *
 * These three are exactly the derivations that were untestable, and they are the
 * ones with rules that are easy to get subtly wrong:
 *
 *   - **unknown sorts last, not first.** A `?? 0` on a size or timestamp would
 *     float a not-yet-measured repository above everything the person knows is
 *     large or recent; the view's own comments call this out (`:403-409`,
 *     `:422-424`) and the tests below hold the line.
 *   - **ties break by name**, so a poll tick cannot reshuffle two equals.
 *   - **the tag test intersects with 运行中**, rather than being short-circuited
 *     by it (`:375-378`).
 *
 * The type parameters are structural on purpose: the caller passes its own
 * `Card`, and nothing here needs to know what else a card carries.
 */
import { matchesTagFilter, type FilterId, type SortId } from "../store/wall";
import { usageScore } from "./usage-score";
import type { RepoHeat, RepoMeta } from "../types";

/** The minimum a card must carry to be filtered, sorted and grouped. */
export type WallCard = {
  slug: string;
  repo: string;
  owner: string;
  path?: string | null;
  /** C1/C2: the repository description, used by the `desc` sort tier. */
  description?: string | null;
};

/** The per-card wall state the filter reads. A structural subset of `RepoState`. */
export type WallCardState = {
  alias?: string;
  tags?: string[];
};

export type WallMatchContext = {
  /** Raw search text; normalised per card, as the view's `q` was already. */
  query: string;
  filter: FilterId;
  states: Record<string, WallCardState | undefined>;
  /** Keys are `repo:<slug>`; presence answers 打开过 / 未打开过. */
  usage: Record<string, unknown>;
  running: { has(slug: string): boolean };
  /** The 标签 chips that still name something on the wall. */
  activeTags: readonly string[];
};

/**
 * Whether one card survives the current search, 标签 chips and 筛选.
 *
 * The order is load-bearing: the tag test runs *before* the 筛选 branch, because
 * the 筛选 branch returns — putting it first would make 标签 silently lose to
 * 运行中 instead of intersecting with it (`ProjectsView.tsx:375-378`).
 */
export function matchWallCard(card: WallCard, ctx: WallMatchContext): boolean {
  const q = ctx.query.trim().toLowerCase();
  const state = ctx.states[card.slug];
  if (q) {
    // Name, alias, owner, on-disk path and 标签 — the five things a person
    // actually remembers. `local` is skipped: the wall never carries it.
    const hay =
      `${card.repo} ${state?.alias ?? ""} ${card.owner} ${card.path ?? ""} ${state?.tags?.join(" ") ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (!matchesTagFilter(state?.tags, ctx.activeTags)) return false;
  const used = ctx.usage[`repo:${card.slug}`];
  if (ctx.filter === "opened") return !!used;
  if (ctx.filter === "unopened") return !used;
  if (ctx.filter === "running") return ctx.running.has(card.slug);
  return true;
}

/** `matchWallCard` over a list. The caller has already dropped hidden cards. */
export function filterWallCards<T extends WallCard>(
  cards: readonly T[],
  ctx: WallMatchContext,
): T[] {
  return cards.filter((c) => matchWallCard(c, ctx));
}

export type WallSortContext = {
  sort: SortId;
  /**
   * `repo:<slug>` → `{ last }` / `{ count, last }`; a missing record sorts last
   * under both 最近使用 and 常用优先 — an unknown history is neither recent
   * nor frequent. `count` is optional in the type because the recent tier never
   * reads it; the store's real entries (`UsageEntry`) always carry both.
   */
  usage: Record<string, { count?: number; last?: number } | undefined>;
  metaBySlug: Record<string, RepoMeta | undefined>;
  /**
   * The clock 常用优先's decay is evaluated at, in unix ms. Injection rather
   * than `Date.now()` at the call site is the same rule `usage-score.ts` states
   * for its own memo: one derivation must not straddle a day boundary, and a
   * test must be able to pin the clock instead of racing midnight.
   */
  nowMs?: number;
  /**
   * `owner/repo` → the GitHub heat row, if one was ever answered (r18 N4).
   *
   * Keyed by `owner/repo` rather than the wall's `host/owner/repo` slug because that
   * is GitHub's own identity and the key the backend answers with. A card with no row
   * sorts **last** under 按 Star — `-1`, not `0` — so "never asked" cannot outrank
   * "asked, and it really has zero stars".
   */
  heatByOwnerRepo?: Record<string, RepoHeat | undefined>;
};

/**
 * One tier comparator applied to a copy of the given list.
 *
 * Taking the input as an argument, rather than closing over `matched`, is what
 * lets a drag number the **whole** wall (`ProjectsView.tsx:388-397`): the
 * off-filter cards have to be stamped in tier order too, or clearing the search
 * would show them in whatever order the backend handed them over.
 */
export function tierSortCards<T extends WallCard>(
  input: readonly T[],
  ctx: WallSortContext,
): T[] {
  const byName = (a: T, b: T) => a.repo.localeCompare(b.repo);
  const metaOf = (c: T) => ctx.metaBySlug[c.slug];
  const list = [...input];
  if (ctx.sort === "recent") {
    // A repository with no usage record sorts *last*: an unknown history is not
    // a recent one.
    list.sort(
      (a, b) =>
        (ctx.usage[`repo:${b.slug}`]?.last ?? 0) - (ctx.usage[`repo:${a.slug}`]?.last ?? 0) ||
        byName(a, b),
    );
  } else if (ctx.sort === "frequent") {
    // r19-C2: the 常用 page's recency-weighted score applied to the wall. The
    // score (count / (1 + daysAgo)) answers "which do I actually open", which
    // raw `last` cannot: one use today outranks five uses last month. A record
    // missing either field scores 0 and lands after every scored card, so a
    // half-written entry cannot buy a front seat.
    const nowMs = ctx.nowMs ?? Date.now();
    const scoreOf = (c: T) => {
      const u = ctx.usage[`repo:${c.slug}`];
      if (!u || typeof u.count !== "number" || typeof u.last !== "number") return 0;
      return usageScore({ count: u.count, last: u.last }, nowMs);
    };
    list.sort((a, b) => scoreOf(b) - scoreOf(a) || byName(a, b));
  } else if (ctx.sort === "owner") {
    list.sort((a, b) => a.owner.localeCompare(b.owner) || byName(a, b));
  } else if (ctx.sort === "installed") {
    list.sort((a, b) => (metaOf(b)?.installedAt ?? 0) - (metaOf(a)?.installedAt ?? 0) || byName(a, b));
  } else if (ctx.sort === "size") {
    list.sort((a, b) => (metaOf(b)?.sizeBytes ?? 0) - (metaOf(a)?.sizeBytes ?? 0) || byName(a, b));
  } else if (ctx.sort === "language") {
    // `?? "zzz"` keeps unknown-language repositories at the end instead of the
    // front, for the same reason 最近使用 does.
    list.sort(
      (a, b) =>
        (metaOf(a)?.language ?? "zzz").localeCompare(metaOf(b)?.language ?? "zzz") || byName(a, b),
    );
  } else if (ctx.sort === "category") {
    list.sort(
      (a, b) =>
        (metaOf(a)?.category ?? "zzz").localeCompare(metaOf(b)?.category ?? "zzz") || byName(a, b),
    );
  } else if (ctx.sort === "cache") {
    list.sort(
      (a, b) => Number(!!metaOf(b)?.hasCache) - Number(!!metaOf(a)?.hasCache) || byName(a, b),
    );
  } else if (ctx.sort === "desc") {
    // C2: sort by repository description alphabetically (case-insensitive),
    // empty/absent descriptions at the bottom.
    list.sort(
      (a, b) => {
        const da = (a.description ?? "").toLowerCase();
        const db = (b.description ?? "").toLowerCase();
        // Empty/absent descriptions sink to the bottom.
        if (!da && !db) return byName(a, b);
        if (!da) return 1;
        if (!db) return -1;
        return da.localeCompare(db) || byName(a, b);
      },
    );
  } else if (ctx.sort === "stars") {
    // r18 N4: the one tier whose data comes from GitHub rather than the clone.
    const starsOf = (c: T) => ctx.heatByOwnerRepo?.[`${c.owner}/${c.repo}`]?.stars ?? -1;
    list.sort((a, b) => starsOf(b) - starsOf(a) || byName(a, b));
  } else {
    list.sort(byName);
  }
  return list;
}

/**
 * `sorted` folded by owner, in first-seen order.
 *
 * First-seen order rather than alphabetical: the input is already in the order
 * the user chose, and re-sorting the groups would undo 名称/最近使用 at the top
 * level of a grouped wall (`ProjectsView.tsx:484-493`).
 */
export function groupCardsByOwner<T extends { owner: string }>(
  sorted: readonly T[],
): [string, T[]][] {
  const buckets = new Map<string, T[]>();
  for (const card of sorted) {
    const bucket = buckets.get(card.owner);
    if (bucket) bucket.push(card);
    else buckets.set(card.owner, [card]);
  }
  return [...buckets.entries()];
}
