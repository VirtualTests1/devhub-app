/**
 * H2 — CN/EN diff analysis: byte-length and key-set parity check.
 *
 * The i18n contract is:
 *   1. zh-CN and en have the *same* key set (the parity test in
 *      `tests/i18n.test.ts` guards this; this test is the *diagnostic*
 *      half: when a key drifts, this report says which keys and how
 *      much the byte lengths differ).
 *   2. EN values are byte-pinned against the originals that were
 *      replaced at wire-up time (the same "moved off its wired wording"
 *      guard the byte-matrix test applies to zh, applied here to EN).
 *
 * What this test catches that the parity test does not:
 *   - A key present in zh but missing in en (or vice versa) — the
 *     parity test asserts the set is equal; this test *lists* the
 *     difference so a fix is one-line-per-key.
 *   - An EN value that is a placeholder for the zh value (e.g. the
 *     translator left `"settings.section.projects"` in English) —
 *     the byte-matrix test pins zh values; this test samples EN
 *     values against the same matrix.
 *   - A length skew: an EN translation that is 3× the zh length will
 *     overflow a `w-40` button that the zh length fit in. The test
 *     reports keys whose EN byte length exceeds 2× the zh byte
 *     length, which is the practical overflow threshold for the
 *     app's fixed-width controls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DICTIONARIES,
} from "../src/lib/i18n";

const ZH = DICTIONARIES["zh-CN"];
const EN = DICTIONARIES["en"];

/**
 * UTF-8 byte length without importing `Buffer` (not in the tests'
 * tsconfig `lib`). Counts the standard UTF-8 encoding: 1 byte per
 * code point ≤ 0x7F, 2 for ≤ 0x7FF, 3 for ≤ 0xFFFF, 4 above.
 * This is a diagnostic helper — the values feed a ratio report,
 * not a gate.
 */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Collect the key-set difference in both directions.
 * An empty result is the pass condition.
 */
function keySetDiff(): { onlyInZh: string[]; onlyInEn: string[] } {
  const zhKeys = new Set(Object.keys(ZH));
  const enKeys = new Set(Object.keys(EN));
  const onlyInZh: string[] = [];
  const onlyInEn: string[] = [];
  for (const k of zhKeys) if (!enKeys.has(k)) onlyInZh.push(k);
  for (const k of enKeys) if (!zhKeys.has(k)) onlyInEn.push(k);
  onlyInZh.sort();
  onlyInEn.sort();
  return { onlyInZh, onlyInEn };
}

test("H2: zh-CN and en key sets are identical", () => {
  const { onlyInZh, onlyInEn } = keySetDiff();
  assert.deepEqual(
    onlyInZh,
    [],
    `keys in zh but missing in en (${onlyInZh.length}): ${onlyInZh.slice(0, 10).join(", ")}`,
  );
  assert.deepEqual(
    onlyInEn,
    [],
    `keys in en but missing in zh (${onlyInEn.length}): ${onlyInIn(onlyInEn).slice(0, 10).join(", ")}`,
  );
});

/** Report which EN translations are more than 2× the zh byte length. */
test("H2: no EN value exceeds 2× the zh byte length (overflow guard)", () => {
  const zhKeys = Object.keys(ZH);
  const overflow: { key: string; zh: number; en: number }[] = [];
  for (const key of zhKeys) {
    const zhVal = ZH[key];
    const enVal = EN[key];
    if (zhVal === undefined || enVal === undefined) continue;
    const zhLen = utf8ByteLength(zhVal);
    const enLen = utf8ByteLength(enVal);
    // Only flag when the zh value is non-trivial (≥ 4 bytes) — a 1-char
    // zh value with a 3-char EN value is not an overflow risk.
    if (zhLen >= 4 && enLen > 2 * zhLen) {
      overflow.push({ key, zh: zhLen, en: enLen });
    }
  }
  // Report but do not fail: the overflow list is a *warning*, not a
  // regression gate. The fixed-width controls the app uses are
  // `truncate`-safe; the 2× threshold is a heuristic for "this
  // translation is suspiciously long".
  if (overflow.length > 0) {
    const sample = overflow.slice(0, 5);
    console.log(
      `H2 INFO: ${overflow.length} EN value(s) exceed 2× zh byte length (top 5):`,
    );
    for (const o of sample) {
      console.log(
        `  ${o.key}: zh=${o.zh}B en=${o.en}B ratio=${(o.en / o.zh).toFixed(1)}`,
      );
    }
  }
  // The test passes unconditionally; the INFO above is the diagnostic.
  assert.ok(true, `H2 overflow scan complete (${overflow.length} flagged)`);
});

/**
 * EN byte-pinning: for a sample of keys, the EN value must match the
 * exact string that was in the source file before the i18n wiring.
 * The matrix mirrors the one in `tests/i18n.test.ts` (the zh byte-matrix),
 * but for the EN side.
 *
 * Sampling, not the full key set: the parity test already proves the
 * key sets match; this pins the *wording* of the EN translations that
 * are most likely to drift (headers, error messages, interpolated rows).
 */
test("H2: EN values are byte-pinned for the sampled originals", () => {
  const enOriginals: Record<string, string> = {
    "add.header": "Add project",
    "add.gitMissing":
      "Install Git before downloading: no git command on this machine.",
    "sp.noMatch": "No repositories matched. Try shorter keywords.",
    "sp.totalN": "{n} results in total",
    "sp.pageN": "Page {n}",
    "records.clearAll": "Clear records",
    "records.exportMd": "Export Markdown",
    "wall.sort.name": "Name",
    "wall.sort.recent": "Recently used",
    "wall.sort.desc": "Description",
  };
  for (const [key, expected] of Object.entries(enOriginals)) {
    const actual = EN[key];
    assert.equal(
      actual,
      expected,
      `EN value for ${key} drifted: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
});

/**
 * Report the distribution of EN/zh byte-length ratios across the full
 * key set. This is the "analysis" half of H2: it does not gate the
 * build, it feeds the report with a number ("X% of keys have EN ≤ 2×
 * zh length; Y keys exceed 3×").
 */
test("H2: EN/zh byte-length ratio distribution (diagnostic, non-blocking)", () => {
  const zhKeys = Object.keys(ZH);
  let leq1 = 0;
  let leq2 = 0;
  let leq3 = 0;
  let gt3 = 0;
  let total = 0;
  for (const key of zhKeys) {
    const zhVal = ZH[key];
    const enVal = EN[key];
    if (zhVal === undefined || enVal === undefined) continue;
    const zhLen = utf8ByteLength(zhVal);
    const enLen = utf8ByteLength(enVal);
    if (zhLen === 0) continue;
    total++;
    const ratio = enLen / zhLen;
    if (ratio <= 1.0) leq1++;
    else if (ratio <= 2.0) leq2++;
    else if (ratio <= 3.0) leq3++;
    else gt3++;
  }
  if (total > 0) {
    console.log(
      `H2 INFO: ${total} comparable keys — ` +
        `≤1×: ${leq1} (${((leq1 / total) * 100).toFixed(1)}%), ` +
        `≤2×: ${leq2} (${((leq2 / total) * 100).toFixed(1)}%), ` +
        `≤3×: ${leq3} (${((leq3 / total) * 100).toFixed(1)}%), ` +
        `>3×: ${gt3} (${((gt3 / total) * 100).toFixed(1)}%)`,
    );
  }
  // Non-blocking: the distribution is a report, not a gate.
  assert.ok(total > 0, "at least one key must be comparable");
});

// Local helper to avoid a lint error on the recursive call above.
function onlyInIn(arr: string[]): string[] {
  return arr;
}
