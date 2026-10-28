/**
 * 项目设置对话框接线（r21-o2-1）：`ProjectSettingsDialog.tsx` 里剩下的 99 行中文字面量
 * 全部搬进 `src/lib/i18n.ts` 的 `psd.*` 命名空间之后，把它们逐字节钉死在这里。
 *
 * ## 为什么另开一个文件，而不是塞进 `tests/i18n.test.ts`
 *
 * `i18n.test.ts` 已经有 1800 行，按「每一批接线一个 test」的节奏在长；这一批是 r21
 * 方向的产物，拆开之后失败信息能直接读出「是哪一小方向把哪句话改了」。两个文件用的
 * 是同一套断言方式（`tFor("zh-CN", key)` 对着 `originals` 表逐字节比），词表键的登记 /
 * zh-en 配对 / 接线点反查仍然由 `i18n.test.ts` 统一管，这里不重复。
 *
 * ## 这一批的三处特殊处理
 *
 *   1. **复用既有键**：`置顶`、`从项目墙隐藏`、`逐步确认`、`启动命令`、`默认终端`、
 *      `默认 IDE`、`虚拟环境`、`工作树`、`打开`、`打开目录失败`、`保存失败：{msg}`、
 *      `并行` / `顺序` 这几条的 zh 值与被替换的字面量逐字节相同，词表里已经有它们，
 *      于是**不另存一份**（另存一份就是同一个字符串的两个真相）。断言写在 `reused`
 *      表里：钉的是「它仍是这个键、仍是这个字」。
 *   2. **四段说明文字**拆成 Lead / Tail（Python 段拆成 Lead / Mid / Outside / Join /
 *      Tail）：原句里 `<code>`、`<strong>` 之间的换行与缩进由 JSX 自己折叠成空格，
 *      所以 `Lead` 的词尾空格、`Mid` 的词首空格都是**照着折叠后的结果**写的，
 *      测试里按界面的渲染顺序把它们拼回原句，差一个空格就红。
 *   3. **`psd.venvsDir` 是唯一一处有意不逐字节**的：接线前的 JSX 里那一行实际是
 *      `项目` + 竖控制字符（U+000B）+ `envs\` —— 写的人本意是 `项目\venvs\`，其中
 *      `\v` 被当成转义吃掉了，渲染出来少了反斜杠。词表里写成 `项目\venvs\`（与既有
 *      `py.venvBlocked` 的写法一致），顺手修掉这条潜伏的显示错误。除这一条外，其余
 *      85 条都与接线前的字面量逐字节相同。
 *
 * ## 被替换掉的字面量是怎么核对的
 *
 * 不靠记忆：用 `git show HEAD:src/dialogs/ProjectSettingsDialog.tsx` 取出接线前的版本，
 * 把 `psd.*` 的 zh 值拿去原文里做**逐字节包含**检查（段落那几条按 JSX 的折叠规则
 * `cleanJSXElementLiteralChild` 先折叠再比），全过之后才写下这张表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isTranslationKey, tFor } from "../src/lib/i18n.ts";

const DIALOG = "src/dialogs/ProjectSettingsDialog.tsx";

/**
 * r21-o2-1 搬进词表的全部 86 条 zh 值 —— 与接线前 `ProjectSettingsDialog.tsx` 里的
 * 字面量逐字节相同（唯一的例外 `psd.venvsDir` 见文件头第 3 点）。
 */
