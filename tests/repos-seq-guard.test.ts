/**
 * `src/App.tsx` — every wall write is stamped.
 *
 * Why this file reads the source instead of driving the component
 * (same approach as `tests/single-source.test.ts`): `App.tsx` is a `.tsx`, and
 * `node --experimental-strip-types` refuses `.tsx` outright
 * (`DEVELOPMENT.md` §8.1), so the composition root cannot be mounted at this
 * layer. What *can* be pinned here is the structural rule the fix depends on,
 * which is exactly the thing a later edit inside the same file silently breaks:
 * a new `setRepos(...)` added without a stamp is invisible in review and
 * reproduces the bug.
 *
 * The bug (r15-correct-5): `settingsSeq` protected settings only. Four refresh
 * paths write the wall — the download-done effect, the startup clean-up, a root
 * change from `persistSettings`, and closing the launch dialog — and each list
 * lands whenever its own `list_repositories` settles. An unforced read comes
 * from the backend index and is fast; a forced re-walk is slow. The fast-but-
 * older answer could therefore overwrite the slow-but-newer one, and the tile
 * for a repository that had just finished downloading disappeared again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { at } from "./helpers/definite.ts";

const APP = "src/App.tsx";
const source = readFileSync(APP, "utf8");
const lines = source.split(/\r?\n/);

const numbered = (re: RegExp) =>
  lines
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => re.test(l.text));

test("setRepos is declared once and never written unguarded", () => {
  const declared = numbered(/^\s*const \[repos, setRepos\] = useState/);
  assert.equal(declared.length, 1, "one state slot owns the wall list");

  const writes = numbered(/setRepos\(/);
  assert.ok(writes.length > 0, "the guard below is worthless if the writes were removed");
  for (const w of writes) {
    assert.match(
      w.text,
      /=== reposSeq\.current\)\s*setRepos\(/,
      `${APP}:${w.n} writes the wall without checking it still owns the newest answer — ` +
        "an older list_repositories response landing here drops tiles a newer list already has",
    );
  }
});

test("both wall-loading paths stamp the sequence before they await", () => {
  const stamps = numbered(/\+\+reposSeq\.current/);
  // `refreshWall` (four callers) and `refresh` (the 刷新 button, startup, git bootstrap).
  assert.equal(
    stamps.length,
    2,
    "every path that can write the wall must claim a newer stamp on entry, " +
      `found: ${stamps.map((s) => `${APP}:${s.n}`).join(", ")}`,
  );
});

test("a superseded refreshWall failure stays quiet rather than overwriting the wall's banner", () => {
  const errWrites = numbered(/setGateError\(t\("app\.gate\.reposFailed"/);
  assert.equal(errWrites.length, 1);
  const err = at(errWrites, 0);
  assert.match(
    err.text,
    /reposSeq\.current === seq|seq === reposSeq\.current/,
    `${APP}:${err.n} reports a failure from a walk somebody else has already superseded`,
  );
});

test("the settings guard this pattern was copied from is still intact", () => {
  // Regression cover for the *reason* the shape is right: `settingsSeq` predates
  // this round and still has to protect settings, or the fix has been paid for
  // by breaking the one that already worked.
  assert.match(source, /const settingsSeq = useRef\(0\);/);
  assert.match(source, /if \(settingsSeq\.current === seq\) setSettings\(s\);/);
  const declared = numbered(/^\s*const reposSeq = useRef\(0\);/);
  assert.equal(declared.length, 1, "one sequence owns the wall");
});

test("the first-paint flag is not gated, so a superseded first walk still ends loading", () => {
  // `setReposLoaded(true)` sits in `refreshWall`'s `finally` on purpose: it means
  // "something answered", not "this answer is the newest". Guarding it would hang
  // the wall on the skeleton if the first walk raced a second one.
  const flag = numbered(/setReposLoaded\(true\)/);
  assert.equal(flag.length, 1);
  const hit = at(flag, 0);
  assert.doesNotMatch(hit.text, /reposSeq/, "the loading flag must stay unconditional");
  const context = lines.slice(Math.max(0, hit.n - 5), hit.n).join("\n");
  assert.match(context, /\}\s*finally\s*\{/, "and it lives in the finally, not in the try");
});
