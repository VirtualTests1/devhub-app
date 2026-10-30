/**
 * r21 N3-1 — 设置页「注册 devhub:// 协议」这一行的两端。
 *
 * 后端行为（三处注册表写入、`Result<String, String>` 错误映射）在
 * `src-tauri/src/deeplink.rs`；这里钉的是**前端接线**里最容易被后来者悄悄改坏的几件事：
 *
 *   1. 调用走真命令名（`check-commands.mjs` 的 allowlist 条目因此可以删，floor 同步抬）；
 *   2. 三态各自渲染自己的句子，失败把后端原话**原样**带到屏幕上；
 *   3. 手动注册的替代说明与 Rust 真正写下去的三处键逐条一致（两份源码互钉），
 *      且界面不许暗示存在「安装包注册」这条路；
 *   4. 新组件没有一个未进词表的中文界面字面量。
 *
 * 行为部分用假 `invoke` 驱动 `registerProtocol`——这正是它把 `invoke` 做成参数
 * 的理由（真 `invoke` 要 Tauri webview，Node 里没有）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerProtocol } from "../src/lib/deeplink-register.ts";
import { isTranslationKey, tFor } from "../src/lib/i18n.ts";

const COMPONENT = readFileSync("src/views/settings/DeepLinkSection.tsx", "utf8").replace(/\r\n/g, "\n");
const SETTINGS_VIEW = readFileSync("src/views/SettingsView.tsx", "utf8").replace(/\r\n/g, "\n");
const CUSTOMIZE = readFileSync("src/store/customize.ts", "utf8").replace(/\r\n/g, "\n");
const I18N = readFileSync("src/lib/i18n.ts", "utf8").replace(/\r\n/g, "\n");
const RUST = readFileSync("src-tauri/src/deeplink.rs", "utf8").replace(/\r\n/g, "\n");
const COMMANDS = readFileSync("scripts/check-commands.mjs", "utf8").replace(/\r\n/g, "\n");

/** 去注释后的代码行：与 zh 棘轮同口径（整行 `//` 与块注释剔除，行内 `//` 保留）。 */
function codeLines(src: string): string[] {
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

// ---------------------------------------------------------------------------
// 1. 假 invoke 驱动的两条结局

test("registerProtocol: 成功把后端那句话一字不差地带回来", async () => {
  const seen: string[] = [];
  const backend = "已注册 devhub:// → C:\\apps\\devhub\\devhub.exe";
  const result = await registerProtocol((cmd) => {
    seen.push(cmd);
    return Promise.resolve(backend);
  });
  assert.deepEqual(seen, ["register_deeplink"], "调用的就是注册在 generate_handler! 里的那个命令名");
  assert.deepEqual(result, { ok: true, message: backend }, "成功串原样透传，界面据此显示它写进了哪个 exe");
});

test("registerProtocol: 失败是后端原话，不是重新措辞的一句话", async () => {
  const backend = "注册协议失败 (add): 拒绝访问。";
  const result = await registerProtocol(() => Promise.reject(backend));
  assert.deepEqual(result, { ok: false, error: backend }, "Result<String,String> 经 Tauri 以字符串 reject，messageOf 对字符串原样返回");
});

test("registerProtocol: 结构化错误仍走 messageOf 的唯一文案口径", async () => {
  const result = await registerProtocol(() =>
    Promise.reject({ message: "无法获取当前可执行文件路径", code: "exe" }),
  );
  assert.deepEqual(result, { ok: false, error: "无法获取当前可执行文件路径（exe）" });
});

// ---------------------------------------------------------------------------
// 2. 三态：每态渲染自己的句子，失败带原文

test("组件: 三态齐全，未尝试不说成「未注册」", () => {
  // 初始态是 `idle`，文案是「还没有试过」——没跑过命令就报「未注册」，
  // 是拿「没试过」冒充「查过」。
  assert.ok(COMPONENT.includes('useState<RegisterState>({ kind: "idle" })'));
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkIdle")'));
  for (const kind of ["busy", "ok", "fail"]) {
    assert.ok(COMPONENT.includes(`state.kind === "${kind}"`), `${kind} 分支缺失`);
  }
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkRegister")'));
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkBusy")'), "进行中换按钮文案");
  assert.ok(COMPONENT.includes('disabled={state.kind === "busy"}'), "进行中不再点第二次");
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkOk")'));
});

test("组件: 失败把 {error} 原样插进屏幕，成功显示后端返回串", () => {
  assert.ok(
    COMPONENT.includes('t("settings.page.deeplinkFailed", { error: state.error })'),
    "失败串只做插值，不在这里改写",
  );
  assert.ok(
    COMPONENT.includes('<code className="break-all font-mono">{state.message}</code>'),
    "成功态把后端的「已注册 devhub:// → <exe>」整个显示出来",
  );
  // 词表侧：两条词条都必须登记，且 {error} 两语言槽名一致（i18n.test 会再查一遍槽名）。
  assert.ok(isTranslationKey("settings.page.deeplinkFailed"));
  assert.ok(tFor("en", "settings.page.deeplinkFailed", { error: "boom" }).includes("boom"));
});

// ---------------------------------------------------------------------------
// 3. 手动替代说明与 Rust 逐条一致；不许暗示安装包注册

test("手动注册说明：三处键与 register_windows_protocol 真正写下去的逐条对上", () => {
  // 界面上给用户抄的那份，必须来自代码本身，否则它就是一段会过期的编造。
  for (const [shape, rust] of [
    ["(Default) = URL:DevHub Protocol", '"/ve", "/t", "REG_SZ", "/d", "URL:DevHub Protocol"'],
    ["URL Protocol = (empty)", '"/v", "URL Protocol"'],
    ['(Default) = "<devhub.exe>" "%1"', 'shell\\\\open\\\\command'],
  ] as const) {
    assert.ok(COMPONENT.includes(shape), `界面少了 ${shape}`);
    assert.ok(RUST.includes(rust), `deeplink.rs 里找不到对应的写入：${rust}`);
  }
  // TS 源码里成对的反斜杠转义：组件的 shape 常量按 `\\` 写，Rust 侧是 raw string。
  assert.ok(COMPONENT.includes("HKCU\\\\Software\\\\Classes\\\\devhub"), "界面按 HKCU 抄键路径");
  assert.ok(RUST.includes('let base = r"HKCU\\Software\\Classes\\devhub";'), "Rust 侧同一个基键");
  // 提示语本身走词表（组件里没有中文字面量，见下一条）。
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkManualHint")'));
});

test("界面不暗示「安装包注册」存在：那条路按需求不做", () => {
  // REQUIREMENTS.md §3.5 / §6：MSI/NSIS 安装包按需求不做 → deeplink.rs 模块头第 2
  // 种注册方式同口径（r21 N3-3 把「还没实现」改齐）。组件里一个安装包字样都不许有；
  // 唯一提到它的地方是词表里一句**不可用**声明。
  const code = codeLines(COMPONENT).join("\n");
  assert.ok(!/msi|nsis|安装包/i.test(code), "组件源码（含注释）不得出现安装包注册的入口或承诺");
  assert.ok(
    I18N.includes('"settings.page.deeplinkNoInstaller"') && /不做 MSI\/NSIS/.test(I18N),
    "失败态用一条「不可用」词条说明边界，而不是留白让人自己猜",
  );
  assert.ok(COMPONENT.includes('t("settings.page.deeplinkNoInstaller")'));
});

test("新组件没有未进词表的中文界面字面量", () => {
  const offenders = codeLines(COMPONENT)
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /[一-鿿]/.test(l));
  assert.deepEqual(
    offenders,
    [],
    `这些行是绕过 t() 的中文字面量: ${offenders.map(([i, l]) => `${i}:${l.trim()}`).join(" | ")}`,
  );
  // 全部键都在两份词表里，且 zh 值逐字节钉住（新家族：词表就是原始文案）。
  const KEYS: Record<string, [string, string]> = {
    "settings.page.deeplinkGroupTitle": ["浏览器协议（devhub://）", "Browser protocol (devhub://)"],
    "settings.page.deeplinkRowTitle": ["注册 devhub:// 协议", "Register the devhub:// protocol"],
    "settings.page.deeplinkRegister": ["注册协议", "Register"],
    "settings.page.deeplinkBusy": ["注册中…", "Registering…"],
    "settings.page.deeplinkOk": ["注册成功", "Registered"],
    "settings.page.deeplinkFailed": ["注册失败：{error}", "Registration failed: {error}"],
    "settings.page.deeplinkManualHint": ["可以手动写入同样的三处（当前用户，无需管理员）：", "You can write the same three keys by hand (current user, no admin required):"],
    "settings.page.deeplinkNoInstaller": [
      "安装包注册不可用：本项目按需求不做 MSI/NSIS 安装包，运行时注册是唯一一条路。",
      "Installer registration is unavailable: MSI/NSIS packages are out of scope for this project, so runtime registration is the only path.",
    ],
  };
  for (const [key, [zh, en]] of Object.entries(KEYS)) {
    assert.ok(isTranslationKey(key), `${key} 未登记`);
    assert.equal(tFor("zh-CN", key), zh, `${key} 的 zh 掉了原话`);
    assert.equal(tFor("en", key), en, `${key} 的 en 掉了原话`);
  }
  // r21-o3-2 之后键只写一遍（EN 是按 ZH 键序的值数组，没有第二张键表）：声明行计数
  // 期望 = 键数 × 1；EN 侧若长回带键对象会变成 ×2 而变红（bundle-diet-1 对全表做同款
  // 守卫）。zh/en 逐字节齐上面已钉，i18n-diff-analysis 再验全表配对。
  const declared = I18N.match(/"settings\.page\.deeplink[A-Za-z]+":/g) ?? [];
  assert.equal(declared.length, 10, `词表里 deeplink 键声明数应为 10（各写一遍），实为 ${declared.length}`);
  // 组件用到的每个键都是字面量调用点（dead-key 棘轮的正向那半）。
  for (const key of [
    "deeplinkGroupTitle",
    "deeplinkRowTitle",
    "deeplinkRowHint",
    "deeplinkIdle",
    "deeplinkManualHint",
    "deeplinkNoInstaller",
  ]) {
    assert.ok(COMPONENT.includes(`t("settings.page.${key}"`), `${key} 没有字面量调用点`);
  }
});

