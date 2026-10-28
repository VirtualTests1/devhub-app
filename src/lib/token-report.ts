/**
 * The token self-check's report type and its wording (r18 R3).
 *
 * Lives in a `.ts` module on purpose, like `src/lib/heat.ts`: the interesting rules are
 * "what may this sentence claim, given exactly these fields" — and a `.tsx` is unreachable
 * from the Node test runner (`--experimental-strip-types` refuses JSX), so wording written
 * inside `SettingsView.tsx` could not be pinned by a test. This file can, and the view is
 * left with nothing but the plumbing.
 *
 * ## The honesty rule this encodes
 *
 * `valid === false` is *not* "the token is wrong". The backend answers with an observed
 * HTTP status, or with nothing at all when curl could not complete a request
 * (`src-tauri/src/auth.rs:parse_report`), and conflating the two would tell a person to
 * regenerate a working token because the office accelerator broke a TLS handshake. So the
 * three readings — accepted / rejected-with-a-status / no-answer-at-all — get three
 * different sentences, and the scope line only ever appears when the response really
 * carried the header.
 */

import type { TranslationKey } from "./i18n";

/** Mirrors `auth::TokenReport` (serde `rename_all = "camelCase"`). No field is the token. */
export type TokenReport = {
  valid: boolean;
  status: number | null;
  login: string | null;
  scopes: string | null;
  expiredScopes: string | null;
  remaining: number | null;
  limit: number | null;
  note: string | null;
};

/**
 * The translator, typed against the key union so an invented key is a compile error
 * rather than a string that silently renders itself into the UI.
 */
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/**
 * One line describing what the check concluded.
 *
 * The quota is only quoted when *both* numbers arrived: `{remaining}/{limit}` with a
 * missing limit would render `4993/—`, which reads like a measurement of something.
 */
export function describeTokenReport(report: TokenReport, t: Translate): string {
  const parts: string[] = [];
  if (report.valid) {
    parts.push(report.login ? t("settings.page.tokenValidAccount", { login: report.login }) : t("settings.page.tokenValid"));
  } else if (report.status === null || report.status === undefined) {
    parts.push(t("settings.page.tokenNoAnswer", { note: report.note ?? t("settings.page.tokenUnknown") }));
  } else {
    parts.push(
      t("settings.page.tokenRejected", { status: report.status, note: report.note ?? t("settings.page.tokenUnknown") }),
    );
  }
  // Scopes: echo what came back, and say so when it did not. A fine-grained token can be
  // perfectly valid and carry no scope header, and "没有返回" is the only claim both cases
  // support.
  if (report.valid) {
    parts.push(report.scopes ? t("settings.page.tokenScopes", { scopes: report.scopes }) : t("settings.page.tokenNoScopes"));
    if (report.expiredScopes) parts.push(t("settings.page.tokenExpiredScopes", { scopes: report.expiredScopes }));
  }
  if (report.remaining !== null && report.remaining !== undefined && report.limit !== null && report.limit !== undefined) {
    parts.push(t("settings.page.tokenQuota", { remaining: report.remaining, limit: report.limit }));
  }
  return parts.join(" · ");
}
