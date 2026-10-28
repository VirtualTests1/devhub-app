/**
 * `src/lib/worktree-warning.ts` — the one line standing between a confirmation
 * and an irreversible delete.
 *
 * Round 11 shipped the probe; round 12 (让失败可见 8.3) found that its failure
 * path was a bare `catch {}`, so "问不到 git" and "工作树干净" rendered the same
 * dialog. Re-verifying the same lines turned up three more confusions, all of
 * them the same defect in a different costume, and one of them pointing the
 * other way (a clean repository warning about itself). These tests are the
 * reason the copy lives in a `.ts` helper instead of inside `ProjectsView.tsx`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorktreeStatus } from "../src/types.ts";
import { worktreeWarningLine, type WorktreeProbe } from "../src/lib/worktree-warning.ts";

/** A git-backed, readable, nothing-to-report tree. */
const CLEAN: WorktreeStatus = { hasGit: true, branch: "main", dirty: 0, untracked: 0, ahead: 0 };

function probeOk(status: Partial<WorktreeStatus>): WorktreeProbe {
  return { ok: true, status: { ...CLEAN, ...status } };
}

const probeErr = (reason: unknown): WorktreeProbe => ({ ok: false, reason });

test("a clean tree is the ONLY state allowed to say nothing", () => {
  assert.equal(worktreeWarningLine(probeOk({}), true), "");
  assert.equal(worktreeWarningLine(probeOk({}), false), "");
});

test("a clean tree on a named branch no longer warns about itself", () => {
  // It used to: `分支 main` was one of the bits, so a repository with nothing at
  // risk printed "工作树还有未提交内容：分支 main". A warning that fires on the safe
  // state is how the real warning stops being read.
  const line = worktreeWarningLine(probeOk({ branch: "main", dirty: 0, untracked: 0, ahead: 0 }), true);
  assert.equal(line, "");
});

test("uncommitted changes are named, with the branch as context", () => {
  const line = worktreeWarningLine(probeOk({ dirty: 3, untracked: 2 }), true);
  assert.match(line, /3 个未提交修改/);
  assert.match(line, /2 个未跟踪文件/);
  assert.match(line, /分支 main/);
  assert.match(line, /无法通过 git 找回/);
  assert.ok(line.startsWith("\n\n⚠"), "the confirm text is one string; the break is the layout");
});

test("unpushed commits count as content on the irreversible path", () => {
  // `ahead` was in the payload (types.ts:205, launch.rs:817) and nowhere in the
  // dialog. A commit that never reached a remote exists on this disk only.
  const line = worktreeWarningLine(probeOk({ ahead: 4 }), true);
  assert.match(line, /4 个提交尚未推送到上游/);
});

test("a rejected probe is never the same sentence as a clean tree", () => {
  // This is the whole item. Both verbs, because 移入回收站 is still a delete the
  // user answers, and an unknown tree there is still not a clean one.
  for (const permanent of [true, false]) {
    const line = worktreeWarningLine(probeErr("找不到该仓库的目录"), permanent);
    assert.notEqual(line, "");
    assert.match(line, /未能检查工作树状态/);
    assert.match(line, /找不到该仓库的目录/, "the backend's own words, via messageOf");
    assert.match(line, /请当作可能有/);
  }
});

test("only 永久删除 claims the extra consequence", () => {
  assert.match(worktreeWarningLine(probeErr("git 失败"), true), /永久删除后这些内容也无法通过 git 找回/);
  assert.doesNotMatch(worktreeWarningLine(probeErr("git 失败"), false), /永久删除/);
});

test("a repository with no git at all is not a clean one", () => {
  // `worktree_status` returns the all-default payload for a directory without
  // `.git`, so this too used to render as clean. The Recycle Bin does come back,
  // so only the irreversible verb says it.
  const noGit = probeOk({ hasGit: false, branch: null, dirty: 0, untracked: 0, ahead: null });
  assert.match(worktreeWarningLine(noGit, true), /没有 git 历史/);
  assert.equal(worktreeWarningLine(noGit, false), "");
});

test("git that answers nothing is 未能检查, not 干净", () => {
  // The `find_git` failure inside `launch.rs:786` keeps `hasGit` true and every
  // other field default. No branch, no upstream, no counts — that is silence
  // from a tool that was asked, not an answer.
  const mute = probeOk({ hasGit: true, branch: null, dirty: 0, untracked: 0, ahead: null });
  const line = worktreeWarningLine(mute, true);
  assert.match(line, /未能检查工作树状态/);
  assert.match(line, /git 没有回答/);
});

test("an unreadable rejection still produces a sentence", () => {
  const line = worktreeWarningLine(probeErr({ nested: { deeply: true } }), true);
  assert.match(line, /后端未返回原因/);
  assert.doesNotMatch(line, /object Object/);
});

test("a tree with no upstream and a readable branch stays silent", () => {
  // Known limit of the payload, pinned so it is a decision rather than an
  // oversight: `ahead: null` means both "no upstream configured" and "git would
  // not say", so the confirmation cannot claim either. Only a tree that also
  // lost its branch name is treated as unknown.
  assert.equal(worktreeWarningLine(probeOk({ ahead: null }), true), "");
});
