/**
 * r21 N2-1 — 设置页 Docker 诊断面板的接线。
 *
 * 本文件钉两层：
 *
 *   - **行为**：`src/lib/docker-status.ts` 的事实清单用假的 `docker_status` 载荷
 *     直接跑（这就是本仓的 fake-invoke 写法——载荷是假的，规则是真的），钉住
 *     「哪些行出现」「哪一格算 ok」「没答话绝不等于正常」这三件最易被改坏的事；
 *   - **结构**：面板挂在哪、命令名与参数、词表 15 键两边齐、元素登记、
 *     check-commands 的 allowlist 与 floor 同步（接线即撤封面，floor 抬到实测值）。
 *
 * Rust 侧的字段名契约由 `src-tauri/src/docker.rs` 的单测钉住，不在此重复。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dockerFacts } from "../src/lib/docker-status.ts";
import type { DockerStatus } from "../src/types.ts";

const PANEL = readFileSync("src/views/settings/DockerDiagnosticsSection.tsx", "utf8").replace(/\r\n/g, "\n");
const VIEW = readFileSync("src/views/SettingsView.tsx", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8").replace(/\r\n/g, "\n");
const COMMANDS = readFileSync("scripts/check-commands.mjs", "utf8").replace(/\r\n/g, "\n");
const TYPES = readFileSync("src/types.ts", "utf8").replace(/\r\n/g, "\n");
const RUST = readFileSync("src-tauri/src/docker.rs", "utf8").replace(/\r\n/g, "\n");

/** 一台「装了 docker、daemon 没在跑、compose 正常」的机器——本机就是这个形状。 */
function status(over: Partial<DockerStatus> = {}): DockerStatus {
  return {
    cliFound: true,
    version: "Docker version 28.4.0, build d8eb465",
    daemonRunning: false,
    daemonError: "error during connect: ... dockerDesktopLinuxEngine",
    composeVersion: "Docker Compose version v2.39.2-desktop.1",
    composeError: null,
    runningContainers: 0,
    imageCount: 0,
    ...over,
  };
}

test("事实清单: 没装 docker 只画一行，且那一行不是 ok", () => {
  const facts = dockerFacts(status({ cliFound: false, version: null, composeVersion: null, composeError: null }));
  assert.equal(facts.length, 1, "守护进程与 compose 的真原因都是没装 docker，重复画三行会读成三个独立故障");
  assert.equal(facts[0]!.id, "cli");
  assert.equal(facts[0]!.state, "absent", "absent 是引导状态，不是 ok，也不是 down");
});

test("事实清单: daemon 与 compose 是两条互不遮挡的事实", () => {
  const facts = dockerFacts(status());
  assert.deepEqual(
    facts.map((f) => [f.id, f.state]),
    [
      ["cli", "ok"],
      ["daemon", "down"],
      ["compose", "ok"],
    ],
    "compose 是纯客户端探针，daemon 没在跑它照样给结论",
  );
  assert.equal(facts[1]!.detail, "error during connect: ... dockerDesktopLinuxEngine", "down 显示后端原话");
  assert.equal(facts[1]!.containers, undefined, "daemon 不可用时后端把计数置 0——那是「没查」，不进清单");
});

test("事实清单: 守护进程在跑才带计数", () => {
  const up = dockerFacts(status({ daemonRunning: true, daemonError: null, runningContainers: 3, imageCount: 12 }));
  const daemon = up.find((f) => f.id === "daemon")!;
  assert.equal(daemon.state, "ok");
  assert.equal(daemon.containers, 3);
  assert.equal(daemon.images, 12);
});

test("事实清单: 后端连原因都没给时是 unknown，不是 ok", () => {
  const facts = dockerFacts(status({ composeVersion: null, composeError: null }));
  const compose = facts.find((f) => f.id === "compose")!;
  assert.equal(compose.state, "unknown");
  assert.equal(compose.detail, null, "detail 为 null → 组件回落到 settings.page.dockerNoReason，仍不写「正常」");
});

test("挂载: 设置页诊断段渲染面板，命令名与参数就是注册的那个", () => {
  assert.ok(VIEW.includes("const DockerDiagnosticsSection = lazy(() =>"));
  assert.ok(VIEW.includes("activeSection === \"diagnostics\" &&"), "挂在诊断段，不是网络段");
  assert.ok(VIEW.includes("<DockerDiagnosticsSection />"), "并且真的被渲染");
  assert.ok(
    PANEL.includes('invoke<DockerStatus>("docker_status")'),
    "命令名与返回类型就是 src-tauri/src/docker.rs 注册的那个",
  );
  assert.ok(PANEL.includes("regId=\"settings-group-docker\""), "面板整块可定制");
  assert.ok(CUSTOMIZE.includes('id: "settings-group-docker"'), "登记表有它（check-registry 会反向查）");
});

