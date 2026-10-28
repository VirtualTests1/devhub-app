/**
 * `src/lib/tool-install.ts` — the missing-tool "缺什么 + 怎么装" mapping the launch
 * panel renders. Pure, so the install rows and the best-effort version extraction
 * from detection notes are testable without a DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { toolGuidanceFor, versionFromNotes } from "../src/lib/tool-install.ts";

import { at } from "./helpers/definite.ts";

test("versionFromNotes: pulls the version out of a note that names the tool", () => {
  const notes = ["package.json engines 需要 Node >= 18.0.0 才支持"];
  assert.equal(versionFromNotes(notes, ["node", "engines"]), "18.0.0");
});

test("versionFromNotes: matches on any alias, case-insensitively", () => {
  assert.equal(versionFromNotes(["pyproject 要求 python 3.11"], ["python"]), "3.11");
  assert.equal(versionFromNotes(["PyTorch 需要 Py 3.12.1"], ["py"]), "3.12.1");
});

test("versionFromNotes: null when no note names the tool, and null when it has no version", () => {
  assert.equal(versionFromNotes(["找不到包管理器"], ["node"]), null);
  assert.equal(versionFromNotes(["package.json 存在但无法读取"], ["node"]), null);
});

test("toolGuidanceFor: known labels get a command and a link", () => {
  const rows = toolGuidanceFor(["Node.js", "Python"], []);
  assert.equal(rows.length, 2);
  assert.equal(at(rows, 0).how, "winget install OpenJS.NodeJS.LTS");
  assert.ok(at(rows, 0).url);
  assert.equal(at(rows, 1).how, "winget install Python.Python.3");
});

test("toolGuidanceFor: attaches a declared version when the notes carry one", () => {
  const rows = toolGuidanceFor(["Node.js"], ["engines 需要 node >= 20.11.0"]);
  assert.equal(at(rows, 0).version, "20.11.0");
});

test("toolGuidanceFor: an unknown label still yields an actionable row, with no link", () => {
  const rows = toolGuidanceFor(["Deno"], []);
  assert.equal(at(rows, 0).name, "Deno");
  assert.ok(at(rows, 0).how.length > 0);
  assert.equal(at(rows, 0).url, undefined);
});
