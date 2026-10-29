/**
 * 项目设置的存储占用面板（r28-N4）。
 *
 * The arithmetic is Rust-tested; this pins the IPC name and the four buckets
 * being rendered, so a renamed command or a dropped row cannot silently turn the
 * panel into an empty box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { tFor } from "../src/lib/i18n.ts";

const PANEL = readFileSync("src/components/RepoStoragePanel.tsx", "utf8");
const DIALOG = readFileSync("src/dialogs/ProjectSettingsDialog.tsx", "utf8");

test("RepoStoragePanel: invokes the command and renders all buckets", () => {
  assert.match(PANEL, /invoke<StorageBreakdown>\("repo_storage_breakdown", \{ slug \}\)/);
  for (const key of ["totalBytes", "repoBytes", "cacheBytes", "venvBytes", "worktreesBytes"]) {
    assert.ok(PANEL.includes(key), key);
  }
  assert.match(DIALOG, /<RepoStoragePanel slug=\{slug\} \/>/);
});

test("storage panel copy is paired in zh/en", () => {
  assert.equal(tFor("zh-CN", "repoStorage.title"), "存储占用");
  assert.equal(tFor("en", "repoStorage.title"), "Storage usage");
  assert.equal(tFor("zh-CN", "repoStorage.cache"), "可清理缓存（含在仓库目录内）");
  assert.equal(tFor("en", "repoStorage.cache"), "Clearable cache (inside the repository)");
});
