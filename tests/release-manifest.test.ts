/**
 * Release manifest and checksum tool (r31-R2).
 *
 * The tool must be deterministic, must not follow links, and must fail loudly
 * when a listed byte changes or an unlisted file appears. The fixture is a
 * fresh temp directory; no release artifact is produced here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CHECKSUMS_NAME,
  MANIFEST_NAME,
  buildManifest,
  checkManifest,
  writeManifest,
} from "../scripts/release-manifest.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "devhub-release-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "app.exe"), "binary-one");
  writeFileSync(join(dir, "nested", "readme.txt"), "hello");
  return dir;
}

test("manifest: deterministic, sorted and includes sizes/hashes", () => {
  const dir = fixture();
  try {
    const a = buildManifest(dir, "9.9.9");
    const b = buildManifest(dir, "9.9.9");
    assert.deepEqual(a, b);
    assert.equal(a.appVersion, "9.9.9");
    assert.deepEqual(a.files.map((f) => f.path), ["app.exe", "nested/readme.txt"]);
    assert.equal(a.files[0]?.size, 10);
    assert.match(a.files[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest: write produces GNU checksums and check accepts it", () => {
  const dir = fixture();
  try {
    writeManifest(dir, dir, "1.0.0");
    const sums = readFileSync(join(dir, CHECKSUMS_NAME), "utf8");
    assert.match(sums, /^[a-f0-9]{64}  app\.exe\n/);
    assert.equal(checkManifest(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest: a changed byte, a deleted file and an unlisted file are failures", () => {
  const dir = fixture();
  try {
    writeManifest(dir, dir, "1.0.0");
    writeFileSync(join(dir, "app.exe"), "binary-two");
    assert.ok(checkManifest(dir).some((p) => p.includes("hash mismatch: app.exe")));

    writeFileSync(join(dir, "app.exe"), "binary-one");
    rmSync(join(dir, "nested", "readme.txt"));
    assert.ok(checkManifest(dir).some((p) => p.includes("missing: nested/readme.txt")));
    writeFileSync(join(dir, "nested", "readme.txt"), "hello");

    writeFileSync(join(dir, "extra.bin"), "extra");
    assert.ok(checkManifest(dir).some((p) => p.includes("unlisted file: extra.bin")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest: links are not hashed and cannot make the check recurse", () => {
  const dir = fixture();
  try {
    writeManifest(dir, dir, "1.0.0");
    try {
      symlinkSync(join(dir, "nested"), join(dir, "linked"), "dir");
    } catch {
      return; // symlink creation is privileged on some Windows configurations
    }
    assert.deepEqual(buildManifest(dir, "1.0.0").files.map((f) => f.path), ["app.exe", "nested/readme.txt"]);
    assert.equal(checkManifest(dir).length, 0, "the generated manifest still describes the real files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest: malformed or absent manifest is a readable problem, not a throw", () => {
  const dir = fixture();
  try {
    assert.ok(checkManifest(dir).some((p) => p.includes(`cannot read ${MANIFEST_NAME}`)));
    writeFileSync(join(dir, MANIFEST_NAME), "{not json");
    assert.ok(checkManifest(dir).some((p) => p.includes(`cannot read ${MANIFEST_NAME}`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});