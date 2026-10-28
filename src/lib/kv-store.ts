/**
 * A synchronous-first key/value facade over the webview's persisted prefs
 * (r21-R3-2).
 *
 * ## What this is for
 *
 * Every persisted store in this app talks to `localStorage` directly, through
 * two shapes: `lib/storage.ts`'s coalescing writer and a handful of private
 * `persist()` helpers. That works, but it hard-wires the *backend*: moving a
 * payload to IndexedDB or the origin-private file system later would mean
 * editing every call site, because the call sites are the API.
 *
 * This module puts one interface in between. Three implementations ship:
 *
 *   * `localStorageKv`        — today's behaviour exactly: writes go through the
 *     coalescing scheduler (`scheduleStorageWrite` / `scheduleStorageRemove`),
 *     reads go straight to `localStorage`.
 *   * `memoryKv`              — a Map, for tests and for the hydration mirror the
 *     migration path below describes.
 *   * `directLocalStorageKv`  — no coalescing; the raw backend. It exists because
 *     the coalescer's *flush* needs a sink to flush into, and a coalescing kv
 *     cannot be its own sink (flush -> schedule -> flush would recurse).
 *
 * plus `makeQuotaKv`, a decorator that estimates usage after every write and
 * fires ONE callback when the estimate crosses a threshold, and
 * `installQuotaStorage`, which puts that decorator into the live write path.
 *
 * ## The synchronous constraint (why the interface is not async)
 *
 * The stores read their first state **synchronously at module init**:
 * `wall.ts` runs `readStored()` at import time, `appearance.ts` runs `load()`,
 * and `searches.ts` / `landing.ts` / `failures.ts` / `customize.ts` do the same.
 * A `KvStore` whose `get` returned a Promise would force every one of those into
 * a hydration state (`null` until the backend opens), which is a product-visible
 * change to first paint — not a drop-in backend swap. So the interface stays
 * synchronous and async backends are expected to *adapt*:
 *
 *   1. **Mirror + write-behind** (the path for a large payload): hydrate a
 *      `memoryKv` mirror from IndexedDB/OPFS once at boot (await it before the
 *      first render), serve `get` / `keys` from the mirror, and push writes
 *      through a queue that flushes to the async backend afterwards. Reads never
 *      block; a failed flush surfaces through the same `onError` channel the
 *      quota decorator uses.
 *   2. **Explicit async at the owning call site** (the path for one oversized
 *      key): give that key its own module with async read/write and await it
 *      only where the value is actually needed. No synchronous API can wrap
 *      IndexedDB on the main thread, and OPFS's synchronous access handles exist
 *      only inside web workers — both facts are recorded in
 *      `docs/r21-storage-eval.md`.
 *
 * Either way the *shape* of a call site does not change while usage is small,
 * which is what makes deferring the migration safe: the quota decorator is the
 * tripwire that says when to start.
 *
 * ## Honest limits
 *
 *   * `quotaEstimate()` is an estimate, never an exact on-disk size: it sums
 *     `estimateBytes` over the keys the backend can enumerate, and it cannot see
 *     another tab's writes or the browser's own padding.
 *   * `localStorageKv.quotaEstimate()` does not include writes still sitting in
 *     the coalescer's 250 ms window — on purpose, because `get` cannot see them
 *     either. A caller that needs the window counted wraps it in `makeQuotaKv`,
 *     whose shadow records every write it forwarded as it was queued.
 *   * Nothing here pops UI. `onError` is a callback; what (if anything) reaches
 *     the person is the caller's decision, because this module cannot know
 *     whether it is running in the shell, in a test, or during boot.
 */
import {
  scheduleStorageRemove,
  scheduleStorageWrite,
  setStorageSink,
  type StorageSink,
} from "./storage";

/** The synchronous contract every backend here implements. */
export type KvStore = {
  /** `null` for "no such key" — the answer `localStorage.getItem` gives. */
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  /** Keys in whatever order the backend enumerates; never a live view. */
  keys: () => string[];
  /** Optional byte estimate of everything this backend currently holds. */
  quotaEstimate?: () => number;
};

