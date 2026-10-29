/**
 * 「未接入中文硬编码」计数棘轮（r17-n1-4）。
 *
 * ## 它数的是什么
 *
 * `src/**\/*.tsx` 里，**去掉注释之后**仍含中文（`\u4e00-\u9fff`）的行数。注释不算：
 * 本仓的注释本身就是中文散文（`// 需求 3：…`），把它们计进去，这个数字只会反映
 * 「注释写得多不多」，随手加一条注释就会误伤门禁。真正的债是**筛不出词表的界面字面量**，
 * 所以扫的是代码行。`.tsx` 之外（`.ts` 的纯逻辑模块、后端 Rust）不在本棘轮射程内，
 * 也因此 `settings/helpers.ts`、`records/constants.ts` 那类「模块内的中文表」不计入
 * ——它们该不该接入是各自方向的事，不靠这条计数来管。
 *
 * ## 为什么是上限基线，而不是「必须为 0」
 *
 * r17-n1 把三批表面接进了词表（记录页、常用页与卡片菜单、设置页行文案），但**没有接完**：
 * 一次性 toast、原生文件对话框标题、后端原话、命令 / 路径 / URL 示例都仍是中文字面量，
 * 见 `DEVELOPMENT.md` §4「界面语言」。声称「已经全接完」才是假的，所以这里钉的是
 * **当前实测值** —— 一个只许下降的棘轮：以后每接入一处，就顺手把基线调小；若有人
 * **新增**了未接入的中文，它会在这里变红。
 *
 * 基线数字来自这条扫描实际跑出来的输出，不是估的：
 * `node --experimental-strip-types --import ./tests/helpers/register.mjs --test tests/zh-hardcode-ratchet.test.ts`
 * 在 r17-n1 三批接线之后实测为 **1200** 行（44 个 `.tsx` 有债），据此钉的基线。
 * r18-o1-1 接入四个仓库面板（端口 / 工作树 / Python / 同步）后实测为 **1091** 行，
 * 基线随之下调：sync 面板保留的 3 行是持久化的步骤名（「安装依赖」「启动」），
 * 属于数据标识而不是界面文案，见 `RepoSyncPanel.tsx` 里的注释。
 * r18-o1-2 接入启动对话框家族（LaunchDialog + launch/ 五个子组件）后实测为 **965** 行；
 * LaunchDialog 保留的 2 行同样是数据标识：写进 `.devhub.json` 的默认步骤名「启动」、
 * 以及 `toolGuidanceFor()` 的查找键「任意可用 IDE」，见各自调用点的注释。
 * r18-o1-3 接入外观页（`AppearanceView.tsx`）后实测为 **851** 行；保留的 1 行同样是
 * 数据：导入模版时的兜底模版名「导入的模版」会写进本地模版列表，见调用点注释。
 * r18-o1-4 接入状态条面板（`StatusStrip.tsx`）后实测为 **781** 行；这一批没有保留任何
 * 字面量——弹层里的两处中文 `//` 注释挪成了整行注释，打点行、分隔符与 `join("、")`
 * 留在调用点，与既有先例一致。并入 master 的 r16 面板挂载（56905a6）又在项目设置
 * 对话框里加了 4 行中文（「工作树」小节标题与一段说明），并入后实测 **785** 行——
 * 那 4 行属于并行线写的挂载点文案，等接线到该文件时一起清零；本批自己的净账仍是 -70。
 * r19-O1 接入项目墙/批量条（A1，785→663）、记录页（A2，663→629）与添加页/搜索面板
 * （A3，629→534）后实测 **534** 行；`AddRepoView.tsx` 保留的 3 行同样是数据标识：
 * 写进记录归档的来源名「添加页」「搜索结果」，以及 hosts 探测的兜底名「本地加速」，
 * 见各自调用点的注释。
 * r21-o2-1 接入项目设置对话框（`ProjectSettingsDialog.tsx`，99 行全清零）后实测
 * **429** 行、32 个文件有债；这一批没有保留任何字面量——连四段包着 <code>/<strong>
 * 的说明文字也拆成了词表里的 Lead / Tail（组装断言见 `tests/i18n-project-settings.test.ts`，
 * 其中 `psd.venvsDir` 顺手修掉了原字面量里那个竖控制字符）。
 * r21-o2-2/3 接入命令面板（`CommandPalette.tsx`，58→0 行）与设置→界面页
 * （`InterfaceRegistry.tsx`，41→0 行）后实测 **330** 行、30 个文件有债，基线随之下调；
 * 这两批同样没有保留任何字面量——连分组 id 都从中文改成英文标识（显示名在渲染处过
 * 词表）。并入 master（`90c8832`）之后读数不变（master 新增的 `.tsx` 自带词表，0 债）。
 * r21-N1b-2 接入设置→依赖更新面板后实测 **329** 行：新增的 `DepsUpdateSection.tsx`
 * 零债（全部走词表），顺手把 `SettingsRows.tsx` 里仅剩的两行未接线中文（devMode
 * 齿轮的 title/aria-label「调整这个区块（…）」）接进 `settings.adjustBlock`（−2），
 * 而 `settingsCatalog.tsx` 新增的「依赖更新」目录行是 +1（它是数据表不是渲染面，
 * 与 `VIEW_LABEL` 同类），净账 −1。
 * 分文件的读数从 `pnpm i18n:coverage`（`scripts/i18n-coverage.mjs`）随时可取，
 * 落盘的快照是 `docs/i18n-coverage.md` —— 棘轮只在**超基线**时才打印直方图，
 * 平时那份分布得有个地方看。
 *
 * r22-O2 接入设置→项目页（`ProjectsSection.tsx`，40→0）、下载进度与队列
 * （`DownloadProgress.tsx` 28→0、`DownloadQueue.tsx` 22→0）以及开发者模式
 * （`CustomizeLayer.tsx`，30→0）后实测 **209** 行、25 个文件有债，基线随之下调。
 * 三批都新增了中英成对词条（`pw.*` / `dl.*` / `queue.*` / `dev.*`），没有保留任何
 * 中文界面字面量；`dev.hideConfirm` 的 `{label}` / `{extra}` 两个槽在两种语言里同名，
 * 由 `tests/i18n.test.ts` 的 slot 对位检查钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

/**
 * 当前实测上限（r28 增加 settingsCatalog 的「关于」目录行后 **32**；该行是数据表，
 * 不是可翻译的渲染面，与其余 31 行同类；`pnpm i18n:coverage` 可复测）。
 *
 * 剩下的 31 行全部是**持久化/协议数据**，不是可翻译的界面文案：
 * settingsCatalog 14（目录 id→标题表，与 `sectionTitle` 的 fallback 同源）、
 * FrequentView 8（旧存档里的中文分组名→view id 的兼容映射）、RepoSyncPanel 3 +
 * LaunchDialog 2（写进 `.devhub.json` 的步骤名/工具查找键）、AddRepoView 2（写进
 * 活动归档的来源名）、AppearanceView 1（导入模版的兜底名）、RecordsView 1（来源名）。
 * 把它们换成 `t()` 会让「按字节匹配旧数据」的路径断掉。只许改小。
 */
