/**
 * The frontend half of r18-R1's change notification: register what to watch, subscribe to
 * what changed, and fold "something happened" into at most one reload at a time.
 *
 * ## Why a gate exists
 *
 * The backend already folds a burst into one notification (`fs_watch::DebouncedBatch`,
 * 1.2 s quiet window). This is a *different* fold: the wall reload it triggers is a
 * `list_repositories` + a metadata walk that takes longer than the next notification
 * arrives. Without it, three batches during an `npm install` queue three full walks
 * back-to-back — the exact "UI 刷爆" failure the coalescer was written to prevent,
 * re-created one layer up.
 *
 * The rule is one-in-flight-plus-one-pending: while a reload runs, further requests
 * collapse into a single "run again when this one finishes", and no more. A queue would
 * remember every past change, which is what a *refresh* must not do — the newest read
 * already contains all of them.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type WatchRoot = { slug: string; path: string };

/** Ask the backend to watch these roots. Resolves to how many it accepted. */
export function registerWatchRoots(roots: readonly WatchRoot[]): Promise<number> {
  return invoke<number>("watch_repositories", { roots: roots.map((r) => ({ slug: r.slug, path: r.path })) });
}

/** Subscribe to `repo://changed`. Resolves to the unlisten function, like every listener. */
export function watchRepoChanged(onChange: (slugs: string[]) => void): Promise<() => void> {
  return listen<{ slugs?: string[] }>("repo://changed", (ev) => onChange(ev.payload?.slugs ?? []));
}

export type GateOutcome = "started" | "queued";

/**
 * One in flight, at most one waiting. See the module header for why that is the shape.
 *
 * `run` may return a promise; the gate releases on its settle, including on rejection
 * (a failed reload must not wedge the gate shut — that is how a watcher "stops working"
 * with nothing on screen to say so).
 */
export function createReloadGate(run: () => void | Promise<unknown>) {
  let running = false;
  let queued = false;

  const gate = {
    request(): GateOutcome {
      if (running) {
        queued = true;
        return "queued";
      }
      running = true;
      let result: unknown;
      try {
        result = run();
      } catch (e) {
        // A synchronous throw releases the gate immediately, then rethrows to the caller
        // that asked for the reload.
        running = false;
        if (queued) {
          queued = false;
          gate.request();
        }
        throw e;
      }
      Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (queued) {
            queued = false;
            gate.request();
          }
        });
      return "started";
    },
    /** Exposed for tests and for a debug panel; nothing in the app reads them. */
    isRunning(): boolean {
      return running;
    },
    isQueued(): boolean {
      return queued;
    },
  };
  return gate;
}
