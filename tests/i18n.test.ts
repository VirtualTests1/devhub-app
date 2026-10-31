/**
 * 词条完整性守卫（r16-n2-3）——「缺键即测试失败」这条要求在这里落地。
 *
 * ## 为什么类型检查不够，还要一份测试
 *
 * 编译期那道闸曾经存在：`EN` 用 `satisfies Record<TranslationKey, string>` 钉键集，
 * 少一个键 = missing-property、多一个键 = excess-property，都编译不过。r21-o3-2 把
 * 英文半表改成了**按 ZH 键序排列的值数组**（见 `src/lib/i18n.ts` 该块头部：两份词表
 * 键集恒等，重复写 1,190 遍键名是 13.6% 产物里约 27 KB 的纯重复），编译期的 EN 侧
 * 键集/对位检查随之**按设计消失**——键集现在由构造保证，而「值与键是否对位」编译器
 * 再也看不见。静态检查救不了的，正是本文件存在的理由：它失败的时候不是一行红线，
 * 是一条测试名。为此本文件在 r21-o3-2 补了**位置对位**那条钉子（数组首尾 + 每约 50
 * 键一条的逐字节映射），它比 `satisfies` 当年挡得更细（当年只能挡缺/多，挡不住错位）。
 *
 * 顺带记一笔已付过的学费：类型约束的可信度取决于「那份字面量还在不在」——临时注释
 * 掉 `satisfies` 来救一次编译，静态检查就全线失效而 `tsc` 依然绿（`tests/single-source.test.ts`
 * 的头一段讲的就是「一个 review 看不出来的重复」）。所以同一个不变量在这里永远再跑一遍。
 *
 * ## 覆盖的事
 *
 *   1. zh / en 键集**完全相同**（两个方向都算，缺一个就失败）。
 *   2. 回落链四种情况逐条钉住（`i18n.ts` 头部写的那份策略）。
 *   3. `{slot}` 插值行为（填、两个槽都在、缺变量留原样、数字转字符串）。
 *   4. 接线点不会指向一个没登记的键：源码里每一处 `t("…")` 字面量、以及按 id 拼出来的
 *      `view.*` / `settings.section.*` 两个家族，都必须在词表里存在。
 *      `settingsCatalog.tsx` 是 `.tsx`，Node 的 type-stripping 解析不了（见
 *      `tests/lib-import-graph.test.ts` 的头一段），所以按本仓库既有做法读源码
 *      （同 `tests/statusstrip-nesting.test.ts`、`tests/single-source.test.ts`）。
 *   5. 反向也成立：词表里每个键都得有接线点。只钉正向的话，删掉一处界面接线却留着
 *      词条（或删了路由却留着 `view.*`）不会有任何测试变红——那是「登记了但没人读」的
 *      债，和缺键一样是词表与界面脱节。
 *   6. 六个接了词条的界面都**订阅**了语言（`useI18n()`），并且确实读词表。键集守卫看
 *      不见这种失败：词条解析对了，组件却不重绘，屏幕停在旧语言上直到别的事把它刷新。
 *   7. 语言行（设置 → 界面 → 语言）的选项就是发布的那两种语言，语言自己的名字逐字节不动。
 *
 * 默认语言那一份还钉了**逐字节**：`VIEW_LABEL.projects` 必须是「项目」，设置目录里
 * `label:` 的每个中文原文、以及接线搬进词表的每一条状态条 / 链路 / 标题栏字面量
 * （逐条列在「接线替换掉的每个中文字面量」那条测试里），都必须等于词表 zh 值。
 * i18n 落地最容易犯的错就是「顺手把文案也改了」，这些把那个偷渡挡在门外。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALE_OPTIONS,
  LOCALES,
  getLocale,
  interpolate,
  readLocale,
  resolveKey,
  setLocale,
  t,
  tFor,
  isTranslationKey,
} from "../src/lib/i18n.ts";
import { VIEW_LABEL, type ViewId } from "../src/store/ui.ts";
import { SORTS, FILTERS, WALL_DENSITIES } from "../src/store/wall.ts";

import { at, atKey } from "./helpers/definite.ts";

/**
 * The two tables, read as *data*.
 *
 * `i18n.ts` publishes them as `DICTIONARIES`: zh-CN is the authored literal,
 * en is `EN_VALUES` paired to `ZH`'s keys **by position** at module init
 * (r21-o3-2). What this file reads is therefore the exact effective table the
 * app ships — the right thing for the runtime guards to check, since the
 * authoring-time `satisfies` that used to sit on `EN` is gone by design.
 * Every assertion below enumerates keys at runtime (`Object.keys`), and the
 * position pairing is pinned byte-for-byte under 键集一致 section 1.5.
 */
const ZH = DICTIONARIES["zh-CN"];
const EN = DICTIONARIES.en;
const ZH_KEYS = Object.keys(ZH);
const EN_KEYS = Object.keys(EN);

/** Strip comments, preserving line numbers — the house pattern for scanning `.tsx`. */
function codeLines(file: string): string[] {
  const src = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
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
      if (close >= 0) {
        line = line.slice(0, open) + line.slice(close + 2);
      } else {
        inBlock = true;
        line = line.slice(0, open);
      }
    }
    kept.push(line);
  }
  return kept;
}

/** Every `.ts` / `.tsx` under `src/` — the tree the dictionary is supposed to own. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The section ids, read out of the union declaration — the authority for the
 * `settings.section.*` family (`settingsCatalog.tsx` is `.tsx`, so it cannot
 * be imported under type-stripping; same source-scan house pattern as below).
 */
function catalogSectionIds(): string[] {
  const decl = codeLines("src/settingsCatalog.tsx")
    .join("\n")
    .match(/export type SettingsSectionId =([\s\S]*?);/);
  assert.ok(decl, "SettingsSectionId declaration not found — update this scan with it");
  return [...at(decl, 1).matchAll(/"([a-z]+)"/g)].map((m) => at(m, 1));
}

// ---------------------------------------------------------------------------
// 1. 键集一致

test("i18n: zh 与 en 的键集完全一致（缺键即失败）", () => {
  const missing = ZH_KEYS.filter((k) => !EN_KEYS.includes(k));
  const surplus = EN_KEYS.filter((k) => !ZH_KEYS.includes(k));
  assert.deepEqual(
    missing,
    [],
    `en 少了 ${missing.length} 个键，默认语言之外会露出中文: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    surplus,
    [],
    `en 多了 ${surplus.length} 个 zh 里没有的键（键集由 zh.ts 权威定义）: ${surplus.join(", ")}`,
  );
});

test("i18n: 键不重复，且没有任何一边有空值", () => {
  for (const [name, table] of [["zh", ZH], ["en", EN]] as const) {
    const keys = Object.keys(table);
    assert.equal(keys.length, new Set(keys).size, `${name} has duplicate keys`);
    const empty = keys.filter((k) => String(table[k as keyof typeof table]).trim() === "");
    assert.deepEqual(empty, [], `${name}: an empty entry renders a blank label (policy case 4)`);
  }
});

test("i18n: 词表不占用 config. / ui. 前缀（那是 lib/targetLabel 的命名空间）", () => {
  // `tests/single-source.test.ts` fails the tree outright on a `"ui.x": "中文"` table,
  // so a key that drifts into those namespaces would take the whole suite down with it.
  const strays = ZH_KEYS.filter((k) => /^(config|ui)\./.test(k));
  assert.deepEqual(strays, [], `setting names come from lib/targetLabel: ${strays.join(", ")}`);
});

test("i18n: 英文词条不带 emoji（本项目的界面语言规范）", () => {
  // Covers both tables rather than only en: the rule is about the UI, not the language.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  const offenders: string[] = [];
  for (const [locale, table] of [[DEFAULT_LOCALE, ZH], ["en", EN]] as const) {
    for (const [key, value] of Object.entries(table)) {
      if (emoji.test(value)) offenders.push(`${locale}.${key}: ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `icons come from lucide, not the copy: ${offenders.join(" | ")}`);
});

