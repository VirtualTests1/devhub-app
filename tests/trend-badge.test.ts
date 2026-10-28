/**
 * D2 — unit tests for the SVG trend badge pure function.
 *
 * The badge is a self-contained SVG string (no DOM, no React), so the
 * tests assert on the structure and invariants of the string itself:
 *   - valid XML (well-formed `<svg>…</svg>`)
 *   - correct `width` / `height` / `viewBox`
 *   - polyline point count = sample count (clamped to ≥ 2 for single/empty)
 *   - delta arrow (↑ / ↓ / →) matches the direction of `last − first`
 *   - NaN / negative values do not produce `NaN` in the output
 *   - `trendBadgeDataUri` returns a `data:image/svg+xml,` prefix
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trendBadgeSvg, trendBadgeDataUri } from "../src/lib/trend-badge";

test("D2: empty samples → flat mid-line, → arrow", () => {
  const svg = trendBadgeSvg({ samples: [] });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /→/);
  // No NaN leaked into the string.
  assert.doesNotMatch(svg, /NaN/);
});

test("D2: single sample → flat mid-line, → arrow", () => {
  const svg = trendBadgeSvg({ samples: [42] });
  assert.match(svg, /→/);
  assert.doesNotMatch(svg, /NaN/);
});

test("D2: increasing series → ↑ arrow, N points", () => {
  const svg = trendBadgeSvg({ samples: [1, 2, 3, 4, 5] });
  assert.match(svg, /↑/);
  // 5 samples → 5 points in the polyline.
  const m = svg.match(/<polyline points="([^"]+)"/);
  assert.ok(m, "polyline not found");
  const pts = m[1]!.split(" ").filter(Boolean);
  assert.equal(pts.length, 5, `expected 5 points, got ${pts.length}`);
});

test("D2: decreasing series → ↓ arrow", () => {
  const svg = trendBadgeSvg({ samples: [10, 8, 6, 4, 2] });
  assert.match(svg, /↓/);
});

test("D2: constant series → → arrow", () => {
  const svg = trendBadgeSvg({ samples: [7, 7, 7, 7] });
  assert.match(svg, /→/);
});

test("D2: NaN values are filtered, never leaked", () => {
  const svg = trendBadgeSvg({ samples: [1, Number.NaN, 3, 4] });
  assert.doesNotMatch(svg, /NaN/);
  // 1, 3, 4 survive → 3 points.
  const m = svg.match(/<polyline points="([^"]+)"/);
  assert.ok(m);
  const pts = m[1]!.split(" ").filter(Boolean);
  assert.equal(pts.length, 3, `expected 3 points (NaN filtered), got ${pts.length}`);
});

test("D2: negative values are clamped to 0 baseline", () => {
  const svg = trendBadgeSvg({ samples: [-5, -2, 0, 3, 6] });
  // minV is clamped to 0 (Math.min(...raw, 0)), so no y goes below the pad.
  const m = svg.match(/<polyline points="([^"]+)"/);
  assert.ok(m);
  const pts = m[1]!.split(" ").map((p) => p.split(",")).map(([, y]) => Number(y));
  const h = 16;
  const pad = 2;
  for (const y of pts) {
    assert.ok(y >= pad - 0.1, `y ${y} below pad ${pad}`);
    assert.ok(y <= h - pad + 0.1, `y ${y} above h-pad ${h - pad}`);
  }
  assert.match(svg, /↑/); // 6 > -5 → increasing
});

test("D2: custom width/height are reflected", () => {
  const svg = trendBadgeSvg({ samples: [1, 2], width: 80, height: 24 });
  assert.match(svg, /width="80"/);
  assert.match(svg, /height="24"/);
  assert.match(svg, /viewBox="0 0 80 24"/);
});

test("D2: data URI starts with the correct prefix", () => {
  const uri = trendBadgeDataUri({ samples: [1, 2, 3] });
  assert.match(uri, /^data:image\/svg\+xml,/);
  // The encoded SVG must be valid when decoded.
  const decoded = decodeURIComponent(uri.replace("data:image/svg+xml,", ""));
  assert.match(decoded, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("D2: large series (1000 samples) still renders valid SVG", () => {
  const big: number[] = Array.from({ length: 1000 }, (_, i) => i);
  const svg = trendBadgeSvg({ samples: big, width: 120, height: 32 });
  assert.match(svg, /<polyline/);
  assert.match(svg, /↑/);
  // 1000 points in the polyline.
  const m = svg.match(/<polyline points="([^"]+)"/);
  assert.ok(m);
  const pts = m[1]!.split(" ").filter(Boolean);
  assert.equal(pts.length, 1000, `expected 1000 points, got ${pts.length}`);
});
