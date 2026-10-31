/**
 * Every Tauri command that takes a caller-supplied filesystem path must either
 * contain a path_guard/delete-target check or be on a reasoned allowlist.
 *
 * The 2026-10-31 audit found `repo_grep` taking an arbitrary `root` from the
 * page with no guard at all. `path_guard` already existed for the text endpoints;
 * this test is what makes the next path-taking command notice it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src-tauri", "src");

type Command = { file: string; name: string; body: string; pathParams: string[] };

const PATH_PARAM = /\b(path|target_dir|root|dir)\s*:\s*(String|Option<String>)\b/g;
const GUARD = /path_guard::(?:guard|check)|check_delete_target|check_worktree_target|check_venv_target/;

function commands(): Command[] {
  const out: Command[] = [];
  for (const file of readdirSync(SRC).filter((n) => n.endsWith(".rs"))) {
    const src = readFileSync(join(SRC, file), "utf8");
    const re =
      /#\[tauri::command[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g;
    for (const m of src.matchAll(re)) {
      const name = m[1] as string;
      const args = m[2] ?? "";
      const lineStart = src.lastIndexOf("\n", m.index ?? 0) + 1;
      const end = src.indexOf("\n}", lineStart);
      const body = end > lineStart ? src.slice(lineStart, end) : src.slice(lineStart);
      const pathParams = [...args.matchAll(PATH_PARAM)].map((p) => p[1] as string);
      out.push({ file, name, body, pathParams });
    }
  }
  return out;
}

/**
 * Commands whose path is intentionally not contained by the app roots. Each
 * reason says what the command actually does with the path.
 */
const ALLOWED = new Map<string, string>([
  ["project_has_compose", "probes four fixed compose filenames; returns a name, never file content"],
  ["add_custom_ide", "user-picked .exe under Program Files; only is_file + extension, then stored in config"],
  ["remove_custom_ide", "removes a string from config; never touches the path"],
  ["remove_repo_worktree", "gitwt::remove runs check_worktree_target before deleting"],
  ["validate_project_root", "validates a user-chosen root candidate; it must accept a directory outside the current roots"],
  ["forget_recent_root", "removes a string from recentRoots; never touches the path"],
]);

test("every path-taking command is guarded or has a recorded reason", () => {
  const offenders = commands()
    .filter((c) => c.pathParams.length > 0)
    .filter((c) => !GUARD.test(c.body) && !ALLOWED.has(c.name))
    .map((c) => `${c.file}:${c.name} (${c.pathParams.join(",")})`);
  assert.deepEqual(
    offenders,
    [],
    "a caller-supplied path reached a command with no path_guard/delete-target check",
  );
});

test("repo_grep no longer accepts a filesystem path", () => {
  const grep = commands().find((c) => c.name === "repo_grep");
  assert.ok(grep, "repo_grep exists");
  assert.deepEqual(grep.pathParams, [], "it must take a slug and resolve it through repo_index");
});

test("the allowlist has no stale entries", () => {
  const live = new Map(commands().map((c) => [c.name, c]));
  for (const [name, reason] of ALLOWED) {
    assert.ok(reason.trim().length > 20, `${name}: reason must explain the exception`);
    const cmd = live.get(name);
    assert.ok(cmd, `${name}: allowlisted command no longer exists`);
    assert.ok(cmd.pathParams.length > 0, `${name}: allowlist entry is stale (no path parameter)`);
  }
});
