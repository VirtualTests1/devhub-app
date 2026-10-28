import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStorageOverview } from "../src/lib/storage-overview.ts";

const name = (slug: string) => slug.split("/").pop() ?? slug;

test("storage overview: totals only known sizes, counts unknown separately", () => {
  const o = buildStorageOverview(
    [
      { slug: "a/one", sizeBytes: 100, hasCache: true },
      { slug: "a/two", sizeBytes: 0, hasCache: false },
      { slug: "a/three", sizeBytes: 50, hasCache: true },
    ],
    name,
  );
  assert.equal(o.repoCount, 3);
  assert.equal(o.knownCount, 2);
  assert.equal(o.unknownCount, 1);
  assert.equal(o.totalBytes, 150);
  assert.equal(o.cacheRepos, 2);
});

test("storage overview: top is size-desc, ties by slug, capped", () => {
  const o = buildStorageOverview(
    [
      { slug: "a/b", sizeBytes: 10, hasCache: false },
      { slug: "a/a", sizeBytes: 10, hasCache: false },
      { slug: "a/c", sizeBytes: 30, hasCache: false },
    ],
    name,
    2,
  );
  assert.deepEqual(o.top.map((r) => r.slug), ["a/c", "a/a"]);
});

test("storage overview: negative/NaN sizes become unknown, never subtract", () => {
  const o = buildStorageOverview(
    [
      { slug: "a/x", sizeBytes: -5, hasCache: false },
      { slug: "a/y", sizeBytes: Number.NaN, hasCache: false },
    ],
    name,
  );
  assert.equal(o.totalBytes, 0);
  assert.equal(o.unknownCount, 2);
});
