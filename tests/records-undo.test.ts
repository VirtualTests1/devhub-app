/**
 * The two undo-path helpers in `src/views/records/undo.ts`.
 *
 * `settingsPayload` is the 记录 page's `save_settings` shape — the shared
 * required-and-replaced base plus the two fields this page owns — and
 * `applyUiValue` is the allowlist that turns a stored `undoKey`/`undoValue`
 * pair back into a store write. The old `applyUiValue` handed parsed JSON
 * straight to the store with `as never`; the throws pinned below are the
 * contract that replaced it, so a regression reads as a red test rather than
 * as arbitrary-field writes from a hand-edited record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { installBrowserGlobals } from "./helpers/storage.ts";
import { applyUiValue, settingsPayload } from "../src/views/records/undo.ts";
import { useAppearance } from "../src/store/appearance.ts";
import type { SettingsView } from "../src/types.ts";

installBrowserGlobals();

const full: SettingsView = {
  projectRoot: "D:/repos",
  projectRootIsDefault: false,
  mirrorEnabled: true,
  ipPinEnabled: false,
  mirrors: ["https://a"],
  effectiveMirrors: ["https://a"],
  proxy: "http://p",
  configPath: "C:/cfg.json",
  configSource: "file",
  configError: null,
  configBackupPath: "C:/cfg.json.bak",
  hasGithubToken: true,
  tokenUnreadable: false,
  extraRoots: ["D:/x"],
  terminalChoice: "",
  ideChoice: "",
  customIdes: [],
  activityRetentionDays: 30,
  searchRoute: "useHosts",
  downloadRoute: "bypass",
  cloneStrategy: "",
  searchDebounceMs: 700,
  parallelDownloads: 3,
  cleanupMode: "weekly",
  cleanupKeepDays: 7,
  recentRoots: [],
  hostsHijacked: false,
  hostsBy: null,
};

// `settingsPayload` spreads a `Record<string, unknown>`, and TypeScript does
// not carry the index signature through an object spread — the inferred return
// type names only extraRoots / activityRetentionDays. The assertion below is
// the payload's real shape, re-widened for the checks.
const payloadOf = (s: SettingsView, patch: Record<string, unknown> = {}): Record<string, unknown> =>
  settingsPayload(s, patch);

test("settingsPayload: shared base, plus the two fields 记录 owns on every save", () => {
  const p = payloadOf(full);
  assert.equal(p.projectRoot, "D:/repos");
  assert.equal(p.mirrorEnabled, true);
  assert.equal(p.ipPinEnabled, false);
  assert.deepEqual(p.mirrors, ["https://a"]);
  assert.equal(p.proxy, "http://p");
  // extraRoots / activityRetentionDays are "set to this" on every 记录 save —
  // absent would mean keep-as-is, which is not this page's contract.
  assert.deepEqual(p.extraRoots, ["D:/x"]);
  assert.equal(p.activityRetentionDays, 30);
  // The token pair is never implicitly touched, same rule as lib/settings-payload.
  assert.equal(p.githubToken, "");
  assert.equal(p.clearGithubToken, false);
});

test("settingsPayload: patch wins — including over the fields this page owns", () => {
  const p = payloadOf(full, { extraRoots: ["D:/y"], activityRetentionDays: 7, clearGithubToken: true });
  assert.deepEqual(p.extraRoots, ["D:/y"], "patch beats the page's own affirmation");
  assert.equal(p.activityRetentionDays, 7);
  assert.equal(p.clearGithubToken, true);
});

test("settingsPayload: optional settings are NOT dragged in from the snapshot", () => {
  // A stale snapshot must never overwrite a newer backend value with a field
  // this save did not mean to change.
  const p = payloadOf(full);
  assert.equal("searchRoute" in p, false);
  assert.equal("parallelDownloads" in p, false);
  assert.equal("cleanupMode" in p, false);
});

test("applyUiValue: refuses everything outside the ui.appearance allowlist", () => {
  assert.throws(() => applyUiValue("config.projectRoot", '"x"'), /未知的界面回退目标/);
  assert.throws(() => applyUiValue("ui.customize.foo", "{}"), /未知的界面存储/);
  assert.throws(() => applyUiValue("ui.appearance.nope", "1"), /未知的界面回退字段/);
});

test("applyUiValue: a value that fails its field validator is refused, not written", () => {
  // gridColumns is intBetween(0, 6); 99 is the hand-edited-blob case.
  assert.throws(() => applyUiValue("ui.appearance.gridColumns", "99"), /旧值与类型不符/);
  assert.throws(() => applyUiValue("ui.appearance.theme", '"blue"'), /旧值与类型不符/);
  // The store never saw either attempt.
  assert.notEqual(useAppearance.getState().theme, "blue");
});

test("applyUiValue: a corrupt blob snapshot is refused before any restore", () => {
  assert.throws(() => applyUiValue("ui.appearance.blob", '"not an object"'), /外观快照不是一个对象/);
  assert.throws(() => applyUiValue("ui.appearance.blob", "[1,2]"), /外观快照不是一个对象/);
});

test("applyUiValue: a valid value round-trips into the appearance store", () => {
  // Plain string (not JSON) exercises the parse-fallback: a string stays a string.
  applyUiValue("ui.appearance.theme", "dark");
  assert.equal(useAppearance.getState().theme, "dark");
  // JSON-encoded value, the form the record actually stores.
  applyUiValue("ui.appearance.gridColumns", "4");
  assert.equal(useAppearance.getState().gridColumns, 4);
});

test("applyUiValue: the blob restores the whole snapshot, unknown keys aside", () => {
  const snapshot = JSON.stringify({ theme: "light", uiFontPx: 18, bogusKey: "ignored" });
  applyUiValue("ui.appearance.blob", snapshot);
  const s = useAppearance.getState();
  assert.equal(s.theme, "light");
  assert.equal(s.uiFontPx, 18);
  // Only recognized keys are copied; a junk field is dropped, not stored.
  assert.equal("bogusKey" in s, false);
});
