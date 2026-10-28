import { create } from "zustand";

/**
 * Bounded, persisted history of the failures the user was actually told about
 * (r18 N1).
 *
 * Why this is a store and not a few more lines in `fatal-policy.ts`: that module
 * is the in-session dedupe rule (4 s, memory only), and `report-error.ts` is a
 * one-line toast. Neither survives a reload, so a failure that appears once,
 * gets dismissed, and comes back tomorrow left nothing behind to look at or to
 * paste into an issue. This store is that transcript — capped, folded, and
 * honest about both limits.
 *
 * What lands here: every `reportError` call — all command catch sites, plus the
 * window `error` / `unhandledrejection` handlers, which reach `reportError`
 * through `main.tsx`'s `routeFatal` — and boot-phase fatals, which never make it
 * to a toast. One deliberate gap: a failure `routeFatal` dedupes into `skip` is
 * not re-recorded, because the fold window below already collapses those bursts
 * and an exact counter would mean recording twice per shown failure.
 *
 * Bounded two ways, because a failing poll is the normal case here:
 *
 *   - CAP: newest 50 entries, older ones fall off;
 *   - FOLD: a new entry identical in kind+verb+text within `FOLD_MS` of the head
 *     bumps `count` and `at` instead of pushing a row. The window is twice the
 *     toast dedupe, so a 3-second poll failing for a minute reads as one row
 *     with a count, not twenty rows.
 *
 * Persistence follows `landing.ts`: read once at module init inside a try/catch
 * (no storage in Node tests, private mode in the browser — both start empty),
 * write on every mutation. Writes are rare (a failure event, not a keystroke),
 * so the coalescing writer in `lib/storage.ts` is not needed; the direct call
 * keeps this store testable through `readBack`.
 */

export type FailureKind = "command" | "runtime" | "rejection";

export type FailureEntry = {
  /** Epoch ms of the most recent occurrence of this failure. */
  at: number;
  kind: FailureKind;
  /** The product verb — 保存失败, 运行失败 — what the user was doing. */
  verb: string;
  /** The readable reason (`messageOf`), capped at {@link TEXT_MAX}. */
  text: string;
  /** How many occurrences the head row has folded (always ≥ 1). */
  count: number;
};

const KEY = "devhub.failures.v1";

/** Newest-first cap. 50 rows is a screenful-plus of history, not a log file. */
export const FAILURE_CAP = 50;

/** Repeats of the same failure inside this window fold into the head row. */
export const FOLD_MS = 10_000;

/** Same defensive cap as `fatal-policy.rejectionKey`: a rejection carrying a
 *  megabyte of HTML should not become a megabyte of history. */
export const TEXT_MAX = 300;

/** Verbs are product copy (a few characters today); the cap exists only so a
 *  broken call site cannot stretch a row layout. */
export const VERB_MAX = 40;

const KINDS = new Set<string>(["command", "runtime", "rejection"]);

function isKind(value: unknown): value is FailureKind {
  return typeof value === "string" && KINDS.has(value);
}

/**
 * Coerce whatever `JSON.parse` returned into entries that can be rendered.
 *
 * Drop, don't repair — same rule as `customize.ts`: a row that cannot name its
 * time, kind, verb and text is someone else's junk (hand-edited storage, an
 * older format), and inventing fields for it would put a fabricated failure in
 * the history. `count` is the one field with a fallback (missing or junk → 1):
 * its meaning is "at least once", and every real occurrence counts one.
 */
export function normalizeEntries(parsed: unknown): FailureEntry[] {
  if (!Array.isArray(parsed)) return [];
  const out: FailureEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { at, kind, verb, text, count } = item as Record<string, unknown>;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    if (!isKind(kind)) continue;
    if (typeof verb !== "string" || !verb.trim()) continue;
    if (typeof text !== "string" || !text.trim()) continue;
    out.push({
      at,
      kind,
      verb: verb.trim().slice(0, VERB_MAX),
      text: text.trim().slice(0, TEXT_MAX),
      count:
        typeof count === "number" && Number.isFinite(count) && count >= 1
          ? Math.floor(count)
          : 1,
    });
    if (out.length === FAILURE_CAP) break;
  }
  return out;
}

/**
 * The entry a caller's arguments describe, or null when there is nothing a row
 * could say. An empty reason would render as a nameless failure, which reads
 * like a bug in the panel rather than in the thing that failed.
 */
export function makeEntry(
  kind: FailureKind,
  verb: string,
  text: string,
  at: number,
): FailureEntry | null {
  if (!Number.isFinite(at) || at <= 0) return null;
  const v = verb.trim();
  const x = text.trim();
  if (!v || !x) return null;
  return { at, kind, verb: v.slice(0, VERB_MAX), text: x.slice(0, TEXT_MAX), count: 1 };
}

/**
 * Newest-first insert with the fold rule and the cap.
 *
 * The clamp delta guards a backwards clock: `at` older than the head is never a
 * fold, it is a new row at the front — sorting by arrival rather than by
 * timestamp, because arrival is what the panel can honestly show.
 */
export function foldEntry(
  entries: FailureEntry[],
  entry: FailureEntry,
  foldMs: number = FOLD_MS,
): FailureEntry[] {
  const head = entries[0];
  if (
    head &&
    head.kind === entry.kind &&
    head.verb === entry.verb &&
    head.text === entry.text &&
    entry.at >= head.at &&
    entry.at - head.at <= foldMs
  ) {
    return [{ ...head, at: entry.at, count: head.count + 1 }, ...entries.slice(1)];
  }
  return [entry, ...entries].slice(0, FAILURE_CAP);
}

function read(): FailureEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return normalizeEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persist(entries: FailureEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* quota or private mode: the session keeps its history */
  }
}

type FailureState = {
  entries: FailureEntry[];
  record: (kind: FailureKind, verb: string, text: string, at?: number) => void;
  clear: () => void;
};

export const useFailures = create<FailureState>((set) => ({
  entries: read(),

  record: (kind, verb, text, at = Date.now()) => {
    const entry = makeEntry(kind, verb, text, at);
    if (!entry) return;
    set((s) => {
      const next = foldEntry(s.entries, entry);
      persist(next);
      return { entries: next };
    });
  },

  clear: () => {
    set(() => {
      persist([]);
      return { entries: [] };
    });
  },
}));

/**
 * Record without subscribing to the store — for `reportError` and `main.tsx`,
 * neither of which renders. A React component reads `useFailures` directly.
 */
export function recordFailure(
  kind: FailureKind,
  verb: string,
  text: string,
  at?: number,
): void {
  useFailures.getState().record(kind, verb, text, at);
}
