/**
 * Settled download history across restarts (r32-N2).
 *
 * The queue's recovery payload deliberately stops at work that still matters
 * (`queued` / `running` / `failed`). A successful clone therefore disappeared
 * from the UI on quit: the directory was on disk, but the row, its log tail and
 * its landing path were gone. 记录 has a one-line activity entry, not the log
 * that explains a fallback layer or a slow mirror.
 *
 * This module keeps the last few *settled* rows — `done` and `cancelled`, never
 * `failed` (recovery already restores those with their reason and a retry path).
 * Entries are read-only: restoring a finished row into the active queue would
 * invite a second clone.
 *
 * Bounds are part of the contract: 20 rows, 12 log lines and 3,000 characters
 * each, redacted through the same `redactSecrets` the diagnostic report uses.
 * localStorage is shared with the wall and every other preference; a history
 * that could grow without a ceiling would be a quota bug.
 *
 * No React, no store import: `src/store/download-history.ts` owns the wiring and
 * tests drive these functions with a fake storage.
 */
import { redactSecrets } from "./download-diagnostics";

export const DOWNLOAD_HISTORY_KEY = "devhub.downloads.history.v1";
export const HISTORY_CAP = 20;
export const HISTORY_LOG_LINES = 12;
export const HISTORY_LOG_CHARS = 3000;
export const HISTORY_FAILURE_MAX = 500;

export type HistoryStatus = "done" | "cancelled";

export type HistoryEntry = {
  id: string;
  ref: string;
  source: string;
  status: HistoryStatus;
  startedAt: number;
  endedAt: number;
  /** The outcome's landing path, when the clone reported one. */
  path?: string;
  targetDir?: string;
  branch?: string;
  /** Redacted and bounded; present for a cancelled row when the backend said why. */
  failure?: string;
  /** Last few log lines, redacted and bounded. */
  logTail: string;
};

export type HistorySourceTask = {
  id: string;
  ref: string;
  source: string;
  startedAt: number;
  endedAt?: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  failure?: string | null;
  targetDir?: string;
  branch?: string;
  outcome?: { path?: string } | null;
  log: readonly string[];
};

export type HistoryStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: HistoryStore): HistoryStore | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function boundedText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = redactSecrets(raw.trim());
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Last lines of a log, redacted, keeping the *end* (where failures are). */
export function tailOfLog(log: readonly string[]): string {
  const lines = log.slice(-HISTORY_LOG_LINES);
  const text = redactSecrets(lines.join("\n")).trim();
  if (text.length <= HISTORY_LOG_CHARS) return text;
  return `…${text.slice(-(HISTORY_LOG_CHARS - 1))}`;
}

/** Settled rows a restart can show, newest first, capped and deduplicated by id. */
export function captureHistory(tasks: readonly HistorySourceTask[]): HistoryEntry[] {
  const rows: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "done" && task.status !== "cancelled") continue;
    if (seen.has(task.id)) continue;
    const endedAt = task.endedAt;
    if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) continue;
    const ref = task.ref.trim();
    if (!ref) continue;
    seen.add(task.id);
    const path = task.outcome?.path?.trim();
    rows.push({
      id: task.id,
      ref,
      source: task.source,
      status: task.status,
      startedAt: task.startedAt,
      endedAt,
      ...(path ? { path } : {}),
      ...(task.targetDir?.trim() ? { targetDir: task.targetDir.trim() } : {}),
      ...(task.branch?.trim() ? { branch: task.branch.trim() } : {}),
      ...(boundedText(task.failure, HISTORY_FAILURE_MAX)
        ? { failure: boundedText(task.failure, HISTORY_FAILURE_MAX) }
        : {}),
      logTail: tailOfLog(task.log),
    });
  }
  rows.sort((a, b) => b.endedAt - a.endedAt);
  return rows.slice(0, HISTORY_CAP);
}

/** Parse a stored payload; malformed rows are dropped one by one, never thrown. */
export function parseHistory(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(rows)) return [];
  const out: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (seen.has(r.id)) continue;
    if (typeof r.ref !== "string" || !r.ref.trim()) continue;
    if (typeof r.source !== "string") continue;
    if (r.status !== "done" && r.status !== "cancelled") continue;
    if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) continue;
    if (typeof r.endedAt !== "number" || !Number.isFinite(r.endedAt)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      ref: r.ref.trim(),
      source: r.source,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      ...(typeof r.path === "string" && r.path.trim() ? { path: r.path.trim() } : {}),
      ...(typeof r.targetDir === "string" && r.targetDir.trim() ? { targetDir: r.targetDir.trim() } : {}),
      ...(typeof r.branch === "string" && r.branch.trim() ? { branch: r.branch.trim() } : {}),
      ...(typeof r.failure === "string" && r.failure.trim() ? { failure: r.failure.trim() } : {}),
      logTail: typeof r.logTail === "string" ? r.logTail : "",
    });
    if (out.length >= HISTORY_CAP) break;
  }
  return out;
}

export function readHistory(storage?: HistoryStore): HistoryEntry[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    return parseHistory(s.getItem(DOWNLOAD_HISTORY_KEY));
  } catch {
    return [];
  }
}

export function writeHistory(entries: readonly HistoryEntry[], storage?: HistoryStore): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (entries.length === 0) {
      s.removeItem(DOWNLOAD_HISTORY_KEY);
      return;
    }
    s.setItem(
      DOWNLOAD_HISTORY_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), entries: entries.slice(0, HISTORY_CAP) }),
    );
  } catch {
    /* quota/private mode: history silently unavailable, downloads unaffected */
  }
}
