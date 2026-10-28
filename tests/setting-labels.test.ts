/**
 * The setting-name catalog (round 12, 单一来源 / 命名一致).
 *
 * Pins the three things that were each true more than once before:
 *   1. every config key the backend can actually write as a `config.<key>`
 *      activity target has exactly one name;
 *   2. no catalog key is dead weight;
 *   3. the two surfaces that show a setting's name — 操作记录 and the 常用设置
 *      chips — resolve it through the same function, so they cannot disagree.
 *
 * Provenance for the reachable set: `src-tauri/src/lib.rs`. The literal targets
 * are at :4251 (`config.projectRoot`), :4296 (`config.mirrorEnabled`), :4311
 * (`config.ipPinEnabled`), :4327 (`config.activityRetentionDays`); the generic
 * writer at :317 (`config.{key}`) is called at :4340-4368 with `searchRoute`,
 * `downloadRoute`, `cleanupMode`, `searchDebounceMs`, `parallelDownloads`. The
 * undoable set (`restore_config_value`, :2719-2756) adds `terminalChoice`,
 * `ideChoice`, `cleanupKeepDays` — those reach a row through an undo descriptor
 * rather than a fresh target, so they must be named too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_TARGET_KEYS, CONFIG_TARGET_LABEL, configTargetLabel } from "../src/lib/targetLabel.ts";
import { APPEARANCE_LABEL } from "../src/store/appearance.ts";
import { displayTarget } from "../src/views/records/format.ts";

/** Keys the backend can emit today (see the header for the line numbers). */
const BACKEND_REACHABLE = [
  "projectRoot",
  "mirrorEnabled",
  "ipPinEnabled",
  "activityRetentionDays",
  "searchRoute",
  "downloadRoute",
  "cleanupMode",
  "searchDebounceMs",
  "parallelDownloads",
  "terminalChoice",
  "ideChoice",
  "cleanupKeepDays",
];

/**
 * Keys no current record can carry, kept because the 常用设置 chips read a
 * `setting:<key>` usage blob that an older build may have written — and a chip
 * that shows `config.proxy` is worse than one that says 本地代理.
 */
const LEGACY_CHIP_ONLY = ["extraRoots", "proxy", "githubToken"];

test("every config key the backend can record has a name", () => {
  const missing = BACKEND_REACHABLE.filter((k) => configTargetLabel(k) === null);
  assert.deepEqual(missing, [], "un-named config target would render as a raw key in 记录");
});

test("every catalog key is reachable", () => {
  const unreachable = CONFIG_TARGET_KEYS.filter(
    (k) => !BACKEND_REACHABLE.includes(k) && !LEGACY_CHIP_ONLY.includes(k),
  );
  assert.deepEqual(unreachable, [], "a label nobody can reach is the next drifted table");
});

test("the catalog is complete: it names exactly the reachable keys", () => {
  assert.deepEqual(
    [...CONFIG_TARGET_KEYS].sort(),
    [...BACKEND_REACHABLE, ...LEGACY_CHIP_ONLY].sort(),
    "the catalog and the reachable set are the same list — add a key here when a setting gains a record",
  );
});

test("one key, one name: no two config keys share a label", () => {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const key of CONFIG_TARGET_KEYS) {
    const label = CONFIG_TARGET_LABEL[key];
    assert.ok(label && label.trim() === label, `${key}: label must be non-empty and untrimmed-free`);
    const previous = seen.get(label);
    if (previous) clashes.push(`${label} ← both ${previous} and ${key}`);
    seen.set(label, key);
  }
  assert.deepEqual(clashes, [], "two keys under one word cannot be told apart in a record");
});

test("记录 and 常用 resolve a config name through the same table", () => {
  for (const key of CONFIG_TARGET_KEYS) {
    assert.equal(
      displayTarget(`config.${key}`),
      CONFIG_TARGET_LABEL[key],
      `config.${key}: the two surfaces must print the same words`,
    );
  }
});

test("the appearance half is not a second table", () => {
  // 常用 chips used to carry their own `ui.*` names; the store's exhaustive
  // APPEARANCE_LABEL is the source, and `字号` → `字号档位` on a chip is the
  // visible cost of that — it is also what 设置→外观 calls the row
  // (`AppearanceView.tsx:86`).
  for (const key of Object.keys(APPEARANCE_LABEL)) {
    assert.equal(displayTarget(`ui.${key}`), APPEARANCE_LABEL[key as keyof typeof APPEARANCE_LABEL]);
  }
});

test("ui.font is gone: nothing in the current build can carry it", () => {
  // `store/appearance.ts:247` does `delete merged.font` on every load, and the
  // record writer only emits `ui.${key}` for keys of `Appearance`
  // (`appearance.ts:426`) — `font` is not one, it was migrated to `fontFamily`.
  assert.equal("font" in APPEARANCE_LABEL, false, "the legacy font enum must not have a label");
  assert.equal(displayTarget("ui.font"), "ui.font", "tombstone deleted: an old key prints itself");
  assert.equal(configTargetLabel("font"), null);
});

test("an unknown key still prints itself rather than nothing", () => {
  // A record must always be renderable — this is the degradation the raw-key
  // fallback exists for, not a hole in the catalog.
  assert.equal(displayTarget("config.somethingNew"), "config.somethingNew");
  assert.equal(displayTarget("ui.somethingNew"), "ui.somethingNew");
});
