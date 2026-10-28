/**
 * The 常用 page's ranking arithmetic (`src/lib/usage-score.ts`) — the `score`
 * formula and the two ranking passes that used to live in `views/FrequentView.tsx`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  repoScoreBySlug,
  topSettingUsage,
  usageScore,
  usageScoreDay,
  type UsageEntry,
} from "../src/lib/usage-score.ts";
import { at } from "./helpers/definite.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

test("usageScore:今天用过一次胜过上个月用过五次", () => {
  const today: UsageEntry = { count: 1, last: NOW };
  const lastMonth: UsageEntry = { count: 5, last: NOW - 30 * DAY };
  assert.equal(usageScore(today, NOW), 1);
  assert.equal(usageScore(lastMonth, NOW), 5 / 31);
  assert.ok(usageScore(today, NOW) > usageScore(lastMonth, NOW));
});

test("usageScore:衰减按天连续，昨天的权重是一半", () => {
  assert.equal(usageScore({ count: 4, last: NOW - DAY }, NOW), 2);
  assert.equal(usageScore({ count: 4, last: NOW - 3 * DAY }, NOW), 1);
});

test("usageScore:未来的 last 被夹到 0 天，不会让陈旧项反超", () => {
  // A clock skew or a hand-edited file could carry `last > now`; without the
  // clamp the denominator goes below 1 and the stale row outranks a fresh one.
  assert.equal(usageScore({ count: 3, last: NOW + 10 * DAY }, NOW), 3, "daysAgo 夹到 0");
});

test("usageScoreDay:按天的桶，同一天内不变", () => {
  assert.equal(usageScoreDay(NOW), Math.floor(NOW / DAY));
  assert.equal(usageScoreDay(NOW + 1), usageScoreDay(NOW), "同一整天两次渲染同桶");
  assert.notEqual(usageScoreDay(NOW + DAY), usageScoreDay(NOW));
});

test("repoScoreBySlug:只认 repo: 行，剥前缀，保序", () => {
  const usage = {
    "setting:debounce": { count: 9, last: NOW },
    "repo:b": { count: 1, last: NOW - DAY },
    "repo:a": { count: 2, last: NOW },
  };
  const scores = repoScoreBySlug(usage, NOW);
  assert.deepEqual([...scores.keys()], ["b", "a"], "顺序是 usage 表自己的键序");
  assert.equal(scores.get("a"), 2);
  assert.equal(scores.get("b"), 0.5);
  assert.equal(scores.has("debounce"), false, "设置行不该混进仓库榜");
});

test("topSettingUsage:只认 setting: 行，按命中数降序，截到上限", () => {
  const usage = {
    "repo:x": { count: 99, last: NOW },
    "setting:b": { count: 1, last: NOW },
    "setting:a": { count: 7, last: NOW },
    "setting:c": { count: 3, last: NOW },
  };
  const out = topSettingUsage(usage, 2);
  assert.deepEqual(out, [
    { key: "a", hits: 7 },
    { key: "c", hits: 3 },
  ]);
  assert.equal(at(out, 0).key, "a", "前缀被剥到只剩「设置目录」需要的 id");
});
