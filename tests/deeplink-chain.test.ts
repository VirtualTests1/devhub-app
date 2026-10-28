/**
 * r21 N3-2 — Deep Link 处理链：监听注册 → 收到 `deeplink://clone` → 校验 → 触发下载。
 *
 * 这条链在 r21 N3-2 之前没有任何测试，toast 还是硬编码英文。三个可测面分开钉：
 *
 *   1. **处理器行为**（真执行）：`makeDeepLinkCloneHandler` 由假事件驱动——
 *      合法 payload 的顺序与参数、非法 payload 的拒绝，都在这里断言；
 *   2. **监听注册**（结构断言，原因写在 `src/lib/deeplink-client.ts` 头部）：
 *      `listen("deeplink://clone", …)` 那一行必须留在 App.tsx——`check-events.mjs`
 *      只认调用点上的字面量，挪进助手函数会让事件从配对表里消失；
 *   3. **守卫的依据**（结构断言）：为什么拦在事件层而不是 preflight，读的是
 *      `downloader.rs::parse_ref` 的真实分支——这段注释哪天与代码不符，这里先红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  cloneTargetOf,
  makeDeepLinkCloneHandler,
  makeDeepLinkOpenHandler,
  type DeepLinkOpenTarget,
  type DeepLinkTarget,
} from "../src/lib/deeplink-client.ts";
import { isTranslationKey, tFor } from "../src/lib/i18n.ts";

const APP = readFileSync("src/App.tsx", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const DOWNLOADER = readFileSync("src-tauri/src/downloader.rs", "utf8").replace(/\r\n/g, "\n");
const LIB_RS = readFileSync("src-tauri/src/lib.rs", "utf8").replace(/\r\n/g, "\n");
const DEEPLINK_RS = readFileSync("src-tauri/src/deeplink.rs", "utf8").replace(/\r\n/g, "\n");

/** 记录三条去向的假注入。 */
function fakeTarget() {
  const calls: { onCloning: string[]; startDownload: [string, string][]; onIgnored: string[] } = {
    onCloning: [],
    startDownload: [],
    onIgnored: [],
  };
  const target: DeepLinkTarget = {
    startDownload: (ref, source) => calls.startDownload.push([ref, source]),
    onCloning: (repo) => calls.onCloning.push(repo),
    onIgnored: (payload) => calls.onIgnored.push(payload),
  };
  return { calls, target };
}

// ---------------------------------------------------------------------------
// 1. 处理器行为（真执行）

test("链路: 收到 owner/repo → 先提示、再以 (repo, repo) 触发 startDownload", () => {
  const { calls, target } = fakeTarget();
  const handler = makeDeepLinkCloneHandler(target);

  handler({ payload: "torvalds/linux" });
  assert.deepEqual(calls.onCloning, ["torvalds/linux"], "提示带的是归一化后的仓库名");
  assert.deepEqual(
    calls.startDownload,
    [["torvalds/linux", "torvalds/linux"]],
    "ref 与 source 同值——下游两条都吃 owner/repo",
  );
  assert.deepEqual(calls.onIgnored, [], "合法 payload 不产生拒绝提示");

  // 顺序是契约：先提示再入队，反过来会看到「提示还没出、队列已经动了」。
  const order: string[] = [];
  makeDeepLinkCloneHandler({
    startDownload: () => order.push("download"),
    onCloning: () => order.push("toast"),
    onIgnored: () => order.push("ignored"),
  })({ payload: "torvalds/linux" });
  assert.deepEqual(order, ["toast", "download"]);
});

test("链路: 恰好一段 / 的合法形状才收（GitHub 组成字符）", () => {
  for (const good of ["torvalds/linux", "rust-lang/rust", "a.b_c/d-e.f", " owner/repo "]) {
    const expected = good.trim();
    assert.equal(cloneTargetOf(good), expected, `${good} 是合法 owner/repo`);
  }
});

