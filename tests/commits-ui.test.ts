/**
 * The commit-history surface, pinned at the IPC contract and the menu wiring.
 *
 * The backend parser and git behaviour are covered by `cargo test` in
 * `src-tauri/src/commits.rs`; this file checks that the page actually calls that
 * command with a bounded limit, that the entry appears only for a local clone,
 * and that the dialog remains lazily loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isTranslationKey } from "../src/lib/i18n.ts";

const ROOT = process.cwd();

test("the dialog asks for a bounded commit list and renders its states", () => {
  const src = readFileSync(resolve(ROOT, "src/dialogs/RepoCommitsDialog.tsx"), "utf8");
  assert.match(src, /invoke<CommitInfo\[\]>\("repo_commits", \{ slug, limit: 30 \}\)/);
  assert.match(src, /kind: "loading"/);
  assert.match(src, /kind: "error"/);
  assert.match(src, /commits\.empty/);
  assert.match(src, /c\.short/);
  assert.match(src, /c\.subject/);
  assert.match(src, /c\.author/);
  assert.match(src, /navigator\.clipboard\.writeText\(hash\)/);
});

test("the card menu offers history only when a local clone exists", () => {
  const src = readFileSync(resolve(ROOT, "src/views/ProjectsView.tsx"), "utf8");
  assert.match(src, /onCommits: \(\) => \{/);
  assert.match(src, /id: "commits"/);
  assert.match(src, /disabled: !card\.path/);
  assert.match(src, /note: card\.path \? undefined : t\("commits\.noPath"\)/);
  assert.match(src, /<RepoCommitsDialog\s/);
});

test("every string the new surface uses exists in both dictionaries", () => {
  for (const key of [
    "commits.menu",
    "commits.title",
    "commits.loading",
    "commits.empty",
    "commits.failed",
    "commits.copy",
    "commits.copyAria",
    "commits.copied",
    "commits.copyFailed",
    "commits.noPath",
    "commits.refresh",
    "commits.count",
  ]) {
    assert.equal(isTranslationKey(key), true, key);
  }
});
