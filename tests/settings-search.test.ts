import { test } from "node:test";
import assert from "node:assert/strict";
import { searchSettings, type SettingsSearchEntry } from "../src/lib/settings-search.ts";

const ENTRIES: SettingsSearchEntry[] = [
  { id: "roots", label: "项目与目录", keywords: ["path", "folder"] },
  { id: "projects", label: "项目页", keywords: ["wall", "cover"] },
  { id: "network", label: "网络", keywords: ["代理", "proxy", "mirror"] },
  { id: "editors", label: "编辑器", keywords: ["terminal", "ide"] },
];

test("settings search: an empty query matches nothing", () => {
  assert.deepEqual(searchSettings(ENTRIES, ""), []);
  assert.deepEqual(searchSettings(ENTRIES, "   "), []);
});

test("settings search: exact label beats prefix, prefix beats substring", () => {
  assert.deepEqual(searchSettings(ENTRIES, "网络"), [{ id: "network", score: 2 }]);
  assert.deepEqual(searchSettings(ENTRIES, "项目"), [
    { id: "roots", score: 1000 },
    { id: "projects", score: 1001 },
  ]);
});

test("settings search: id is searchable in either language", () => {
  assert.deepEqual(searchSettings(ENTRIES, "edi"), [{ id: "editors", score: 3003 }]);
  assert.deepEqual(searchSettings(ENTRIES, "PROXY"), [{ id: "network", score: 4002 }]);
});

test("settings search: aliases cover the words people actually type", () => {
  assert.deepEqual(searchSettings(ENTRIES, "代理"), [{ id: "network", score: 4002 }]);
  assert.deepEqual(searchSettings(ENTRIES, "folder"), [{ id: "roots", score: 4000 }]);
});

test("settings search: equal matches keep catalog order", () => {
  const entries = [
    { id: "b", label: "设置" },
    { id: "a", label: "设置" },
  ];
  assert.deepEqual(
    searchSettings(entries, "设置").map((h) => h.id),
    ["b", "a"],
  );
});
