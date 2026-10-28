/**
 * A self-rescheduling poll that can actually be stopped.
 *
 * Why this exists as a `.ts` module rather than eight lines inside a component
 * (round 12, 让失败可见 8.4): `RepoPortPanel`'s loop was written as
 *
 * ```
 * let timer = 0;
 * const tick = async () => { …await invoke(…); timer = setTimeout(tick, 3000); };
 * return () => clearTimeout(timer);
 * ```
 *
 * and `timer` is only assigned *after* the `await`. Unmount — or change `slug` —
 * while a request is in flight and the cleanup clears `0`, i.e. nothing; the
 * in-flight tick then schedules a poll that no cleanup can ever reach, which
 * dials the backend every 3 s for the rest of the session and stacks a second
 * loop under it the next time the panel opens. The same shape is in
 * `docs/DEV-SYNC.md`'s list of async-liveness bugs (`feat/d4-2`, `feat/d4-4`),
 * and it keeps being re-derived because the interesting part — "the guard has to
 * outlive the await, and the callbacks have to sit behind it" — is easy to write
 * and impossible to see in review.
 *
 * So the loop is here, with no DOM in it: `schedule` / `unschedule` are required
 * parameters, which is what lets a Node test drive one with a fake clock and
 * prove the in-flight case.
 */
export type PollLoopOptions<T> = {
  /** One probe. Rejected answers go to `onError`; the loop never dies on them. */
  probe: () => Promise<T>;
  /** Immediately before each probe, live runs only. */
  onStart: () => void;
  /** A settled answer, live runs only. */
  onResult: (value: T) => void;
  /** A rejection, live runs only — the reason is passed through untouched. */
  onError: (err: unknown) => void;
  /** Gap between a settled probe and the next one, in ms. */
  everyMs: number;
  /** Injected so this is testable without a `window`. */
  schedule: (cb: () => void, ms: number) => number;
  unschedule: (id: number) => void;
};

export type PollLoop = {
  /** Idempotent: a second call while running starts nothing. */
  start: () => void;
  /** Stops now, including a tick that is mid-flight. */
  stop: () => void;
};

/** How one probe settled. */
type Outcome<T> = { ok: true; value: T } | { ok: false; err: unknown };

export function createPollLoop<T>(opts: PollLoopOptions<T>): PollLoop {
  let stopped = false;
  let started = false;
  let timer: number | null = null;

  const tick = async (): Promise<void> => {
    opts.onStart();
    let outcome: Outcome<T>;
    try {
      outcome = { ok: true, value: await opts.probe() };
    } catch (err) {
      // Also catches a `probe` that throws before it ever returns a promise: a
      // loop that dies on one bad tick is how a panel ends up frozen on
      // "检查中" forever.
      outcome = { ok: false, err };
    }
    // The whole point, and the line the old code did not have: everything after
    // the `await` — including the next schedule — sits behind the flag the
    // cleanup sets. A superseded run writes no state and schedules nothing.
    if (stopped) return;
    if (outcome.ok) opts.onResult(outcome.value);
    else opts.onError(outcome.err);
    timer = opts.schedule(() => void tick(), opts.everyMs);
  };

  return {
    start: () => {
      if (stopped || started) return;
      started = true;
      void tick();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        opts.unschedule(timer);
        timer = null;
      }
    },
  };
}
