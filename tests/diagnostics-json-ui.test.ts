/**
 * JSON 导出必须是一个独立、可发现的命令面板动作，并且真的把 format 传给后端。
 * Markdown 那条动作保持原样（不带 format），避免旧路径被意外改成 JSON。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const PALETTE = readFileSync("src/components/CommandPalette.tsx", "utf8");

test("接线: JSON 动作单独存在，save 对话框用 .json，invoke 带 format", () => {
  assert.match(PALETTE, /id: "act-export-diag-json"/);
  assert.match(PALETTE, /defaultPath: `devhub-diagnostics-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.json`/);
  assert.match(PALETTE, /invoke\("export_diagnostics", \{ path: picked, format: "json" \}\)/);
  // The Markdown action must stay format-less.
  assert.match(PALETTE, /await invoke\("export_diagnostics", \{ path: picked \}\);/);
});

test("词条: zh/en 成对", () => {
  assert.equal(tFor("zh-CN", "palette.exportDiagJson"), "导出诊断报告（JSON）");
  assert.equal(tFor("en", "palette.exportDiagJson"), "Export diagnostics report (JSON)");
});
