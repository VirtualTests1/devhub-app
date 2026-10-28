/**
 * `store/downloads.ts` 必须真的调用上界函数，而且是在「新增」与「结束」两个入口。
 * 纯函数测试只能证明规则对；这里钉住接线，避免规则写好却没人用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STORE = readFileSync("src/store/downloads.ts", "utf8");

test("接线: add 用 boundQueueTasks 包住新数组", () => {
  assert.match(STORE, /import \{ boundQueueTasks \} from "\.\.\/lib\/queue-retention"/);
  assert.match(STORE, /tasks: boundQueueTasks\(\[task, \.\.\.s\.tasks\]\)/);
});

test("接线: finish 用 keep:id 保留刚改变状态的那一行", () => {
  assert.match(STORE, /tasks: boundQueueTasks\(tasks, \{ keep: id \}\)/);
});
