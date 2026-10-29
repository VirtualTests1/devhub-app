/**
 * The command-threading audit, pinned from both sides.
 *
 * The rule (scripts/check-command-threading.mjs): a synchronous Tauri command
 * runs on the window thread; anything that touches the disk, a process table or
 * the registry must run off it. The allowlist is the written exception list, and
 * it is checked for stale entries so a command that was converted cannot keep
 * its old exemption.
 *
 * The repo-wide assertions below are the reason the script exists; the synthetic
 * cases prove the parser actually notices a regression instead of passing
 * because it found nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ALLOWLIST, audit, scanSource } from "../scripts/check-command-threading.mjs";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "target" || name === "gen") continue;
      out.push(...walk(p));
    } else if (name.endsWith(".rs")) {
      out.push(p);
    }
  }
  return out;
}

const sources = walk(join(ROOT, "src-tauri", "src")).map((p) => ({
  file: p.split("\\").join("/"),
  text: readFileSync(p, "utf8"),
}));

test("the repository has no unallowlisted synchronous command", () => {
  const result = audit(sources);
  assert.equal(result.unknownSync.length, 0, JSON.stringify(result.unknownSync, null, 2));
  assert.equal(result.staleAllowlist.length, 0, `stale allowlist: ${result.staleAllowlist.join(", ")}`);
  assert.ok(result.commands.length >= 90, `expected the full command surface, found ${result.commands.length}`);
  assert.equal(result.sync.length, ALLOWLIST.size, "every sync command must carry an allowlist reason");
});

test("commands that touch disk, processes or the registry are off the window thread", () => {
  const byName = new Map(audit(sources).commands.map((c) => [c.name, c]));
  for (const name of [
    "process_states",
    "live_processes",
    "log_activity",
    "repo_grep",
    "docker_status",
    "list_system_fonts",
    "webview2_info",
    "last_crash",
    "clear_crash",
    "register_deeplink",
    "cover_cache_size",
    "clear_cover_cache",
  ]) {
    const cmd = byName.get(name);
    assert.ok(cmd, `${name} is no longer a registered command`);
    assert.equal(cmd.async, true, `${name} must not run on the window thread`);
  }
});

test("scanSource reads plain, command(async) and async fn shapes", () => {
  const text = [
    "#[tauri::command]",
    "fn plain() {}",
    "",
    "#[tauri::command(async)]",
    "pub fn marked() {}",
    "",
    "#[tauri::command]",
    "pub async fn native() {}",
  ].join("\n");
  const got = scanSource("x.rs", text).map((c) => [c.name, c.async]);
  assert.deepEqual(got, [
    ["plain", false],
    ["marked", true],
    ["native", true],
  ]);
});

test("scanSource does not attribute a later fn to a broken attribute block", () => {
  const text = ["#[tauri::command]", "const X: u8 = 1;", "fn unrelated() {}"].join("\n");
  assert.deepEqual(scanSource("x.rs", text), []);
});

test("audit flags an unknown sync command and a stale allowlist entry", () => {
  const result = audit(
    [{ file: "fake.rs", text: "#[tauri::command]\nfn heavy_io() {}\n#[tauri::command(async)]\nfn now_async() {}" }],
    new Map([["now_async", "was sync once"]]),
  );
  assert.deepEqual(result.unknownSync.map((c) => c.name), ["heavy_io"]);
  assert.deepEqual(result.staleAllowlist, ["now_async"]);
});

test("the checker script exits 0 on the repository as it stands", () => {
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts", "check-command-threading.mjs")], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 60_000,
  });
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.match(r.stdout, /OK: every synchronous command is allowlisted/);
});
