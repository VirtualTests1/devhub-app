/**
 * r21-n1b-3 — 设置 → 依赖更新面板的接线（结构层）。
 *
 * 面板的行为层在两个纯模块里（`tests/deps-aggregate.test.ts` 钉合并规则、
 * `tests/deps-scan.test.ts` 钉调度规则），本文件钉的是**接线**：目录行、
 * 挂载点、命令名、元素登记、词表键、竞态闸门、IPC 同步——全是「改坏了
 * gate 会红、但纯模块测试看不见」的那一层。与 `tests/docker-panel-ui.test.ts`
 * 同一套写法：读源码、比对字符串，不挂 React（本仓没有 DOM 测试运行器）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL = readFileSync("src/views/settings/DepsUpdateSection.tsx", "utf8").replace(/\r\n/g, "\n");
const SCAN = readFileSync("src/lib/deps-scan.ts", "utf8").replace(/\r\n/g, "\n");
const VIEW = readFileSync("src/views/SettingsView.tsx", "utf8").replace(/\r\n/g, "\n");
const CATALOG = readFileSync("src/settingsCatalog.tsx", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8").replace(/\r\n/g, "\n");
const COMMANDS = readFileSync("scripts/check-commands.mjs", "utf8").replace(/\r\n/g, "\n");

test("挂载: 目录行、union、设置页挂载、元素登记四处齐全", () => {
  assert.ok(CATALOG.includes("| \"deps\""), "SettingsSectionId union 有 deps");
  assert.ok(
    CATALOG.includes('{ id: "deps", label: "依赖更新", icon: <PackageSearch'),
    "SETTINGS_SECTIONS 有目录行，label 与词表逐字节一致（i18n.test 会再对一次）",
  );
  assert.ok(VIEW.includes("const DepsUpdateSection = lazy(() =>"));
  assert.ok(VIEW.includes('activeSection === "deps" && (') && VIEW.includes("<DepsUpdateSection repos={repos} />"));
  assert.ok(PANEL.includes("regId=\"settings-group-deps\""), "面板整块可定制");
  assert.ok(PANEL.includes("sectionId=\"deps\""), "深链锚点是 deps");
  assert.ok(CUSTOMIZE.includes('id: "settings-group-deps"'), "登记表有它（check-registry 会反向查）");
});

test("IPC: check_dependencies 直调、封面已撤、floor 抬到 86", () => {
  assert.ok(
    PANEL.includes('invoke<DependencyReport>("check_dependencies", { slug })'),
    "命令名字面量必须留在 invoke(…) 的调用位置——扫描正则就是按这个形状找的",
  );
  assert.ok(
    !/^[\t ]*check_dependencies[\t ]*:/m.test(COMMANDS),
    "接了直调调用者的命令不能再躺在 allowlist 里——stale 检查也会这么判",
  );
  assert.ok(
    COMMANDS.includes("const INVOKED_FLOOR = 107;") && COMMANDS.includes("const REGISTERED_FLOOR = 107;"),
    "floor = live：r21 收口 86/87；r34 四条新命令后 107/107（理由见 check-commands.mjs）",
  );
});

test("调度: DEPS_WIDTH=3、取消闸门、按入序出结果三件都在源码里", () => {
  assert.match(SCAN, /export const DEPS_WIDTH = 3;/, "并发默认 3，面板脚注渲染这个数");
  assert.ok(
    SCAN.includes("while (active < width && next < slugs.length && opts.isCancelled?.() !== true)"),
    "调度循环每发一发前看取消旗——取消只停新发，不 abort 在途",
  );
  assert.ok(
    SCAN.includes("for (const slug of slugs) {\n        const r = answered.get(slug);"),
    "出结果按调用方的顺序，不按网络完成的顺序",
  );
  assert.ok(
    SCAN.includes("manager: \"\"") && SCAN.includes("outdated: [],"),
    "拒绝合成 manager:\"\" 错误报告——「没答话」不是「没有依赖」",
  );
});

test("竞态: seq 闸门在面板里，卸载即作废", () => {
  assert.ok(PANEL.includes("const seqRef = useRef(0);"), "每个扫描一个序号");
  assert.ok(
    PANEL.includes("if (seqRef.current !== seq) return;"),
    "onStart/onAnswer/收尾三处都比对序号——旧扫描的回答不许污染新扫描",
  );
  assert.ok(
    PANEL.includes("seqRef.current += 1;"),
    "卸载时把闸门永久关上（useEffect 清理）",
  );
  assert.ok(PANEL.includes("cancelRef.current = true;"), "取消按钮只翻旗，不 setState 越权");
});

test("词表: 34 键各声明一次、面板里各有字面量调用点", () => {
  const KEYS = [
    "settings.section.deps",
    "deps.footnote",
    "deps.emptyTitle",
    "deps.emptyHint",
    "deps.reposTitle",
    "deps.selectAll",
    "deps.selectionCount",
    "deps.selectRepo",
    "deps.scan",
    "deps.scanHint",
    "deps.rescan",
    "deps.cancel",
    "deps.scanning",
    "deps.idleTitle",
    "deps.idleHint",
    "deps.statePending",
    "deps.stateChecking",
    "deps.stateDone",
    "deps.stateFailed",
    "deps.stateCurrent",
    "deps.repoOutdated",
    "deps.summary",
    "deps.cancelled",
    "deps.errorsTitle",
    "deps.managersTitle",
    "deps.managerLine",
    "deps.managerNone",
    "deps.managerUnknown",
    "deps.packagesTitle",
    "deps.allCurrent",
    "deps.listAria",
    "deps.truncatedNote",
    "deps.readingsTitle",
    "settings.adjustBlock",
  ];
  for (const k of KEYS) {
    assert.ok(
      PANEL.includes(`t("${k}"`) || I18N.includes(`"${k}":`),
      `${k} 没有字面量调用点也没有声明`,
    );
  }
  // 34 个 deps.* + settings.section.deps + settings.adjustBlock 各声明一次。
  for (const k of KEYS) {
    const declared = (I18N.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(declared, 1, `${k} 在词表里声明了 ${declared} 次（应当恰好 1 次）`);
  }
  // settings.adjustBlock 的接线点在 SettingsRows（齿轮提示），不在本面板。
  const ROWS = readFileSync("src/components/SettingsRows.tsx", "utf8");
  assert.ok(ROWS.includes('t("settings.adjustBlock", { id: regId })'), "齿轮提示走词表");
  assert.ok(!ROWS.includes("调整这个区块"), "SettingsRows 里不再有未接线的中文字面量");
});

test("措辞纪律: 面板代码行零中文，manager 两态各有其词", () => {
  // 与 zh-hardcode 棘轮同一条规则：去块注释（含多行）与整行 // 注释后，代码行里
  // 不允许再有中文字面量。自己实现一遍而不是 import 棘轮——棘轮是计数器不是库，
  // 两个目的（计数 vs 断言为零）共用一份实现反而会让断言失去独立性。
  const codeLines = (src: string): string[] => {
    const kept: string[] = [];
    let inBlock = false;
    for (const raw of src.split(/\r?\n/)) {
      let line = raw;
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end < 0) {
          kept.push("");
          continue;
        }
        line = line.slice(end + 2);
        inBlock = false;
      }
      const open = line.indexOf("/*");
      if (open >= 0) {
        const close = line.indexOf("*/", open + 2);
        if (close >= 0) line = line.slice(0, open) + line.slice(close + 2);
        else {
          inBlock = true;
          line = line.slice(0, open);
        }
      }
      if (/^\s*\/\//.test(line)) line = "";
      kept.push(line);
    }
    return kept;
  };
  const cjk = codeLines(PANEL).filter((l) => /[一-鿿]/.test(l));
  assert.deepEqual(cjk, [], "面板源码的代码行里不允许出现中文字面量——全部走 t()");
  assert.ok(PANEL.includes('t("deps.managerNone")'), "none（没有清单）有自己的词");
  assert.ok(PANEL.includes('t("deps.managerUnknown")'), "空串（没答话）有自己的词");
  assert.ok(
    PANEL.includes("if (manager === \"\") return t(\"deps.managerUnknown\");"),
    "空串先于 none 判断——两个分支不可互换",
  );
  // 「全是最新」只在至少一个仓库干净答完时才说。
  assert.ok(
    PANEL.includes("agg.totals.errors < agg.totals.repos"),
    "allCurrent 被「有仓库答上了」守着——全军覆没时只有错误区",
  );
});
