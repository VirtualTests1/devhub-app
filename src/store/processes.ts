import { useCallback, useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reportError } from "../lib/report-error";
import { browserScheduler, createRefTicker } from "../lib/ref-ticker";
import { browserVisibility } from "../lib/visibility";
import type { ProcessState } from "../types";

/**
 * The live process list, out of `App.tsx` and into its own store.
 *
 * ## Why this exists as a slice rather than a `useState` on the composition root
 *
 * The poll that feeds `live_processes` runs every two seconds. When its result
 * lived in `App.tsx`, *every* tick wrote a fresh array into the composition root,
 * which re-rendered `App` → `AppShell` → every view → the whole repository wall
 * (one `RepoTile` per project). A wall that merely needs to know "is *this* one
 * running" paid for a full-tree render every two seconds, even while idle.
 *
 * The store splits that by subscription granularity:
 *
 *   - `useLiveProcesses()`       — the full array. Only the components that render
 *                                    per-process detail subscribe to it (the wall,
 *                                    the strip's popover while it is open).
 *   - `useRunningProcessCount()` — a primitive. `AppShell` and `StatusStrip` read
 *                                    the one number they need, and a tick that does
 *                                    not change the count re-renders neither.
 *
 * zustand compares a selector's return with `Object.is`, so a selector that hands
 * back a number only re-renders the subscriber when that number actually moved.
 * That is the whole mechanism: a component's cost across a tick is now proportional
 * to what it renders about processes, not to how many tiles the wall has.
 *
 * ## Why the poll self-starts instead of living in `App.tsx`
 *
 * `App.tsx` is the shared composition root, so the timer is owned here instead: the
 * first subscriber calls `ensurePoll()`, which starts the one controller this module
 * keeps. That matches the old behaviour (the poll ran from mount to close) while
 * keeping `App.tsx` free of process state, and holding a controller rather than a
 * one-way `pollStarted` flag is what makes it StrictMode double-mount safe *and*
 * actually cancellable — the previous version passed `setInterval`'s handle straight
 * into the void, so nothing in the app could ever stop it.
 *
 * What the loop does between answers is decided by `nextPollPolicy` below, not by a
 * constant: it suspends while `document.hidden`, backs off exponentially while the
 * command keeps failing, and says so once through `reportError`. The old shape was a
 * fixed `setInterval` plus `catch {}` — a dead `live_processes` was therefore dialled
 * twice a second for the rest of the session, visible or not, without a signal.
 *
 * Two seconds, not one, for the same reason the old comment gave: this feeds the
 * strip's count for *every* project; the launch dialog already polls the per-slug
 * list at one second while it is open, and that is a separate concern.
 *
 * A trailing `setTimeout`, not an interval: `setInterval` fires on its own schedule
 * whatever a previous tick is still doing, so a slow backend stacked concurrent
 * `live_processes` calls two seconds apart. Rescheduling only after a tick settles
 * cannot.
 */

type ProcessesState = {
  /** Every process this app started, running or recently exited. */
  live: ProcessState[];
};

export const useProcesses = create<ProcessesState>(() => ({ live: [] }));

/**
 * Whether two polls describe the same process *situation*.
 *
 * Every field the UI reads is compared except `elapsedMs`, which advances on
 * every tick for a running process — including it would make this always false
 * while anything runs, and the point is that a tick which only lets time pass
 * must not re-render anyone.
 *
 *   - `pid` / `slug` / `label` / `state` — what the wall badge, the strip rows
 *     and the tile tooltip render, and what `ProjectsView`'s `runningBySlug`
 *     keys and filters on.
 *   - `exitCode` / `stoppable` / `suspendable` — included on purpose, not
 *     decoration: the first is what 已退出（代码 N） reads, and the other two
 *     flip *without* a state change (a process detaches and becomes un-stoppable),
 *     so comparing without them would freeze the strip's 停止/挂起 buttons in
 *     whatever enabled state the last real change left them in.
 *
 * Order is part of the comparison: the popover walks `live`, so a reordered
 * list is a different answer even with the same members.
 *
 * Consequence for consumers: `live` elements' `elapsedMs` is now the value it
 * had at the last real change, not "now". Anything that shows a *live* clock
 * must derive it from a clock of its own rather than read that field per render.
 */
export function sameProcessList(
  a: readonly ProcessState[],
  b: readonly ProcessState[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    // noUncheckedIndexedAccess: 两条腿的长度已相等（上面挡住），但索引访问的
    // 类型仍带 `| undefined`。缺席只可能发生在数组本身被别名改写的瞬间，
    // 此时按「不同」处理是唯一诚实的答案。
    if (x === undefined || y === undefined) return false;
    if (!sameProcessEntry(x, y)) return false;
  }
  return true;
}

