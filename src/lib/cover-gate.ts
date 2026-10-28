/**
 * A session-wide gate on cover fetches (r20-O1-2).
 *
 * `RepoTile.tsx` already deduplicates by `owner/repo` (`coverInflight`) and already
 * waits for the card to approach the viewport (`src/lib/use-in-view.ts`, commit
 * `9f472a4`). Neither of those bounds a *burst*: a fast scroll or a filter change can
 * put 40 different repositories in view at once, and each one then calls
 * `fetch_cover`, which is one IPC round trip plus — on a cold cover — one `curl`
 * against `opengraph.githubassets.com`. The backend measures that fetch at 0.5 s to
 * 5.1 s cold (`DEVELOPMENT.md` §4, "Repository covers"), so 40 simultaneous fetches
 * are 40 OS threads in `spawn_blocking` competing for the same network path a person
 * is trying to read the wall through.
 *
 * The cap is deliberately small and deliberately shared: the covers are decorative
 * (a gradient is already painted under each tile), so they should never be able to
 * out-prioritise an interaction.
 */

/** How many cover requests may be in flight across the whole app at once. */
export const COVER_MAX_INFLIGHT = 4;

let inflight = 0;
const waiting: (() => void)[] = [];

/** Take a slot, run `task`, release the slot — even when `task` rejects. */
export async function withCoverSlot<T>(task: () => Promise<T>, limit = COVER_MAX_INFLIGHT): Promise<T> {
  if (inflight >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inflight++;
  try {
    return await task();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

/** Number of tasks currently holding a slot. Exported for tests and for the
 * 状态条's future "封面加载中" count — not for production logic to branch on. */
export function coverSlotsInUse(): number {
  return inflight;
}
