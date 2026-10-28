/**
 * Mounts the taskbar progress indicator (r24-R2-2).
 *
 * Tauri 2's `getCurrentWindow().setProgressBar` wraps Windows' `ITaskbarList3`
 * (`SetProgressValue` / `SetProgressState`); there is no extra plugin and no new
 * dependency. The one non-obvious requirement is ACL: `core:window:default` does
 * **not** include `allow-set-progress-bar`, so the capability file grants exactly
 * that one method (`src-tauri/capabilities/default.json`).
 *
 * The hook subscribes to the download store rather than being called from a view:
 * downloads continue while the user is on any page, and a taskbar indicator that
 * only updates on the 添加 page would be lying about the other four.
 */
import { useEffect } from "react";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { useDownloads } from "../store/downloads";
import {
  shouldPushTaskbar,
  taskbarProgressOf,
  taskbarTasksFrom,
  type TaskbarProgress,
  type TaskbarStatus,
} from "./taskbar-progress";

/** Our string union → Tauri's enum; a string literal is not assignable to the enum. */
const STATUS: Record<TaskbarStatus, ProgressBarStatus> = {
  none: ProgressBarStatus.None,
  normal: ProgressBarStatus.Normal,
  error: ProgressBarStatus.Error,
  indeterminate: ProgressBarStatus.Indeterminate,
};

export function useTaskbarProgress(): void {
  useEffect(() => {
    const win = getCurrentWindow();
    let last: TaskbarProgress | null = null;
    let lastAt = 0;

    const apply = (tasks: Parameters<typeof taskbarTasksFrom>[0]) => {
      const next = taskbarProgressOf(taskbarTasksFrom(tasks));
      const now = Date.now();
      if (!shouldPushTaskbar(last, next, now, lastAt)) return;
      last = next;
      lastAt = now;
      void win
        .setProgressBar({ status: STATUS[next.status], ...(next.progress === undefined ? {} : { progress: next.progress }) })
        .catch(() => {
          /* The taskbar is decoration; a rejected IPC must not become a toast. */
        });
    };

    apply(useDownloads.getState().tasks);
    const unsubscribe = useDownloads.subscribe((state) => apply(state.tasks));
    return () => {
      unsubscribe();
      void win.setProgressBar({ status: ProgressBarStatus.None }).catch(() => {});
    };
  }, []);
}
