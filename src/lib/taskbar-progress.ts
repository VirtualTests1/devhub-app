/**
 * Taskbar progress: one bar for a queue of downloads (r24-R2-1).
 *
 * Windows (and Tauri's `setProgressBar`, which wraps `ITaskbarList3`) has exactly
 * one progress indicator per window. The download queue can hold several tasks, so
 * the bar answers "how far is this app through the work it started", not "which
 * task is winning":
 *
 *   - no unfinished work            → hide the bar
 *   - queued, nothing running       → 0 %, normal
 *   - one or more running, all with a real percentage → their average
 *   - any running task without one  → indeterminate (never a made-up number)
 *   - nothing running, a failure left in the queue → error
 *
 * Percentages come from git (via `parseGitProgress` in the wiring layer), so this
 * module only does arithmetic and state selection. No Tauri import, no DOM: the
 * Windows API cannot be called from the Node test runner, but these decisions can.
 */

import { parseGitProgress } from "./download-rate";

export type TaskbarStatus = "none" | "normal" | "error" | "indeterminate";

/** The subset of `DownloadTask` this decision reads. */
export type TaskbarTask = {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** `null` = git has not printed a percentage for this task yet. */
  percent: number | null;
};

/** One queue row as the store holds it; only the fields the bar needs. */
export type TaskbarSourceTask = {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress?: { message?: string } | null;
};

/**
 * Queue rows → the bar's input. The percent comes from git's own line through
 * `parseGitProgress`, so the taskbar and the panel's bar cannot disagree about
 * what "45 %" means.
 */
export function taskbarTasksFrom(tasks: readonly TaskbarSourceTask[]): TaskbarTask[] {
  return tasks.map((task) => ({
    status: task.status,
    percent: parseGitProgress(task.progress?.message).percent,
  }));
}

/** Shaped like Tauri's `ProgressBarState`; `progress` is absent when not normal. */
export type TaskbarProgress = {
  status: TaskbarStatus;
  progress?: number;
};

export function taskbarProgressOf(tasks: readonly TaskbarTask[]): TaskbarProgress {
  const running = tasks.filter((t) => t.status === "running");
  const queued = tasks.filter((t) => t.status === "queued");
  const failed = tasks.filter((t) => t.status === "failed");

  if (running.length === 0 && queued.length === 0) {
    return failed.length > 0 ? { status: "error", progress: 100 } : { status: "none" };
  }
  if (running.length === 0) return { status: "normal", progress: 0 };

  const values = running.map((t) => t.percent);
  if (values.some((p) => p === null)) return { status: "indeterminate" };
  const nums = values.filter((p): p is number => p !== null).map((p) => Math.min(100, Math.max(0, p)));
  const avg = Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length);
  return { status: "normal", progress: avg };
}

/** Whether two answers differ in anything the OS can observe. */
export function taskbarChanged(a: TaskbarProgress | null, b: TaskbarProgress): boolean {
  if (a === null) return true;
  return a.status !== b.status || a.progress !== b.progress;
}

/**
 * Minimum gap between two *progress* updates. A git clone rewrites its line
 * several times a second; one taskbar IPC per rewrite is waste. A change of
 * status (start, finish, error) is not a progress update and bypasses the gate —
 * the last frame of a download must not be throttled away.
 */
export const TASKBAR_MIN_INTERVAL_MS = 250;

export function shouldPushTaskbar(
  prev: TaskbarProgress | null,
  next: TaskbarProgress,
  now: number,
  lastAt: number,
): boolean {
  if (!taskbarChanged(prev, next)) return false;
  if (now - lastAt >= TASKBAR_MIN_INTERVAL_MS) return true;
  return prev === null || prev.status !== next.status;
}
