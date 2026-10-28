/**
 * The 项目墙's GitHub "heat" facts (r18 N4) — the pure half.
 *
 * Everything here is a function of plain values so it can be pinned by `pnpm test`:
 * the Node runner cannot reach `@tauri-apps/api/core`, and the interesting rules
 * ("what may a tile claim about a number we last confirmed six hours ago") are
 * formatting and state questions, not IPC questions. The store that owns the IPC is
 * `src/store/heat.ts`, and it drives these through an injected fetcher — the same
 * split `src/store/meta.ts` documents.
 *
 * ## Why `source` decides the wording, not `error`
 *
 * The backend answers one of four things per repository (see `src-tauri/src/heat.rs`):
 *
 *   - `fresh` — fetched now;
 *   - `revalidated` — the server said `304`, i.e. the number we hold is confirmed current;
 *   - `cached` — served inside the TTL, **nobody was asked**;
 *   - `failed` — this round got no answer, and the row carries whatever was last known
 *     plus the reason.
 *
 * A tile that says "1.2k" for a `cached` row is not lying, but it *is* implying a
 * confirmation that never happened, and that distinction is the only reason this
 * module exists rather than the badge just reading `heat.stars`.
 */
import type { RepoHeat } from "../types";

/** The two characters `owner/repo` is made of, as the wall already holds them. */
export function heatSlug(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/**
 * Compact star count.
 *
 * Deliberately not `Intl.NumberFormat({notation:"compact"})`: that answers in the
 * runtime's locale and its own rounding, so the same number would print differently
 * in a zh and an en shell and could not be pinned by a test. The rule is one line per
 * band, and 1-999 stay exact because a small repository's exact count is the point.
 */
export function formatStars(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return compact(n, 1000, "k");
  if (n < 1_000_000_000) return compact(n, 1_000_000, "M");
  return compact(n, 1_000_000_000, "B");
}

function compact(n: number, unit: number, suffix: string): string {
  const scaled = n / unit;
  // Two bands of precision: under 10 of the unit show one decimal (1.5k), above it the
  // integer (25k) — a wall of cards does not need 5 significant digits for a star count,
  // and `.5k` reads better than `5000`.
  const text = scaled < 10 ? scaled.toFixed(1) : String(Math.floor(scaled));
  return `${text.replace(/\.0$/, "")}${suffix}`;
}

/** What the tile renders, and whether it has to say "unconfirmed". */
export type HeatBadge = {
  /** Compact count, e.g. `1.2k`. */
  text: string;
  /** Exact count, for the tooltip. */
  stars: number;
  /** True when nobody confirmed this number in this round (`cached` or `failed`). */
  unconfirmed: boolean;
};

/**
 * The badge for one repository, or `null` when there is nothing honest to show.
 *
 * `stars === 0` **is** shown: GitHub answers 0 for a genuinely unstarred repository,
 * and hiding it would make those tiles look like they were never fetched. A row whose
 * only state is `failed` with nothing held is the one case that stays silent.
 */
export function heatBadgeOf(heat: RepoHeat | undefined): HeatBadge | null {
  if (!heat) return null;
  if (heat.source === "failed" && heat.stars === 0 && !heat.pushedAt) return null;
  return {
    text: formatStars(heat.stars),
    stars: heat.stars,
    unconfirmed: heat.source === "cached" || heat.source === "failed",
  };
}

/**
 * Fold a batch answer into the by-slug map.
 *
 * The backend echoes `slug` per row, so a late answer for a repository that left the
 * wall cannot overwrite anything the wall still shows: unknown slugs are dropped.
 * Rows are keyed in input order, which is what lets the store keep the seq guard
 * simple — the last accepted batch owns the whole map.
 */
export function indexHeat(list: readonly RepoHeat[]): Record<string, RepoHeat> {
  const out: Record<string, RepoHeat> = {};
  for (const row of list) {
    if (!row || typeof row.slug !== "string" || row.slug.length === 0) continue;
    out[row.slug] = row;
  }
  return out;
}

/**
 * The `owner/repo` names to ask for, in wall order, capped.
 *
 * The cap is the **backend's** `HEAT_BATCH_CAP` mirrored here so the UI does not send
 * 80 names and have 50 silently dropped — a person who just clicked 刷新 on a big wall
 * would otherwise see the last tiles never fill in, with no explanation anywhere.
 * Keeping the number in one place would be nicer, but the frontend cannot import a
 * Rust constant; the test in `tests/heat.test.ts` pins the value against the Rust
 * source instead, which is the same guard at a different layer.
 */
export const HEAT_UI_CAP = 30;

export function heatNames(cards: readonly { owner: string; repo: string }[], cap = HEAT_UI_CAP): string[] {
  const names: string[] = [];
  for (const c of cards) {
    if (names.length >= cap) break;
    if (!c.owner || !c.repo) continue;
    names.push(heatSlug(c.owner, c.repo));
  }
  return names;
}
