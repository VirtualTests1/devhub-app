/**
 * The binding store's boundary (r20-N1-2).
 *
 * Everything here crosses `localStorage`, which is untrusted on read — the same rule
 * `src/lib/launch-templates.ts` states for its own key. What is pinned is the shape of
 * a bad file, the canonicalisation that makes a conflict visible, and the fact that a
 * rebind tells the caller whose key it took.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearBinding,
  currentKeyMap,
  loadOverrides,
  setBinding,
} from "../src/lib/shortcut-bindings.ts";

const KEY = "devhub.shortcuts.v1";

function withStore(initial: string | null, body: () => void): void {
  const g = globalThis as unknown as { localStorage?: unknown };
  const store = new Map<string, string>();
  if (initial !== null) store.set(KEY, initial);
  const previous = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    body();
  } finally {
    if (previous === undefined) delete g.localStorage;
    else g.localStorage = previous;
  }
}

test("loadOverrides: a hostile file drops entries instead of throwing", () => {
  for (const junk of ["not json", "[]", "null", '{"palette": 42}', '{"nope":"Ctrl+K"}']) {
    withStore(junk, () => {
      assert.deepEqual(loadOverrides(), {}, `should have ignored ${junk}`);
    });
  }
  withStore('{"palette":"this is not a chord","back":"Alt+ArrowLeft"}', () => {
    assert.deepEqual(loadOverrides(), { back: "Alt+ArrowLeft" });
  });
});

test("no localStorage at all still produces the shipped key map", () => {
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = g.localStorage;
  delete g.localStorage;
  try {
    const map = currentKeyMap();
    assert.equal(map.bindings.palette, "Ctrl+K");
    assert.deepEqual(map.conflicts, {});
  } finally {
    if (previous !== undefined) g.localStorage = previous;
  }
});

test("setBinding: stored canonically, so two spellings cannot hide a conflict", () => {
  withStore(null, () => {
    const r = setBinding("palette", "shift+ctrl+k");
    assert.ok(r.ok && r.chord === "Ctrl+Shift+K");
    assert.equal(loadOverrides().palette, "Ctrl+Shift+K");
  });
});

test("setBinding: taking someone else's chord says whose key was lost", () => {
  withStore(null, () => {
    // `help` ships on F1; move it onto the palette's chord and the palette is the
    // action that just lost its binding — the panel needs that to be a sentence.
    const r = setBinding("help", "Ctrl+K");
    assert.ok(r.ok);
    assert.deepEqual(r.over, ["palette"]);
    const conflicts = Object.values(currentKeyMap().conflicts)
      .map((ids) => ids.slice().sort())
      .sort();
    assert.deepEqual(conflicts, [["help", "palette"]]);
  });
});

test("setBinding: unknown action and unparseable chord are refused without writing", () => {
  withStore(null, () => {
    assert.deepEqual(setBinding("no-such-action", "Ctrl+K"), {
      ok: false,
      reason: "unknown-action",
      chord: "Ctrl+K",
    });
    assert.deepEqual(setBinding("palette", "k"), {
      ok: false,
      reason: "unparsable",
      chord: "k",
    });
    assert.deepEqual(loadOverrides(), {}, "a refused rebind must not touch storage");
  });
});

test("clearBinding puts the shipped chord back", () => {
  withStore(null, () => {
    setBinding("back", "Alt+ArrowUp");
    assert.equal(currentKeyMap().bindings.back, "Alt+ArrowUp");
    clearBinding("back");
    assert.equal(currentKeyMap().bindings.back, "Alt+ArrowLeft");
  });
});
