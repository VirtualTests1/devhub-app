import type { LaunchStep } from "../../types";

/**
 * In-memory identity for the rows of the step editor.
 *
 * The defect (round 12, 让失败可见 8.5): `StepsEditor.tsx:34` keyed the list by
 * array index while `move()` (`:23-29`) swaps rows that contain a controlled
 * `<input value={s.name}>`. React then reuses the DOM node in the *slot*, so the
 * caret — and, on a Chinese-language app, the IME preedit string — stays pinned
 * to position N while the step it belongs to walks away to N±1. Typing "安装依赖"
 * and pressing 下移 once can leave the half-typed composition in the row above
 * the step it was typed for.
 *
 * The rule this file keeps: the id never leaves React.
 *   - It is not in `LaunchStep` (`types.ts:267-272`), so nothing that stores a
 *     `.devhub.json` step list can acquire it.
 *   - It is stripped by {@link withoutKeys} before any `invoke`, which includes
 *     `confirm_launch_steps` and `launch_steps_all`. `launch.rs:625` has no
 *     `deny_unknown_fields`, so a leak would be *accepted* rather than rejected —
 *     silently persisting a field the type does not declare is exactly the drift
 *     that makes a stored marker unreadable on the next round.
 *   - It is allocated from a module counter, not derived from position or name: a
 *     key derived from either is unstable under the very reorder this is meant to
 *     survive.
 */

/** A step as it exists in React state: keyed, possibly for the first time. */
export type MaybeKeyedStep = LaunchStep & { uid?: number };

/** A step with its identity assigned. What the editor and the row keys use. */
export type KeyedStep = LaunchStep & { uid: number };

let nextUid = 1;

/**
 * Give every step an id, keeping the ones that already have one.
 *
 * Idempotent by design: it is called when a marker loads, when a template is
 * applied, when a row is added, and after a save re-read — each of those must
 * leave the rows the user is looking at with the identities they already had, or
 * the inputs remount and the caret jumps, which is the bug.
 */
export function withKeys(steps: readonly MaybeKeyedStep[]): KeyedStep[] {
  return steps.map((s) => ({ ...s, uid: typeof s.uid === "number" ? s.uid : nextUid++ }));
}

/**
 * The shape that goes over IPC and into the dirty check: the four real fields,
 * same key order they arrived in.
 *
 * The order matters more than it looks: `LaunchDialog`'s `dirtySteps` compares
 * `JSON.stringify` of the draft against `effectiveStepsOf(detail)`, and
 * `JSON.stringify` is sensitive to key order. A rest-destructuring copy is what
 * keeps the two sides the same string.
 */
export function withoutKeys(steps: readonly MaybeKeyedStep[]): LaunchStep[] {
  return steps.map((s) => {
    const { uid: _uid, ...rest } = s;
    return rest;
  });
}

/**
 * Swap a step with its neighbour, or return the input untouched.
 *
 * Pure (it copies), and it moves the *objects*, so the uid travels with the step
 * it belongs to — which is the whole property the index-keyed version could not
 * hold. Out of range is a no-op rather than a throw: the 上移/下移 buttons are
 * disabled at the ends, and a helper that reorders a list must not be able to
 * break a dialog.
 */
export function moveStep(steps: KeyedStep[], i: number, dir: -1 | 1): KeyedStep[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const next = [...steps];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return steps;
  next[i] = b;
  next[j] = a;
  return next;
}
