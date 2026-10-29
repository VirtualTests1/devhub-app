#!/usr/bin/env node
/**
 * JSON whole-file vs SQLite state-store benchmark (r31-R4).
 *
 * WHY THIS EXISTS
 *   The backend's small stores (settings, stars, freshness, activity) are JSON
 *   files replaced atomically. That is simple and inspectable, but "JSON will
 *   not scale" is repeated without a number. This script measures the two shapes
 *   on the same machine and same record count:
 *
 *     JSON:    stringify + writeFileSync; readFileSync + parse; rewrite one row
 *     SQLite:  one transaction of prepared inserts; full select; UPDATE one row
 *
 *   It is an experiment, not a proposed dependency. The production app would
 *   use a Rust SQLite crate; this Node built-in (`node:sqlite`, experimental in
 *   Node 22) is used only to keep the benchmark dependency-free and offline.
 *
 * USAGE
 *   node scripts/state-store-bench.mjs [--sizes 1000,10000,100000] [--json]
 *   node scripts/state-store-bench.mjs --quick
 *
 * No network, no repository writes: temp files under the OS temp directory are
 * removed at the end.
 */
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const DEFAULT_SIZES = [1_000, 10_000, 100_000];
const REPS = 3;

function parseArgs(argv) {
  const out = { sizes: DEFAULT_SIZES, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--quick") out.sizes = [200, 2_000];
    else if (a === "--json") out.json = true;
    else if (a === "--sizes") {
      const raw = argv[i + 1];
      i += 1;
      const sizes = (raw ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (!sizes.length) throw new Error("--sizes needs positive integers, e.g. 1000,10000");
      out.sizes = sizes;
    } else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/state-store-bench.mjs [--sizes 1000,10000,100000] [--quick] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

/** One row shaped like a wall/activity record, not a trivial integer. */
export function makeRecords(n) {
  const tags = ["backend", "rust", "web", "tooling"];
  return Array.from({ length: n }, (_, i) => ({
    id: `rec-${i.toString(36)}`,
    slug: `github.com/owner${i % 97}/repo-${i}`,
    alias: `项目 ${i}`,
    note: i % 5 === 0 ? "需要先跑测试" : "",
    tags: [tags[i % tags.length], tags[(i + 1) % tags.length]],
    updatedAt: 1_700_000_000_000 + i,
    pinned: i % 11 === 0,
  }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function msOf(fn) {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

/**
 * Write + fsync. The app's `write_atomic` calls `sync_all` before rename, so a
 * benchmark using bare `writeFileSync` would compare a durable SQLite commit
 * with a non-durable JSON write and flatter JSON for the wrong reason.
 */
function writeDurable(file, text) {
  const fd = openSync(file, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function benchJson(records) {
  const dir = mkdtempSync(join(tmpdir(), "devhub-state-json-"));
  const file = join(dir, "state.json");
  const writes = [];
  const reads = [];
  try {
    for (let r = 0; r < REPS; r += 1) writes.push(msOf(() => writeDurable(file, JSON.stringify(records))).ms);
    for (let r = 0; r < REPS; r += 1) reads.push(msOf(() => JSON.parse(readFileSync(file, "utf8"))).ms);
    const update = [];
    let parsed = JSON.parse(readFileSync(file, "utf8"));
    for (let r = 0; r < REPS; r += 1) {
      const next = parsed.map((row, i) => (i === records.length >> 1 ? { ...row, note: `touch ${r}` } : row));
      update.push(msOf(() => writeDurable(file, JSON.stringify(next))).ms);
      parsed = next;
    }
    return {
      bytes: statSync(file).size,
      writeMs: median(writes),
      readMs: median(reads),
      updateOneMs: median(update),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function benchSqlite(records) {
  const dir = mkdtempSync(join(tmpdir(), "devhub-state-sqlite-"));
  const file = join(dir, "state.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA synchronous = FULL");
    db.exec(`
      CREATE TABLE records (
        id TEXT PRIMARY KEY, slug TEXT, alias TEXT, note TEXT, tags TEXT,
        updated_at INTEGER, pinned INTEGER
      );
    `);
    const insert = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertAll = () => {
      db.exec("BEGIN");
      for (const row of records) {
        insert.run(row.id, row.slug, row.alias, row.note, row.tags.join(","), row.updatedAt, row.pinned ? 1 : 0);
      }
      db.exec("COMMIT");
    };
    const write = [];
    for (let r = 0; r < REPS; r += 1) {
      db.exec("DELETE FROM records");
      write.push(msOf(insertAll).ms);
    }
    const read = [];
    const select = db.prepare("SELECT * FROM records ORDER BY id");
    for (let r = 0; r < REPS; r += 1) read.push(msOf(() => select.all()).ms);
    const updateStmt = db.prepare("UPDATE records SET note = ? WHERE id = ?");
    const middle = records[records.length >> 1];
    const update = [];
    for (let r = 0; r < REPS; r += 1) {
      update.push(msOf(() => updateStmt.run(`touch ${r}`, middle.id)).ms);
    }
    return {
      bytes: statSync(file).size,
      writeMs: median(write),
      readMs: median(read),
      updateOneMs: median(update),
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fmt(ms) {
  return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms).toString();
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`state-store-bench: ${e.message}`);
    return 2;
  }
  if (!existsSync(tmpdir())) {
    console.error("state-store-bench: no OS temp directory");
    return 2;
  }
  const rows = [];
  for (const n of args.sizes) {
    const records = makeRecords(n);
    const json = benchJson(records);
    const sqlite = benchSqlite(records);
    rows.push({ records: n, json, sqlite });
  }
  if (args.json) {
    console.log(JSON.stringify({ reps: REPS, rows }, null, 2));
    return 0;
  }
  console.log(`state-store benchmark (median of ${REPS}, temp files removed)`);
  console.log("records | JSON write | JSON read | JSON update-one | JSON bytes | SQLite write | SQLite read | SQLite update-one | SQLite bytes");
  for (const r of rows) {
    console.log(
      `${r.records} | ${fmt(r.json.writeMs)} ms | ${fmt(r.json.readMs)} ms | ${fmt(r.json.updateOneMs)} ms | ${r.json.bytes} | ${fmt(r.sqlite.writeMs)} ms | ${fmt(r.sqlite.readMs)} ms | ${fmt(r.sqlite.updateOneMs)} ms | ${r.sqlite.bytes}`,
    );
  }
  console.log("note: this is a Node-built-in experiment, not a dependency decision; see docs/research/state-store.md");
  return 0;
}

process.exitCode = main();
