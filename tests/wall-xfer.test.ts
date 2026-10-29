import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWallXfer, parseWallXfer } from "../src/store/wall-xfer";
import type { WallView } from "../src/lib/wall-views.ts";

const state = {
  sort: "size" as const,
  filter: "running" as const,
  grouped: true,
  density: "compact" as const,
  repos: {
    "github/foo/bar": { alias: "bar", pinned: true, index: 3 },
    "github/baz/qux": { hidden: true },
  },
};

const view = (over: Partial<WallView> = {}): WallView => ({
  id: "wv-1",
  name: "Rust backend",
  query: "rust",
  language: "Rust",
  category: "",
  tags: ["backend"],
  sort: "size",
  filter: "all",
  ...over,
});

test("buildWallXfer tags the payload and round-trips through parseWallXfer", () => {
  const x = buildWallXfer(state);
  assert.equal(x.format, "devhub-wall");
  assert.equal(x.version, 1);
  const { prefs, repos } = parseWallXfer(JSON.stringify(x));
  assert.equal(prefs.sort, "size");
  assert.equal(prefs.filter, "running");
  assert.equal(prefs.grouped, true);
  assert.equal(prefs.density, "compact");
  assert.deepEqual(repos["github/foo/bar"], { alias: "bar", pinned: true, index: 3 });
  assert.deepEqual(repos["github/baz/qux"], { hidden: true });
});

test("parseWallXfer rejects non-JSON and non-object roots", () => {
  assert.throws(() => parseWallXfer("{"), /JSON/);
  assert.throws(() => parseWallXfer("null"), /对象/);
  assert.throws(() => parseWallXfer("[1]"), /对象/);
});

test("parseWallXfer rejects a file without the format tag", () => {
  assert.throws(() => parseWallXfer(JSON.stringify({ version: 1 })), /devhub-wall/);
});

test("parseWallXfer drops unknown sort/filter/density ids", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: { sort: "nope", filter: "also-nope", density: "huge", grouped: false },
    repos: {},
  });
  const { prefs } = parseWallXfer(text);
  assert.equal(prefs.sort, undefined);
  assert.equal(prefs.filter, undefined);
  assert.equal(prefs.density, undefined);
  assert.equal(prefs.grouped, false);
});

test("parseWallXfer re-checks repo fields (hostile types are dropped)", () => {
  const text = JSON.stringify({
    format: "devhub-wall",
    version: 1,
    prefs: {},
    repos: {
      good: { alias: "ok", pinned: true },
      bad: { pinned: "yes", index: "abc", alias: 123 },
      empty: {},
    },
  });
  const { repos } = parseWallXfer(text);
  assert.deepEqual(repos.good, { alias: "ok", pinned: true });
  assert.equal("bad" in repos, false);
  assert.equal("empty" in repos, false);
});

test("views travel with a wall export and are sanitised on the way back", () => {
  const x = buildWallXfer({ ...state, views: [view()] });
  assert.deepEqual(x.views, [view()]);
  const parsed = parseWallXfer(JSON.stringify(x));
  assert.deepEqual(parsed.views, [view()]);
});

test("an old export without views leaves the receiving list untouched", () => {
  const x = buildWallXfer(state);
  assert.equal("views" in x, false);
  assert.equal(parseWallXfer(JSON.stringify(x)).views, undefined);
});

test("a present views array is replaced exactly; junk rows are dropped", () => {
  const x = {
    ...buildWallXfer(state),
    views: [view({ id: "wv-good" }), { id: "", name: "no id" }, { id: "wv-bad", name: "  " }],
  };
  const parsed = parseWallXfer(JSON.stringify(x));
  assert.deepEqual(parsed.views?.map((v) => v.id), ["wv-good"]);
  const wrongShape = parseWallXfer(JSON.stringify({ ...buildWallXfer(state), views: "nope" }));
  assert.equal(wrongShape.views, undefined, "a non-array must not clear the receiving views");
  const empty = parseWallXfer(JSON.stringify({ ...buildWallXfer(state), views: [] }));
  assert.deepEqual(empty.views, [], "an explicit empty array is a real replacement");
});