test("i18n: 两份词表的槽名逐键一致（英文可以挪位置，不能改名字）", () => {
  const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const drifted: string[] = [];
  for (const key of ZH_KEYS) {
    const a = slots(atKey(ZH, key));
    const b = slots(atKey(EN, key));
    if (a !== b) drifted.push(`${key}: zh{${a}} vs en{${b}}`);
  }
  assert.deepEqual(drifted, [], `a renamed slot leaves the hole on screen: ${drifted.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// 1.5 位置对位（r21-o3-2 起：EN 是按 ZH 键序排的值数组，键只在 ZH 写一遍）
//
// 为什么需要这条：键集恒等现在是**构造出来的**（EN 由 Object.keys(ZH) 生成），
// 于是「少一个键 / 多一个键」那条测不到任何东西了；而 EN_VALUES 插错位置、少一项、
// 整体错一格这类**错位**，键集测试、空值测试、CJK 测试全看不出来——错位拿到的仍
// 是一个合法英文值，只是配给了错的键，屏幕会显示正确语言的错误文案。
//
// 钉法：在数组首 5 条、其后每约 50 个键、以及末 4 条上逐字节钉住 键→英文 映射。
// 最大采样间隔 50，所以任何一处插入/删除/错位都会让「错位点之后的某个钉子」对不上。
test("i18n: 英文按 ZH 键序对位——错位即失败（首尾 + 每约 50 键，32 条逐字节）", () => {
  const pins: [string, string][] = [
    ["view.projects", "Projects"],
    ["view.add", "Add"],
    ["view.settings", "Settings"],
    ["view.records", "Records"],
    ["view.frequent", "Frequent"],
    ["link.accelBypassed", "Local accelerator (hosts){who} · bypassed"],
    ["stats.total", "{n} entries"],
    ["readme.openLink", "Open {href} in the browser"],
    ["frequent.openCountTitle", "Opened {n} times"],
    ["settings.page.setMain", "Set as main"],
    ["settings.page.recordsFootnote", "Retention really deletes expired records rather than filtering them; export before shortening it."],
    ["wt.revealFailed", "Failed to open the directory"],
    ["launch.openedVia", "Opened via {label} (PID {pid})"],
    ["split.noTools", "No usable tools detected; set one manually under “Settings → Editors & IDEs”."],
    ["appearance.tplFootnoteTail", "); export as JSON to take them along. Applying overwrites the current appearance and writes a record you can revert."],
    ["strip.stop", "Stop"],
    ["wall.batch.tagAddLit", "Batch tag \"{tags}\""],
    ["records.lineNoId", "This record has no id yet; use \"Clear records\" for it."],
    ["sp.resetSoon", "(resets in about {n} s)"],
    ["stars.clearSelected", "Clear"],
    ["shortcut.viewSettings", "Go to Settings"],
    ["shortcutHelp.customized", "Customised"],
    ["shortcutHelp.resetOne", "Reset"],
    ["shortcutHelp.resetAll", "Reset all"],
    ["shortcutHelp.unparsable", "That combination cannot be bound: {chord}"],
    ["activity.clearConfirm", "Clear all operation records? This cannot be undone, and shortening the retention period also deletes history."],
    ["activity.clearTitle", "Clear operation records"],
    ["activity.clearOk", "Clear"],
    ["activity.cleared", "Operation records cleared"],
    ["activity.clearFailed", "Failed to clear: {msg}"],
    ["grep.timedOut", "The scan stopped at its {seconds}s limit; these results may be incomplete."],
    ["storage.saveFailed", "Save failed: browser storage is full or disabled; this change lasts only for the current session."],
  ];
  const shifted = pins
    .filter(([key, want]) => EN[key] !== want)
    .map(([key, want]) => `${key}: got ${JSON.stringify(EN[key])}, want ${JSON.stringify(want)}`);
  assert.deepEqual(
    shifted,
    [],
    `EN_VALUES 与 ZH 键序错位（加键只加一边、或两边插入位置不同）: ${shifted.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// 2. 回落链（夹具字典，四策略逐条）
//
// Fixture tables are keyed by the *real* locale ids (`zh-CN`, not `zh`):
// `resolveKey` falls back to `dicts[DEFAULT_LOCALE]`, and a fixture under a
// key the fallback never looks up would silently test the key-as-text branch
// instead of the branch it names.

test("i18n 回落 1: 请求语言里有这个键就用它", () => {
  const dicts = { "zh-CN": { a: "甲" }, en: { a: "A" } };
  assert.equal(resolveKey(dicts, "en", "a"), "A");
  assert.equal(resolveKey(dicts, "zh-CN", "a"), "甲");
});

test("i18n 回落 2: 请求语言缺键 → 落回 zh 原文，不报缺", () => {
  // This is the case an English gap actually hits: today's Chinese text, not a
  // blank, not a raw key.
  const dicts = { "zh-CN": { a: "甲" }, en: {} };
  const reported: string[] = [];
  const out = resolveKey(dicts, "en", "a", (l, k) => reported.push(`${l}:${k}`));
  assert.equal(out, "甲");
  assert.deepEqual(reported, [], "a zh fallback is the designed answer, not a defect to log");
});

test("i18n 回落 3: zh 里也没有 → 渲染键本身并报告一次", () => {
  const dicts = { "zh-CN": { a: "甲" }, en: { a: "A" } };
  const reported: string[] = [];
  const out = resolveKey(dicts, "en", "no.such.key", (l, k) => reported.push(`${l}:${k}`));
  assert.equal(out, "no.such.key", "the debuggable degradation: the screen names the missing key");
  assert.deepEqual(reported, ["en:no.such.key"]);
});

test("i18n 回落 4: 空串按缺键处理，先落 zh 再落键名", () => {
  const halfFilled = { "zh-CN": { a: "甲" }, en: { a: "" } };
  assert.equal(resolveKey(halfFilled, "en", "a"), "甲");
  const bothEmpty = { "zh-CN": { a: "" }, en: { a: "" } };
  assert.equal(resolveKey(bothEmpty, "en", "a"), "a");
});

test("i18n 回落: 未知语言（未来版本写下的值）也走 zh，不抛错", () => {
  // Against the real tables: an unrecognised locale has no primary table, so
  // the chain lands on `DEFAULT_LOCALE` — the same answers the app boots with.
  const out = resolveKey(DICTIONARIES, "de", "view.projects");
  assert.equal(out, ZH["view.projects"]);
});

// r19-H1: EN fallback 循环。上面的回落钉子用的是 fixture 字典——它们钉的是
// resolveKey 的规则；这两条把**真实词表的每个键**走一遍真实 `tFor`，钉的是
// 规则在整张表上的结果。结构测试（键集一致、无空值）能被一条绕过真实取值
// 路径的回归骗过（比如 tFor 的参数序换了、locale 判定反了），行为循环不会。

test("i18n EN 循环: 每个键走真实 tFor 都取到英文自己的值，一个都不落回 zh（r19-H1）", () => {
  const fellBack: string[] = [];
  for (const key of ZH_KEYS) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    if (tFor("en", key) !== EN[key]) fellBack.push(key);
  }
  assert.deepEqual(fellBack, [], `${fellBack.length} 个键在英文下落回了 zh（或取值路径变了）: ${fellBack.slice(0, 12).join(", ")}${fellBack.length > 12 ? " …" : ""}`);
});

test("i18n EN 循环: 英文词条里没有 CJK——落回的英文界面就是中文界面（r19-H1）", () => {
  // The user-visible failure an EN gap produces is not an error, it is a
  // mixed-language UI. Whatever the resolve chain does, the shipped en table
  // itself must not carry Chinese bytes.
  const CJK = /[\u4e00-\u9fff]/;
  const tainted: string[] = [];
  for (const key of ZH_KEYS) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    if (CJK.test(EN[key] ?? "")) tainted.push(key);
  }
  assert.deepEqual(tainted, [], `这些键的英文值含中文字符: ${tainted.slice(0, 12).join(", ")}${tainted.length > 12 ? " …" : ""}`);
});

// ---------------------------------------------------------------------------
// 3. 插值

test("i18n 插值: 槽被填、两个槽都在、数字转字符串", () => {
  assert.equal(tFor("zh-CN", "strip.running", { n: 3 }), "运行中 3");
  assert.equal(tFor("en", "strip.running", { n: 3 }), "Running 3");
  // Two slots in one real entry, both locales: English may move them around,
  // it may not drop either — the slot-name test above pins that half.
  assert.equal(tFor("zh-CN", "strip.activeGroup", { ref: "a/b", n: 4 }), "a/b 等 4 项");
  assert.equal(tFor("en", "strip.activeGroup", { ref: "a/b", n: 4 }), "a/b and 4 more");
  // A slot inside quoted template text: the quotes survive, the slot fills.
  assert.equal(tFor("en", "titlebar.backTo", { target: "Projects" }), 'Back to "Projects"');
  // The same slot twice: `replaceAll` semantics, not「第一个」.
  const dicts = { zh: { d: "{x}-{x}" } };
  assert.equal(tFor2(dicts, "zh", "d", { x: "1" }), "1-1");
});

test("i18n 插值: 没有对应变量的槽原样留着，一个看得见的洞会自己报告", () => {
  const dicts = { zh: { d: "共 {n} 项" } };
  assert.equal(tFor2(dicts, "zh", "d"), "共 {n} 项");
  assert.equal(tFor2(dicts, "zh", "d", { m: 1 }), "共 {n} 项");
});

/**
 * `resolveKey` + the module's own `interpolate` (imported above, not
 * re-implemented here: a guard that copies the rule it guards proves nothing
 * once the two drift), composed the way `tFor` composes them — against a
 * fixture dictionary, since `tFor` only eats the real pair.
 */
function tFor2(
  dicts: Readonly<Record<string, Readonly<Record<string, string>>>>,
  locale: string,
  key: string,
  vars?: Record<string, string | number>,
): string {
  return interpolate(resolveKey(dicts, locale, key), vars);
}

// ---------------------------------------------------------------------------
// 4. 接线点不会指向没登记的键

test("i18n: 源码里每一处 t(\"…\") 字面量都是登记过的键", () => {
  const CALL = /\b(?:t|translate|tFor)\(\s*(?:locale,\s*)?"([^"]+)"\s*[,)]/g;
  const strays: string[] = [];
  for (const file of sourceFiles()) {
    codeLines(file).forEach((line, i) => {
      for (const m of line.matchAll(CALL)) {
        const key = at(m, 1);
        // `tFor("zh-CN", …)` in the tests passes a locale, not a key — the literal
        // that *is* a key is the second argument, matched by the same regex only
        // when it reads like a namespaced key.
        if ((LOCALES as readonly string[]).includes(key)) continue;
        if (!isTranslationKey(key)) strays.push(`${file}:${i + 1} ${key}`);
      }
    });
  }
  assert.deepEqual(strays, [], `unregistered key = the screen prints the key: ${strays.join(" | ")}`);
});

test("i18n: 每个 ViewId 都有 view.* 词条（侧栏、标题栏、命令面板共用）", () => {
  const views = Object.keys(VIEW_LABEL) as ViewId[];
  assert.ok(views.length >= 5, `VIEW_LABEL lost routes: ${views.join(",")}`);
  const missing = views.filter((v) => !isTranslationKey(`view.${v}`));
  assert.deepEqual(missing, [], `no dictionary entry for view(s): ${missing.join(", ")}`);
});

test("i18n: 每个设置分区都有 settings.section.* 词条", () => {
  // The `SettingsSectionId` union is the authority, and an id added there
  // without a 词条 is precisely the drift this assertion exists to catch.
  const found = catalogSectionIds();
  assert.ok(found.length >= 8, `section ids read as ${found.length}; the scan broke`);
  const missing = found.filter((id) => !isTranslationKey(`settings.section.${id}`));
  assert.deepEqual(missing, [], `no dictionary entry for section(s): ${missing.join(", ")}`);
});

test("i18n: 常用页可钉的视图也都有 view.* 词条", () => {
  const body = codeLines("src/settingsCatalog.tsx")
    .join("\n")
    .match(/export const PINNABLE_VIEWS[\s\S]*?\n\];/);
  assert.ok(body, "PINNABLE_VIEWS not found — update this scan with it");
  const ids = [...body[0].matchAll(/id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, `pinnable ids read as ${ids.length}; the scan broke`);
  const missing = ids.filter((id) => !isTranslationKey(`view.${id}`));
  assert.deepEqual(missing, [], `no dictionary entry for pinnable view(s): ${missing.join(", ")}`);
});

test("i18n: 词表里每个键都有接线点（登记了却没人读的键也是债）", () => {
  // The mirror of the call-site scan above: that one walks 调用点 → 键, this one
  // walks 键 → 调用点. Only pinning the first direction leaves a hole the size
  // of this direction's own failure: delete a surface's wiring (or a route the
  // `view.*` family was keyed against) and every remaining test stays green
  // while the dictionary carries a promise nothing renders.
  const read = new Set<string>();
  for (const file of sourceFiles()) {
    for (const line of codeLines(file)) {
      for (const m of line.matchAll(/\bt\(\s*"([^"]+)"/g)) read.add(at(m, 1));
    }
  }
  // The two id families compose their key at the call site (`viewTitle(t, id)`),
  // so for them a "reader" is a live id: the store's routes and the catalog's
  // section union. A key outside both families must appear as a `t("…")` literal.
  for (const id of Object.keys(VIEW_LABEL)) read.add(`view.${id}`);
  for (const id of catalogSectionIds()) read.add(`settings.section.${id}`);
  // r19-O1-A1: the wall enums compose their keys at the call site too
  // (`t(`wall.sort.${s.id}`)`); a "reader" is the live id in `store/wall.ts`.
  for (const s of SORTS) read.add(`wall.sort.${s.id}`);
  for (const f of FILTERS) read.add(`wall.filter.${f.id}`);
  for (const d of WALL_DENSITIES) {
    read.add(`wall.density.${d.id}`);
    read.add(`wall.density.${d.id}Note`);
  }
  // r19-O1-A3: AddRepoView composes its enum keys at the call site too —
  // `sp.click.*` from the result-click id tuple, `sp.sort.*` from the
  // SEARCH_SORTS ids. A "reader" is the live id in the component source.
  {
    const add = codeLines("src/views/AddRepoView.tsx").join("\n");
    const clicks = add.match(/\(\[([^\]]+)\] as const\)/);
    assert.ok(clicks, "result-click id tuple not found — update this scan with it");
    for (const raw of clicks[1]!.split(",")) read.add(`sp.click.${raw.trim().replace(/"/g, "")}`);
    const sorts = add.match(/const SEARCH_SORTS[\s\S]*?;\n/);
    assert.ok(sorts, "SEARCH_SORTS not found — update this scan with it");
    for (const m of sorts[0]!.matchAll(/\{\s*id:\s*"([^"]*)"\s*\}/g)) {
      if (m[1]) read.add(`sp.sort.${m[1]}`);
    }
  }
  const dead = ZH_KEYS.filter((k) => !read.has(k));
  assert.deepEqual(dead, [], `registered but never resolved: ${dead.join(", ")}`);
});

// ---------------------------------------------------------------------------
// 5. 默认语言逐字节 = 接线的历史字面量

test("i18n: 默认语言下 VIEW_LABEL 渲染出接线前的原话（逐字节）", () => {
  // The regression guard for「加 i18n 顺便改文案」. These five literals are what
  // `store/ui.ts` carried before the wiring, and the loop below is the identity
  // `i18n.ts`'s header promises: the dictionary's zh entry says the same bytes,
  // or the gate fails. (Reading `VIEW_LABEL` alone would only prove the table
  // still holds what someone typed into it.)
  assert.equal(VIEW_LABEL.projects, "项目");
  assert.equal(VIEW_LABEL.add, "添加");
  assert.equal(VIEW_LABEL.settings, "设置");
  assert.equal(VIEW_LABEL.records, "记录");
  assert.equal(VIEW_LABEL.frequent, "常用");
  for (const [id, label] of Object.entries(VIEW_LABEL)) {
    const key = `view.${id}`;
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), label, `${key} drifted from VIEW_LABEL.${id}`);
  }
});

test("i18n: 设置目录的中文原文与词表逐字节一致（接线的两侧互相钉住）", () => {
  // `settingsCatalog.tsx` is `.tsx`, so — like the id scans above — its labels
  // are read out of the source. Each row's literal is the wording the app
  // rendered before r16-n2-2; the dictionary's zh entry must equal it, or the
  // default locale moved as a side effect of the wiring.
  const src = readFileSync("src/settingsCatalog.tsx", "utf8");
  const block = (name: string): string => {
    const m = src.match(new RegExp(`export const ${name}[\\s\\S]*?\\n\\];`));
    assert.ok(m, `${name} not found — update this scan with it`);
    return m[0];
  };
  const rows = (body: string): [string, string][] =>
    [...body.matchAll(/id:\s*"([a-z-]+)",\s*label:\s*"([^"]+)"/g)].map((m): [string, string] => [at(m, 1), at(m, 2)]);

  const sections = rows(block("SETTINGS_SECTIONS"));
  assert.ok(sections.length >= 8, `section rows read as ${sections.length}; the scan broke`);
  for (const [id, label] of sections) {
    const key = `settings.section.${id}`;
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), label, `${key} drifted from the catalog's "${label}"`);
  }

  const pinnable = rows(block("PINNABLE_VIEWS"));
  assert.ok(pinnable.length >= 5, `pinnable rows read as ${pinnable.length}; the scan broke`);
  for (const [id, label] of pinnable) {
    const key = `view.${id}`;
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), label, `${key} drifted from the catalog's "${label}"`);
  }
});

test("i18n: 状态条那一句在默认语言下逐字节不变", () => {
  // Spacing is the part that drifts when a JSX text node becomes an expression,
  // so the two templates with a space in them are pinned as strings, not counts.
  assert.equal(tFor("zh-CN", "strip.link", { label: "直连" }), "链路：直连");
  assert.equal(tFor("zh-CN", "strip.running", { n: 2 }), "运行中 2");
  assert.equal(
    `${tFor("zh-CN", "strip.downloading", { n: 3 })} ${tFor("zh-CN", "strip.queued", { n: 2 })}`,
    "下载中 3 (+2 排队)",
  );
  assert.equal(tFor("zh-CN", "strip.downloadFailed", { n: 1 }), "下载失败 1");
  assert.equal(tFor("zh-CN", "strip.activeGroup", { ref: "a/b", n: 4 }), "a/b 等 4 项");
  // The palette composes its 去… rows as `palette.go` + a space + `view.*`
  // (CommandPalette), so the composition — not a `palette.goTo` template that
  // does not exist — is what must reproduce「去 项目」.
  assert.equal(`${tFor("zh-CN", "palette.go")} ${tFor("zh-CN", "view.projects")}`, "去 项目");
  assert.equal(tFor("zh-CN", "titlebar.backTo", { target: "项目" }), "后退到「项目」");
  assert.equal(tFor("zh-CN", "strip.ariaGroup"), "环境状态条 · 展开可看详情，内含 运行中 与 下载 两个控件");
});

