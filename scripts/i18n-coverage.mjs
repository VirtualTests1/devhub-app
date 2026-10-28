// i18n-coverage.mjs — `src/**/*.tsx` 的中文硬编码覆盖度量（报告，不设门禁）。
//
// 为什么要它（r21-o2-3）：`tests/zh-hardcode-ratchet.test.ts` 只在**超过基线**时
// 打印按文件的直方图，平时那份分布是看不见的 —— 棘轮是红绿灯，不是地图。这个
// 脚本把同一套读数变成随取随看的 markdown 表：每个 `.tsx` 一行，两列数字，
// 「去注释后仍含中文的代码行」（= 棘轮计的债）与「`t(` 调用次数」（= 词表接线
// 的密度）。两列都不是质量评分：`.ts` 的纯逻辑模块不在射程内（同棘轮：注册表
// 数据、持久化步骤名那类中文属于数据标识，不在这条计数的射程），`t(` 多也可能
// 只是这个页面长。
//
// 用法：
//     node scripts/i18n-coverage.mjs          把 markdown 报告打到 stdout
//     node scripts/i18n-coverage.mjs --md     同时回写 docs/i18n-coverage.md
//     pnpm i18n:coverage                      上面那条的 package.json 快捷方式
//
// 计数规则与 `tests/zh-hardcode-ratchet.test.ts` 逐条一致（同一份去注释规则：
// 去块注释与整行 `//` 注释、保留行内 `//` 注释 —— 逐字符切 `//` 会把
// `https://…` 从协议头截断，见棘轮文件头），所以表尾的**合计就是棘轮会读到的
// 那个数**；两边不一致时，错的是先动的那个。`tests/i18n-coverage.test.ts` 用
// 同一条规则独立重算一遍与本表对账，并把合计压在棘轮基线之下。
//
// 依赖按本仓 scripts 的硬规则：只用 node:fs / node:path / node:url。
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Root anchoring（round 15 d7 起的通则）：路径全部相对脚本自身，`cd tests && node
// ../scripts/i18n-coverage.mjs` 与从仓库根跑必须给出同一张表。
process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));

const writeMd = process.argv.includes("--md");
for (const a of process.argv.slice(2)) {
  if (a !== "--md") {
    // 未识别的参数一律拒绝而不是忽略：一个被静默吃掉的 `--md` 会让“文档已更新”
    // 变成一句没人验证过的话（同 check-dist.mjs / check-docs.mjs 的出口码 2）。
    console.error(`i18n-coverage.mjs: unrecognised argument '${a}' (only --md is accepted)`);
    process.exit(2);
  }
}

/** 一行里出现任意 CJK 统一表意文字即算「含中文」。 */
const ZH = /[\u4e00-\u9fff]/;

/** 源码里的 `t(` 调用（`\b` 让 `sort(` / `tFor(` / `sectionTitle(` 不被数进去）。 */
const T_CALL = /\bt\(/g;

/**
 * 去掉块注释（`/* … *\/`，含 JSX 的 `{/* … *\/}`）、丢掉整行 `//` 注释后的源码行。
 * 与 `tests/zh-hardcode-ratchet.test.ts` 的 `codeLines` 是同一份算法 —— 那个文件
 * 是这条计数的定义方，这里复制一份是为了脚本不依赖测试文件；改动任一侧都要改两处，
 * 对账由 `tests/i18n-coverage.test.ts` 负责。
 */
function codeLines(file) {
  const src = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const kept = [];
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

/** Every `.tsx` under `src/`, as posix-relative paths, sorted. */
function tsxFiles(dir = "src") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out.sort();
}

const rows = tsxFiles().map((file) => {
  const lines = codeLines(file);
  return {
    file,
    zh: lines.filter((l) => ZH.test(l)).length,
    calls: lines.reduce((n, l) => n + (l.match(T_CALL)?.length ?? 0), 0),
  };
});

// 欠债降序、同数按路径（与棘轮直方图同序），0 债文件仍列在表里 —— 「一个 t( 都
// 没有也没有中文」的页面才是覆盖度问题，只列有债的文件会把那一半藏起来。
const ordered = [...rows].sort((a, b) => b.zh - a.zh || a.file.localeCompare(b.file));
const totalZh = rows.reduce((n, r) => n + r.zh, 0);
const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
const inDebt = rows.filter((r) => r.zh > 0).length;
const top = ordered.filter((r) => r.zh > 0).slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

const table = [
  "| 文件 | 中文硬编码行 | `t(` 调用 |",
  "| --- | ---: | ---: |",
  ...ordered.map((r) => `| ${r.file} | ${r.zh} | ${r.calls} |`),
  `| **合计（${rows.length} 个 .tsx）** | **${totalZh}** | **${totalCalls}** |`,
].join("\n");

const doc = [
  "# i18n 覆盖度量（`src/**/*.tsx`）",
  "",
  `> 生成命令：\`pnpm i18n:coverage\`（等价 \`node scripts/i18n-coverage.mjs\`；回写本文件加 \`--md\`）`,
  `> 运行日期：${today}`,
  "> 计数规则：与 `tests/zh-hardcode-ratchet.test.ts` 同一份去注释规则（去块注释与整行 `//`，",
  "> 保留行内 `//`）—— 所以下面的合计**就是**棘轮读到的那个数，基线只许下降。",
  "",
  "## 总读数",
  "",
  `- 文件：${rows.length} 个 \`.tsx\`，其中 **${inDebt}** 个仍有未接词表的中文代码行`,
  `- 中文硬编码行合计：**${totalZh}**`,
  `- \`t(\` 调用合计：**${totalCalls}**`,
  "",
  "## 欠债面 top 10",
  "",
  ...(top.length
    ? top.map((r) => `- \`${r.file}\` — ${r.zh} 行`)
    : ["- （无：所有 `.tsx` 的中文代码行都是 0）"]),
  "",
  "## 按文件（欠债降序，0 债在后）",
  "",
  table,
  "",
].join("\n");

console.log(doc.trimEnd());

if (writeMd) {
  writeFileSync("docs/i18n-coverage.md", `${doc}`, "utf8");
  console.log(`\nwritten: docs/i18n-coverage.md`);
}
