/**
 * `src/lib/freshness-scan.ts` — what a `repo_freshness` answer may be said.
 *
 * The backend computes `state` as `local == remote ? "fresh" : "behind"`
 * (`lib.rs:1342`), so "behind" also covers a local HEAD that is *ahead* and a
 * diverged branch. A wall badge reading 落后于远程 for those would send the user to
 * the one verb (`更新`) that refuses to run — which is why the wording here is
 * "HEAD 不一致" plus the two possible directions, and why an `unknown` answer never
 * collapses into 已是最新. Those two are the assertions that matter; the rest pins
 * the arithmetic behind the summary line, because "一致 30" printed over a
 * 48-project filter is a claim about projects that were never checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRESHNESS_CAP,
  freshnessVerdict,
  planFreshnessScan,
  scanSummaryLine,
  summarizeScan,
  uncheckedNote,
} from "../src/lib/freshness-scan.ts";
import type { Freshness } from "../src/types.ts";

function fresh(of: Partial<Freshness> = {}): Freshness {
  return {
    slug: "github.com/a/b",
    state: "fresh",
    localHead: "a1b2c3d4e5f6",
    remoteHead: "a1b2c3d4e5f6",
    checkedAt: 1,
    error: null,
    ...of,
  };
}

test("freshness verdict: an equal HEAD pair is the only 一致 answer", () => {
  const v = freshnessVerdict(fresh());
  assert.equal(v.tone, "same");
  assert.equal(v.text, "与远程一致");
  assert.match(v.detail, /a1b2c3d/);
});

test("freshness verdict: 不一致 never claims a direction", () => {
  // The whole point. The backend cannot tell 落后 from 领先/分叉, so neither can
  // the surface that reads it.
  const v = freshnessVerdict(fresh({ state: "behind", localHead: "aaaaaaa1", remoteHead: "bbbbbbb2" }));
  assert.equal(v.tone, "diff");
  assert.ok(!v.text.includes("落后"), `text says 落后: ${v.text}`);
  assert.match(v.text, /不一致/);
  assert.match(v.detail, /领先|分叉/);
  // HEADs are shown, so the user can see which one moved.
  assert.match(v.detail, /本地 aaaaaaa/);
  assert.match(v.detail, /远程 bbbbbbb/);
});

test("freshness verdict: a missing local hash is reported, not hidden", () => {
  const v = freshnessVerdict(fresh({ state: "behind", localHead: null, remoteHead: "bbbbbbb2" }));
  assert.equal(v.tone, "diff");
  assert.match(v.detail, /读不到/);
});

test("freshness verdict: unknown / no-git / missing all read as warnings, never as current", () => {
  for (const f of [
    fresh({ state: "unknown", remoteHead: null, error: "暂时连不上远程，无法确认" }),
    fresh({ state: "no-git", localHead: null, remoteHead: null, error: "压缩包下载的仓库没有 git 历史" }),
    fresh({ state: "missing", remoteHead: null, error: "远程仓库不存在或已设为私有" }),
  ]) {
    const v = freshnessVerdict(f);
    assert.equal(v.tone, "warn", f.state);
    assert.ok(!v.text.includes("一致"), `${f.state} → ${v.text}`);
    assert.ok(v.detail.length > 0, `${f.state} gave no reason at all`);
  }
  // The reason survives verbatim when the backend bothered to give one.
  assert.equal(
    freshnessVerdict(fresh({ state: "unknown", error: "暂时连不上远程，无法确认" })).detail,
    "暂时连不上远程，无法确认",
  );
});

test("freshness verdict: an unrecorded state is quoted back, not mapped to a mood", () => {
  const v = freshnessVerdict(fresh({ state: "whatever-the-backend-learned-to-say" }));
  assert.equal(v.tone, "warn");
  assert.equal(v.text, "无法确认");
  assert.match(v.detail, /whatever-the-backend-learned-to-say/);
});

test("planFreshnessScan: splits at the cap and accounts for every card", () => {
  const slugs = Array.from({ length: 48 }, (_, i) => `github.com/a/r${i}`);
  const plan = planFreshnessScan(slugs);
  assert.equal(plan.willCheck.length, FRESHNESS_CAP);
  assert.equal(plan.skipped.length, 48 - FRESHNESS_CAP);
  assert.deepEqual(plan.willCheck, slugs.slice(0, FRESHNESS_CAP));
  assert.deepEqual(plan.skipped, slugs.slice(FRESHNESS_CAP));
});

test("planFreshnessScan: a short list is fully checked; a junk cap checks nothing", () => {
  assert.deepEqual(planFreshnessScan(["a", "b", "c"]), {
    willCheck: ["a", "b", "c"],
    skipped: [],
  });
  assert.deepEqual(planFreshnessScan(["a", "b"], 0), { willCheck: [], skipped: ["a", "b"] });
  assert.deepEqual(planFreshnessScan(["a", "b"], -1), { willCheck: [], skipped: ["a", "b"] });
});

test("scan totals: the summary counts what the rows say, in one pass", () => {
  const rows = [
    { tone: "same" as const },
    { tone: "diff" as const },
    { tone: "warn" as const },
    { tone: "same" as const },
  ];
  assert.deepEqual(summarizeScan(rows), { total: 4, same: 2, diff: 1, warn: 1 });
  assert.equal(scanSummaryLine(summarizeScan(rows)), "一致 2 · 不一致 1 · 无法确认 1");
});

test("unchecked note: the honest sentence about a partial scan", () => {
  assert.equal(uncheckedNote(0), null);
  assert.equal(uncheckedNote(-3), null);
  const note = uncheckedNote(18) ?? "";
  assert.match(note, /18 个项目本次未检查/);
  assert.match(note, new RegExp(String(FRESHNESS_CAP)));
});
