/**
 * Cancelling a cross-repository scan must say when the stop request failed.
 *
 * The old dialog swallowed both the cancel and the close-path rejection and
 * closed anyway; the backend may still have been walking repositories with no
 * UI left to show it. `requestGrepCancel` makes the failure a value, and the
 * dialog keeps itself open (cancel button) or reports it after closing (X).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requestGrepCancel } from "../src/lib/grep.ts";

test("requestGrepCancel: sends the task id and reports success", async () => {
  const seen: { cmd?: string; args?: Record<string, unknown> } = {};
  const out = await requestGrepCancel(async (cmd, args) => {
    seen.cmd = cmd;
    seen.args = args;
    return true;
  }, "task-1");
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.cmd, "cancel_repo_grep");
  assert.deepEqual(seen.args, { task: "task-1" });
});

test("requestGrepCancel: a rejected IPC call becomes a reported failure", async () => {
  const out = await requestGrepCancel(async () => {
    throw new Error("bridge closed");
  }, "task-2");
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /bridge closed/);
});

test("CrossRepoGrepDialog: neither cancel nor close pretends the stop worked", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "src/dialogs/CrossRepoGrepDialog.tsx"),
    "utf8",
  );
  assert.match(src, /requestGrepCancel\(invoke, taskRef\.current\)/);
  assert.match(src, /setError\(t\("grep\.cancelFailed", \{ msg: out\.error \}\)\)/);
  assert.match(src, /if \(!out\.ok\) toast\.error\(t\("grep\.cancelFailed"/);
  assert.doesNotMatch(src, /cancel_repo_grep", \{ task: taskRef\.current \}\)\.catch\(\(\) => undefined\)/);
});
