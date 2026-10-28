/**
 * `src/views/records/constants.ts` — 记录页筛选器的取值表（此前整个模块无人 import）。
 *
 * 这不是「测常量等于自己」。每一项都钉的是**别处的文件对这张表的假设**，两边一旦
 * 各改各的就在这里红：
 *   - `TAGS` 去掉 "all" 后必须恰好等于 `types.ts` 的 `ACTIVITY_TAG_LABEL` 键集——
 *     后端写记录 tag、类型表给 tag 配中文、这张表给筛选 chip 列 tag，是三处独立维护。
 *   - `RANGES` 的秒数要与 id 的 d 数对得上，防 `7d` 被写成 `6*86400` 这类复制错。
 *   - `CLEANUP_LABEL` 的键要覆盖 `lib.rs:cleanup_phrase` 认的那几种 mode。
 *   - `RETENTIONS` 必须含 0（"永久/不限" 那个特殊值，保留时长逻辑对它单独分支）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLEANUP_LABEL,
  RANGES,
  RECORDS_GROUP_PAGE,
  RECORDS_SEARCH_DEBOUNCE_MS,
  RETENTIONS,
  TAGS,
  TIME_FORMAT_LABEL,
} from "../src/views/records/constants.ts";
import { ACTIVITY_TAG_LABEL } from "../src/types.ts";

test("TAGS 与 types.ts 的 ACTIVITY_TAG_LABEL：每个 chip 都有中文标签；钉住现状里的漏项", () => {
  const tagIds = TAGS.map((t) => t.id);
  assert.equal(tagIds[0], "all", "第一个 chip 必须是「全部」哨兵");
  for (const t of TAGS) assert.ok(t.label.length > 0, `chip ${t.id} 不能没有 label`);
  // 渲染安全的那半边不变式：每个筛选 chip 都得能在标签表里找到词，否则选中它后
  // 记录行会显示裸 tag id。
  for (const id of tagIds.slice(1)) {
    assert.ok(ACTIVITY_TAG_LABEL[id], `chip ${id} 在 ACTIVITY_TAG_LABEL 里没有对应中文标签`);
  }
  // 反向不成立——如实钉下来，别让读者以为两边一一对应。当前 ACTIVITY_TAG_LABEL 比
  // 筛选 chip 多一个 "update"：后端会给记录打「更新」标签，但记录页筛选行没有「更新」
  // 这一档，update 事件只能靠「全部」筛。列出所有「有标签、无 chip」的 tag，一旦
  // 又加了一个没配 chip 的 tag，这里会精确报出来，提示要么补 chip 要么补筛选逻辑。
  const labelOnly = Object.keys(ACTIVITY_TAG_LABEL).filter((k) => !tagIds.includes(k)).sort();
  assert.deepEqual(labelOnly, ["update"], "已知漏项：update 有标签却无 chip。若这是有意为之可更新此断言；若新增别的漏项则是回归。");
});

test("RANGES：id 的天数与 seconds 字段逐项对得上", () => {
  const byId = Object.fromEntries(RANGES.map((r) => [r.id, r.seconds]));
  assert.equal(byId.all, 0, "「不限时间」= 0 秒，表示不设时间窗");
  assert.equal(byId["1d"], 86_400);
  assert.equal(byId["7d"], 7 * 86_400);
  assert.equal(byId["30d"], 30 * 86_400);
  assert.equal(byId["90d"], 90 * 86_400);
  assert.equal(RANGES.length, 5, "档位数量是筛选行布局的一部分");
});

test("RETENTIONS 含 0（永久/不限那个被保留逻辑单独分支的值）", () => {
  assert.deepEqual([...RETENTIONS].sort((a, b) => a - b), [0, 7, 30, 90]);
  assert.ok(RETENTIONS.includes(0), "0 是「永久保留」哨位，缺了它保留时长选择器少一档");
});

test("CLEANUP_LABEL 覆盖 lib.rs cleanup_phrase 认的每一种 mode", () => {
  // `cleanup_phrase` 分支 "daily"/"weekly"/"monthly"，其余落到 "手动"。前端这张表
  // 的键必须正好是 {manual, daily, weekly, monthly}，否则设置页会缺一个中文词。
  assert.deepEqual(Object.keys(CLEANUP_LABEL).sort(), ["daily", "manual", "monthly", "weekly"]);
  for (const v of Object.values(CLEANUP_LABEL)) assert.ok(v.length > 0, "清理频率不能有空 label");
});

test("TIME_FORMAT_LABEL 覆盖记录页会读的四档时间格式", () => {
  assert.deepEqual(Object.keys(TIME_FORMAT_LABEL).sort(), ["full", "hm", "hms", "relative"]);
});

test("两个调优旋钮：本地去抖 150ms、分组每屏 30 组", () => {
  // 这两个数是「筛选重跑的安静期」和「显示更多之前的分组上限」，被 auto-animate 与
  // 分组渲染间接依赖；钉住它们让一次顺手改成 50/200 变成一次有意识的编辑。
  assert.equal(RECORDS_SEARCH_DEBOUNCE_MS, 150);
  assert.equal(RECORDS_GROUP_PAGE, 30);
});
