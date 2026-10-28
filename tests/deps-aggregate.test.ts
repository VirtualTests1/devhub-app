/**
 * r21-n1b-1 — the cross-repository dependency rollup, pinned as pure rules.
 *
 * The panel (`src/views/settings/DepsUpdateSection.tsx`, r21-n1b-2) renders
 * whatever this module answers, so these tests are the ones that decide what a
 * number on screen means. Three of the cases are built from the real-machine
 * fixtures under `tests/fixtures/deps/` — the same files `tests/deps-fixtures.test.ts`
 * guards and `src-tauri/src/deps.rs` parses with `include_str!` — so the model
 * is exercised on the shapes this repo actually receives (npm's keyed map,
 * pnpm's lockfile-wanted rows, uv/pip's array, pip's zero-row answer), not on
 * invents. The mapping from fixture row to `Dependency` mirrors `parse_npm_outdated`
 * (`deps.rs:272`) and `parse_pip_outdated` (`deps.rs:292`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  aggregateDeps,
  compareVersions,
  dedupeReports,
  highestVersion,
  limitPackages,
  rollupPackages,
  sortPackages,
  summarizeManagers,
  summarizeRepos,
} from "../src/lib/deps-aggregate.ts";
import type { Dependency, DependencyReport } from "../src/types.ts";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "deps");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** One backend answer, spelled out so each test states its own input. */
function report(
  slug: string,
  manager: string,
  outdated: Dependency[] = [],
  error: string | null = null,
): DependencyReport {
  return { slug, manager, outdated, error };
}

const dep = (name: string, current: string, wanted: string, latest: string): Dependency => ({
  name,
  current,
  wanted,
  latest,
});

// ---------------------------------------------------------------------------

test("aggregate: empty input answers an empty model, not null and not a guess", () => {
  const agg = aggregateDeps([]);
  assert.deepEqual(agg.repos, []);
  assert.deepEqual(agg.managers, []);
  assert.deepEqual(agg.packages, []);
  assert.deepEqual(agg.totals, { repos: 0, managers: 0, packages: 0, outdated: 0, errors: 0 });
});

test("aggregate: the same package in two repos is one row carrying both", () => {
  const a = report("github.com/a/web", "npm", [
    dep("eslint", "9.39.4", "9.39.4", "10.13.0"),
    dep("react", "18.2.0", "18.2.0", "19.0.0"),
  ]);
  const b = report("github.com/b/web", "npm", [
    dep("eslint", "8.57.0", "8.57.0", "10.13.0"),
    dep("vue", "3.4.0", "3.4.0", "3.5.0"),
  ]);
  const agg = aggregateDeps([a, b]);

  assert.equal(agg.totals.repos, 2);
  assert.equal(agg.totals.outdated, 4, "two repos × two entries each");
  assert.equal(agg.totals.packages, 3, "eslint merged; react and vue stay separate");

  const eslint = agg.packages.find((p) => p.name === "eslint");
  assert.ok(eslint, "eslint is a rollup row");
  assert.equal(eslint.repos.length, 2, "both repos listed, neither dropped");
  assert.deepEqual(
    eslint.repos.map((r) => r.slug),
    ["github.com/a/web", "github.com/b/web"],
    "rollup entries keep the caller's repo order",
  );
  assert.equal(eslint.latest, "10.13.0", "display latest is the highest reading");
  assert.equal(
    eslint.repos.find((r) => r.slug === "github.com/b/web")?.current,
    "8.57.0",
    "per-repo truth survives next to the display number",
  );

  const npm = agg.managers.find((m) => m.manager === "npm");
  assert.ok(npm);
  assert.deepEqual(npm, { manager: "npm", repos: 2, errors: 0, outdated: 4 });
});

test("aggregate: an errored report is a row of its own, never an up-to-date repo", () => {
  const ok = report("github.com/a/tool", "npm", [dep("left-pad", "1.0.0", "1.0.0", "1.3.0")]);
  const noTool = report("github.com/b/rust", "cargo", [], "未安装 cargo-outdated（cargo 不认识 `outdated` 子命令）");
  const noAnswer = report("github.com/c/py", "", [], "spawn ENOENT");

  const agg = aggregateDeps([ok, noTool, noAnswer]);
  assert.equal(agg.totals.repos, 3);
  assert.equal(agg.totals.errors, 2, "both failures counted");
  assert.equal(agg.totals.outdated, 1, "the failed repos contribute no phantom rows");

  const rows = summarizeRepos([ok, noTool, noAnswer]);
  assert.equal(rows[1]?.error, "未安装 cargo-outdated（cargo 不认识 `outdated` 子命令）", "backend words carried through");
  assert.equal(rows[2]?.manager, "", "a rejected probe reads as manager empty — no answer, not \"none\"");

  // "" is its own bucket: 「没答话」 must not borrow the meaning of "none".
  const managers = agg.managers.map((m) => [m.manager, m.repos, m.errors]);
  assert.deepEqual(managers, [
    ["", 1, 1],
    ["cargo", 1, 1],
    ["npm", 1, 0],
  ]);
});

