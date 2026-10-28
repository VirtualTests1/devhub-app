/**
 * `src/lib/palette-scope.ts` — 命令面板的 `>` / `@` / `#` 作用域前缀。
 *
 * 前缀的价值全在边界上：它只在第 0 个字节生效、只认三个字符、`>` 同时覆盖动作与
 * 设置项。这些规则一旦漂移，用户会看到「输入了 @ 却还混着记录」这种安静的错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterByScope,
  groupsForScope,
  inScope,
  parsePaletteQuery,
} from "../src/lib/palette-scope.ts";

test("前三个前缀字符各自收窄到一组（> 收窄到动作 + 设置）", () => {
  assert.deepEqual(parsePaletteQuery("> 刷新"), { scope: "commands", prefix: ">", text: "刷新" });
  assert.deepEqual(parsePaletteQuery("@ dev"), { scope: "projects", prefix: "@", text: "dev" });
  assert.deepEqual(parsePaletteQuery("# 下载"), { scope: "records", prefix: "#", text: "下载" });
});

test("没有前缀就是全部；前缀后的前导空格去掉，词内空格保留", () => {
  assert.deepEqual(parsePaletteQuery("read me"), { scope: null, prefix: "", text: "read me" });
  assert.equal(parsePaletteQuery(">   two words").text, "two words");
  assert.equal(parsePaletteQuery("@").text, "", "只有前缀是合法输入：显示该作用域的默认切片");
});

test("只在前缀是字段第一个字符时生效：前导空格让它成为普通搜索词", () => {
  const parsed = parsePaletteQuery(" @ dev");
  assert.equal(parsed.scope, null);
  assert.equal(parsed.text, " @ dev", "文本原样保留，用户仍能搜索 @ 本身");
  // A middle-of-word @ is not a scope either.
  assert.equal(parsePaletteQuery("foo@bar").scope, null);
});

test("只有已知的三个字符被当成前缀；其它符号原样搜索", () => {
  assert.equal(parsePaletteQuery("/settings").scope, null);
  assert.equal(parsePaletteQuery("$repo").scope, null);
  assert.equal(parsePaletteQuery("@@foo").scope, "projects", "第二个 @ 属于搜索词");
  assert.equal(parsePaletteQuery("@@foo").text, "@foo");
});

test("groupsForScope：commands 含动作与设置，projects / records 各一组，null 不设限", () => {
  assert.deepEqual(groupsForScope("commands"), ["actions", "settings"]);
  assert.deepEqual(groupsForScope("projects"), ["projects"]);
  assert.deepEqual(groupsForScope("records"), ["records"]);
  assert.equal(groupsForScope(null), null);
});

test("inScope：无作用域放行全部，有作用域只放行自己的组", () => {
  assert.equal(inScope("records", null), true);
  assert.equal(inScope("actions", null), true);
  assert.equal(inScope("settings", "commands"), true);
  assert.equal(inScope("projects", "commands"), false);
  assert.equal(inScope("records", "projects"), false);
  assert.equal(inScope("projects", "projects"), true);
});

test("filterByScope：保持原顺序，两条路径共用同一条收窄规则", () => {
  const rows = [
    { id: "a", group: "actions" },
    { id: "p", group: "projects" },
    { id: "s", group: "settings" },
    { id: "r", group: "records" },
  ] as const;
  assert.deepEqual(filterByScope(rows, null).map((r) => r.id), ["a", "p", "s", "r"]);
  assert.deepEqual(filterByScope(rows, "commands").map((r) => r.id), ["a", "s"]);
  assert.deepEqual(filterByScope(rows, "projects").map((r) => r.id), ["p"]);
  assert.deepEqual(filterByScope(rows, "records").map((r) => r.id), ["r"]);
});
