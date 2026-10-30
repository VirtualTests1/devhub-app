import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderableGroups,
  stepHitIndex,
  summarizeBatch,
  type GrepBatchResult,
} from "../src/lib/grep-batch";

function result(partial: Partial<GrepBatchResult> = {}): GrepBatchResult {
  return {
    pattern: "x",
    groups: [],
    totalHits: 0,
    filesScanned: 0,
    filesSkipped: 0,
    elapsedMs: 1,
    truncated: false,
    timedOut: false,
    repositoriesSkipped: 0,
    error: null,
    ...partial,
  };
}

function group(slug: string, hits: number, error: string | null = null) {
  return {
    slug,
    root: `D:/container/${slug}`,
    filesScanned: 1,
    filesSkipped: 0,
    hits: Array.from({ length: hits }, (_, i) => ({ file: "a.ts", line: i + 1, content: "x" })),
    error,
  };
}

test("summary separates scanned, hit, and failed repositories", () => {
  const s = summarizeBatch(
    result({
      groups: [group("a/one", 2), group("b/two", 0), group("c/missing", 0, "未找到仓库")],
      totalHits: 2,
      filesScanned: 3,
    }),
  );
  assert.equal(s.hitRepos, 1);
  assert.equal(s.scannedRepos, 2);
  assert.equal(s.failedRepos, 1);
  assert.equal(s.totalHits, 2);
  assert.equal(s.partial, false);
});

test("any cap or timeout marks the answer partial", () => {
  assert.equal(summarizeBatch(result({ truncated: true })).partial, true);
  assert.equal(summarizeBatch(result({ timedOut: true })).partial, true);
  assert.equal(summarizeBatch(result({ repositoriesSkipped: 3 })).partial, true);
});

test("clean zero-hit repositories are counted, not rendered as rows", () => {
  const { shown, hiddenGroups } = renderableGroups(
    result({ groups: [group("a/one", 0), group("b/two", 3)] }),
  );
  assert.deepEqual(shown.map((g) => g.slug), ["b/two"]);
  assert.equal(hiddenGroups, 0);
  assert.equal(shown[0]?.hiddenHits, 0);
});

test("render caps count what they hide", () => {
  const many = result({
    groups: [group("a/one", 25), ...Array.from({ length: 25 }, (_, i) => group(`x/r${i}`, 1))],
  });
  const { shown, hiddenGroups } = renderableGroups(many, 20, 10);
  assert.equal(shown.length, 20);
  assert.equal(hiddenGroups, 6);
  assert.equal(shown[0]?.hits.length, 10);
  assert.equal(shown[0]?.hiddenHits, 15);
});

test("a per-repository error is rendered even with zero hits", () => {
  const { shown } = renderableGroups(result({ groups: [group("a/missing", 0, "未找到仓库")] }));
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.error, "未找到仓库");
});

test("roving focus enters at an end and clamps rather than wraps", () => {
  assert.equal(stepHitIndex(-1, 1, 3), 0);
  assert.equal(stepHitIndex(-1, -1, 3), 2);
  assert.equal(stepHitIndex(0, 1, 3), 1);
  assert.equal(stepHitIndex(2, 1, 3), 2, "down at the last row stays");
  assert.equal(stepHitIndex(0, -1, 3), 0, "up at the first row stays");
  assert.equal(stepHitIndex(0, 1, 0), -1);
});
