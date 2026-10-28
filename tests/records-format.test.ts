/**
 * The pure formatters in `src/views/records/format.ts` — how one 记录 row
 * decides its group, its title, and the words it prints for a target, a value
 * and a timestamp. Every branch here has been a drift site: two surfaces used
 * to render the same setting with different names, and the raw storage key
 * (`config.projectRoot`) used to leak into the title line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  displayTarget,
  displayValue,
  formatTime,
  groupKeyOf,
  groupLabelOf,
  retentionPhrase,
} from "../src/views/records/format.ts";
import { fmtAgo } from "../src/lib/format.ts";
import { t as zh } from "../src/lib/i18n.ts";

test("groupKeyOf: target beats slug, and an untargeted record groups by id", () => {
  assert.equal(groupKeyOf({ tag: "设置", target: "config.projectRoot", id: "1" }), "设置:config.projectRoot");
  assert.equal(groupKeyOf({ tag: "下载", slug: "github.com/a/b", id: "2" }), "下载:github.com/a/b");
  // Neither target nor slug: its own single group, never an empty key.
  assert.equal(groupKeyOf({ tag: "外观", id: "3" }), "single:3");
});

test("groupLabelOf: the action alone, or action · 中文 target", () => {
  assert.equal(groupLabelOf({ action: "已移除", target: undefined }), "已移除");
  assert.equal(
    groupLabelOf({ action: "启用", target: "config.mirrorEnabled" }),
    "启用 · 第三方镜像",
  );
});

test("displayTarget: known keys print their catalog name, unknown keys keep the namespace", () => {
  assert.equal(displayTarget("config.searchDebounceMs"), "搜索停顿时间");
  assert.equal(displayTarget("ui.theme"), "深浅色");
  // An unknown key prints the WHOLE target, namespace included — `font` alone
  // could be either an appearance or a config key, so stripping it made the
  // two surfaces degrade into different uninterpretable words.
  assert.equal(displayTarget("config.notARealKey"), "config.notARealKey");
  assert.equal(displayTarget("ui.notARealKey"), "ui.notARealKey");
  assert.equal(displayTarget("bareKey"), "bareKey");
});

test("displayTarget: the four non-config namespaces", () => {
  assert.equal(displayTarget("launch.steps:github.com/a/b"), "github.com/a/b");
  assert.equal(displayTarget("launch.command:npm run dev"), "npm run dev");
  assert.equal(displayTarget("process:4242"), "PID 4242");
  assert.equal(displayTarget("activity.download"), "操作记录");
});

test("displayValue: ui.* values go through the appearance describer, others pass", () => {
  assert.equal(displayValue(undefined, "raw"), "raw");
  assert.equal(displayValue("config.parallelDownloads", "3"), "3");
  assert.equal(displayValue("ui.theme", "light"), "浅色");
  assert.equal(displayValue("ui.recordTimeFormat", "hm"), "时分");
  assert.equal(displayValue("ui.gridColumns", "0"), "自动");
});

test("retentionPhrase: only zero is 永久", () => {
  // r17-n1-1: the wording moved into the dictionary; the rule is still this
  // function's, so the assertion drives it with the real (zh-CN) translator.
  assert.equal(retentionPhrase(0, zh), "永久");
  assert.equal(retentionPhrase(30, zh), "30 天");
  // Pinned: a negative (a corrupt config) is NOT special-cased into 永久.
  assert.equal(retentionPhrase(-1, zh), "-1 天");
});

test("formatTime: hm and full are fixed-width, local-time renderings", () => {
  // Built in local time so the assertion does not depend on this machine's zone.
  const ts = Math.floor(new Date(2026, 0, 15, 14, 20, 30).getTime() / 1000);
  assert.equal(formatTime(ts, "hm"), "14:20");
  assert.equal(formatTime(ts, "full"), "2026-01-15 14:20:30");
  // The default register: a day other than today keeps the date prefix. Year
  // 2000 so the "same day" branch can never accidentally be taken.
  const otherDay = Math.floor(new Date(2000, 0, 15, 4, 5, 6).getTime() / 1000);
  assert.equal(formatTime(otherDay, "hms"), "01-15 04:05:06");
});

test("formatTime: the default register says time-only for a timestamp of today", () => {
  const now = Math.floor(Date.now() / 1000);
  // The two `new Date()` calls inside formatTime and here are milliseconds
  // apart; crossing midnight between them would flip the branch, which is the
  // same race every same-day check in this app already accepts.
  assert.match(formatTime(now, "hms"), /^\d{2}:\d{2}:\d{2}$/);
});

test("formatTime: relative delegates to the shared ladder, never invents units", () => {
  const ts = Math.floor(new Date(2026, 0, 15, 14, 20, 30).getTime() / 1000);
  assert.equal(formatTime(ts, "relative"), fmtAgo(ts * 1000));
});
