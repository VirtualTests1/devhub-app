/**
 * Licence overview: the wire shape, the summary and the CSV.
 *
 * The backend (`license_overview`) reports **facts about files**, not legal
 * conclusions: `detected` came from licence text, `declared` from a manifest,
 * `unknown` is a licence file nobody classified, `missing` is neither. The
 * summary keeps those four apart because collapsing "missing" into "unknown"
 * turns a compliance gap into a reading task.
 */

export type LicenseRow = {
  slug: string;
  license: string | null;
  source: string;
  file: string | null;
  confidence: "detected" | "declared" | "unknown" | "missing";
  error: string | null;
};

export type LicenseOverview = {
  rows: LicenseRow[];
  scanned: number;
  capped: boolean;
  elapsedMs: number;
};

export type LicenseSummary = {
  total: number;
  known: number;
  missing: number;
  unknown: number;
  detected: number;
  declared: number;
  /** Known licence names, most common first, then alphabetically. */
  byLicense: [string, number][];
};

export function summarizeLicenses(rows: readonly LicenseRow[]): LicenseSummary {
  const counts = new Map<string, number>();
  let missing = 0;
  let unknown = 0;
  let detected = 0;
  let declared = 0;
  let known = 0;
  for (const row of rows) {
    if (row.confidence === "missing") {
      missing += 1;
      continue;
    }
    if (row.confidence === "unknown" || row.license === null) {
      unknown += 1;
      continue;
    }
    known += 1;
    if (row.confidence === "detected") detected += 1;
    else if (row.confidence === "declared") declared += 1;
    counts.set(row.license, (counts.get(row.license) ?? 0) + 1);
  }
  const byLicense = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return { total: rows.length, known, missing, unknown, detected, declared, byLicense };
}

/**
 * Neutralise a spreadsheet formula in one field.
 *
 * The same boundary as the activity CSV export: a repository can be named
 * `=HYPERLINK(...)`, and a licence expression is free text from a manifest. A
 * leading `'` makes Excel/LibreOffice treat the cell as text. The apostrophe is
 * inside the quoted field, so it is part of the data and visible.
 */
export function csvSafe(value: string): string {
  const first = value.charAt(0);
  const neutral = first === "=" || first === "+" || first === "-" || first === "@" || first === "\t" || first === "\r";
  const text = neutral ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV row per repository, header included. */
export function licenseCsv(rows: readonly LicenseRow[]): string {
  const header = ["slug", "license", "source", "file", "confidence", "error"];
  const lines = [header.map(csvSafe).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.slug,
        row.license ?? "",
        row.source,
        row.file ?? "",
        row.confidence,
        row.error ?? "",
      ]
        .map(csvSafe)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** A stable tone for a row's badge. */
export function licenseTone(row: LicenseRow): "ok" | "warn" | "muted" {
  if (row.confidence === "missing") return "warn";
  if (row.confidence === "unknown" || row.license === null) return "muted";
  return "ok";
}
