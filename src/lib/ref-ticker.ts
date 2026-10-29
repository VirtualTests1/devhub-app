/**
 * One refcounted interval, for every "tick once a second while something is
 * live" readout in the app.
 *
 * ## The defect class this collapses
 *
 * Two surfaces needed a clock that ticks once a second: the download queue's
 * per-row elapsed timers (`components/DownloadQueue.tsx`) and the project wall's
 * running-process readouts (`store/processes.ts`). Both were written the same
 * way and both were written by hand, so the *contract* — "start exactly one
 * interval when the first active subscriber appears, tear it down when the last
 * one leaves" — was enforced twice by two copies of the same code and proven by
 * nobody. A timer whose teardown is wrong is invisible until it is a leak, which
 * is exactly the class of bug this round audits.
 *
 * The logic is the part worth testing and the part that needs no DOM: the
 * interval callback reads a counter and notifies listeners. So the scheduler is
 * injected — the browser passes `window.setInterval` / `window.clearInterval`,
 * a test passes a fake that counts starts and stops without a clock. That is
 * what makes "the timer stops when the last subscriber leaves" an assertion
 * rather than a paragraph.
 *
 * ## Hidden means stopped, not slowed (r30-O3)
 *
 * The webview runs with background timer throttling disabled, so a clock left
 * armed while the window is minimised keeps waking it to repaint numbers nobody
 * can read. `createVisibilityInterval` owns that gate; this ticker passes the
 * browser source in production and the default `alwaysVisible` in tests. When
 * the window returns, the interval is re-armed and the version is bumped once so
 * the visible clock catches up on the first paint.
 *
 * Deliberately not React: the hook wrapper (`useSyncExternalStore` + the
 * caller's `active` flag) stays at the call site, because the "inactive
 * subscriber shares a constant snapshot" rule is a React detail, not a timer
 * detail, and folding it in here would make the timer testable only through a
 * renderer.
 */
import {
  alwaysVisible,
  createVisibilityInterval,
  type IntervalScheduler,
  type VisibilitySource,
} from "./visibility";

export type { IntervalScheduler, VisibilitySource } from "./visibility";

/** The browser scheduler — `window` is only read when a timer is actually armed. */
export const browserScheduler: IntervalScheduler = {
  setInterval: (cb, ms) => window.setInterval(cb, ms),
  clearInterval: (handle) => window.clearInterval(handle),
};

export type RefTicker = {
  /** Register a listener; returns the unsubscribe. Arms the interval if idle. */
  subscribe: (onChange: () => void) => () => void;
  /** Monotonic tick count — the snapshot a `useSyncExternalStore` reads. */
  version: () => number;
  /** Live subscribers. 0 means the interval is stopped. */
  subscriberCount: () => number;
  /** Whether an interval handle is currently held. */
  isRunning: () => boolean;
  /** Release the interval now, whatever the subscriber count says. */
  stop: () => void;
};

/**
 * Build one refcounted ticker.
 *
 * The interval is created on the first `subscribe` and cleared when the last
 * unsubscribe empties the listener set — never earlier, so N rows share one
 * clock instead of N clocks, and never later, so a finished row that stays
 * mounted does not keep a timer alive for the life of the session.
 */
export function createRefTicker(
  scheduler: IntervalScheduler,
  intervalMs: number,
  visibility: VisibilitySource = alwaysVisible,
): RefTicker {
  let version = 0;
  const listeners = new Set<() => void>();

  const tick = () => {
    version += 1;
    // A listener that unsubscribes during the notify loop is skipped, not
    // visited after it asked to leave — same behaviour the two hand-written
    // copies had, now stated.
    for (const listener of listeners) listener();
  };

  // One interval for the whole ticker. `fireOnResume` bumps the version when
  // the window comes back, so a visible elapsed clock does not wait a second to
  // become true again. Start/stop remain refcount-driven at subscribe time.
  const clock = createVisibilityInterval(tick, intervalMs, scheduler, visibility, {
    fireOnResume: true,
  });

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      clock.start();
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) clock.stop();
      };
    },
    version: () => version,
    subscriberCount: () => listeners.size,
    isRunning: () => clock.isRunning(),
    stop() {
      clock.stop();
    },
  };
}
