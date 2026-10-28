/**
 * 常用页固定项的序列化与「一份可信列表」。
 *
 * These functions used to live in `settingsCatalog.tsx`, which is fine for the
 * app and useless for `pnpm test`: Node's type-stripping runner cannot even
 * parse JSX, so every assertion about how a pinned entry round-trips had to be
 * observed through a `.tsx` — that is, not at all. Moving the declarations here
 * (a plain `.ts`, imports nothing) makes them testable; `settingsCatalog.tsx`
 * re-exports them so no import site has to change.
 */

/**
 * Everything the 常用 page can pin besides a project (需求 7).
 *
 * A pinned entry navigates: a view entry switches the shell, a settings entry
 * opens 设置 on that catalog page. The ids are prefixed so one flat list can
 * hold both kinds - and so a future kind does not have to reshuffle the old.
 */
export type FrequentEntry =
  | { kind: "repo"; id: string }
  | { kind: "view"; id: string }
  | { kind: "settings"; id: string };

/** Serialises an entry for the pinned list (`repo:github.com/a/b`). */
export function entryId(kind: FrequentEntry["kind"], id: string): string {
  return `${kind}:${id}`;
}

/**
 * Parses a stored entry. Bare ids are pre-round-9 repository slugs: the list
 * used to hold nothing else, and dropping them on upgrade would empty a page
 * the person had arranged.
 */
export function parseEntry(raw: string): FrequentEntry | null {
  const value = raw.trim();
  if (!value) return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return { kind: "repo", id: value };
  const kind = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (!id) return null;
  if (kind === "repo" || kind === "view" || kind === "settings") return { kind, id };
  // A slug with a colon in it (never seen, but a Windows path in `local` is
  // not impossible) parses as a repository rather than being dropped.
  return { kind: "repo", id: value };
}

/** One pinned item as the page uses it: the canonical id plus the parsed entry. */
export type PinnedEntry = { id: string; entry: FrequentEntry };

/**
 * parse → drop what parses to nothing → dedupe by canonical id, in stored order.
 *
 * This is the **only** list the page is allowed to read. It used to have two:
 * the cards were mapped off a parsed copy while the drag arithmetic, the
 * 第 N/M 项 readout and the `key`s were indexed into the raw string array.
 * Any stored string `parseEntry` rejected shifted that mismatch by one, and a
 * bare pre-round-9 slug (`github.com/a/b` next to its own `repo:github.com/a/b`
 * on an imported list) collided keys and turned reordering into a no-op. One
 * list, one id scheme: render, index/total, drag filter and keys all name the
 * same item the same way.
 */
export function canonicalEntries(raws: readonly string[]): PinnedEntry[] {
  const seen = new Set<string>();
  const out: PinnedEntry[] = [];
  for (const raw of raws) {
    const entry = parseEntry(raw);
    if (!entry) continue;
    const id = entryId(entry.kind, entry.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, entry });
  }
  return out;
}
