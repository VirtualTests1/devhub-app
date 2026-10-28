/**
 * The palette's scope prefixes, as a pure parser (r24-N1-1).
 *
 * The palette ranks four groups as one list, which is right when you do not know
 * what you are looking for and wrong when you do. Typing `@` before a term is the
 * cheap way to say "only projects" without adding a second control: no chips to
 * click, no state that can disagree with the text field.
 *
 *   >  commands (动作 + 设置项)
 *   @  projects
 *   #  operation records
 *
 * A prefix is only a prefix at byte 0. A leading space makes the character part of
 * the search term, so `" @"` still searches for a literal `@` — otherwise there
 * would be no way to search for the character at all.
 *
 * No React, no storage, no i18n: `tests/lib-import-graph.test.ts` loads every
 * `src/lib/**` module under Node's type stripping, and this file is imported by a
 * component that must not gain a dependency from it.
 */

/** The four result groups the palette already renders. */
export type PaletteGroup = "projects" | "actions" | "settings" | "records";

/** What a leading character narrows to, or `null` for "everything". */
export type PaletteScope = "commands" | "projects" | "records";

export type ParsedPaletteQuery = {
  /** `null` = no prefix; rank across every group. */
  scope: PaletteScope | null;
  /** The prefix character, kept so the field can show which scope is active. */
  prefix: "" | ">" | "@" | "#";
  /** Everything after the prefix, with leading spaces removed. */
  text: string;
};

const PREFIXES: Readonly<Record<string, PaletteScope>> = {
  ">": "commands",
  "@": "projects",
  "#": "records",
};

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const prefix = raw[0] ?? "";
  const scope = PREFIXES[prefix] ?? null;
  if (scope === null) return { scope: null, prefix: "", text: raw };
  return { scope, prefix: prefix as ParsedPaletteQuery["prefix"], text: raw.slice(1).trimStart() };
}

/**
 * The groups one scope admits, or `null` for "no narrowing".
 *
 * `>` deliberately includes settings: 动作 and 设置项 are both "do something"
 * commands, and a scope that hid 设置 would send people back to the unfiltered
 * list for the most common verb-shaped query.
 */
export function groupsForScope(scope: PaletteScope | null): readonly PaletteGroup[] | null {
  switch (scope) {
    case "commands":
      return ["actions", "settings"];
    case "projects":
      return ["projects"];
    case "records":
      return ["records"];
    default:
      return null;
  }
}

export function inScope(group: PaletteGroup, scope: PaletteScope | null): boolean {
  const groups = groupsForScope(scope);
  return groups === null || groups.includes(group);
}

/**
 * The rows a scope keeps, in their existing order.
 *
 * The component's two ranking paths (empty query, typed query) both narrow here,
 * so a scope cannot apply to one and be forgotten by the other.
 */
export function filterByScope<T extends { group: PaletteGroup }>(
  rows: readonly T[],
  scope: PaletteScope | null,
): T[] {
  return rows.filter((row) => inScope(row.group, scope));
}
