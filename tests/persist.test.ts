/**
 * `src/lib/persist.ts` — the outcome of a storage write, not the write itself.
 *
 * The failure this covers is the sentence "已保存" after a `QuotaExceededError`:
 * the in-memory list was right, the disk was not, and the UI had no value to
 * branch on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { persistJson, removeKey } from "../src/lib/persist.ts";

type FakeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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

test("persistJson: a successful write reports ok and stores the JSON", () => {
  let written = "";
  withStorage(
    {
      getItem: () => null,
      setItem: (_k, v) => {
        written = v;
      },
      removeItem: () => {},
    },
    () => {
      assert.deepEqual(persistJson("k", { a: 1 }), { ok: true });
      assert.equal(written, '{"a":1}');
    },
  );
});

test("persistJson: a throwing setItem is reported, not swallowed", () => {
  const error = new Error("QuotaExceededError");
  withStorage(
    {
      getItem: () => null,
      setItem() {
        throw error;
      },
      removeItem: () => {},
    },
    () => {
      assert.deepEqual(persistJson("k", []), { ok: false, error });
    },
  );
});

test("persistJson: no localStorage at all is a reported failure", () => {
  withStorage(undefined, () => {
    const out = persistJson("k", 1);
    assert.equal(out.ok, false);
  });
});

test("removeKey: reports a refused removal", () => {
  withStorage(
    {
      getItem: () => null,
      setItem: () => {},
      removeItem() {
        throw new Error("denied");
      },
    },
    () => {
      assert.equal(removeKey("k").ok, false);
    },
  );
});