test("aggregate: manager \"none\" is an answer and stays its own bucket", () => {
  const agg = aggregateDeps([report("github.com/a/docs", "none")]);
  assert.equal(agg.totals.repos, 1);
  assert.equal(agg.totals.errors, 0, "no manifest is not a failure");
  assert.deepEqual(agg.managers, [{ manager: "none", repos: 1, errors: 0, outdated: 0 }]);
});

test("sorting: widest package first, ties alphabetical; managers by repo count", () => {
  const r1 = report("github.com/a/1", "npm", [dep("vue", "3.4.0", "3.4.0", "3.5.0")]);
  const r2 = report("github.com/a/2", "npm", [
    dep("vue", "3.4.0", "3.4.0", "3.5.0"),
    dep("eslint", "9.0.0", "9.0.0", "10.0.0"),
  ]);
  const r3 = report("github.com/a/3", "pnpm", [
    dep("vue", "3.4.0", "3.4.0", "3.5.0"),
    dep("eslint", "9.0.0", "9.0.0", "10.0.0"),
    dep("react", "18.0.0", "18.0.0", "19.0.0"),
  ]);
  const r4 = report("github.com/a/4", "pnpm", [
    dep("vue", "3.4.0", "3.4.0", "3.5.0"),
    dep("eslint", "9.0.0", "9.0.0", "10.0.0"),
    dep("react", "18.0.0", "18.0.0", "19.0.0"),
  ]);
  const agg = aggregateDeps([r1, r2, r3, r4]);
  assert.deepEqual(
    agg.packages.map((p) => [p.name, p.repos.length]),
    [
      ["vue", 4],
      ["eslint", 3],
      ["react", 2],
    ],
    "repo count desc, then name asc",
  );
  // Managers: npm 2 repos, pnpm 2 repos — tie broken by name.
  assert.deepEqual(
    agg.managers.map((m) => `${m.manager}:${m.repos}`),
    ["npm:2", "pnpm:2"],
    "manager buckets are stable regardless of input order",
  );
  const reordered = summarizeManagers(summarizeRepos([r3, r1, r4, r2]));
  assert.deepEqual(
    reordered.map((m) => `${m.manager}:${m.repos}`),
    ["npm:2", "pnpm:2"],
    "reordered input, same buckets",
  );
});

test("limit: the table head is shown and the rest is counted, not silently cut", () => {
  const one = (name: string) => report(`github.com/a/${name}`, "npm", [dep(name, "1.0.0", "1.0.0", "2.0.0")]);
  const rows = sortPackages(rollupPackages([one("a"), one("b"), one("c"), one("d")]));
  const { shown, hidden } = limitPackages(rows, 2);
  assert.equal(shown.length, 2);
  assert.equal(hidden, 2, "the panel states how many rows it is not drawing");
  assert.equal(limitPackages(rows, 0).hidden, 4, "limit 0 hides everything, keeps the count");
  assert.deepEqual(limitPackages(rows, 99).hidden, 0);
});

test("dedupe: one answer per slug — last value wins, first position kept", () => {
  const first = report("github.com/a/web", "npm", [dep("eslint", "9.0.0", "9.0.0", "9.5.0")]);
  const second = report("github.com/a/web", "npm", [dep("eslint", "9.5.0", "9.5.0", "10.0.0")]);
  const other = report("github.com/b/web", "npm", []);
  const out = dedupeReports([first, second, other]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.outdated[0]?.latest, "10.0.0", "the later answer supersedes");
  assert.deepEqual(
    out.map((r) => r.slug),
    ["github.com/a/web", "github.com/b/web"],
    "position of the first occurrence is stable",
  );
  assert.equal(aggregateDeps([first, second, other]).totals.repos, 2, "aggregate dedupes too");
});