/** What `makeQuotaKv` reports. One type for both reasons, discriminated by `reason`. */
export type QuotaEvent = {
  /**
   * `threshold`   — estimated usage reached `warnAtBytes`; fired at most once
   *                 per decorator instance (the idempotence a monitor wants).
   * `write-error` — the backend's own `set` / `remove` threw (a real
   *                 `QuotaExceededError` in the app). Not latched: every
   *                 refused write is a distinct event.
   */
  reason: "threshold" | "write-error";
  /** The key being written when the event fired. */
  key: string;
  /** Estimated bytes at the moment of the event. */
  bytes: number;
  /** The configured threshold, carried on both reasons so a log line stands alone. */
  warnAtBytes: number;
  /** The thrown value; only set for `write-error`. */
  error?: unknown;
};

const encoder = new TextEncoder();

/**
 * Conservative byte estimate for one string.
 *
 * Two candidate counters exist and this round's research could not establish
 * which one Chromium enforces (the 信息缺失 list in `docs/r21-storage-eval.md`):
 * the quota is specified in *bytes*, while keys and values are *UTF-16* strings.
 * So the estimate is `max(UTF-8 bytes, UTF-16 code units x 2)` — the larger of
 * the two hypotheses, the only choice that cannot under-count under either one.
 * ASCII payloads come out at 2x their UTF-8 size; CJK payloads at their UTF-8 size.
 */
export function estimateBytes(value: string): number {
  return Math.max(encoder.encode(value).length, value.length * 2);
}

/**
 * Usage over `base`, with `overrides` winning per key (`null` = removed).
 *
 * Shared by the quota decorator (its shadow of what it wrote) and by any caller
 * that knows a key's value is about to change. The override map is consulted
 * first, so a value queued but not yet visible to `base.get` is still counted
 * exactly once rather than twice.
 */
function usageOf(base: KvStore, overrides: ReadonlyMap<string, string | null>): number {
  let bytes = 0;
  for (const [key, value] of overrides) {
    if (value !== null) bytes += estimateBytes(key) + estimateBytes(value);
  }
  for (const key of base.keys()) {
    if (overrides.has(key)) continue;
    const value = base.get(key);
    if (value !== null) bytes += estimateBytes(key) + estimateBytes(value);
  }
  return bytes;
}

/** The real `localStorage`, or `null` in a Node process that installed no fake. */
function resolveStorage(explicit?: () => Storage): Storage | null {
  if (explicit) {
    try {
      return explicit();
    } catch {
      return null;
    }
  }
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/**
 * Raw `localStorage`, no coalescing — the backend the flush path can target.
 *
 * Without a `localStorage` in this process (Node without the test helper's
 * `installBrowserGlobals`) reads answer "empty" and writes are dropped: the same
 * defensive shape `launch-templates.ts` and `shortcut-bindings.ts` already use,
 * and the reason a store can be imported under `node --test` at all.
 */
export function directLocalStorageKv(opts?: { storage?: () => Storage }): KvStore {
  const kv: KvStore = {
    get: (key) => resolveStorage(opts?.storage)?.getItem(key) ?? null,
    set: (key, value) => {
      const s = resolveStorage(opts?.storage);
      if (s) s.setItem(key, value);
    },
    remove: (key) => {
      const s = resolveStorage(opts?.storage);
      if (s) s.removeItem(key);
    },
    keys: () => {
      const s = resolveStorage(opts?.storage);
      if (!s) return [];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += 1) {
        const key = s.key(i);
        if (key !== null) out.push(key);
      }
      return out;
    },
    quotaEstimate: () => usageOf(kv, new Map()),
  };
  return kv;
}

/**
 * Today's behaviour, behind the interface: coalesced writes, direct reads.
 *
 * `set` queues the JSON into `lib/storage.ts`'s scheduler, so a burst of sets
 * still collapses into one trailing write 250 ms later and `beforeunload` /
 * `pagehide` still flush what is pending. `get` does NOT see a queued write
 * until the flush lands — that is precisely what `localStorage` does today, and
 * answering differently here would let a caller read a value the real store
 * could not.
 */
export function localStorageKv(opts?: { storage?: () => Storage }): KvStore {
  const direct = directLocalStorageKv(opts);
  return {
    get: (key) => direct.get(key),
    set: (key, value) => scheduleStorageWrite(key, value),
    remove: (key) => scheduleStorageRemove(key),
    keys: () => direct.keys(),
    // Queued writes are invisible here on purpose (see above); a caller that
    // needs them counted wraps this in `makeQuotaKv`, whose shadow tracks every
    // write it forwarded the moment it was queued.
    quotaEstimate: () => direct.quotaEstimate?.() ?? 0,
  };
}

