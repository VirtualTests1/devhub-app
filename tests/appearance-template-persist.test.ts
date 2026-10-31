/**
 * The appearance template API must report a refused storage write.
 *
 * `saveTemplate` used to return the in-memory list and `AppearanceView` printed
 * 模版已保存 from it; a full/denied localStorage made that sentence true for the
 * session only. The module is imported dynamically after the storage stub is in
 * place because `store/appearance.ts` reads localStorage at module init.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("appearance saveTemplate reports persisted=false and keeps the session copy", async () => {
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  g.localStorage = {
    getItem: () => null,
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  try {
    const { saveTemplate, loadTemplates } = await import("../src/store/appearance.ts");
    const result = saveTemplate("dark-ish", {} as never);
    assert.equal(result.persisted, false, "the caller must be able to show a failure");
    assert.equal(result.templates.length, 1, "the session still has the template");
    assert.deepEqual(loadTemplates(), [], "the disk copy is unchanged");
  } finally {
    if (previous === undefined) delete g.localStorage;
    else g.localStorage = previous;
  }
});
