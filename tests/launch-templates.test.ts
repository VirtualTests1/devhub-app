import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteTemplate, loadUserTemplates, saveTemplate } from "../src/lib/launch-templates";
import type { LaunchStep } from "../src/types";
import { installBrowserGlobals } from "./helpers/storage";

import { at } from "./helpers/definite.ts";

installBrowserGlobals();

const KEY = "devhub.launch.templates.v1";

function resetStore() {
  localStorage.clear();
}

test("loadUserTemplates returns empty when nothing is stored", () => {
  resetStore();
  assert.deepEqual(loadUserTemplates(), []);
});

test("saveTemplate persists and loadUserTemplates reads it back", () => {
  resetStore();
  const steps: LaunchStep[] = [
    { name: "install", command: "npm install", cwd: "", parallel: false },
    { name: "run", command: "npm run dev", cwd: "", parallel: false },
  ];
  const created = saveTemplate("my team's flow", steps);
  assert.equal(created.label, "my team's flow");
  const loaded = loadUserTemplates();
  assert.equal(loaded.length, 1);
  assert.equal(at(loaded, 0).label, "my team's flow");
  assert.deepEqual(at(loaded, 0).steps, steps);
});

test("saveTemplate falls back to a default label when the input is blank", () => {
  resetStore();
  const created = saveTemplate("   ", [{ name: "", command: "echo hi", cwd: "", parallel: false }]);
  assert.ok(created.label.length > 0);
  assert.equal(loadUserTemplates().length, 1);
});

test("saveTemplate caps the label length", () => {
  resetStore();
  const long = "a".repeat(200);
  const created = saveTemplate(long, [{ name: "", command: "x", cwd: "", parallel: false }]);
  assert.equal(created.label.length, 60);
});

test("deleteTemplate removes only the named template", () => {
  resetStore();
  const a = saveTemplate("a", [{ name: "", command: "a", cwd: "", parallel: false }]);
  const b = saveTemplate("b", [{ name: "", command: "b", cwd: "", parallel: false }]);
  assert.equal(deleteTemplate(a.id), true);
  const loaded = loadUserTemplates();
  assert.equal(loaded.length, 1);
  assert.equal(at(loaded, 0).id, b.id);
});

test("deleteTemplate returns false for an unknown id", () => {
  resetStore();
  assert.equal(deleteTemplate("nope"), false);
});

test("loadUserTemplates drops malformed entries", () => {
  resetStore();
  localStorage.setItem(
    KEY,
    JSON.stringify([
      { id: "ok", label: "ok", steps: [{ name: "n", command: "c", cwd: "", parallel: false }] },
      { id: "no-steps", label: "x", steps: [] },
      { id: "no-command", label: "x", steps: [{ name: "n" }] },
      "not-an-object",
      null,
      { label: "no-id", steps: [{ name: "n", command: "c", cwd: "", parallel: false }] },
    ]),
  );
  const loaded = loadUserTemplates();
  assert.equal(loaded.length, 1);
  assert.equal(at(loaded, 0).id, "ok");
});

test("loadUserTemplates tolerates corrupt JSON", () => {
  resetStore();
  localStorage.setItem(KEY, "{not json");
  assert.deepEqual(loadUserTemplates(), []);
});

test("saveTemplate generates unique ids", () => {
  resetStore();
  const a = saveTemplate("a", [{ name: "", command: "a", cwd: "", parallel: false }]);
  const b = saveTemplate("b", [{ name: "", command: "b", cwd: "", parallel: false }]);
  assert.notEqual(a.id, b.id);
});