/** A Map-backed `KvStore`: tests, and the hydration mirror of the migration path. */
export function memoryKv(seed?: Readonly<Record<string, string>>): KvStore {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
    quotaEstimate: () => {
      let bytes = 0;
      for (const [key, value] of map) bytes += estimateBytes(key) + estimateBytes(value);
      return bytes;
    },
  };
}

/**
 * Decorator factory: estimate usage after every successful write, and report a
 * threshold crossing **once**.
 *
 * `makeQuotaKv({ warnAtBytes, onError })(base)` returns a `KvStore` that behaves
 * exactly like `base` — the decorator adds no behaviour a caller can observe
 * through `get` / `set` / `remove` / `keys`, only the callback. That is what lets
 * it sit in the live write path (see `installQuotaStorage`) without changing a
 * single store's semantics.
 *
 * Contract:
 *   * `threshold` fires at most once per decorator instance, after the write
 *     that crossed the line has landed, so `bytes` describes real stored data.
 *     Further writes stay silent — a monitor that re-fires on every keystroke is
 *     noise, not signal.
 *   * `write-error` fires whenever the base refuses a write, and then the error
 *     is re-thrown so the caller's own policy (every writer in this app swallows
 *     quota failures on purpose) is unchanged.
 *   * An `onError` that itself throws is caught: a faulty reporter must not be
 *     able to abort the flush loop carrying the remaining writes.
 */
export function makeQuotaKv(opts: {
  warnAtBytes: number;
  onError?: (event: QuotaEvent) => void;
}): (base: KvStore) => KvStore {
  const { warnAtBytes, onError } = opts;
  return (base: KvStore): KvStore => {
    const shadow = new Map<string, string | null>();
    let thresholdFired = false;

    const usage = (): number => usageOf(base, shadow);

    const fire = (event: QuotaEvent): void => {
      if (!onError) return;
      try {
        onError(event);
      } catch {
        /* a reporter that throws must not take the write path down with it */
      }
    };

    const afterWrite = (key: string): void => {
      if (thresholdFired) return;
      const bytes = usage();
      if (bytes < warnAtBytes) return;
      thresholdFired = true;
      fire({ reason: "threshold", key, bytes, warnAtBytes });
    };

    return {
      get: (key) => base.get(key),
      set: (key, value) => {
        try {
          base.set(key, value);
        } catch (error) {
          fire({ reason: "write-error", key, bytes: usage(), warnAtBytes, error });
          throw error;
        }
        shadow.set(key, value);
        afterWrite(key);
      },
      remove: (key) => {
        try {
          base.remove(key);
        } catch (error) {
          fire({ reason: "write-error", key, bytes: usage(), warnAtBytes, error });
          throw error;
        }
        shadow.set(key, null);
      },
      keys: () => base.keys(),
      quotaEstimate: usage,
    };
  };
}

/**
 * Put a quota-watched `localStorage` behind `lib/storage.ts`'s flush path.
 *
 * This is the r3-3 integration point: `storage.ts` does not know what a `KvStore`
 * is — it only flushes into a `StorageSink` — and this function installs a sink
 * built from `makeQuotaKv(...)(directLocalStorageKv())`. Stores keep calling
 * `scheduleStorageWrite` and nothing about their timing changes; the only new
 * behaviour is that a write which pushes the estimate over `warnAtBytes`, or a
 * write the browser refuses, reaches `onError`.
 *
 * Returns the uninstall function, which puts the default (unwatched) sink back.
 * Tests need it: the sink is module state, and a leaked one would make an
 * unrelated suite's flushes run through a dead decorator.
 */
export function installQuotaStorage(opts: {
  warnAtBytes: number;
  onError?: (event: QuotaEvent) => void;
}): () => void {
  const kv = makeQuotaKv(opts)(directLocalStorageKv());
  const sink: StorageSink = {
    write: (key, json) => kv.set(key, json),
    remove: (key) => kv.remove(key),
  };
  setStorageSink(sink);
  return () => setStorageSink(null);
}
