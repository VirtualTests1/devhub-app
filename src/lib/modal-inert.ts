/**
 * Inerting what a modal covers (r20-O4-1).
 *
 * `DialogShell.tsx` traps Tab and restores focus, so keyboard users cannot walk out
 * of a dialog — but that is only a *behavioural* promise. Everything behind the scrim
 * stays in the accessibility tree and remains programmatically focusable, so a screen
 * reader still announces the 项目墙 behind an open 启动对话框, and a click can land on
 * a control that is invisible. `aria-hidden` alone would be worse than the status quo:
 * it hides the subtree from assistive tech while leaving it focusable, which is the
 * exact mismatch the HTML spec introduced `inert` to fix.
 *
 * The two attributes are therefore applied together, and removed together, by the same
 * call — a partial application is the broken state, not a cheaper one.
 *
 * Written against a structural type rather than `HTMLElement`, and given the sibling
 * list instead of reaching for `document`, because this repo's unit tests run under
 * `node --test` with no DOM (`tests/lib-import-graph.test.ts` loads every module in
 * this directory without one). The behaviour that matters — which siblings get touched,
 * and what a restore puts back — is then testable rather than aspirational.
 */

export type InertableElement = {
  /** The `inert` IDL attribute. Absent on a document fragment that predates it;
   * `setAttribute` below covers the content-attribute path for old engines. */
  inert?: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  /** Only used to recognise another open dialog (`data-layer="scrim"`). */
  dataset?: Record<string, string | undefined>;
};

/**
 * Mark every sibling except `self` (and any other open scrim) inert.
 *
 * Returns the restore. Siblings that were already inert before the dialog opened keep
 * that state: the restore only un-marks what *this* call marked, so nesting two dialogs
 * cannot resurrect a panel a person had deliberately disabled.
 */
export function applyModalInert<T extends InertableElement>(siblings: readonly T[], self: T): () => void {
  const touched: T[] = [];
  for (const el of siblings) {
    if (el === self) continue;
    // A second dialog's scrim must stay reachable: its own trap is what protects it,
    // and inertiing it would make the topmost dialog's controls unfocusable.
    if (el.dataset?.layer === "scrim") continue;
    if (el.inert === true) continue;
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    touched.push(el);
  }
  return () => {
    for (const el of touched) {
      el.inert = false;
      el.removeAttribute("aria-hidden");
    }
  };
}
