/**
 * Recently used clone branches (r27-N1).
 *
 * The add view offers these as a datalist, the same "paths you chose" pattern
 * `landing.ts` uses for landing directories. A recent value is remembered at
 * click time, not on success: a branch that failed because the remote did not
 * have it yet is still a branch this person types.
 *
 * Pure parse/serialize so the cap and dedupe rules are testable without a DOM.
 */
export const BRANCH_RECENT_KEY = "devhub.download.branches.v1";
export const BRANCH_RECENT_CAP = 8;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storageOrNull(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What a stored JSON array means, keeping only plausible branch names. */
export function parseBranches(raw: string | null, cap = BRANCH_RECENT_CAP): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || name.length > 255 || name.startsWith("-")) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= Math.max(0, Math.floor(cap))) break;
  }
  return out;
}

export function readBranches(storage: StorageLike | null = storageOrNull()): string[] {
  if (!storage) return [];
  try {
    return parseBranches(storage.getItem(BRANCH_RECENT_KEY));
  } catch {
    return [];
  }
}

/** Newest first, deduped, capped. Returns the new list for the caller's state. */
export function rememberBranch(
  name: string,
  storage: StorageLike | null = storageOrNull(),
): string[] {
  const trimmed = name.trim();
  if (!trimmed) return readBranches(storage);
  const next = parseBranches(JSON.stringify([trimmed, ...readBranches(storage)]));
  if (storage) {
    try {
      storage.setItem(BRANCH_RECENT_KEY, JSON.stringify(next));
    } catch {
      // A full/unavailable storage must not block a download.
    }
  }
  return next;
}
