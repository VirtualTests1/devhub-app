/**
 * `src/components/CommandPalette.tsx` — scope prefixes are wired into BOTH
 * ranking paths.
 *
 * The pure parser is covered by `tests/palette-scope.test.ts`; this file pins the
 * wiring, because the failure mode is a scope that applies to a typed query but
 * not to the empty-query slice (or vice versa): one screen filters, the other
 * quietly does not. Structural, same harness as `tests/palette-theme-command.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const code = readFileSync("src/components/CommandPalette.tsx", "utf8");

test("接线: 输入先过 parsePaletteQuery，两个排序分支都走 filterByScope", () => {
  assert.match(code, /import \{[\s\S]*?parsePaletteQuery[\s\S]*?\} from "\.\.\/lib\/palette-scope"/);
  assert.match(code, /const parsedQuery = useMemo\(\(\) => parsePaletteQuery\(query\), \[query\]\)/);
  assert.match(code, /groupsForScope\(scope\) \?\? GROUP_ORDER/, "空查询的默认切片受作用域约束");
  assert.match(code, /const scoped = filterByScope\(commands, scope\)/, "有词查询在打分前收窄");
  assert.match(code, /\[commands, parsedQuery, localIndex, recentIds\]/, "parsedQuery 或最近序变化必须重建排序");
});

test("接线: 前缀提示可见、可朗读，且作用域激活时改口", () => {
  assert.match(code, /aria-describedby=\{`\$\{uid\}-scope-hint`\}/, "输入框关联到提示行");
  assert.match(code, /id=\{`\$\{uid\}-scope-hint`\}/);
  assert.match(code, /t\("palette\.scopeActive", \{ scope: scopeLabel\(t, parsedQuery\.scope\) \}\)/);
  assert.match(code, /: t\("palette\.scopeHint"\)/);
});

test("词条: zh/en 成对，且说明三种前缀", () => {
  assert.equal(tFor("zh-CN", "palette.scopeHint"), "前缀：> 动作 · @ 项目 · # 记录");
  assert.equal(tFor("en", "palette.scopeHint"), "Prefixes: > actions · @ projects · # records");
  assert.equal(tFor("zh-CN", "palette.scopeActive", { scope: "项目" }), "仅看：项目");
  assert.equal(tFor("en", "palette.scopeActive", { scope: "Projects" }), "Scope: Projects");
});

test("最近使用: 两条执行路径都记录，空查询按最近重排、有词查询只加 tie-break", () => {
  assert.match(code, /useState<string\[\]>\(\(\) => readRecent\(\)\)/, "打开时读取一次，坏数据自行降级");
  assert.match(code, /const runCommand = \(command: Command\) => \{\s*setRecentIds\(pushRecent\(command\.id\)\);/);
  assert.match(code, /onClick=\{\(\) => runCommand\(c\)\}/, "鼠标执行记录");
  assert.match(code, /runCommand: run \} = nav\.current;[\s\S]*?if \(list\[at\]\) run\(list\[at\]\)/, "Enter 执行记录");
  assert.match(code, /rankByRecent\(\s*commands\.filter\(\(c\) => c\.group === g\),\s*recentIds,?\s*\)/, "空查询的货架按最近排序");
  assert.match(code, /s: \(fused\[i\] \?\? 0\) \+ recentBoost\(row\.c\.id, recentIds\)/, "有词查询只加有界加成");
});