test("i18n: 接线替换掉的每个中文字面量，在词表里逐字节不变", () => {
  // The exhaustive half of the「加 i18n 顺便改文案」guard: section 5 above pins
  // the wording the *tests* happen to quote (view / catalog / a few composed
  // templates); this table pins **every** literal the r16-n2-2 wiring moved
  // into the dictionary, quoted from the pre-wiring source (commit 8760ce0:
  // `src/shell/StatusStrip.tsx` and `src/shell/TitleBar.tsx`). Keys the wiring
  // introduced rather than replaced — the 语言 row's own copy — have no
  // original to preserve and are deliberately absent.
  const originals: Record<string, string> = {
    "strip.ariaGroup": "环境状态条 · 展开可看详情，内含 运行中 与 下载 两个控件",
    "strip.collapse": "收起环境详情",
    "strip.expand": "展开环境详情 · 双击卡片可跳到对应设置",
    "strip.link": "链路：{label}",
    "strip.gitMissing": "未安装",
    "strip.running": "运行中 {n}",
    "strip.runCollapse": "收起进程列表",
    "strip.runExpand": "{n} 个由本项目启动的进程正在运行 · 点击查看是哪些",
    "strip.downloading": "下载中 {n}",
    "strip.queued": "(+{n} 排队)",
    "strip.downloadFailed": "下载失败 {n}",
    "strip.downloadTitle": "点击跳到下载队列",
    "strip.activeGroup": "{ref} 等 {n} 项",
    "link.probing": "探测中…",
    "link.mirror": "镜像已启用",
    "link.accelAuto": "本地加速（hosts）{who} · 自动",
    "link.accelUnavailable": "本地加速（hosts）{who} · 绕过不可用（无公网地址）",
    "link.accelUseHosts": "本地加速（hosts）{who} · 沿用",
    "link.accelBypassed": "本地加速（hosts）{who} · 已绕过",
    "link.localProxy": "本地代理 {addr}",
    "link.systemProxy": "系统代理 {addr}",
    "link.direct": "直连 · DNS {ip}",
    "link.directUnresolved": "直连 · 解析未达成一致",
    "titlebar.backTo": "后退到「{target}」",
    "titlebar.fwdTo": "前进到「{target}」",
    "titlebar.noBack": "没有可后退的页面",
    "titlebar.noFwd": "没有可前进的页面",
    "palette.go": "去",
    // r17-o1-1: RepoTile always-visible labels (commit before wiring: the strings
    // below were the literals in src/components/RepoTile.tsx).
    "tile.running": "运行中",
    "tile.suspended": "挂起",
    "tile.pinned": "置顶",
    "tile.open": "打开",
    "tile.cached": "有缓存",
    "tile.installedOn": "{date} 安装",
    // r17-o1-2: DownloadQueue panel header + status words.
    "queue.title": "下载队列",
    "queue.runningN": "{n} 进行中",
    "queue.queuedTail": " · {n} 排队",
    "queue.failedTail": " · {n} 失败",
    "queue.maxParallel": "最多同时 {n} 个",
    "queue.clearFinished": "清除已完成",
    "queue.statusQueued": "排队中",
    "queue.statusRunning": "下载中",
    "queue.statusDone": "已完成",
    "queue.statusFailed": "失败",
    // r17-o1-3: project-settings dialog section headers + save button.
    "dialog.displaySection": "显示与位置",
    "dialog.launchSection": "该项目的启动默认值",
    "dialog.save": "保存",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // Two templates whose *filling* was inline before: the slot carries what the
  // call site used to paste in, so the rendered sentence must match too.
  assert.equal(
    tFor("zh-CN", "strip.runExpand", { n: 3 }),
    "3 个由本项目启动的进程正在运行 · 点击查看是哪些",
  );
  assert.equal(tFor("zh-CN", "titlebar.fwdTo", { target: "记录" }), "前进到「记录」");
});

// ---------------------------------------------------------------------------
// 5b. r17 第三批：记录页接线的历史字面量（逐字节）

test("i18n: 记录页接线搬进词表的每个中文字面量逐字节不变（r17-n1-1）", () => {
  // Same guard as section 5's exhaustive table, for the records surface. Each
  // value is quoted from the pre-wiring source (`RecordsView.tsx`,
  // `records/RecordRow.tsx`, `records/RetentionRows.tsx`, and the two data tables
  // in `records/constants.ts` the chip row renders). Keys the wiring *introduced*
  // rather than replaced have no original and are deliberately absent.
  // `records.emptyHint`: JSX folds the two source lines of the old paragraph into
  // one string with a single space where the line break was — that space is what
  // shipped, so it is what is pinned.
  const originals: Record<string, string> = {
    "records.hint": "下载、删除、清理、启动、终端、IDE、设置与界面的操作历史",
    "records.selectedCount": "已选 {n}",
    "records.selectAll": "全选",
    "records.deselectAll": "取消全选",
    "records.deleteSelected": "删除所选",
    "records.exitSelection": "退出选择",
    "records.batchSelect": "批量选择",
    "records.exportMd": "导出 Markdown",
    "records.exportJsonl": "导出 JSONL",
    "records.clearAll": "清空记录",
    "records.show": "显示",
    "records.searchAria": "搜索记录",
    "records.searchPlaceholder": "搜索记录…",
    "records.retentionPending": "保留 …",
    "records.retentionForever": "永久保留",
    "records.retentionDays": "保留 {n} 天",
    "records.retentionTitleAuto": "自动清理永远保留最近这些天的记录",
    "records.retentionTitleRead": "读取记录时裁掉超过这个天数的部分",
    "records.loading": "正在读取记录…",
    "records.loadFailed": "加载记录失败：{msg}",
    "records.emptyTitle": "还没有操作记录",
    "records.emptyHint":
      "下载、删除、清理、修改启动命令或界面设置之后，做过什么会自动列在这里， 包括在哪个界面做的、动了哪个项目、改之前是什么值。",
    "records.noMatchTitle": "没有匹配的记录",
    "records.noVisibleTitle": "没有可显示的记录",
    "records.noMatchHint": "{words} 在 {n} 条记录里都没有命中。",
    "records.clearFilters": "清除筛选",
    "records.showMore": "显示更多（还有 {n} 组）",
    "records.times": "{n} 次",
    // The chip values, quoted from `records/constants.ts` TAGS / RANGES.
    "records.tag.all": "全部",
    "records.tag.download": "下载",
    "records.tag.delete": "删除",
    "records.tag.clear": "清理",
    "records.tag.launch": "启动",
    "records.tag.terminal": "终端",
    "records.tag.ide": "IDE",
    "records.tag.settings": "设置",
    "records.tag.appearance": "外观",
    "records.tag.interface": "界面",
    "records.range.all": "不限时间",
    "records.range.1d": "今天",
    "records.range.7d": "7 天",
    "records.range.30d": "30 天",
    "records.range.90d": "90 天",
    // The no-match sentence, quoted from `records/filter-words.ts`.
    "records.filter.tag": "类别「{label}」",
    "records.filter.range": "时间「{label}」",
    "records.filter.query": "搜索「{query}」",
    "records.filter.anyTag": "已选类别",
    "records.filter.anyRange": "已选时间",
    // RetentionRows' MiniRow labels / hints, and the two data tables they render.
    "records.retention.title": "保留时长",
    "records.retention.hint": "读取记录时裁掉超过这个天数的部分，读到才删。",
    "records.retention.forever": "永久",
    "records.retention.days": "{n} 天",
    "records.cleanup.title": "自动清理",
    "records.cleanup.hint": "自动清理的频率。选「手动」则不主动清。",
    "records.cleanup.manual": "手动",
    "records.cleanup.daily": "每天",
    "records.cleanup.weekly": "每周",
    "records.cleanup.monthly": "每月",
    "records.keep.title": "清理时保留",
    "records.keep.hint": "自动清理执行时永远保留最近这么多天的记录，即便它们已超过保留时长。",
    "records.keep.disabledHint": "自动清理为「手动」时此项不生效；改为每天/每周/每月后可设。",
    "records.keep.notApplicable": "手动模式下不适用",
    "records.time.title": "显示时间",
    "records.time.hint": "只影响这一页怎么打印时间，不改记录本身。",
    "records.timeFormat.hms": "时分秒",
    "records.timeFormat.hm": "时分",
    "records.timeFormat.relative": "相对时间",
    "records.timeFormat.full": "完整日期",
    "records.goSettings": "到设置页的「记录」分组里改这些",
    // RecordRow's own copy and tooltips.
    "records.row.select": "选择这条记录",
    "records.row.undone": "已回退",
    "records.row.undoneTitle": "这条记录的回退已经执行过",
    "records.row.sourceUnknown": "界面未知",
    "records.row.none": "（无）",
    "records.row.targetTitle": "对象：{target}",
    "records.row.openPanelTitle": "打开 {slug} 的操作面板",
    "records.row.undo": "回退这次操作",
    "records.row.delete": "删除这条记录",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // Two templates whose *filling* was inline before: the slot carries what the call
  // site used to paste in, so the rendered sentence must match too.
  assert.equal(tFor("zh-CN", "records.selectedCount", { n: 3 }), "已选 3");
  assert.equal(tFor("zh-CN", "records.noMatchHint", { words: "类别「外观」", n: 12 }), "类别「外观」 在 12 条记录里都没有命中。");
  assert.equal(tFor("zh-CN", "records.times", { n: 5 }), "5 次");
  assert.equal(tFor("zh-CN", "records.showMore", { n: 2 }), "显示更多（还有 2 组）");
  assert.equal(tFor("zh-CN", "records.retentionDays", { n: 30 }), "保留 30 天");
  assert.equal(tFor("zh-CN", "records.row.openPanelTitle", { slug: "a/b" }), "打开 a/b 的操作面板");
});

// ---------------------------------------------------------------------------
// 5c. r17 第三批：常用页与卡片右键菜单接线的历史字面量（逐字节）

test("i18n: 常用页与卡片菜单接线搬进词表的每个中文字面量逐字节不变（r17-n1-2）", () => {
  // Each value is quoted from the pre-wiring source (`FrequentView.tsx`, and
  // `ProjectsView.tsx`'s `buildMenu`). `frequent.pinnedHint` is the one entry
  // that carries a slot in place of the ✕ glyph: U+2715 sits inside the
  // code-point range `i18n: 英文词条不带 emoji` forbids in either table, so the
  // glyph stays at the call site and is filled back in for the assertion below.
  const originals: Record<string, string> = {
    "frequent.hint": "固定的项目与功能排在最前，其余按最近使用自动汇总",
    "frequent.editStart": "自定义这一页",
    "frequent.editDone": "完成",
    "frequent.searchPlaceholder": "搜索项目或功能…",
    "frequent.searchAria": "搜索要固定的项目或功能",
    "frequent.clearSearch": "清空搜索",
    "frequent.noMatch": "没有匹配的项目或功能",
    "frequent.allPinned": "所有项目和功能都已在常用里",
    "frequent.groupViews": "页面",
    "frequent.emptyTitle": "还没有常用内容",
    "frequent.emptyHint":
      "打开过的项目会自动列在「最近使用」里。点「添加」或网格里的 + 把项目、页面、设置固定到最前面。",
    "frequent.pinnedTitle": "固定项",
    "frequent.pinnedEditHint":
      "拖动卡片，或用键盘调整顺序：Tab 聚焦卡片，空格拿起，方向键移动，空格或 Esc 放下；点垃圾桶移除；改动立即生效并保存在本机。此页面内所有卡片不可点击。",
    "frequent.pinnedEmpty": "还没有固定项，点上方「添加」从项目、页面或设置里挑。",
    "frequent.recentTitle": "最近使用",
    "frequent.recentHint": "按打开次数与最近程度自动排序；点图钉把它固定到上面，固定的项目不重复出现。",
    "frequent.blocksTitle": "钉选的区块",
    "frequent.unpin": "取消钉选",
    "frequent.settingsTitle": "常用设置",
    "frequent.settingsHint": "点一下直接跳到那一项。",
    "frequent.offDisk": "已不在磁盘",
    "frequent.offDiskTitle": "这个项目已不在磁盘上",
    "frequent.remove": "从常用移除",
    "frequent.pin": "固定到常用",
    "frequent.pinAnyway": "仍然固定它",
    "frequent.revealDir": "打开所在目录",
    "frequent.openCountTitle": "被打开过 {n} 次",
    "frequent.removeConfirm": "确定把「{name}」从常用里移除吗？文件不会动。",
    "frequent.removeDialogTitle": "移除常用项",
    "frequent.removeOk": "移除",
    "frequent.removeCancel": "取消",
    "frequent.sortableItem": "可排序项",
    "frequent.itemAria": "{label}，第 {i} / {n} 项。{state}",
    "frequent.itemStateGrabbed": "已拿起，方向键移动，空格放下",
    "frequent.itemStateIdle": "空格或 Enter 拿起后可用方向键调整顺序",
    "frequent.position": "第 {i} / {n} 项",
    "menu.panel": "打开操作面板",
    "menu.reveal": "在资源管理器打开",
    "menu.revealNoPath": "磁盘上没有这个目录",
    "menu.homepage": "在浏览器打开仓库",
    "menu.update": "更新",
    "menu.updateBusy": "更新中…",
    "menu.busy": "正在处理",
    "menu.pin": "置顶",
    "menu.unpin": "取消置顶",
    "menu.pinNote": "排在最前",
    "menu.hide": "从项目墙隐藏",
    "menu.hideRunningNote": "它还在运行",
    "menu.hideNote": "不删文件",
    "menu.tags": "标签…",
    "menu.tagsCount": "{n} 个",
    "menu.tagsNone": "无",
    "menu.settings": "项目设置…",
    "menu.trash": "删除（移入回收站）",
    "menu.trashBusy": "处理中…",
    "menu.trashNote": "可还原",
    "menu.permanent": "永久删除",
    "menu.permanentNote": "不可恢复",
    "menu.forNamed": "{name} 的操作",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // The slot-bearing entry, filled back to the pre-wiring sentence.
  assert.equal(
    tFor("zh-CN", "frequent.pinnedHint", { x: "✕" }),
    "项目与功能都可以固定在这里。悬停时点右下 ✕ 移除，或进「自定义这一页」批量整理。",
  );
  // Templates whose filling was inline before: the rendered sentence must match.
  assert.equal(
    tFor("zh-CN", "frequent.itemAria", { label: "x", i: 2, n: 5, state: "已拿起，方向键移动，空格放下" }),
    "x，第 2 / 5 项。已拿起，方向键移动，空格放下",
  );
  assert.equal(tFor("zh-CN", "frequent.position", { i: 2, n: 5 }), "第 2 / 5 项");
  assert.equal(tFor("zh-CN", "frequent.openCountTitle", { n: 4 }), "被打开过 4 次");
  assert.equal(tFor("zh-CN", "frequent.removeConfirm", { name: "a/b" }), "确定把「a/b」从常用里移除吗？文件不会动。");
  assert.equal(tFor("zh-CN", "menu.tagsCount", { n: 3 }), "3 个");
  assert.equal(tFor("zh-CN", "menu.forNamed", { name: "rust" }), "rust 的操作");
});

// ---------------------------------------------------------------------------
// 5d. r17 第三批：设置页行文案接线的历史字面量（逐字节）

test("i18n: 设置页接线搬进词表的每个中文字面量逐字节不变（r17-n1-3）", () => {
  // Quoted from the pre-wiring source (`SettingsView.tsx`, `settings/rows.tsx`).
  // The multi-line JSX paragraphs fold their line breaks into single spaces, so
  // the two entries that came from such a paragraph (`hostsNotice`,
  // `keepDisabledNote`) carry that folded space in their value. The two plain
  // strings with a leading space (`mainDirHintDefault`, and the `{x}` tail below)
  // keep it too — it is what the source rendered.
  const originals: Record<string, string> = {
    "settings.page.hint": "改动自动保存，无需重启",
    "settings.page.rootBlocked": "项目目录不可用，改动不会保存：{msg}",
    "settings.page.saveFailed": "保存失败：{msg}",
    "settings.page.catalogAria": "设置目录",
    "settings.page.rootsTitle": "项目目录",
    "settings.page.rootsFootnoteLead": "每个仓库一个目录：",
    "settings.page.rootsFootnoteTail": "。Program Files 不可写。",
    "settings.page.rootsEmptyHint": "这些目录里的项目会显示在项目墙上。切换主目录时，上一个主目录会自动加进来。",
    "settings.page.rootsListHint": "这些目录里的项目会显示在项目墙上；切换主目录时上一个自动转为「附加」。",
    "settings.page.browse": "浏览…",
    "settings.page.mainDirTitle": "主目录",
    "settings.page.mainDirHint": "离开输入框、按回车或用「浏览」选择都会保存并生效。",
    "settings.page.mainDirHintDefault": " 当前是自动推导的默认值。",
    "settings.page.mainDirField": "项目根目录",
    "settings.page.addExtra": "加入附加",
    "settings.page.addExtraHint": "加入附加目录，让这里的项目继续显示在项目墙上",
    "settings.page.setMainTitle": "把这个目录设为主目录：{path}",
    "settings.page.setMain": "设为主目录",
    "settings.page.removeRecent": "从历史中移除",
    "settings.page.remove": "移除",
    "settings.page.networkFootnote": "启用镜像意味着代码经由第三方服务器传输，请只信任你知道的源。",
    "settings.page.ipPinTitle": "DNS 失败时钉死 IP",
    "settings.page.ipPinHint": "多解析器一致时才采用，保留主机名与证书校验。",
    "settings.page.mirrorTitle": "允许第三方镜像",
    "settings.page.mirrorHint": "默认关闭；开启后代码经由第三方传输，界面会标注。",
    "settings.page.proxyTitle": "本地代理（可选）",
    "settings.page.proxyHintLead":
      "留空则自动探测常见端口（Watt Toolkit 26501、Clash 7890 等）。这里填的值也会被探测尝试，并且",
    "settings.page.proxyHintStrong": "只用于本次下载调用，不会写入你的全局 git 配置",
    "settings.page.proxyHintTail": "。",
    "settings.page.proxyAria": "代理地址",
    "settings.page.mirrorsTitle": "镜像源",
    "settings.page.mirrorsHint": "仅在开启镜像后使用：完整 URL 拼前缀，只写域名用 insteadOf。",
    "settings.page.mirrorAria": "镜像 {i}",
    "settings.page.mirrorPlaceholder": "https://gh-proxy.com/ 或 hk.gh-proxy.com",
    "settings.page.removeMirror": "移除镜像",
    "settings.page.mirrorsEmpty": "列表为空，将使用内置默认镜像。",
    "settings.page.addMirror": "添加镜像源",
    "settings.page.searchRouteTitle": "搜索链路",
    "settings.page.searchRouteHint": "GitHub 域名被 hosts 指向本机时，搜索请求走哪条路。",
    "settings.page.routeBypass": "绕过",
    "settings.page.routeUseHosts": "沿用加速",
    "settings.page.downloadRouteTitle": "下载链路",
    "settings.page.downloadRouteHint": "克隆仓库时是否同样绕过 hosts。下载器另有四层回退。",
    "settings.page.cloneStrategyTitle": "克隆深度策略",
    "settings.page.cloneStrategyHint":
      "默认完整克隆。浅克隆实测省 85–96 % 的 .git 体积，但读不到旧提交（回退、blame 类操作会失败），需要先 git fetch --unshallow 才能补回历史；无 blob 克隆只在支持过滤的服务器上有意义，且 git 在服务器忽略该参数时仍然报成功——所以选非默认档时，下载记录里会写明它到底生效了没有。依据见 docs/clone-strategy.md。",
    "settings.page.cloneFull": "完整（默认）",
    "settings.page.cloneShallow": "浅克隆（只取最近一次提交）",
    "settings.page.cloneBlobless": "无 blob 克隆（内容按需取回）",
    "settings.page.hostsByParen": "（{by}）",
    "settings.page.routeBypassed": "已绕过",
    "settings.page.routeUseHostsShort": "沿用",
    "settings.page.debounceTitle": "搜索输入停顿",
    "settings.page.debounceHint": "毫秒。超过 5000 只手动搜索，点「搜索」才执行。",
    "settings.page.debounceAria": "搜索停顿毫秒",
    "settings.page.parallelTitle": "同时下载数",
    "settings.page.parallelHint": "并行克隆的仓库数量。太多会互相抢带宽，反而更慢。",
    "settings.page.parallelAria": "同时下载数",
    "settings.page.editorsTitle": "编辑器与 IDE",
    "settings.page.editorsFootnote": "识别顺序：卸载记录 → 注册表 → 常见安装位置 → PATH；找不到就手动指定。",
    "settings.page.terminalTitle": "默认终端",
    "settings.page.terminalFailed": "读取列表失败，下面的选择可能不完整；按钮仍可用默认终端打开。",
    "settings.page.terminalLoading": "正在检测本机终端…",
    "settings.page.terminalEmpty": "本机未检测到可用终端。",
    "settings.page.terminalCount": "本机检测到 {n} 个。",
    "settings.page.terminalAuto": "自动（PowerShell 7）",
    "settings.page.ideTitle": "默认 IDE",
    "settings.page.ideFailed": "读取列表失败，下面的选择可能不完整；按钮仍可用默认 IDE 打开。",
    "settings.page.ideLoading": "正在检测本机 IDE…",
    "settings.page.ideEmpty": "本机未检测到可用 IDE。",
    "settings.page.ideCount": "本机检测到 {n} 个：{list}",
    "settings.page.ideAuto": "自动（列表第一个）",
    "settings.page.customIdeTitle": "手动指定 IDE 程序",
    "settings.page.customIdeHint": "识别不到时，直接选它的 .exe。",
    "settings.page.chooseApp": "选择程序…",
    "settings.page.removeCustomIde": "移除这个自定义 IDE",
    "settings.page.recordsFootnote": "保留时长会真的删除超期记录，不是筛选；缩短前请先导出。",
    "settings.page.cleanupHint": "按计划主动执行清理的频率。手动＝不主动清，只靠保留时长在读取时裁掉超龄记录。",
    "settings.page.clearRecordsTitle": "清空全部操作记录",
    "settings.page.clearRecordsHint": "立即删除整个历史文件，不可撤销。",
    "settings.page.clear": "清空",
    "settings.page.tokenFootnote": "Token 以 Windows DPAPI 加密保存在配置文件里（{path}），只有当前 Windows 用户能解密；换机或换用户后需要重新填写。请使用权限最小的 Token。",
    "settings.page.tokenSaved": "已保存一个 Token",
    "settings.page.tokenMissing": "未配置 Token",
    "settings.page.tokenHint": "匿名额度 10 次/分钟；填入 Token 后 30 次/分钟。",
    "settings.page.tokenKeepPlaceholder": "留空则保持不变",
    "settings.page.tokenPastePlaceholder": "粘贴 Token",
    "settings.page.tokenDeleted": "已删除 Token",
    "settings.page.tokenDeleteButton": "删除已存 Token",
    "settings.page.tokenDeleteConfirm":
      "删除已保存的 GitHub Token？删除后搜索会退回未登录的限额（10 次/分钟），需要重新填入。",
    "settings.page.tokenDeleteTitle": "删除 GitHub Token",
    "settings.page.delete": "删除",
    "settings.page.configPathLead": "配置文件：",
    "settings.page.save.blocked": "目录不可用，未保存",
    "settings.page.save.busy": "保存中…",
    "settings.page.save.queued": "即将保存…",
    "settings.page.save.done": "已自动保存",
    "settings.page.save.idle": "改动自动保存",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // The two folded JSX paragraphs, and the sentence assembled out of them.
  assert.equal(
    tFor("zh-CN", "settings.page.hostsNotice", { by: "", search: "已绕过", download: "沿用" }),
    "检测到 hosts 把 GitHub 指向本机。 当前策略：搜索已绕过， 下载沿用。",
  );
  assert.equal(
    tFor("zh-CN", "settings.page.hostsNotice", {
      by: tFor("zh-CN", "settings.page.hostsByParen", { by: "hostsX" }),
      search: "沿用",
      download: "已绕过",
    }),
    "检测到 hosts 把 GitHub 指向本机（hostsX）。 当前策略：搜索沿用， 下载已绕过。",
  );
  assert.equal(
    tFor("zh-CN", "settings.page.keepDisabledNote"),
    "清理时保留：自动清理当前是「手动」，这一项不生效——它是自动清理执行时的下限。 把上面的「自动清理」改为每天/每周/每月即可设置。",
  );
  // Templates whose filling was inline before: the rendered sentence must match.
  assert.equal(tFor("zh-CN", "settings.page.rootBlocked", { msg: "x" }), "项目目录不可用，改动不会保存：x");
  assert.equal(tFor("zh-CN", "settings.page.mainDirHintDefault"), " 当前是自动推导的默认值。");
  assert.equal(tFor("zh-CN", "settings.page.setMainTitle", { path: "D:\\a" }), "把这个目录设为主目录：D:\\a");
  assert.equal(tFor("zh-CN", "settings.page.mirrorAria", { i: 2 }), "镜像 2");
  assert.equal(tFor("zh-CN", "settings.page.terminalCount", { n: 3 }), "本机检测到 3 个。");
  assert.equal(tFor("zh-CN", "settings.page.ideCount", { n: 2, list: "a、b" }), "本机检测到 2 个：a、b");
  assert.equal(tFor("zh-CN", "settings.page.tokenFootnote", { path: "C:\\c.json" }), "Token 以 Windows DPAPI 加密保存在配置文件里（C:\\c.json），只有当前 Windows 用户能解密；换机或换用户后需要重新填写。请使用权限最小的 Token。");
  assert.equal(
    `${tFor("zh-CN", "settings.page.proxyHintLead")}<${tFor("zh-CN", "settings.page.proxyHintStrong")}>${tFor("zh-CN", "settings.page.proxyHintTail")}`,
    "留空则自动探测常见端口（Watt Toolkit 26501、Clash 7890 等）。这里填的值也会被探测尝试，并且<只用于本次下载调用，不会写入你的全局 git 配置>。",
  );
});

// ---------------------------------------------------------------------------
// 5e. r18 第四批：四个仓库面板接线的历史字面量（逐字节）

test("i18n: 四个仓库面板接线搬进词表的每个中文字面量逐字节不变（r18-o1-1）", () => {
  // Quoted from the pre-wiring source (`RepoPortPanel.tsx`, `RepoWorktreesPanel.tsx`,
  // `RepoPythonPanel.tsx`, `RepoSyncPanel.tsx`). The split entries (Lead / Strong /
  // Mid / Tail / Suffix) are the pieces the panels concatenate around <strong>,
  // <code> and each other; the composition assertions at the bottom put them back
  // together byte-for-byte, spaces included — that is where a dropped space around
  // an inline element would show up. `port.retry` / `sync.retry` (and the like) are
  // separate keys because the two panels own their copy separately, the 取消 pair
  // likewise.
  const originals: Record<string, string> = {
    "port.staleError": "上次端口检查失败：{msg}。下面显示的是再上一次的结果，可能已经过期。",
    "port.probeError": "端口健康检查失败：{msg}。这不代表端口没在监听，是这个面板没读到答案。",
    "port.retry": "重试",
    "port.noPorts": "本来这里会逐个连一下本仓库分配到的端口。",
    "port.title": "端口健康",
    "port.listeningCount": "{up}/{n} 个端口在监听",
    "port.chipOpenTitle": "{service} 端口 {port}：有服务在监听，可直接打开",
    "port.chipClosedTitle": "{service} 端口 {port}：暂无人监听——可能还在启动，也可能没有绑定这个端口",
    "port.listening": "监听中",
    "port.notListening": "未监听",
    "port.openTitle": "在浏览器打开 {url}",
    "port.open": "打开",
    "port.footnote": "进程活着不代表服务起来了：这里逐个连一下本仓库分配到的端口。没监听可能只是还在启动。",
    "wt.title": "工作树",
    "wt.loading": "正在问 git…",
    "wt.empty": "还没有读到列表。",
    "wt.summary": "{n} 个工作树。工作树是同一个仓库的第二份工作目录，共用同一条 git 历史，所以每个任务可以各自占一个目录、互不打断。它们都放在 {dir}，这个目录不会被扫描成项目。",
    "wt.refresh": "刷新",
    "wt.badgeMain": "主工作树",
    "wt.badgeStale": "登记可清理",
    "wt.badgeMissing": "目录已不在",
    "wt.reveal": "在资源管理器里打开这个目录",
    "wt.open": "打开",
    "wt.removeTitle": "删除这个工作树（git worktree remove）",
    "wt.remove": "删除",
    "wt.removeLead": "这会把 {path} 从磁盘上删掉。",
    "wt.removeStrong": "不进回收站",
    "wt.removeTail": "：目录是 git 自己删的。",
    "wt.branchKept": "分支 {branch} 仍然留在仓库里。",
    "wt.detached": "这是一个分离头指针的工作树，删除后它上面的提交只能靠仓库里的对象找回。",
    "wt.forceHint": "强制删除（连未提交的内容一起，对应 git worktree remove --force）",
    "wt.removing": "删除中…",
    "wt.confirmForce": "确认强制删除",
    "wt.confirmRemove": "确认删除",
    "wt.cancel": "取消",
    "wt.createTitle": "新建工作树",
    "wt.createCommand": "会执行 git worktree add {cmd}{placement}。目录已存在、分支已被别的树占用、或名字不合规则会被 git 拒绝，并把它的原话说回来。",
    "wt.branchHint": "分支名可以带 /（feat/login），落成目录时按 _worktrees 的既有规则换成 __。名字太长或想单独命名时，用子目录名覆盖这一截。",
    "wt.branchPlaceholderNew": "新分支名，如 dev 或 feat/login",
    "wt.branchPlaceholderExisting": "已有分支名，如 main",
    "wt.branchAria": "工作树的分支名",
    "wt.subdirPlaceholder": "子目录名（可选）",
    "wt.subdirAria": "工作树目录名的后缀",
    "wt.newBranch": "新建分支",
    "wt.create": "创建",
    "wt.preview": "落位：{preview}",
    "wt.loadFailed": "读取工作树列表失败：{msg}",
    "wt.needBranch": "先填一个分支名。",
    "wt.created": "已创建 {path}（{label}）",
    "wt.createFailed": "创建工作树失败：{msg}",
    "wt.removeFailed": "删除工作树失败：{msg}",
    "wt.revealFailed": "打开目录失败",
    "py.listFailed": "读取本机 Python 列表失败：{msg}",
    "py.locked": "已锁定该仓库使用的 Python",
    "py.followed": "已恢复跟随虚拟环境 / PATH",
    "py.saveFailed": "保存 Python 选择失败：{msg}。当前仍是原来的解释器，没有改动。",
    "py.needInterpreter": "先选一个 Python 解释器，再创建虚拟环境。",
    "py.ready": "已就绪：{path}",
    "py.createFailed": "创建虚拟环境失败：{msg}",
    "py.opFailed": "处理虚拟环境失败：{msg}",
    "py.revealFailed": "打开目录失败",
    "py.loading": "正在枚举本机 Python…",
    "py.empty": "本机没有可用的 Python：既找不到 py 启动器，PATH 里也没有 python。依赖安装与虚拟环境都需要先装一个。",
    "py.fallback": "未找到 py 启动器，只能列出 PATH 上的 python——这台机器上只有一个可选项。",
    "py.count": "来自 py 启动器（py -0p），共 {n} 个。",
    "py.title": "Python 解释器",
    "py.follow": "跟随虚拟环境 / PATH",
    "py.selectAria": "该仓库使用的 Python",
    "py.venvTitle": "虚拟环境",
    "py.venvBlocked": "本机没有可用 Python，无法创建虚拟环境——先装一个再回来。位置是 项目\\venvs\\<repo>_<owner>，在仓库之外。",
    "py.open": "打开",
    "py.createVenvTitle": "运行 <所选 python> -m venv <目录>，并把该目录写回这条记录；已有真实环境时是重新记录，不会清空目录内容",
    "py.cleanupLabel": "清理：",
    "py.toBinTitle": "把环境目录移入回收站，并清除记录；还原由 Windows 负责",
    "py.toBinNoDirTitle": "磁盘上没有属于这条记录的目录，只清除记录即可",
    "py.toBinBusy": "移入回收站…",
    "py.toBin": "移入回收站",
    "py.destroyTitle": "不可恢复地删除目录；自己没创建过的目录不会被删除，只会清除记录",
    "py.destroyBusy": "删除中…",
    "py.destroy": "彻底删除",
    "py.forgetTitle": "只清除记录里的环境路径，不动任何目录——用于环境被搬走、或由别的工具管理的情况",
    "py.forgetBusy": "清除中…",
    "py.forget": "只清除记录",
    "py.destroyLead": "彻底删除",
    "py.destroyStrong": "不可恢复",
    "py.destroyTail": "：{dir}，以及里面已经安装的全部依赖包都会消失，回收站里也找不到。输入 ",
    "py.destroySuffix": " 以确认：",
    "py.thisDir": "该目录",
    "py.destroyAria": "输入 {slug} 以确认彻底删除虚拟环境",
    "py.destroyConfirm": "确认彻底删除",
    "py.cancel": "取消",
    "sync.stateFresh": "已是最新",
    "sync.stateBehind": "落后于远程",
    "sync.stateUnknown": "无法确认",
    "sync.stateNoGit": "没有 git 历史",
    "sync.stateMissing": "远程仓库不存在或不可读",
    "sync.freshnessFailed": "检查新鲜度失败：{msg}",
    "sync.planFailed": "读取依赖安装方案失败：{msg}",
    "sync.updateFailed": "更新仓库失败：{msg}",
    "sync.installFailed": "安装依赖失败：{msg}",
    "sync.ranAsStep": "已作为第 1 步执行：{command}（PID {pid}）",
    "sync.title": "同步与依赖",
    "sync.updateTitle": "git pull --ff-only：只接受快进，不替你合并",
    "sync.updateBusy": "更新中…",
    "sync.update": "更新仓库",
    "sync.freshnessTitle": "只问一次远程的 HEAD，结果缓存五分钟",
    "sync.freshness": "检查新鲜度",
    "sync.reason": "原因：{msg}",
    "sync.heads": "本地 {local} / 远程 {remote}",
    "sync.installDeps": "装依赖",
    "sync.layerNoteLead": "更新按层级回退：直连 → IP 钉死 → 本地代理；",
    "sync.layerNoteStrong": "只有当你启用了第三方镜像",
    "sync.layerNoteMid": "才会多走一条经 ",
    "sync.layerNoteTail": " 改写 origin 的镜像层（该路径在本机未经实测）。",
    "sync.retry": "重试",
    "sync.basis": "依据文件：{list}",
    "sync.none": "无",
    "sync.toolMissingLead": "这台机器上找不到 ",
    "sync.toolMissingTail": "。可以先装工具，再回来执行这条命令。",
    "sync.installBusy": "执行中…",
    "sync.confirmInstall": "确认并安装",
    "sync.confirmInstallHint": "确认后它会作为第 1 步写入本仓库的启动步骤（可在启动面板里删除）",
    "sync.upToDate": "已是最新（HEAD {head}，链路 {layer}）",
    "sync.forwarded": "已快进 {before} → {after}{commits}（链路 {layer}）",
    "sync.commitsAdded": "，新增 {n} 个提交",
    "sync.commitsUnknown": "本次 HEAD 有变化，但 git 数不出提交数（浅克隆或被改写过历史），所以不报「N 个新提交」。",
    "sync.mirrorWarning": "代码经由第三方镜像传输（更新不应出现这一条，见到即为异常）。",
    "sync.output": "过程输出（{n} 行）",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // Composed sentences, put back together the way each panel renders them.
  assert.equal(tFor("zh-CN", "port.listeningCount", { up: 1, n: 3 }), "1/3 个端口在监听");
  assert.equal(
    tFor("zh-CN", "port.chipOpenTitle", { service: "web", port: 5173 }),
    "web 端口 5173：有服务在监听，可直接打开",
  );
  assert.equal(tFor("zh-CN", "port.openTitle", { url: "http://127.0.0.1:5173" }), "在浏览器打开 http://127.0.0.1:5173");
  assert.equal(
    tFor("zh-CN", "wt.summary", { n: 2, dir: "D:\\proj\\_worktrees" }),
    "2 个工作树。工作树是同一个仓库的第二份工作目录，共用同一条 git 历史，所以每个任务可以各自占一个目录、互不打断。它们都放在 D:\\proj\\_worktrees，这个目录不会被扫描成项目。",
  );
  assert.equal(tFor("zh-CN", "wt.preview", { preview: "feat__login" }), "落位：feat__login");
  assert.equal(
    tFor("zh-CN", "wt.createCommand", { cmd: "-b dev ", placement: "dev__hotfix" }),
    "会执行 git worktree add -b dev dev__hotfix。目录已存在、分支已被别的树占用、或名字不合规则会被 git 拒绝，并把它的原话说回来。",
  );
  assert.equal(
    tFor("zh-CN", "wt.createCommand", { cmd: "", placement: "dev__hotfix" }),
    "会执行 git worktree add dev__hotfix。目录已存在、分支已被别的树占用、或名字不合规则会被 git 拒绝，并把它的原话说回来。",
  );
  // The confirm paragraph folds its newline before the branch sentence, so the
  // four pieces concatenate with no seam.
  assert.equal(
    `${tFor("zh-CN", "wt.removeLead", { path: "D:\\w" })}${tFor("zh-CN", "wt.removeStrong")}${tFor("zh-CN", "wt.removeTail")}${tFor("zh-CN", "wt.branchKept", { branch: "dev" })}`,
    "这会把 D:\\w 从磁盘上删掉。不进回收站：目录是 git 自己删的。分支 dev 仍然留在仓库里。",
  );
  assert.equal(
    `${tFor("zh-CN", "wt.removeLead", { path: "D:\\w" })}${tFor("zh-CN", "wt.removeStrong")}${tFor("zh-CN", "wt.removeTail")}${tFor("zh-CN", "wt.detached")}`,
    "这会把 D:\\w 从磁盘上删掉。不进回收站：目录是 git 自己删的。这是一个分离头指针的工作树，删除后它上面的提交只能靠仓库里的对象找回。",
  );
  assert.equal(tFor("zh-CN", "py.ready", { path: "D:\\venvs\\a_b" }), "已就绪：D:\\venvs\\a_b");
  assert.equal(
    tFor("zh-CN", "py.venvBlocked"),
    "本机没有可用 Python，无法创建虚拟环境——先装一个再回来。位置是 项目\\venvs\\<repo>_<owner>，在仓库之外。",
  );
  // The 彻底删除 paragraph, in the order the panel renders it (text + <strong> +
  // text + <code> + text); `thisDir` is the fallback inside the `dir` slot.
  assert.equal(
    `${tFor("zh-CN", "py.destroyLead")}${tFor("zh-CN", "py.destroyStrong")}${tFor("zh-CN", "py.destroyTail", { dir: tFor("zh-CN", "py.thisDir") })}demo_repo${tFor("zh-CN", "py.destroySuffix")}`,
    "彻底删除不可恢复：该目录，以及里面已经安装的全部依赖包都会消失，回收站里也找不到。输入 demo_repo 以确认：",
  );
  assert.equal(tFor("zh-CN", "py.destroyAria", { slug: "demo_repo" }), "输入 demo_repo 以确认彻底删除虚拟环境");
  assert.equal(tFor("zh-CN", "sync.heads", { local: "aaaa111", remote: "bbbb222" }), "本地 aaaa111 / 远程 bbbb222");
  assert.equal(tFor("zh-CN", "sync.reason", { msg: "x" }), "原因：x");
  assert.equal(tFor("zh-CN", "sync.basis", { list: "package.json、pnpm-lock.yaml" }), "依据文件：package.json、pnpm-lock.yaml");
  assert.equal(tFor("zh-CN", "sync.basis", { list: tFor("zh-CN", "sync.none") }), "依据文件：无");
  assert.equal(tFor("zh-CN", "sync.ranAsStep", { command: "pnpm install", pid: 1234 }), "已作为第 1 步执行：pnpm install（PID 1234）");
  assert.equal(
    tFor("zh-CN", "sync.upToDate", { head: "abc1234", layer: "直连" }),
    "已是最新（HEAD abc1234，链路 直连）",
  );
  assert.equal(
    tFor("zh-CN", "sync.forwarded", {
      before: "aaaa111",
      after: "bbbb222",
      commits: tFor("zh-CN", "sync.commitsAdded", { n: 3 }),
      layer: "直连",
    }),
    "已快进 aaaa111 → bbbb222，新增 3 个提交（链路 直连）",
  );
  assert.equal(
    tFor("zh-CN", "sync.forwarded", { before: "aaaa111", after: "bbbb222", commits: "", layer: "直连" }),
    "已快进 aaaa111 → bbbb222（链路 直连）",
  );
  // The layer note: text + <strong> + text + <code>insteadOf</code> + text.
  assert.equal(
    `${tFor("zh-CN", "sync.layerNoteLead")}${tFor("zh-CN", "sync.layerNoteStrong")}${tFor("zh-CN", "sync.layerNoteMid")}insteadOf${tFor("zh-CN", "sync.layerNoteTail")}`,
    "更新按层级回退：直连 → IP 钉死 → 本地代理；只有当你启用了第三方镜像才会多走一条经 insteadOf 改写 origin 的镜像层（该路径在本机未经实测）。",
  );
  // The tool-missing line: text + <code>toolName</code> + text.
  assert.equal(
    `${tFor("zh-CN", "sync.toolMissingLead")}pnpm${tFor("zh-CN", "sync.toolMissingTail")}`,
    "这台机器上找不到 pnpm。可以先装工具，再回来执行这条命令。",
  );
});

// ---------------------------------------------------------------------------
// 5f. r18 第四批：启动对话框家族接线的历史字面量（逐字节）

test("i18n: 启动对话框家族接线搬进词表的每个中文字面量逐字节不变（r18-o1-2）", () => {
  // Quoted from the pre-wiring source (`LaunchDialog.tsx` and the five
  // components under `launch/`). Same rules as 5e: the split entries are the
  // pieces the JSX concatenates around <strong> / <code> and conditional
  // fragments (spaces included — the composed assertions below are where a
  // dropped space would show up). Two lines stay hardcoded on purpose and are
  // therefore NOT in this table: the persisted step name `启动` (written into
  // `.devhub.json`, LaunchDialog) and the `任意可用 IDE` lookup key consumed by
  // `toolGuidanceFor()` — both are data, and their call sites say so.
  const originals: Record<string, string> = {
    "launch.loadDetailFailed": "加载项目信息失败：{msg}",
    "launch.loadExtrasFailed": "加载检测信息失败：{msg}",
    "launch.stepDone": "步骤「{label}」完成",
    "launch.stepExit": "步骤「{label}」退出码 {code}",
    "launch.stoppedPid": "已停止 PID {pid}",
    "launch.stopFailed": "停止进程失败：{msg}",
    "launch.suspendedPid": "已挂起 PID {pid}",
    "launch.resumedPid": "已恢复 PID {pid}",
    "launch.suspendFailed": "挂起进程失败：{msg}",
    "launch.resumeFailed": "恢复进程失败：{msg}",
    "launch.stepsSaved": "启动命令已保存",
    "launch.saveStepsFailed": "保存启动命令失败：{msg}",
    "launch.startedSteps": "已启动 {n} 个步骤",
    "launch.startedStepsFailed": "，{n} 个失败",
    "launch.launchFailed": "启动失败：{msg}",
    "launch.startedPid": "已启动（PID {pid}）：{command}",
    "launch.stepLabel": "步骤 {n}",
    "launch.stepwiseStarted": "第 {n} 步「{label}」已启动（PID {pid}）",
    "launch.runStepFailed": "执行步骤失败：{msg}",
    "launch.allStepsDone": "{n} 个步骤已依次执行完。",
    "launch.stepStarted": "步骤 {n} 已启动（PID {pid}）",
    "launch.openedIn": "已在 {label} 中打开（PID {pid}）",
    "launch.openTerminalFailed": "打开终端失败：{msg}",
    "launch.openedVia": "已通过 {label} 打开（PID {pid}）",
    "launch.openIdeFailed": "打开 IDE 失败：{msg}",
    "launch.explorerFailed": "打开资源管理器失败：{msg}",
    "launch.confirmedCommand": "已确认启动命令：{command}",
    "launch.confirmFailed": "确认启动命令失败：{msg}",
    "launch.openExplorer": "在资源管理器打开",
    "launch.clipboardDenied": "剪贴板不可用，请手动选中路径复制",
    "launch.copyPathTitle": "复制路径\n{path}",
    "launch.copied": "已复制",
    "launch.copyPath": "复制路径",
    "launch.launching": "启动中…",
    "launch.launchAll": "一键启动",
    "launch.confirmAndLaunch": "确认并启动",
    "launch.stepwiseHint": "多步启动时，每执行完一步停下来等你确认",
    "launch.stepwise": "逐步确认",
    "launch.detectingTerminals": "检测终端中…",
    "launch.terminalWith": "终端 · {label}",
    "launch.openTerminal": "打开终端",
    "launch.detectingIdes": "检测 IDE 中…",
    "launch.openWithIde": "通过 {label} 打开",
    "launch.openIde": "打开 IDE",
    "launch.retry": "重试",
    "launch.commandTitle": "启动命令",
    "launch.stepCount": "{n} 步",
    "launch.confirmed": "已确认",
    "launch.pending": "待确认",
    "launch.unsaved": "有未保存修改",
    "launch.edit": "编辑",
    "launch.defaultStepName": "启动",
    "launch.parallel": "并行",
    "launch.sequential": "顺序",
    "launch.runOneHint": "只执行这一步",
    "launch.run": "执行",
    "launch.awaitingNext": "第 {n} 步已启动。确认它的结果后继续第 {next} 步。",
    "launch.runNext": "执行第 {n} 步",
    "launch.stopHere": "停在这里",
    "launch.noSteps": "尚未设置启动命令。点「编辑」添加，或从下方识别结果中点击一条。",
    "launch.missing": "缺少：{list}。启动前请先安装，否则会报错。",
    "launch.needsVersion": "（需要 {version}）",
    "launch.openHomepage": "打开官网",
    "launch.outputTitle": "运行输出（{n} 行）",
    "launch.cancel": "取消",
    "cleanup.scanFailed": "扫描缓存失败：{msg}",
    "cleanup.partialFailed": "部分失败：{list}",
    "cleanup.freed": "已释放 {size}（删除 {n} 项）",
    "cleanup.clearFailed": "清理缓存失败：{msg}",
    "cleanup.deletedFreed": "已删除，释放 {size}",
    "cleanup.deleteFailed": "删除项目失败：{msg}",
    "cleanup.title": "清理与删除",
    "cleanup.scanning": "扫描中…",
    "cleanup.scan": "扫描缓存",
    "cleanup.nothing": "没有可清理的缓存（依赖与构建产物）。这是正常结果。",
    "cleanup.clearButton": "清理以上 {n} 项，释放 {size}",
    "cleanup.cleanNoteLead": "只删除依赖与构建产物；源码、",
    "cleanup.cleanNoteTail": " 与你的改动都不会被碰。",
    "cleanup.destroyTitle": "彻底删除项目",
    "cleanup.destroyLead": "删除仓库目录、其独立 venv 与工作树副本。",
    "cleanup.destroyStrong": "不可恢复",
    "cleanup.destroyTail": "，磁盘上的代码会消失。",
    "cleanup.confirmOpen": "我要删除…",
    "cleanup.dirtyLead": "这个工作树有 ",
    "cleanup.dirtyFiles": " 个已改动文件",
    "cleanup.untrackedLead": "、",
    "cleanup.untrackedFiles": " 个未跟踪文件",
    "cleanup.dirtyTail": "。彻底删除会连它们一起消失，且",
    "cleanup.dirtyEnd": "。",
    "cleanup.ahead": "另有 {n} 个提交尚未推送到上游。",
    "cleanup.branchLead": "当前分支 ",
    "cleanup.branchUnknown": "（读不到上游，未推送的提交数未知）",
    "cleanup.confirmLead": "输入 ",
    "cleanup.confirmTail": " 以确认：",
    "cleanup.confirmAria": "输入 {slug} 以确认删除",
    "cleanup.confirmDestroy": "确认彻底删除",
    "detect.recognized": "识别为",
    "detect.unrecognized": "未识别",
    "detect.inspected": "，已检查：{list}",
    "detect.pickHint": "，点击一条即确认",
    "detect.evidence": "依据：{evidence}",
    "detect.noCandidates": "没有推断出候选命令，请点「编辑」手动填写。",
    "run.startingLead": "正在启动",
    "run.startingStep": "：执行步骤「{step}」",
    "run.startingIdle": "…",
    "run.startingTail": "，输出见下方「运行输出」",
    "run.running": "运行中",
    "run.suspendedState": "已挂起",
    "run.elapsed": "已运行 {elapsed}",
    "run.suspendHint": "挂起这个进程及其子进程（不退出，可恢复）",
    "run.resumeHint": "恢复运行",
    "run.suspend": "挂起",
    "run.resume": "恢复",
    "run.stopHint": "停止这个进程及其子进程",
    "run.stop": "停止",
    "run.exitedOk": "已正常退出",
    "run.shellReturned": "命令外壳已返回（代码 {code}）",
    "run.exitedCode": "已退出（代码 {code}）",
    "run.unknown": "未知",
    "run.ranFor": "{label} · 运行了 {elapsed}",
    "run.maybeRunning": "它启动的程序可能仍在运行",
    "split.noToolsHint": "没有检测到可用工具",
    "split.pickTool": "选择工具",
    "split.noTools": "没有检测到可用工具，可在「设置 → 编辑器与 IDE」里手动指定。",
    "steps.namePlaceholder": "步骤 {n} 名称（可选）",
    "steps.nameAria": "步骤 {n} 名称",
    "steps.modeHint": "顺序：等待上一步结束后执行；并行：与其他并行步骤同时启动",
    "steps.moveUp": "上移",
    "steps.moveUpAria": "上移该步骤",
    "steps.moveDown": "下移",
    "steps.moveDownAria": "下移该步骤",
    "steps.remove": "移除该步骤",
    "steps.commandPlaceholder": "命令，例如 npm install",
    "steps.commandAria": "步骤 {n} 命令",
    "steps.cwdPlaceholder": "工作目录（相对仓库根目录，留空即根目录）",
    "steps.cwdAria": "步骤 {n} 工作目录",
    "steps.add": "添加步骤",
    "steps.templatesLabel": "模板：",
    "steps.save": "保存",
    "steps.atLeastOne": "至少需要一个步骤。",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // The step-done log lines keep ✓ / ✗ at the call site: both glyphs sit in the
  // dictionary's forbidden emoji range (U+2713 / U+2717), so the table only
  // carries what follows them.
  assert.equal(`✓ ${tFor("zh-CN", "launch.stepDone", { label: "安装依赖" })}`, "✓ 步骤「安装依赖」完成");
  assert.equal(`✗ ${tFor("zh-CN", "launch.stepExit", { label: "启动", code: 1 })}`, "✗ 步骤「启动」退出码 1");
  // Multi-step launch status: two fragments, the failed half conditional.
  assert.equal(tFor("zh-CN", "launch.startedSteps", { n: 1 }), "已启动 1 个步骤");
  assert.equal(
    `${tFor("zh-CN", "launch.startedSteps", { n: 2 })}${tFor("zh-CN", "launch.startedStepsFailed", { n: 1 })}`,
    "已启动 2 个步骤，1 个失败",
  );
  assert.equal(
    tFor("zh-CN", "launch.stepwiseStarted", { n: 2, label: "启动", pid: 1234 }),
    "第 2 步「启动」已启动（PID 1234）",
  );
  assert.equal(
    tFor("zh-CN", "launch.awaitingNext", { n: 1, next: 2 }),
    "第 1 步已启动。确认它的结果后继续第 2 步。",
  );
  // Both halves of the suspend/resume toast are separate keys (a ternary at the
  // call site); assert each independently.
  assert.equal(tFor("zh-CN", "launch.suspendedPid", { pid: 7 }), "已挂起 PID 7");
  assert.equal(tFor("zh-CN", "launch.resumedPid", { pid: 7 }), "已恢复 PID 7");
  assert.equal(tFor("zh-CN", "launch.suspendFailed", { msg: "x" }), "挂起进程失败：x");
  assert.equal(tFor("zh-CN", "launch.resumeFailed", { msg: "x" }), "恢复进程失败：x");
  // The copy-path tooltip is two lines; the newline is inside the value.
  assert.equal(tFor("zh-CN", "launch.copyPathTitle", { path: "D:\\repo" }), "复制路径\nD:\\repo");
  assert.equal(
    tFor("zh-CN", "launch.startedPid", { pid: 9, command: "pnpm dev" }),
    "已启动（PID 9）：pnpm dev",
  );
  assert.equal(tFor("zh-CN", "launch.terminalWith", { label: "Windows Terminal" }), "终端 · Windows Terminal");
  assert.equal(tFor("zh-CN", "launch.openWithIde", { label: "VS Code" }), "通过 VS Code 打开");
  assert.equal(tFor("zh-CN", "launch.stepCount", { n: 2 }), "2 步");
  assert.equal(tFor("zh-CN", "launch.outputTitle", { n: 12 }), "运行输出（12 行）");
  assert.equal(tFor("zh-CN", "launch.needsVersion", { version: "18" }), "（需要 18）");
  assert.equal(
    tFor("zh-CN", "launch.missing", { list: "Node.js、Python" }),
    "缺少：Node.js、Python。启动前请先安装，否则会报错。",
  );
  assert.equal(tFor("zh-CN", "launch.stepStarted", { n: 3, pid: 42 }), "步骤 3 已启动（PID 42）");
  assert.equal(tFor("zh-CN", "launch.stepLabel", { n: 3 }), "步骤 3");
  assert.equal(tFor("zh-CN", "launch.runNext", { n: 2 }), "执行第 2 步");
  // cleanup.scan/scanning share the busy toggle; freed/clearButton take sizes.
  assert.equal(tFor("zh-CN", "cleanup.freed", { size: "1.2 GB", n: 3 }), "已释放 1.2 GB（删除 3 项）");
  assert.equal(tFor("zh-CN", "cleanup.clearButton", { n: 3, size: "1.2 GB" }), "清理以上 3 项，释放 1.2 GB");
  assert.equal(
    `${tFor("zh-CN", "cleanup.partialFailed", { list: ["a", "b"].join("；") })}`,
    "部分失败：a；b",
  );
  // The note around <code>.git</code>: trailing space in the lead, leading in the tail.
  assert.equal(
    `${tFor("zh-CN", "cleanup.cleanNoteLead")}.git${tFor("zh-CN", "cleanup.cleanNoteTail")}`,
    "只删除依赖与构建产物；源码、.git 与你的改动都不会被碰。",
  );
  // The destroy paragraph: text + <strong>不可恢复</strong> + text.
  assert.equal(
    `${tFor("zh-CN", "cleanup.destroyLead")}${tFor("zh-CN", "cleanup.destroyStrong")}${tFor("zh-CN", "cleanup.destroyTail")}`,
    "删除仓库目录、其独立 venv 与工作树副本。不可恢复，磁盘上的代码会消失。",
  );
  // The dirty-worktree warning, in the order the JSX renders it: text + <strong>
  // + text + [、+ <strong> + text] + text + <strong> + text + [ahead].
  assert.equal(
    `${tFor("zh-CN", "cleanup.dirtyLead")}3${tFor("zh-CN", "cleanup.dirtyFiles")}${tFor("zh-CN", "cleanup.untrackedLead")}2${tFor("zh-CN", "cleanup.untrackedFiles")}${tFor("zh-CN", "cleanup.dirtyTail")}${tFor("zh-CN", "cleanup.destroyStrong")}${tFor("zh-CN", "cleanup.dirtyEnd")}${tFor("zh-CN", "cleanup.ahead", { n: 1 })}`,
    "这个工作树有 3 个已改动文件、2 个未跟踪文件。彻底删除会连它们一起消失，且不可恢复。另有 1 个提交尚未推送到上游。",
  );
  assert.equal(
    `${tFor("zh-CN", "cleanup.dirtyLead")}1${tFor("zh-CN", "cleanup.dirtyFiles")}${tFor("zh-CN", "cleanup.dirtyTail")}${tFor("zh-CN", "cleanup.destroyStrong")}${tFor("zh-CN", "cleanup.dirtyEnd")}`,
    "这个工作树有 1 个已改动文件。彻底删除会连它们一起消失，且不可恢复。",
  );
  // Branch line: lead + <code>branch</code> + [unknown-upstream note].
  assert.equal(
    `${tFor("zh-CN", "cleanup.branchLead")}dev${tFor("zh-CN", "cleanup.branchUnknown")}`,
    "当前分支 dev（读不到上游，未推送的提交数未知）",
  );
  assert.equal(`${tFor("zh-CN", "cleanup.branchLead")}dev`, "当前分支 dev");
  // Type-to-confirm line: text + <code>slug</code> + text, and the aria twin.
  assert.equal(
    `${tFor("zh-CN", "cleanup.confirmLead")}demo${tFor("zh-CN", "cleanup.confirmTail")}`,
    "输入 demo 以确认：",
  );
  assert.equal(tFor("zh-CN", "cleanup.confirmAria", { slug: "demo" }), "输入 demo 以确认删除");
  // Detection scores its evidence.
  assert.equal(
    tFor("zh-CN", "detect.inspected", { list: "package.json、pnpm-lock.yaml" }),
    "，已检查：package.json、pnpm-lock.yaml",
  );
  assert.equal(tFor("zh-CN", "detect.evidence", { evidence: "package.json" }), "依据：package.json");
  // Run status line: the step name is a slot; the "…" branch stays its own key.
  assert.equal(
    `${tFor("zh-CN", "run.startingLead")}${tFor("zh-CN", "run.startingStep", { step: "启动" })}${tFor("zh-CN", "run.startingTail")}`,
    "正在启动：执行步骤「启动」，输出见下方「运行输出」",
  );
  assert.equal(
    `${tFor("zh-CN", "run.startingLead")}${tFor("zh-CN", "run.startingIdle")}${tFor("zh-CN", "run.startingTail")}`,
    "正在启动…，输出见下方「运行输出」",
  );
  assert.equal(
    `${tFor("zh-CN", "run.running")} · dev · PID 1 · ${tFor("zh-CN", "run.elapsed", { elapsed: "12s" })}`,
    "运行中 · dev · PID 1 · 已运行 12s",
  );
  assert.equal(
    tFor("zh-CN", "run.shellReturned", { code: tFor("zh-CN", "run.unknown") }),
    "命令外壳已返回（代码 未知）",
  );
  assert.equal(tFor("zh-CN", "run.exitedCode", { code: 1 }), "已退出（代码 1）");
  assert.equal(tFor("zh-CN", "run.ranFor", { label: "dev", elapsed: "12s" }), "dev · 运行了 12s");
  // Numbered editor placeholders and aria-labels share one numbering.
  assert.equal(tFor("zh-CN", "steps.namePlaceholder", { n: 1 }), "步骤 1 名称（可选）");
  assert.equal(tFor("zh-CN", "steps.nameAria", { n: 1 }), "步骤 1 名称");
  assert.equal(tFor("zh-CN", "steps.commandAria", { n: 2 }), "步骤 2 命令");
  assert.equal(tFor("zh-CN", "steps.cwdAria", { n: 2 }), "步骤 2 工作目录");
});

// ---------------------------------------------------------------------------
// 5g. r18 第四批：外观页接线的历史字面量（逐字节）

test("i18n: 外观页接线搬进词表的每个中文字面量逐字节不变（r18-o1-3）", () => {
  // Quoted from the pre-wiring `AppearanceView.tsx`. Same rules as 5e/5f: the
  // footnote pair is the pieces the JSX concatenates around <code>, and the
  // composed assertions below cover the slots ({n} columns, {name} in the
  // template dialogs, {query} in the font search). One literal stays hardcoded
  // on purpose and is therefore NOT in this table: the fallback template name
  // `导入的模版` — it is persisted data (written into the local template list),
  // and its call site says so.
  const originals: Record<string, string> = {
    "appearance.groupSize": "大小",
    "appearance.fontScaleTitle": "字号档位",
    "appearance.fontScaleHint": "快捷预设，点一下写入下面的精确字号。",
    "appearance.fontPxTitle": "精确字号",
    "appearance.fontPxHint": "整个界面按这个像素值缩放（12–22），像 Word 里填字号一样精确。",
    "appearance.fontPxMinus": "字号减 1",
    "appearance.fontPxAria": "界面字号（像素）",
    "appearance.fontPxPlus": "字号加 1",
    "appearance.scaleTitle": "界面尺度",
    "appearance.scaleHint": "文字与控件的体量。密度只管留白，两者互不干扰。",
    "appearance.ambienceTitle": "氛围层",
    "appearance.ambienceHint": "页面底的细网格与标题短线；「动态」再加缓慢漂移与卡片扫光。",
    "appearance.densityTitle": "布局密度",
    "appearance.densityHint": "页面留白与项目墙卡片间距。留白偏多时先试「紧凑」。",
    "appearance.columnsTitle": "项目墙列数",
    "appearance.columnsHint": "「自动」按窗口宽度决定，卡片不会小于当前外观风格的最小宽度。",
    "appearance.columnsAuto": "自动",
    "appearance.columnsN": "{n} 列",
    "appearance.groupTheme": "主题",
    "appearance.themeTitle": "深浅色",
    "appearance.themeHint": "跟随系统会随 Windows 的深浅色设置实时切换。",
    "appearance.themeDark": "深色",
    "appearance.themeLight": "浅色",
    "appearance.themeSystem": "跟随系统",
    "appearance.skinTitle": "外观风格",
    "appearance.fontWeightTitle": "界面字重",
    "appearance.fontWeightHint": "作用于界面正文；标题保持自己的层级。",
    "appearance.fontTitle": "字体",
    "appearance.fontHintFallback": "后端字体枚举未就绪，以下为常用字体列表。",
    "appearance.fontHint": "列出本机已安装的字体（可搜索）；缺字时回退到系统默认。",
    "appearance.fontSystemDefault": "系统默认",
    "appearance.fontListAria": "选择字体",
    "appearance.fontSearchAria": "搜索字体",
    "appearance.fontSearchPlaceholder": "搜索字体（中英文名均可）",
    "appearance.fontNoMatch": "没有匹配「{query}」的字体",
    "appearance.fontLoading": "正在读取本机字体…",
    "appearance.fontPreview": "预览 Aa 123",
    "appearance.groupContent": "内容显示",
    "appearance.contentFootnote": "关掉封面图会同时停止向图片服务发请求；项目很多时，这一项对启动速度影响最大。",
    "appearance.coversTitle": "加载项目封面图",
    "appearance.coversHint": "关闭后项目墙只显示生成的渐变底色。",
    "appearance.repoPathTitle": "卡片显示完整路径",
    "appearance.repoPathHint": "在仓库名下方显示它在磁盘上的目录。",
    "appearance.reduceMotionTitle": "减弱动画",
    "appearance.reduceMotionHint": "去掉视图切换淡入、卡片悬浮位移与封面淡入。",
    "appearance.autoScrollTitle": "启动输出自动滚动",
    "appearance.autoScrollHint": "关闭后输出停在你当前看到的位置，便于回看。",
    "appearance.showDescTitle": "显示描述性文字",
    "appearance.showDescHint": "关闭后隐藏界面里的说明性小字，只留标题与控件。",
    "appearance.scrollbarTitle": "显示滚动条",
    "appearance.scrollbarHint": "关闭后仅悬停时显示滚动条。",
    "appearance.groupChrome": "界面区块",
    "appearance.chromeFootnote": "这些开关真正隐藏对应的界面区块；开发者模式里的元素管理是另一套更细的控制系统。",
    "appearance.brandTitle": "左上角软件名称",
    "appearance.refreshTitle": "侧边栏刷新按钮",
    "appearance.statusStripTitle": "底部状态栏",
    "appearance.versionTitle": "版本号",
    "appearance.searchBlockTitle": "添加页的搜索区块",
    "appearance.settingsEntryTitle": "设置入口位置",
    "appearance.settingsEntryHint": "侧边栏底部是默认位置；标题栏右侧适合侧边栏常收起的用法。",
    "appearance.settingsEntryFooter": "侧边栏底部",
    "appearance.settingsEntryTitlebar": "标题栏",
    "appearance.groupTemplates": "外观模版",
    "appearance.tplNoItems": "这个模版没有可用设置项",
    "appearance.tplApplyConfirm": "应用模版「{name}」将覆盖当前外观的 {n} 项设置，确定吗？",
    "appearance.tplApplyTitle": "应用外观模版",
    "appearance.tplApplyOk": "应用",
    "appearance.cancel": "取消",
    "appearance.tplApplied": "已应用模版「{name}」",
    "appearance.tplExportCopied": "模版 JSON 已复制到剪贴板",
    "appearance.tplExportFallback": "剪贴板不可用，JSON 已填入下方导入框，请手动复制",
    "appearance.tplDeleteConfirm": "删除模版「{name}」？",
    "appearance.tplDeleteTitle": "删除模版",
    "appearance.tplDeleteOk": "删除",
    "appearance.tplDeleted": "模版已删除",
    "appearance.tplImportNoItems": "没有可识别的外观设置项",
    "appearance.tplImported": "模版已导入",
    "appearance.tplImportParseFailed": "JSON 解析失败，请检查内容",
    "appearance.tplFootnoteLead": "把当前外观存为命名模版，随时一键切换回那一套。模版保存在本机（",
    "appearance.tplFootnoteTail": "），导出为 JSON 可以带走。应用会覆盖当前外观并写入一条可回退的记录。",
    "appearance.tplEmpty": "还没有模版。调整好外观后，用下面的「保存当前为模版」存一份。",
    "appearance.tplRenameTitle": "重命名模版",
    "appearance.tplRenameAria": "模版新名称",
    "appearance.tplApply": "应用",
    "appearance.tplExport": "导出",
    "appearance.tplRename": "重命名",
    "appearance.tplDelete": "删除",
    "appearance.tplSaveTitle": "保存当前为模版",
    "appearance.tplSaveHint": "给当前整套外观起个名字。",
    "appearance.tplNewAria": "新模版名称",
    "appearance.tplNewPlaceholder": "模版名称，例如「夜间护眼」",
    "appearance.tplSaved": "模版已保存",
    "appearance.tplSave": "保存",
    "appearance.tplSaveActionHint": "把当前的整套外观设置存成一个命名模版。",
    "appearance.tplNew": "新建模版",
    "appearance.tplImportTitle": "导入模版",
    "appearance.tplImportHint": "粘贴模版 JSON，导入后先加入列表，不立即覆盖当前外观。",
    "appearance.tplImportAria": "粘贴模版 JSON",
    "appearance.tplImportPlaceholder": "{\"name\":\"夜间护眼\",\"values\":{…}}",
    "appearance.tplImport": "导入",
    "appearance.tplImportActionHint": "粘贴其他机器导出的模版 JSON。",
    "appearance.tplPasteImport": "粘贴导入",
    "appearance.resetFootnote": "保存在本机，不进配置文件；恢复默认会留一条记录，可整份回退。",
    "appearance.resetTitle": "恢复默认外观",
    "appearance.resetHint": "字号、主题、风格与上面的显示开关全部回到初始值。",
    "appearance.resetAction": "恢复默认",
    "appearance.resetDone": "外观已恢复默认",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // Column labels: one key for all five fixed widths.
  assert.equal(tFor("zh-CN", "appearance.columnsN", { n: 2 }), "2 列");
  assert.equal(tFor("zh-CN", "appearance.columnsN", { n: 6 }), "6 列");
  // Font search empty state carries the query back.
  assert.equal(tFor("zh-CN", "appearance.fontNoMatch", { query: "Sar" }), "没有匹配「Sar」的字体");
  // Template dialogs: the name is a slot, the overwrite count is its own slot.
  assert.equal(
    tFor("zh-CN", "appearance.tplApplyConfirm", { name: "夜间护眼", n: 5 }),
    "应用模版「夜间护眼」将覆盖当前外观的 5 项设置，确定吗？",
  );
  assert.equal(tFor("zh-CN", "appearance.tplApplied", { name: "夜间护眼" }), "已应用模版「夜间护眼」");
  assert.equal(tFor("zh-CN", "appearance.tplDeleteConfirm", { name: "夜间护眼" }), "删除模版「夜间护眼」？");
  // The templates footnote wraps its <code> key: trailing （ in the lead,
  // leading ） in the tail. The key name below is `TEMPLATES_KEY` read from
  // `src/store/appearance.ts` — kept as a literal so this test does not pull the
  // store (and its React imports) into the Node run.
  assert.equal(
    `${tFor("zh-CN", "appearance.tplFootnoteLead")}devhub.appearance.templates.v1${tFor("zh-CN", "appearance.tplFootnoteTail")}`,
    "把当前外观存为命名模版，随时一键切换回那一套。模版保存在本机（devhub.appearance.templates.v1），导出为 JSON 可以带走。应用会覆盖当前外观并写入一条可回退的记录。",
  );
  // The import placeholder is the JSON sample itself, ellipsis included.
  assert.equal(
    tFor("zh-CN", "appearance.tplImportPlaceholder"),
    "{\"name\":\"夜间护眼\",\"values\":{…}}",
  );
});

// ---------------------------------------------------------------------------
// 5h. r18 第四批：状态条面板接线的历史字面量（逐字节）

test("i18n: 状态条面板接线搬进词表的每个中文字面量逐字节不变（r18-o1-4）", () => {
  // Quoted from the pre-wiring `StatusStrip.tsx`. Same rules as 5e-5g: the
  // composed assertions below cover the split pairs (git source lead + tag
  // suffix, hijack lead + policy phrase, the two-paragraph stop-all confirm and
  // its suspended note, the stop reports that share a failure suffix). Nothing
  // is kept hardcoded this time — the two Chinese `//` notes that sat inline in
  // the source moved to their own lines so the ratchet can see those lines are
  // clean.
  const originals: Record<string, string> = {
    "strip.doubleClickHint": "双击卡片跳到对应设置",
    "strip.sectionEnv": "环境",
    "strip.gitNotFound": "未找到",
    "strip.gitSourceSystem": "来源：系统已安装",
    "strip.gitSourceBuiltin": "来源：应用内置",
    "strip.gitSourceBuiltinTag": "（{tag}）",
    "strip.gitWillBootstrap": "将自动引导便携版 Git",
    "strip.projectRoot": "项目目录",
    "strip.detecting": "探测中…",
    "strip.rootFallback": "软件所在位置不可写，已回退到用户目录",
    "strip.rootFixed": "仓库固定放在此目录的 <仓库名>_<拥有者> 下",
    "strip.sectionNetwork": "网络",
    "strip.localProxyTitle": "本地代理",
    "strip.proxyNotFound": "未发现",
    "strip.proxyHint": "转发代理端口。它没发现不代表没有加速——见下一张 hosts 卡。",
    "strip.hostsTitle": "hosts 改写",
    "strip.hostsRewritten": "已改写 {n} 条",
    "strip.hostsRewrittenBy": "已改写 {n} 条 · {by}",
    "strip.hostsNotRewritten": "未改写",
    "strip.hostsHijackLead": "GitHub 域名被指向 127.0.0.1，通常是本地加速工具。当前策略：",
    "strip.policyAuto": "搜索自动（按加速器连通性逐次决定）",
    "strip.policyUseHosts": "搜索沿用",
    "strip.policyBypass": "搜索绕过",
    "strip.hostsClean": "hosts 里没有 GitHub 域名被指向本机",
    "strip.resolvedTitle": "github.com 解析",
    "strip.resolversDisagree": "多解析器未达成一致",
    "strip.resolvedHint": "多个公共 DNS 一致才采用（防投毒）",
    "strip.ipPinLabel": "IP 钉死：",
    "strip.enabled": "已启用",
    "strip.disabled": "已关闭",
    "strip.mirrorLabel": "第三方镜像：",
    "strip.mirrorEnabled": "已启用（代码经由第三方）",
    "strip.privLabel": "进程权限：",
    "strip.privElevated": "已提权（管理员）— 应用本身不需要，请检查启动方式",
    "strip.privStandard": "标准用户（未提权）",
    "strip.ipPinNote": "IP 钉死保留主机名与证书校验，不关闭 sslVerify。",
    "strip.revealFolderFailed": "打开目录失败",
    "strip.sectionDownloads": "下载",
    "strip.downloadQueue": "下载队列",
    "strip.viewAll": "查看全部",
    "strip.taskFailed": "失败",
    "strip.taskQueued": "排队中",
    "strip.taskRunning": "进行中",
    "strip.revealTarget": "在资源管理器中打开落位目录",
    "strip.suspendFailed": "挂起失败",
    "strip.resumeFailed": "恢复失败",
    "strip.cannotStopReason": "该进程已经停不下来了",
    "strip.stopFailed": "停止失败：{reason}",
    "strip.stopAllConfirm": "停止全部 {n} 个进程？\n\n涉及项目：{slugs}",
    "strip.stopAllSuspendedNote": "\n\n其中 {n} 个正在挂起：停止会终止它们，不是解冻。",
    "strip.stopAllTitle": "停止全部进程",
    "strip.stopAllOk": "停止 {n} 个",
    "strip.stoppedReport": "已停止 {stopped}/{total} 个",
    "strip.stoppedReportFailed": "，{n} 个失败",
    "strip.stoppedAll": "已停止 {n} 个进程",
    "strip.runningProcesses": "运行中的进程",
    "strip.suspendNote": "挂起会冻结整个进程树，端口与终端保持不动",
    "strip.stopAllAria": "停止全部 {n} 个进程",
    "strip.stopAllHint": "停止这 {n} 个进程；挂起中的也会被终止",
    "strip.stopping": "停止中…",
    "strip.stopAll": "全部停止",
    "strip.stopProgress": "停止 {stopped}/{total}",
    "strip.stateSuspended": "已挂起",
    "strip.stateRunning": "运行中",
    "strip.suspendedSuffix": " · 已挂起",
    "strip.resumeHint": "恢复运行：进程继续执行，窗口和端口不变",
    "strip.suspendHint": "挂起：冻结进程树，先排查它是不是在抢资源",
    "strip.resume": "恢复",
    "strip.suspend": "挂起",
    "strip.cannotSuspend": "不可挂起",
    "strip.stopTitle": "停止这个进程",
    "strip.cannotStopTitle": "已经停不下来了",
    "strip.stop": "停止",
    "strip.openProjectPanel": "打开这个项目的操作面板",
    "strip.project": "项目",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its pre-wiring wording`);
  }
  // The git-source hint: lead + optional parenthetical tag.
  assert.equal(
    `${tFor("zh-CN", "strip.gitSourceBuiltin")}${tFor("zh-CN", "strip.gitSourceBuiltinTag", { tag: "v2.44.0" })}`,
    "来源：应用内置（v2.44.0）",
  );
  // hosts rewrite value: with and without the byline.
  assert.equal(tFor("zh-CN", "strip.hostsRewritten", { n: 5 }), "已改写 5 条");
  assert.equal(tFor("zh-CN", "strip.hostsRewrittenBy", { n: 5, by: "127.0.0.1" }), "已改写 5 条 · 127.0.0.1");
  // The hijack hint composes lead + policy phrase (no separator between them in zh).
  assert.equal(
    tFor("zh-CN", "strip.hostsHijackLead") + tFor("zh-CN", "strip.policyAuto"),
    "GitHub 域名被指向 127.0.0.1，通常是本地加速工具。当前策略：搜索自动（按加速器连通性逐次决定）",
  );
  // Stop-all confirmation: two paragraphs are one value; the suspended note is
  // a \n\n suffix, appended only when a suspended process is in the batch.
  assert.equal(
    tFor("zh-CN", "strip.stopAllConfirm", { n: 13, slugs: "a、b" }) +
      tFor("zh-CN", "strip.stopAllSuspendedNote", { n: 2 }),
    "停止全部 13 个进程？\n\n涉及项目：a、b\n\n其中 2 个正在挂起：停止会终止它们，不是解冻。",
  );
  // The two stop-report variants share the failure suffix.
  assert.equal(tFor("zh-CN", "strip.stoppedReport", { stopped: 11, total: 13 }), "已停止 11/13 个");
  assert.equal(
    tFor("zh-CN", "strip.stoppedReport", { stopped: 11, total: 13 }) +
      tFor("zh-CN", "strip.stoppedReportFailed", { n: 2 }),
    "已停止 11/13 个，2 个失败",
  );
  assert.equal(
    tFor("zh-CN", "strip.stopProgress", { stopped: 11, total: 13 }) +
      tFor("zh-CN", "strip.stoppedReportFailed", { n: 2 }),
    "停止 11/13，2 个失败",
  );
  assert.equal(tFor("zh-CN", "strip.stopFailed", { reason: "boom" }), "停止失败：boom");
  assert.equal(tFor("zh-CN", "strip.stopAllOk", { n: 3 }), "停止 3 个");
  assert.equal(tFor("zh-CN", "strip.stoppedAll", { n: 3 }), "已停止 3 个进程");
});

// ---------------------------------------------------------------------------
// 5i. r18 N1：故障与诊断面板的词条（接线即终稿，逐字节钉住）

test("i18n: 故障与诊断面板的每个词条逐字节落定（r18-n1-3）", () => {
  // Unlike 5a-5h these are not moved literals — the panel is new, so the
  // dictionary IS the original. Pinned anyway, per 先钉住再优化: a later copy
  // tweak should be a visible diff here, not an accident on the way to some
  // other change (this family is exactly what r18-N2 网络诊断 or a future
  // "failure grouping" pass might be tempted to re-word).
  const originals: Record<string, string> = {
    "settings.section.diagnostics": "故障与诊断",
    "settings.page.diagnosticsFootnote":
      "保留最近 50 条；同一故障 10 秒内连发会折叠成一行并计数。转瞬即逝的提示在这里留下底稿；完整诊断报告请在命令面板运行「导出诊断报告」。",
    "settings.page.failuresEmpty": "最近没有失败记录",
    "settings.page.failuresClearTitle": "清空故障历史",
    "settings.page.failuresClearHint": "只清这份本地档案，不动记录页与下载日志。",
    "settings.page.failuresClearConfirm": "清空全部故障历史？此操作不可撤销。",
    "settings.page.failuresCleared": "已清空故障历史",
    "settings.page.failuresCopyAll": "复制全部",
    "settings.page.failuresCopyAllHint": "按时间倒序复制为纯文本，方便贴进 issue。",
    "settings.page.failuresCopyRow": "复制这条",
    "settings.page.failuresCopied": "已复制",
    "settings.page.failuresClipboardDenied": "剪贴板不可用，请手动选中文本复制",
    "settings.page.failureKind.command": "命令失败",
    "settings.page.failureKind.runtime": "运行时错误",
    "settings.page.failureKind.rejection": "未处理拒绝",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its wired wording`);
  }
  // The fold badge: a multiplication sign and the count, nothing else — the
  // panel composes its own leading space and only shows it when count > 1.
  assert.equal(tFor("zh-CN", "settings.page.failuresCount", { n: 3 }), "×3");
});

// ---------------------------------------------------------------------------
// 5j. r18 N2：网络诊断的词条（规则句 + 对话框面，逐字节钉住）

test("i18n: 网络诊断的每个词条逐字节落定（r18-n2）", () => {
  // Same doctrine as 5i: the family is new, so the dictionary IS the original —
  // pinned anyway, so a later reword is a visible diff here rather than an
  // accident on the way to some other change. The 7 `*.title` keys are read by
  // `lib/netdiag.ts` (whose rules and variants are behaviourally pinned in
  // `tests/netdiag.test.ts`); the rest is the dialog/entry surface.
  const originals: Record<string, string> = {
    "netdiag.hostsHijacked.title":
      "hosts 把 GitHub 域名指向了本机（{n} 条）：搜索会按当前策略自动绕过，通常无需处理。",
    "netdiag.hostsHijackedBy.title":
      "hosts 把 GitHub 域名指向了本机（{n} 条，多半来自 {by}）：搜索会按当前策略自动绕过，通常无需处理。",
    "netdiag.pinUnviable.title":
      "IP 钉死已开启，但本次没有拿到一致的公网地址——这条绕过路径暂时不可用。",
    "netdiag.unresolvedDns.title":
      "多个公共 DNS 未对 github.com 达成一致，本次没有采用任何解析结果（防投毒策略）。",
    "netdiag.proxyNotFound.title": "未发现本地代理。没发现不等于没有加速——hosts 改写请看事实区。",
    "netdiag.mirrorOn.title": "第三方镜像已启用：代码会经由镜像下载。",
    "netdiag.elevated.title": "应用以管理员权限运行——它并不需要提权，请检查启动方式。",
    "netdiag.title": "网络诊断",
    "netdiag.open": "打开网络诊断",
    "netdiag.loading": "正在探测网络…",
    "netdiag.factsTitle": "网络事实",
    "netdiag.emptyTitle": "未发现网络异常",
    "netdiag.emptyHint": "链路、代理、解析与权限各探针都平静。镜像与 IP 钉死的开关见下方事实。",
    "netdiag.probeFailed": "取不到网络状态（环境探测失败）——这不代表网络没问题，请重新诊断。",
    "netdiag.copy": "复制网络状态",
    "netdiag.copied": "已复制网络状态",
    "netdiag.openSettings": "打开网络设置",
    "netdiag.paletteNote": "分级结论 + 网络事实，可一键复制",
    "settings.page.proxyPlaceholder": "例如 http://127.0.0.1:26501",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its wired wording`);
  }
  // The two hijack variants substitute for real: the plain one takes {n}, the
  // By one takes both slots — a slot renamed on one side only would leave the
  // braces in the sentence, which the equality above cannot see.
  assert.equal(
    tFor("zh-CN", "netdiag.hostsHijacked.title", { n: 3 }),
    "hosts 把 GitHub 域名指向了本机（3 条）：搜索会按当前策略自动绕过，通常无需处理。",
  );
  assert.equal(
    tFor("zh-CN", "netdiag.hostsHijackedBy.title", { n: 2, by: "Steam++" }),
    "hosts 把 GitHub 域名指向了本机（2 条，多半来自 Steam++）：搜索会按当前策略自动绕过，通常无需处理。",
  );
});

test("i18n: 添加页/搜索面板接线搬进词表的每个中文字面量逐字节不变（r19-o1-a3）", () => {
  // The regression guard for「加 i18n 顺便改文案」on the add page and its
  // search panel: these literals are what `AddRepoView.tsx` carried before the
  // wiring, and the identity below pins the dictionary to the same bytes.
  // Sampling, not the full 96 — the parity tests above already pin every key
  // to both locales; this pins the *wording* of the sentence shapes most
  // likely to drift (headers, errors, interpolated rows).
  const originals: Record<string, string> = {
    "add.header": "添加项目",
    "add.gitMissing": "需要先安装 Git 才能下载：本机没有找到 git 命令。",
    "add.overwriteWarn": "当前落位目录已有内容。不勾选这一项，下载会以「目录已存在」结束。",
    "sp.debounceErr": "停顿时间需在 0–30000 毫秒之间，已恢复原值；超过 5000 毫秒只手动搜索",
    "sp.noMatch": "没有匹配的仓库。试试更短的关键词。",
    "sp.totalN": "共 {n} 个结果",
    "sp.pageN": "第 {n} 页",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its wired wording`);
  }
  assert.equal(tFor("zh-CN", "sp.pasteOk", { u: "rust-lang/rust" }), "已识别仓库链接 rust-lang/rust，下载位置已填好");
  assert.equal(tFor("zh-CN", "sp.totalN", { n: "1,024" }), "共 1,024 个结果");
});

// ---------------------------------------------------------------------------
// 5k. r18 N3：星标导入的词条（面板面，逐字节钉住）

test("i18n: 星标导入的每个词条逐字节落定（r18-n3）", () => {
  // Same doctrine as 5i/5j: the family is new this round, so the dictionary
  // IS the original — pinned anyway, so a later reword is a visible diff on
  // purpose. `stars.goToken` is the only key that is not a plain copy: the
  // jump button in `StarImportPanel.tsx` hangs the missing-token case on it,
  // and `tests/star-import-ui.test.ts` pins that wiring.
  const originals: Record<string, string> = {
    "stars.source": "星标导入",
    "stars.title": "从星标导入",
    "stars.hint": "读取你 GitHub 账号的 Star，勾选后批量加入下载",
    "stars.load": "载入我的星标",
    "stars.reload": "重新载入",
    "stars.loading": "正在读取星标…",
    "stars.loadMore": "加载更多",
    "stars.empty": "没有可导入的公开星标。",
    "stars.filterPlaceholder": "在已载入的星标里筛选",
    "stars.filterEmpty": "没有匹配的星标。",
    "stars.owned": "已在库中",
    "stars.queued": "在队列中",
    "stars.archived": "已归档",
    "stars.goToken": "去设置 Token",
    "stars.loaded": "已载入 {n} 个",
    "stars.remaining": "GitHub 剩余额度 {n}",
    "stars.selected": "已选 {n} 个",
    "stars.selectAll": "全选",
    "stars.clearSelected": "清除选择",
    "stars.download": "下载选中（{n}）",
    "stars.enqueued": "已加入下载队列：{n} 个仓库",
    "stars.allSkipped": "选中的仓库都已在库中或已在队列里。",
  };
  for (const [key, expected] of Object.entries(originals)) {
    assert.ok(isTranslationKey(key), `${key} is not a registered key`);
    assert.equal(tFor("zh-CN", key), expected, `${key} moved off its wired wording`);
  }
  // Five keys carry {n}; substitute for real so a slot renamed on one side
  // only leaves braces in the sentence (the equality above cannot see that).
  assert.equal(tFor("zh-CN", "stars.loaded", { n: 200 }), "已载入 200 个");
  assert.equal(tFor("zh-CN", "stars.selected", { n: 3 }), "已选 3 个");
  assert.equal(tFor("zh-CN", "stars.download", { n: 3 }), "下载选中（3）");
  assert.equal(tFor("zh-CN", "stars.enqueued", { n: 3 }), "已加入下载队列：3 个仓库");
  assert.equal(tFor("zh-CN", "stars.remaining", { n: 4998 }), "GitHub 剩余额度 4998");
  // And the English side answers for the same keys — the panel is a surface
  // in both languages, not just the one the domain is written in.
  assert.equal(tFor("en", "stars.title"), "Import from stars");
  assert.equal(tFor("en", "stars.enqueued", { n: 3 }), "Added 3 repositories to the download queue");
});

// ---------------------------------------------------------------------------
// 6. 语言状态

test("i18n: 语言切换同步 html lang，屏幕阅读器不按中文读英文", () => {
  const previous = getLocale();
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { documentElement: { lang: "" } },
  });
  try {
    setLocale("zh-CN");
    setLocale("en");
    assert.equal((globalThis as { document: { documentElement: { lang: string } } }).document.documentElement.lang, "en");
    setLocale("zh-CN");
    assert.equal((globalThis as { document: { documentElement: { lang: string } } }).document.documentElement.lang, "zh-CN");
  } finally {
    setLocale(previous);
    if (!hadDocument) Reflect.deleteProperty(globalThis, "document");
  }
});

test("i18n: 启动读盘在 Node（没有 localStorage）里兜到默认语言", () => {
  assert.equal(typeof globalThis.localStorage, "undefined");
  assert.equal(readLocale(), DEFAULT_LOCALE);
});

test("i18n: 切换语言会改 t() 的取字，切回来也是", () => {
  // The persistence call is inside try/catch for exactly this reason: a headless
  // run has no storage, and a lost disk copy must not cost the session its language.
  const before = getLocale();
  setLocale("en");
  try {
    assert.equal(getLocale(), "en");
    assert.equal(t("view.projects"), "Projects");
    assert.equal(t("strip.running", { n: 5 }), "Running 5");
  } finally {
    setLocale(before);
  }
  assert.equal(getLocale(), before);
  assert.equal(t("view.projects"), "项目");
});

test("i18n: 词表里没有任何键落进回落链的第 3 种情况", () => {
  // The whole point of the parity guard: for every registered key, both locales
  // answer. `resolveKey` reaching the key-as-text branch through the real tables
  // would mean the dictionary itself is broken, not a call site.
  const unresolved: string[] = [];
  for (const locale of LOCALES) {
    for (const key of ZH_KEYS) {
      if (resolveKey(DICTIONARIES, locale, key) === key && ZH[key] !== key) {
        unresolved.push(`${locale}:${key}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
});

// ---------------------------------------------------------------------------
// 7. 接线的两端：订阅（切语言要重绘）与语言行本身

test("i18n: 接了词条的界面都订阅了语言，也确实读词表", () => {
  // The failure mode no key-set guard can see: the entry resolves correctly
  // but the component never re-renders, so the screen keeps the previous
  // language until something else happens to repaint it. `useI18n()` is the
  // `useSyncExternalStore` subscription that makes the switch repaint; a file
  // that subscribes but resolves nothing is the other drift (unwired again).
  // Full-line `//` comments are dropped so a comment naming the hook cannot
  // stand in for the code — the house quotes old markup in comments freely.
  //
  // r17-n1-1 added the three records components; r18-o1-1 added the four
  // repository panels; r18-o1-2 added the launch dialog and its five
  // subcomponents; r18-o1-3 added the appearance page; r18-o1-4 finished the
  // status strip (its two inner components gained their own `useI18n()`
  // subscriptions). r18-n1-3 added the failure-history panel; r18-n2-2 added
  // the network-diagnostics dialog; r18-n3-2 added the star-import panel.
  // `records/filter-words.ts`
  // is a pure module that takes the
  // translator as an argument (its caller passes the hook's `t`), so it is
  // deliberately not listed here — it has no subscription of its own to check.
  // `lib/worktree-panel.ts` and `lib/venv-removal.ts` are the same shape (their
  // composed Chinese lines are deferred to a later batch; see the panels' headers).
  const surfaces = [
    "src/shell/Sidebar.tsx",
    "src/shell/TitleBar.tsx",
    "src/shell/StatusStrip.tsx",
    "src/components/CommandPalette.tsx",
    // r21-o2-2: 设置 → 界面整页接词表（行文案、确认框、toast、文件对话框标题）——
    // 组件面用 useI18n() 订阅，三个模块级动作（导出/导入/恢复）读模块级 t()，
    // 事件触发时才取字，语言一翻下一次点击就是新语言。
    "src/components/InterfaceRegistry.tsx",
    "src/views/SettingsView.tsx",
    "src/views/settings/rows.tsx",
    "src/views/FrequentView.tsx",
    "src/views/ProjectsView.tsx",
    "src/views/RecordsView.tsx",
    "src/views/records/RecordRow.tsx",
    "src/views/records/RetentionRows.tsx",
    "src/components/RepoTile.tsx",
    "src/components/DownloadQueue.tsx",
    "src/dialogs/ProjectSettingsDialog.tsx",
    "src/components/RepoPortPanel.tsx",
    "src/components/RepoWorktreesPanel.tsx",
    "src/components/RepoPythonPanel.tsx",
    "src/components/RepoSyncPanel.tsx",
    "src/dialogs/LaunchDialog.tsx",
    "src/dialogs/launch/CleanupSection.tsx",
    "src/dialogs/launch/DetectionEvidence.tsx",
    "src/dialogs/launch/RunStatus.tsx",
    "src/dialogs/launch/SplitButton.tsx",
    "src/dialogs/launch/StepsEditor.tsx",
    "src/views/AppearanceView.tsx",
    "src/dialogs/RepoDiagnoseDialog.tsx",
    "src/views/settings/FailureHistorySection.tsx",
    "src/dialogs/NetworkDiagnoseDialog.tsx",
    "src/components/StarImportPanel.tsx",
  ];
  for (const file of surfaces) {
    const code = codeLines(file)
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    assert.match(code, /useI18n\(\)/, `${file} renders dictionary text without subscribing to the locale`);
    assert.match(
      code,
      /viewTitle\(t,|sectionTitle\(t,|t\(\s*"/,
      `${file} subscribes to the locale but never resolves a key — is it still wired?`,
    );
  }
});

test("i18n: 语言行只列发布的语言，语言自己的名字逐字节不动", () => {
  // `LOCALE_OPTIONS` is what 设置 → 界面 → 语言 renders through `ChoiceRow`.
  // A language's own name is shown in every UI language (the doc on that
  // constant): translating「简体中文」into English would defeat the row, so both
  // native names are pinned here as bytes, alongside the ids staying in sync
  // with `LOCALES` — an option the store does not know, or a shipped locale the
  // row does not offer, would strand the user on the language they cannot pick.
  assert.deepEqual(
    LOCALE_OPTIONS.map((o) => o.id),
    [...LOCALES],
    "the switcher row offers exactly the shipped locales",
  );
  assert.ok(
    (LOCALES as readonly string[]).includes(DEFAULT_LOCALE),
    "the default language must be selectable from its own row",
  );
  assert.equal(LOCALE_OPTIONS[0]?.label, "简体中文");
  assert.equal(LOCALE_OPTIONS[1]?.label, "English");
  for (const o of LOCALE_OPTIONS) assert.ok(o.label.trim().length > 0, `${o.id} has an empty native name`);
});
