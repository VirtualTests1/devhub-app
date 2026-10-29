/**
 * Wall → Markdown is a one-way snapshot, so the tests focus on the two ways a
 * snapshot goes wrong: a cell that breaks the table (or injects HTML into a
 * renderer), and a row set that disagrees with what the wall shows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildWallMarkdown,
  markdownCell,
  rowsFromWall,
  type WallExportLabels,
} from "../src/lib/wall-export.ts";

const LABELS: WallExportLabels = {
  title: "项目清单",
  name: "项目",
  alias: "别名",
  tags: "标签",
  note: "备注",
  path: "路径",
  empty: "（空）",
};

test("cells escape table and HTML syntax", () => {
  assert.equal(markdownCell("a|b"), "a\\|b");
  assert.equal(markdownCell("a\nb"), "a<br>b");
  assert.equal(markdownCell("a\r\nb"), "a<br>b");
  assert.equal(markdownCell("<img onerror=x>"), "&lt;img onerror=x&gt;");
  assert.equal(markdownCell("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(markdownCell("`code`"), "\\`code\\`");
  assert.equal(markdownCell("   "), "—");
  assert.equal(markdownCell(""), "—");
});

test("rows follow display order, skip hidden cards, and index state by full slug", () => {
  const repos = [
    { host: "github.com", owner: "z", repo: "last", path: "D:/p/last" },
    { host: "github.com", owner: "a", repo: "first", path: "D:/p/first" },
    { host: "github.com", owner: "h", repo: "hidden", path: null },
  ];
  const states = {
    "github.com/z/last": { alias: "Zed", tags: ["工具", "  "], note: "note" },
    "github.com/a/first": { tags: ["a", "b"] },
    "github.com/h/hidden": { hidden: true },
  };
  const rows = rowsFromWall(repos, states);
  assert.deepEqual(rows.map((r) => r.name), ["a/first", "z/last"]);
  assert.deepEqual(rows[0]?.tags, ["a", "b"]);
  assert.equal(rows[1]?.alias, "Zed");
  assert.equal(rows[1]?.tags.length, 1, "blank tags are dropped");
  assert.equal(rows[1]?.path, "D:/p/last");
});

test("the document has a real table and an honest empty state", () => {
  const text = buildWallMarkdown(
    [{ name: "o/r", alias: "别名", tags: ["t1", "t2"], note: "n|1", path: "D:/p" }],
    LABELS,
  );
  assert.ok(text.startsWith("# 项目清单\n\n| 项目 | 别名 | 标签 | 备注 | 路径 |"));
  assert.ok(text.includes("| --- | --- | --- | --- | --- |"));
  assert.ok(text.includes("| o/r | 别名 | t1, t2 | n\\|1 | D:/p |"));
  assert.equal(buildWallMarkdown([], LABELS), "# 项目清单\n\n（空）\n");
});

test("the settings section wires the export to a save dialog and a file write", () => {
  const src = readFileSync(resolve(process.cwd(), "src/views/settings/ProjectsSection.tsx"), "utf8");
  assert.match(src, /rowsFromWall\(repos, states\)/);
  assert.match(src, /buildWallMarkdown\(/);
  assert.match(src, /defaultPath: "devhub-wall\.md"/);
  assert.match(src, /write_text_file/);
  assert.match(src, /pw\.exportMdOk/);
});
