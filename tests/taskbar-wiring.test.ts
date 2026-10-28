/**
 * `useTaskbarProgress` + capability — the two things that can make the bar silently
 * never appear: the hook not being mounted, or the ACL refusing the IPC.
 *
 * `core:window:default` does not contain `allow-set-progress-bar` (verified from
 * `src-tauri/gen/schemas/acl-manifests.json` during r24-R2), so the capability
 * grant is part of the feature, not boilerplate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = readFileSync("src/App.tsx", "utf8");
const HOOK = readFileSync("src/lib/use-taskbar-progress.ts", "utf8");
const MAP = readFileSync("src/lib/taskbar-progress.ts", "utf8");
const CAP = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as {
  permissions: string[];
};

test("接线: 根组件挂载一次，订阅整个下载 store（不是某个页面）", () => {
  assert.match(APP, /import \{ useTaskbarProgress \} from "\.\/lib\/use-taskbar-progress"/);
  assert.match(APP, /useTaskbarProgress\(\);/);
  assert.match(HOOK, /useDownloads\.subscribe\(\(state\) => apply\(state\.tasks\)\)/);
  assert.match(HOOK, /apply\(useDownloads\.getState\(\)\.tasks\)/, "挂载时先对齐当前队列");
  assert.match(HOOK, /void win\.setProgressBar\(\{ status: ProgressBarStatus\.None \}\)/, "卸载时清掉，别留下一个冻结的进度条");
});

test("接线: 百分比来自共享解析器，节流来自纯函数，失败不打扰用户", () => {
  assert.match(MAP, /import \{ parseGitProgress \} from "\.\/download-rate"/);
  assert.match(MAP, /percent: parseGitProgress\(task\.progress\?\.message\)\.percent/);
  assert.match(HOOK, /shouldPushTaskbar\(last, next, now, lastAt\)/);
  assert.match(HOOK, /\.catch\(\(\) => \{/);
});

test("权限: capability 显式授予 set-progress-bar（默认窗口集不含它）", () => {
  assert.ok(CAP.permissions.includes("core:window:allow-set-progress-bar"));
});
