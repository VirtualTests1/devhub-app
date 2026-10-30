import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sortHealthRows,
  summarizeHealth,
  worstSeverity,
} from "../src/lib/health-overview";
import type { HealthRow } from "../src/types";

function row(slug: string, issues: HealthRow["issues"]): HealthRow {
  return {
    slug,
    path: `D:/container/${slug}`,
    markerState: "valid",
    hasGit: true,
    branch: "main",
    detached: false,
    upstream: "origin/main",
    dirty: 0,
    hasReadme: true,
    hasLaunch: true,
    venvState: "none",
    issues,
  };
}

test("summary keeps clean repositories apart from warnings and errors", () => {
  const s = summarizeHealth([
    row("a/clean", []),
    row("b/warn", [{ code: "dirty", severity: "warn", detail: null }]),
    row("c/error", [
      { code: "marker", severity: "error", detail: null },
      { code: "dirty", severity: "warn", detail: null },
    ]),
    row("d/info", [{ code: "no-launch", severity: "info", detail: null }]),
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.clean, 2, "an info-only repository needs no attention");
  assert.equal(s.errors, 1);
  assert.equal(s.warnings, 2);
  assert.equal(s.infos, 1);
  assert.deepEqual(s.byIssue, [
    ["dirty", 2],
    ["marker", 1],
    ["no-launch", 1],
  ]);
});

test("rows sort error, warn, info, clean and tie-break by slug", () => {
  const rows = [
    row("z/clean", []),
    row("b/info", [{ code: "no-launch", severity: "info", detail: null }]),
    row("a/warn", [{ code: "dirty", severity: "warn", detail: null }]),
    row("c/error", [{ code: "marker", severity: "error", detail: null }]),
  ];
  assert.deepEqual(
    sortHealthRows(rows).map((r) => r.slug),
    ["c/error", "a/warn", "b/info", "z/clean"],
  );
});

test("worstSeverity reports the highest issue, or ok", () => {
  assert.equal(worstSeverity(row("x", [])), "ok");
  assert.equal(worstSeverity(row("x", [{ code: "no-launch", severity: "info", detail: null }])), "info");
  assert.equal(worstSeverity(row("x", [{ code: "dirty", severity: "warn", detail: null }])), "warn");
  assert.equal(worstSeverity(row("x", [{ code: "marker", severity: "error", detail: null }])), "error");
});
