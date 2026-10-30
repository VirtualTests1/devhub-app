/**
 * Session memo for cover fetches that came back with no image.
 *
 * `RepoTile`'s `coverInflight` map keeps a resolved promise for the whole session.
 * That is right for a cover that exists (the bytes are on disk), and wrong for one
 * that does not: a repository without an OpenGraph image resolves `{path: null}`,
 * and the old map then answered that same empty result on every remount. The
 * backend has no negative cache either, so the only way to recover was to change
 * view, restart, or press 刷新封面 - and the map would still hold the empty row
 * after a restart of the page.
 *
 * This module is the frontend half: remember the failure for a bounded time, then
 * let the next card mount ask again. The TTL matches the backend's
 * `NEGATIVE_TTL` (ogimage.rs), so the two layers agree on what "fresh" means; the
 * backend holds one extra guard for sessions this module never sees.
 *
 * Deliberately not persisted: a failure is about *this* network moment, and a
 * cold start is a legitimate reason to try again.
 */

/** How long a cover that failed stays "known bad" in this page. */
export const COVER_FAILURE_TTL_MS = 5 * 60 * 1000;

type Failure = { at: number; error: string };

const failures = new Map<string, Failure>();

/**
 * The remembered reason for `slug`, or `null` when the next mount may ask again.
 *
 * An empty reason is still a failure ("no image") and is reported as an empty
 * string; callers use `!== null` rather than truthiness.
 */
export function coverFailureFor(slug: string, now = Date.now()): string | null {
  const row = failures.get(slug);
  if (!row) return null;
  if (now - row.at >= COVER_FAILURE_TTL_MS) {
    failures.delete(slug);
    return null;
  }
  return row.error;
}

/** Remember a soft failure. `error` is the backend's text, possibly empty. */
export function rememberCoverFailure(slug: string, error: string, now = Date.now()): void {
  failures.set(slug, { at: now, error });
}

/** Drop the failure for `slug`; called when a later fetch succeeds. */
export function forgetCoverFailure(slug: string): void {
  failures.delete(slug);
}

/** Test seam: the memo is module state, like the tile's inflight map. */
export function clearCoverFailures(): void {
  failures.clear();
}

/** Number of remembered failures, for tests and diagnostics only. */
export function coverFailureCount(): number {
  return failures.size;
}