const originals: Record<string, string> = {
  "psd.loadTerminalsFailed": "读取终端列表失败",
  "psd.loadIdesFailed": "读取 IDE 列表失败",
  "psd.portSaved": "端口段已设为 {n}",
  "psd.portInvalid": "端口段要填 1024–65535 的整数",
  "psd.copied": "已复制{label}",
  "psd.clipboardDenied": "剪贴板不可用",
  "psd.copyPath": "路径",
  "psd.copyUrl": "地址",
  "psd.openLinkFailed": "打开链接失败",
  "psd.refreshFailed": "刷新项目信息失败",
  "psd.alias": "别名",
  "psd.aliasHint": "只显示在这个项目墙上；真实的仓库名仍然排在第二行，避免卡片把自己的身份藏起来。",
  "psd.clear": "清除",
  "psd.coverFitTitle": "封面取景",
  "psd.coverFitHint": "裁切填满最稳；完整显示会留边；模糊铺底用同图放大虚化填掉留边。",
  "psd.coverFitCrop": "裁切填满",
  "psd.coverFitContain": "完整显示",
  "psd.coverFitBlur": "模糊铺底",
  "psd.coverRatioTitle": "封面比例",
  "psd.coverRatioHint": "默认 2:1 对齐 GitHub 的社交预览图，抓来的封面不会被横向切掉。",
  "psd.coverLookTitle": "封面处理",
  "psd.coverLookHint": "「跟随皮肤」用外观风格自带的滤镜；其余三档对这张封面单独生效。",
  "psd.lookAuto": "跟随皮肤",
  "psd.lookVivid": "鲜明",
  "psd.lookFlat": "柔和",
  "psd.lookMono": "单色",
  "psd.focusTitle": "封面焦点",
  "psd.focusHint": "把想让人先看到的区域拖到框内。只在完整显示或模糊铺底时有明显效果。",
  "psd.focusX": "横",
  "psd.focusY": "纵",
  "psd.focusXAria": "封面水平焦点",
  "psd.focusYAria": "封面垂直焦点",
  "psd.coverTitle": "封面",
  "psd.coverHint": "指定一张本地图片代替抓来的项目封面。抓来的封面要联网、也可能根本没有；这张是自己选的，卡片会优先用它。",
  "psd.coverPickerTitle": "选择封面图片",
  "psd.coverFieldLabel": "封面图片路径",
  "psd.coverPlaceholder": "留空则用抓取的封面或渐变兜底",
  "psd.coverLocal": "封面已改用这张本地图片",
  "psd.coverFetched": "已恢复用抓取的封面",
  "psd.pinHint": "无论按名称、最近使用还是拥有者排序，这张卡都排在最前。",
  "psd.hideHint": "只是不在墙上出现，磁盘、venv、启动配置都不动；恢复入口在 设置 → 项目页。",
  "psd.posTitle": "手动位置",
  "psd.posUnset": "还没有参与拖动排序，位置由当前排序档决定。",
  "psd.posN": "拖动顺序里的第 {n} 位。复位会清掉所有卡片的拖动顺序。",
  "psd.posReset": "复位顺序",
  "psd.orderReset": "已清除全部手动顺序",
  "psd.stepwiseHint": "多步启动时，每一步跑完等你点下一步。开着它，一键启动就不再一键。",
  "psd.followGlobal": "跟随全局",
  "psd.on": "开",
  "psd.off": "关",
  "psd.launchCmdHint": "看得见这个项目确认过的步骤；改仍去启动面板 —— 会启动进程的地方多一处，就多一处说不清是谁启动的。",
  "psd.noCommands": "还没有确认过启动命令",
  "psd.editInPanel": "在启动面板修改…",
  "psd.termHint": "覆盖全局默认终端，只对这一个项目有效。",
  "psd.termAria": "该项目的默认终端",
  "psd.ideHint": "同样只对这个项目有效。写在 `.devhub.json` 里，意味着它跟着仓库走。",
  "psd.ideAria": "该项目的默认 IDE",
  "psd.launchFootLead": "这三项写进仓库自己的 ",
  "psd.launchFootTail": "：换一台机器打开同一个克隆，它们会跟着过来。",
  "psd.locTitle": "这个仓库的位置",
  "psd.diskTitle": "磁盘路径",
  "psd.pathMissing": "未找到目录",
  "psd.copy": "复制",
  "psd.cloneTitle": "克隆地址",
  "psd.noMarker": "没有 .devhub.json，这个目录是手工拷进来的",
  "psd.portTitle": "端口段",
  "psd.portHint":
    "启动时按这个段往后找空闲端口，一仓一段所以并发克隆不会撞。填新的段会先和所有项目（含附加目录）的段比对，重叠会被拒绝并说明撞了谁。",
  "psd.unassigned": "未分配",
  "psd.portCurrent": "当前 {v}",
  "psd.venvHint":
    "记下这个项目用的是哪个 venv，启动时它先进 PATH。「清除」只删这条记录，磁盘上的环境不动 —— 真删是启动面板里 清理 venv 的事。",
  "psd.venvPickerTitle": "选择虚拟环境目录",
  "psd.venvFieldLabel": "虚拟环境目录",
  "psd.venvPlaceholder": "还没有为它记过 venv",
  "psd.locFootLead": "端口段和虚拟环境同样写进 ",
  "psd.locFootTail": "：它们是这一个仓库的启动事实，跟着克隆走，也随克隆一起消失。",
  "psd.pyTitle": "Python 与虚拟环境",
  "psd.pyNoteLead": "本机同时装着多个 Python 时，选错解释器是「装完依赖起不来」的头号原因，所以这里锁的是一个具体",
  "psd.pyNoteMid": " 路径，而不是「3.12」这种别名。虚拟环境建在仓库",
  "psd.pyNoteOutside": "之外",
  "psd.pyNoteJoin": "的",
  "psd.venvsDir": "项目\\venvs\\",
  "psd.pyNoteTail": "，同名仓库不会互相踩。上方「虚拟环境」那一行仍然有效：它可以指向一个已经存在的环。",
  "psd.writing": "正在写入 .devhub.json…",
  "psd.wtNoteLead":
    "工作树是同一个仓库的第二份工作目录，共用同一条 git 历史，所以每个任务可以各自占一个目录、 互不打断。它们统一收在 ",
  "psd.worktreesDir": "项目\\_worktrees\\",
  "psd.wtNoteTail":
    " 下一层，这个目录不会被扫描成项目； 在这里删除工作树只动那份目录，分支和提交仍然留在仓库里。",
};

