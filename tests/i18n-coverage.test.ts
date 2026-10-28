/**
 * `scripts/i18n-coverage.mjs` — 覆盖度量脚本的 CLI 契约（r21-o2-3）。
 *
 * 这个脚本存在的理由写在它自己的文件头：`tests/zh-hardcode-ratchet.test.ts` 只在
 * 超基线时才打印按文件的直方图，平时那份分布没有地方看。报告脚本最容易腐坏的
 * 方式不是算错，而是**没人再跑它** —— 表头改了、文件行漏了、合计与棘轮读数分了叉，
 * 文档照旧躺在 `docs/` 里当结论用。所以这里钉的是四件最便宜又最能发现腐坏的事：
 *
 *   1. 脚本能跑（从仓库根 spawn，退出码 0），stdout 是一张带表头的 markdown 表；
 *   2. 表里每个 `src/**\/*.tsx` 都在，一个不漏（文件计数与测试自己 walk 出来的对账）；
 *   3. 合计 = 同一条去注释规则的独立重算，且不高于棘轮的 `BASELINE` —— 报告与
 *      门禁读的必须是同一个数（两边任一侧改了计数规则，这条会红）；
 *   4. `docs/i18n-coverage.md` 落了盘，带生成日期、生成命令与一个不超基线的合计。
 *
 * 刻意不断言「文档合计 == 刚跑出来的合计」：那会把一份报告变成每改一行 `.tsx`
 * 就必须重跑的门禁，而本仓已有棘轮在管数字本身。文档只要求是**可信的快照**
 * （≤ 基线、结构齐全），新鲜度由生成命令 `pnpm i18n:coverage --md` 负责。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { at } from "./helpers/definite.ts";

const ROOT = process.cwd();
const SCRIPT = "scripts/i18n-coverage.mjs";
const RATCHET = "tests/zh-hardcode-ratchet.test.ts";

/** 表体行：`| src/x.tsx | 12 | 34 |`（合计行与 top-10 的行各有别的形状，不会落进来）。 */
const ROW = /^\| (src\/[^\s|]+\.tsx) \| (\d+) \| (\d+) \|$/;
const HEADER = "| 文件 | 中文硬编码行 | `t(` 调用 |";
const TOTAL_BULLET = /- 中文硬编码行合计：\*\*(\d+)\*\*/;

let cached: { status: number | null; out: string } | null = null;

/** 跑一次脚本并缓存结果；非 0 退出码本身就是失败信息（脚本的 stderr 在 out 里）。 */
function report(): string {
  if (!cached) {
    const r = spawnSync(process.execPath, [resolve(ROOT, SCRIPT)], {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 180_000,
    });
    cached = r.error
      ? { status: -1, out: `spawn failed: ${r.error.message}` }
      : { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  }
  assert.equal(cached.status, 0, cached.out);
  return cached.out;
}

function rows(out: string): [string, number, number][] {
  const found: [string, number, number][] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(ROW);
    if (m) found.push([at(m, 1), Number(at(m, 2)), Number(at(m, 3))]);
  }
  return found;
}

/** `src/**\/*.tsx` 的全量清单（测试自己走一遍，不借用被测脚本的函数）。 */
function tsxFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out.sort();
}

/**
 * 与棘轮同一条计数规则（去块注释、去整行 `//`、保留行内 `//`）—— 这里是第三份
 * 副本，第三处会分叉的地方：棘轮是定义方，被测脚本复制一份，本测试再复制一份，
 * 三者对不上时这条会红。
 */
function zhCodeLines(file: string): number {
  const src = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let inBlock = false;
  let n = 0;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
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
    if (/^\s*\/\//.test(line)) continue;
    if (/[一-鿿]/.test(line)) n++;
  }
  return n;
}

/** 棘轮的当前基线（只许下降的那个数），从棘轮源码里读而不是抄一份。 */
function ratchetBaseline(): number {
  const m = readFileSync(RATCHET, "utf8").match(/const BASELINE = (\d+);/);
  assert.ok(m, `${RATCHET} 里找不到 const BASELINE —— 对账的这一端没了`);
  return Number(at(m, 1));
}

test("i18n-coverage: 脚本可执行，stdout 是一张带表头与总读数的 markdown 表", () => {
  const out = report();
  assert.ok(out.includes(HEADER), `表头缺失，stdout 开头是：\n${out.slice(0, 400)}`);
  assert.match(out, /> 运行日期：\d{4}-\d{2}-\d{2}/, "缺运行日期，快照就无法判断新旧");
  assert.match(out, /pnpm i18n:coverage/, "缺生成命令，下一个人不知道怎么刷新这张表");
  assert.match(out, /- `t\(` 调用合计：\*\*\d+\*\*/, "缺 t( 调用总读数");
  const m = out.match(TOTAL_BULLET);
  assert.ok(m, "缺「中文硬编码行合计」总读数");
  assert.ok(Number(at(m, 1)) >= 0, "总读数非负");
});

test("i18n-coverage: 每个 src/**/*.tsx 都在表里（文件计数对账）", () => {
  const parsed = rows(report());
  const expected = tsxFiles();
  assert.equal(parsed.length, expected.length, "表体行数与 src 下的 .tsx 文件数不一致");
  assert.deepEqual(
    parsed.map(([f]) => f).sort(),
    expected,
    "表里列的文件集合与 src 下的 .tsx 文件集合不一致",
  );
  const seen = new Set(parsed.map(([f]) => f));
  assert.equal(seen.size, parsed.length, "同一个文件在表里出现了两次");
});

test("i18n-coverage: 合计 = 独立重算的棘轮读数，且不高于基线", () => {
  const out = report();
  const parsed = rows(out);
  const sum = parsed.reduce((n, [, zh]) => n + zh, 0);
  const bullet = out.match(TOTAL_BULLET);
  assert.ok(bullet, "缺「中文硬编码行合计」总读数");
  assert.equal(Number(at(bullet, 1)), sum, "总读数与表体各行之和不一致");

  const recount = tsxFiles().reduce((n, f) => n + zhCodeLines(f), 0);
  assert.equal(sum, recount, "脚本读数与本测试按同一规则的独立重算不一致 —— 有一侧改了计数规则");

  const baseline = ratchetBaseline();
  assert.ok(
    sum <= baseline,
    `覆盖度量的合计 ${sum} 已经高于棘轮基线 ${baseline}：棘轮应当先红，而不是报告越线`,
  );
});
