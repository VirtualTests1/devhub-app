/**
 * `src/types.ts` — the label tables every view renders.
 *
 * `formatBytes` is tested here too but imported from its real home,
 * `src/lib/format.ts`: `types.ts` only re-exported it (round-11), which is how the
 * app ended up with two import paths for one formatter — `RepoTile` / `CleanupSection`
 * on one side and `ProjectsView` on the other. The re-export survives only while
 * `ProjectsView` (another work stream's file) still reads it, and the identity
 * assertion below is what proves it is a pass-through rather than a copy.
 *
 * These are characterization tests: they pin down what the code does *today*,
 * including in the corners where today's answer is questionable, so a later
 * change is a deliberate edit of this file rather than an unnoticed drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_TAG_LABEL,
  CATEGORY_LABEL,
  KIND_LABEL,
  LAYER_LABEL,
} from "../src/types.ts";
import { formatBytes } from "../src/lib/format.ts";
import { formatBytes as formatBytesViaTypes } from "../src/types.ts";

test("types.ts re-exports lib/format's function, not a second copy", () => {
  assert.equal(formatBytesViaTypes, formatBytes);
});

test("formatBytes: byte tier", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(999), "999 B");
  // 1000 is still rendered as bytes even though it is a "kilobyte" to a HDD
  // vendor: the threshold here is 1024, not 1000. Pinned because 清理 reports
  // freed space, and a 999 B / 1000 B pair that reads as two different units
  // would be the bug.
  assert.equal(formatBytes(1000), "1000 B");
  assert.equal(formatBytes(1023), "1023 B");
});

test("formatBytes: KB tier rounds to one decimal and divides by 1024", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  // 1025/1024 = 1.00097 → "1.0 KB": a card may show 1.0 KB for something a
  // hair over a kilobyte. Correct given the formula, surprising on screen.
  assert.equal(formatBytes(1025), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KB");
});

test("formatBytes: MB tier", () => {
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 100), "100.0 MB");
  // The top of the MB tier still says "1024.0 MB" rather than promoting to
  // "1.00 GB", because the tier test is `< 1024*1024*1024` on the raw count.
  assert.equal(formatBytes(1024 * 1024 * 1024 - 1), "1024.0 MB");
});

test("formatBytes: GB tier is the only two-decimal tier", () => {
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
  assert.equal(formatBytes(1024 * 1024 * 1024 * 1.5), "1.50 GB");
});

test("formatBytes: every negative value lands in the byte tier", () => {
  // `n < 1024` is true for all negatives, so a negative size never gets a unit
  // no matter how large its magnitude: -1048576 renders as "-1048576 B", a
  // seven-digit number on a card. Nothing clamps the sign — this test is the
  // note, and the reason `freedBytes` on the Rust side has to stay non-negative.
  assert.equal(formatBytes(-1), "-1 B");
  assert.equal(formatBytes(-1024), "-1024 B");
  assert.equal(formatBytes(-1024 * 1024), "-1048576 B");
});

test("formatBytes: non-finite input falls through every tier to GB", () => {
  // `NaN < 1024` is false, so the guards cascade to the last branch rather than
  // short-circuiting. The result is a *unit* attached to a non-number, which is
  // the shape of the "0 B" vs "—" confusion the tile labels had. Asserting it
  // here so the next person sees the choice instead of rediscovering it.
  assert.equal(formatBytes(Number.NaN), "NaN GB");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "Infinity GB");
});

test("LAYER_LABEL covers every DownloadLayer id", () => {
  // A missing key would render `undefined` in 下载进度. The id list is duplicated
  // here on purpose: if the union in types.ts grows, this test is the thing that
  // fails, in the frontend, rather than a blank chip on screen.
  const layers = ["direct", "ipPinned", "localProxy", "mirror", "bundle"];
  assert.deepEqual(Object.keys(LAYER_LABEL).sort(), [...layers].sort());
  for (const value of Object.values(LAYER_LABEL)) {
    assert.ok(value.length > 0, "no layer may have an empty label");
  }
});

test("KIND_LABEL covers every LaunchKind id", () => {
  assert.deepEqual(Object.keys(KIND_LABEL).sort(), ["build", "installThenRun", "run", "serve"].sort());
});

test("CATEGORY_LABEL always answers, including the unknown bucket", () => {
  assert.equal(CATEGORY_LABEL["unknown"], "未识别");
  // 未识别 is the fallback the tile reads when the marker walk found nothing, so
  // deleting it turns a label into a hole in the card.
  for (const id of ["rust", "go", "python", "java", "dotnet", "ruby", "php", "dart", "node", "static"]) {
    assert.ok(CATEGORY_LABEL[id], `category ${id} must have a Chinese label`);
  }
});

test("ACTIVITY_TAG_LABEL covers the tags the backend writes", () => {
  for (const tag of ["download", "delete", "clear", "launch", "terminal", "ide", "settings", "appearance", "interface"]) {
    assert.ok(ACTIVITY_TAG_LABEL[tag], `记录 would show a raw tag id for ${tag}`);
  }
});