const BASELINE = 32;

/** 一行里出现任意 CJK 统一表意文字即算「含中文」。 */
const ZH = /[\u4e00-\u9fff]/;

/**
 * 去掉块注释（`/* … *\/`，含 JSX 的 `{/* … *\/}`）、丢掉整行 `//` 注释后的源码行。
 *
 * 行内 `//` 注释（`foo(); // 中文`）**保留**：逐字符切 `//` 会把 `https://…`
 * 这种字符串从协议头处截断，把 URL 后半段连同正文一起误删 —— 那比这点偏差更贵。
 */
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

/** Every `.tsx` under `src/` — the tree this ratchet measures. */
function tsxFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("i18n: 未接入中文硬编码的行数不超过基线（只许下降的棘轮）", () => {
  const perFile: [string, number][] = [];
  let current = 0;
  for (const file of tsxFiles()) {
    const n = codeLines(file).filter((l) => ZH.test(l)).length;
    current += n;
    if (n) perFile.push([file, n]);
  }
  perFile.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const histogram = perFile
    .slice(0, 30)
    .map(([f, n]) => `  ${String(n).padStart(4)}  ${f}`)
    .join("\n");
  assert.ok(
    current <= BASELINE,
    `未接入的中文硬编码行数上涨了：当前 ${current} 行，基线 ${BASELINE} 行（只允许下降）。\n` +
      `应当接入词表，或把基线在 tests/zh-hardcode-ratchet.test.ts 里改小 —— 不要改大。\n` +
      `按文件（前 30，共 ${perFile.length} 个文件有债）：\n${histogram}`,
  );
});