/**
 * Whether two rows describe the same *situation* for one pid.
 *
 * Everything the UI reads is compared except `elapsedMs` — see `sameProcessList`;
 * the push merge reuses the same rule so a snapshot that differs only in the clock
 * can keep the object (and therefore the caller's reported-at baseline) it already
 * had.
 */
function sameProcessEntry(x: ProcessState, y: ProcessState): boolean {
  return (
    x.pid === y.pid &&
    x.slug === y.slug &&
    x.label === y.label &&
    x.state === y.state &&
    x.exitCode === y.exitCode &&
    x.stoppable === y.stoppable &&
    x.suspendable === y.suspendable
  );
}

/**
 * The poll's schedule, as a pure reducer.
 *
 * All of this used to be `setInterval(tick, 2000)` plus `catch {}`: a fixed rate
 * whatever the backend was doing, a handle nobody kept (so nothing could ever
 * cancel it), every rejection dropped on the floor, and no awareness of whether
 * anybody was looking. A dead `live_processes` command was therefore dialled every
 * two seconds for the rest of the session — including while the window was hidden
 * — and said nothing while it did it (r15-correct-12).
 *
 * Kept apart from the wiring on purpose: `document.hidden` and `setTimeout` cannot
 * be driven from the Node runner, but the decisions can, and the decisions are the
 * part that was missing.
 */

/** The gap between two good answers: the interval the strip was designed around. */
export const POLL_BASE_MS = 2000;

/** ... and the most it is ever allowed to stretch to while things stay broken. */
export const POLL_MAX_MS = 30000;

/**
 * `2000 * 2 ** fails`, capped.
 *
 * The exponent is clamped rather than trusted: `2 ** 1100` is `Infinity`, and
 * `Math.min(30000, Infinity)` is still 30000 — but a caller that ever reads the raw
 * value would be scheduling a timer that never fires. 30 stops the arithmetic from
 * being a joke long before the cap bites.
 */
export function pollDelayMs(fails: number): number {
  if (fails <= 0) return POLL_BASE_MS;
  return Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** Math.min(fails, 30));
}

export type PollPolicy = {
  /** Consecutive failed probes; a good answer resets it to 0. */
  fails: number;
  /** `document.hidden` as last observed. */
  hidden: boolean;
};

export type PollEvent =
  /** A probe answered (whatever it answered). */
  | { type: "ok" }
  /** A probe rejected. */
  | { type: "fail" }
  /** `visibilitychange`, in both directions. */
  | { type: "hidden" }
  | { type: "visible" };

export type PollDecision = PollPolicy & {
  /** ms until the next probe, or `null` for "do not probe again". */
  nextDelayMs: number | null;
  /** Tell the user about this failure — once per streak, not once per tick. */
  report: boolean;
};

/** The starting state, and the shape the runtime keeps between ticks. */
export const initialPollPolicy = (hidden = false): PollPolicy => ({ fails: 0, hidden });

export function nextPollPolicy(p: PollPolicy, e: PollEvent): PollDecision {
  switch (e.type) {
    case "hidden":
      // Suspend, do not merely slow down: nothing is reading the count, and a
      // background webview is exactly where a runaway timer goes unnoticed.
      return { fails: p.fails, hidden: true, nextDelayMs: null, report: false };
    case "visible":
      // Come back at once — the window is showing and the number may be stale.
      return { fails: p.fails, hidden: false, nextDelayMs: 0, report: false };
    case "ok":
      return { fails: 0, hidden: p.hidden, nextDelayMs: p.hidden ? null : POLL_BASE_MS, report: false };
    case "fail": {
      const fails = p.fails + 1;
      return {
        fails,
        hidden: p.hidden,
        // A rejection that lands after the window went hidden must not restart the
        // loop behind the visibility handler's back.
        nextDelayMs: p.hidden ? null : pollDelayMs(fails),
        // Only the first failure of a streak speaks: 60 broken ticks are one fact.
        report: fails === 1,
      };
    }
  }
}

/** The running poll, with the handle the old code threw away. */
type PollController = { stop: () => void };

let poll: PollController | null = null;

/**
 * Called from `useEffect(ensurePoll, [])`, so it must keep returning `undefined` —
 * anything else React would run as a cleanup on the first unmount and the poll
 * would die with the StrictMode double-mount it was written to survive.
 */
function ensurePoll(): undefined {
  if (poll || typeof window === "undefined" || typeof document === "undefined") return;
  poll = startProcessPoll();
  return undefined;
}

