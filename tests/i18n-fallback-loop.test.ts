/**
 * H1 — EN fallback loop test: the `resolveKey` chain
 *   `requested locale → zh-CN (default) → the key itself`
 *
 * The whole point of the fallback chain is that an `en` gap shows the
 * zh-CN value, not a raw key string. But there is a subtle failure mode
 * that no key-set guard can catch:
 *
 *   If a dictionary entry's **zh value** is the key name itself
 *   (a typo in the dictionary, e.g. `"wall.sort.forks": "wall.sort.forks"`),
 *   the fallback chain returns the key, and the user sees the raw key
 *   string on screen. This is the "键名被当值" loop.
 *
 * This test drives `resolveKey` / `tFor` through every registered key in
 * both locales and asserts:
 *   1. No zh-CN value equals its own key name (typo'd dictionary entry).
 *   2. For every key present in zh but absent in en, `tFor("en", key)`
 *      returns the zh value, not the key string.
 *   3. `interpolate` fills repeated placeholders (the replaceAll case).
 *   4. No zh value is a placeholder-shaped copy of its own key name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveKey,
  interpolate,
  tFor,
  DICTIONARIES,
} from "../src/lib/i18n";

/** Derive the full key set from the zh-CN dictionary. */
const ZH_KEYS: readonly string[] = Object.keys(DICTIONARIES["zh-CN"]);

test("H1: no zh-CN dictionary value equals its own key name", () => {
  // The real regression: a zh-CN dictionary entry whose value is the key
  // name. `tFor` would return that key string to the UI.
  const selfResolving: string[] = [];
  for (const key of ZH_KEYS) {
    const v = DICTIONARIES["zh-CN"][key];
    if (v === key) {
      selfResolving.push(key);
    }
  }
  assert.deepEqual(
    selfResolving,
    [],
    `zh-CN keys that equal their own name: ${selfResolving.join(", ")}`,
  );
});

test("H1: tFor('en', key) falls back to zh-CN when en lacks the key", () => {
  // For every key, if the en table does not have it, tFor("en", key) must
  // equal tFor("zh-CN", key) — not the key itself.
  const gaps: string[] = [];
  for (const key of ZH_KEYS) {
    const enVal = DICTIONARIES["en"][key];
    const zhVal = DICTIONARIES["zh-CN"][key];
    // en gap: the en table has no entry (or has the same value as zh, which
    // means the fallback is a no-op).
    if (enVal === undefined && zhVal !== key) {
      const resolved = tFor("en", key as Parameters<typeof tFor>[1]);
      if (resolved === key) {
        gaps.push(key);
      }
    }
  }
  assert.deepEqual(
    gaps,
    [],
    `en gaps that fall through to the key string: ${gaps.join(", ")}`,
  );
});

test("H1: interpolate fills repeated placeholders (the replaceAll-equivalent)", () => {
  // A template with `{n}` twice must fill both occurrences.
  const out = interpolate("共 {n} 个，第 {n} 页", { n: "42" });
  assert.equal(out, "共 42 个，第 42 页");
});

test("H1: interpolate with a missing var leaves the placeholder literal", () => {
  // A `{target}` with no matching var stays `{target}` on screen — a visible
  // hole names the bug.
  const out = interpolate("改 {target} 为 {value}", { value: "x" });
  assert.equal(out, "改 {target} 为 x");
});

test("H1: no key's zh value is a placeholder-shaped copy of the key name", () => {
  // The subtlest case: a zh value like `"{wall.sort.forks}"` (the key inside
  // braces) would pass test 1 but make `interpolate` return the key name
  // when the caller supplies a matching var.
  const placeholderKeys: string[] = [];
  for (const key of ZH_KEYS) {
    const v = DICTIONARIES["zh-CN"][key];
    if (v === `{${key}}`) {
      placeholderKeys.push(key);
    }
  }
  assert.deepEqual(
    placeholderKeys,
    [],
    `keys whose zh value is a placeholder-shaped copy of the key: ${placeholderKeys.join(", ")}`,
  );
});

test("H1: resolveKey returns the key string only when both dicts lack it", () => {
  // With empty dicts the result is always the key itself. With the real
  // dicts, a key present in zh but not en must return the zh value.
  const empty: Record<string, Record<string, string>> = {};
  assert.equal(resolveKey(empty, "en", "some.key"), "some.key");

  // Real dicts: a key that exists in zh must not return the key string
  // from the en locale (unless en explicitly has the same value).
  const sampleKey = ZH_KEYS[0]!;
  const resolved = resolveKey(
    DICTIONARIES as unknown as Record<string, Record<string, string>>,
    "en",
    sampleKey,
  );
  const zhVal = DICTIONARIES["zh-CN"][sampleKey]!;
  assert.notEqual(
    resolved,
    sampleKey,
    `resolveKey("en", "${sampleKey}") returned the key string; zh value is ${JSON.stringify(zhVal)}`,
  );
});
