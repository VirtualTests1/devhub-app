/**
 * WCAG 2.2 contrast, with OKLCH input (r24-R3-1).
 *
 * The design tokens in `src/index.css` are OKLCH. Browsers turn them into sRGB,
 * and WCAG's contrast ratio is defined on sRGB relative luminance — so this module
 * implements the public conversion chain (OKLCH → OKLab → LMS → linear sRGB →
 * sRGB) and the WCAG 2.2 formula, rather than eyeballing hex comments.
 *
 * Correctness is checked against numbers already recorded in this repo from a
 * previous measurement (index.css light-theme comment: ink 19.3:1, muted 6.02:1,
 * blue button 4.74:1) and against the two anchor pairs every implementation must
 * reproduce: black/white = 21, #767676/white ≈ 4.54 (the classic AA boundary).
 *
 * Scope: opaque colours only. Alpha compositing, gradients, images, focus-ring
 * thickness and "large text" classification are the caller's job; the audit
 * docs list those as not covered.
 */

export type Rgb = { r: number; g: number; b: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** OKLCH (L in 0..1, C, hue degrees) → sRGB bytes, gamut-clipped. */
export function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const encode = (x: number) => {
    const v = clamp01(x);
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(clamp01(s) * 255);
  };
  return { r: encode(rLin), g: encode(gLin), b: encode(bLin) };
}

/** Parse the colour spellings this repo's tokens use: `oklch(...)`, `#rgb`, `#rrggbb`, `rgb(...)`. */
export function parseColor(input: string): Rgb | null {
  const text = input.trim();
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)\s*(?:deg)?\s*\)$/i.exec(text);
  if (ok) {
    const l = Number(ok[1]) / (ok[2] ? 100 : 1);
    const c = Number(ok[3]) / (ok[4] ? 100 : 1);
    const h = Number(ok[5]);
    if (![l, c, h].every(Number.isFinite)) return null;
    return oklchToRgb(l, c, h);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const s = hex[1] ?? "";
    const expand = s.length === 3 ? s.split("").map((ch) => ch + ch).join("") : s;
    return {
      r: parseInt(expand.slice(0, 2), 16),
      g: parseInt(expand.slice(2, 4), 16),
      b: parseInt(expand.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i.exec(text);
  if (rgb) {
    const v = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (v.some((n) => n < 0 || n > 255)) return null;
    return { r: v[0] as number, g: v[1] as number, b: v[2] as number };
  }
  return null;
}

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance(rgb: Rgb): number {
  const lin = (channel: number) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio, 1..21; argument order does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** `4.54:1`, the form the audit table and docs use. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

/** WCAG 2.2 thresholds used by the audit. */
export const AA_TEXT = 4.5;
/** Non-text UI boundaries (1.4.11) and large text (1.4.3). */
export const AA_NON_TEXT = 3;
export const AAA_TEXT = 7;
