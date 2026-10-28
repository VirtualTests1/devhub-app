/**
 * `src/lib/kv-store.ts` — the synchronous `KvStore` facade and the quota
 * decorator (r21-R3-2).
 *
 * What is worth pinning here is not "a Map works" but the contracts a live store
 * will silently depend on later:
 *
 *   * `localStorageKv` must behave exactly like today's path — a queued write is
 *     invisible until the 250 ms flush, and last value wins. If this facade ever
 *     answered a read *before* the flush, a caller could observe a value the real
 *     `localStorage` never had, and the swap would have changed behaviour.
 *   * `makeQuotaKv` must report a threshold crossing exactly once (a monitor that
 *     re-fires per keystroke is noise), must report a refused write and then
 *     re-throw it (so each store's existing swallow-policy is unchanged), and must
 *     not let a broken reporter take the flush loop down.
 *   * `installQuotaStorage` must be invisible to the scheduler: writes still
 *     land, `flushStorage()` still never throws, and uninstalling restores the
 *     raw sink so a leaked decorator cannot outlive its test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateBytes,
  directLocalStorageKv,
  installQuotaStorage,
  localStorageKv,
  makeQuotaKv,
  memoryKv,
  type KvStore,
  type QuotaEvent,
} from "../src/lib/kv-store.ts";
import { flushStorage, scheduleStorageWrite } from "../src/lib/storage.ts";
import { installBrowserGlobals, readBack } from "./helpers/storage.ts";

installBrowserGlobals();

const KEY = "devhub.kvtest.v1";

function globalStore(): Storage {
  const g = globalThis as { localStorage?: Storage };
  assert.ok(g.localStorage !== undefined, "the test helper must have installed localStorage");
  return g.localStorage;
}

/** Flush whatever a previous test queued, then start from an empty store. */
function resetSharedStorage(): void {
  flushStorage();
  globalStore().clear();
}

function makeStorage(seed?: Record<string, string>): Storage {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
  };
}

/** A `Storage` whose every write is refused, counting the attempts it saw. */
function refusingStorage(attempts: { count: number }): Storage {
  const inner = makeStorage();
  return {
    get length() {
      return inner.length;
    },
    key: (index: number) => inner.key(index),
    getItem: (k: string) => inner.getItem(k),
    setItem: () => {
      attempts.count += 1;
      throw new Error("QuotaExceededError: rejected");
    },
    removeItem: (k: string) => inner.removeItem(k),
    clear: () => {
      inner.clear();
    },
  };
}

function eventAt(events: QuotaEvent[], index: number): QuotaEvent {
  const event = events[index];
  assert.ok(event !== undefined, `events[${index}] must exist, saw ${events.length}`);
  return event;
}

test("estimateBytes: the larger of UTF-8 bytes and UTF-16 code units x 2", () => {
  assert.equal(estimateBytes("abc"), 6, "ASCII is counted as UTF-16 code units x 2");
  assert.equal(estimateBytes("墙"), 3, "a CJK code point is 3 UTF-8 bytes but 1 code unit");
  assert.equal(estimateBytes("🙂"), 4, "a surrogate pair is 4 UTF-8 bytes and 4 code units");
  for (const sample of ["", "a", "abcdefg", "中文字", "🙂🙂", "mixed 中 🙂"]) {
    assert.ok(estimateBytes(sample) >= sample.length * 2, `never under-counts UTF-16: ${sample}`);
    assert.ok(
      estimateBytes(sample) >= new TextEncoder().encode(sample).length,
      `never under-counts UTF-8: ${sample}`,
    );
  }
});

test("memoryKv: seed, roundtrip, removal, and an estimate that counts keys too", () => {
  const kv = memoryKv({ [KEY]: "seeded" });
  assert.equal(kv.get(KEY), "seeded");
  assert.equal(kv.get("devhub.kvtest.absent"), null, "missing keys read as null, not undefined");

  kv.set(KEY, "written");
  assert.equal(kv.get(KEY), "written");

  kv.set("devhub.kvtest.other", "x");
  assert.deepEqual([...kv.keys()].sort(), [KEY, "devhub.kvtest.other"].sort());

  kv.remove("devhub.kvtest.other");
  assert.equal(kv.get("devhub.kvtest.other"), null);

  // estimate = key bytes + value bytes, per key, with the conservative formula.
  const expected = estimateBytes(KEY) + estimateBytes("written");
  assert.equal(kv.quotaEstimate?.(), expected);
});

