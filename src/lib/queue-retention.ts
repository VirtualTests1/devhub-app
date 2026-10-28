/**
 * Retention bound for the download queue (r26-O2-1).
 *
 * `tasks` is the only list in the app with no ceiling: a session that queues a
 * hundred repositories keeps a hundred `DownloadTask` objects, each with up to
 * ~300 log lines (`LOG_HEAD + LOG_TAIL`) and stage arrays. Active work must never
 * be dropped; finished rows are history, and history can be bounded.
 *
 * Newest-first is the store's display order (需求 9), so "keep the newest N
 * finished" is a forward scan that counts done/failed rows and keeps the first
 * N. A task that is still queued or running is always kept, wherever it sits.
 *
 * Pure and framework-free: the store calls it, tests drive the exact rule.
 */

import type { DownloadTask } from "../store/downloads";

/** How many finished rows stay in the queue without the user clearing them. */
export const QUEUE_FINISHED_CAP = 50;

type Status = DownloadTask["status"];

function isFinished(status: Status): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/**
 * Keep every active row and at most `cap` finished rows (newest first).
 *
 * `keep` is an id that must survive even if it falls outside the cap — used when
 * a task has just transitioned to `done` and a concurrent add would otherwise
 * remove the very row the UI is about to announce. It does not raise the cap for
 * any other row.
 */
export function boundQueueTasks(
  tasks: readonly DownloadTask[],
  opts: { cap?: number; keep?: string } = {},
): DownloadTask[] {
  const cap = Math.max(0, Math.floor(opts.cap ?? QUEUE_FINISHED_CAP));
  const out: DownloadTask[] = [];
  let finished = 0;
  for (const task of tasks) {
    if (!isFinished(task.status)) {
      out.push(task);
      continue;
    }
    if (task.id === opts.keep) {
      out.push(task);
      finished += 1;
      continue;
    }
    if (finished >= cap) continue;
    out.push(task);
    finished += 1;
  }
  return out;
}

/** How many finished rows this queue holds, for the header hint. */
export function finishedCount(tasks: readonly DownloadTask[]): number {
  return tasks.reduce((n, t) => n + (isFinished(t.status) ? 1 : 0), 0);
}
