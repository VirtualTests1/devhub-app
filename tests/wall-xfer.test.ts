import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWallXfer, parseWallXfer } from "../src/store/wall-xfer";

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
