/**
 * Recently used clone branches (r27-N1).
 *
 * The datalist is convenience only; the rules that matter are that a malformed
 * storage payload degrades to an empty list, the cap holds, and a failed write
 * never blocks the download.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRANCH_RECENT_CAP,
  BRANCH_RECENT_KEY,
  parseBranches,
  readBranches,
  rememberBranch,
} from "../src/lib/branch-recent.ts";

function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

test("parseBranches: malformed / non-array / non-string rows yield []", () => {
  assert.deepEqual(parseBranches(null), []);
  assert.deepEqual(parseBranches("{oops"), []);
  assert.deepEqual(parseBranches('{"a":1}'), []);
  assert.deepEqual(parseBranches('[1, null, {}, "  ", "-evil", "ok/x", "ok/x"]'), ["ok/x"]);
});

test("rememberBranch: newest first, deduped, capped", () => {
  const s = fakeStorage();
  for (let i = 0; i < BRANCH_RECENT_CAP + 3; i += 1) rememberBranch(`feature/${i}`, s);
  const list = readBranches(s);
  assert.equal(list.length, BRANCH_RECENT_CAP);
  assert.equal(list[0], `feature/${BRANCH_RECENT_CAP + 2}`);

  const again = rememberBranch("feature/5", s);
  assert.equal(again[0], "feature/5");
  assert.equal(again.filter((x) => x === "feature/5").length, 1);
  assert.equal(new Set(again).size, again.length);
});

test("a broken storage never throws and never blocks a download", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.deepEqual(readBranches(broken), []);
  assert.deepEqual(rememberBranch("main", broken), ["main"], "the in-memory result still returns; only persistence failed");
  assert.equal(BRANCH_RECENT_KEY.includes("branches"), true);
});

test("queue 与重启恢复都保留所选分支", async () => {
  const { captureRecovered, parseRecovered } = await import("../src/lib/download-recovery.ts");
  const { useDownloads } = await import("../src/store/downloads.ts");
  useDownloads.setState({ tasks: [], maxParallel: 0 });
  useDownloads.getState().add("o/r", "manual", undefined, false, "feature/x");
  assert.equal(useDownloads.getState().tasks[0]?.branch, "feature/x");
  const rows = captureRecovered(useDownloads.getState().tasks);
  assert.equal(rows[0]?.branch, "feature/x");
  assert.equal(parseRecovered(JSON.stringify({ version: 1, tasks: rows }))[0]?.branch, "feature/x");
});

test("添加页/项目设置/队列的接线形状", async () => {
  const { readFileSync } = await import("node:fs");
  const add = readFileSync("src/views/AddRepoView.tsx", "utf8");
  assert.match(add, /readBranches\(\)/);
  assert.match(add, /rememberBranch\(branchName\)/);
  assert.match(add, /id="add-branch-input"/);
  assert.match(add, /onDownload\(term, "添加页", targetOverride \|\| undefined, overwrite, branchName \|\| undefined\)/);
  const psd = readFileSync("src/dialogs/ProjectSettingsDialog.tsx", "utf8");
  assert.match(psd, /t\("psd\.branchTitle"\)/);
  assert.match(psd, /detail\.branch/);
  const queue = readFileSync("src/components/DownloadQueue.tsx", "utf8");
  assert.match(queue, /addTask\(task\.ref, task\.source, task\.targetDir, task\.overwrite, task\.branch\)/);
});
