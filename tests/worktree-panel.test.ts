/**
 * `src/lib/worktree-panel.ts` — 项目设置 → 工作树面板的判定层。
 *
 * 这个文件的存在本身就是一条修好的引用：模块头与 `worktreeDirName` 的注释都写着
 * 「由 `tests/worktree-panel.test.ts` 钉住」，而那个文件在 2026-10-22 之前并不存在。
 * 同样的规则出现在 gitwt.rs 的测试与这里的镜像之间，漂移时没有任何门禁会红。
 *
 * 这里不测 React，只测面板在按下按钮之前就要给出的答案：新树落在哪、哪一行不能删、
 * 为什么不能删、删完之后怎么描述。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorktreeInfo, WorktreeList, WorktreeRemoveReport, WorktreeStatus } from "../src/types.ts";
import {
  worktreeCanCreate,
  worktreeConfirmLine,
  worktreeDeleteRefusal,
  worktreeDirName,
  worktreeEmptyLine,
  worktreeLabel,
  worktreePlacement,
  worktreeRemovalLine,
  worktreeRowNote,
} from "../src/lib/worktree-panel.ts";

const STATUS: WorktreeStatus = {
  hasGit: true,
  branch: "feat/x",
  dirty: 0,
  untracked: 0,
  ahead: 0,
};

function wt(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: "D:\\projects\\_worktrees\\demo__feat-x",
    head: "0123456789abcdef",
    branch: "feat/x",
    detached: false,
    bare: false,
    prunable: false,
    locked: false,
    isMain: false,
    exists: true,
    managed: true,
    status: STATUS,
    ...over,
  };
}

function list(over: Partial<WorktreeList> = {}): WorktreeList {
  return {
    repo: "demo",
    hasGit: true,
    container: "D:\\projects\\_worktrees",
    worktrees: [],
    error: null,
    ...over,
  };
}

function removal(over: Partial<WorktreeRemoveReport> = {}): WorktreeRemoveReport {
  return {
    path: "D:\\projects\\_worktrees\\demo__feat-x",
    branch: "feat/x",
    removed: true,
    force: false,
    pruned: 0,
    note: null,
    failed: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 放置规则（与 gitwt.rs 同一份，靠三个夹具互钉）

test("worktreeDirName: 斜杠压平成 __，两端空白去掉", () => {
  assert.equal(worktreeDirName("acme/demo", "feat/x"), "acme__demo__feat__x");
  assert.equal(worktreeDirName(" acme\\demo ", " fix "), "acme__demo__fix");
});

test("worktreePlacement: 无子目录时用分支名；两者都空就不给路径", () => {
  assert.equal(
    worktreePlacement("D:\\projects\\_worktrees", "acme/demo", "feat/x", ""),
    "D:\\projects\\_worktrees\\acme__demo__feat__x",
  );
  assert.equal(
    worktreePlacement("D:\\projects\\_worktrees\\", "acme/demo", "feat/x", "sub"),
    "D:\\projects\\_worktrees\\acme__demo__sub",
  );
  assert.equal(
    worktreePlacement("D:/projects/_worktrees", "acme/demo", "feat/x", "sub"),
    "D:/projects/_worktrees/acme__demo__sub",
    "容器的分隔符决定结果的形状",
  );
  assert.equal(worktreePlacement("D:\\x", "a/b", "  ", "  "), "", "没有分支也没有目录 → 没有可预览的路径");
});

// ---------------------------------------------------------------------------
// 2. 行身份与删除许可

test("worktreeLabel: 裸仓库 / 分支 / 分离头指针各有自己的说法", () => {
  assert.equal(worktreeLabel(wt({ bare: true })), "裸仓库（不是工作树）");
  assert.equal(worktreeLabel(wt()), "feat/x");
  assert.equal(worktreeLabel(wt({ branch: null, detached: true })), "分离头指针 01234567");
  assert.equal(worktreeLabel(wt({ branch: null, detached: true, head: "" })), "分离头指针（没有提交）");
  assert.equal(worktreeLabel(wt({ branch: null, detached: false, head: "" })), "（git 没有说它在哪个分支上）");
});

test("worktreeDeleteRefusal: 主检出、锁定、目录丢失、非托管都拒绝并说明理由", () => {
  assert.match(worktreeDeleteRefusal(wt({ isMain: true })) ?? "", /仓库本身/);
  assert.match(worktreeDeleteRefusal(wt({ locked: true })) ?? "", /unlock/);
  assert.match(worktreeDeleteRefusal(wt({ exists: false })) ?? "", /登记/);
  assert.match(worktreeDeleteRefusal(wt({ managed: false })) ?? "", /_worktrees/);
  assert.equal(worktreeDeleteRefusal(wt()), null, "托管且存在的普通工作树可以删");
});

// ---------------------------------------------------------------------------
// 3. 行说明、确认与删除结果

test("worktreeRowNote: 干净只留空白；问不到与目录丢失分开说", () => {
  assert.equal(worktreeRowNote(wt()), "");
  assert.match(worktreeRowNote(wt({ exists: false, prunable: true })), /登记还在/);
  assert.match(worktreeRowNote(wt({ status: null })), /问不到/);
  assert.match(
    worktreeRowNote(wt({ status: { hasGit: false, branch: null, dirty: 0, untracked: 0, ahead: null } })),
    /问不到/,
  );
  assert.match(
    worktreeRowNote(wt({ status: { ...STATUS, dirty: 2, untracked: 1 } })),
    /2 个未提交修改.*1 个未跟踪文件/,
  );
});

test("worktreeConfirmLine: 用 worktreeWarningLine 的同一句话，不另写副本", () => {
  assert.equal(worktreeConfirmLine(wt()), "");
  const line = worktreeConfirmLine(wt({ status: { ...STATUS, dirty: 1 } }));
  assert.match(line, /无法通过 git 找回/, "永久删除路径上必须说明不可恢复");
  assert.equal(worktreeConfirmLine(wt({ status: null })), "");
});

test("worktreeRemovalLine: 成功/强删/剪枝/空操作/失败五种结论", () => {
  assert.deepEqual(worktreeRemovalLine(removal()), {
    tone: "ok",
    text: "已删除 D:\\projects\\_worktrees\\demo__feat-x。分支 feat/x 仍然留在仓库里，需要时可以再挂出来。",
  });
  assert.match(worktreeRemovalLine(removal({ force: true })).text, /不进回收站/);
  assert.match(worktreeRemovalLine(removal({ removed: false, pruned: 2, note: "x" })).text, /2 条/);
  assert.match(worktreeRemovalLine(removal({ removed: false })).text, /没有任何东西被删除/);
  const dirty = worktreeRemovalLine(
    removal({ removed: false, failed: ["fatal: contains modified or untracked files, use --force to delete"] }),
  );
  assert.equal(dirty.tone, "warn");
  assert.match(dirty.text, /强制/);
  const generic = worktreeRemovalLine(removal({ removed: false, failed: ["permission denied"] }));
  assert.match(generic.text, /permission denied/);
});

test("worktreeEmptyLine: 没有 git / git 没答 / 真的还没有 是三句话", () => {
  assert.match(worktreeEmptyLine(list({ hasGit: false })), /没有 git 历史/);
  assert.match(worktreeEmptyLine(list({ error: "not a repo" })), /not a repo/);
  assert.match(worktreeEmptyLine(list()), /_worktrees/);
});

test("worktreeCanCreate: 只有空白分支名不能创建", () => {
  assert.equal(worktreeCanCreate("feat/x"), true);
  assert.equal(worktreeCanCreate("  feat/x  "), true);
  assert.equal(worktreeCanCreate(""), false);
  assert.equal(worktreeCanCreate("   "), false);
});
