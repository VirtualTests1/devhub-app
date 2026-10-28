/**
 * The Node-reachability guard for every module under `src/lib/` and `src/store/`.
 *
 * ## Why this file exists (src/store/toast.ts:6-11)
 *
 * That comment is the rule this test enforces: the toast *queue* lives in
 * `store/toast.ts` precisely so a non-DOM importer "can reach `toast.error` without
 * pulling JSX into a runtime that cannot parse it." `node --test` here runs through
 * Node's native type stripping (`--experimental-strip-types`), which refuses `.tsx`
 * outright, and `tests/helpers/ts-resolver.mjs` deliberately tries only `.ts`. So a
 * `src/lib` or `src/store` module that transitively imports a `.tsx` component
 * becomes *un-importable from Node* — not type-wrong, unreachable. That silently
 * removes it from every unit test, because a test cannot import it to assert on it.
 *
 * This test imports every module in those two directories through the same resolver
 * the runner uses and fails loudly on any new `.tsx` pull. `src/lib/clipboard.ts` and
 * `src/lib/activity.ts` were doing exactly this — importing `toast` from
 * `components/Toast` (a `.tsx`) — until round 15 repointed them to `store/toast`; the
 * last assertions here are the regression guard for that fix.
 *
 * ## What it does NOT try to be
 *
 * Not a coverage tool and not a behaviour test. It only asks one question per module:
 * does loading it throw? Side effects that are legitimately browser-only (a store's
 * `create(...)` initializer, `readStored()`'s localStorage read inside try/catch) run
 * and are expected to be inert under Node — that is what makes the whole directory
 * importable in the first place.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

/** The two directories the rule covers: the non-DOM half of the frontend. */
const DIRS = ["src/lib", "src/store"] as const;

/**
 * Modules that are known-unreachable from Node right now, and NOT owned by this
 * work stream. This is a tracking list, not an endorsement: each entry is the same
 * `.tsx` trap the guard is meant to catch, parked here because the fix belongs in
 * another agent's file (`docs` ownership: round 15 test stream may edit only
 * `src/lib/clipboard.ts` and `src/lib/activity.ts`).
 *
 * It is now empty, and the entry it lost is the proof the guard works:
 * `src/store/downloads.ts` used to import `toast` from `../components/Toast`, which
 * made the whole module un-importable and silently deleted it from every unit test.
 * `feat/r15-correct-2` repointed that line to `../store/toast` — the same re-exported
 * object, per `components/Toast.tsx:13` — so the parked entry had to come out, and
 * `tests/downloads-pure.test.ts` (which was written against this module and had never
 * once executed) woke up with it. Add an entry only when the fix genuinely belongs to
 * another stream; the guard is worth nothing if this set grows by default.
 */
const KNOWN_UNREACHABLE = new Set<string>([]);

type ModuleEntry = { key: string; href: string };

/** Lists `DIRS` and maps each `.ts` to a `file://` href anchored to this test file,
 *  not to `process.cwd()`, so the import resolves the same way any test import does. */
function listModules(): ModuleEntry[] {
  const root = process.cwd();
  const out: ModuleEntry[] = [];
  for (const dir of DIRS) {
    const names = readdirSync(join(root, dir))
      .filter((f) => f.endsWith(".ts"))
      .sort();
    for (const name of names) {
      // `../src/lib/foo.ts` resolves against this file's URL (`tests/`), landing on
      // the sibling `src/` tree — the identical path a static test import would take.
      const href = new URL(`../${dir}/${name}`, import.meta.url).href;
      out.push({ key: `${dir}/${name}`, href });
    }
  }
  return out;
}

test("lib/store 全模块都能被 Node 解析器加载（.tsx 污染守卫）", async () => {
  const modules = listModules();

  // Guard against a vacuous pass: the enumeration itself has to be non-trivial, and
  // it must actually contain the sentinel modules the suite depends on.
  assert.ok(modules.length >= 25, `expected dozens of lib/store modules, found ${modules.length}`);
  for (const sentinel of ["src/lib/format.ts", "src/store/toast.ts", "src/store/wall.ts"]) {
    assert.ok(
      modules.some((m) => m.key === sentinel),
      `enumeration lost ${sentinel} — the directory walk or the .ts filter broke`,
    );
  }

  const failures: { key: string; detail: string }[] = [];
  for (const m of modules) {
    try {
      await import(m.href);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      failures.push({ key: m.key, detail: `${err.code ?? "load-error"}: ${String(err.message).split("\n")[0]}` });
    }
  }

  const unexpected = failures.filter((f) => !KNOWN_UNREACHABLE.has(f.key));
  assert.deepEqual(
    unexpected,
    [],
    "a module under src/lib or src/store became un-importable from Node — almost " +
      "certainly it now imports a .tsx component. Move that dependency to a non-DOM " +
      "module (see src/store/toast.ts:6-11) rather than adding it to the allow-list.",
  );

  // The allow-list stays honest: a parked module must still be failing for the one
  // documented reason (the components/Toast .tsx pull). A *new* failure cause there
  // is a real regression and must not hide behind the allow-list.
  for (const f of failures) {
    assert.match(f.detail, /components[\\/]+Toast/, `${f.key} is allow-listed for the components/Toast trap, but failed differently: ${f.detail}`);
  }
});

test("round-15 fix：clipboard 与 activity 已改从 store/toast 取 toast，重新可测", async () => {
  // The two files this stream owns and repaired. If either regresses to importing
  // `toast` from `components/Toast`, these imports throw ERR_MODULE_NOT_FOUND and
  // this test fails before the graph test's "no unexpected failure" check even gets
  // to weigh in — the message here names the fix directly.
  const { copyLogWithToast } = await import(new URL("../src/lib/clipboard.ts", import.meta.url).href);
  const { confirmAndClearActivity } = await import(new URL("../src/lib/activity.ts", import.meta.url).href);
  assert.equal(typeof copyLogWithToast, "function");
  assert.equal(typeof confirmAndClearActivity, "function");
});
