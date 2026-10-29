/**
 * Saved wall views: the coercion rules, the persistence and the palette hand-off.
 *
 * The view is a `.tsx`, so "what a valid view is" and "what the store does when
 * the list is full" live in modules Node can load. The toolbar wiring is checked
 * separately by reading the source, the same way the other view-only contracts
 * in this suite are pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EMPTY_VIEW_CRITERIA,
  WALL_VIEW_LIMIT,
  hasViewCriteria,
  sanitiseCriteria,
  sanitiseViewName,
  sanitiseViews,
  sameCriteria,
  type WallView,
  type WallViewCriteria,
} from "../src/lib/wall-views.ts";
import { WALL_VIEWS_KEY, createWallViewsStore } from "../src/store/wall-views.ts";

const criteria = (over: Partial<WallViewCriteria> = {}): WallViewCriteria => ({
  ...EMPTY_VIEW_CRITERIA,
  tags: [],
  ...over,
});

function fakeStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(WALL_VIEWS_KEY, seed);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("criteria: junk collapses to the defaults, valid ids survive", () => {
  assert.deepEqual(sanitiseCriteria(null), criteria());
  const clean = sanitiseCriteria({
    query: "  rust  ",
    language: " Rust ",
    category: "rust",
    tags: [" backend ", "backend", "api"],
    sort: "size",
    filter: "running",
  });
  assert.deepEqual(clean, {
    query: "rust",
    language: "Rust",
    category: "rust",
    tags: ["backend", "api"],
    sort: "size",
    filter: "running",
  });
  const bad = sanitiseCriteria({ sort: "not-a-tier", filter: "everything", tags: "nope" });
  assert.equal(bad.sort, "name");
  assert.equal(bad.filter, "all");
  assert.deepEqual(bad.tags, []);
});

test("names: trimmed, whitespace-collapsed, capped; empty is invalid", () => {
  assert.equal(sanitiseViewName("  backend   rust "), "backend rust");
  assert.equal(sanitiseViewName("   "), null);
  assert.equal(sanitiseViewName(7), null);
  assert.equal(sanitiseViewName("x".repeat(100))?.length, 40);
});

test("views: rows without identity are dropped, ids are unique, cap applies", () => {
  const rows = [
    { id: "a", name: "One" },
    { id: "a", name: "Duplicate id" },
    { id: "", name: "No id" },
    { id: "b", name: "   " },
    { id: "c", name: "Three", tags: ["x"] },
  ];
  assert.deepEqual(
    sanitiseViews(rows).map((v) => v.id),
    ["a", "c"],
  );
  const many = Array.from({ length: WALL_VIEW_LIMIT + 5 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` }));
  assert.equal(sanitiseViews(many).length, WALL_VIEW_LIMIT);
});

test("hasViewCriteria: only a non-default question is worth saving", () => {
  assert.equal(hasViewCriteria(criteria()), false);
  assert.equal(hasViewCriteria(criteria({ query: "x" })), true);
  assert.equal(hasViewCriteria(criteria({ tags: ["a"] })), true);
  assert.equal(hasViewCriteria(criteria({ sort: "size" })), true);
});

test("sameCriteria: tag order is part of the identity", () => {
  assert.equal(sameCriteria(criteria(), criteria()), true);
  assert.equal(sameCriteria(criteria({ tags: ["a", "b"] }), criteria({ tags: ["a", "b"] })), true);
  assert.equal(sameCriteria(criteria({ tags: ["a", "b"] }), criteria({ tags: ["b", "a"] })), false);
});

test("store: save refuses empty, duplicate and over-cap names, and persists the rest", () => {
  const storage = fakeStorage();
  const store = createWallViewsStore(storage);
  assert.deepEqual(store.getState().save("   ", criteria({ query: "x" })), {
    ok: false,
    reason: "empty",
  });
  const first = store.getState().save(" Backend ", criteria({ query: "rust" }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.view.name, "Backend");
  assert.equal(store.getState().activeId, first.view.id);
  assert.deepEqual(store.getState().save("backend", criteria({ query: "go" })), {
    ok: false,
    reason: "duplicate",
  });
  for (let i = 1; i < WALL_VIEW_LIMIT; i += 1) {
    assert.equal(store.getState().save(`View ${i}`, criteria({ query: String(i) })).ok, true);
  }
  assert.deepEqual(store.getState().save("One too many", criteria({ query: "x" })), {
    ok: false,
    reason: "full",
  });
  const reopened = createWallViewsStore(storage);
  assert.equal(reopened.getState().views.length, WALL_VIEW_LIMIT);
  assert.equal(reopened.getState().views[0]?.name, "Backend");
  assert.equal(reopened.getState().activeId, null, "active view is session state, not disk state");
});

test("store: rename checks duplicates, remove clears active, persisted list follows", () => {
  const storage = fakeStorage();
  const store = createWallViewsStore(storage);
  const a = store.getState().save("A", criteria({ query: "a" }));
  const b = store.getState().save("B", criteria({ query: "b" }));
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(store.getState().rename(b.view.id, "a"), { ok: false, reason: "duplicate" });
  assert.equal(store.getState().rename(b.view.id, "Bee").ok, true);
  assert.equal(store.getState().views.find((v) => v.id === b.view.id)?.name, "Bee");
  store.getState().remove(b.view.id);
  assert.equal(store.getState().views.length, 1);
  assert.equal(store.getState().activeId, null, "deleting the active view clears the indicator");
  const reopened = createWallViewsStore(storage);
  assert.deepEqual(reopened.getState().views.map((v) => v.name), ["A"]);
});

test("store: apply requests are one-shot and unknown ids are ignored", () => {
  const store = createWallViewsStore(fakeStorage());
  const saved = store.getState().save("Rust", criteria({ query: "rust" }));
  assert.ok(saved.ok);
  if (!saved.ok) return;
  store.getState().requestApply("missing");
  assert.equal(store.getState().applyRequest, null);
  store.getState().requestApply(saved.view.id);
  const request = store.getState().applyRequest;
  assert.equal(request?.id, saved.view.id);
  store.getState().consume(-1);
  assert.equal(store.getState().applyRequest?.id, saved.view.id, "a stale consume must not clear it");
  store.getState().consume(request?.seq ?? -1);
  assert.equal(store.getState().applyRequest, null);
});

test("store: replaceViews sanitises, clears active state and persists", () => {
  const storage = fakeStorage();
  const store = createWallViewsStore(storage);
  const saved = store.getState().save("Old", criteria({ query: "old" }));
  assert.ok(saved.ok);
  if (!saved.ok) return;
  store.getState().requestApply(saved.view.id);
  store.getState().replaceViews([
    {
      id: "wv-new",
      name: "New",
      query: "new",
      language: "",
      category: "",
      tags: ["a", "a"],
      sort: "name",
      filter: "all",
    } satisfies WallView,
  ]);
  assert.deepEqual(store.getState().views.map((v) => v.name), ["New"]);
  assert.deepEqual(store.getState().views[0]?.tags, ["a"]);
  assert.equal(store.getState().activeId, null);
  assert.equal(store.getState().applyRequest, null);
  const reopened = createWallViewsStore(storage);
  assert.deepEqual(reopened.getState().views.map((v) => v.name), ["New"]);
});

test("store: a corrupt payload is an empty list, not a crash", () => {
  const store = createWallViewsStore(fakeStorage("{not json"));
  assert.deepEqual(store.getState().views, []);
  const wrongShape = createWallViewsStore(fakeStorage(JSON.stringify({ version: 1, views: "nope" })));
  assert.deepEqual(wrongShape.getState().views, []);
});

test("toolbar and palette are wired to the store", () => {
  const projects = readFileSync("src/views/ProjectsView.tsx", "utf8");
  const palette = readFileSync("src/components/CommandPalette.tsx", "utf8");
  assert.match(projects, /useWallViews\.getState\(\)\.save\(name, currentCriteria\)/);
  assert.match(projects, /requestApply\(id\)/);
  assert.match(projects, /<WallViewDialog/);
  assert.match(projects, /wall\.views\.deleteConfirm/);
  assert.match(palette, /t\("wall\.views\.apply", \{ name: view\.name \}\)/);
  assert.match(palette, /useWallViews\.getState\(\)\.requestApply\(view\.id\)/);
});
