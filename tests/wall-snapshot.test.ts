/**
 * Wall snapshots and the corrupt-main fallback (r30-N4).
 *
 * The rotation, the junk-row rules and the "only corruption may recover" rule
 * are pure enough to drive with a Map. The live profile is never touched, and
 * the real wall store's fallback is exercised through its exported reader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WALL_SNAPSHOTS_KEY,
  WALL_SNAPSHOT_LIMIT,
  captureSnapshot,
  latestSnapshot,
  parseSnapshots,
  readSnapshots,
} from "../src/lib/wall-snapshot.ts";
import { parseStoredWall, readWallFrom } from "../src/store/wall.ts";

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  let failWrites = 0;
  return {
    map,
    failNextWrites(n: number) {
      failWrites = n;
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error("QuotaExceededError");
      }
      map.set(key, value);
    },
  };
}

const wall = (label: string) =>
  JSON.stringify({
    prefs: { sort: "name", filter: "all", grouped: false, density: "standard" },
    repos: { [`github.com/o/${label}`]: { alias: label } },
  });

test("snapshots: junk rows are dropped, duplicates collapse, cap and newest-first hold", () => {
  assert.deepEqual(parseSnapshots("{"), []);
  assert.deepEqual(parseSnapshots(JSON.stringify({ snapshots: "nope" })), []);
  assert.deepEqual(parseSnapshots(JSON.stringify({ snapshots: [null, 1, {}, { savedAt: 0, wall: "x" }] })), []);
  const rows = [
    { savedAt: 10, wall: "a" },
    { savedAt: 30, wall: "b" },
    { savedAt: 20, wall: "a" },
    { savedAt: 40, wall: "c" },
    { savedAt: 50, wall: "d" },
  ];
  assert.deepEqual(
    parseSnapshots(JSON.stringify({ snapshots: rows })).map((s) => s.wall),
    ["d", "c", "b"],
    "newest first, one entry per distinct payload, capped at three",
  );
});

test("snapshots: capture stores the payload and does not duplicate the newest", () => {
  const storage = fakeStorage();
  const first = captureSnapshot(wall("one"), 1_000, storage);
  assert.equal(first?.savedAt, 1_000);
  assert.equal(latestSnapshot(storage)?.wall, wall("one"));
  const again = captureSnapshot(wall("one"), 2_000, storage);
  assert.equal(again?.savedAt, 1_000, "same payload keeps the existing restore point");
  assert.equal(readSnapshots(storage).length, 1);
  captureSnapshot(wall("two"), 2_000, storage);
  assert.deepEqual(readSnapshots(storage).map((s) => s.wall), [wall("two"), wall("one")]);
});

test("snapshots: capture keeps at most three, and survives a quota refusal", () => {
  const storage = fakeStorage();
  for (let i = 0; i < 5; i += 1) captureSnapshot(wall(`v${i}`), 100 + i, storage);
  assert.equal(readSnapshots(storage).length, WALL_SNAPSHOT_LIMIT);
  assert.equal(readSnapshots(storage)[0]?.wall, wall("v4"));

  const refusing = fakeStorage();
  refusing.failNextWrites(1);
  const saved = captureSnapshot(wall("only"), 500, refusing);
  assert.equal(saved?.wall, wall("only"), "the retry keeps one restore point");
  assert.equal(readSnapshots(refusing).length, 1);
});

test("readWallFrom: a corrupt main key falls back to the newest valid snapshot", () => {
  const valid = wall("recovered");
  const storage = fakeStorage({
    "devhub.wall.v1": "{truncated",
    [WALL_SNAPSHOTS_KEY]: JSON.stringify({
      version: 1,
      snapshots: [
        { savedAt: 2_000, wall: "not json" },
        { savedAt: 1_000, wall: valid },
      ],
    }),
  });
  const read = readWallFrom(storage);
  assert.equal(read.recoveredAt, 1_000);
  assert.equal(read.repos["github.com/o/recovered"]?.alias, "recovered");
  assert.equal(read.prefs.sort, "name");
});

test("readWallFrom: a missing main key is a first run, not a snapshot restore", () => {
  const storage = fakeStorage({
    [WALL_SNAPSHOTS_KEY]: JSON.stringify({ snapshots: [{ savedAt: 2_000, wall: wall("old") }] }),
  });
  const read = readWallFrom(storage);
  assert.equal(read.recoveredAt, null);
  assert.deepEqual(read.repos, {});
});

test("readWallFrom: a valid main key wins over an older snapshot", () => {
  const storage = fakeStorage({
    "devhub.wall.v1": wall("current"),
    [WALL_SNAPSHOTS_KEY]: JSON.stringify({ snapshots: [{ savedAt: 2_000, wall: wall("old") }] }),
  });
  const read = readWallFrom(storage);
  assert.equal(read.recoveredAt, null);
  assert.equal(read.repos["github.com/o/current"]?.alias, "current");
});

test("parseStoredWall: non-object payloads are corruption, empty objects are valid defaults", () => {
  assert.equal(parseStoredWall("null"), null);
  assert.equal(parseStoredWall("[]"), null);
  assert.equal(parseStoredWall("42"), null);
  const empty = parseStoredWall("{}");
  assert.ok(empty);
  assert.deepEqual(empty.repos, {});
  assert.equal(empty.prefs.sort, "name");
});

test("wiring: wall persists snapshots, repairs main after recovery, UI exposes restore", () => {
  const wallStore = readFileSync("src/store/wall.ts", "utf8");
  const projects = readFileSync("src/views/ProjectsView.tsx", "utf8");
  const settings = readFileSync("src/views/settings/ProjectsSection.tsx", "utf8");
  assert.match(wallStore, /if \(now - lastSnapshotAt >= WALL_SNAPSHOT_INTERVAL_MS\)/);
  assert.match(wallStore, /captureSnapshot\(json, now\)/);
  assert.match(wallStore, /if \(initial\.recoveredAt !== null\) persist\(useWall\.getState\(\)\)/);
  assert.match(projects, /wallRecoveredAt !== null/);
  assert.match(projects, /wall\.recovered\.dismiss/);
  assert.match(settings, /latestSnapshot\(\)\?\.savedAt/);
  assert.match(settings, /restoreSnapshot\(\)/);
});
