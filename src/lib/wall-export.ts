/**
 * The wall as a Markdown table (r32-N3).
 *
 * JSON export exists to move wall state to another machine. This one answers a
 * different question: "what is in my collection, in a form I can paste into a
 * README, an issue or a note". It is a snapshot, not an import format — nothing
 * here is ever read back.
 *
 * ## Why every cell is escaped, including `<` and `&`
 *
 * A repository alias, tag or note is user text. Markdown renderers commonly
 * pass raw HTML through, so `|` alone is not the attack surface: a note reading
 * `<img onerror=…>` would become an image tag in any viewer that allows HTML.
 * Cells therefore escape `&`, `<`, `>`, backticks and pipes, and turn newlines
 * into `<br>` *after* escaping, so the only HTML in the output is the one this
 * builder wrote on purpose.
 *
 * ## Ordering and hidden rows
 *
 * Rows are sorted by display name so the same wall produces the same file.
 * Hidden cards are omitted: 隐藏 is the user saying "keep this off the wall",
 * and an export that quietly re-included them would be the wrong default. No
 * timestamp is written — the file is deterministic, and a timestamp makes every
 * export differ for no information the rows do not already carry.
 */
import { slugOf } from "./slug";

export type WallExportRepo = {
  host: string;
  owner: string;
  repo: string;
  path?: string | null;
};

export type WallExportState = {
  alias?: string;
  tags?: string[];
  note?: string;
  hidden?: boolean;
};

export type WallExportRow = {
  /** `owner/repo` — the host is identity, not something a reader wants in every row. */
  name: string;
  alias: string;
  tags: string[];
  note: string;
  path: string;
};

export type WallExportLabels = {
  title: string;
  name: string;
  alias: string;
  tags: string;
  note: string;
  path: string;
  empty: string;
};

const EMPTY_CELL = "—";

/** Escape one cell. Exported so the rules are testable on their own. */
export function markdownCell(value: string, empty: string = EMPTY_CELL): string {
  const text = value.replace(/\u0000/g, "").trim();
  if (!text) return empty;
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

/** Visible wall rows, sorted by display name. */
export function rowsFromWall(
  repos: readonly WallExportRepo[],
  states: Readonly<Record<string, WallExportState | undefined>>,
): WallExportRow[] {
  const rows: WallExportRow[] = [];
  for (const repo of repos) {
    const state = states[slugOf(repo)];
    if (state?.hidden) continue;
    rows.push({
      name: `${repo.owner}/${repo.repo}`,
      alias: state?.alias?.trim() ?? "",
      tags: (state?.tags ?? []).map((t) => t.trim()).filter(Boolean),
      note: state?.note?.trim() ?? "",
      path: repo.path?.trim() ?? "",
    });
  }
  rows.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

/** Build the whole file. Pure: labels arrive already resolved for the locale. */
export function buildWallMarkdown(rows: readonly WallExportRow[], labels: WallExportLabels): string {
  const head = `# ${labels.title}\n\n`;
  if (rows.length === 0) return `${head}${labels.empty}\n`;
  const header = [labels.name, labels.alias, labels.tags, labels.note, labels.path]
    .map((h) => markdownCell(h))
    .join(" | ");
  const divider = "| --- | --- | --- | --- | --- |";
  const lines = rows.map((row) =>
    [
      markdownCell(row.name),
      markdownCell(row.alias),
      markdownCell(row.tags.join(", ")),
      markdownCell(row.note),
      markdownCell(row.path),
    ].join(" | "),
  );
  return `${head}| ${header} |\n${divider}\n${lines.map((l) => `| ${l} |`).join("\n")}\n`;
}
