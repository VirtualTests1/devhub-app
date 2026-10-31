/**
 * Subprocess-boundary regression guard.
 *
 * The 2026-10-31 audit found small "ask a tool a question" probes that used a
 * bare `Command::output()`: `git rev-parse`, `docker info`, `reg add`. A locked
 * repository, a starting Docker Desktop or a wedged registry call could park a
 * command for as long as the tool felt like. `proc::output_timeout` exists; this
 * test is what keeps a future probe from quietly bypassing it.
 *
 * The allowlist is for files whose `.output()` is a curl invocation with
 * `--max-time` (curl enforces the deadline itself) or a test-only fixture. Every
 * entry needs a reason and must still contain an `.output()` — a stale
 * allowlist is a blind spot pretending to be a decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src-tauri", "src");
const read = (name: string) => readFileSync(join(SRC, name), "utf8");

const BARE_OUTPUT_ALLOW = new Map<string, string>([
  ["downloader.rs", "curl carries --max-time; the git probes are pinned below; remaining calls are test fixtures"],
  ["gitboot.rs", "curl carries --max-time; the 7z probe is covered by the downloader's own cancellation"],
  ["heat.rs", "curl carries --max-time"],
  ["ogimage.rs", "curl carries --max-time; the other call is a test fixture"],
  ["preview.rs", "curl carries --max-time"],
  ["releases.rs", "curl carries --max-time"],
  ["search.rs", "curl carries --max-time"],
  ["lib.rs", "headless diagnostics use output_timeout; tasklist/taskkill are short-lived and test-only"],
]);

function topLevelBody(source: string, name: string): string {
  const marker = `fn ${name}(`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `function ${name} not found`);
  const start = source.lastIndexOf("\n", at) + 1;
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `function ${name} has no top-level closing brace`);
  return source.slice(start, end);
}

test("docker and commits no longer call a process without a deadline", () => {
  for (const file of ["docker.rs", "commits.rs"]) {
    const src = read(file);
    assert.doesNotMatch(src, /Command::new\s*\(/, `${file} must use proc::silent`);
    assert.doesNotMatch(src, /\.output\s*\(\s*\)/, `${file} must use proc::output_timeout`);
  }
});

test("the downloader's four small git probes use output_timeout", () => {
  const src = read("downloader.rs");
  for (const fn of ["local_head", "count_commits", "remote_origin_url", "scrub_origin_credentials"]) {
    assert.match(
      topLevelBody(src, fn),
      /output_timeout/,
      `${fn} is a probe; a bare .output() can hang a freshness batch or the startup scrub`,
    );
  }
});

test("every other bare .output() is on the reasoned allowlist", () => {
  const offenders = readdirSync(SRC)
    .filter((name) => name.endsWith(".rs"))
    .filter((name) => {
      const src = read(name);
      return /\.output\s*\(\s*\)/.test(src) && !/output_timeout/.test(src) && !BARE_OUTPUT_ALLOW.has(name);
    });
  assert.deepEqual(
    offenders,
    [],
    "new file with a bare .output(): use proc::output_timeout, or add a reasoned allowlist entry",
  );
});

test("the allowlist has no stale entries and every reason is real", () => {
  for (const [name, reason] of BARE_OUTPUT_ALLOW) {
    assert.ok(reason.trim().length > 20, `${name}: reason must say why this file is exempt`);
    assert.match(read(name), /\.output\s*\(\s*\)/, `${name}: allowlist entry is stale (no .output() left)`);
  }
});
