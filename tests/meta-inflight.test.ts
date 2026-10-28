/**
 * `src/store/meta.ts` — the ordering guard on the 项目墙 metadata load.
 *
 * The bug these pin (r15-correct-4): `load` dropped a second *plain* ask while
 * one was in flight but let a `force` ask through unconditionally, and nothing
 * ordered the two responses. A 刷新 issued while a cached load was still out
 * could therefore lose: the earlier call — answered from the backend's ten-minute
 * cache, i.e. the stale walk — wrote `bySlug` *after* the fresh one, so the tiles
 * went back to pre-refresh sizes. Whichever response finished first also cleared
 * `loading` for both.
 *
 * Same shape as `App.tsx`'s `settingsSeq`: stamp the sequence on entry, and let
 * only the newest stamp write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMetaStore, type MetaFetcher } from "../src/store/meta.ts";
import type { RepoMeta } from "../src/types.ts";

/** Lets a response be landed exactly when the test wants it, so "later" is a state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (r: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resumes the awaiting `load` continuations before the next assertion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const meta = (slug: string, sizeBytes: number): RepoMeta => ({
  slug,
  installedAt: 1_700_000_000_000,
  sizeBytes,
  language: "Rust",
  category: "rust",
  hasCache: true,
});

type Store = ReturnType<typeof createMetaStore>;

function storeOver(fetcher: MetaFetcher): Store {
  return createMetaStore(fetcher);
}

test("a plain ask while one is in flight is dropped, not queued", async () => {
  let calls = 0;
  const gate = deferred<RepoMeta[]>();
  const s = storeOver(() => {
    calls += 1;
    return gate.promise;
  });

  void s.getState().load(false);
  void s.getState().load(false);
  assert.equal(calls, 1, "the in-flight answer is newer than the ask that would replace it");
  assert.equal(s.getState().loading, true);

  gate.resolve([meta("github.com/a/one", 10)]);
  await flush();
  assert.equal(calls, 1);
  assert.equal(s.getState().loading, false);
});

test("a forced ask is never swallowed by the dedupe", async () => {
  const d1 = deferred<RepoMeta[]>();
  const d2 = deferred<RepoMeta[]>();
  let n = 0;
  const s = storeOver(() => {
    n += 1;
    return n === 1 ? d1.promise : d2.promise;
  });

  void s.getState().load(false);
  void s.getState().load(true);
  assert.equal(n, 2, "刷新 means re-walk past the cache, so it must reach the backend");

  d1.resolve([]);
  d2.resolve([]);
  await flush();
  assert.equal(s.getState().loading, false, "and both outstanding loads settle");
});

test("the stale cached response cannot win bySlug after the forced one lands", async () => {
  const d1 = deferred<RepoMeta[]>();
  const d2 = deferred<RepoMeta[]>();
  let n = 0;
  const s = storeOver(() => {
    n += 1;
    return n === 1 ? d1.promise : d2.promise;
  });

  void s.getState().load(false); // cached walk, already in flight
  void s.getState().load(true); // 刷新, forced past the cache

  d2.resolve([meta("github.com/a/new", 200)]);
  await flush();
  assert.deepEqual(Object.keys(s.getState().bySlug), ["github.com/a/new"], "the fresh answer paints");

  // The race: the earlier call answers *after* the one that superseded it.
  d1.resolve([meta("github.com/a/stale", 999)]);
  await flush();
  assert.deepEqual(
    Object.keys(s.getState().bySlug),
    ["github.com/a/new"],
    "a superseded response must not overwrite the wall with pre-refresh sizes",
  );
  assert.equal(s.getState().bySlug["github.com/a/stale"], undefined);
});

test("an older response finishing first does not end the loading state", async () => {
  const d1 = deferred<RepoMeta[]>();
  const d2 = deferred<RepoMeta[]>();
  let n = 0;
  const s = storeOver(() => {
    n += 1;
    return n === 1 ? d1.promise : d2.promise;
  });

  void s.getState().load(false);
  void s.getState().load(true);

  d1.resolve([meta("github.com/a/one", 1)]);
  await flush();
  assert.equal(s.getState().loading, true, "the forced walk is still out; the wall must say so");

  d2.resolve([meta("github.com/a/two", 2)]);
  await flush();
  assert.equal(s.getState().loading, false, "only the newest load closes it");
  assert.deepEqual(Object.keys(s.getState().bySlug), ["github.com/a/two"]);
});

test("a superseded rejection does not report a failure the user did not ask about", async () => {
  const d1 = deferred<RepoMeta[]>();
  const d2 = deferred<RepoMeta[]>();
  let n = 0;
  const s = storeOver(() => {
    n += 1;
    return n === 1 ? d1.promise : d2.promise;
  });

  void s.getState().load(false);
  void s.getState().load(true);

  d2.resolve([meta("github.com/a/fresh", 5)]);
  await flush();
  d1.reject(new Error("命令不存在"));
  await flush();

  assert.equal(s.getState().loading, false, "the newer load already closed it and stands");
  assert.deepEqual(Object.keys(s.getState().bySlug), ["github.com/a/fresh"], "its data survives");
});

test("loadedAt moves with the accepted answer only", async () => {
  const first = deferred<RepoMeta[]>();
  const second = deferred<RepoMeta[]>();
  let n = 0;
  const s = storeOver(() => {
    n += 1;
    return n === 1 ? first.promise : second.promise;
  });

  assert.equal(s.getState().loadedAt, 0, "nothing has been loaded yet");
  void s.getState().load(false);
  void s.getState().load(true);

  first.resolve([meta("a", 1)]);
  await flush();
  assert.equal(s.getState().loadedAt, 0, "a stale response does not claim the wall is up to date");

  second.resolve([meta("b", 2)]);
  await flush();
  assert.ok(s.getState().loadedAt > 0, "and the accepted one does");
});
