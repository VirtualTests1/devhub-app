/**
 * r18 N2 — 网络诊断的接线：谁能打开它、打开的是哪一层、里面探测什么。
 *
 * 规则本身钉在 `tests/netdiag.test.ts`（纯函数，行为断言）。本文件钉两件事：
 *
 *   - `ui` store 的行为：`netDiagOpen` 与 `closeTopLayer` 的层级次序（真模块直驱，
 *     这可以在 Node 里跑——store 不认识 React）；
 *   - 入口与对话框的**结构**：四处入口（状态栏弹层 / 命令面板 / 设置页 /
 *     App 挂载）各自的关键行。对话框的探测在真实运行里需要 DOM 与 IPC，
 *     这里没有 DOM 可跑，所以钉住「传了 force」「失败落成 null 状态」这些
 *     在审查中最容易被悄悄拿走的行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installBrowserGlobals } from "./helpers/storage.ts";
import { useUI } from "../src/store/ui.ts";

installBrowserGlobals();

const ui = () => useUI.getState();

test("ui store: closeTopLayer 的层级次序——palette → 项目面板 → 网络诊断 → 环境弹层", () => {
  // 四层全开，按一次「后退」关一层，顺序就是声明的次序。
  useUI.setState({ paletteOpen: true, openSlug: "demo", netDiagOpen: true, envOpen: true });
  assert.equal(ui().closeTopLayer(), true);
  assert.equal(ui().paletteOpen, false, "palette 在最上面");
  assert.equal(ui().openSlug, "demo", "其余三层原样");
  assert.equal(ui().closeTopLayer(), true);
  assert.equal(ui().openSlug, null, "项目面板第二");
  assert.equal(ui().netDiagOpen, true, "诊断对话框还没轮到");
  assert.equal(ui().closeTopLayer(), true);
  assert.equal(ui().netDiagOpen, false, "网络诊断第三");
  assert.equal(ui().envOpen, true);
  assert.equal(ui().closeTopLayer(), true);
  assert.equal(ui().envOpen, false, "环境弹层最后");
  assert.equal(ui().closeTopLayer(), false, "四层都关了，后退交还给历史");
  useUI.setState({ paletteOpen: false, openSlug: null, envOpen: false });
});

const UI_STORE = readFileSync("src/store/ui.ts", "utf8").replace(/\r\n/g, "\n");
const APP = readFileSync("src/App.tsx", "utf8").replace(/\r\n/g, "\n");
const DIALOG = readFileSync("src/dialogs/NetworkDiagnoseDialog.tsx", "utf8").replace(/\r\n/g, "\n");
const STRIP = readFileSync("src/shell/StatusStrip.tsx", "utf8").replace(/\r\n/g, "\n");
const PALETTE = readFileSync("src/components/CommandPalette.tsx", "utf8").replace(/\r\n/g, "\n");
const SETTINGS = readFileSync("src/views/SettingsView.tsx", "utf8").replace(/\r\n/g, "\n");

test("ui store: netDiagOpen 是 store 状态而不是某个组件的局部 state", () => {
  // 三个互不相识的入口（状态栏弹层、命令面板、设置页）都要开它，其中两个
  // 没有通向根组件的 prop 线——这正是它必须在 store 里的原因。
  assert.ok(UI_STORE.includes("netDiagOpen: false,"), "初始为关");
  assert.ok(UI_STORE.includes("setNetDiagOpen: (netDiagOpen) => set({ netDiagOpen }),"));
  const closeBranch = UI_STORE.indexOf("if (s.netDiagOpen) {");
  const envBranch = UI_STORE.indexOf("if (s.envOpen) {");
  const projectBranch = UI_STORE.indexOf("if (s.openSlug) {");
  assert.ok(closeBranch > 0, "closeTopLayer 认这一层");
  assert.ok(
    projectBranch < closeBranch && closeBranch < envBranch,
    "次序：项目面板 → 网络诊断 → 环境弹层",
  );
});

test("App: 对话框由 netDiagOpen 挂载，关闭回写 store，且渲染可识别标题（F2）", () => {
  assert.ok(
    // The dialog is code-split (a `lazy(() => import(...))`) so it stays off the first
    // paint; what this test must pin is the *mount gate*, not the import syntax.
    APP.includes('import("./dialogs/NetworkDiagnoseDialog")'),
  );
  assert.ok(APP.includes("<NetworkDiagnoseDialog onClose={() => setNetDiagOpen(false)} />"));
  assert.ok(APP.includes("{netDiagOpen && ("), "挂载条件就是 store 的标志位");
  // F2: the mount condition alone does not prove the dialog renders *content*.
  // Assert the dialog's title line is present in the source — a dialog that
  // mounts but renders nothing is the "mounted" trap the r18-o4 census
  // lesson documents (the assertion must name what it sees, not just that
  // something is on screen).
  assert.ok(
    DIALOG.includes('title={t("netdiag.title")}'),
    "dialog renders its i18n title, not just an empty shell",
  );
});

test("对话框: 打开即 force 探测——「诊断」按钮不许返回缓存事实", () => {
  assert.ok(
    DIALOG.includes('invoke<EnvironmentReport>("environment", { force: true })'),
    "每一次打开 / 重新诊断都绕过 5 秒链路缓存（n2-1 给后端加的 force 参数就为这件事）",
  );
  assert.ok(DIALOG.includes("setNonce((n) => n + 1)"), "重新诊断走 nonce 重跑 effect");
  assert.ok(DIALOG.includes("diagnoseNetwork("), "结论来自纯规则模块，不在组件里另写一份");
  assert.ok(DIALOG.includes("netDiagText(t, issue)"), "句子跟随界面语言行");
});

test("对话框: 探针失败是 probeFailed 状态，不是空清单的「没问题」", () => {
  assert.ok(
    DIALOG.includes("setState({ kind: \"ready\", env })"),
    "失败把 env 置 null 而不是保留旧值",
  );
  assert.ok(DIALOG.includes('t("netdiag.probeFailed")'), "并为 null 画一张不同的脸");
  // 空态只在有数据（env != null）且零结论时出现——`ready &&` 在两种状态里
  // 都出现了，这里钉的是「null 分支与空态分支是两段互斥 JSX」。
  assert.ok(DIALOG.includes("ready === null &&"), "null 走失败分支");
  assert.ok(DIALOG.includes("ready && issues.length === 0"), "空态要求真的拿到了数据");
});

test("对话框: 打开网络设置 = 先关自己再跳——两层浮层不叠着争 Escape", () => {
  const openIdx = DIALOG.indexOf("function openNetworkSettings() {");
  assert.ok(openIdx > 0);
  const body = DIALOG.slice(openIdx, openIdx + 260);
  assert.ok(
    body.indexOf("onClose();") < body.indexOf('go("settings")'),
    "关自己（onClose）在跳转之前，镜像 RepoDiagnoseDialog 的 onJump 约定",
  );
  assert.ok(body.includes('setSettingsSection("network")'), "并指名网络设置 section");
  assert.ok(DIALOG.includes("navigator.clipboard.writeText"), "复制走剪贴板");
  assert.ok(DIALOG.includes('t("settings.page.failuresClipboardDenied")'), "剪贴板被拒复用既有文案");
});

test("入口: 状态栏弹层、命令面板、设置页各有一条通往对话框的路", () => {
  assert.ok(
    STRIP.includes("useUI.getState().setNetDiagOpen(true)"),
    "弹层里的按钮 = 网络事实的就地出口",
  );
  const stripClick = STRIP.indexOf("useUI.getState().setNetDiagOpen(true)");
  assert.ok(
    STRIP.lastIndexOf("setOpen(false);", stripClick) > 0,
    "打开对话框前先收起弹层：不是三层浮层叠在一起",
  );

  assert.ok(PALETTE.includes('id: "act-netdiag"'), "命令面板动作");
  assert.ok(PALETTE.includes('label: t("netdiag.title")'), "新动作文案走 t()——不加硬编码新债");
  assert.ok(PALETTE.includes('t("netdiag.paletteNote")'));
  assert.ok(!PALETTE.includes('label: "网络诊断"'), "且没有把中文直接写进代码");

  assert.ok(SETTINGS.includes("useUI.getState().setNetDiagOpen(true)"), "设置页 ActionRow");
  assert.ok(
    SETTINGS.includes('placeholder={t("settings.page.proxyPlaceholder")}'),
    "顺带把网络节最后一条硬编码占位符接进词表（棘轮只许下降的等额抵偿）",
  );
  assert.ok(!SETTINGS.includes("例如 http://127.0.0.1:26501"), "旧字面量已不在代码里");
});
