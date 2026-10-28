/**
 * IME (输入法) guard for fields that commit on Enter.
 *
 * This app is Chinese-first, and on Windows the default editor is an IME. While
 * a pinyin/historical candidate list is open, pressing Enter does NOT mean
 * "I am done with this field" — it means "accept the highlighted candidate". The
 * browser still fires a `keydown` with `key === "Enter"` for that keypress, so a
 * handler that commits on Enter without checking composition state will fire a
 * half-typed value: a download kicked off for `D:\Pro` on the way to
 * `D:\Projects`, a setting saved mid-word, a 端口段 written as whatever the IME
 * had tentatively committed. `AddRepoView` documents the exact hazard (a
 * half-typed path), and the same class of bug lives in every Enter-commits-input
 * pair.
 *
 * Two signals, and we honour both:
 *   - `isComposing` (React surfaces it on the synthetic event *and* on
 *     `nativeEvent`) is the modern, spec'd flag — true for the whole time the
 *     candidate window is open.
 *   - `keyCode === 229` is the legacy tell every engine still sets while a
 *     composition is in progress, and some (older WebView2 / Chromium edge
 *     cases) rely on it alone.
 *
 * Keep this a pure predicate over the smallest shape that carries those fields,
 * so it is testable without a DOM and works from `React.KeyboardEvent`,
 * `KeyboardEvent` or a synthetic test stub alike.
 */

/** The minimal shape a composition-aware key event must carry. */
export type MaybeComposing = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/** True while an IME composition is in progress for this event. */
export function isImeComposing(e: MaybeComposing): boolean {
  if (e.isComposing === true) return true;
  if (e.nativeEvent?.isComposing === true) return true;
  if (e.keyCode === 229) return true;
  if (e.nativeEvent?.keyCode === 229) return true;
  return false;
}

/**
 * True when this event is the Enter that should commit a field: the physical
 * Enter key, and not a composition confirmation. Handlers that already branch
 * on `e.key === "Enter"` can gate the whole body on this.
 */
export function isCommitEnter(e: MaybeComposing & { key?: string }): boolean {
  return e.key === "Enter" && !isImeComposing(e);
}
