/**
 * `buildSettingsPayload` in `src/lib/settings-payload.ts` — the shared
 * `save_settings` base.
 *
 * Pins the contract against the backend's `SettingsUpdate` (src-tauri/src/lib.rs):
 * the five required-and-replaced fields are always sent from the snapshot, the
 * token is never implicitly touched, optional fields are left for `patch`
 * (never sent stale), and `patch` wins (including over the token markers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSettingsPayload } from "../src/lib/settings-payload.ts";
import type { SettingsView } from "../src/types.ts";

// Annotated with the parameter's own type rather than left to inference:
// `searchRoute` is the union `"bypass" | "useHosts"` in `SettingsView`, and a bare
// literal in an un-annotated object widens to `string`, which is not assignable —
// so every call below failed to typecheck. The annotation also means a field this
// suite stops sending is a compile error rather than a silent `undefined`.
const full: Partial<SettingsView> = {
  projectRoot: "D:/repos",
  mirrorEnabled: true,
  ipPinEnabled: false,
  mirrors: ["https://a", "https://b"],
  proxy: "http://p",
  extraRoots: ["D:/x"],
  activityRetentionDays: 30,
  searchRoute: "useHosts",
};

test("buildSettingsPayload: sends the five required-and-replaced fields", () => {
  const p = buildSettingsPayload(full);
  assert.equal(p.projectRoot, "D:/repos");
  assert.equal(p.mirrorEnabled, true);
  assert.equal(p.ipPinEnabled, false);
  assert.deepEqual(p.mirrors, ["https://a", "https://b"]);
  assert.equal(p.proxy, "http://p");
});

test("buildSettingsPayload: token is never implicitly touched", () => {
  const p = buildSettingsPayload(full);
  assert.equal(p.githubToken, "");
  assert.equal(p.clearGithubToken, false);
});

test("buildSettingsPayload: optional fields are NOT sent unless patched (keep-as-is)", () => {
  const p = buildSettingsPayload(full);
  // extraRoots / activityRetentionDays / searchRoute are Option on the backend;
  // sending them from a possibly-stale snapshot would clobber a newer value.
  assert.equal("extraRoots" in p, false);
  assert.equal("activityRetentionDays" in p, false);
  assert.equal("searchRoute" in p, false);
});

test("buildSettingsPayload: patch wins, and may override the token markers", () => {
  const p = buildSettingsPayload(full, { activityRetentionDays: 7, clearGithubToken: true });
  assert.equal(p.activityRetentionDays, 7);
  assert.equal(p.clearGithubToken, true);
  // The base token marker still rounds out the pair unless explicitly overridden.
  assert.equal(p.githubToken, "");
});

test("buildSettingsPayload: null snapshot falls back to safe defaults", () => {
  const p = buildSettingsPayload(null);
  assert.equal(p.projectRoot, "");
  assert.equal(p.mirrorEnabled, false);
  assert.equal(p.ipPinEnabled, true);
  assert.deepEqual(p.mirrors, []);
  assert.equal(p.proxy, "");
});