test("链路: 非两段式 / 非字符串 / 本地路径形状一律被拦，不碰 startDownload", () => {
  const bad: [unknown, string][] = [
    ["torvalds", "一段式"],
    ["a/b/c", "三段式——parse_ref 会收下并克隆 https://a/b/c"],
    ["", "空串"],
    ["torvalds/", "尾空段"],
    ["/linux", "头空段"],
    ["D:/foo", "盘符形——parse_ref 会当本地路径"],
    ["../foo", "相对路径形"],
    ["own er/repo", "带空格"],
    ["own%20er/repo", "带百分号编码"],
    ["torvalds/../linux", "带点段"],
    [42, "非字符串"],
    [null, "null"],
    [{ owner: "a", repo: "b" }, "对象"],
  ];
  for (const [payload, why] of bad) {
    const { calls, target } = fakeTarget();
    makeDeepLinkCloneHandler(target)({ payload });
    assert.equal(calls.startDownload.length, 0, `应当被拦（${why}），payload=${JSON.stringify(payload)}`);
    assert.equal(calls.onCloning.length, 0, `被拦就不该先提示（${why}）`);
    assert.equal(calls.onIgnored.length, 1, `被拦必须留一句话（${why}）`);
  }
});

test("链路: 被拒的 payload 转成能看的文本（字符串照抄，对象走 JSON）", () => {
  const seen: string[] = [];
  const handler = makeDeepLinkCloneHandler({
    startDownload: () => {},
    onCloning: () => {},
    onIgnored: (p) => seen.push(p),
  });
  handler({ payload: "a/b/c" });
  handler({ payload: { owner: "a" } });
  handler({ payload: null });
  assert.deepEqual(seen, ["a/b/c", '{"owner":"a"}', "null"]);
});

test("链路: open 处理器只打开、不下载；非法 payload 仍走同一道拒绝", () => {
  const opened: string[] = [];
  const ignored: string[] = [];
  const target: DeepLinkOpenTarget = {
    open: (repo) => opened.push(repo),
    onIgnored: (payload) => ignored.push(payload),
  };
  makeDeepLinkOpenHandler(target)({ payload: "torvalds/linux" });
  assert.deepEqual(opened, ["torvalds/linux"]);
  assert.deepEqual(ignored, []);

  for (const bad of ["a/b/c", "D:/foo", 42, null]) {
    makeDeepLinkOpenHandler(target)({ payload: bad });
  }
  assert.deepEqual(opened, ["torvalds/linux"], "被拒的 payload 不打开任何项目");
  assert.equal(ignored.length, 4, "每个被拒 payload 都留一句话");
});

// ---------------------------------------------------------------------------
// 2. 监听注册与词条（结构）

