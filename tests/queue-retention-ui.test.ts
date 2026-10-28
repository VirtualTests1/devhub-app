/**
 * 「保留最近 N 条」只有在真的达到上限时才说，避免每一屏都挂一句无关紧要的提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const QUEUE = readFileSync("src/components/DownloadQueue.tsx", "utf8");

test("接线: 只有 tally.finished >= cap 时显示保留提示", () => {
  assert.match(QUEUE, /QUEUE_FINISHED_CAP/);
  assert.match(QUEUE, /tally\.finished >= QUEUE_FINISHED_CAP/);
  assert.match(QUEUE, /t\("queue\.keepHint", \{ n: QUEUE_FINISHED_CAP \}\)/);
});

test("词条: zh/en 成对", () => {
  assert.equal(tFor("zh-CN", "queue.keepHint", { n: 50 }), "已完成行只保留最近 50 条");
  assert.equal(tFor("en", "queue.keepHint", { n: 50 }), "Only the newest 50 finished rows are kept");
});
