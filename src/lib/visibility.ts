/**
 * A visibility-aware interval for the few timers that tick once a second.
 *
 * The window ships `--disable-background-timer-throttling` (see
 * `tauri.conf.json`), which is right for a download that must keep painting when
 * the user switches away, but it also means a 1 s timer keeps waking the webview
 * while the window is minimised. The process poll already suspends on
 * `document.hidden` (`store/processes.ts`); the elapsed clocks, the download
 * silence counter and the launch dialog's process poll did not.
 *
 * The policy is deliberately not "slow down": when nothing is on screen, every
 * one of those ticks only updates a number nobody can read. Suspend, then arm a
 * fresh interval when the window is visible again. An optional extra callback on
 * resume lets a surface refresh immediately instead of waiting one interval.
 *
 * The scheduler and the visibility source are injected. Node has no `document`,
 * and the behaviour worth testing is "hidden means no interval and visible means
 * exactly one", not whether the browser fires `visibilitychange`.
 */

export type IntervalScheduler = {
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
};

export type VisibilitySource = {
  hidden: () => boolean;
  /** Calls `onChange` whenever visibility may have changed; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
};

export const browserVisibility: VisibilitySource = {
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  subscribe: (onChange) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
};

/** A source for callers that never want visibility gating (tests, SSR). */
export const alwaysVisible: VisibilitySource = {
  hidden: () => false,
  subscribe: () => () => {},
};

export type VisibilityInterval = {
  /** Idempotent; arms the interval only while visible. */
  start: () => void;
  /** Stops and unsubscribes from visibility. */
  stop: () => void;
  /** Whether a real interval handle is currently held. */
  isRunning: () => boolean;
};

export type VisibilityIntervalOptions = {
  /**
   * Call the callback once when the window becomes visible again. Surfaces that
   * show a clock want the number to be right on the first paint, not one second
   * after it; a probe wants the same.
   */
  fireOnResume?: boolean;
};

/**
 * Build one interval that exists only while its owner is started **and** the
 * window is visible.
 *
 * Multiple `start` calls do not stack handles, and hiding clears the handle
 * without forgetting that the owner is started — that distinction is what makes
 * the later `visibilitychange` able to resume it.
 */
export function createVisibilityInterval(
  cb: () => void,
  ms: number,
  scheduler: IntervalScheduler,
  visibility: VisibilitySource,
  opts: VisibilityIntervalOptions = {},
): VisibilityInterval {
  let started = false;
  let handle: number | null = null;
  let unsubscribe: (() => void) | null = null;

  const disarm = () => {
    if (handle !== null) {
      scheduler.clearInterval(handle);
      handle = null;
    }
  };

  const arm = () => {
    if (!started || handle !== null || visibility.hidden()) return;
    handle = scheduler.setInterval(cb, ms);
  };

  const onChange = () => {
    if (!started) return;
    if (visibility.hidden()) {
      disarm();
      return;
    }
    arm();
    if (opts.fireOnResume) cb();
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = visibility.subscribe(onChange);
      arm();
    },
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      disarm();
    },
    isRunning: () => handle !== null,
  };
}
