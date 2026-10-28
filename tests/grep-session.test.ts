/**
 * r21-N1-2 —「在项目中搜索」的交互、安全边界与错误态。
 *
 * N1-1（`tests/grep-ui.test.ts`）钉了参数、分组与三态；本文件钉**交互**：
 * 打字防抖（假时钟）、计划与在途两条作废线（竞态）、pattern 长度上限、
 * 后端错误原样呈现，以及复制 / reveal / ↑↓ 浏览这三条交互的规则本身——
 * 规则全部住在 `src/lib/grep.ts`（fake invoke + 注入计时器驱动），`.tsx` 那一半
 * 仍按本仓惯例读源码钉结构。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GREP_DEBOUNCE_MS,
  PATTERN_MAX,
  checkPattern,
  createGrepSession,
  grepCopyLines,
  hitAbsolutePath,
  nextActive,
  type GrepGroup,
  type GrepInvoke,
  type GrepResult,
  type GrepView,
} from "../src/lib/grep.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
    pattern: "x",
    root: "D:\\proj\\demo",
    files_scanned: 1,
    files_skipped: 0,
    hits: [],
    elapsed_ms: 1,
    error: null,
    ...over,
  };
}

/** The injected clock `tests/poll-loop.test.ts` uses: schedule/unschedule/fire. */
function fakeClock() {
  let nextId = 0;
  const pending: { id: number; cb: () => void; ms: number }[] = [];
  const cleared: number[] = [];
  return {
    pending,
    cleared,
    schedule: (cb: () => void, ms: number) => {
      const id = ++nextId;
      pending.push({ id, cb, ms });
      return id;
    },
    unschedule: (id: number) => {
      cleared.push(id);
      const at = pending.findIndex((p) => p.id === id);
      if (at >= 0) pending.splice(at, 1);
    },
    fire: () => {
      const soonest = pending.shift();
      if (!soonest) throw new Error("fake clock: nothing is scheduled");
      soonest.cb();
    },
  };
}

const Q = (pattern: string) => ({ root: "D:\\proj\\demo", pattern, caseInsensitive: false });

// ---------------------------------------------------------------------------
// 1. 防抖：停顿后才查

