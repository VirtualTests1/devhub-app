/**
 * CSV 导出的 UI 接线：kind 传给后端、扩展名/filter 正确、按钮可发现。
 * 序列化本身的转义由 Rust `activity::tests::csv_...` 钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const VIEW = readFileSync("src/views/RecordsView.tsx", "utf8");

test("接线: kind=csv、扩展名 csv、filter CSV、按钮调用 exportFile(csv)", () => {
  assert.match(VIEW, /kind: "jsonl" \| "markdown" \| "markdown-grouped" \| "csv"/);
  assert.match(VIEW, /kind === "csv" \? "csv" : "md"/);
  assert.match(VIEW, /t\("records\.exportCsvTitle"\)/);
  assert.match(VIEW, /onClick=\{\(\) => void exportFile\("csv"\)\}/);
  assert.match(VIEW, /name: ext === "md" \? "Markdown" : ext === "csv" \? "CSV" : "JSONL"/);
});

test("词条: zh/en 成对", () => {
  assert.equal(tFor("zh-CN", "records.exportCsv"), "导出 CSV");
  assert.equal(tFor("en", "records.exportCsv"), "Export CSV");
  assert.match(tFor("zh-CN", "records.exportCsvTitle"), /Excel/);
});