test("App: 监听注册留在原地，字面量与 Rust 两处 emit 同名", () => {
  assert.ok(
    APP.includes('const unlistenClone = listen<string>("deeplink://clone", onClone);'),
    "check-events.mjs 只认调用点上的字面量；这行挪进助手函数事件配对就断了",
  );
  assert.ok(
    APP.includes('const unlistenOpen = listen<string>("deeplink://open", onOpen);'),
    "open 的监听同样必须是字面量",
  );
  assert.ok(APP.includes("const onClone = makeDeepLinkCloneHandler({"), "处理器由纯模块提供");
  assert.ok(APP.includes("const onOpen = makeDeepLinkOpenHandler({"), "open 处理器同样来自纯模块");
  assert.ok(
    APP.includes("void unlistenClone.then((fn) => fn());") &&
      APP.includes("void unlistenOpen.then((fn) => fn());"),
    "两条监听都要等 listen 落地后再 unlisten",
  );
  // 两端互钉：Rust 两个调用点走同一个 Action::emit，事件名与载荷形状在 deeplink.rs 里。
  assert.equal(
    (LIB_RS.match(/action\.emit\(/g) ?? []).length,
    2,
    "setup 与 second-instance 各一处 emit",
  );
  assert.ok(DEEPLINK_RS.includes('app.emit("deeplink://clone", &format!("{owner}/{repo}"))'));
  assert.ok(DEEPLINK_RS.includes('app.emit("deeplink://open", &format!("{owner}/{repo}"))'));
});

test("App: 硬编码 toast 已换成词表键，且三个键都登记在两份词表里", () => {
  assert.ok(!APP.includes("Deep Link: cloning ${repo}"), "旧的模板字面量必须消失");
  assert.ok(APP.includes('t("deeplink.cloning", { repo })'), "提示走词表");
  assert.ok(APP.includes('t("deeplink.ignored", { payload })'), "被拦的那句也走词表");
  assert.ok(APP.includes('t("deeplink.openMissing", { repo })'), "open 找不到项目时也要说清楚");
  // 键集两份都在 + zh/en 逐字节钉住（新家族：词表就是原始文案）。
  const KEYS: Record<string, [string, string]> = {
    "deeplink.cloning": ["Deep Link：开始克隆 {repo}", "Deep Link: cloning {repo}"],
    "deeplink.ignored": [
      "Deep Link：链接无法识别，已忽略（{payload}）",
      "Deep Link: link not recognised, ignored ({payload})",
    ],
    "deeplink.openMissing": [
      "Deep Link：本地没有 {repo}，请先添加这个项目",
      "Deep Link: {repo} is not in DevHub yet; add it first",
    ],
  };
  for (const [key, [zh, en]] of Object.entries(KEYS)) {
    assert.ok(isTranslationKey(key), `${key} 未登记`);
    assert.equal(tFor("zh-CN", key), zh, `${key} 的 zh 掉了原话`);
    assert.equal(tFor("en", key), en, `${key} 的 en 掉了原话`);
  }
  // r21-o3-2 之后键只写一遍（EN 是按 ZH 键序的值数组）：3 键各声明一次；EN 侧若长回
  // 第二张键表，计数会变成 6 而变红（bundle-diet-1 对全表做同款守卫）。zh/en 逐字节
  // 齐上面已钉（tFor），i18n-diff-analysis 再验全表配对。（正则只认键声明行，注释不参与。）
  assert.equal((I18N.match(/"deeplink\.[A-Za-z]+":/g) ?? []).length, 3);
});

// ---------------------------------------------------------------------------
// 3. 守卫放在事件层的依据（读真实代码，注释与代码不符先红）

test("依据: parse_ref 对一段式报错、对三段式照收——所以拦在事件层", () => {
  // 三段式被接受 → `https://a/b/c` 会排进队列；添加页必须这样，所以那层不能收紧。
  assert.ok(DOWNLOADER.includes("3.. => ("), "parse_ref 的三段及以上分支仍在（host/owner/repo）");
  assert.ok(
    DOWNLOADER.includes("_ => return Err(DownloadError::InvalidRef(input.to_string()))"),
    "不足两段判 InvalidRef——事件若放行，preflight 的 catch 会记一条没人发起的失败",
  );
  // App 的 preflight 确实会把 InvalidRef 变成一次失败提示 + 故障历史。
  assert.ok(APP.includes('reportError(err, t("app.download.startFailed"))'), "一段式的下游就是这句");
});

test("依据: 后端两处 emit 已校验——前端这层是纵深防御，不是补漏", () => {
  // setup 走 extract_action（内部 parse），second-instance 直接 parse 后交给 Action::emit。
  assert.ok(LIB_RS.includes("let Some(action) = deeplink::extract_action() else {"));
  assert.ok(DEEPLINK_RS.includes("Action::Open { owner, repo } =>"), "open 与 clone 分派到不同事件");
  // 本文件的守卫因此不替代后端校验：它只保证事件这一侧也说同一句话。
  assert.equal(cloneTargetOf("owner/repo"), "owner/repo");
});
