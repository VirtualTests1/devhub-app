/**
 * `scripts/contrast-audit.mjs` — the audit is only useful if it is executed.
 *
 * `pnpm check` now runs it, so this test pins the two things that would make the
 * gate lie: a non-zero exit with an OK-looking message, or a silent pass with no
 * checks. It also pins `--json`'s `ok` against the exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = "scripts/contrast-audit.mjs";

function run(args: string[] = []) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./tests/helpers/register.mjs", SCRIPT, ...args],
    { encoding: "utf8", cwd: process.cwd() },
  );
  return { status: child.status, stdout: String(child.stdout ?? ""), stderr: String(child.stderr ?? "") };
}

test("contrast audit: 全绿、确实执行了 34 项检查", () => {
  const { status, stdout, stderr } = run();
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /OK: all text pairs >= 4\.5, non-text pairs >= 3 \(34 checks\)/);
  assert.doesNotMatch(stdout, /FAIL:/);
});

test("contrast audit --json: ok 与退出码一致", () => {
  const { status, stdout } = run(["--json"]);
  assert.equal(status, 0);
  const data = JSON.parse(stdout) as { ok: boolean; failed: number; rows: unknown[] };
  assert.equal(data.ok, true);
  assert.equal(data.failed, 0);
  assert.ok(data.rows.length >= 34);
});

test("contrast audit: 未知 flag 走用法错误（exit 2），不静默忽略", () => {
  const { status, stderr } = run(["--jsno"]);
  assert.equal(status, 2);
  assert.match(stderr, /unknown argument '--jsno'/);
});