test("措辞纪律: 没装是引导、探针失败另有句子、计数只在 daemon ok 时出现", () => {
  // 1) 未安装走引导文案（不是错误红）：absent 分支单独 return 它。
  const absentBranch = PANEL.indexOf("if (f.state === \"absent\") return t(\"settings.page.dockerCliMissingHint\");");
  assert.ok(absentBranch > 0, "引导文案只在 absent 分支返回");
  // 2) 探针本身抛错有自己的状态，不复用 absent 的引导。
  assert.ok(PANEL.includes("probe.kind === \"failed\" &&"), "失败态是一段独立 JSX");
  assert.ok(PANEL.includes('t("settings.page.dockerProbeFailed", { note: probe.note })'));
  // 3) 计数行只在 daemon state === "ok" 里拼。
  const countsIdx = PANEL.indexOf('t("settings.page.dockerCounts"');
  assert.ok(countsIdx > 0);
  const guardIdx = PANEL.lastIndexOf("if (f.state === \"ok\")", countsIdx);
  assert.ok(guardIdx > 0 && guardIdx < countsIdx, "计数被 state === \"ok\" 守着");
  // 4) 面板不许出现一句笼统的「正常」——不可判定时尤其不许。（只看代码行：
  //    文件头的注释里写着这条纪律本身，注释不算渲染出来的字。）
  assert.ok(!PANEL.includes('"正常"'), "面板里没有任何一处把状态概括成「正常」的字符串字面量");
});

test("词表: 15 键双语齐、每键都有字面量调用点", () => {
  const KEYS = [
    "settings.page.dockerGroupTitle",
    "settings.page.dockerFootnote",
    "settings.page.dockerChecking",
    "settings.page.dockerProbeFailed",
    "settings.page.dockerCliOk",
    "settings.page.dockerCliMissing",
    "settings.page.dockerCliMissingHint",
    "settings.page.dockerDaemonUp",
    "settings.page.dockerDaemonDown",
    "settings.page.dockerCounts",
    "settings.page.dockerComposeOk",
    "settings.page.dockerComposeMissing",
    "settings.page.dockerNoReason",
    "settings.page.dockerRefresh",
    "settings.page.dockerRefreshHint",
  ];
  for (const k of KEYS) assert.ok(PANEL.includes(`t("${k}"`), `${k} 在面板里被直接调用`);
  // r21-o3-2 之后键只写一遍（EN 是按 ZH 键序的值数组）：声明行计数期望 = 键数 × 1；
  // EN 侧若长回第二张键表会变成 ×2 而变红。双语齐由 i18n-diff-analysis 与
  // bundle-diet-2（值数组等长）保证。
  assert.equal(
    (I18N.match(/"settings\.page\.docker[A-Za-z]+":/g) ?? []).length,
    KEYS.length,
    "15 键各声明一次：键名写第二遍 = r21-o3-2 的 −25 KB 整笔退回",
  );
});

test("IPC 同步: docker_status 的封面已撤，floor 抬到实测值", () => {
  assert.ok(
    !COMMANDS.includes('docker_status: "R19-N1'),
    "接了调用者的命令不能再躺在 allowlist 里——stale 检查也会这么判",
  );
  // 具体数字随下一条接线走（r21-N2-2 接 project_has_compose 后 floor = 82），
  // 这里钉的是「floor 被抬到 ≥ 本面板接线那一刻的实测值」这一纪律本身：
  // 低于实测值的 floor 等于没在数。
  const invoked = /const INVOKED_FLOOR = (\d+);/.exec(COMMANDS);
  const registered = /const REGISTERED_FLOOR = (\d+);/.exec(COMMANDS);
  assert.ok(invoked && registered, "两个 floor 常量都还在");
  assert.ok(Number(invoked[1]) >= 81, `invoked floor ${invoked[1]} 至少要是接线后的实测值 81`);
  assert.equal(registered[1], "103", "registered 侧 = live：r21 收口 87；r33 加 repo_grep_many / repo_release / license_overview 后 103");
});

test("契约: TS 类型字段与 Rust serde rename 两端一致", () => {
  assert.ok(RUST.includes('#[serde(rename_all = "camelCase")]'), "DockerStatus 补了 camelCase rename");
  assert.ok(RUST.includes("pub compose_version: Option<String>"), "compose 探针字段在 Rust 侧");
  for (const f of [
    "cliFound: boolean;",
    "version: string | null;",
    "daemonRunning: boolean;",
    "daemonError: string | null;",
    "composeVersion: string | null;",
    "composeError: string | null;",
    "runningContainers: number;",
    "imageCount: number;",
  ]) {
    assert.ok(TYPES.includes(f), `src/types.ts 缺 ${f}`);
  }
  // 探针与 daemon 无关，也不该被 daemon 的结论挡住：compose_probe 只以 cli_found 为门。
  assert.ok(RUST.includes("let (compose_version, compose_error) = if cli_found {"), "compose 探针只看 CLI 在不在");
  assert.ok(RUST.includes("compose_probe()"), "docker_status 真的调用了探针");
});