// ---------------------------------------------------------------------------
// 4. 挂载点、元素登记、IPC 契约

test("挂载: 项目与目录页在目录组之后渲染这一组", () => {
  const roots = SETTINGS_VIEW.indexOf('{activeSection === "roots" && (');
  const mount = SETTINGS_VIEW.indexOf("<DeepLinkSection />");
  const projects = SETTINGS_VIEW.indexOf('{activeSection === "projects" &&');
  assert.ok(roots > 0 && mount > roots && projects > mount, "挂载在 roots 分支内、projects 分支之前");
  assert.ok(
    SETTINGS_VIEW.includes('const DeepLinkSection = lazy(() =>'),
    "有 lazy 定义，不是未定义的标识符",
  );
  // 与目录组并列（fragment 内的兄弟），不是塞进「项目目录」面板里的嵌套 section。
  assert.ok(SETTINGS_VIEW.slice(roots, mount).includes("</SettingsGroup>"), "前一个组先闭合");
  assert.ok(COMPONENT.includes('regId="settings-group-deeplink"'), "这一组有自己的 registry id");
  assert.ok(CUSTOMIZE.includes('id: "settings-group-deeplink"'), "并在 ELEMENTS 登记（check-registry 校验）");
});

test("IPC 契约: register_deeplink 有了调用者，allowlist 条目已删、floor 抬到实测值", () => {
  assert.ok(
    // 对象字面量条目的形状（行首缩进 + 键名 + 冒号），注释里引用旧条目的字样不算。
    !/^[\t ]*register_deeplink[\t ]*:/m.test(COMMANDS),
    "allowlist 里留着它会触发 staleAllowlist（有调用者还占着掩护）",
  );
  assert.ok(
    COMMANDS.includes("const INVOKED_FLOOR = 107;") && COMMANDS.includes("const REGISTERED_FLOOR = 107;"),
    "floor = live：r21 收口 86/87；r34 四条新命令后 107/107（理由见 check-commands.mjs）",
  );
  // 反向：调用点确实在 src/ 里（check-commands 的扫描就是按这个形状找的）。
  assert.ok(
    readFileSync("src/lib/deeplink-register.ts", "utf8").includes('await invoke("register_deeplink")'),
    "命令名字面量必须留在 invoke(…) 的调用位置",
  );
});
