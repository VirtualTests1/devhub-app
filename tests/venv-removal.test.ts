/**
 * `src/lib/venv-removal.ts` — the sentences the 虚拟环境 row shows, and which verb
 * belongs to which state.
 *
 * The defect (r16-o1): `create_repo_venv` has existed since round 11 and its
 * removal did not, so a stale environment could only be cleaned up in Explorer.
 * Worse, the row rendered `venvPath` — *what the marker was last told* — as if it
 * were the disk's state, while `venv_for` had already filtered that same path
 * through `looks_like_venv` and stopped using it. A moved or half-built venv
 * therefore showed 「已记录：…」 next to a repository that would launch without it.
 *
 * These are the two decisions that make the surfaces agree, kept out of
 * `RepoPythonPanel.tsx` because a `.tsx` cannot be asserted on from `node --test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type VenvReport,
  type VenvState,
  venvCreateLabel,
  venvDestroyIsIrreversible,
  venvHasSomethingToClean,
  venvRemovalLine,
  venvStateHint,
} from "../src/lib/venv-removal.ts";

const report = (over: Partial<VenvReport> = {}): VenvReport => ({
  hadVenv: true,
  removedVenv: false,
  recordOnly: false,
  freedBytes: 0,
  toBin: false,
  path: null,
  failed: [],
  ...over,
});

const STATES: VenvState[] = ["ready", "missing", "notAVenv", "unrecorded", "staleDir", "nothing"];

test("a removal is described by what the backend did, not by the button pressed", () => {
  const bin = venvRemovalLine(report({ removedVenv: true, toBin: true, freedBytes: 5 * 1024 * 1024 }));
  assert.equal(bin.tone, "ok");
  assert.match(bin.text, /回收站/);
  assert.match(bin.text, /还原由 Windows 负责/, "the app must not claim it owns the restore");

  const destroyed = venvRemovalLine(report({ removedVenv: true, freedBytes: 1024 }));
  assert.match(destroyed.text, /彻底删除/);
  assert.match(destroyed.text, /已安装的包不会回来/);

  // The case the old UI could not express: a pointer to a directory the app did not
  // create. Saying 「已删除」 here would be a lie about somebody else's files.
  const forgot = venvRemovalLine(
    report({ recordOnly: true, hadVenv: true, path: "D:\\conda\\envs\\other" }),
  );
  assert.match(forgot.text, /已停止跟踪/);
  assert.doesNotMatch(forgot.text, /已删除/);

  const gone = venvRemovalLine(report({ recordOnly: true, hadVenv: false }));
  assert.match(gone.text, /磁盘上本来就没有/);
});

test("a failed removal is a warning and names the failure", () => {
  const r = venvRemovalLine(report({ failed: ["虚拟环境目录: 另一个程序正在使用"] }));
  assert.equal(r.tone, "warn");
  assert.match(r.text, /另一个程序正在使用/);
});

test("every state gets its own hint, and only the healthy one says 已就绪", () => {
  for (const s of STATES) {
    const line = venvStateHint(s, "D:\\p\\venvs\\repo_owner", "D:\\p\\venvs\\repo_owner");
    assert.ok(line.length > 0, `${s} must say something`);
    if (s === "ready") assert.equal(line, "已就绪：D:\\p\\venvs\\repo_owner");
  }
  // The sentence that used to be impossible: recorded, but gone from disk.
  assert.match(venvStateHint("missing", "D:\\p\\venvs\\gone", null), /已经不在了/);
  assert.match(venvStateHint("notAVenv", "D:\\p\\venvs\\half", null), /不是一个虚拟环境/);
  // `staleDir` must not promise a refusal the backend does not implement:
  // `create_venv` only checks `pyvenv.cfg` afterwards, so it writes into the
  // directory. The hint says that instead of the old tooltip's claim.
  const stale = venvStateHint("staleDir", null, "D:\\p\\venvs\\junk");
  assert.match(stale, /直接往里面写/);
  assert.doesNotMatch(stale, /拒绝/);
  // Nothing recorded and nothing on disk still names where creation would go.
  assert.match(venvStateHint("nothing", null, "D:\\p\\venvs\\repo_owner"), /尚未创建/);
  assert.match(venvStateHint("nothing", null, null), /venvs/);
});

test("the create button's verb matches the state, and 重建 never means 清空", () => {
  assert.equal(venvCreateLabel("nothing"), "创建虚拟环境");
  assert.equal(venvCreateLabel("ready"), "检查 / 重建");
  assert.equal(venvCreateLabel("unrecorded"), "重新记录");
  for (const s of ["missing", "notAVenv", "staleDir"] as VenvState[]) {
    assert.match(venvCreateLabel(s), /重建/);
  }
});

test("only the cases that really destroy something ask for a typed confirmation", () => {
  // Retyping the slug for a delete that destroys nothing trains the user to retype
  // it without reading, which is how a typed confirmation stops working.
  assert.equal(venvDestroyIsIrreversible("ready"), true);
  assert.equal(venvDestroyIsIrreversible("staleDir"), true);
  for (const s of ["missing", "notAVenv", "unrecorded", "nothing"] as VenvState[]) {
    assert.equal(venvDestroyIsIrreversible(s), false, s);
  }
});

test("the cleanup row disappears exactly when there is nothing to clean", () => {
  assert.equal(venvHasSomethingToClean("nothing"), false);
  for (const s of ["ready", "missing", "notAVenv", "unrecorded", "staleDir"] as VenvState[]) {
    assert.equal(venvHasSomethingToClean(s), true, s);
  }
});
