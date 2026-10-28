/**
 * Localized text for the launch-command risk codes (r27-O3).
 *
 * The Rust classifier returns stable machine codes and a severity; the words
 * live here so a new locale is a dictionary edit, not a backend change. A code
 * this build does not know (an older frontend against a newer backend) falls
 * back to a generic sentence rather than showing the raw identifier.
 */
import type { TFunc } from "./i18n";
import type { RiskHit } from "../types";

export function riskText(t: TFunc, code: string): string {
  // A switch, not a lookup table: `tests/i18n.test.ts` proves every registered
  // key has a static call site, and a computed key is invisible to that guard.
  // The default is a sentence rather than the raw identifier.
  switch (code) {
    case "pipe-to-shell":
      return t("launch.risk.pipe-to-shell");
    case "encoded-command":
      return t("launch.risk.encoded-command");
    case "download-execute":
      return t("launch.risk.download-execute");
    case "root-delete":
      return t("launch.risk.root-delete");
    case "elevation":
      return t("launch.risk.elevation");
    case "insecure-tls":
      return t("launch.risk.insecure-tls");
    case "world-writable":
      return t("launch.risk.world-writable");
    default:
      return t("launch.risk.unknown");
  }
}

export function hasDanger(hits: readonly RiskHit[]): boolean {
  return hits.some((h) => h.severity === "danger");
}

/** Unique sentences for a confirmation line, in hit order. */
export function riskListText(t: TFunc, hits: readonly RiskHit[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.code)) continue;
    seen.add(hit.code);
    out.push(riskText(t, hit.code));
  }
  return out.join(t("launch.risk.separator"));
}
