/**
 * r21-O3-3 —— 构建产物的**防回退守卫**（源码侧棘轮；`scripts/check-dist.mjs` 的
 * 四条预算常量一行没改，那是任务书的铁律）。
 *
 * ## 为什么钉源码机制，不钉 dist/ 的字节
 *
 * `tests/dist-budget.test.ts` 的头一段记着第 15 轮那次翻车（c0dde6e）：一条直接断言
 * `dist/` 体积的测试，在 `pnpm gate`（不构建）下测的是「某个时候留在盘上的产物」——
 * 陈旧的、甚至来自别的工作树的 `index-*.js` 让它红在一个与被审改动无关的原因上。
 * 那份头注释把「真实体积检查」明确判给了先构建再检查的 `pnpm verify`，也就是
 * `scripts/check-dist.mjs` 的四条预算；本方向不去重复它、也不去动它。
 *
 * 所以本文件守的是**产生那次削减的源码机制**：机制在，字节就在。r21-o3-2 那
 * −25,396 B 全部来自一件事 —— 1,190 个词条键（合并 master 后 1,260 个，机制不变）
 * 在 `src/lib/i18n.ts` 里从写两遍改成写一遍
 * （EN 存按 ZH 键序排的值数组）。机制回来，字节就回来，而回来的幅度（约 +26 KB 源码）
 * 大到足以被下面的体积棘轮当场拦下。
 *
 * ## 本方向实测的数（2026-10-19，分支 `feat/r21-o3-2-i18n-en-array` 之后）
 *
 *   - JS 合计 977,312 → **951,916 B**（−25,396，−2.60%），JS+CSS 1,054,564 → 1,029,168
 *   - `src/lib/i18n.ts` 165,557 → **139,613 B / 2,809 → 2,783 行**
 *   - 回潮的唯一结构性方式 = 把 EN 变回带键的对象（+26 KB，源文件回到 ≈165.5 KB）
 *
 * 合并 master（`db1e1eb`，含 N1 grep / N2 docker+compose / N3 deeplink 的 70 个新键）后
 * 同一文件 **148,432 B / 2,923 行**——键只写一遍的机制让 70 键只付出值的成本，
 * EN 侧零键名重复；对照 master 上键写两遍的旧结构，同样的 70 键会再多付约 2.6 KB 键名。
 *
 * ## 四条断言各挡一种回潮
 *
 *   1. 键只写一遍：全文件扫描行首 `"键":` 的出现次数，每个键必须恰好 1 次 ——
 *      直接钉住那 25 KB 的来源（`tests/star-import-ui.test.ts` 只对 stars.* 22 键做了同款计数，
 *      这里放大全表 1,190 键）。
 *   2. 值数组与键数等长：`EN_VALUES` 少一项 = 之后的英文整体错位（静默回落 zh 或配错键），
 *      多一项 = 一条永远读不到的死译文。
 *   3. 体积棘轮：源文件字节 ≤ `I18N_MAX_BYTES`。抬高上限必须在做这件事的提交里写明理由
 *      （同 `lib.rs` 的 `lib-rs-ceiling` 规矩），否则就是把守卫改成装饰。
 *   4. `ZH` 仍是对象字面量：`docs/i18n-key-typing.md` §4 把「ZH 不再是字面量」列为
 *      `keyof typeof ZH` 保护失效的触发条件 —— 追体积时最容易顺手把 ZH 也改成数组。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DICTIONARIES } from "../src/lib/i18n.ts";

const I18N_PATH = "src/lib/i18n.ts";
const RAW = readFileSync(I18N_PATH, "utf8");
const SRC = RAW.replace(/\r\n/g, "\n");
const LINES = SRC.split("\n");
// r32-O1: English values live in a lazy chunk; both files are budgeted below.
const EN_PATH = "src/lib/i18n-en.ts";
const EN_RAW = readFileSync(EN_PATH, "utf8");
const EN_SRC = EN_RAW.replace(/\r\n/g, "\n");
const EN_LINES = EN_SRC.split("\n");
/** 字节数走 TextEncoder 而非 statSync：tests/helpers/node-builtins.d.ts 的最小
 *  `node:fs` stub 只声明了 `{ isDirectory() }`，没有 `.size`（也不该为本文件去改共享 stub）。 */
const RAW_BYTES = new TextEncoder().encode(RAW).length;
const EN_BYTES = new TextEncoder().encode(EN_RAW).length;

/** 行首缩进两格的 `"键":` —— ZH 表、以及任何重新长出来的键表都长这样。 */
const KEY_LINE = /^ {2}"((?:[^"\\]|\\.)*)":/;

const ZH_START = LINES.indexOf("const ZH = {");
const ZH_END = LINES.indexOf("} as const;", ZH_START);
const VALUES_START = EN_LINES.indexOf("export const EN_VALUES = [");
const VALUES_END = EN_LINES.indexOf("] as const;", VALUES_START);

