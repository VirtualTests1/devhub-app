/**
 * The `localStorage` boundary of user launch templates (r20-O1-3).
 *
 * The reader's structural validation is already covered by
 * `tests/launch-templates.test.ts`-style fixtures elsewhere; what had no coverage was
 * the storage *object* itself misbehaving. In a WebView2 whose profile is wedged, or
 * under a policy that denies the origin, `getItem` and `setItem` throw — they do not
 * return `null` and they do not return a bad value. Both paths used to be unguarded
 * here while every other store in the app guarded them, which is the asymmetry this
 * commit closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadUserTemplates,
  saveTemplate,
} from "../src/lib/launch-templates.ts";

type FakeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function withStorage(stub: FakeStorage | undefined, body: () => void): void {
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  if (stub === undefined) delete g.localStorage;
  else g.localStorage = stub;
  try {
    body();
  } finally {
    if (previous === undefined) delete g.localStorage;
    else g.localStorage = previous;
  }
}

test("loadUserTemplates: a throwing getItem reads as an empty list, not a crash", () => {
  withStorage(
    {
      getItem() {
        throw new Error("SecurityError: storage access denied");
      },
      setItem() {},
    },
    () => {
      assert.deepEqual(loadUserTemplates(), []);
    },
  );
});

test("loadUserTemplates: no localStorage at all is still an empty list", () => {
  withStorage(undefined, () => {
    assert.deepEqual(loadUserTemplates(), []);
  });
});

test("saveTemplate: a refused write does not throw out of the click", () => {
  withStorage(
    {
      getItem: () => null,
      setItem() {
        throw new Error("QuotaExceededError");
      },
    },
    () => {
      // The call itself is what a button handler awaits, so the assertion is that it
      // returns normally with the created template in hand. `assert.doesNotThrow` is
      // not on the strict assert type this repo uses, and reaching for the loose
      // `assert` import just to phrase a negative would weaken the file.
      const created = saveTemplate("迁移 + 起服务", [
        { name: "install", command: "pnpm install", cwd: "", parallel: false },
        { name: "dev", command: "pnpm dev", cwd: "", parallel: false },
      ]);
      assert.equal(created.label, "迁移 + 起服务");
      assert.equal(created.steps.length, 2);
    },
  );
});