test("directLocalStorageKv: roundtrip against an injected backend, empty without one", () => {
  const fake = makeStorage({ [KEY]: "seeded" });
  const kv = directLocalStorageKv({ storage: () => fake });
  assert.equal(kv.get(KEY), "seeded");
  assert.deepEqual(kv.keys(), [KEY]);
  assert.equal(kv.quotaEstimate?.(), estimateBytes(KEY) + estimateBytes("seeded"));

  kv.set("devhub.kvtest.direct", "12345");
  assert.equal(fake.getItem("devhub.kvtest.direct"), "12345", "writes are immediate, not coalesced");
  kv.remove("devhub.kvtest.direct");
  assert.equal(fake.getItem("devhub.kvtest.direct"), null);

  // No `localStorage` in this process at all: reads answer "empty" and writes
  // drop, the defensive shape that lets a store import under `node --test`.
  const g = globalThis as { localStorage?: Storage };
  const previous = g.localStorage;
  delete g.localStorage;
  try {
    const bare = directLocalStorageKv();
    assert.equal(bare.get(KEY), null);
    assert.deepEqual(bare.keys(), []);
    assert.equal(bare.quotaEstimate?.(), 0);
    bare.set(KEY, "dropped");
    bare.remove(KEY);
  } finally {
    g.localStorage = previous;
  }
});

test("localStorageKv: a queued write is invisible until the flush, last value wins", () => {
  resetSharedStorage();
  const kv = localStorageKv();

  kv.set(KEY, "queued");
  assert.equal(readBack(KEY), null, "not written yet: the scheduler owns the timing");
  assert.equal(kv.get(KEY), null, "get reads the real store, so it must not see the queue either");

  flushStorage();
  assert.equal(readBack(KEY), "queued");
  assert.equal(kv.get(KEY), "queued");

  kv.set(KEY, "first");
  kv.set(KEY, "second");
  flushStorage();
  assert.equal(readBack(KEY), "second", "last call wins across a burst, as the coalescer promises");

  kv.remove(KEY);
  assert.equal(readBack(KEY), "second", "removal is queued by the same scheduler");
  flushStorage();
  assert.equal(readBack(KEY), null);
  assert.equal(kv.get(KEY), null);
});

test("localStorageKv: the estimate excludes the queue, because reads do too", () => {
  resetSharedStorage();
  const kv = localStorageKv();
  const before = kv.quotaEstimate?.() ?? 0;

  kv.set(KEY, "0123456789");
  assert.equal(
    kv.quotaEstimate?.() ?? 0,
    before,
    "a pending write is invisible to this backend by design",
  );

  flushStorage();
  assert.ok(
    (kv.quotaEstimate?.() ?? 0) > before,
    "once flushed, the bytes show up; a caller that needs the window counted wraps this in makeQuotaKv",
  );

  kv.remove(KEY);
  flushStorage();
});

test("makeQuotaKv: threshold fires once, on the crossing write, and stays silent", () => {
  const events: QuotaEvent[] = [];
  const kv = makeQuotaKv({ warnAtBytes: 40, onError: (event) => events.push(event) })(memoryKv());

  kv.set("a", "12345");
  assert.equal(events.length, 0, "still under the line");

  kv.set("b", "z".repeat(40));
  const first = eventAt(events, 0);
  assert.equal(events.length, 1, "exactly one event, fired after the write landed");
  assert.equal(first.reason, "threshold");
  assert.equal(first.key, "b");
  assert.equal(first.warnAtBytes, 40);
  assert.ok(first.bytes >= 40, `bytes must describe stored data, saw ${first.bytes}`);
  assert.equal(first.error, undefined, "a threshold event carries no error");

  kv.set("c", "y".repeat(500));
  assert.equal(events.length, 1, "latched: a monitor that re-fires per keystroke is noise");

  // Even dropping back under the line and crossing again stays silent: the
  // latch is per decorator instance, not per crossing.
  kv.remove("c");
  kv.set("d", "w".repeat(500));
  assert.equal(events.length, 1);

  // The decorator added no behaviour a reader can observe.
  assert.equal(kv.get("a"), "12345");
  assert.equal(kv.get("d"), "w".repeat(500));
  assert.deepEqual([...kv.keys()].sort(), ["a", "b", "d"]);
});

test("makeQuotaKv: below the line it is behaviourally the base store", () => {
  const events: QuotaEvent[] = [];
  const seed = { [KEY]: "seeded" };
  const bare = memoryKv(seed);
  const watched = makeQuotaKv({
    warnAtBytes: 1_000_000_000,
    onError: (event) => events.push(event),
  })(memoryKv(seed));

  assert.equal(watched.get(KEY), bare.get(KEY));
  watched.set("devhub.kvtest.next", "value");
  bare.set("devhub.kvtest.next", "value");
  assert.deepEqual([...watched.keys()].sort(), [...bare.keys()].sort());
  assert.equal(watched.quotaEstimate?.(), bare.quotaEstimate?.());

  watched.remove("devhub.kvtest.next");
  assert.equal(watched.get("devhub.kvtest.next"), null);
  assert.equal(events.length, 0, "nothing to report while usage stays trivial");
});

