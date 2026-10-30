/**
 * Aggregate health view: counts and ordering, kept out of the card.
 *
 * The backend already returns stable issue codes and severities. This layer only
 * decides what the collection-level sentence is - how many repositories are
 * clean, how many have a warning, which issue is most common - so the card does
 * not re-derive numbers in JSX and the rules are testable without a renderer.
 */
import type { HealthIssue, HealthOverview, HealthRow } from "../types";

export type HealthSummary = {
  total: number;
  clean: number;
  errors: number;
  warnings: number;
  infos: number;
  /** Issue code -> number of repositories carrying it, most frequent first. */
  byIssue: [string, number][];
};

const SEVERITIES = ["error", "warn", "info"] as const;

export function summarizeHealth(rows: readonly HealthRow[]): HealthSummary {
  let clean = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const severe = row.issues.filter((i) => i.severity === "error").length;
    const warn = row.issues.filter((i) => i.severity === "warn").length;
    const info = row.issues.filter((i) => i.severity === "info").length;
    errors += severe;
    warnings += warn;
    infos += info;
    if (severe === 0 && warn === 0) clean += 1;
    for (const issue of row.issues) {
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
  }
  const byIssue = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { total: rows.length, clean, errors, warnings, infos, byIssue };
}

/** Highest severity first, then slug; the card paints this order. */
export function sortHealthRows(rows: readonly HealthRow[]): HealthRow[] {
  const rank = (row: HealthRow) => {
    if (row.issues.some((i) => i.severity === "error")) return 0;
    if (row.issues.some((i) => i.severity === "warn")) return 1;
    if (row.issues.length > 0) return 2;
    return 3;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
}

export function worstSeverity(row: HealthRow): "error" | "warn" | "info" | "ok" {
  for (const severity of SEVERITIES) {
    if (row.issues.some((i) => i.severity === severity)) return severity;
  }
  return "ok";
}

export function issueCodes(row: HealthRow): string[] {
  return row.issues.map((i) => i.code);
}

export { type HealthIssue, type HealthOverview, type HealthRow };
