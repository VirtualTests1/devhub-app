import type { DependencyReport } from "../types";

/**
 * Cross-repository dependency rollup (r21-n1b-1).
 *
 * `check_dependencies` answers one repository at a time
 * (`src-tauri/src/deps.rs:42`), and the question this panel exists to answer is
 * cross-repository: *which packages are stale in how many of my repos, and did
 * any repo fail to answer at all*. That question is pure — reports in, model
 * out — so it lives here with no React, no i18n and no IPC, and the tests
 * exercise exactly the rules the settings panel renders
 * (`tests/deps-aggregate.test.ts`).
 *
 * ## Honesty rules baked into the model
 *
 *   - An errored report (`error != null`) is a first-class row, never dropped
 *     and never counted as "up to date": `deps.rs` only sets `error` when it
 *     could not get an answer (missing tool, timeout), so folding those into a
 *     clean total would say "no updates" about a repo nobody asked.
 *   - `manager: ""` is the shape a *rejected probe* is synthesised into by the
 *     scan runner (`lib/deps-scan.ts`) — "no answer at all" is distinct from
 *     `manager: "none"` ("no recognised manifest", an answer).
 *   - The per-package `wanted` / `latest` on a rollup row is the **highest**
 *     reading across the repos that carry it (`highestVersion`), a display
 *     convenience only. Per-repo truth stays in `repos[]`; a repo pinning an
 *     older major must not be able to hide behind the rollup's number.
 *
 * Grouping is by package name alone: the manager is carried on every rollup
 * entry instead, because the same name in two repos of the same ecosystem is
 * the common case (eslint everywhere) and the panel shows the manager per repo.
 */

/** One repository's answer, compacted for the per-repo summary. */
export type DepRepoRow = {
  slug: string;
  manager: string;
  /** Number of outdated entries the backend reported (0 when it errored). */
  outdated: number;
  /** The backend's own words, or null when the answer was clean. */
  error: string | null;
};

/** Per-manager bucket: how many repos use it, how many of those failed. */
export type DepManagerRow = {
  manager: string;
  repos: number;
  errors: number;
  outdated: number;
};

/** One repo's reading of one package inside a rollup row. */
export type DepRollupEntry = {
  slug: string;
  manager: string;
  current: string;
  wanted: string;
  latest: string;
};

/** A package across the fleet: display versions plus every repo that carries it. */
export type DepPackageRow = {
  name: string;
  wanted: string;
  latest: string;
  repos: DepRollupEntry[];
};

export type DepTotals = {
  repos: number;
  managers: number;
  packages: number;
  /** Sum of per-repo outdated counts — one package in two repos counts twice. */
  outdated: number;
  /** Repos whose report carries an error. */
  errors: number;
};

export type DepAggregate = {
  repos: DepRepoRow[];
  managers: DepManagerRow[];
  packages: DepPackageRow[];
  totals: DepTotals;
};

/**
 * One answer per slug, first occurrence's position, last occurrence's value.
 *
 * A double answer can only come from a bug upstream (the scan runner's seq
 * guard exists to prevent it), so the rule is chosen for stability rather than
 * for freshness: rows keep the order the caller passed and the newer value
 * wins, which makes the aggregate idempotent under a re-scan.
 */
export function dedupeReports(reports: readonly DependencyReport[]): DependencyReport[] {
  const bySlug = new Map<string, DependencyReport>();
  for (const r of reports) bySlug.set(r.slug, r);
  return [...bySlug.values()];
}

/** Split a version string into comparable tokens: `2.12.4` → `["2","12","4"]`. */
const versionTokens = (v: string): string[] =>
  v.split(/[^0-9A-Za-z]+/).filter((s) => s.length > 0);

