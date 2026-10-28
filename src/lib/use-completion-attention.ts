/**
 * Taskbar attention for completions that happen while the window is unfocused
 * (r27-N3).
 *
 * `requestUserAttention` is the only Windows channel that survives a hidden
 * window without a new dependency (notifications plugin, tray icon). It is
 * requested through one shared throttle so a batch of downloads finishing at
 * once flashes once, and a failure is never suppressed by a preceding success.
 *
 * The download subscription starts from the tasks already on screen: a recovered
 * row from the previous session must not flash the taskbar on startup.
 */
import { useEffect } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { decideAttention, type AttentionLevel } from "./completion-attention";
import { useAttention } from "../store/attention";
import { useDownloads } from "../store/downloads";

let lastAt = 0;

/** One request, shared by the queue subscription and 批量更新. */
export async function requestCompletionAttention(
  outcome: "success" | "failure",
): Promise<void> {
  const focused = typeof document !== "undefined" && document.hasFocus();
  const d = decideAttention({
    focused,
    enabled: useAttention.getState().enabled,
    outcome,
    now: Date.now(),
    lastAt,
  });
  if (d.level === "none") return;
  lastAt = d.lastAt;
  await requestLevel(d.level);
}

async function requestLevel(level: AttentionLevel): Promise<void> {
  try {
    await getCurrentWindow().requestUserAttention(
      level === "critical" ? UserAttentionType.Critical : UserAttentionType.Informational,
    );
  } catch {
    // The taskbar is decoration; a rejected IPC must not become a toast, and an
    // environment without a taskbar (a test runner) has nothing to flash.
  }
}

/** Mount once in the app shell. */
export function useCompletionAttention(): void {
  const enabled = useAttention((s) => s.enabled);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const seen = new Set<string>();
    const key = (id: string, at: number | undefined) => `${id}@${at ?? 0}`;
    for (const t of useDownloads.getState().tasks) {
      if (t.endedAt) seen.add(key(t.id, t.endedAt));
    }
    const unsub = useDownloads.subscribe((state) => {
      const fresh = state.tasks.filter(
        (t) =>
          t.endedAt !== undefined &&
          (t.status === "done" || t.status === "failed" || t.status === "cancelled") &&
          !seen.has(key(t.id, t.endedAt)),
      );
      for (const t of fresh) seen.add(key(t.id, t.endedAt));
      const interesting = fresh.filter((t) => t.status !== "cancelled");
      if (interesting.length === 0) return;
      void requestCompletionAttention(
        interesting.some((t) => t.status === "failed") ? "failure" : "success",
      );
    });
    // A focus returning is the signal that the flash has done its job.
    const clear = () => {
      void getCurrentWindow().requestUserAttention(null).catch(() => {});
    };
    window.addEventListener("focus", clear);
    return () => {
      unsub();
      window.removeEventListener("focus", clear);
    };
  }, [enabled]);
}
