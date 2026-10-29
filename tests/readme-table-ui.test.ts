/**
 * The renderer half of r31-N2: table nodes become a real horizontal-scrolling
 * table with per-column alignment, and task-list items become read-only
 * checkboxes. The parser's security contract is unchanged; this only pins the
 * new branches wiring up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DIALOG = readFileSync("src/dialogs/RepoReadmeDialog.tsx", "utf8");

test("README: table nodes render header/body with alignment and overflow", () => {
  assert.match(DIALOG, /case "table":/);
  assert.match(DIALOG, /overflow-x-auto/);
  assert.match(DIALOG, /style=\{\{ textAlign: b\.align\[i\] \?\? undefined \}\}/);
  assert.match(DIALOG, /b\.rows\.map\(\(row, r\)/);
  assert.match(DIALOG, /renderInline\(cell, t,/);
});

test("README: task items are disabled checkboxes with accessible labels", () => {
  assert.match(DIALOG, /item\.task === "checked"/);
  assert.match(DIALOG, /type="checkbox"/);
  assert.match(DIALOG, /disabled/);
  assert.match(DIALOG, /readOnly/);
  assert.match(DIALOG, /t\("readme\.taskDone"\)/);
  assert.match(DIALOG, /t\("readme\.taskOpen"\)/);
});