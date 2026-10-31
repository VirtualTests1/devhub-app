/**
 * A `localStorage` write that says whether it happened.
 *
 * Every store in this app already catches `setItem` failures, because the call
 * can throw (`QuotaExceededError`, a denied origin, a wedged WebView2 profile).
 * What several of them did next was return the in-memory list and let the UI
 * print 已保存: the change was true for the session and gone on restart, with no
 * sentence saying so. This helper keeps the catch, and turns it into a value the
 * caller can show.
 */
export type PersistOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

export function persistJson(key: string, value: unknown): PersistOutcome {
  if (typeof localStorage === "undefined") {
    return { ok: false, error: new Error("localStorage is unavailable") };
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function removeKey(key: string): PersistOutcome {
  if (typeof localStorage === "undefined") {
    return { ok: false, error: new Error("localStorage is unavailable") };
  }
  try {
    localStorage.removeItem(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
