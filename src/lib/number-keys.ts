/**
 * Keyboard stepping for `type="number"` fields.
 *
 * ## Why not trust the browser
 *
 * Chromium/WebView2 give number inputs ↑↓ spin-button behaviour for free, but:
 * - PageUp/PageDown (×10) and Home/End (→min/max) are **not** guaranteed.
 * - The app's own tests dispatch synthetic KeyboardEvents, which never trigger
 *   UA default actions — so anything left to the browser is untestable.
 * - Two of the three call sites also need Enter to commit (SettingsView only
 *   had onBlur; a number field that ignores Enter reads as broken next to the
 *   text fields on the same page, which all accept it).
 *
 * ## Contract
 *
 * The handler computes the next value and hands it to `apply` — it never
 * clamps. Clamping lives in the caller's `apply` (or in `setPx` for the font
 * size), because only the caller knows the domain (12–22 px vs 0–30000 ms).
 * PageUp/PageDown and Shift+Arrow multiply the step by 10 — the same gesture
 * editors use for font size, and the reason a 0–30000 ms slider is usable at
 * all with a keyboard.
 */
export function numberKeyHandler(opts: {
  min: number;
  max: number;
  step: number;
  /** Receives the already-clamped next value. */
  apply: (next: number) => void;
  /** Called on Enter — commit-on-blur counterparts pass their commit here. */
  commit?: () => void;
}): (e: React.KeyboardEvent) => void {
  const { min, max, step, apply, commit } = opts;
  return (e) => {
    const cur = Number((e.target as HTMLInputElement).value);
    if (e.key === "Enter") {
      e.preventDefault();
      commit?.();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const bump = e.shiftKey ? step * 10 : step;
    let next: number;
    switch (e.key) {
      case "ArrowUp":
        next = cur + bump;
        break;
      case "ArrowDown":
        next = cur - bump;
        break;
      case "PageUp":
        next = cur + step * 10;
        break;
      case "PageDown":
        next = cur - step * 10;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    // The caller's apply clamps; rounding happens here so 12.7 + 1 → 14, not 13.7.
    apply(Math.min(max, Math.max(min, Math.round(next))));
  };
}
