/**
 * The pure half of the local-README preview (round 17, n2-3).
 *
 * `RepoReadmeDialog.tsx` owns the IPC and the JSX. Everything that is only a
 * decision about *strings and bytes* lives here instead, in a `.ts` module the
 * Node runner can import — the runner strips types and refuses `.tsx`, so logic
 * left inside the dialog is logic no unit test can reach
 * (`tests/lib-import-graph.test.ts` states the same rule for `src/lib/**`).
 *
 * Three decisions are separated, each for its own reason:
 *
 *   - **Which filenames to try** ([`README_CANDIDATES`]) and in what order.
 *     GitHub looks for these spellings in this order, and the dialog's probe is
 *     that order — a fifth spelling becomes a one-line change here rather than a
 *     loop inside JSX.
 *   - **How much of a file to render** ([`capUtf8`]). The cap is a byte count
 *     (256 KB) but the file is read as a JS string, so the cut has to land on a
 *     code-point boundary: slicing raw bytes and decoding would leave the tail
 *     character as U+FFFD, a replacement glyph the reader would mistake for the
 *     file's own text.
 *   - **Whether a backend refusal means "no such file"** ([`isMissingFileReason`]).
 *     `read_text_file`'s guard answers a missing path with its stable
 *     `code() == "missing"` token; that token is the durable part, while matching
 *     the Chinese sentence around it would break as soon as the wording moved.
 *
 * No React, no Tauri: this module is importable under Node's type stripping.
 */

/** GitHub's own README spellings, in the order GitHub itself looks for them. */
export const README_CANDIDATES = ["README.md", "readme.md", "README.markdown", "README"] as const;

/**
 * How many bytes of the file the dialog renders. The backend already refuses
 * anything over 4 MB (`read_text_file` checks the size before reading); this is
 * the tighter, dialog-level cap so an ordinary large README need not cross IPC
 * in full.
 */
export const README_MAX_BYTES = 256 * 1024;

/**
 * The first `limit` bytes of `raw`, decoded back to a string, plus whether the
 * original was longer than that.
 *
 * The cut backs off to the last complete UTF-8 sequence, so a multi-byte
 * character straddling the limit is dropped whole instead of being decoded as
 * the U+FFFD replacement character.
 */
export function capUtf8(
  raw: string,
  limit: number = README_MAX_BYTES,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.length <= limit) return { text: raw, truncated: false };
  let end = Math.max(0, Math.floor(limit));
  // A UTF-8 continuation byte is 0b10xxxxxx; stepping back while the first
  // *excluded* byte is one keeps a partial sequence out of the decoded slice.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * Does a `read_text_file` refusal mean "there is no such file"?
 *
 * `path_guard::guard` maps its `GuardError` through `Display`, which renders as
 * `{message} ({code})` (`path_guard.rs:97-101`), and `Missing` is the only case
 * whose `code` is `missing` — so a missing path arrives as
 * `路径不存在或无法解析：… (missing)`. The token is matched as a **suffix**, not
 * a substring: `GuardError::Missing { shown }` embeds the path in the sentence,
 * so `includes` would misread a directory literally named `(missing)` as a
 * missing file instead of the refusal it is. Every other refusal (outside the
 * roots, denied, empty, traversal) must be surfaced, not swallowed.
 */
export function isMissingFileReason(reason: string): boolean {
  return /\(missing\)\s*$/.test(reason);
}
