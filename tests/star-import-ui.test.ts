/**
 * r18 N3 — 星标导入的接线：面板挂在哪、读取走哪条命令、勾选怎么变成下载。
 *
 * 后端行为钉在 `src-tauri/src/stars.rs` 的离线测试里（分页规则、错误映射、
 * 守卫不触网）；词条在 `tests/i18n.test.ts` 的 5k 段逐字节钉住。本文件钉住
 * 前端接线里最容易被后来者悄悄改坏的几行：命令名与参数、token 缺失时的去
 * 向（跳设置页而不是空手重试）、「已在库中 / 在队列中」的过滤发生在**点击
 * 时**（不是在渲染时拿着快照就下单）、以及页码乱序守卫。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL = readFileSync("src/components/StarImportPanel.tsx", "utf8").replace(/\r\n/g, "\n");
const ADD = readFileSync("src/views/AddRepoView.tsx", "utf8").replace(/\r\n/g, "\n");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8").replace(/\r\n/g, "\n");
const TYPES = readFileSync("src/types.ts", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const COMMANDS = readFileSync("scripts/check-commands.mjs", "utf8").replace(/\r\n/g, "\n");

test("契约: list_starred_repos 调用与 StarPage 类型两端一致", () => {
  assert.ok(
    PANEL.includes('invoke<StarPage>("list_starred_repos", { page: p })'),
    "命令名与参数就是 Rust 侧注册的那个",
  );
  assert.ok(TYPES.includes("export type StarPage = {"), "共享类型在 types.ts");
  for (const field of ["items: RepoHit[]", "hasMore: boolean", "page: number", "remaining: number | null", "resetIn: number | null"]) {
    assert.ok(TYPES.includes(field), `StarPage 字段 ${field}（camelCase 与 serde rename_all 对应）`);
  }
});

test("词表: 面板的每条文案都有字面量调用点，且没有绕过 t() 的中文字面量", () => {
  const KEYS = [
    "stars.source",
    "stars.title",
    "stars.hint",
    "stars.load",
    "stars.reload",
    "stars.loading",
    "stars.loadMore",
    "stars.empty",
    "stars.filterPlaceholder",
    "stars.filterEmpty",
    "stars.owned",
    "stars.queued",
    "stars.archived",
    "stars.goToken",
    "stars.loaded",
    "stars.remaining",
    "stars.selected",
    "stars.selectAll",
    "stars.clearSelected",
    "stars.download",
    "stars.enqueued",
    "stars.allSkipped",
  ];
  for (const k of KEYS) {
    assert.ok(PANEL.includes(`t("${k}"`), `${k} 在面板里被直接调用`);
  }
  // 22 键：r21-o3-2 起键名只在 ZH 写一遍（EN 是按位置对齐的值数组，不再有键名）。
  // 计数钉住「重复写两遍」不会偷偷回来，也钉住「删了却留着调用点」。
  assert.equal((I18N.match(/"stars\.[a-zA-Z]+":/g) ?? []).length, KEYS.length);
  // 徽标与按钮文案不许退回硬编码（棘轮管全局计数，这里钉住具体这几条）。
  assert.ok(!PANEL.includes('"已在库中"') && !PANEL.includes('"在队列中"') && !PANEL.includes('"已归档"'));
});

test("token 缺失：由稳定 ASCII 标记识别，去设置页而不是反复重试", () => {
  assert.ok(
    PANEL.includes('error.includes("GitHub Token")'),
    "识别用后端保证的 ASCII 标记，不依赖整句措辞",
  );
  const setSection = PANEL.indexOf('setSettingsSection("token")');
  const go = PANEL.indexOf('go("settings")');
  assert.ok(setSection > 0 && go > setSection, "先指名 token 节再跳设置页");
  assert.ok(PANEL.includes('t("stars.goToken")'), "跳转按钮的文案走词表");
});

test("已在库/已在队列：过滤发生在点击时，不是渲染快照", () => {
  assert.ok(
    PANEL.includes("const picks = items.filter((i) => selected.has(i.fullName) && !isBlocked(i.fullName));"),
    "下载前重新过一遍库与队列——勾选之后这两边都可能动",
  );
  assert.ok(PANEL.includes("disabled={blocked}"), "被挡的行复选框禁用");
  assert.ok(PANEL.includes('toast.info(t("stars.allSkipped"))'), "全被挡住给一句总结，不是每个仓库一条错误");
  assert.ok(PANEL.includes('toast.success(t("stars.enqueued", { n: picks.length }))'));
});

test("乱序守卫与选择清理：慢页不追加重载后的清单", () => {
  assert.ok(PANEL.includes("const mine = ++seq.current;"), "每次请求领号");
  assert.ok(PANEL.includes("if (mine !== seq.current) return;"), "过期响应直接丢弃");
  const reloadIdx = PANEL.indexOf("const reload = () => {");
  assert.ok(reloadIdx > 0);
  const body = PANEL.slice(reloadIdx, reloadIdx + 300);
  assert.ok(body.includes("setSelected(new Set());"), "重载清空选择：旧勾选指向的清单已经换了一份");
});

test("入口: 添加页挂载面板，注册表与命令数下限同步", () => {
  assert.ok(ADD.includes("const StarImportPanel = lazy(() =>"));
  assert.ok(ADD.includes("<StarImportPanel onDownload={onDownload} owned={owned} />"), "复用与搜索同一份 owned 集合");
  assert.ok(CUSTOMIZE.includes('id: "add-stars-panel"'), "面板可定制（注册表 141 条）");
  assert.ok(!COMMANDS.includes('list_starred_repos: "bridge'), "check-commands 的桥接条目已按其承诺删除");
  // floor = live（check-commands.mjs 的纪律）：这行断言钉的是「提交那一刻的实测值」，
  // 所以每次接线抬 floor 时它跟着改——r21-N2-1 接 docker_status、r21-N2-2 接
  // project_has_compose、r21-N1 接 repo_grep 三条并入后是 83，r21-N3-1 接
  // register_deeplink 后是 84，r21-N1b-2 接 check_dependencies（依赖更新面板直调）后是 85，
  // r21-N4-2 接 net_status（状态条实时连通）后是 86。
  assert.ok(
    COMMANDS.includes("const INVOKED_FLOOR = 103;") && COMMANDS.includes("const REGISTERED_FLOOR = 103;"),
    "floor 已抬到实测值 103/103（r21 的六条接线之后，r33 又加了 repo_grep_many / repo_release / license_overview；理由写在 check-commands.mjs 的注释里）",
  );
});
