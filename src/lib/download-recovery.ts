/**
 * Queue recovery across restarts (r26-N1-1, r30-O1).
 *
 * The queue is process memory. Closing the app used to erase every trace of it:
 * no row, no reason, no URL to retry. The first version persisted only queued
 * and running tasks and replayed both as **failed** rows — safe, because it
 * never restarted a clone nobody asked for, but wrong in two visible ways:
 *
 *   - a task that was merely *queued* had done no work, so calling it
 *     "interrupted" was a lie and discarded the user's place in line;
 *   - a failure vanished on quit, so the most useful row to retry was exactly
 *     the one restart could not show.
 *
 * Version 2 keeps the same safety rule — nothing starts by itself — while
 * stating each row's real history: `queued` comes back **paused**, `running`
 * comes back as interrupted/failed, and `failed` comes back with its reason so
 * the existing 重试失败 path can pick it up. A resumed queued row is an explicit
 * click, never an automatic clone.
 *
 * What is still deliberately not stored: log lines, stage list, progress and
 * outcome. They are session evidence, not recovery data, and a 20-row payload
 * with full logs would compete for the same localStorage quota the wall uses.
 * The failure text is kept because it is the one field that tells the user
 * whether retrying is worthwhile, and it is capped.
 *
 * No React, no store import at runtime: the store passes its tasks in, tests
 * drive the same functions with a fake storage.
 */

export const DOWNLOAD_RECOVERY_KEY = "devhub.downloads.interrupted.v1";
export const DOWNLOAD_RECOVERY_CAP = 20;

/** How long a stored failure reason may be; the backend's own message, trimmed. */
export const RECOVERY_FAILURE_MAX = 500;

export type RecoveryStatus = "queued" | "running" | "failed";

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
  /**
   * What the row was doing at quit. Absent in v1 payloads, where every row was
   * in flight by definition; the reader treats that as `running`.
   */
  status?: RecoveryStatus;
  /** v2: the failure text for a failed row, so 重试失败 is not a blind click. */
  failure?: string;
  /** v2: when the row settled, for a failed row. */
  endedAt?: number;
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
  /** A user-held row never reached the backend; v2 restores it held. */
  paused?: boolean;
  failure?: string | null;
  endedAt?: number;
};

/** Keep a recovery payload's failure text bounded without cutting a code point. */
function boundedFailure(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length <= RECOVERY_FAILURE_MAX) return text;
  return `${text.slice(0, RECOVERY_FAILURE_MAX - 1)}…`;
}

/**
 * Tasks a restart can honestly present, newest first, capped.
 *
 * `queued` counts even when the user had held it (`paused`): the row existed,
 * and v2 restores it held rather than pretending it failed. `running` is the
 * only state that has partial work and therefore the only one that becomes
 * "interrupted". `failed` is included so the retry path survives a restart;
 * `done`/`cancelled` are history, not recovery.
 *
 * Duplicate refs are resolved in favour of the row that still had work to do.
 * The queue already refuses a second active download of one ref, but a failed
 * row plus a fresh queued row is a legal state — and dropping the queued one
 * because the failed one happens to be newer would lose the user's current
 * request.
 */
export function captureRecovered(tasks: readonly RecoverySourceTask[]): RecoverableTask[] {
  const out: RecoverableTask[] = [];
  const rank = new Map<string, number>();
  const order: { task: RecoverableTask; priority: number }[] = [];
  for (const task of tasks) {
    if (task.status !== "queued" && task.status !== "running" && task.status !== "failed") continue;
    const ref = task.ref.trim();
    if (!ref) continue;
    const priority = task.status === "failed" ? 0 : 1;
    const row: RecoverableTask = {
      id: task.id,
      ref,
      source: task.source,
      ...(task.targetDir?.trim() ? { targetDir: task.targetDir.trim() } : {}),
      ...(task.overwrite ? { overwrite: true } : {}),
      ...(task.branch?.trim() ? { branch: task.branch.trim() } : {}),
      startedAt: task.startedAt,
      status: task.status,
      ...(task.status === "failed" && boundedFailure(task.failure)
        ? { failure: boundedFailure(task.failure) }
        : {}),
      ...(task.status === "failed" && typeof task.endedAt === "number" && Number.isFinite(task.endedAt)
        ? { endedAt: task.endedAt }
        : {}),
    };
    const current = rank.get(ref);
    if (current === undefined) {
      rank.set(ref, order.length);
      order.push({ task: row, priority });
    } else {
      const prior = order[current];
      if (prior && priority > prior.priority) {
        // Keep the row's original position but prefer the active copy.
        order[current] = { task: row, priority };
      }
    }
  }
  for (const { task } of order) {
    out.push(task);
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
    // v1 had no status field and only ever stored in-flight rows, so the honest
    // default for an old payload is "running" (which the store shows as
    // interrupted). A v2 row is only trusted when the value is a known state.
    const status: RecoveryStatus =
      r.status === "queued" || r.status === "failed" || r.status === "running"
        ? r.status
        : "running";
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
      status,
      ...(status === "failed" && boundedFailure(r.failure)
        ? { failure: boundedFailure(r.failure) }
        : {}),
      ...(status === "failed" && typeof r.endedAt === "number" && Number.isFinite(r.endedAt)
        ? { endedAt: r.endedAt }
        : {}),
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

/** Write the current recoverable set; an empty set removes the key. */
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
      JSON.stringify({ version: 2, savedAt: Date.now(), tasks: tasks.slice(0, DOWNLOAD_RECOVERY_CAP) }),
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
