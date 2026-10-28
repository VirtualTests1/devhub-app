/**
 * Download speed and remaining time, as pure functions (r24-N3-1).
 *
 * ## What is measured, and what is guessed
 *
 * git writes `Receiving objects:  45% (1234/2740), 1.20 MiB | 3.40 MiB/s` on
 * stderr; the backend forwards every percent rewrite as `<stage>-progress`
 * (`downloader.rs`'s `progress_percent` documents exactly this line shape). The
 * rate is therefore **git's own number**, not a timer of ours.
 *
 * ETA is not in that line: `(1234/2740)` counts objects, not bytes, so dividing
 * them by a byte rate would be a unit error. The only honest estimate available
 * is the slope of the percentage over time, sampled from successive rewrites.
 * It is marked as an estimate in the UI and needs at least two samples ~500 ms
 * apart; before that the answer is `null`, never a fabricated number.
 *
 * No React, no DOM: tests drive the exact functions the component drives.
 */

/** Parse `45%` and `3.40 MiB/s` out of one git progress line. */
export type GitProgress = {
  percent: number | null;
  /** Bytes/sec when git printed a rate, else `null`. */
  bytesPerSec: number | null;
};

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/**
 * `Receiving objects:  45% (1234/2740), 1.20 MiB | 3.40 MiB/s`
 *
 * - The first `N%` is the stage percentage (git prints one per rewrite).
 * - The rate is the token immediately before `/s`, with an optional space:
 *   git prints `MiB/s`, some localised builds print `MiB / s`. The unit is
 *   case-insensitive; an unknown unit leaves the rate `null` rather than
 *   treating it as bytes.
 */
export function parseGitProgress(message: string | null | undefined): GitProgress {
  if (!message) return { percent: null, bytesPerSec: null };
  const pm = /(\d{1,3})\s*%/.exec(message);
  let percent: number | null = null;
  if (pm) {
    const n = Number(pm[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) percent = n;
  }
  const rm = /([\d.]+)\s*([KMGTP]?i?B)\s*\/\s*s\b/i.exec(message);
  let bytesPerSec: number | null = null;
  if (rm) {
    const value = Number(rm[1]);
    const unit = UNITS[(rm[2] ?? "").toLowerCase()];
    if (Number.isFinite(value) && value > 0 && unit !== undefined) {
      bytesPerSec = value * unit;
    }
  }
  return { percent, bytesPerSec };
}

/** One observation of the stage percentage, at a wall-clock instant. */
export type RateSample = { percent: number; at: number };

/** Only the last half minute matters; an early slow patch must not pin the ETA. */
export const RATE_WINDOW_MS = 30_000;

/** Two samples closer than this are one observation for slope purposes. */
export const RATE_MIN_SPAN_MS = 500;

/**
 * Append a sample and drop observations outside the window. A percentage that
 * did not move adds nothing to the slope, so it is not stored (it would only
 * dilute the denominator).
 */
export function pushRateSample(
  samples: readonly RateSample[],
  percent: number | null,
  at: number,
): RateSample[] {
  if (percent === null) return samples.slice();
  const last = samples[samples.length - 1];
  if (last && last.percent === percent) return samples.slice();
  return [...samples, { percent, at }].filter((s) => at - s.at <= RATE_WINDOW_MS).slice(-12);
}

/**
 * Milliseconds until 100%, from the first and last sample in the window.
 *
 * `null` when there are fewer than two distinct percentages, when the span is
 * too short, or when the percentage is not moving forward. A stalled download
 * is not given a "remaining 999 years" number; the component's own stall alarm
 * (`STALL_AFTER_MS`) says that in words.
 */
export function estimateEta(samples: readonly RateSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const span = last.at - first.at;
  const moved = last.percent - first.percent;
  if (span < RATE_MIN_SPAN_MS || moved <= 0) return null;
  if (last.percent >= 100) return 0;
  return Math.round(((100 - last.percent) * span) / moved);
}

/** `2:10`, or `1:02:03` past an hour. Neutral digits, no localised unit words. */
export function formatEta(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
