/**
 * Storage quota events, turned into at most a couple of user-visible warnings
 * (r26-O3-1).
 *
 * `lib/kv-store.ts` already reports a threshold crossing once per decorator and
 * every refused write. `main.tsx` logged both to `console.warn` only, because
 * `docs/r21-storage-eval.md` deferred the product decision ("no key for storage
 * nearly full"). That is a real gap: a user whose project wall stopped persisting
 * has no way to know short of devtools.
 *
 * This module decides *whether* to speak, not how to phrase it:
 *   - the threshold fires once per session (it is a state, not an event);
 *   - a refused write may repeat forever if the user keeps editing — announce at
 *     most once per [`WRITE_ERROR_COOLDOWN_MS`], because a toast per keystroke is
 *     noise that would hide the first, useful warning.
 *
 * Pure and framework-free; the wiring in `main.tsx` decides the words.
 */
import type { QuotaEvent } from "./kv-store";

export type StorageHealth = {
  thresholdAnnounced: boolean;
  lastWriteErrorAt: number;
};

export const STORAGE_HEALTH_INITIAL: StorageHealth = {
  thresholdAnnounced: false,
  lastWriteErrorAt: 0,
};

/** A refused write can happen on every keystroke; one reminder a minute is enough. */
export const WRITE_ERROR_COOLDOWN_MS = 60_000;

export type StorageAnnouncement = {
  announce: boolean;
  state: StorageHealth;
};

export function nextStorageHealth(
  state: StorageHealth,
  event: QuotaEvent,
  now: number,
): StorageAnnouncement {
  if (event.reason === "threshold") {
    if (state.thresholdAnnounced) return { announce: false, state };
    return { announce: true, state: { ...state, thresholdAnnounced: true } };
  }
  const last = state.lastWriteErrorAt;
  if (last !== 0 && now - last < WRITE_ERROR_COOLDOWN_MS) {
    return { announce: false, state };
  }
  return { announce: true, state: { ...state, lastWriteErrorAt: now } };
}

/** Human-sized MB for the warning; the event carries bytes. */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}