/**
 * 复用的既有键：接线前后这几处的显示字必须一模一样，所以钉的是「仍然是这个键，
 * 这个键的 zh 仍然是这个字」。它们的接线点分散在 `i18n.test.ts` 与各自组件的测试里，
 * 这里只管「项目设置对话框这次没有把它们改成另一份副本」。
 */
const reused: Record<string, string> = {
  "tile.pinned": "置顶",
  "menu.hide": "从项目墙隐藏",
  "launch.stepwise": "逐步确认",
  "launch.commandTitle": "启动命令",
  "settings.page.terminalTitle": "默认终端",
  "settings.page.ideTitle": "默认 IDE",
  "py.venvTitle": "虚拟环境",
  "wt.title": "工作树",
  "wt.open": "打开",
  "wt.revealFailed": "打开目录失败",
  "settings.page.saveFailed": "保存失败：{msg}",
  "launch.parallel": "并行",
  "launch.sequential": "顺序",
};

test("i18n: 项目设置对话框接线搬进词表的每个中文字面量逐字节不变（r21-o2-1）", () => {
  assert.equal(Object.keys(originals).length, 86, "词表里的 psd.* 条目数与这张表对不上");
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  for (const [key, expected] of Object.entries(reused)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} 本该复用，却被改成了另一份文案`);
  }
  // 文件头第 3 点说的那条：词表里必须是正字的反斜杠，而不是接线前那个竖控制字符。
  assert.equal(tFor("zh-CN", "psd.venvsDir"), "项目\\venvs\\");
  for (const code of tFor("zh-CN", "psd.venvsDir")) {
    assert.ok(code >= " " || code === "\n", `venvsDir 里混进了控制字符 U+${code.codePointAt(0)}`);
  }
});

test("i18n: 项目设置的说明文字按界面的组装顺序拼回接线前的原句", () => {
  const zh = "zh-CN" as const;
  // 启动默认值小节的脚注：<code> 两侧各一段。
  assert.equal(
    `${tFor(zh, "psd.launchFootLead")}.devhub.json${tFor(zh, "psd.launchFootTail")}`,
    "这三项写进仓库自己的 .devhub.json：换一台机器打开同一个克隆，它们会跟着过来。",
  );
  // 位置小节的脚注。
  assert.equal(
    `${tFor(zh, "psd.locFootLead")}.devhub.json${tFor(zh, "psd.locFootTail")}`,
    "端口段和虚拟环境同样写进 .devhub.json：它们是这一个仓库的启动事实，跟着克隆走，也随克隆一起消失。",
  );
  // Python 小节：文本 + <code> + 文本 + <strong> + 文本 + <code> + 文本。
  assert.equal(
    `${tFor(zh, "psd.pyNoteLead")}python.exe${tFor(zh, "psd.pyNoteMid")}<strong>${tFor(zh, "psd.pyNoteOutside")}</strong>${tFor(zh, "psd.pyNoteJoin")}${tFor(zh, "psd.venvsDir")}${tFor(zh, "psd.pyNoteTail")}`,
    '本机同时装着多个 Python 时，选错解释器是「装完依赖起不来」的头号原因，所以这里锁的是一个具体python.exe 路径，而不是「3.12」这种别名。虚拟环境建在仓库<strong>之外</strong>的项目\\venvs\\，同名仓库不会互相踩。上方「虚拟环境」那一行仍然有效：它可以指向一个已经存在的环。',
  );
  // 工作树小节：文本 + <code> + 文本。
  assert.equal(
    `${tFor(zh, "psd.wtNoteLead")}${tFor(zh, "psd.worktreesDir")}${tFor(zh, "psd.wtNoteTail")}`,
    '工作树是同一个仓库的第二份工作目录，共用同一条 git 历史，所以每个任务可以各自占一个目录、 互不打断。它们统一收在 项目\\_worktrees\\ 下一层，这个目录不会被扫描成项目； 在这里删除工作树只动那份目录，分支和提交仍然留在仓库里。',
  );
});

test("i18n: 项目设置的 toast 与位置行按槽拼回接线前的模板", () => {
  const zh = "zh-CN" as const;
  assert.equal(tFor(zh, "psd.portSaved", { n: 49152 }), "端口段已设为 49152");
  assert.equal(tFor(zh, "psd.portInvalid"), "端口段要填 1024–65535 的整数");
  assert.equal(tFor(zh, "psd.copied", { label: tFor(zh, "psd.copyPath") }), "已复制路径");
  assert.equal(tFor(zh, "psd.copied", { label: tFor(zh, "psd.copyUrl") }), "已复制地址");
  assert.equal(
    tFor(zh, "psd.posN", { n: 3 }),
    "拖动顺序里的第 3 位。复位会清掉所有卡片的拖动顺序。",
  );
  assert.equal(tFor(zh, "psd.portCurrent", { v: "49152" }), "当前 49152");
  assert.equal(tFor(zh, "psd.portCurrent", { v: tFor(zh, "psd.unassigned") }), "当前 未分配");
  assert.equal(tFor(zh, "settings.page.saveFailed", { msg: "boom" }), "保存失败：boom");
  assert.equal(tFor(zh, "psd.writing"), "正在写入 .devhub.json…");
});

/** 一行里出现任意 CJK 统一表意文字即算「含中文」。 */
const ZH = /[㐀-鿿]/;

/**
 * 去掉块注释（含 JSX 的 `{/* … *\/}`）与整行 `//` 之后的源码行 —— 与
 * `tests/zh-hardcode-ratchet.test.ts` 的 `codeLines` 同一套规则（那条棘轮管全仓，
 * 这里只管这一个文件：它这一次的目标是清零）。
 */
function codeLines(file: string): string[] {
  const src = readFileSync(file, "utf8").replace(/^﻿/, "");
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
}

test("i18n: 项目设置对话框接线后不留中文代码行，且每个词条都有接线点", () => {
  const leftover = codeLines(DIALOG)
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => ZH.test(line));
  assert.deepEqual(
    leftover.map(([n, l]) => `${n}: ${l.trim()}`),
    [],
    "这些行还在界面里写着中文字面量",
  );

  const src = readFileSync(DIALOG, "utf8");
  for (const key of Object.keys(originals)) {
    assert.ok(src.includes(`"${key}"`), `${key} 在 ${DIALOG} 里没有接线点（词表有、界面没用）`);
  }
  for (const key of Object.keys(reused)) {
    assert.ok(src.includes(`"${key}"`), `${key} 该被这个对话框复用，却没接上`);
  }
  // 读了词表就必须订阅语言，否则切语言后这一屏停在旧文案上。
  assert.ok(src.includes("useI18n("), "对话框没有 useI18n()，切语言不会重取词表");
});
