/**
 * Interrupted-download recovery (r26-N1-1).
 *
 * The queue is process memory. Closing the app with a clone in flight used to
 * erase every trace of it: no row, no reason, no URL to retry. This module
 * persists only the tasks that had NOT finished, and reads them back as
 * **failed** rows — never as queued ones. Restarting a clone the user did not ask
 * to restart is a different feature (and a surprising one); showing "this was
 * interrupted, retry?" is the honest half.
 *
 * What is deliberately not stored: log lines, stage list, progress, outcome.
 * They are session evidence, not recovery data, and a 20-row payload with full
 * logs would compete for the same localStorage quota the wall uses.
 *
 * No React, no store import at runtime: the store passes its tasks in, tests
 * drive the same functions with a fake storage.
 */

export const DOWNLOAD_RECOVERY_KEY = "devhub.downloads.interrupted.v1";
export const DOWNLOAD_RECOVERY_CAP = 20;

export type RecoverableTask = {
  id: string;
  ref: string;
  source: string;
  targetDir?: string;
  overwrite?: boolean;
  /** Branch chosen at clone time (r27-N1); absent = the remote default. */
  branch?: string;
  /** Wall-clock start; kept so the recovered row can say when it began. */
  startedAt: number;
};

export type RecoveryStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(storage?: RecoveryStore): RecoveryStore | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The subset of a queue task this module reads. */
export type RecoverySourceTask = {
  id: string;
  ref: string;
  source: string;
  targetDir?: string;
  overwrite?: boolean;
  branch?: string;
  startedAt: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** A user-held row never reached the backend, so it is not "interrupted". */
  paused?: boolean;
};

/**
 * Tasks still in flight at quit, newest first, capped.
 *
 * `queued` counts: a user who pressed download and quit immediately should see
 * that the request existed. `done`/`failed` are history and are not persisted.
 * A *paused* queued row is the exception: the user deliberately held it before
 * any clone started, so there is no partial work to explain and resurrecting it
 * as "interrupted" would contradict the hold.
 */
export function captureRecovered(tasks: readonly RecoverySourceTask[]): RecoverableTask[] {
  const out: RecoverableTask[] = [];
  for (const task of tasks) {
    if (task.status !== "queued" && task.status !== "running") continue;
    if (task.paused) continue;
    const ref = task.ref.trim();
    if (!ref) continue;
    out.push({
      id: task.id,
      ref,
      source: task.source,
      ...(task.targetDir?.trim() ? { targetDir: task.targetDir.trim() } : {}),
      ...(task.overwrite ? { overwrite: true } : {}),
      ...(task.branch?.trim() ? { branch: task.branch.trim() } : {}),
      startedAt: task.startedAt,
    });
    if (out.length >= DOWNLOAD_RECOVERY_CAP) break;
  }
  return out;
}

/** Parse what was stored; anything malformed is dropped row-by-row, never thrown. */
export function parseRecovered(raw: string | null): RecoverableTask[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = (value as { version?: unknown; tasks?: unknown })?.tasks;
  if (!Array.isArray(rows)) return [];
  const out: RecoverableTask[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ref !== "string" || !r.ref.trim()) continue;
    if (typeof r.source !== "string") continue;
    if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) continue;
    const ref = r.ref.trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : `recovered-${out.length}`,
      ref,
      source: r.source,
      ...(typeof r.targetDir === "string" && r.targetDir.trim()
        ? { targetDir: r.targetDir.trim() }
        : {}),
      ...(r.overwrite === true ? { overwrite: true } : {}),
      ...(typeof r.branch === "string" && r.branch.trim() ? { branch: r.branch.trim() } : {}),
      startedAt: r.startedAt,
    });
    if (out.length >= DOWNLOAD_RECOVERY_CAP) break;
  }
  return out;
}

export function readRecovered(storage?: RecoveryStore): RecoverableTask[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    return parseRecovered(s.getItem(DOWNLOAD_RECOVERY_KEY));
  } catch {
    return [];
  }
}

/** Write the current in-flight set; an empty set removes the key. */
export function writeRecovered(tasks: readonly RecoverableTask[], storage?: RecoveryStore): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (tasks.length === 0) {
      s.removeItem(DOWNLOAD_RECOVERY_KEY);
      return;
    }
    s.setItem(
      DOWNLOAD_RECOVERY_KEY,
      JSON.stringify({ version: 1, tasks: tasks.slice(0, DOWNLOAD_RECOVERY_CAP) }),
    );
  } catch {
    /* quota/private mode: recovery silently unavailable, downloads unaffected */
  }
}

/**
 * Read once and clear. A recovered row is shown exactly once: if the user quits
 * again without touching it, it is a failed row in memory, not "in flight", and
 * captureRecovered will not resurrect it.
 */
export function takeRecovered(storage?: RecoveryStore): RecoverableTask[] {
  const tasks = readRecovered(storage);
  const s = resolveStorage(storage);
  if (s) {
    try {
      s.removeItem(DOWNLOAD_RECOVERY_KEY);
    } catch {
      /* ignore: the key will be overwritten by the next capture */
    }
  }
  return tasks;
}
