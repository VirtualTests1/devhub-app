/**
 * `src/store/searches.ts` — the pinned-search list.
 *
 * The value of this store is entirely in what it refuses: a hand-edited or
 * half-written localStorage blob must not become a row that throws when clicked,
 * and must not turn into an unexpected `?sort=` on the GitHub API. So most of
 * these cases are adversarial.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { importSeeded, installBrowserGlobals, readBack } from "./helpers/storage.ts";
import { normalizeSearch } from "../src/store/searches.ts";

import { at } from "./helpers/definite.ts";

installBrowserGlobals();

type Searches = typeof import("../src/store/searches.ts");

const KEY = "devhub.searches.v1";

test("normalizeSearch: a well-formed entry survives", () => {
  assert.deepEqual(normalizeSearch({ q: "rust http", sort: "stars" }), {
    q: "rust http",
    sort: "stars",
  });
});

test("normalizeSearch: junk shapes are refused, not coerced", () => {
  for (const bad of [null, undefined, 0, "", "rust", [], {}, ["rust"], { q: 42 }, { sort: "stars" }]) {
    assert.equal(normalizeSearch(bad), null, `${JSON.stringify(bad)} is not a search`);
  }
});

test("normalizeSearch: a one-character or absurd query is refused", () => {
  // The search box itself requires two characters (AddRepoView), so a saved entry
  // that cannot be re-run is a row that does nothing when clicked.
  assert.equal(normalizeSearch({ q: "x", sort: "" }), null);
  assert.equal(normalizeSearch({ q: " ".repeat(3), sort: "" }), null);
  assert.equal(normalizeSearch({ q: "q".repeat(201), sort: "" }), null);
});

test("normalizeSearch: an unknown sort falls back to best-match instead of reaching the API", () => {
  // search.rs forwards the sort string straight into `?sort=`; an entry edited to
  // something else would make the app send a query variation nobody asked for.
  assert.deepEqual(normalizeSearch({ q: "rust", sort: "nonsense" }), { q: "rust", sort: "" });
  assert.deepEqual(normalizeSearch({ q: "rust", sort: "updated" }), { q: "rust", sort: "updated" });
});

test("searches: first run is empty", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  assert.deepEqual(useSavedSearches.getState().items, []);
});

test("searches: save pins to the front and re-saving moves rather than duplicates", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  const s = useSavedSearches.getState();
  s.save({ q: "rust http", sort: "" });
  s.save({ q: "go cli", sort: "stars" });
  s.save({ q: "RUST http", sort: "" });
  const items = useSavedSearches.getState().items;
  assert.equal(items.length, 2, "case-insensitive on the query: GitHub search is");
  assert.equal(at(items, 0).q, "RUST http", "most recent first");
});

test("searches: the same query with a different sort is a different entry", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  useSavedSearches.getState().save({ q: "rust", sort: "" });
  useSavedSearches.getState().save({ q: "rust", sort: "forks" });
  assert.equal(useSavedSearches.getState().items.length, 2);
});

test("searches: the list is capped and the newest survive", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  for (let i = 0; i < 20; i += 1) useSavedSearches.getState().save({ q: `p${i} x`, sort: "" });
  const items = useSavedSearches.getState().items;
  assert.equal(items.length, 12);
  assert.equal(at(items, 0).q, "p19 x");
  assert.equal(at(items, 11).q, "p8 x");
});

test("searches: an illegal save is refused quietly, leaving the list untouched", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  useSavedSearches.getState().save({ q: "rust http", sort: "" });
  useSavedSearches.getState().save({ q: "x", sort: "" });
  assert.equal(useSavedSearches.getState().items.length, 1);
});

test("searches: remove takes exactly one entry and persists", async () => {
  const { useSavedSearches } = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
  );
  useSavedSearches.getState().save({ q: "a b", sort: "" });
  useSavedSearches.getState().save({ q: "c d", sort: "stars" });
  useSavedSearches.getState().remove(0);
  const items = useSavedSearches.getState().items;
  assert.deepEqual(items.map((s) => s.q), ["a b"], "index 0 was the newest");
  const written = JSON.parse(readBack(KEY) ?? "[]") as unknown[];
  assert.equal(written.length, 1, "the removal reaches disk, not just memory");
});

test("searches: a corrupt payload degrades to empty rather than crashing the page", async () => {
  const broken = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
    { [KEY]: "{{{not json" },
  );
  assert.deepEqual(broken.useSavedSearches.getState().items, []);

  const wrongShape = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
    { [KEY]: JSON.stringify({ q: "not an array" }) },
  );
  assert.deepEqual(wrongShape.useSavedSearches.getState().items, []);
});

test("searches: mixed-quality storage keeps the valid rows and drops the rest", async () => {
  const seeded = await importSeeded<Searches>(
    import.meta.resolve("../src/store/searches.ts"),
    {
      [KEY]: JSON.stringify([
        { q: "rust http", sort: "stars" },
        { q: 12 },
        { q: "x" },
        { q: "go cli", sort: "made-up" },
        "just a string",
      ]),
    },
  );
  const items = seeded.useSavedSearches.getState().items;
  assert.deepEqual(items, [
    { q: "rust http", sort: "stars" },
    { q: "go cli", sort: "" },
  ]);
});
