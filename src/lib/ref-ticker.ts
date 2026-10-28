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
 * Deliberately not React: the hook wrapper (`useSyncExternalStore` + the
 * caller's `active` flag) stays at the call site, because the "inactive
 * subscriber shares a constant snapshot" rule is a React detail, not a timer
 * detail, and folding it in here would make the timer testable only through a
 * renderer.
 */

/** The two timer primitives, injected so a test can observe them. */
export type IntervalScheduler = {
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
};

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
): RefTicker {
  let version = 0;
  let handle: number | null = null;
  const listeners = new Set<() => void>();

  const tick = () => {
    version += 1;
    // A listener that unsubscribes during the notify loop is skipped, not
    // visited after it asked to leave — same behaviour the two hand-written
    // copies had, now stated.
    for (const listener of listeners) listener();
  };

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (handle === null) handle = scheduler.setInterval(tick, intervalMs);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && handle !== null) {
          scheduler.clearInterval(handle);
          handle = null;
        }
      };
    },
    version: () => version,
    subscriberCount: () => listeners.size,
    isRunning: () => handle !== null,
    stop() {
      if (handle !== null) scheduler.clearInterval(handle);
      handle = null;
    },
  };
}