test("makeQuotaKv: a refused write reports write-error, then re-throws to the caller", () => {
  const inner = memoryKv();
  const refusal = new Error("QuotaExceededError: rejected");
  const failing: KvStore = {
    get: (key) => inner.get(key),
    set: () => {
      throw refusal;
    },
    remove: () => {
      throw refusal;
    },
    keys: () => inner.keys(),
  };

  const events: QuotaEvent[] = [];
  const kv = makeQuotaKv({ warnAtBytes: 1_000_000_000, onError: (event) => events.push(event) })(
    failing,
  );

  assert.throws(
    () => kv.set(KEY, "never lands"),
    (error: unknown) => error === refusal,
    "the store's own swallow-policy sees the same error it always did",
  );
  const setEvent = eventAt(events, 0);
  assert.equal(events.length, 1);
  assert.equal(setEvent.reason, "write-error");
  assert.equal(setEvent.key, KEY);
  assert.equal(setEvent.error, refusal);
  assert.equal(inner.get(KEY), null, "nothing landed, so nothing is counted as landed");
  assert.equal(
    kv.quotaEstimate?.(),
    0,
    "the shadow only records writes the base accepted",
  );

  assert.throws(() => kv.remove(KEY), (error: unknown) => error === refusal);
  assert.equal(eventAt(events, 1).reason, "write-error", "refusals are not latched");
  assert.equal(events.length, 2);
});

test("makeQuotaKv: a reporter that throws never escapes into the write path", () => {
  const inner = memoryKv();
  const refusal = new Error("QuotaExceededError: rejected");
  const failing: KvStore = {
    get: (key) => inner.get(key),
    set: () => {
      throw refusal;
    },
    remove: () => {
      throw refusal;
    },
    keys: () => inner.keys(),
  };

  const explode = (): void => {
    throw new Error("reporter exploded");
  };

  // Error path: the reporter's failure must not mask the backend's error.
  const onFailing = makeQuotaKv({ warnAtBytes: 1, onError: explode })(failing);
  assert.throws(
    () => onFailing.set(KEY, "x"),
    (error: unknown) => error === refusal,
    "the caller sees the quota refusal, never the reporter's throw",
  );

  // Threshold path: the write itself must still complete.
  const healthy = makeQuotaKv({ warnAtBytes: 1, onError: explode })(memoryKv());
  healthy.set(KEY, "lands anyway");
  assert.equal(healthy.get(KEY), "lands anyway");
});

test("installQuotaStorage: the flush carries the threshold event and the write lands", () => {
  resetSharedStorage();
  const events: QuotaEvent[] = [];
  const uninstall = installQuotaStorage({ warnAtBytes: 100, onError: (event) => events.push(event) });
  try {
    scheduleStorageWrite("devhub.kvtest.a", "v");
    scheduleStorageWrite("devhub.kvtest.b", "z".repeat(60));
    flushStorage();

    assert.equal(readBack("devhub.kvtest.a"), "v", "the scheduler's writes still land");
    assert.equal(readBack("devhub.kvtest.b"), "z".repeat(60));
    const first = eventAt(events, 0);
    assert.equal(events.length, 1, "one crossing, one event, even across a two-write flush");
    assert.equal(first.reason, "threshold");
    assert.equal(first.key, "devhub.kvtest.b");
    assert.equal(first.warnAtBytes, 100);

    scheduleStorageWrite("devhub.kvtest.c", "y".repeat(200));
    flushStorage();
    assert.equal(readBack("devhub.kvtest.c"), "y".repeat(200));
    assert.equal(events.length, 1, "the installed decorator is latched too");
  } finally {
    uninstall();
    resetSharedStorage();
  }
});

test("installQuotaStorage: a refused flush does not throw, and reporting it still works", () => {
  resetSharedStorage();
  const events: QuotaEvent[] = [];
  const attempts = { count: 0 };
  const uninstall = installQuotaStorage({
    warnAtBytes: 1_000_000_000,
    onError: (event) => events.push(event),
  });
  const g = globalThis as { localStorage?: Storage };
  const previous = g.localStorage;
  g.localStorage = refusingStorage(attempts);
  try {
    scheduleStorageWrite("devhub.kvtest.x", "1");
    scheduleStorageWrite("devhub.kvtest.y", "2");
    flushStorage(); // the old contract: a quota refusal never throws out of a flush

    const refusal = eventAt(events, 0);
    assert.equal(events.length, 2, "write-error is not latched: every refused write is an event");
    assert.equal(refusal.reason, "write-error");
    assert.equal(refusal.key, "devhub.kvtest.x");
    assert.ok(refusal.error instanceof Error);
    assert.match(refusal.error.message, /QuotaExceededError/);
    assert.equal(eventAt(events, 1).key, "devhub.kvtest.y", "the loop reported the second refusal too");
    assert.equal(attempts.count, 2, "the first refusal did not abort the loop for the rest");
  } finally {
    g.localStorage = previous;
    uninstall();
    resetSharedStorage();
  }
});

test("installQuotaStorage: uninstalling restores the raw sink", () => {
  resetSharedStorage();
  const events: QuotaEvent[] = [];
  const uninstall = installQuotaStorage({ warnAtBytes: 40, onError: (event) => events.push(event) });
  uninstall();

  scheduleStorageWrite(KEY, "raw again");
  flushStorage();
  assert.equal(readBack(KEY), "raw again", "the default sink writes straight through");
  assert.equal(events.length, 0, "no decorator is left behind to observe it");
  resetSharedStorage();
});
