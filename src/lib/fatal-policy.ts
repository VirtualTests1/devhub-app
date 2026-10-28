import { messageOf } from "./report-error";

/**
 * The rule the entry point follows when something reaches `window` instead of a
 * `catch`.
 *
 * Why this is a pure function in a `.ts` file rather than a few lines inside
 * `main.tsx`: `main.tsx` is a `.tsx` (Node's type-stripping runner cannot parse
 * JSX), and the two decisions here — *is this still booting?* and *have we
 * already shown this exact failure?* — are the parts that used to be wrong, so
 * they are worth pinning with a test.
 *
 * The defect this closes (round 12, 让失败可见 8.1): `unhandledrejection` was
 * wired straight to the fatal overlay, and the overlay does `root.innerHTML =
 * ""`. So one missing `.catch` anywhere in the app converted a silent failure
 * into a destroyed UI, with no dedupe and no way back. That is the wrong trade:
 * a reason the app can still live with should read like a failure, not like a
 * crash report.
 *
 * The split:
 *   - **boot** — nothing is on screen yet, so a dump is the only honest surface.
 *     `overlay`.
 *   - **running** — the app owns an error surface (`reportError` → toast), and
 *     tearing down a working window to explain one rejection is the bug.
 *     `report`.
 *   - **running, already reported** — repeats of the same reason inside
 *     {@link DEDUPE_MS} collapse to `skip`, because a self-rescheduling poll that
 *     fails every three seconds would otherwise push three identical toasts out
 *     every six seconds and the queue holds three.
 */

/** Where the app is, as far as the fatal surface is concerned. */
export type FatalPhase = "boot" | "running";

/** What `main.tsx` should do with the value. */
export type FatalAction = "overlay" | "report" | "skip";

/** Repeats of the same reason inside this window are not shown again. */
export const DEDUPE_MS = 4000;

/** A `Map` of reason-key → epoch ms of the last time it was surfaced. */
export type SeenFailures = ReadonlyMap<string, number>;

/**
 * Identity of a rejection, for dedupe only — never for display.
 *
 * The key is the *sentence the user is about to read* (`messageOf`), not the
 * object that produced it. A `TypeError` and a backend `String` saying the same
 * thing are one failure as far as a toast is concerned, and the stack — which
 * would make every throw unique and switch the dedupe off — is deliberately left
 * out. The length cap is defensive: a rejection carrying a megabyte of HTML
 * would otherwise become a megabyte-long map key held for the whole session.
 */
export function rejectionKey(reason: unknown): string {
  const text = messageOf(reason);
  return text.length > 300 ? text.slice(0, 300) : text;
}

export type FatalVerdict = {
  action: FatalAction;
  /** Feed this back to {@link rememberFatal} unless the action is `skip`. */
  key: string;
  /** What to show, in the `动词失败：后端原话` shape once the caller adds the verb. */
  text: string;
};

/**
 * Decide what a value that escaped every `catch` should do to the screen.
 *
 * `now` and `seen` are parameters rather than read from the clock and from
 * module state so the whole thing is testable without a DOM, a timer or a toast
 * host; the caller in `main.tsx` owns the state.
 */
export function decideFatal(opts: {
  reason: unknown;
  phase: FatalPhase;
  now: number;
  seen: SeenFailures;
  dedupeMs?: number;
}): FatalVerdict {
  const key = rejectionKey(opts.reason);
  const text = messageOf(opts.reason);
  if (opts.phase === "boot") return { action: "overlay", key, text };
  const windowMs = opts.dedupeMs ?? DEDUPE_MS;
  const last = opts.seen.get(key);
  if (last !== undefined && opts.now - last < windowMs) {
    // Same reason, same burst. The first one already said it.
    return { action: "skip", key, text };
  }
  return { action: "report", key, text };
}

/**
 * Record that `key` was surfaced at `now`, dropping anything outside the window.
 *
 * Returns a new `Map` and leaves the input alone — the same reason `decideFatal`
 * takes its state as an argument: the entry point stays readable and the rule
 * stays testable. Pruning here is what keeps `seen` bounded across a long
 * session; without it the map grows with every distinct failure since launch.
 */
export function rememberFatal(
  seen: SeenFailures,
  key: string,
  now: number,
  dedupeMs: number = DEDUPE_MS,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [k, at] of seen) {
    if (now - at < dedupeMs) next.set(k, at);
  }
  next.set(key, now);
  return next;
}