/** 全文件里每个行首键名出现了几次（第二张键表一旦长回来，这里立刻 >1）。 */
const keyOccurrences = new Map<string, number>();
for (const line of LINES) {
  const m = KEY_LINE.exec(line);
  if (m) keyOccurrences.set(m[1]!, (keyOccurrences.get(m[1]!) ?? 0) + 1);
}

/** ZH 块里的键（权威键集，顺序即 EN 值数组的下标序）。 */
const ZH_KEYS: string[] = [];
if (ZH_START >= 0 && ZH_END > ZH_START) {
  for (const line of LINES.slice(ZH_START + 1, ZH_END)) {
    const m = KEY_LINE.exec(line);
    if (m) ZH_KEYS.push(m[1]!);
  }
}

/** EN 值数组里真正的值行（缩进两格 + 引号开头；注释行与空行不算）。 */
const VALUE_LINES =
  VALUES_START >= 0 && VALUES_END > VALUES_START
    ? EN_LINES.slice(VALUES_START + 1, VALUES_END).filter((l) => /^ {2}["']/.test(l))
    : [];

test("bundle diet 1: 词条键在 src/lib/i18n.ts 里只写一遍（键名写第二遍 ≈ 25 KB 回潮）", () => {
  assert.ok(ZH_START >= 0 && ZH_END > ZH_START, "ZH 对象字面量的标记行没扫到——本文件的扫描必须跟着改");
  const published = Object.keys(DICTIONARIES["zh-CN"]);
  assert.equal(ZH_KEYS.length, published.length, `源码扫描到 ${ZH_KEYS.length} 个键，词表发布 ${published.length} 个——扫描或词表有一边坏了`);
  assert.equal(new Set(ZH_KEYS).size, ZH_KEYS.length, "ZH 块内部就有重复键（TS 也会报 duplicate property，不该走到这里）");
  const twice = ZH_KEYS.filter((k) => keyOccurrences.get(k) !== 1);
  assert.deepEqual(
    twice,
    [],
    `${twice.length} 个键不是恰好出现 1 次（>1 = 第二张键表长回来了，r21-o3-2 的 −25,396 B 会整笔退回；0 = 键在 ZH 里却被删了）: ${twice.slice(0, 8).join(", ")}`,
  );
});

test("bundle diet 2: EN 值数组与 ZH 键数等长（少一项整体错位，多一项是死译文）", () => {
  assert.ok(VALUES_START >= 0 && VALUES_END > VALUES_START, "EN_VALUES 的标记行没扫到——结构改了，本文件必须跟着改");
  const keyLinesInEn = EN_LINES.filter((l) => KEY_LINE.test(l)).length;
  assert.equal(keyLinesInEn, 0, "英文值文件里长出了键表（值数组必须只有值）");
  assert.equal(
    VALUE_LINES.length,
    ZH_KEYS.length,
    `EN_VALUES 有 ${VALUE_LINES.length} 个值，ZH 有 ${ZH_KEYS.length} 个键：少一项会让其后的英文整体错位（EN_VALUES[i] ?? "" 静默回落 zh），多一项是永远读不到的死译文`,
  );
});

test("bundle diet 3: src/lib/i18n.ts 体积棘轮（抬高上限必须在提交里写明理由）", () => {
  // 当前 167,411 B（r21-o2 的 158 条新键并入值数组后实测）；并入前 148,432 B（db1e1eb），
  // 199,699 B 是 r21-o2 对象形态的实测值，≈165,557 B 是键写两遍的旧值；
  // 175_000 给 r21 剩余线（依赖面板 / 网络状态的词条，估 ≈70 条 ≈9 KB）留头寸，
  // 但把「EN 变回带键对象」（实测 199.7 KB）挡在门外。抬高它 = 放弃这道闸，必须写清理由。
  //
  // r22-O2 上调到 186_000：新增 120 条中英成对词条（pw.* 41 / dl.* 33 / queue.* 21 /
  // 开发者模式 dev.* 25，部分合并），实测 185,745 B。这是把三块 .tsx 的中文界面字面量
  // 搬进词表换来的合法增长（棘轮 329→209 行）；不是第二张键表——bundle diet 1 仍在守。
  // r22-O1 再上调到 187_000：令牌存储状态需要两条中英词条（tokenUnreadable 及其说明），
  // 实测 186,560 B；仍是词表接线，不是键名重复。
  // r23 并入存储概览（6 条）、备注（4 条）、I/O（1 条）后实测 190,741 B，再重钉一次。
  // r22-N1 并入远端预检 17 条词条后实测 187,754 B；随后 N2 文件浏览（15 条）与 O3
  // 配置恢复（2 条）并入，集成终态实测 189,700 B，常量按实测重钉。
  // r25-O1 把设置/收藏搜索的导出导入两行、缓存占用/时间格式两行，以及设置页
  // 尾部的 toast/占位符（共 62 条中英成对词条）接进词表，中文硬编码棘轮 209→136；
  // 实测 197,474 B。199.7 KB 的「EN 变回带键对象」形态叠上这批新键会到约
  // 206 KB，仍被原来的闸挡住。
  // r25-O2 再接线外壳（标题栏/侧边栏/App 启动门）39 条词条，实测 200,948 B；
  // 随后常用页 toast、路径选择、Git 引导、对话框/通知/页脚、启动与致命错误面
  // 再并入 29 条，实测 203,451 B。仍是同一张键表，不是键名重复。
  // 206_000 → 208_000 on 2026-10-22 (r25-N1): the settings catalog search adds
  // 13 paired keys (3 UI strings + 10 alias rows). The aliases live in the
  // dictionary deliberately: as a Chinese table in SettingsView they would raise
  // the zh-hardcode ratchet, which is supposed to only go down.
  // 208_000 → 212_000 on 2026-10-22 (r26-O1): card cover/local-source/selection
  // tooltips and the tag editor add 28 paired tile.*/tags.* keys (measured
  // 211,015 B after the r25-N1 and r26 integrations). Still one key table.
  // 212_000 → 220_000 on 2026-10-28 (r27): three optimizations/new features land
  // their UI text here — tag editor + tile tooltips (O4), launch-risk sentences
  // and the second-confirmation copy (O3), branch selection (N1), recent commits
  // (N2), taskbar attention (N3), and the credential-scrub notice (O1). Measured
  // 216,867 B. The cap still sits below the 199.7 KB object-EN regression plus
  // this round's growth (~222 KB), so the structural guard is intact.
  // 220_000 → 232_000 on 2026-10-29 (r30): saved wall views, note search evidence,
  // download diagnostics/remedies, update cache wording, wall snapshot/restore,
  // LFS/submodule warnings and crash reports add 100 paired keys (measured
  // 229,032 B). All are literal call sites; bundle diet 1 still proves the key
  // table did not grow a second copy.
  // r32-O1 split the English values into src/lib/i18n-en.ts (a lazy chunk).
  // Measured after the split and this round's new keys:
  //   i18n.ts 149,543 B (zh table + lookup + lazy loader)
  //   i18n-en.ts 83,742 B (values only)
  // Each ceiling leaves ~2 KB for a normal round; a second key table still
  // fails bundle diet 1/2 before size is considered.
  // 152_000 -> 156_000 on 2026-10-30 (r33): cross-repo search, release
  // awareness and the license overview added 26 paired keys (measured
  // 153,303 B). Every one is a literal `t("…")` call site; bundle diet 1 still
  // proves there is no second key table.
  // 156_000 -> 159_000 on 2026-10-30 (r34): health issue labels, the secret
  // scanner and search progress/cancel added 45 paired keys (measured
  // 156,332 B with the checkout's CRLF). Same literal-call-site rule.
  const I18N_MAX_BYTES = 159_000;
  // 86_000 -> 88_000 on 2026-10-30 (r33): the same 26 paired keys, English side
  // measured 86,049 B. Values only; no lookup logic lives here.
  // 88_000 -> 92_000 on 2026-10-30 (r34): r34's 45 paired keys measure 90,105 B
  // with the checkout's CRLF. Values only, as before.
  const EN_MAX_BYTES = 92_000;
  assert.ok(
    RAW_BYTES <= I18N_MAX_BYTES,
    `${I18N_PATH} 现在 ${RAW_BYTES} B，超过棘轮 ${I18N_MAX_BYTES} B（r32-O1 拆分后实测 149,543 B）。正当增长就抬高并写明理由；否则先查第二张键表`,
  );
  assert.ok(
    EN_BYTES <= EN_MAX_BYTES,
    `${EN_PATH} 现在 ${EN_BYTES} B，超过棘轮 ${EN_MAX_BYTES} B（r32-O1 拆分后实测 83,742 B）。值数组只能有值，加键必须同时加值`,
  );
});

test("bundle diet 4: ZH 仍是对象字面量——keyof typeof ZH 的编译期键类型不能在追体积时丢", () => {
  // docs/i18n-key-typing.md §4：ZH 改成数组/JSON 运行时构建时 keyof 会静默退化成 string，
  // 「键写错 = 编译错误」整条消失而 tsc 依然绿。r21-o3-2 刻意只动 EN，这条钉住那个刻意。
  assert.ok(
    SRC.includes("export type TranslationKey = keyof typeof ZH;"),
    "TranslationKey 不再由 keyof typeof ZH 派生——编译期键类型已经没了",
  );
  assert.equal(LINES[ZH_START], "const ZH = {", "ZH 的声明形态变了（见 docs/i18n-key-typing.md §4 的触发条件）");
  assert.equal(LINES[ZH_END], "} as const;", "ZH 不再是 as const 字面量，字面量键联合随之失效");
});
