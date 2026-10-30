import { test } from "node:test";
import assert from "node:assert/strict";

import {
  csvSafe,
  licenseCsv,
  licenseTone,
  summarizeLicenses,
  type LicenseRow,
} from "../src/lib/license-overview";

function row(partial: Partial<LicenseRow>): LicenseRow {
  return {
    slug: "o/r",
    license: null,
    source: "none",
    file: null,
    confidence: "missing",
    error: null,
    ...partial,
  };
}

test("the summary keeps missing, unknown, detected and declared apart", () => {
  const s = summarizeLicenses([
    row({ license: "MIT", source: "license-file", confidence: "detected" }),
    row({ license: "MIT", source: "Cargo.toml", confidence: "declared" }),
    row({ license: "Apache-2.0", source: "license-file", confidence: "detected" }),
    row({ license: null, source: "license-file", confidence: "unknown", file: "LICENSE" }),
    row({ confidence: "missing" }),
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.known, 3);
  assert.equal(s.detected, 2);
  assert.equal(s.declared, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.missing, 1);
  assert.deepEqual(s.byLicense, [
    ["MIT", 2],
    ["Apache-2.0", 1],
  ]);
});

test("an unknown file is not counted as known just because it has a name", () => {
  const s = summarizeLicenses([
    row({ source: "license-file", file: "LICENSE", confidence: "unknown" }),
  ]);
  assert.equal(s.known, 0);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.byLicense, []);
});

test("tones: missing is warn, unknown is muted, known is ok", () => {
  assert.equal(licenseTone(row({ confidence: "missing" })), "warn");
  assert.equal(licenseTone(row({ confidence: "unknown", source: "license-file" })), "muted");
  assert.equal(licenseTone(row({ license: "MIT", confidence: "declared" })), "ok");
});

test("csv fields are quoted and formulas are neutralised", () => {
  assert.equal(csvSafe("plain"), '"plain"');
  assert.equal(csvSafe('a "quote"'), '"a ""quote"""');
  assert.equal(csvSafe("=1+1"), `"'=1+1"`);
  assert.equal(csvSafe("+42"), `"'+42"`);
  assert.equal(csvSafe("@cmd"), `"'@cmd"`);
  assert.equal(csvSafe("-2"), `"'-2"`);
});

test("the csv has a header followed by one row per repository", () => {
  const csv = licenseCsv([
    row({ slug: "o/r", license: "MIT", source: "license-file", file: "LICENSE", confidence: "detected" }),
    row({ slug: "o/missing", confidence: "missing" }),
  ]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"slug","license","source","file","confidence","error"');
  assert.match(lines[1] ?? "", /"MIT"/);
  assert.match(lines[2] ?? "", /"missing"/);
});
