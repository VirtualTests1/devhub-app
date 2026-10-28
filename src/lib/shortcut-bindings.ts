/**
 * Where a user's key bindings live (r20-N1-2).
 *
 * `localStorage`, versioned key `devhub.shortcuts.v1`, like every other webview-side
 * preference in this app (`devhub.wall.v1`, `devhub.failures.v1`, …). Not the backend
 * `AppConfig`: that struct is closed and typed, so an extra JSON key is silently
 * dropped rather than stored — the same reason `src/lib/i18n.ts` keeps the language
 * choice here (`DEVELOPMENT.md` §4, 界面语言 rule 3).
 *
 * What is stored is the *override map*, never the resolved key map. Defaults therefore
 * stay a code fact: shipping a better chord for an action that nobody re-bound is a
 * one-line change in `shortcut-actions.ts` and needs no migration.
 */
import { SHORTCUT_ACTIONS } from "./shortcut-actions";
import { findConflicts, formatChord, parseChord, resolveBindings } from "./shortcuts";

const STORAGE_KEY = "devhub.shortcuts.v1";

/** Only ids that still exist survive a load: a removed action must not keep a ghost
 * binding that blocks the chord for someone else. */
function knownIds(): Set<string> {
  return new Set(SHORTCUT_ACTIONS.map((a) => a.id));
}

export function loadOverrides(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const ids = knownIds();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ids.has(key)) continue;
    if (typeof value !== "string") continue;
    // Two spellings of "no key" are stored, and both mean the same thing: `""` is
    // what 清除 writes, `null` is what a hand-edited file looks like.
    if (value === "") continue;
    if (!parseChord(value)) continue;
    out[key] = value;
  }
  return out;
}

function saveOverrides(overrides: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Refused write: the in-session map stays correct, the next launch falls back to
    // defaults. Same trade as `src/lib/launch-templates.ts` makes for the same reason.
  }
}

/** The resolved map the shell dispatches against, and the conflicts the help panel
 * has to show. Computed together so a conflict cannot be reported against one copy of
 * the bindings and dispatched from another.
 *
 * Cached on the stored string, because the shell calls this on **every** keydown and
 * a `localStorage` read plus a `JSON.parse` per keystroke is a real cost while typing
 * in the 搜索项目 box. The key is the raw value, so any write — including one from
 * another window — recomputes on the next call.
 */
let cacheRaw: string | null = null;
let cacheMap: {
  bindings: Record<string, string>;
  conflicts: Record<string, string[]>;
} | null = null;

export function currentKeyMap(): {
  bindings: Record<string, string>;
  conflicts: Record<string, string[]>;
} {
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (cacheMap && raw === cacheRaw) return cacheMap;
  const bindings = resolveBindings(SHORTCUT_ACTIONS, loadOverrides());
  cacheMap = { bindings, conflicts: findConflicts(bindings) };
  cacheRaw = raw;
  return cacheMap;
}

export type BindResult =
  | { ok: true; chord: string; over: string[] }
  | { ok: false; reason: "unparsable" | "unknown-action"; chord: string };

/**
 * Bind `actionId` to `chordText`.
 *
 * A chord that lands on another action is NOT refused. Refusing would mean the user
 * cannot swap two keys in one edit, which is how every rebind UI that ever existed
 * got blamed; instead the previous claimant is listed in `over` so the panel can say
 * which action just lost its key, and `currentKeyMap().conflicts` keeps saying it
 * until the user fixes one of them.
 */
export function setBinding(actionId: string, chordText: string): BindResult {
  const ids = knownIds();
  if (!ids.has(actionId)) return { ok: false, reason: "unknown-action", chord: chordText };
  const parsed = parseChord(chordText);
  if (!parsed) return { ok: false, reason: "unparsable", chord: chordText };
  // Stored in canonical form, so `ctrl+alt+k` and `Alt+Ctrl+K` cannot be two different
  // bindings that the conflict table then fails to notice.
  const canonical = formatChord(parsed);
  const overrides = loadOverrides();
  overrides[actionId] = canonical;
  const after = resolveBindings(SHORTCUT_ACTIONS, overrides);
  // Who just lost their key: any other action whose canonical chord equals the new
  // one. Their own binding did not change — that is the point: two actions now answer
  // to one chord, and the panel has to name both.
  const over = Object.entries(after)
    .filter(([id, chord]) => id !== actionId && sameChord(chord, canonical))
    .map(([id]) => id);
  saveOverrides(overrides);
  return { ok: true, chord: canonical, over };
}

/** Two chord strings that mean the same press. */
function sameChord(a: string, b: string): boolean {
  const pa = parseChord(a);
  const pb = parseChord(b);
  if (!pa || !pb) return false;
  return formatChord(pa) === formatChord(pb);
}

/** Back to the shipped chord for one action. */
export function clearBinding(actionId: string): void {
  const overrides = loadOverrides();
  delete overrides[actionId];
  saveOverrides(overrides);
}

export function resetBindings(): void {
  saveOverrides({});
}

/** The shipped default, for the panel's 恢复默认 hint next to a changed binding. */
export function defaultChord(actionId: string): string | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === actionId)?.defaultChord;
}
