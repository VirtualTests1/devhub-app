/**
 * Last-known-good snapshots of the wall's local state (r30-N4).
 *
 * The wall's aliases, tags, notes, covers and hand-dragged order live only in
 * `localStorage` under one key. A truncated write, a hand-edited value, or a
 * WebView2 profile reset that leaves the key unreadable loses all of it, and
 * `readStored`'s catch-all fallback silently replaced it with an empty wall —
 * the worst possible answer, because it looks like a first run.
 *
 * This module keeps the last three payloads under a separate key. It stores the
 * wall's own JSON verbatim, so the reader can run exactly the same validation
 * over a snapshot as over the main file. The snapshot is written at most once
 * per interval (the wall persists on every drag tick), newest first, and never
 * for an empty payload.
 *
 * The snapshots are local to the same storage as the main key. They survive a
 * corrupt value and an accidental overwrite of that key; they do not survive
 * clearing the whole profile. That limit is stated in the settings row rather
 * than hidden behind the word "backup".
 */

export const WALL_SNAPSHOTS_KEY = "devhub.wall.snapshots.v1";
export const WALL_SNAPSHOT_LIMIT = 3;
/** How often a snapshot may be taken while the wall keeps changing. */
export const WALL_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export type WallSnapshot = {
  savedAt: number;
  /** The exact JSON the wall would have written to its main key. */
  wall: string;
};

export type SnapshotStorage = Pick<Storage, "getItem" | "setItem">;

function storageOrNull(storage?: SnapshotStorage): SnapshotStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Parse the snapshot list; junk rows are dropped, newest first, capped. */
export function parseSnapshots(raw: string | null): WallSnapshot[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { snapshots?: unknown }).snapshots
      : value;
  if (!Array.isArray(rows)) return [];
  const out: WallSnapshot[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt) || r.savedAt <= 0) continue;
    if (typeof r.wall !== "string" || r.wall.trim() === "") continue;
    out.push({ savedAt: r.savedAt, wall: r.wall });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  // The same payload twice is not two restore points; keep the newest.
  const seen = new Set<string>();
  const unique = out.filter((s) => {
    if (seen.has(s.wall)) return false;
    seen.add(s.wall);
    return true;
  });
  return unique.slice(0, WALL_SNAPSHOT_LIMIT);
}

export function readSnapshots(storage?: SnapshotStorage): WallSnapshot[] {
  const s = storageOrNull(storage);
  if (!s) return [];
  try {
    return parseSnapshots(s.getItem(WALL_SNAPSHOTS_KEY));
  } catch {
    return [];
  }
}

export function latestSnapshot(storage?: SnapshotStorage): WallSnapshot | null {
  return readSnapshots(storage)[0] ?? null;
}

/**
 * Take a snapshot of `wallJson` if it differs from the newest one.
 *
 * The interval throttle lives at the wall store, where "when did we last try"
 * is meaningful; this function is the storage half and always writes when asked.
 * A quota failure retries once with only the new payload, so a large wall can
 * still leave one restore point instead of none.
 */
export function captureSnapshot(
  wallJson: string,
  savedAt: number,
  storage?: SnapshotStorage,
): WallSnapshot | null {
  const s = storageOrNull(storage);
  if (!s || wallJson.trim() === "" || !Number.isFinite(savedAt) || savedAt <= 0) return null;
  const existing = readSnapshots(s);
  if (existing[0]?.wall === wallJson) return existing[0] ?? null;
  const next = [{ savedAt, wall: wallJson }, ...existing].slice(0, WALL_SNAPSHOT_LIMIT);
  try {
    s.setItem(WALL_SNAPSHOTS_KEY, JSON.stringify({ version: 1, snapshots: next }));
    return next[0] ?? null;
  } catch {
    try {
      s.setItem(WALL_SNAPSHOTS_KEY, JSON.stringify({ version: 1, snapshots: [next[0]] }));
      return next[0] ?? null;
    } catch {
      return null;
    }
  }
}
