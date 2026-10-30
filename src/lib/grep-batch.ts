/**
 * Cross-repository grep: the wire shape and the presentation rules.
 *
 * The backend (`repo_grep_many`) is deliberately not a ranking source — this is
 * the "which of my projects contains this line" question, asked explicitly over
 * a named set of repositories. The cost is bounded by the backend (200 repos,
 * 50 hits each, 1 000 total, 15 s); this module decides what the screen says
 * when one of those caps was reached, because "no more matches" and "I stopped
 * looking" must not share a face.
 */
import { PATTERN_MAX, type GrepHit } from "./grep";

export type GrepBatchGroup = {
  slug: string;
  root: string;
  filesScanned: number;
  filesSkipped: number;
  hits: GrepHit[];
  error: string | null;
};

export type GrepBatchResult = {
  pattern: string;
  groups: GrepBatchGroup[];
  totalHits: number;
  filesScanned: number;
  filesSkipped: number;
  elapsedMs: number;
  /** A per-repo or total cap stopped collection. */
  truncated: boolean;
  /** The deadline expired before every repository was reached. */
  timedOut: boolean;
  /** The user cancelled; groups collected so far are still present. */
  cancelled?: boolean;
  /** Slugs over the backend's repository ceiling were never looked up. */
  repositoriesSkipped: number;
  error: string | null;
};

/** The backend's repository ceiling; the dialog warns before the request. */
export const BATCH_MAX_REPOS = 200;

/** Groups and hits painted before the rest become a counted sentence. */
export const BATCH_RENDER_GROUPS = 20;
export const BATCH_RENDER_HITS = 10;

/** The pattern limits are the single-repo dialog's, so the two searches agree. */
export { PATTERN_MAX };

export type BatchSummary = {
  /** Repositories that produced at least one hit. */
  hitRepos: number;
  /** Repositories that were actually scanned (missing/error rows excluded). */
  scannedRepos: number;
  /** Repositories with a per-repo error (missing path, read failure). */
  failedRepos: number;
  totalHits: number;
  filesScanned: number;
  /** True when *any* answer was cut by a cap or the deadline. */
  partial: boolean;
};

export function summarizeBatch(result: GrepBatchResult): BatchSummary {
  let hitRepos = 0;
  let scannedRepos = 0;
  let failedRepos = 0;
  for (const group of result.groups) {
    if (group.hits.length > 0) hitRepos += 1;
    if (group.error !== null) failedRepos += 1;
    else scannedRepos += 1;
  }
  return {
    hitRepos,
    scannedRepos,
    failedRepos,
    totalHits: result.totalHits,
    filesScanned: result.filesScanned,
    partial:
      result.truncated || result.timedOut || result.repositoriesSkipped > 0,
  };
}

/**
 * Clamped roving-focus step for the result list.
 *
 * `-1` means "nothing focused yet": ArrowDown enters at the first row, ArrowUp
 * at the last. At an edge the index stays put rather than wrapping - wrapping a
 * list of file hits sends the eye to the other end of the dialog.
 */
export function stepHitIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : total - 1;
  return Math.max(0, Math.min(total - 1, current + delta));
}

export type RenderedGroup = {
  slug: string;
  error: string | null;
  hits: GrepHit[];
  /** Hits this group has that the render cap hid. */
  hiddenHits: number;
};

/**
 * The groups worth painting: a hit or an error. A repository that answered
 * cleanly with zero matches is summarised by the count, not by an empty row.
 */
export function renderableGroups(
  result: GrepBatchResult,
  groups = BATCH_RENDER_GROUPS,
  hits = BATCH_RENDER_HITS,
): { shown: RenderedGroup[]; hiddenGroups: number } {
  const relevant = result.groups.filter((g) => g.hits.length > 0 || g.error !== null);
  const shown = relevant.slice(0, groups).map((g) => ({
    slug: g.slug,
    error: g.error,
    hits: g.hits.slice(0, hits),
    hiddenHits: Math.max(0, g.hits.length - hits),
  }));
  return { shown, hiddenGroups: Math.max(0, relevant.length - shown.length) };
}