test("打字防抖: type 不立即查，停顿 700ms（本仓搜索停顿的默认值）后才发一次", async () => {
  const clock = fakeClock();
  const views: GrepView[] = [];
  let calls = 0;
  const fake: GrepInvoke = async () => {
    calls += 1;
    return makeResult({ hits: [{ file: "a.ts", line: 1, content: "x" }] });
  };
  const session = createGrepSession({
    invoke: fake,
    emit: (v) => views.push(v),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  session.type(Q("ab"));
  assert.equal(calls, 0, "刚敲下去不许花一次扫描");
  assert.deepEqual(views, [], "停顿期内也不改屏幕状态——上一批结果保持可见");
  assert.equal(clock.pending.length, 1);
  assert.equal(clock.pending[0]?.ms, GREP_DEBOUNCE_MS, "停顿就是设置页同款的 700ms");

  clock.fire();
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(views.map((v) => v.kind), ["loading", "hits"]);
});

test("打字防抖: 停顿期内再改一次，前一次计划被作废——只查最后一次", async () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const fake: GrepInvoke = async (_cmd, args) => {
    seen.push(String(args?.pattern ?? ""));
    return makeResult();
  };
  const session = createGrepSession({
    invoke: fake,
    emit: () => undefined,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  session.type(Q("a"));
  const firstId = clock.pending[0]?.id;
  session.type(Q("ab"));
  session.type(Q("abc"));
  assert.equal(clock.pending.length, 1, "同时只挂着一个计划");
  assert.ok(firstId !== undefined && clock.cleared.includes(firstId), "第一次计划被真的撤掉了");

  clock.fire();
  await flush();
  assert.deepEqual(seen, ["abc"], "只有最后一次输入到达后端");
});

test("打字防抖: debounceMs 可覆盖（会话不藏死一个数）", async () => {
  const clock = fakeClock();
  const session = createGrepSession({
    invoke: async () => makeResult(),
    emit: () => undefined,
    debounceMs: 50,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  session.type(Q("x"));
  assert.equal(clock.pending[0]?.ms, 50);
});

// ---------------------------------------------------------------------------
// 2. 竞态：计划作废之外，回答也要作废

test("竞态: 在途请求的旧回答不许在新输入敲定后落回来", async () => {
  const clock = fakeClock();
  const slow = deferred<GrepResult>();
  const views: GrepView[] = [];
  const fake: GrepInvoke = (_cmd, args) =>
    args?.pattern === "old" ? slow.promise : Promise.resolve(makeResult({ hits: [{ file: "new.ts", line: 1, content: "n" }] }));
  const session = createGrepSession({
    invoke: fake,
    emit: (v) => views.push(v),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  session.run(Q("old")); // 在路上
  assert.deepEqual(views.map((v) => v.kind), ["loading"]);
  session.type(Q("new")); // 用户继续打字 → 在途的那次作废
  slow.resolve(makeResult({ hits: [{ file: "old.ts", line: 9, content: "old" }] }));
  await flush();
  assert.equal(views.length, 1, "旧回答落地无门（既没盖状态也没补状态）");

  clock.fire();
  await flush();
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "hits" && last.groups[0]?.file === "new.ts", "屏幕上是新输入的结果");
});

test("竞态: 超长输入判死时同样作废在途请求", async () => {
  const slow = deferred<GrepResult>();
  const views: GrepView[] = [];
  const session = createGrepSession({
    invoke: () => slow.promise,
    emit: (v) => views.push(v),
  });
  session.run(Q("ok"));
  session.type(Q("z".repeat(PATTERN_MAX + 1)));
  slow.resolve(makeResult({ hits: [{ file: "a.ts", line: 1, content: "x" }] }));
  await flush();
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "invalid" && last.issue === "tooLong", "定格在「太长」这张脸上");
});

// ---------------------------------------------------------------------------
// 3. 错误态与长度上限

test("错误态: invoke 被拒绝时，后端原话一个字不改地进 error 态", async () => {
  const views: GrepView[] = [];
  const session = createGrepSession({
    invoke: () => Promise.reject("正则编译失败：unclosed group"),
    emit: (v) => views.push(v),
  });
  session.run(Q("("));
  await flush();
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "error");
  if (last && last.kind === "error") {
    assert.equal(last.message, "正则编译失败：unclosed group");
    assert.notEqual(last.kind, "empty");
  }
});

test("长度上限: PATTERN_MAX=200，边界内放行、超一个字符判死", () => {
  assert.equal(PATTERN_MAX, 200);
  assert.equal(checkPattern("a".repeat(PATTERN_MAX)), null);
  assert.equal(checkPattern("a".repeat(PATTERN_MAX + 1)), "tooLong");
  assert.equal(checkPattern(""), "empty");
  assert.equal(checkPattern("   "), "empty");
  assert.equal(checkPattern("TODO|FIXME"), null, "现实长度的检索式不受影响");
});

test("打字判死: 空输入回 idle（不报警），超长给 invalid 脸，两者都不排查询", async () => {
  const clock = fakeClock();
  const views: GrepView[] = [];
  let calls = 0;
  const session = createGrepSession({
    invoke: async () => {
      calls += 1;
      return makeResult();
    },
    emit: (v) => views.push(v),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  session.type(Q("   "));
  assert.equal(clock.pending.length, 0, "空输入连计时器都不挂");
  assert.equal(views[views.length - 1]?.kind, "idle");

  session.type(Q("z".repeat(PATTERN_MAX + 1)));
  assert.equal(clock.pending.length, 0, "超长同样不排查询");
  const last = views[views.length - 1];
  assert.ok(last && last.kind === "invalid" && last.issue === "tooLong");
  await flush();
  assert.equal(calls, 0, "两种判死都不许花一次扫描");
});

test("dispose: 取消挂起的计划", async () => {
  const clock = fakeClock();
  const views: GrepView[] = [];
  let calls = 0;
  const session = createGrepSession({
    invoke: async () => {
      calls += 1;
      return makeResult();
    },
    emit: (v) => views.push(v),
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  session.type(Q("x"));
  const timer = clock.pending[0]?.id;
  assert.ok(timer !== undefined);
  session.dispose();
  assert.ok(clock.cleared.includes(timer), "关掉对话框 = 撤掉停顿计时");
  assert.equal(calls, 0, "撤掉的计划没有变成一次扫描");
  assert.deepEqual(views, [], "什么都没发生过");
});

test("dispose: 在途回答同样落地无门", async () => {
  const slow = deferred<GrepResult>();
  const views: GrepView[] = [];
  const session = createGrepSession({ invoke: () => slow.promise, emit: (v) => views.push(v) });
  session.run(Q("x"));
  session.dispose();
  slow.resolve(makeResult({ hits: [{ file: "a.ts", line: 1, content: "x" }] }));
  await flush();
  assert.deepEqual(views.map((v) => v.kind), ["loading"], "卸载后没有任何状态回写");
});

// ---------------------------------------------------------------------------
// 4. 交互规则：复制格式、reveal 路径、↑↓ 钳位

test("复制: `file:line:content`，顺序与渲染一致（文件组 × 组内行）", () => {
  const groups: GrepGroup[] = [
    { file: "src\\a.ts", hits: [{ file: "src\\a.ts", line: 3, content: "const x = 1;" }] },
    {
      file: "src\\b.ts",
      hits: [
        { file: "src\\b.ts", line: 10, content: "let y = 2;" },
        { file: "src\\b.ts", line: 20, content: "z()" },
      ],
    },
  ];
  assert.deepEqual(grepCopyLines(groups), [
    "src\\a.ts:3:const x = 1;",
    "src\\b.ts:10:let y = 2;",
    "src\\b.ts:20:z()",
  ]);
  assert.deepEqual(grepCopyLines([]), []);
});

test("reveal 路径: 相对 file 拼到 root 下，尾部分隔符不重复，两种斜杠归一", () => {
  assert.equal(hitAbsolutePath("D:\\proj\\demo", "src\\a.ts"), "D:\\proj\\demo\\src\\a.ts");
  assert.equal(hitAbsolutePath("D:\\proj\\demo\\", "src/a.ts"), "D:\\proj\\demo\\src\\a.ts");
  assert.equal(hitAbsolutePath("D:/proj/demo/", "src/a.ts"), "D:\\proj\\demo\\src\\a.ts");
});

test("键盘: ↑↓ 钳位移动，-1（未选中）两个方向都从第一行起步", () => {
  assert.equal(nextActive(-1, "ArrowDown", 5), 0);
  assert.equal(nextActive(-1, "ArrowUp", 5), 0, "未选中时 ↑ 也落到第一行，不是最后一行的绕法");
  assert.equal(nextActive(0, "ArrowDown", 5), 1);
  assert.equal(nextActive(4, "ArrowDown", 5), 4, "到底停住，不循环");
  assert.equal(nextActive(0, "ArrowUp", 5), 0, "到头停住，不循环");
  assert.equal(nextActive(3, "ArrowUp", 5), 2);
  assert.equal(nextActive(0, "ArrowDown", 0), -1, "空列表没有可选项");
});

// ---------------------------------------------------------------------------
// 5. 接线（源码钉法）

const DIALOG = readFileSync("src/dialogs/RepoGrepDialog.tsx", "utf8");

test("接线: 打字进 type()（防抖）、搜索按钮与 Enter 进 run()（立即）", () => {
  assert.ok(DIALOG.includes("sessionRef.current?.type("), "onChange 走防抖通道");
  assert.ok(DIALOG.includes("query(\"run\")"), "表单提交（按钮/Enter）立即查");
  assert.ok(DIALOG.includes('checked={ci}') && DIALOG.includes('t("grep.caseInsensitive")'), "忽略大小写开关有词条");
  assert.ok(
    DIALOG.includes("sessionRef.current?.run({ root, pattern, caseInsensitive: next })"),
    "切换大小写立即重查（显式点击没有防抖的理由）",
  );
});

test("接线: 结果列表是 listbox + aria-activedescendant，行是 option", () => {
  assert.ok(DIALOG.includes('role="listbox"'), "容器语义");
  assert.ok(DIALOG.includes("aria-activedescendant={activeIndex >= 0"), "当前项靠 id 播报，焦点留在容器");
  assert.ok(DIALOG.includes("tabIndex={0}"), "容器可聚焦，否则 activedescendant 无从播报");
  assert.ok(DIALOG.includes('role="option"') && DIALOG.includes("aria-selected="), "行是 option 且有选中态");
  assert.ok(DIALOG.includes("nextActive(activeIndex, e.key, total)"), "↑↓ 用可测的纯函数");
  assert.ok(DIALOG.includes('t("grep.listAria"') && DIALOG.includes('t("grep.keyboardHint")'), "列表与键法都念得出名字");
});

test("接线: 点击或 Enter → reveal_path；复制走剪贴板且文案来自词表", () => {
  assert.ok(DIALOG.includes('invoke("reveal_path", { path })'), "与卡片菜单同一条命令");
  assert.ok(DIALOG.includes('reportError(e, t("wall.revealFail"))'), "失败文案复用既有词条");
  assert.ok(DIALOG.includes("reveal(hitAbsolutePath(root, at.file))"), "键盘 Enter 打开当前行的文件");
  assert.ok(DIALOG.includes("grepCopyLines(view.groups)"), "复制的行格式来自纯函数");
  assert.ok(DIALOG.includes("navigator.clipboard.writeText"), "剪贴板");
  assert.ok(DIALOG.includes('t("grep.copied"'), "成功提示走词表");
  assert.ok(DIALOG.includes('t("settings.page.failuresClipboardDenied")'), "剪贴板被拒复用既有文案");
});

test("接线: 超长与空输入是两种不同的脸，且不发请求", () => {
  assert.ok(DIALOG.includes('t("grep.patternTooLong", { max: PATTERN_MAX })'), "太长有自己的一句话");
  assert.ok(DIALOG.includes('view.issue === "empty" ? t("grep.needPattern")'), "空输入另一句");
  assert.ok(DIALOG.includes('t("grep.revealTitle", { path })'), "每行的 reveal 提示说明去哪");
});
