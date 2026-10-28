/**
 * Coalesced localStorage writes.
 *
 * Why this exists: `wall.ts` stringified and wrote on every `setRepo` — a cover
 * pick or a drag burst fires dozens in a second — and `appearance.ts` wrote on
 * every keystroke-driven `set`. Each write is synchronous JSON over the whole
 * store; the storm is pure cost with zero added safety, because only the last
 * value in a burst is the one that matters.
 *
 * Semantics: one trailing flush per burst (250 ms), last value per key wins,
 * and the promise that makes deferring safe is that nothing is ever lost on
 * quit — `beforeunload` and `pagehide` flush whatever is pending. A lost
 * preference is worse than an extra write, so when in doubt we write early.
 *
 * The value passed in is the already-stringified JSON: this module never
 * re-formats it, so what lands on disk is byte-identical to what the direct
 * `localStorage.setItem(key, JSON.stringify(...))` call used to write.
 */

/**
 * Where a flushed write actually lands.
 *
 * `storage.ts` itself knows nothing about `KvStore`, quotas, or IndexedDB — it
 * only merges and delivers. This two-method port is the seam those concerns
 * plug into (see `installQuotaStorage` in `kv-store.ts`): the default sink is
 * today's raw `localStorage` call, and swapping the sink does not change the
 * scheduling, the last-wins rule, or the quit-time flush.
 */
export type StorageSink = {
  write: (key: string, json: string) => void;
  remove: (key: string) => void;
};

const defaultSink: StorageSink = {
  write: (key, json) => {
    localStorage.setItem(key, json);
  },
  remove: (key) => {
    localStorage.removeItem(key);
  },
};

let sink: StorageSink = defaultSink;

/** Install `next` as the flush target, or `null` to restore the raw default. */
export function setStorageSink(next: StorageSink | null) {
  sink = next ?? defaultSink;
}

/** key → the JSON to write, or null for removeItem. Last call wins. */
const pending = new Map<string, string | null>();
let timer: number | null = null;

const COALESCE_MS = 250;

function flushNow() {
  if (timer !== null) {
    // The bare global, not `window.clearTimeout`: this function is reached from
    // `flushStorage()`, which the Node test runner calls directly, and there is
    // no `window` there — the `window`-guard at the bottom of this file covers
    // the listeners but not this line, so `pnpm test` died with
    // "window is not defined" from an otherwise healthy store.
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  const ops = [...pending.entries()];
  pending.clear();
  for (const [key, value] of ops) {
    try {
      // Through the sink, not `localStorage` directly. A quota-watched sink
      // reports the refusal to its callback *and then* re-throws; this
      // per-operation catch keeps the old contract (one refused write never
      // kills the loop or the session) while the event still escapes once.
      if (value === null) sink.remove(key);
      else sink.write(key, value);
    } catch {
      /* quota or private mode: the session keeps its state, same as before */
    }
  }
}

/** Queue a write for this key; a burst of calls collapses into one. */
export function scheduleStorageWrite(key: string, json: string) {
  pending.set(key, json);
  if (timer === null) timer = setTimeout(flushNow, COALESCE_MS);
}

/** Queue a removal for this key (恢复默认), with the same coalescing. */
export function scheduleStorageRemove(key: string) {
  pending.set(key, null);
  if (timer === null) timer = setTimeout(flushNow, COALESCE_MS);
}

/** Flush any pending write immediately (tests and explicit commit points). */
export function flushStorage() {
  flushNow();
}

// Quit safety: WebView2 fires both on window close; whichever arrives first
// writes, the second finds nothing pending. Guarded because this module is also
// imported by the Node test runner (`pnpm test`), which has no `window` — an
// unguarded top-level `window.addEventListener` made every test file that
// transitively imports the wall store die at import time with
// "window is not defined", which reads like a broken store and is not one.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushNow);
  window.addEventListener("pagehide", flushNow);
}
