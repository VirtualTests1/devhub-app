import type { RepoState, WallPrefs } from "./wall";
import { SORTS, FILTERS, WALL_DENSITIES, sanitiseNote, sanitiseTags } from "./wall";
import { sanitiseViews, type WallView } from "../lib/wall-views";

/**
 * Portable project-wall export.
 *
 * Same rule as settings export (`settings-xfer.ts`): display preferences
 * travel, machine-bound facts do not. The wall's own state already sanitises
 * untrusted JSON on load (`sanitiseRepo`); this module is the write/parse side
 * of that same trust boundary, plus a format tag so a random JSON file cannot
 * be mistaken for a wall export.
 *
 * r31-N1 adds the saved views as an optional top-level key. The version stays 1
 * because the change is additive: an old reader ignores an unknown key (the
 * existing forward-compatibility test pins that), and a file without `views`
 * must not clear the receiving machine's views. Only a file that explicitly
 * carries the key replaces them.
 */
export type WallXfer = {
  format: "devhub-wall";
  version: 1;
  prefs: Pick<WallPrefs, "sort" | "filter" | "grouped" | "density">;
  repos: Record<string, RepoState>;
  /** Saved wall views; absent in exports written before r31. */
  views?: WallView[];
};

export function buildWallXfer(state: {
  sort: WallPrefs["sort"];
  filter: WallPrefs["filter"];
  grouped: boolean;
  density: WallPrefs["density"];
  repos: Record<string, RepoState>;
  views?: readonly WallView[];
}): WallXfer {
  return {
    format: "devhub-wall",
    version: 1,
    prefs: {
      sort: state.sort,
      filter: state.filter,
      grouped: state.grouped,
      density: state.density,
    },
    repos: state.repos,
    ...(state.views === undefined ? {} : { views: state.views.map((v) => ({ ...v, tags: [...v.tags] })) }),
  };
}

/**
 * Parses an imported wall export.
 *
 * Unknown ids and wrong-typed prefs are dropped (falling back to defaults) the
 * same way `readStored` does; repo entries go through a structural re-check
 * that mirrors `sanitiseRepo` so a hostile file cannot inject a string `pinned`.
 */
export function parseWallXfer(text: string): {
  prefs: Partial<Pick<WallPrefs, "sort" | "filter" | "grouped" | "density">>;
  repos: Record<string, RepoState>;
  /**
   * `undefined` means the file predates views: the caller must leave the
   * receiving machine's views alone. `[]` means the file explicitly said "no
   * saved views" and is a real replacement.
   */
  views?: WallView[];
} {
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
  if (obj.format !== "devhub-wall") {
    throw new Error("缺少 format: \"devhub-wall\" 标记，可能不是项目页导出文件");
  }

  const prefs: Partial<Pick<WallPrefs, "sort" | "filter" | "grouped" | "density">> = {};
  const rawPrefs = obj.prefs as Record<string, unknown> | undefined;
  if (rawPrefs && typeof rawPrefs === "object") {
    if (typeof rawPrefs.sort === "string" && SORTS.some((s) => s.id === rawPrefs.sort)) {
      prefs.sort = rawPrefs.sort as WallPrefs["sort"];
    }
    if (typeof rawPrefs.filter === "string" && FILTERS.some((f) => f.id === rawPrefs.filter)) {
      prefs.filter = rawPrefs.filter as WallPrefs["filter"];
    }
    if (typeof rawPrefs.grouped === "boolean") prefs.grouped = rawPrefs.grouped;
    if (
      typeof rawPrefs.density === "string" &&
      WALL_DENSITIES.some((d) => d.id === rawPrefs.density)
    ) {
      prefs.density = rawPrefs.density as WallPrefs["density"];
    }
  }

  const repos: Record<string, RepoState> = {};
  if (obj.repos && typeof obj.repos === "object" && !Array.isArray(obj.repos)) {
    for (const [slug, v] of Object.entries(obj.repos as Record<string, unknown>)) {
      const e = sanitiseImportedRepo(v);
      if (e) repos[slug] = e;
    }
  }
  // A present but non-array `views` is treated as absent rather than as "clear
  // everything": a hostile or hand-edited file must not silently delete saved
  // views it never described.
  const views = Array.isArray(obj.views) ? sanitiseViews(obj.views) : undefined;
  return { prefs, repos, ...(views === undefined ? {} : { views }) };
}

function sanitiseImportedRepo(v: unknown): RepoState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const out: RepoState = {};
  if (typeof r.alias === "string" && r.alias.trim() !== "") out.alias = r.alias;
  if (r.pinned === true) out.pinned = true;
  if (r.hidden === true) out.hidden = true;
  if (typeof r.index === "number" && Number.isFinite(r.index)) out.index = r.index;
  if (typeof r.cover === "string" && r.cover !== "") out.cover = r.cover;
  if (r.coverFit === "fit" || r.coverFit === "contain" || r.coverFit === "blur") {
    out.coverFit = r.coverFit;
  }
  if (
    Array.isArray(r.coverFocus) &&
    r.coverFocus.length === 2 &&
    r.coverFocus.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    out.coverFocus = [r.coverFocus[0], r.coverFocus[1]];
  }
  if (r.coverRatio === "2/1" || r.coverRatio === "16/9" || r.coverRatio === "4/3" || r.coverRatio === "1/1") {
    out.coverRatio = r.coverRatio;
  }
  if (r.coverLook === "auto" || r.coverLook === "vivid" || r.coverLook === "flat" || r.coverLook === "mono") {
    out.coverLook = r.coverLook;
  }
  // Same single rule as `sanitiseRepo`, imported rather than restated: an import
  // that counted, trimmed or capped tags differently from a reload of the same
  // wall would make the chips disagree with the file they came from.
  const note = sanitiseNote(r.note);
  if (note) out.note = note;
  const tags = sanitiseTags(r.tags);
  if (tags) out.tags = tags;
  return Object.keys(out).length > 0 ? out : null;
}
