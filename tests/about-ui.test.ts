/**
 * 设置 → 关于 的接线（r28-N1）。
 *
 * The network and the opener need a GUI; this file pins the shape that can be
 * checked in Node: the two IPC calls, the release link going through the
 * allowlist, and the catalog/i18n entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { tFor } from "../src/lib/i18n.ts";

const ABOUT = readFileSync("src/views/settings/AboutSection.tsx", "utf8");
const SETTINGS = readFileSync("src/views/SettingsView.tsx", "utf8");
const CATALOG = readFileSync("src/settingsCatalog.tsx", "utf8");

test("AboutSection: version read + release check + allowlisted link", () => {
  assert.match(ABOUT, /invoke<string>\("app_version"\)/);
  assert.match(ABOUT, /invoke<AppUpdate>\("check_app_update", \{ force \}\)/);
  assert.match(ABOUT, /openHttpUrl\(update\.url\)/);
  assert.match(ABOUT, /disabled=\{checking\}/);
  assert.match(ABOUT, /t\("about\.failed", \{ msg: error \}\)/);
});

test("AboutSection: cached answers are dated and can be force-refreshed", () => {
  assert.match(ABOUT, /update\?\.fromCache/);
  assert.match(ABOUT, /void check\(true\)/);
  assert.match(ABOUT, /t\("about\.checkedAt", \{ time: checkedAt \}\)/);
  assert.equal(tFor("zh-CN", "about.forceCheck"), "强制刷新");
  assert.equal(tFor("en", "about.cached"), "Cached for 10 minutes");
});

test("catalog and settings render the about section", () => {
  assert.match(CATALOG, /id: "about", label: "关于"/);
  assert.match(SETTINGS, /activeSection === "about" && <AboutSection \/>/);
  assert.equal(tFor("zh-CN", "settings.section.about"), "关于");
  assert.equal(tFor("en", "settings.section.about"), "About");
  assert.equal(tFor("zh-CN", "about.check"), "检查更新");
  assert.equal(tFor("en", "about.check"), "Check for updates");
});
