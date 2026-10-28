/**
 * r21-N1-1 —「在项目中搜索」（`repo_grep`）：逻辑用 fake invoke 驱动，接线按源码钉。
 *
 * ## 为什么这样分
 *
 * 对话框是 `.tsx`，Node 的类型剥离加载不了（`tests/lib-import-graph.test.ts` 头部），
 * 所以所有「给这些输入返回什么」的判定点——参数拼装、按文件分组、截断、后端错误与
 * 空结果的分界、竞态守卫——都住在 `src/lib/grep.ts`，这里用 **fake invoke** 驱动它们。
 * `.tsx` 那一半钉的是**结构**（入口、挂载、登记、词条读点），照
 * `tests/network-diag-ui.test.ts` 的既有写法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GREP_LIMIT,
  classify,
  createGrepSession,
  groupHits,
  runGrep,
  type GrepInvoke,
  type GrepResult,
  type GrepView,
} from "../src/lib/grep.ts";

/** Lets the session's `await` resume before the next assertion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A settlement a test controls, so "still in flight" is a state you can be in. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeResult(over: Partial<GrepResult> = {}): GrepResult {
  return {
    pattern: "TODO",
    root: "D:\\proj\\demo",
    files_scanned: 0,
    files_skipped: 0,
    hits: [],
    elapsed_ms: 1,
    error: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. 请求形状：单仓库 + camelCase 按键 + 显式 limit

test("runGrep: 调的是 repo_grep，参数是单个 root/pattern + camelCase + 显式 limit", async () => {
  const seen: { cmd?: string; args?: Record<string, unknown> } = {};
  const fake: GrepInvoke = async (cmd, args) => {
    seen.cmd = cmd;
    seen.args = args;
    return makeResult();
  };
  const out = await runGrep(fake, { root: "D:\\proj\\demo", pattern: "TODO", caseInsensitive: true });
  assert.equal(seen.cmd, "repo_grep");
  // `caseInsensitive` 是驼峰：Tauri 2 把 JS 按键转成 Rust 形参 `case_insensitive`
  // （同仓先例 `createNew` → `create_new`），传 snake_case 会静默落成 None。
  assert.deepEqual(seen.args, {
    root: "D:\\proj\\demo",
    pattern: "TODO",
    caseInsensitive: true,
    limit: GREP_LIMIT,
  });
  assert.equal(out.root, "D:\\proj\\demo", "回答原样透传");
});

test("runGrep: limit 默认等于 GREP_LIMIT（= 后端 unwrap_or(500)），截断判断不悬在后端默认值上", () => {
  assert.equal(GREP_LIMIT, 500);
});

// ---------------------------------------------------------------------------
// 2. 按文件分组

test("groupHits: 文件按第一次命中的顺序，行保持返回顺序", () => {
  const groups = groupHits([
    { file: "b.ts", line: 7, content: "b7" },
    { file: "a.ts", line: 1, content: "a1" },
    { file: "b.ts", line: 2, content: "b2" },
    { file: "a.ts", line: 9, content: "a9" },
  ]);
  assert.deepEqual(
    groups.map((g) => g.file),
    ["b.ts", "a.ts"],
    "第一个文件先出现，即使它的行号更大",
  );
  assert.deepEqual(
    groups.map((g) => g.hits.map((h) => h.line)),
    [[7, 2], [1, 9]],
    "组内顺序 = 后端返回顺序",
  );
});

test("groupHits: 空输入给空数组，不产生空段", () => {
  assert.deepEqual(groupHits([]), []);
});

// ---------------------------------------------------------------------------
// 3. 三态三张脸：error / empty / hits

test("classify: 后端 error 字段原样呈现——正则编译失败不是「没找到」", () => {
  const backendWords = "正则编译失败：unclosed group";
  const view = classify(makeResult({ error: backendWords, files_scanned: 0, hits: [] }));
  assert.equal(view.kind, "error");
  if (view.kind !== "error") return;
  assert.equal(view.message, backendWords, "一个字都不许改写");
});

test("classify: 零命中是 empty，带扫描量与耗时，且与 error 是两个态", () => {
  const empty = classify(makeResult({ files_scanned: 12, files_skipped: 3, elapsed_ms: 3 }));
  const failed = classify(makeResult({ error: "目录不存在：X", files_scanned: 0 }));
  assert.notEqual(empty.kind, failed.kind, "「查过没有」和「没查成」不能长一个样");
  assert.equal(empty.kind, "empty");
  if (empty.kind !== "empty") return;
  assert.equal(empty.filesScanned, 12, "空态要说扫描量，否则「没有」没有证据");
  assert.equal(empty.elapsedMs, 3);
  assert.equal(empty.filesSkipped, 3, "跳过的文件数是结论的一部分，必须带到屏幕");
});

test("classify: 有命中按文件分组；命中数碰到 limit 才标截断", () => {
  const hits = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ file: "a.ts", line: i + 1, content: `L${i}` }));

  const full = classify(makeResult({ hits: hits(3), files_scanned: 4, files_skipped: 2 }), 3);
  assert.equal(full.kind, "hits");
  if (full.kind === "hits") {
    assert.equal(full.truncated, true, "3 条打到 limit=3 → 必须说截断");
    assert.equal(full.total, 3);
    assert.equal(full.groups.length, 1);
    assert.equal(full.filesSkipped, 2);
  }

  const partial = classify(makeResult({ hits: hits(3), files_scanned: 4 }), 500);
  if (partial.kind === "hits") {
    assert.equal(partial.truncated, false, "远低于 limit 不许喊截断");
  } else {
    assert.fail(`expected hits, got ${partial.kind}`);
  }
});

// ---------------------------------------------------------------------------
// 4. 会话：loading 顺序、竞态、dispose、空输入

test("session: run 先发 loading，回答落地后给 classify 的最终态", async () => {
  const views: GrepView[] = [];
  const fake: GrepInvoke = async () =>
    makeResult({ hits: [{ file: "a.ts", line: 1, content: "x" }], files_scanned: 1 });
  const session = createGrepSession({ invoke: fake, emit: (v) => views.push(v) });
  session.run({ root: "D:\\p", pattern: "x", caseInsensitive: false });
  assert.deepEqual(views.map((v) => v.kind), ["loading"], "同步先亮 loading");
  await flush();
  assert.deepEqual(views.map((v) => v.kind), ["loading", "hits"]);
});

test("session: 旧请求晚到不得覆盖新结果（seq 守卫）", async () => {
  const views: GrepView[] = [];
  const slow = deferred<GrepResult>();
  const calls: string[] = [];
  const fake: GrepInvoke = (_cmd, args) => {
    const pattern = String(args?.pattern ?? "");
    calls.push(pattern);
    if (pattern === "old") return slow.promise;
    return Promise.resolve(makeResult({ hits: [{ file: "new.ts", line: 1, content: "new" }] }));
  };
  const session = createGrepSession({ invoke: fake, emit: (v) => views.push(v) });

  session.run({ root: "D:\\p", pattern: "old", caseInsensitive: false });
  session.run({ root: "D:\\p", pattern: "new", caseInsensitive: false });
  await flush();
  assert.deepEqual(
    views.map((v) => v.kind),
    ["loading", "loading", "hits"],
    "第二次搜索的答案先落地",
  );

  // 慢的那次现在才回来，带着一批完全不同的命中——它必须落地无门。
  slow.resolve(makeResult({ hits: [{ file: "old.ts", line: 9, content: "old" }] }));
  await flush();
  const kinds = views.map((v) => v.kind);
  assert.deepEqual(kinds, ["loading", "loading", "hits"], "迟到的旧答案没有多出一个状态");
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "hits" && last.groups[0]?.file === "new.ts", "屏幕上留的是新结果");
  assert.deepEqual(calls, ["old", "new"]);
});

test("session: 一个已被取代的请求，其迟到的失败也不许覆盖状态", async () => {
  const views: GrepView[] = [];
  const slow = deferred<GrepResult>();
  const fake: GrepInvoke = (_cmd, args) =>
    String(args?.pattern) === "old" ? slow.promise : Promise.resolve(makeResult({ files_scanned: 2 }));
  const session = createGrepSession({ invoke: fake, emit: (v) => views.push(v) });
  session.run({ root: "D:\\p", pattern: "old", caseInsensitive: false });
  session.run({ root: "D:\\p", pattern: "new", caseInsensitive: false });
  await flush();
  slow.reject("这是一次已被取代的失败");
  await flush();
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "empty", `迟到失败把状态盖成了 ${last?.kind}`);
});

test("session: dispose 后在途回答落地无门", async () => {
  const views: GrepView[] = [];
  const slow = deferred<GrepResult>();
  const session = createGrepSession({ invoke: () => slow.promise, emit: (v) => views.push(v) });
  session.run({ root: "D:\\p", pattern: "x", caseInsensitive: false });
  session.dispose();
  slow.resolve(makeResult({ hits: [{ file: "a.ts", line: 1, content: "x" }] }));
  await flush();
  assert.deepEqual(views.map((v) => v.kind), ["loading"], "对话框关掉后没有任何状态回写");
});

test("session: 空 pattern 是 invalid（empty），且根本不发请求", async () => {
  const views: GrepView[] = [];
  let calls = 0;
  const fake: GrepInvoke = async () => {
    calls += 1;
    return makeResult();
  };
  const session = createGrepSession({ invoke: fake, emit: (v) => views.push(v) });
  session.run({ root: "D:\\p", pattern: "   ", caseInsensitive: false });
  await flush();
  assert.equal(calls, 0, "空白输入不许花一次扫描");
  assert.equal(views.length, 1);
  const only = views[0];
  assert.ok(only && only.kind === "invalid" && only.issue === "empty");
});

// ---------------------------------------------------------------------------
// 5. 接线（源码钉法：.tsx 这一层 Node 加载不了）

const DIALOG = readFileSync("src/dialogs/RepoGrepDialog.tsx", "utf8");
const VIEW = readFileSync("src/views/ProjectsView.tsx", "utf8");
const GREP_LIB = readFileSync("src/lib/grep.ts", "utf8");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8");

test("对话框: 走 DialogShell 并登记 regId（dialog-a11y / check-registry 两侧都要绿）", () => {
  assert.ok(DIALOG.includes("<DialogShell"), "复用对话框骨架，不另写一套 role/焦点纪律");
  assert.ok(DIALOG.includes('regId="grep-dialog"'), "面板可被元素登记表寻址");
  assert.ok(CUSTOMIZE.includes('id: "grep-dialog"'), "登记表里有这一条，否则界面上找不到它");
  assert.ok(DIALOG.includes('title={t("grep.dialogTitle")}'), "标题读词表，不写中文字面量");
});

test("对话框: 状态机来自 lib/grep，后端错误原样走 {msg} 槽，空态是另一段 JSX", () => {
  assert.ok(
    DIALOG.includes("createGrepSession({") && DIALOG.includes("invoke: grepInvoke,"),
    "查询会话（含 seq 守卫）住在可测的 .ts 里，组件只接 emit",
  );
  assert.ok(DIALOG.includes('t("grep.failed", { msg: view.message })'), "后端原话原样呈现");
  assert.ok(DIALOG.includes('role="alert"'), "错误态是打断式的，不是一句灰色小字");
  const errorBranch = DIALOG.indexOf('view.kind === "error"');
  const emptyBranch = DIALOG.indexOf('view.kind === "empty"');
  assert.ok(errorBranch > 0 && emptyBranch > 0 && errorBranch !== emptyBranch, "两态是两段互斥 JSX");
  assert.ok(GREP_LIB.includes('invoke("repo_grep"'), "命令名的字面量在 .ts 里（check-commands 扫得到）");
});

test("入口: 卡片右键菜单有「在项目中搜索…」，无本地目录时置灰并说明原因", () => {
  assert.ok(VIEW.includes('id: "grep"'), "菜单项存在");
  assert.ok(VIEW.includes('label: t("grep.menu")'), "文案走词表");
  assert.ok(VIEW.includes("disabled: !card.path"), "没有目录就问不了");
  assert.ok(VIEW.includes('note: card.path ? undefined : t("grep.noPath")'), "置灰的行把原因写在脸上");
  assert.ok(VIEW.includes("onGrep: () =>"), "菜单接到打开动作");
  assert.ok(VIEW.includes("<RepoGrepDialog"), "对话框真的被挂载");
  assert.ok(VIEW.includes("setGrepSlug(menuCard.slug)"), "挂载在被右键的那张卡上——单仓库语义靠它成立");
});

test("对话框: 按文件分组渲染命中，行号与行内容都是数据渲染", () => {
  assert.ok(DIALOG.includes("view.groups.map((group"), "按文件分节");
  assert.ok(DIALOG.includes("{hit.line}"), "行号来自后端，不是数组下标");
  assert.ok(DIALOG.includes("{hit.content}"), "行内容直接渲染（React 转义），不走 innerHTML");
  assert.ok(!DIALOG.includes("dangerouslySetInnerHTML"), "仓库内容永远不当 HTML 解析");
  assert.ok(DIALOG.includes('t("grep.stats"'), "扫描量 / 命中数 / 耗时都上了屏");
  assert.ok(DIALOG.includes('t("grep.truncated"'), "截断必须可见");
});
