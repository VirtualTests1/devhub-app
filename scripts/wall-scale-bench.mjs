// Wall derivation at scale: one reproducible measurement of the pure pipeline.
//
// `Views/ProjectsView.tsx` runs filter → tier sort → group on every keystroke and
// on every wall state change. The pipeline is pure (`src/lib/wall-derive.ts`), so
// it can be measured without a renderer; what this script adds is a *synthetic*
// wall large enough that a regression would show up, and a per-stage breakdown so
// the next change knows what it is paying for.
//
// Nothing here asserts a budget — a number from this machine is not a contract for
// another one. It prints a table and exits 0; the research note records the
// measured values and the date.
//
//   node --experimental-strip-types scripts/wall-scale-bench.mjs [--cards 2000] [--runs 30]

import { performance } from "node:perf_hooks";
import {
  filterWallCards,
  groupCardsByOwner,
  tierSortCards,
} from "../src/lib/wall-derive.ts";

const argv = process.argv.slice(2);
const opt = { cards: 2000, runs: 30 };
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const next = Number(argv[++i]);
  if (flag === "--cards" && Number.isFinite(next) && next > 0) opt.cards = next;
  else if (flag === "--runs" && Number.isFinite(next) && next > 0) opt.runs = next;
  else {
    console.error(`wall-scale-bench.mjs: unrecognised argument '${flag}' (accepted: --cards --runs)`);
    process.exit(2);
  }
}

const LANGUAGES = ["Rust", "TypeScript", "Python", "Go", "C#", "Java"];
const CATEGORIES = ["rust", "node", "python", "go", "dotnet", "java", "unknown"];

function cards(n) {
  return Array.from({ length: n }, (_, i) => ({
    slug: `github.com/owner${i % 40}/project${i}`,
    owner: `owner${i % 40}`,
    repo: `project${i}`,
    path: `D:/container/owner${i % 40}/project${i}`,
    description: i % 7 === 0 ? null : `A synthetic project number ${i} for scale measurement`,
  }));
}

const list = cards(opt.cards);
const states = Object.fromEntries(
  list.map((c, i) => [
    c.slug,
    {
      alias: i % 5 === 0 ? `alias-${i}` : undefined,
      tags: i % 3 === 0 ? ["tools", "archive"] : ["tools"],
      note: i % 11 === 0 ? "a note that must be searched" : undefined,
    },
  ]),
);
const usage = Object.fromEntries(
  list.map((c, i) => [`repo:${c.slug}`, { count: i % 17, last: 1_700_000_000_000 + i * 1000 }]),
);
const metaBySlug = Object.fromEntries(
  list.map((c, i) => [
    c.slug,
    {
      slug: c.slug,
      installedAt: 1_700_000_000_000 + i * 60_000,
      sizeBytes: (i % 20) * 1_000_000,
      language: LANGUAGES[i % LANGUAGES.length],
      category: CATEGORIES[i % CATEGORIES.length],
      hasCache: i % 4 === 0,
    },
  ]),
);
const heatByOwnerRepo = Object.fromEntries(
  list.map((c, i) => [`${c.owner}/${c.repo}`, { stars: (i * 37) % 5000 }]),
);

/** A `Set`-like object rather than a Set so the fixture mirrors the view's shape. */
const running = { has: (slug) => usage[`repo:${slug}`].count % 5 === 0 };
const filterCtx = {
  query: "project1",
  filter: "all",
  states,
  usage,
  running,
  activeTags: ["tools"],
  metaBySlug,
};
const sortCtx = {
  sort: "recent",
  usage,
  metaBySlug,
  nowMs: 1_710_000_000_000,
  heatByOwnerRepo,
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bench(label, fn) {
  for (let i = 0; i < 5; i += 1) fn(); // warm-up
  const times = [];
  for (let i = 0; i < opt.runs; i += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  console.log(`${label.padEnd(34)} median=${median(times).toFixed(2)} ms  p95=${times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)].toFixed(2)} ms`);
}

console.log(`cards=${opt.cards} runs=${opt.runs} node=${process.version}`);
bench("filter (query + tag)", () => filterWallCards(list, filterCtx));
const filtered = filterWallCards(list, filterCtx);
for (const sort of ["name", "recent", "frequent", "size", "stars", "desc", "owner", "cache"]) {
  bench(`tierSort:${sort}`, () => tierSortCards(filtered, { ...sortCtx, sort }));
}
const sorted = tierSortCards(filtered, sortCtx);
bench("group by owner", () => groupCardsByOwner(sorted));
bench("full pipeline", () => groupCardsByOwner(tierSortCards(filterWallCards(list, filterCtx), sortCtx)));
