// check-build-env.mjs — the sccache wrapper must be opt-in, never a tracked path
// to a machine-local (gitignored) binary.
//
// Why this exists (r23-O1): `src-tauri/.cargo/config.toml` used to pin
// `rustc-wrapper = "../vendor/sccache/bin/sccache.exe"`. `vendor/sccache/` is
// gitignored and was empty on this machine, so every fresh clone and every linked
// worktree died before compiling:
//   error: could not execute process ".../vendor/sccache/bin/sccache.exe ... -vV"
// Clearing RUSTC_WRAPPER did not help: cargo treats an empty value as absent and
// still honours the config file.
//
// The fix is structural: the config no longer names the wrapper; `env.ps1` sets
// RUSTC_WRAPPER only when the vendored binary actually exists. This checker keeps
// a future edit from re-introducing the broken shape.
//
// Usage: node scripts/check-build-env.mjs
// Exit 0 = consistent, 1 = a tracked wrapper or a missing opt-in, 2 = usage.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
for (const arg of process.argv.slice(2)) {
  console.error(`check-build-env.mjs: unrecognised argument '${arg}' (no arguments are accepted)`);
  process.exit(2);
}

const failures = [];
const info = [];

const cargoConfig = readFileSync(join(ROOT, "src-tauri", ".cargo", "config.toml"), "utf8");
const wrapperLine = cargoConfig
  .split(/\r?\n/)
  .find((line) => /^\s*rustc-wrapper\s*=/.test(line) && !/^\s*#/.test(line));
if (wrapperLine) {
  failures.push(
    `src-tauri/.cargo/config.toml pins a rustc-wrapper (${wrapperLine.trim()}); ` +
      "vendor/sccache is gitignored, so a fresh clone/worktree cannot compile. " +
      "Set RUSTC_WRAPPER from env.ps1 only when the binary exists instead.",
  );
}

const env = readFileSync(join(ROOT, "env.ps1"), "utf8");
for (const required of ["RUSTC_WRAPPER", "vendor/sccache/bin/sccache.exe", "sccache      : disabled"]) {
  if (!env.includes(required)) failures.push(`env.ps1 no longer contains '${required}' — the opt-in path is gone`);
}

const testRust = readFileSync(join(ROOT, "scripts", "test-rust.ps1"), "utf8");
if (!testRust.includes("env.ps1")) {
  failures.push("scripts/test-rust.ps1 no longer dot-sources env.ps1; cargo may run without MSVC or the wrapper decision");
}

const localBin = join(ROOT, "vendor", "sccache", "bin", "sccache.exe");
if (existsSync(localBin)) {
  info.push("vendor/sccache/bin/sccache.exe present — env.ps1 enables the wrapper");
} else {
  info.push("vendor/sccache/bin/sccache.exe absent — env.ps1 must leave cargo unwrapped");
}

for (const line of info) console.log(`INFO ${line}`);
if (failures.length) {
  console.log("BUILD-ENV CHECK FAILED");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("OK: the sccache wrapper is opt-in; no tracked path can break a fresh clone.");
