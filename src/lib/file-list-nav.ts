/**
 * Roving focus for the repository file list (r25-N2).
 *
 * The list is a flat, already-bounded array rendered as buttons. Arrow keys
 * move focus without opening anything, so browsing does not fire `read_text_file`
 * for every row; Enter is the button's own activation. Ends clamp rather than
 * wrap: in a file list, wrapping from the last row to the first hides the fact
 * that you reached the end.
 */
export function moveFileIndex(current: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(length - 1, Math.max(0, current) + (current < 0 ? 0 : 1));
    case "ArrowUp":
      return Math.max(0, current < 0 ? 0 : current - 1);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}
