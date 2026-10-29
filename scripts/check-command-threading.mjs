// Static audit of how every Tauri command runs.
//
// A synchronous command runs on the window thread. Tauri 2 exposes
// `#[tauri::command(async)]`, which moves a non-`async fn` onto its thread pool
// without changing the function body (tauri-macros wrapper.rs: "sync_threadpool").
// That distinction matters here because several commands touch the disk or walk
// process tables, and one of them (`live_processes`) is polled every two seconds.
//
// The rule this checker enforces: every command is either async (or marked
// `command(async)`), or named in ALLOWLIST with a reason. The allowlist is
// checked in both directions, so converting a command without removing its entry
// fails as loudly as adding a blocking one.
//
// Dependency-free by rule: node:fs, node:path only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A synchronous command that genuinely does not leave the window thread doing
 * anything that can block. Keep the reason concrete: "it is fast" is not one.
 */
export const ALLOWLIST = new Map([
  ["cancel_download", "flips an in-memory CancelToken; the clone itself runs on a worker"],
  ["clear_search_cache", "clears the in-memory search cache map"],
  ["git_bootstrap_status", "reads the in-memory bootstrap outcome"],
  ["assess_launch_commands", "bounded regexes over the handful of commands being edited"],
  ["apply_config_value", "pure formatting of one setting value into the loaded config"],
  ["clear_env_cache", "clears the in-memory environment TTL map"],
  ["note_boot_painted", "dispatches window.show() to the main thread; moving it would only add a hop"],
  ["app_version", "returns a compile-time constant"],
]);

/** Parse `#[tauri::command]` / `#[tauri::command(async)]` blocks in Rust source. */
export function scanSource(file, text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let pending = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith("#[tauri::command")) {
      pending = { line: i + 1, attrAsync: /\basync\b/.test(line) };
      continue;
    }
    if (!pending) continue;
    if (line === "" || line.startsWith("//") || line.startsWith("#[")) continue;
    const fn = /\b(async\s+)?fn\s+([A-Za-z0-9_]+)\s*[<(]/.exec(line);
    if (fn) {
      found.push({
        file,
        line: pending.line,
        name: fn[2],
        async: pending.attrAsync || Boolean(fn[1]),
      });
      pending = null;
      continue;
    }
    // A command attribute followed by something that is not a function is not a
    // shape this codebase has; stop rather than attribute a later fn to it.
    pending = null;
  }
  return found;
}

/** Audit parsed commands against the allowlist. Pure, so tests can feed sources. */
export function audit(sources, allowlist = ALLOWLIST) {
  const commands = sources.flatMap((s) => scanSource(s.file, s.text));
  const sync = commands.filter((c) => !c.async);
  const unknownSync = sync.filter((c) => !allowlist.has(c.name));
  const staleAllowlist = [...allowlist.keys()].filter((name) => !sync.some((c) => c.name === name));
  return { commands, sync, unknownSync, staleAllowlist };
}

function walkRust(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "target" || name === "gen") continue;
      out.push(...walkRust(p));
    } else if (name.endsWith(".rs")) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const root = join(ROOT, "src-tauri", "src");
  const sources = walkRust(root).map((p) => ({
    file: relative(ROOT, p).replaceAll("\\", "/"),
    text: readFileSync(p, "utf8"),
  }));
  const result = audit(sources);
  for (const c of result.sync) {
    const why = ALLOWLIST.get(c.name);
    console.log(`SYNC  ${c.file}:${c.line}  ${c.name}${why ? ` — allowlisted: ${why}` : ""}`);
  }
  if (result.unknownSync.length) {
    for (const c of result.unknownSync) {
      console.log(`FAIL  ${c.file}:${c.line}  ${c.name} is synchronous and not allowlisted`);
    }
  }
  if (result.staleAllowlist.length) {
    console.log(`FAIL  stale allowlist entries (no longer synchronous): ${result.staleAllowlist.join(", ")}`);
  }
  console.log(
    `commands: ${result.commands.length}, synchronous: ${result.sync.length}, ` +
      `allowlisted: ${result.sync.length - result.unknownSync.length}, unknown: ${result.unknownSync.length}`,
  );
  if (result.unknownSync.length || result.staleAllowlist.length) {
    console.log("FAIL: command threading audit");
    process.exitCode = 1;
    return;
  }
  console.log("OK: every synchronous command is allowlisted with a reason; the rest run off the window thread");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
