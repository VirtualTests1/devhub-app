import type { SettingsView } from "../../types";

/**
 * Portable fields of a settings export.
 *
 * Machine-bound facts stay out on purpose:
 *   - `projectRoot` / `projectRootIsDefault` / `recentRoots`: moving roots between
 *     machines is how people wipe the wrong disk.
 *   - `configPath` / `hasGithubToken` / `hostsHijacked` / `hostsBy`: derived or
 *     secret-adjacent; the token itself is never written to the export file.
 * Everything else is a preference that should follow the user.
 */
export const XFER_FIELDS = [
  "mirrorEnabled",
  "ipPinEnabled",
  "mirrors",
  "proxy",
  "extraRoots",
  "terminalChoice",
  "ideChoice",
  "customIdes",
  "activityRetentionDays",
  "searchRoute",
  "downloadRoute",
  "searchDebounceMs",
  "parallelDownloads",
  "cleanupMode",
  "cleanupKeepDays",
] as const satisfies readonly (keyof SettingsView)[];

export type SettingsXfer = Partial<Pick<SettingsView, (typeof XFER_FIELDS)[number]>> & {
  /** Schema tag so a future format change can be detected. */
  format: "devhub-settings";
  version: 1;
};

/** Expected runtime type for each portable field (arrays = "array"). */
const FIELD_KIND: Record<(typeof XFER_FIELDS)[number], "string" | "number" | "boolean" | "array"> = {
  mirrorEnabled: "boolean",
  ipPinEnabled: "boolean",
  mirrors: "array",
  proxy: "string",
  extraRoots: "array",
  terminalChoice: "string",
  ideChoice: "string",
  customIdes: "array",
  activityRetentionDays: "number",
  searchRoute: "string",
  downloadRoute: "string",
  searchDebounceMs: "number",
  parallelDownloads: "number",
  cleanupMode: "string",
  cleanupKeepDays: "number",
};

export function buildXfer(settings: SettingsView | null): SettingsXfer | null {
  if (!settings) return null;
  const out: Record<string, unknown> = { format: "devhub-settings", version: 1 };
  for (const k of XFER_FIELDS) {
    const v = settings[k];
    if (v !== undefined) out[k] = v;
  }
  return out as SettingsXfer;
}

/**
 * Validates an imported blob. Returns a clean patch of only the known fields
 * with the right primitive types — unknown keys and wrong types are dropped
 * rather than forwarded to the backend.
 */
export function parseXfer(text: string): { patch: Record<string, unknown>; dropped: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("不是合法的 JSON 文件");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("文件顶层不是对象");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== "devhub-settings") {
    throw new Error("缺少 format: \"devhub-settings\" 标记，可能不是设置导出文件");
  }
  const patch: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const k of XFER_FIELDS) {
    if (!(k in obj)) continue;
    const v = obj[k];
    const kind = FIELD_KIND[k];
    let ok: boolean;
    if (kind === "array") ok = Array.isArray(v);
    else if (kind === "number") ok = typeof v === "number" && Number.isFinite(v);
    else ok = typeof v === kind;
    if (ok) patch[k] = v;
    else dropped.push(k);
  }
  return { patch, dropped };
}
