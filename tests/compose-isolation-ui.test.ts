/**
 * r21 N2-2 — 项目设置页 Docker 隔离面板的接线。
 *
 * 规则本身钉在 `tests/compose.test.ts`（命名折叠、override 文本、命令串、
 * composeDeclarations 的三种答案）。本文件钉**接线**：
 *
 *   - 谁渲染它、探针传了什么路径、读文件用哪条命令；
 *   - 展示的每一项都出自 `src/lib/compose.ts`，面板里没有第二份拼名字的逻辑；
 *   - 只读不写（没有 write_text_file，落盘步骤写在 saveHint 里让本人执行）；
 *   - 词表 21 键双语齐、每键有字面量调用点、元素已登记；
 *   - check-commands 的封面与 floor 同步，docs 有「已进界面」小节。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL = readFileSync("src/components/RepoComposePanel.tsx", "utf8").replace(/\r\n/g, "\n");
const DIALOG = readFileSync("src/dialogs/ProjectSettingsDialog.tsx", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8").replace(/\r\n/g, "\n");
const COMMANDS = readFileSync("scripts/check-commands.mjs", "utf8").replace(/\r\n/g, "\n");

test("挂载: 项目设置对话框渲染面板，并把项目路径交给它", () => {
  assert.ok(DIALOG.includes('import { RepoComposePanel } from "../components/RepoComposePanel";'));
  assert.ok(
    DIALOG.includes(
      "<RepoComposePanel slug={slug} path={detail?.path ?? card.path ?? null} />",
      ),
    "路径来自 repo_detail（优先）或卡片兜底——project_has_compose 要的就是目录",
  );
  assert.ok(PANEL.includes('reg("project-row-compose")'), "面板整块可定制");
  assert.ok(CUSTOMIZE.includes('id: "project-row-compose"'), "登记表有它（check-registry 反向查）");
});

test("接线: project_has_compose 找文件，read_text_file 读它", () => {
  assert.ok(
    PANEL.includes('await invoke<string | null>("project_has_compose", { path })'),
    "命令名与参数就是 src-tauri/src/docker.rs 注册的那个",
  );
  assert.ok(
    PANEL.includes('await invoke<string>("read_text_file", { path: `${path}/${file}` })'),
    "路径拼接与 RepoReadmeDialog 一致（同一条带 path_guard 的读命令）",
  );
  // 没有 compose 文件的仓库整个面板不出现：这一维对它无话可说，
  // 留一个空标题比不说更糟。
  assert.ok(
    PANEL.includes('if (probe.kind === "checking" || probe.kind === "none") return null;'),
    "checking / none 都不画",
  );
});

test("只读: 面板里没有写文件能力，落盘步骤交给本人", () => {
  // 头注释里会提到那条写命令（说明为什么不用它），所以钉的是**调用形态**：
  // 双引号包起来的命令名 + 面板里唯一的 invoke 只有读的那两条。
  assert.ok(!PANEL.includes('"write_text_file"'), "不写用户的仓库（REQUIREMENTS §5.2 不污染用户环境）");
  const invokes = [...PANEL.matchAll(/invoke(?:<[^()]*>)?\(\s*["']([a-z0-9_]+)["']/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(invokes)].sort(),
    ["project_has_compose", "read_text_file"],
    "面板只发这两条，都是只读的",
  );
  // 覆写文件的保存方式写在 footnote 里：预览 → 自己存成 devhub-isolation.yml → 跑命令。
  assert.ok(PANEL.includes('t("compose.saveHint")'), "保存步骤是明说的，不是让人猜");
  assert.ok(PANEL.includes("devhub-isolation.yml"), "命令里的 -f 名字与预览标题同名");
});

test("产物: 每一项都出自 src/lib/compose.ts，面板不另写一份拼名字的逻辑", () => {
  for (const fn of [
    "composeProjectName",
    "composeNetworkName",
    "composeVolumeName",
    "isolatedOverride",
    "isolatedComposeCommand",
    "composeDeclarations",
  ]) {
    assert.ok(PANEL.includes(fn), `${fn} 被面板调用`);
  }
  assert.ok(PANEL.includes("import {") && /from "\.\.\/lib\/compose"/.test(PANEL), "且从同一个模块 import");
  // 复制走全仓同一条契约：成功/失败各一句 toast，失败文案复用既有键。
  assert.ok(PANEL.includes("navigator.clipboard.writeText"), "复制走剪贴板");
  assert.ok(PANEL.includes('t("settings.page.failuresClipboardDenied")'), "剪贴板被拒复用既有文案");
  assert.ok(PANEL.includes('t("compose.copied")'), "成功提示走词表");
});

test("三处不知道各有各的脸: 探针失败 / 读失败 / 结构没认出", () => {
  assert.ok(PANEL.includes('probe.kind === "failed" ? ('), "探针失败是一段独立 JSX");
  assert.ok(PANEL.includes('t("compose.probeFailed", { note: probe.note })'));
  assert.ok(PANEL.includes("probe.readNote &&"), "读失败有名有姓地显示");
  assert.ok(PANEL.includes('t("compose.readFailed", { file: probe.file, note: probe.readNote })'));
  // 结构没认出（composeDeclarations 的 null）永远走警示句，不会被画成「没有」。
  assert.ok(PANEL.includes("declarations.volumes === null ? ("), "卷清单三态互斥");
  assert.ok(PANEL.includes('t("compose.volumesUnknown")'));
  assert.ok(PANEL.includes("declarations.services === null &&"), "服务清单同理");
  assert.ok(PANEL.includes('t("compose.servicesUnknown")'));
  assert.ok(PANEL.includes('t("compose.noVolumes")'), "真·没有卷是另一句");
});

test("词表: 21 键双语齐、每键都有字面量调用点", () => {
  const KEYS = [
    "compose.sectionTitle",
    "compose.probeFailed",
    "compose.fileTitle",
    "compose.readFailed",
    "compose.projectName",
    "compose.projectNameHint",
    "compose.networkName",
    "compose.networkNameHint",
    "compose.volumesTitle",
    "compose.volumesHint",
    "compose.noVolumes",
    "compose.volumesUnknown",
    "compose.servicesUnknown",
    "compose.overrideTitle",
    "compose.overrideHint",
    "compose.copyOverride",
    "compose.commandTitle",
    "compose.commandHint",
    "compose.copyCommand",
    "compose.copied",
    "compose.saveHint",
  ];
  for (const k of KEYS) assert.ok(PANEL.includes(`t("${k}"`), `${k} 在面板里被直接调用`);
  // r21-o3-2 之后键只写一遍（EN 是按 ZH 键序的值数组，没有第二张键表）：声明行计数
  // 期望 = 键数 × 1；若有人把 EN 变回带键对象，这里会变成 ×2 而变红（bundle-diet-1
  // 对全表做同款守卫）。双语齐由上面的 tFor 逐字节断言与 i18n-diff-analysis 保证。
  assert.equal(
    (I18N.match(/"compose\.[a-zA-Z]+":/g) ?? []).length,
    KEYS.length,
    "21 键各声明一次：键名写第二遍 = r21-o3-2 的 −25 KB 整笔退回",
  );
  // 新面板不许把中文直接写进 .tsx（zh-hardcode 棘轮管全局，这里钉住本文件）。
  const code = PANEL.split("\n")
    .filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l))
    .join("\n");
  assert.ok(!/[\u4e00-\u9fff]/.test(code), "代码行里没有裸中文字面量——都走 t()");
});

test("IPC 同步: project_has_compose 的封面已撤，floor 抬到实测值 103", () => {
  assert.ok(
    !COMMANDS.includes('project_has_compose: "R19-N1'),
    "接了调用者的命令不能再躺在 allowlist 里",
  );
  assert.ok(
    COMMANDS.includes("const INVOKED_FLOOR = 103;") && COMMANDS.includes("const REGISTERED_FLOOR = 103;"),
    "floor = live：r21 接线后 86/87；r33 增加 repo_grep_many / repo_release / license_overview 后实测 103/103（抬升理由写在 check-commands.mjs 的注释里）",
  );
});