/**
 * A deterministic ordering for version *strings*, not semver.
 *
 * Numeric tokens compare numerically (so `10.13.0` beats `9.39.4`), anything
 * else compares lexically, and a token run that ends early sorts lower. It
 * deliberately does not know about pre-release precedence — `2.12.4-rc1` sorts
 * above `2.12.4` here — because its only job is picking the highest reading
 * across repos for a display cell, and every field that must be *true* keeps
 * its per-repo value next to it.
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionTokens(a);
  const pb = versionTokens(b);
  const shared = Math.min(pa.length, pb.length);
  for (let i = 0; i < shared; i += 1) {
    const ta = pa[i] || "";
    const tb = pb[i] || "";
    const na = /^\d+$/.test(ta) ? Number(ta) : null;
    const nb = /^\d+$/.test(tb) ? Number(tb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  if (pa.length !== pb.length) return pa.length < pb.length ? -1 : 1;
  return 0;
}

/** The highest version string in the list; `""` when the list is empty. */
export function highestVersion(values: readonly string[]): string {
  let best = "";
  for (const v of values) {
    if (best === "" || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** Per-repo rows in input order (deduped), each carrying its own error text. */
export function summarizeRepos(reports: readonly DependencyReport[]): DepRepoRow[] {
  return dedupeReports(reports).map((r) => ({
    slug: r.slug,
    manager: r.manager,
    outdated: r.outdated.length,
    error: r.error,
  }));
}

/**
 * Manager buckets, most repos first (ties broken by name so the order never
 * depends on input order).
 */
export function summarizeManagers(rows: readonly DepRepoRow[]): DepManagerRow[] {
  const byManager = new Map<string, DepManagerRow>();
  for (const row of rows) {
    const cur = byManager.get(row.manager) ?? {
      manager: row.manager,
      repos: 0,
      errors: 0,
      outdated: 0,
    };
    cur.repos += 1;
    if (row.error !== null) cur.errors += 1;
    cur.outdated += row.outdated;
    byManager.set(row.manager, cur);
  }
  return [...byManager.values()].sort(
    (a, b) => b.repos - a.repos || a.manager.localeCompare(b.manager),
  );
}

/** Package rollup in first-seen order; use `sortPackages` for display order. */
export function rollupPackages(reports: readonly DependencyReport[]): DepPackageRow[] {
  const byName = new Map<string, DepPackageRow>();
  for (const r of dedupeReports(reports)) {
    for (const d of r.outdated) {
      const row = byName.get(d.name) ?? { name: d.name, wanted: "", latest: "", repos: [] };
      row.repos.push({
        slug: r.slug,
        manager: r.manager,
        current: d.current,
        wanted: d.wanted,
        latest: d.latest,
      });
      byName.set(d.name, row);
    }
  }
  for (const row of byName.values()) {
    row.wanted = highestVersion(row.repos.map((e) => e.wanted));
    row.latest = highestVersion(row.repos.map((e) => e.latest));
  }
  return [...byName.values()];
}

/**
 * Display order: the packages stale in the most repos first (that is the
 * cross-repo payoff), then alphabetical so a tie is stable.
 */
export function sortPackages(rows: readonly DepPackageRow[]): DepPackageRow[] {
  return [...rows].sort(
    (a, b) => b.repos.length - a.repos.length || a.name.localeCompare(b.name),
  );
}

/**
 * The table cap. A cargo tree can answer hundreds of rows (the real-machine
 * fixture has 298), so the panel shows a head and states how many it is not
 * showing rather than painting them all.
 */
export function limitPackages(
  rows: readonly DepPackageRow[],
  limit: number,
): { shown: DepPackageRow[]; hidden: number } {
  const cap = Math.max(0, Math.floor(limit));
  return { shown: rows.slice(0, cap), hidden: Math.max(0, rows.length - cap) };
}

/** The whole model the panel renders, from one batch of reports. */
export function aggregateDeps(reports: readonly DependencyReport[]): DepAggregate {
  const repos = summarizeRepos(reports);
  const managers = summarizeManagers(repos);
  const packages = sortPackages(rollupPackages(reports));
  return {
    repos,
    managers,
    packages,
    totals: {
      repos: repos.length,
      managers: managers.length,
      packages: packages.length,
      outdated: repos.reduce((n, r) => n + r.outdated, 0),
      errors: repos.filter((r) => r.error !== null).length,
    },
  };
}
