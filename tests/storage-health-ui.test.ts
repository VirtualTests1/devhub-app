/**
 * 配额事件必须同时到达屏幕和 console：屏幕一次，console 每次。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const MAIN = readFileSync("src/main.tsx", "utf8");

test("接线: 配额事件过状态机，阈值用 info、写失败用 error", () => {
  assert.match(MAIN, /nextStorageHealth\(storageHealth, event, Date\.now\(\)\)/);
  assert.match(MAIN, /storageHealth = decision\.state/);
  assert.match(MAIN, /toast\.info\(t\("storageHealth\.threshold", \{ mb: megabytes\(event\.bytes\) \}\)\)/);
  assert.match(MAIN, /toast\.error\(t\("storageHealth\.writeError", \{ key: event\.key \}\)\)/);
  assert.match(MAIN, /if \(!decision\.announce\)/, "去重后仍然写 console");
});

test("词条: zh/en 成对", () => {
  assert.match(tFor("zh-CN", "storageHealth.threshold", { mb: 2 }), /约 2 MB/);
  assert.match(tFor("en", "storageHealth.threshold", { mb: 2 }), /about 2 MB/);
  assert.match(tFor("zh-CN", "storageHealth.writeError", { key: "k" }), /「k」/);
  assert.match(tFor("en", "storageHealth.writeError", { key: "k" }), /"k"/);
});
