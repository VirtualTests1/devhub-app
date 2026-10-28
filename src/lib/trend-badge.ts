/**
 * D2 — SVG trend badge: a pure function that renders a sparkline-style SVG
 * badge from a series of numeric samples (e.g. star counts across N days).
 *
 * Design constraints from `freshness-scan.ts:6-15`:
 *   - No DOM / no React: the badge is an SVG *string* the caller can drop
 *     into a `<foreignObject>` or an `<img>` data-URI.
 *   - No network: the samples come from local data the caller already holds.
 *   - No mutation: the function is total — any input shape (empty series,
 *     single point, constant series, NaN, negative values) returns a
 *     valid, self-contained SVG string.
 *
 * The badge answers one question at a glance: "is this number trending
 * up, down, or flat over the last N samples?" A 48×16 px rounded-rect
 * with a mini polyline and a delta arrow (↑ / ↓ / →).
 */

// ---------------------------------------------------------------------------
// Types

/** A single time-ordered sample. */
export type TrendSample = number;

export interface TrendBadgeOptions {
  /** Number of samples to include in the sparkline. Default: all. */
  samples?: TrendSample[];
  /** Badge width in px. Default 48. */
  width?: number;
  /** Badge height in px. Default 16. */
  height?: number;
  /** Fill colour for the badge background. Default `var(--card)`. */
  bg?: string;
  /** Stroke colour for the polyline. Default `var(--foreground)`. */
  fg?: string;
  /** Line thickness. Default 1.2. */
  strokeWidth?: number;
}

// ---------------------------------------------------------------------------
// Pure function

/**
 * Returns a complete, self-contained `<svg>` element as a string.
 *
 * The SVG carries its own `xmlns` so it can be inlined into an `<img>`
 * data-URI (`data:image/svg+xml,${encodeURIComponent(svg)}`) or pasted
 * directly into JSX via `dangerouslySetInnerHTML`.
 *
 * Edge cases:
 *   - empty / single-point series → flat line at mid-height, "→"
 *   - all-equal series → flat line, "→"
 *   - any NaN in the series → treated as 0 for the polyline; badge still
 *     renders (never throws)
 *   - negative values → clamped to the top of the badge (min = 0 baseline)
 */
export function trendBadgeSvg(opts: TrendBadgeOptions = {}): string {
  const w = opts.width ?? 48;
  const h = opts.height ?? 16;
  const bg = opts.bg ?? "var(--card)";
  const fg = opts.fg ?? "var(--foreground)";
  const sw = opts.strokeWidth ?? 1.2;

  const raw = (opts.samples ?? []).filter((n) => Number.isFinite(n));
  const n = raw.length;

  // Map to polyline points: x spreads across [0, w], y inverts so high = top.
  // Single / empty → flat mid-line.
  let points: string;
  let arrow: string;

  if (n <= 1) {
    const midY = (h / 2).toFixed(1);
    points = `0,${midY} ${w},${midY}`;
    arrow = "→";
  } else {
    const maxV = Math.max(...raw, 0);
    const minV = Math.min(...raw, 0);
    const range = maxV - minV || 1;
    const pad = 2; // 2 px top/bottom so the line doesn't touch the badge edges
    const innerH = h - 2 * pad;
    const stepX = w / (n - 1);

    const pts: string[] = raw.map((v, i) => {
      const y = pad + innerH * (1 - (v - minV) / range);
      return `${(i * stepX).toFixed(1)},${y.toFixed(1)}`;
    });
    points = pts.join(" ");

    const last = raw[n - 1] ?? 0;
    const first = raw[0] ?? 0;
    const delta = last - first;
    arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  }

  // The delta arrow sits in the top-right corner; the polyline fills the rest.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" rx="3" fill="${bg}"/>`,
    `<polyline points="${points}" fill="none" stroke="${fg}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<text x="${w - 1}" y="${h - 1}" text-anchor="end" font-size="${h * 0.55}" fill="${fg}" opacity="0.7">${arrow}</text>`,
    `</svg>`,
  ].join("");
}

/**
 * Convenience: returns the badge as an `<img>` data-URI, ready for a
 * `src` attribute. Encodes the SVG so it survives HTML attribute quoting.
 */
export function trendBadgeDataUri(opts?: TrendBadgeOptions): string {
  return `data:image/svg+xml,${encodeURIComponent(trendBadgeSvg(opts))}`;
}
