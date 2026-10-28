/**
 * 恢复数据只有在 store 真的读/写它时才有效：启动读一次、四个变更入口写、退出再写一次。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STORE = readFileSync("src/store/downloads.ts", "utf8");
const MAIN_HOOKS = ["beforeunload", "pagehide"];

test("接线: 初始化用 recoveredTasks()，并从 takeRecovered() 读一次", () => {
  assert.match(STORE, /import \{[\s\S]*?takeRecovered[\s\S]*?\} from "\.\.\/lib\/download-recovery"/);
  assert.match(STORE, /function recoveredTasks\(\): DownloadTask\[\] \{[\s\S]*?takeRecovered\(\)/);
  assert.match(STORE, /tasks: recoveredTasks\(\)/);
  assert.match(STORE, /status: "failed" as const/);
  assert.match(STORE, /interrupted: true/);
});

test("接线: add/finish/dismiss/clearFinished 都持久化；退出时再 flush", () => {
  const occurrences = STORE.match(/persistRecovery\(get\(\)\.tasks\)/g) ?? [];
  assert.ok(occurrences.length >= 4, `expected >=4 mutation calls, got ${occurrences.length}`);
  for (const ev of MAIN_HOOKS) {
    assert.ok(STORE.includes(`addEventListener("${ev}", flushRecovery)`), `missing ${ev} flush`);
  }
});
