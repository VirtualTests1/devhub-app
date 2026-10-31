/**
 * Move one item in an ordered list. Used by the sidebar's keyboard reorder
 * (Alt+↑/↓) and kept pure so the boundary cases are testable without a DOM.
 *
 * Out-of-range indices return a copy unchanged: a keypress at the first/last
 * item is a no-op, not a reason to throw or to move something to the end.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) {
    return next;
  }
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
