/**
 * The queue's refusal rule, separated from the IPC that gathers the facts.
 *
 * `download_preflight` answers filesystem facts; this module decides whether
 * those facts mean "do not start git". It is pure so the decision can be tested
 * without a Tauri runtime, and it is deliberately conservative: only a path the
 * backend already considers impossible, or an occupied directory without an
 * explicit overwrite, stops the task. Free space is reported, not guessed at —
 * without a remote size there is no honest minimum.
 */
import { t } from "./i18n";
import { formatBytes } from "./format";
import type { DownloadPreflight } from "../types";

export type PreflightProblem = "path" | "occupied" | null;

export function preflightProblem(
  facts: DownloadPreflight,
  overwrite: boolean,
): PreflightProblem {
  if (facts.pathError) return "path";
  if (facts.occupied && !overwrite) return "occupied";
  return null;
}

/** The user-facing reason, or null when the task may start. */
export function preflightFailureText(
  facts: DownloadPreflight,
  overwrite: boolean,
): string | null {
  const problem = preflightProblem(facts, overwrite);
  if (problem === "path") return facts.pathError ?? t("queue.preflightPathUnknown");
  if (problem === "occupied") return t("queue.preflightOccupied", { path: facts.target });
  return null;
}

/** One log line for a passed preflight, so the queue says what it checked. */
export function preflightPassedLine(facts: DownloadPreflight): string {
  const free =
    facts.freeBytes === null
      ? t("queue.preflightFreeUnknown")
      : t("queue.preflightFree", { size: formatBytes(facts.freeBytes) });
  return t("queue.preflightPassed", { path: facts.target, free });
}