test("versions: numeric-aware compare, and highest picks the top reading", () => {
  assert.ok(compareVersions("9.39.4", "10.13.0") < 0, "9 < 10 as numbers, not as strings");
  assert.ok(compareVersions("2", "10") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.2", "1.2.1") < 0, "a shorter run sorts lower");
  assert.ok(compareVersions("2.12.4", "2.12.4-rc1") < 0, "documented non-semver corner: extra token sorts higher");
  assert.equal(highestVersion(["2.31.0", "2.34.2", "1.99.0"]), "2.34.2");
  assert.equal(highestVersion([]), "");
  assert.equal(highestVersion(["1.0.0"]), "1.0.0");
});

// ---------------------------------------------------------------------------
// Fixture-based case: the real-machine shapes, through the same mapping the
// Rust parsers apply (deps.rs:272 npm/pnpm map, deps.rs:292 uv/pip array).
// ---------------------------------------------------------------------------

type FixtureNpmRow = { current: string; wanted: string; latest: string };

function npmRows(file: string): Dependency[] {
  const map = JSON.parse(read(file)) as Record<string, FixtureNpmRow>;
  return Object.entries(map).map(([name, v]) => dep(name, v.current, v.wanted, v.latest));
}

type FixturePipRow = { name: string; version: string; latest_version: string };

function pipRows(file: string): Dependency[] {
  const arr = JSON.parse(read(file)) as FixturePipRow[];
  return arr.map((v) => dep(v.name, v.version, v.latest_version, v.latest_version));
}

test("fixture case: npm+pnpm+uv+pip reports aggregate the way the panel will read them", () => {
  const npmDeps = npmRows("npm-outdated.json");
  const pnpmDeps = npmRows("pnpm-outdated.json");
  const uvDeps = pipRows("uv-outdated.json");
  const pipDeps = pipRows("pip-outdated.json");

  assert.equal(npmDeps.length, 12, "真机 12 条（tests/deps-fixtures.test.ts 同一读数）");
  assert.equal(pnpmDeps.length, 12);
  assert.equal(uvDeps.length, 1);
  assert.equal(pipDeps.length, 0, "pip 真机 0 条");

  const agg = aggregateDeps([
    report("github.com/devhub/app", "npm", npmDeps),
    report("github.com/devhub/web", "pnpm", pnpmDeps),
    report("github.com/devhub/ops", "uv", uvDeps),
    report("github.com/devhub/sys", "pip", pipDeps),
  ]);

  assert.deepEqual(agg.totals, {
    repos: 4,
    managers: 4,
    packages: new Set([...npmDeps, ...pnpmDeps, ...uvDeps].map((d) => d.name)).size,
    outdated: 25,
    errors: 0,
  });

  // npm's wanted is the range-latest (eslint held at 9.39.4 while 10.13.0 is
  // out). The same package name also sits in the pnpm fixture, so the rollup
  // row carries BOTH readings — per-repo truth stays distinct.
  const eslint = agg.packages.find((p) => p.name === "eslint");
  assert.ok(eslint);
  assert.equal(eslint.repos.length, 2, "eslint appears in the npm and the pnpm fixture");
  const npmEslint = eslint.repos.find((r) => r.manager === "npm");
  assert.deepEqual(npmEslint, {
    slug: "github.com/devhub/app",
    manager: "npm",
    current: "9.39.4",
    wanted: "9.39.4",
    latest: "10.13.0",
  });
  assert.equal(
    eslint.repos.find((r) => r.manager === "pnpm")?.wanted,
    "9.39.4",
    "pnpm 的 wanted = lockfile 版本 —— 与 npm 的 range-latest 各记各的",
  );

  // pnpm's wanted obeys the lockfile (= current) — the same package name in
  // the npm fixture reads differently (wanted = range-latest), and the rollup
  // keeps both readings apart.
  const api = agg.packages.find((p) => p.name === "@tauri-apps/api");
  assert.ok(api);
  assert.equal(api.repos.length, 2);
  const pnpmApi = api.repos.find((r) => r.manager === "pnpm");
  assert.ok(pnpmApi);
  assert.equal(pnpmApi.current, "2.12.1");
  assert.equal(pnpmApi.wanted, pnpmApi.current, "pnpm 的 wanted = lockfile 版本");
  assert.equal(pnpmApi.latest, "2.12.4");
  assert.equal(
    api.repos.find((r) => r.manager === "npm")?.wanted,
    "2.12.4",
    "npm 侧的 wanted 是 range-latest —— 两个读数并存，不互相覆盖",
  );

  // uv/pip: wanted falls back to latest_version (parse_pip_outdated's rule).
  const requests = agg.packages.find((p) => p.name === "requests");
  assert.ok(requests);
  assert.equal(requests.repos[0]?.manager, "uv");
  assert.equal(requests.repos[0]?.current, "2.31.0");
  assert.equal(requests.repos[0]?.wanted, "2.34.2");
  assert.equal(requests.latest, "2.34.2");

  // The zero-row pip repo still appears as a scanned repo.
  const sys = agg.repos.find((r) => r.slug === "github.com/devhub/sys");
  assert.deepEqual(sys, { slug: "github.com/devhub/sys", manager: "pip", outdated: 0, error: null });
});
