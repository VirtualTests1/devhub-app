import { test } from "node:test";
import assert from "node:assert/strict";
import { buildXfer, parseXfer, XFER_FIELDS } from "../src/views/settings/settings-xfer";
import type { SettingsView } from "../src/types";

const base: SettingsView = {
  projectRoot: "D:\\projects",
  projectRootIsDefault: false,
  mirrorEnabled: true,
  ipPinEnabled: false,
  mirrors: ["https://mirror.example"],
  effectiveMirrors: ["https://mirror.example"],
  proxy: "http://127.0.0.1:7890",
  configPath: "C:\\cfg\\settings.json",
  configSource: "file",
  configError: null,
  configBackupPath: "C:\\cfg\\settings.json.bak",
  hasGithubToken: true,
  tokenUnreadable: false,
  extraRoots: ["E:\\more"],
  terminalChoice: "wt",
  ideChoice: "code",
  customIdes: ["D:\\ide\\x.exe"],
  activityRetentionDays: 7,
  searchRoute: "useHosts",
  downloadRoute: "bypass",
  cloneStrategy: "",
  searchDebounceMs: 500,
  parallelDownloads: 4,
  cleanupMode: "weekly",
  cleanupKeepDays: 14,
  recentRoots: ["D:\\old"],
  hostsHijacked: true,
  hostsBy: "devhub",
};

test("buildXfer tags the payload and keeps only portable fields", () => {
  const x = buildXfer(base)!;
  assert.equal(x.format, "devhub-settings");
  assert.equal(x.version, 1);
  assert.equal(x.mirrorEnabled, true);
  assert.equal(x.activityRetentionDays, 7);
  // Machine-bound / secret-adjacent facts stay out.
  assert.equal("projectRoot" in x, false);
  assert.equal("configPath" in x, false);
  assert.equal("hasGithubToken" in x, false);
  assert.equal("hostsHijacked" in x, false);
  assert.equal("recentRoots" in x, false);
});

test("buildXfer returns null when settings are not loaded", () => {
  assert.equal(buildXfer(null), null);
});

test("parseXfer accepts a round-trip of buildXfer output", () => {
  const text = JSON.stringify(buildXfer(base));
  const { patch, dropped } = parseXfer(text);
  assert.deepEqual(dropped, []);
  assert.equal(patch.mirrorEnabled, true);
  assert.equal(patch.parallelDownloads, 4);
  assert.deepEqual(patch.mirrors, ["https://mirror.example"]);
  assert.equal("projectRoot" in patch, false);
});

test("parseXfer rejects non-JSON and non-object roots", () => {
  assert.throws(() => parseXfer("{"), /JSON/);
  assert.throws(() => parseXfer("null"), /对象/);
  assert.throws(() => parseXfer("[1]"), /对象/);
});

test("parseXfer rejects a file without the format tag", () => {
  assert.throws(() => parseXfer(JSON.stringify({ version: 1 })), /devhub-settings/);
});

test("parseXfer drops wrong-typed fields instead of forwarding them", () => {
  const text = JSON.stringify({
    format: "devhub-settings",
    version: 1,
    parallelDownloads: "many",
    mirrorEnabled: true,
    mirrors: "not-an-array",
  });
  const { patch, dropped } = parseXfer(text);
  assert.equal(patch.mirrorEnabled, true);
  assert.equal("parallelDownloads" in patch, false);
  assert.equal("mirrors" in patch, false);
  assert.deepEqual(dropped.sort(), ["mirrors", "parallelDownloads"]);
});

test("XFER_FIELDS does not contain secret or machine-bound keys", () => {
  const banned = new Set([
    "projectRoot",
    "projectRootIsDefault",
    "configPath",
    "hasGithubToken",
    "githubToken",
    "hostsHijacked",
    "hostsBy",
    "recentRoots",
  ]);
  for (const k of XFER_FIELDS) {
    assert.equal(banned.has(k), false, `${k} must not be exportable`);
  }
});
