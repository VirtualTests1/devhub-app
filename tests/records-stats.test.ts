/**
 * 记录页统计纯函数（r19-N1-1）的表征测试。
 *
 * 三条性质各钉一处，都是「改错了但界面照常渲染」的那类：
 *
 *   1. `localDayKey` 用**本地日**——UTC 实现会让东半球的凌晨归到前一天，
 *      面板上的「今天」和用户过的那天错开。
 *   2. 并列名次按**标识码点**，不靠 `localeCompare`——同一份数据在不同
 *      语言环境的机器上必须排出同一个顺序。
 *   3. `topRepos` 跳过**没有 slug** 的条目，且 `limit <= 0` 是「要零条」。
 *
 * 时间戳一律从本地组件构造（`localDay`），测试本身不依赖运行机器的时区。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  entriesByDay,
  entriesByTag,
  localDayKey,
  topRepos,
  type StatsEntry,
} from "../src/lib/records-stats.ts";

/** 某天 00:00:00 **本地时间**的 unix 秒——任何时区下都是当天的起点。 */
function localDay(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000);
}

const entry = (ts: number, tag: string, slug?: string): StatsEntry => ({ ts, tag, slug });

// ---------------------------------------------------------------------------
// 1. 本地日

test("localDayKey: 本地日历日，零填充，排序即时间序", () => {
  assert.equal(localDayKey(localDay(2026, 1, 1) + 30), "2026-01-01");
  assert.equal(localDayKey(localDay(2026, 3, 5)), "2026-03-05", "月与日都补零");
  assert.equal(localDayKey(localDay(2026, 12, 31)), "2026-12-31");
});

test("localDayKey: 钉的是本地日而非 UTC 日", () => {
  // 本地 00:30 在任何东八区时区里 UTC 还是前一天；换成 toISOString 实现在
  // 这类机器上会返回前一天的日期，此断言即红。（UTC 以西的机器上两种实现
  // 同结果，这条在那里是空转——时区属性决定它能在哪半边机器上抓错。）
  const justAfterMidnight = localDay(2026, 1, 1) + 30 * 60;
  assert.equal(localDayKey(justAfterMidnight), "2026-01-01");
});

test("entriesByDay: 同一天折叠，跨本地午夜分家，空表空列表", () => {
  assert.deepEqual(entriesByDay([]), []);
  const d1 = localDay(2026, 1, 1);
  const d2 = localDay(2026, 1, 2);
  const days = entriesByDay([
    entry(d1 + 10, "download"),
    entry(d1 + 20, "launch"),
    entry(d2 + 5, "download"),
  ]);
  assert.deepEqual(days, [
    { day: "2026-01-01", count: 2 },
    { day: "2026-01-02", count: 1 },
  ]);
  // 一秒之隔跨过午夜也是两条——「今天」的边界由用户的日历决定，不由调用时刻决定。
  const straddle = entriesByDay([entry(d2 - 1, "download"), entry(d2, "launch")]);
  assert.deepEqual(straddle.map((d) => d.day), ["2026-01-01", "2026-01-02"]);
});

test("entriesByDay: 安静的日子不占位，条与条之间可以有洞", () => {
  const days = entriesByDay([entry(localDay(2026, 1, 1), "download"), entry(localDay(2026, 1, 3), "launch")]);
  assert.deepEqual(days, [
    { day: "2026-01-01", count: 1 },
    { day: "2026-01-03", count: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// 2. 并列名次

test("entriesByTag: 次数降序，并列按标识码点（不靠 localeCompare）", () => {
  const rows = entriesByTag([
    entry(1, "settings"),
    entry(2, "download"),
    entry(3, "download"),
    entry(4, "appearance"),
    entry(5, "appearance"),
  ]);
  assert.deepEqual(rows, [
    { tag: "appearance", count: 2 },
    { tag: "download", count: 2 },
    { tag: "settings", count: 1 },
  ]);
});

test("entriesByTag: 大写与小写是不同标识，码点序把大写排在前", () => {
  // localeCompare 在多数语言环境里会把 "a" 排在 "B" 前；码点序不会（U+0042 < U+0061）。
  const rows = entriesByTag([entry(1, "a"), entry(2, "B")]);
  assert.deepEqual(rows.map((r) => r.tag), ["B", "a"]);
});

// ---------------------------------------------------------------------------
// 3. 仓库榜

test("topRepos: 没有 slug 的条目不进榜，空壳仓库是编造证据", () => {
  const rows = topRepos(
    [entry(1, "settings"), entry(2, "download", "github.com/a/b"), entry(3, "download", "github.com/a/b")],
    5,
  );
  assert.deepEqual(rows, [{ slug: "github.com/a/b", count: 2 }]);
});

test("topRepos: limit 是上限；0 与负数都是零条，不是默认档", () => {
  const entries = [
    entry(1, "download", "github.com/a/one"),
    entry(2, "download", "github.com/a/two"),
    entry(3, "download", "github.com/a/three"),
  ];
  // 三条各一次 → 并列，按 slug 码点：one < three < two（"th" < "tw"）。
  assert.deepEqual(topRepos(entries, 2).map((r) => r.slug), ["github.com/a/one", "github.com/a/three"]);
  assert.deepEqual(topRepos(entries, 99).map((r) => r.slug), [
    "github.com/a/one",
    "github.com/a/three",
    "github.com/a/two",
  ]);
  assert.deepEqual(topRepos(entries, 0), []);
  assert.deepEqual(topRepos(entries, -3), []);
});

test("topRepos: 并列按 slug 码点，同一份输入两次跑出同一顺序", () => {
  const entries = [entry(1, "download", "github.com/z/z"), entry(2, "download", "github.com/a/a")];
  const once = topRepos(entries, 5);
  assert.deepEqual(once.map((r) => r.slug), ["github.com/a/a", "github.com/z/z"]);
  assert.deepEqual(topRepos(entries, 5), once, "纯函数，无隐藏状态");
});

// ---------------------------------------------------------------------------
// 4. 接线：面板是 .tsx，Node 的 runner 加载不了，按本仓既有做法读源码钉结构
//    （同 tests/statusstrip-nesting.test.ts 的路子）。

test("统计面板挂在记录页筛选条之后，没有记录时不渲染", () => {
  const view = readFileSync("src/views/RecordsView.tsx", "utf8");
  assert.match(view, /import \{ StatsPanel \} from "\.\/records\/StatsPanel"/, "面板没被接进视图");
  assert.match(view, /<StatsPanel entries=\{entries\} t=\{t\}/, "渲染调用点变了");
  assert.match(view, /entries && entries\.length > 0 && \(\s*<StatsPanel/, "空历史必须整块不渲染");
});

test("面板的计数全部来自纯函数模块，且登记进元素表", () => {
  const panel = readFileSync("src/views/records/StatsPanel.tsx", "utf8");
  assert.match(panel, /from "\.\.\/\.\.\/lib\/records-stats"/, "统计改了纯函数之外的第二套实现");
  for (const fn of ["entriesByDay", "entriesByTag", "topRepos"]) {
    assert.match(panel, new RegExp(`${fn}\\(`), `${fn} 没被面板使用——接线断了或在别处重算`);
  }
  const elements = readFileSync("src/store/customize.ts", "utf8");
  assert.match(elements, /id: "records-stats-panel"/, "reg() 的 id 必须登记进 ELEMENTS，否则设置→界面里管不了它");
});