function startProcessPoll(): PollController {
  let policy = initialPollPolicy(document.hidden === true);
  let timer: number | null = null;
  let disposed = false;
  // True between `invoke` and its landing, so a `visible` resume cannot stack a
  // second probe on the one already in flight.
  let inFlight = false;

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  /** Commit one decision: cancel whatever was pending, then honour the new gap. */
  const apply = (d: PollDecision) => {
    policy = { fails: d.fails, hidden: d.hidden };
    clearTimer();
    // `inFlight` only ever matters for a `visibilitychange` that arrives mid-request:
    // the tick that is out there will reschedule itself when it lands, and scheduling
    // here too would put two probes on the wire.
    if (d.nextDelayMs !== null && !inFlight) {
      timer = window.setTimeout(() => void tick(), d.nextDelayMs);
    }
  };

  const tick = async () => {
    timer = null;
    if (disposed) return;
    // Hidden without a `visibilitychange` we acted on (started hidden, or an event
    // that arrived after this timer was already queued): record the suspension
    // through the reducer so the later 可见 event is what resumes us.
    if (document.hidden) {
      apply(nextPollPolicy(policy, { type: "hidden" }));
      return;
    }
    inFlight = true;
    let answer: ProcessState[] | null = null;
    let err: unknown = null;
    try {
      answer = await invoke<ProcessState[]>("live_processes");
    } catch (e) {
      err = e;
    }
    inFlight = false;
    // Everything after the `await` sits behind the flag the cleanup sets — the
    // rule `src/lib/poll-loop.ts` exists for; a superseded run writes no state,
    // reports nothing and schedules nothing.
    if (disposed) return;
    if (err === null && answer !== null) {
      // A failed or hidden poll leaves the previous list on screen, as before; a
      // tick that changed nothing keeps the old array identity so nobody re-renders.
      if (!sameProcessList(useProcesses.getState().live, answer)) {
        useProcesses.setState({ live: answer });
      }
      apply(nextPollPolicy(policy, { type: "ok" }));
      return;
    }
    const d = nextPollPolicy(policy, { type: "fail" });
    // The line the old `catch {}` did not have. `reportError` is the app's one
    // failure path (`src/lib/report-error.ts`) → a toast with the backend's own
    // sentence, and once per streak because every tick would otherwise shout.
    if (d.report) reportError(err, "读取运行进程失败");
    apply(d);
  };

  const onVisibility = () => {
    apply(nextPollPolicy(policy, { type: document.hidden ? "hidden" : "visible" }));
  };
  document.addEventListener("visibilitychange", onVisibility);

  void tick();

  return {
    stop: () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/** The full live list. Prefer `useRunningProcessCount` when only a count is needed. */
export function useLiveProcesses(): ProcessState[] {
  useEffect(ensurePoll, []);
  return useProcesses((s) => s.live);
}

/** How many processes are not `exited` — a primitive, so ticks that keep it
 *  constant do not re-render the caller. */
export function useRunningProcessCount(): number {
  useEffect(ensurePoll, []);
  return useProcesses((s) => s.live.filter((p) => p.state !== "exited").length);
}

/**
 * `elapsedMs` as it reads *right now*.
 *
 * `sameProcessList` ignores `elapsedMs`, so a stored element carries the value
 * the poll reported at the last real change — not "now". Anything that shows a
 * moving clock adds its own time back here: `reportedAt` is when that element
 * was read, `reportedMs` what it said, and the pair only drifts by the poll
 * interval (2 s) at re-basing, never cumulatively.
 *
 * Clamped at the reported value: a clock that rewound when a fresh poll turned
 * out slightly behind the wall would read as a bug on screen.
 */
export function liveElapsedMs(reportedMs: number, reportedAt: number, now = Date.now()): number {
  return Math.max(reportedMs, reportedMs + (now - reportedAt));
}

/**
 * One refcounted per-second clock for every live process readout in the app.
 *
 * Needed *because* of `sameProcessList`: the store stopped re-rendering the wall
 * every two seconds, so a running timer nobody re-renders would simply stop.
 * Same shape as the download queue's own ticker — the subscription is what makes
 * the caller re-render, the version number is not read.
 *
 * The shape itself is now shared rather than re-implemented (r17-o2-2):
 * `lib/ref-ticker.ts` owns the "arm on the first subscriber, clear on the last"
 * mechanism both this store and the queue used to spell out by hand, and it has
 * the unit test that was missing. This file keeps the React half.
 */
const processSecondTicker = createRefTicker(browserScheduler, 1000, browserVisibility);

/** Re-renders the caller once a second while `active`, else never. */
export function useProcessSecond(active: boolean): number {
  const subscribe = useCallback(
    (onChange: () => void) => (active ? processSecondTicker.subscribe(onChange) : () => {}),
    [active],
  );
  // Inactive subscribers share one constant snapshot, so the interval is not
  // created by a wall full of idle tiles.
  return useSyncExternalStore(
    subscribe,
    () => (active ? processSecondTicker.version() : 0),
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Push updates (`process://update`)
// ---------------------------------------------------------------------------
//
// The 2 s poll stays: it is the authoritative reconciliation, it survives a
// missed or malformed event, and it re-reads the table even if nobody pushed.
// The event exists to remove the *latency* the poll cannot: a spawn, stop,
// suspend/resume or crash now reaches the store within one Rust tick instead of
// up to two seconds later.
//
// Rust pushes the same `Vec<ProcessState>` that `live_processes` answers with
// (`snapshot_processes` in `src-tauri/src/lib.rs` is shared by both), and only
// when a field the UI reads changed — `elapsedMs` alone never triggers a push.
//
// The merge is deliberately not "replace the array": a surviving pid keeps the
// *object* it already had when nothing but the clock moved. `RepoTile` and the
// status strip derive a live clock from `(elapsedMs, moment this array identity
// was installed)`, so replacing the object would re-base every running timer on
// every event. New pids arrive with Rust's fresh `elapsedMs` (the baseline is the
// moment they land here); pids absent from the payload are gone, because the
// payload is a complete snapshot rather than a delta.

/** True when an unknown event payload is a well-formed `ProcessState`. */
function isProcessState(value: unknown): value is ProcessState {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.pid === "number" &&
    Number.isFinite(p.pid) &&
    typeof p.label === "string" &&
    typeof p.slug === "string" &&
    (p.state === "running" || p.state === "suspended" || p.state === "exited") &&
    (p.exitCode === null || typeof p.exitCode === "number") &&
    typeof p.elapsedMs === "number" &&
    Number.isFinite(p.elapsedMs) &&
    typeof p.stoppable === "boolean" &&
    typeof p.suspendable === "boolean"
  );
}

/**
 * Merge one full snapshot into the existing list.
 *
 * Returns the *same* array when nothing meaningful moved, so `useProcesses`
 * subscribers do not re-render. Rows are ordered by pid, matching Rust's
 * `out.sort_by_key(|p| p.pid)` and therefore the poll.
 */
export function mergeProcessUpdates(
  current: readonly ProcessState[],
  incoming: readonly ProcessState[],
): ProcessState[] {
  const previous = new Map(current.map((p) => [p.pid, p]));
  const merged = [...incoming]
    .sort((a, b) => a.pid - b.pid)
    .map((next) => {
      const old = previous.get(next.pid);
      // Keep the old object — and with it the elapsed baseline the components
      // derived from the array identity — when only time has passed.
      return old !== undefined && sameProcessEntry(old, next) ? old : next;
    });
  if (
    merged.length === current.length &&
    merged.every((p, i) => p === current[i])
  ) {
    return current as ProcessState[];
  }
  return merged;
}

/**
 * Apply one `process://update` payload to the store.
 *
 * A payload that is not an array of well-formed rows is ignored wholesale: a
 * half-parsed snapshot could drop a live pid, so the poll is the safer answer.
 * An empty array *is* well-formed — it means nothing is running — and clears the
 * list the same way `live_processes` would.
 */
export function applyProcessUpdate(payload: unknown): void {
  if (!Array.isArray(payload) || !payload.every(isProcessState)) return;
  const merged = mergeProcessUpdates(useProcesses.getState().live, payload);
  if (merged !== useProcesses.getState().live) {
    useProcesses.setState({ live: merged });
  }
}

/**
 * Subscribe to Rust's pushed process snapshots. Returns the cleanup.
 *
 * `listen` resolves asynchronously, so unmount can happen before the subscription
 * exists; the `active` flag makes the late resolution unlisten itself instead of
 * leaving a listener bound to a dead component (the StrictMode double-mount case).
 */
export function subscribeProcessUpdates(): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  const pending = listen<ProcessState[]>("process://update", (event) => {
    if (active) applyProcessUpdate(event.payload);
  });
  void pending
    .then((off) => {
      if (active) unlisten = off;
      else off();
    })
    .catch((e) => {
      if (active) reportError(e, "订阅进程更新失败");
    });
  return () => {
    active = false;
    if (unlisten !== null) {
      unlisten();
      unlisten = null;
    }
  };
}
