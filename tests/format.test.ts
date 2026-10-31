/**
 * Characterization tests for the shared formatters in `src/lib/format.ts`.
 *
 * These pin what the code does *today* — including the questionable corners —
 * so a later change is a deliberate edit of this file, not an unnoticed drift.
 * `formatBytes` is additionally pinned through its `types.ts` re-export in
 * `tests/types-format.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatBytes,
  fmtAgo,
  fmtDate,
  fmtDateTime,
  fmtElapsed,
  fmtTime,
  formatNumber,
  fmtRelative,
  getFormatLocale,
  pad2,
  setFormatLocale,
} from "../src/lib/format.ts";

test("formatBytes: byte tier", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(999), "999 B");
  // Threshold is 1024, not 1000 — pinned because 清理 reports freed space.
  assert.equal(formatBytes(1000), "1000 B");
  assert.equal(formatBytes(1023), "1023 B");
});

test("formatBytes: KB/MB/GB tiers", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
});

test("formatBytes: negative and non-finite fall through tiers", () => {
  // `n < 1024` is true for all negatives; NaN/Infinity make every `<` false.
  assert.equal(formatBytes(-1), "-1 B");
  assert.equal(formatBytes(-1024 * 1024), "-1048576 B");
  assert.equal(formatBytes(Number.NaN), "NaN GB");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "Infinity GB");
});

test("fmtElapsed: 毫秒 / 秒 / 分 / 小时", () => {
  assert.equal(fmtElapsed(500), "500 毫秒");
  assert.equal(fmtElapsed(1000), "1 秒");
  // 60 000 ms is exactly 1 minute, so it lands in the 分 branch, not 小时.
  assert.equal(fmtElapsed(60000), "1 分 00 秒");
  assert.equal(fmtElapsed(3600000), "1 小时 00 分");
});

test("fmtElapsed: the four surfaces that show it agree on one string", () => {
  // The round-12 audit found 15 min rendering as `15 分 00 秒` in 启动对话框 and
  // `15 分 0 秒` in 状态栏 at the same moment. One contract, pinned per tier.
  assert.equal(fmtElapsed(15 * 60_000), "15 分 00 秒");
  // Sub-second keeps the 毫秒 tier: `RunStatus` reads it as "the shell returned
  // immediately", where `0 秒` would say nothing.
  assert.equal(fmtElapsed(400), "400 毫秒");
  assert.equal(fmtElapsed(999), "999 毫秒");
  assert.equal(fmtElapsed(59_000), "59 秒");
  assert.equal(fmtElapsed(59 * 60_000 + 59_000), "59 分 59 秒");
  assert.equal(fmtElapsed(2 * 3_600_000 + 5 * 60_000), "2 小时 05 分");
});

test("fmtElapsed: zero, negatives and junk clamp instead of printing a fake age", () => {
  // A clock jump between `startedAt` and now can hand this a negative.
  assert.equal(fmtElapsed(0), "0 毫秒");
  assert.equal(fmtElapsed(-500), "0 毫秒");
  assert.equal(fmtElapsed(-90_000), "0 毫秒");
  assert.equal(fmtElapsed(Number.NaN), "0 毫秒");
  // Fractional input is floored, never printed as `400.5 毫秒`.
  assert.equal(fmtElapsed(400.7), "400 毫秒");
});

test("formatNumber delegates to toLocaleString", () => {
  assert.equal(formatNumber(42), "42");
  assert.equal(formatNumber(1234567), (1234567).toLocaleString());
});

test("fmtRelative: 刚刚 / 分钟前 / 小时前 / 天前", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(fmtRelative(0, now), "刚刚");
  assert.equal(fmtRelative(now - 1000, now), "刚刚");
  assert.equal(fmtRelative(now - 5 * 60000, now), "5 分钟前");
  assert.equal(fmtRelative(now - 3 * 3600000, now), "3 小时前");
  assert.equal(fmtRelative(now - 2 * 86400000, now), "2 天前");
});

// The three sites this ladder replaced each had a defensible reason for its own
// wording. Pinning all three registers is what lets the arithmetic be one copy:
// the ladder is shared, the *choice of register* is explicit per surface.
test("fmtAgo: the 记录 register (45 秒前 … 43 天前)", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(fmtAgo(now - 45_000, now), "45 秒前");
  assert.equal(fmtAgo(now - 59_000, now), "59 秒前");
  // A whole minute is already 分钟前 — the 秒 tier never says `0 秒前`.
  assert.equal(fmtAgo(now - 60_000, now), "1 分钟前");
  assert.equal(fmtAgo(now - 3_599_000, now), "59 分钟前");
  assert.equal(fmtAgo(now - 3_600_000, now), "1 小时前");
  assert.equal(fmtAgo(now - 86_399_000, now), "23 小时前");
  assert.equal(fmtAgo(now - 86_400_000, now), "1 天前");
  assert.equal(fmtAgo(now - 43 * 86_400_000, now), "43 天前");
});

test("fmtAgo: the 同步面板 register trades the seconds tier for 刚刚", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const justNow = { subMinute: "justNow" } as const;
  assert.equal(fmtAgo(now - 45_000, now, justNow), "刚刚");
  assert.equal(fmtAgo(now - 59_999, now, justNow), "刚刚");
  assert.equal(fmtAgo(now - 60_000, now, justNow), "1 分钟前");
  // Above a minute the two registers are the same words, byte for byte.
  assert.equal(fmtAgo(now - 43 * 86_400_000, now, justNow), fmtRelative(now - 43 * 86_400_000, now));
});

test("fmtAgo: the 项目墙 register trades 天前 for an absolute stamp", () => {
  // Built in local time so the assertion does not depend on this machine's zone.
  const stamp = new Date(2026, 7, 12, 14, 20).getTime();
  const dateAfterDay = { pastDay: "date" } as const;
  assert.equal(fmtAgo(stamp, stamp + 86_400_000, dateAfterDay), "2026-08-12 14:20");
  assert.equal(fmtAgo(stamp, stamp + 40 * 86_400_000, dateAfterDay), "2026-08-12 14:20");
  // Inside a day it stays relative — that is the tier the card asks about.
  assert.equal(fmtAgo(stamp, stamp + 3 * 3_600_000, dateAfterDay), "3 小时前");
  assert.equal(fmtAgo(stamp, stamp + 86_399_000, dateAfterDay), "23 小时前");
  assert.equal(fmtAgo(stamp, stamp + 45_000, dateAfterDay), "45 秒前");
});

test("fmtAgo: a future timestamp is not a negative age", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(fmtAgo(now + 90_000, now), "0 秒前");
  assert.equal(fmtAgo(now + 90_000, now, { subMinute: "justNow" }), "刚刚");
});

test("fmtElapsed / fmtAgo follow the interface language, not the OS locale", () => {
  const previous = getFormatLocale();
  const now = Date.parse("2026-01-02T00:00:00Z");
  try {
    setFormatLocale("en");
    assert.equal(fmtElapsed(500), "500 ms");
    assert.equal(fmtElapsed(1000), "1 s");
    assert.equal(fmtElapsed(60_000), "1 min 00 s");
    assert.equal(fmtElapsed(2 * 3_600_000 + 5 * 60_000), "2 h 05 min");
    assert.equal(fmtAgo(now - 45_000, now), "45s ago");
    assert.equal(fmtAgo(now - 5 * 60_000, now), "5 min ago");
    assert.equal(fmtAgo(now - 3 * 3_600_000, now), "3 h ago");
    assert.equal(fmtAgo(now - 2 * 86_400_000, now), "2 d ago");
    assert.equal(fmtRelative(0, now), "just now");
    assert.equal(formatNumber(1234567), "1,234,567");
  } finally {
    setFormatLocale(previous);
  }
  assert.equal(fmtElapsed(500), "500 毫秒");
});

test("date helpers use the app language, replacing OS-locale toLocaleString", () => {
  const previous = getFormatLocale();
  // Local components on purpose: the formatter renders local time, so this does
  // not depend on the machine's timezone.
  const stamp = new Date(2026, 7, 12, 14, 20, 5).getTime();
  try {
    setFormatLocale("en");
    assert.equal(fmtDate(stamp), "08/12/2026");
    assert.equal(fmtTime(stamp), "02:20:05 PM");
    assert.equal(fmtDateTime(stamp), "08/12/2026, 02:20:05 PM");
    setFormatLocale("zh-CN");
    assert.equal(fmtDate(stamp), "2026/08/12");
    assert.equal(fmtTime(stamp), "14:20:05");
    assert.equal(fmtDateTime(stamp), "2026/08/12 14:20:05");
    assert.equal(fmtDate(Number.NaN), "Invalid Date");
  } finally {
    setFormatLocale(previous);
  }
});

test("pad2: the two-digit register everything else borrows", () => {
  assert.equal(pad2(0), "00");
  assert.equal(pad2(9), "09");
  assert.equal(pad2(59), "59");
  assert.equal(pad2(100), "100");
});

