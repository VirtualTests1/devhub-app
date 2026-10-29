#!/usr/bin/env node
/**
 * Release directory → deterministic file manifest + SHA-256 checksums.
 *
 * WHY THIS EXISTS
 *   The project currently publishes source-only releases, but the moment a
 *   portable ZIP or installer is attached, "here is the file" is not enough:
 *   the user needs a hash they can verify, and CI needs a way to prove the
 *   bytes it uploaded are the bytes it built. This script is deliberately
 *   dependency-free and deterministic so it can run before signing, after
 *   signing, or in a dry run on a fixture.
 *
 * WHAT IT DOES
 *   - walks a directory without following symlinks/junctions;
 *   - hashes every regular file (SHA-256) and records its size;
 *   - writes `release-manifest.json` and `SHA256SUMS` (GNU format);
 *   - `--check` re-hashes and fails if any listed file is missing/changed or
 *     if an unlisted regular file is present.
 *
 * It does not sign, upload, or claim SmartScreen reputation. See
 * `docs/research/code-signing.md`.
 *
 * USAGE
 *   node scripts/release-manifest.mjs <dir> [--out <dir>] [--check]
 *   node scripts/release-manifest.mjs <dir> --help
 *
 * Exit codes: 0 ok, 1 verification failure, 2 usage error.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST_NAME = "release-manifest.json";
export const CHECKSUMS_NAME = "SHA256SUMS";
const GENERATED = new Set([MANIFEST_NAME, CHECKSUMS_NAME]);

function slash(path) {
  return path.split(sep).join("/");
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/** Every regular file under `dir`, relative POSIX path → absolute path. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile() && !GENERATED.has(childRel)) out.push({ rel: childRel, abs: childAbs });
    }
  };
  walk(dir, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Build the manifest object (does not write). */
export function buildManifest(dir, appVersion = "0.0.0") {
  const files = listFiles(dir).map(({ rel, abs }) => ({
    path: slash(rel),
    size: statSync(abs).size,
    sha256: sha256File(abs),
  }));
  return { format: "devhub-release-manifest", version: 1, appVersion, files };
}

export function checksumsText(manifest) {
  return manifest.files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + (manifest.files.length ? "\n" : "");
}

/** Write both artifacts into `outDir` (default: the release dir). */
export function writeManifest(dir, outDir = dir, appVersion = "0.0.0") {
  const manifest = buildManifest(dir, appVersion);
  const target = resolve(outDir);
  writeFileSync(join(target, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(target, CHECKSUMS_NAME), checksumsText(manifest));
  return manifest;
}

/** Re-hash and compare; returns a list of human-readable problems. */
export function checkManifest(dir) {
  const path = join(dir, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [`cannot read ${MANIFEST_NAME}: ${e.message}`];
  }
  if (manifest?.format !== "devhub-release-manifest" || !Array.isArray(manifest.files)) {
    return [`${MANIFEST_NAME} has an unexpected shape`];
  }
  const problems = [];
  const expected = new Map();
  for (const row of manifest.files) {
    if (typeof row?.path !== "string" || typeof row?.sha256 !== "string") {
      problems.push("manifest contains a malformed row");
      continue;
    }
    if (expected.has(row.path)) problems.push(`duplicate manifest path: ${row.path}`);
    expected.set(row.path, row);
  }
  for (const [rel, row] of expected) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) {
      problems.push(`missing: ${rel}`);
      continue;
    }
    const got = sha256File(abs);
    if (got !== row.sha256) problems.push(`hash mismatch: ${rel}`);
    const size = statSync(abs).size;
    if (typeof row.size === "number" && row.size !== size) problems.push(`size mismatch: ${rel}`);
  }
  for (const { rel } of listFiles(dir)) {
    if (!expected.has(slash(rel))) problems.push(`unlisted file: ${slash(rel)}`);
  }
  return problems;
}

function usage(stream) {
  stream.write(
    "usage: node scripts/release-manifest.mjs <dir> [--out <dir>] [--check]\n" +
      "  <dir>       release directory to hash\n" +
      "  --out <dir> where to write release-manifest.json / SHA256SUMS (default: <dir>)\n" +
      "  --check     verify the existing manifest against the directory\n" +
      "exit 2 is a usage error; exit 1 is a verification failure\n",
  );
}

function appVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(argv) {
  let dir = null;
  let out = null;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage(process.stdout);
      return 0;
    }
    if (arg === "--check") {
      check = true;
    } else if (arg === "--out") {
      out = argv[i + 1];
      i += 1;
      if (!out) {
        process.stderr.write("--out needs a directory\n");
        usage(process.stderr);
        return 2;
      }
    } else if (!arg.startsWith("--") && dir === null) {
      dir = arg;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      usage(process.stderr);
      return 2;
    }
  }
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write("release-manifest: <dir> must be an existing directory\n");
    usage(process.stderr);
    return 2;
  }
  const root = resolve(dir);
  if (check) {
    const problems = checkManifest(root);
    if (problems.length) {
      process.stderr.write(`${MANIFEST_NAME} check FAILED:\n`);
      for (const p of problems.slice(0, 50)) process.stderr.write(`  - ${p}\n`);
      if (problems.length > 50) process.stderr.write(`  … ${problems.length - 50} more\n`);
      return 1;
    }
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_NAME), "utf8"));
    process.stdout.write(`OK: ${manifest.files.length} file(s) match ${MANIFEST_NAME}\n`);
    return 0;
  }
  const manifest = writeManifest(root, out ? resolve(out) : root, appVersion());
  process.stdout.write(`wrote ${manifest.files.length} file(s) into ${out ?? root}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}