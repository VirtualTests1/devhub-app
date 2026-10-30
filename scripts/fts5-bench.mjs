// Local search bakeoff: walking + literal scan vs SQLite FTS5 trigram (r34-D9).
//
// The app's cross-repo search walks each repository and runs a literal/regex match
// per line. This experiment asks whether a persistent FTS5 index would pay for
// itself on the same corpus shape, using Node's built-in SQLite (experimental on
// 22.19) so no dependency is added just to measure.
//
//   node --experimental-sqlite scripts/fts5-bench.mjs [--files 1000] [--queries 20]
//
// The corpus and database live under `.pack/` (gitignored). Numbers are printed,
// not asserted: one machine's result is a decision input, not a contract.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const opt = { files: 1000, queries: 20 };
for (let i = 0; i < argv.length; i += 1) {
  const next = Number(argv[++i]);
  if (argv[i - 1] === "--files" && Number.isFinite(next) && next > 0) opt.files = next;
  else if (argv[i - 1] === "--queries" && Number.isFinite(next) && next > 0) opt.queries = next;
  else {
    console.error("fts5-bench.mjs: accepted: --files N --queries N");
    process.exit(2);
  }
}

const root = resolve(".pack/fts-corpus");
const dbPath = resolve(".pack/fts5-bench.db");
for (const p of [root, dbPath]) rmSync(p, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// Deterministic corpus: 200 words, zipf-ish reuse, plus a unique token per file so
// a query can be made arbitrarily narrow.
const WORDS = Array.from({ length: 200 }, (_, i) => `word${String(i).padStart(3, "0")}`);
let seed = 0x12345678;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const files = [];
for (let f = 0; f < opt.files; f += 1) {
  const path = join(root, `dir${f % 40}`, `file${String(f).padStart(4, "0")}.txt`);
  mkdirSync(join(root, `dir${f % 40}`), { recursive: true });
  const lines = [];
  for (let l = 0; l < 60; l += 1) {
    const words = Array.from({ length: 8 }, () => WORDS[Math.floor(rnd() * WORDS.length)]);
    lines.push(words.join(" "));
  }
  lines.push(`unique_token_${f}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  files.push(path);
}

const queries = Array.from({ length: opt.queries }, (_, i) => WORDS[i * 7]);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function baseline(query) {
  const needle = query.toLowerCase();
  let hits = 0;
  for (const path of files) {
    const text = readFileSync(path, "utf8").toLowerCase();
    for (const line of text.split("\n")) if (line.includes(needle)) hits += 1;
  }
  return hits;
}

const baselineTimes = [];
let baselineHits = 0;
for (const q of queries) {
  for (let w = 0; w < 2; w += 1) baseline(q); // warm file cache
  const times = [];
  for (let r = 0; r < 3; r += 1) {
    const t = performance.now();
    baselineHits += baseline(q);
    times.push(performance.now() - t);
  }
  baselineTimes.push(median(times));
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, body, tokenize='trigram')");
const insert = db.prepare("INSERT INTO docs(path, body) VALUES (?, ?)");
const buildStart = performance.now();
db.exec("BEGIN");
for (const path of files) insert.run(path, readFileSync(path, "utf8"));
db.exec("COMMIT");
const buildMs = performance.now() - buildStart;

const select = db.prepare("SELECT count(*) AS c FROM docs WHERE docs MATCH ?");
const queryTimes = [];
let ftsHits = 0;
for (const q of queries) {
  select.get(q);
  const times = [];
  for (let r = 0; r < 10; r += 1) {
    const t = performance.now();
    ftsHits += Number(select.get(q).c);
    times.push(performance.now() - t);
  }
  queryTimes.push(median(times));
}

// Incremental cost: ten new files, which is what a day's edits look like at this
// corpus scale, and one delete.
const incStart = performance.now();
db.exec("BEGIN");
for (let i = 0; i < 10; i += 1) insert.run(`incremental${i}`, `incremental word000 unique_token_inc${i}`);
db.exec("COMMIT");
const incrementalMs = performance.now() - incStart;
const deleteStart = performance.now();
db.prepare("DELETE FROM docs WHERE path = ?").run(files[0]);
const deleteMs = performance.now() - deleteStart;

const dbBytes = statSync(dbPath).size;
const walBytes = statSync(`${dbPath}-wal`).size;
const fileBytes = files.reduce((n, p) => n + statSync(p).size, 0);
db.close();

console.log(JSON.stringify({
  files: opt.files,
  fileBytes,
  queries: opt.queries,
  baselineMedianMs: median(baselineTimes),
  ftsMedianMs: median(queryTimes),
  buildMs,
  incremental10FilesMs: incrementalMs,
  deleteOneMs: deleteMs,
  dbBytes,
  walBytes,
  baselineHits,
  ftsHits,
  note: "hits are not comparable: baseline counts matching lines, FTS5 counts matching files",
}, null, 2));
