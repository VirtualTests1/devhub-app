import { create } from "zustand";
import { scheduleStorageWrite } from "../lib/storage";

/**
 * The 项目墙's own state: what the wall looks like, and what each card means to
 * this person on this device.
 *
 * ## Why a store and not component state
 *
 * The filter, the sort tier and 按拥有者分组 used to live in `useState` inside
 * `ProjectsView`. Consequences: switching to 记录 and back reset the wall to
 * defaults, and nothing on the 设置 page could mention them - which is what
 * "项目页缺失设置项目对应的功能调整" was about. Persisting them here is also what
 * lets a per-page default be a *setting* rather than a constant in the source.
 *
 * ## The ordering model, and why it is an overlay
 *
 * A sort tier and a hand-dragged order are two expressions of the same intent,
 * so exactly one may win at a time. Round 9 (需求 1: "排序功能无法使用") changed
 * *which*: **the most recent explicit choice wins.** Picking a tier clears the
 * dragged indices; dragging afterwards takes over again. What stays on top of
 * either is the overlay of durable or transient facts:
 *
 *     pinned  →  running  →  items with an explicit index, in that order  →
 *     everything else, still in tier order
 *
 * 置顶 is a per-item state rather than an ordering mode, so switching tiers
 * never touches it. The running float is transient, and a drag indexes the
 * sequence *below* it: a slot that only exists while a process lives would
 * freeze the card at the front after it stopped. A repository downloaded
 * afterwards has no index and lands after the indexed block, in tier order.
 *
 * A drag writes indices for the **whole wall**, never for the rows a filter
 * happened to be showing: the moved block first, then every other card in the
 * order it already has, as one contiguous 0..n-1 run. Numbering only the
 * visible subset leaves the off-filter cards holding the previous scheme, so
 * clearing the filter interleaves the two — cards jump and the manual order is
 * silently damaged. `applyOrder` enforces the "one scheme" half of that by
 * dropping the index of anything the sequence does not name.
 *
 * Before round 9 the overlay silently outranked every tier - one drag indexed
 * the whole visible set, so from then on the 排序 control reordered nothing
 * and read as broken. That is why a chosen tier now clears the indices: a
 * control that appears to do nothing is worse than one that discards a stale
 * order.
 *
 * ## Where this lives, and why not on disk with the repository
 *
 * `localStorage`, like the element registry (`customize.ts`) and 外观 before it:
 * these are display facts about *this* device. The split is deliberate and
 * partial - the per-project **launch** defaults (step confirm, terminal, IDE) are
 * the opposite kind of fact and are written into that repository's own
 * `.devhub.json` by `set_repo_launch_defaults`, so they travel with the clone.
 */

/**
 * The ordering tiers, in the order the 排序 menu lists them.
 *
 * Round 9 (需求 1) added the four metadata tiers. Their direction follows
 * 需求 9 - "最新的显示在最上方" - so 安装时间 is newest-first and 大小 is
 * largest-first, while the two name-like tiers (语言/类别) are alphabetical
 * because there is no "newest" in a name. 是否缓存 puts the projects that
 * carry artefacts first: that is the question the label exists to answer.
 * r19-C2 added 常用优先: the 常用 page's recency-weighted score
 * (`lib/usage-score.ts`) applied to the wall, so "which of these do I actually
 * open" is one menu entry instead of a visit to another view.
 * r19-C2 (o1-add 线) added 描述: alphabetical by the card's description, empty last.
 * `stars` (r18 N4, restored here from master) is listed last on purpose: it is the
 * only tier whose data comes from GitHub rather than the clone, so picking it is
 * what triggers the (capped, cached) request.
 */
export type SortId =
  | "name"
  | "recent"
  | "frequent"
  | "owner"
  | "installed"
  | "size"
  | "language"
  | "category"
  | "cache"
  | "desc"
  | "stars";

export type FilterId = "all" | "opened" | "unopened" | "running";

/**
 * id tables only since r19-O1-A1: labels moved into the i18n dictionary
 * (`wall.sort.*` / `wall.filter.*` / `wall.density.*`), because a hardcoded
 * Chinese label here would survive a language switch. The ids remain the
 * persisted wire format (wall prefs, wall-xfer payloads) and every coercion
 * below still validates against these arrays by id.
 */
export const SORTS: { id: SortId }[] = [
  { id: "name" },
  { id: "recent" },
  { id: "frequent" },
  { id: "owner" },
  { id: "installed" },
  { id: "size" },
  { id: "language" },
  { id: "category" },
  { id: "cache" },
  { id: "desc" },
  // r18 N4: the only tier whose data comes from GitHub rather than from the clone, so
  // it is listed last — picking it is what triggers the (capped, cached) request.
  { id: "stars" },
];

export const FILTERS: { id: FilterId }[] = [
  { id: "all" },
  { id: "opened" },
  { id: "unopened" },
  { id: "running" },
];

/**
 * Wall density, as the tile minimum in px.
 *
 * Explicit values rather than "inherit the skin": the `soft` skin ships
 * `--skin-grid-min: 380px`, which at the 940 px minimum window width is **one
 * card per row** - the wall stops being a wall exactly when the window is small.
 * 标准 is the 232 px the stylesheet's own measurement landed on (three columns at
 * 952 px), and the skin's big-cover layout is available as 宽松 rather than being
 * the accidental default.
 */
export type WallDensity = "compact" | "standard" | "large";

export const WALL_DENSITIES: { id: WallDensity }[] = [
  { id: "compact" },
  { id: "standard" },
  { id: "large" },
];

/** Tile minimum per tier, written onto the grid as `--skin-grid-min`. */
export const WALL_DENSITY_MIN: Record<WallDensity, string> = {
  compact: "168px",
  standard: "232px",
  large: "380px",
};

/** What one repository means on this device. */
export type RepoState = {
  /** Shown instead of the repository name. Display only - never written to disk. */
  alias?: string;
  pinned?: boolean;
  /** Off the wall, still on disk. Recovered from 设置 → 项目页. */
  hidden?: boolean;
  /** Position in the hand-dragged overlay. `undefined` means "follow the tier". */
  index?: number;
  /**
   * A local image file used instead of the fetched OpenGraph cover.
   *
   * The **source** path is what is stored, not the cached copy: which picture this
   * person chose is a display fact about this device, so it belongs here rather than
   * in the clone's `.devhub.json`. The copy under `cache/covers` is derived from it
   * on demand, which is why clearing the cover cache costs nothing - the next paint
   * re-copies from the source.
   */
  cover?: string;
  /**
   * 封面取景。`fit` 裁切填满、`contain` 完整显示（留边）、`blur` 完整显示并用同图
   * 模糊铺底 —— 窄图不再被横向切掉名字，这是「封面观感粗糙」的根因之一。
   */
  coverFit?: "fit" | "contain" | "blur";
  /** object-position 百分比 [x, y]，让重要内容落在框内。 */
  coverFocus?: [number, number];
  /** 比例档。默认 2/1 对齐 GitHub 的 1280x640 社交图。 */
  coverRatio?: CoverRatio;
  /** 滤镜档；`auto` 跟随皮肤的 --skin-cover-filter。 */
  coverLook?: "auto" | "vivid" | "flat" | "mono";
  /** 用户自定义备注（r23-N2）。纯本地显示事实，不写进仓库 marker；空串按缺席处理。 */
  note?: string;
  /**
   * 用户自定义标签（需求 N3-1）。`undefined`/absent means "no tags" - never `[]`,
   * which `sanitiseTags` folds away so an entry that carries nothing disappears
   * instead of squatting in storage and in the wall export.
   */
  tags?: string[];
};

export type CoverRatio = "2/1" | "16/9" | "4/3" | "1/1";

// ---------------------------------------------------------------------------
// 标签（需求 N3-1）
// ---------------------------------------------------------------------------
// Tags are a *wall* fact, not a repository fact, and that choice is the whole
// design. `RepoRef` (`src/types.ts:9`) mirrors the Rust payload and is derived
// from the directory listing, so a field there would need a backend command to
// fill it; `RepoState` is already the home of the other things this person
// decided about a card on this device (alias / 置顶 / 隐藏 / 封面), and it is
// what the wall export carries. So a tag travels with a wall export between
// this user's machines, and not with a `git clone` to somebody else's.
//
// The two limits are constants rather than settings, because both exist to keep
// one number bounded in a *layout*: the chip row wraps by tag count, and a card
// line truncates by tag length. A wall with 40 tags per card or a 500-character
// one is not a slower wall, it is an unreadable one, and there is no preference
// that can be worth that.

/** How many tags one repository may carry. Beyond this, new tags are refused. */
export const REPO_TAG_LIMIT = 8;

/** How long a single tag may be, in characters. Longer is truncated, not rejected. */
export const REPO_TAG_LENGTH_LIMIT = 24;

/**
 * What the tag readers accept.
 *
 * Wider than `RepoState["tags"]` on purpose: `addRepoTag` / `removeRepoTag` report
 * "no tags left" as `null`, and a reader that only took `undefined` would make every
 * caller that chains the two write its own `?? undefined` - the one place that noise
 * belongs is the signature. Junk in, junk out is still `sanitiseTags`'s job.
 */
export type TagList = readonly string[] | null | undefined;

/**
 * One tag from one untrusted value, or `null` when it is not one.
 *
 * Whitespace is collapsed rather than only trimmed: `"  backend  "` and
 * `"backend "` are the same tag typed twice, and keeping both would put two
 * chips saying the same word in the filter row. Over-length input is truncated
 * rather than refused, because the typist's intent is clear and losing the word
 * entirely is the worse failure.
 */
export function sanitiseTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > REPO_TAG_LENGTH_LIMIT ? one.slice(0, REPO_TAG_LENGTH_LIMIT) : one;
}

/**
 * Casefolded identity of a tag - what makes two tags "the same one".
 *
 * Comparison only; the form that is *shown* is the first one typed, so a person
 * who writes `Rust` keeps seeing `Rust` while `rust` still matches their chip.
 */
function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/**
 * A tag list from an untrusted value: trimmed, deduplicated, capped.
 *
 * Returns `null` for "no tags", never `[]`. That is deliberate: the store's
 * emptiness rule (see `setRepo`) deletes a card entry that carries nothing, and
 * an empty array would read as a real value and keep a pointless entry alive on
 * disk and in the export.
 *
 * Junk is dropped, never fatal - a non-array, a `null` member, a number, an
 * over-cap tail all come back as the valid prefix. An entry written by another
 * machine, an edited localStorage blob or an older build must not be able to
 * take the wall down.
 */
/** 备注长度上限；超出截断而不是拒绝（用户可能粘贴长文本）。 */
export const REPO_NOTE_LENGTH_LIMIT = 2000;

/** 读一条备注：trim 后空串 = 没有备注。 */
export function sanitiseNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const one = raw.trim();
  if (one === "") return undefined;
  return one.length > REPO_NOTE_LENGTH_LIMIT ? one.slice(0, REPO_NOTE_LENGTH_LIMIT) : one;
}

export function sanitiseTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = sanitiseTag(item);
    if (!tag) continue;
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= REPO_TAG_LIMIT) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Which entry of `tags` `tag` refers to, in the spelling the card stores.
 *
 * Both sides are folded through `sanitiseTag` before comparing, so a hand-built
 * `RepoState` holding `" Rust "` and a chip labelled `"rust"` still recognise each
 * other. Comparing the raw probe alone was the half-fix: it survives a clean store,
 * and a dirty entry would then match no chip while still being counted by
 * `tagVocabulary`, which filters to a card the chip claims to show.
 */
export function findStoredTag(tags: TagList, tag: string): string | null {
  if (!tags) return null;
  const probe = sanitiseTag(tag);
  if (!probe) return null;
  const key = tagKey(probe);
  return tags.find((t) => {
    const one = sanitiseTag(t);
    return one !== null && tagKey(one) === key;
  }) ?? null;
}

/** Does this tag list contain `tag`? */
export function hasRepoTag(tags: TagList, tag: string): boolean {
  return findStoredTag(tags, tag) !== null;
}

/**
 * Add one tag, keeping the list inside both limits.
 *
 * At the cap a new tag is **refused** rather than displacing the oldest: silently
 * dropping a tag the user can still see on a card would mean an edit they never
 * asked for. The caller shows 最多 N 个标签 instead - `REPO_TAG_LIMIT` is exported
 * for exactly that sentence.
 */
export function addRepoTag(tags: TagList, raw: unknown): string[] | null {
  const current = sanitiseTags(tags) ?? [];
  const tag = sanitiseTag(raw);
  if (!tag) return current.length > 0 ? current : null;
  if (hasRepoTag(current, tag)) return current;
  if (current.length >= REPO_TAG_LIMIT) return current;
  return [...current, tag];
}

/** Remove one tag, ignoring case. `null` when nothing is left. */
export function removeRepoTag(tags: TagList, raw: unknown): string[] | null {
  const current = sanitiseTags(tags) ?? [];
  const tag = sanitiseTag(raw);
  if (!tag) return current.length > 0 ? current : null;
  const key = tagKey(tag);
  const left = current.filter((t) => tagKey(t) !== key);
  return left.length > 0 ? left : null;
}

/**
 * The wall's tag vocabulary, most-used first.
 *
 * Reads the overlay rather than the cards, so a tag on a hidden or off-filter
 * card still gets its chip: chip counts are a property of the wall, not of the
 * current search (the same rule as `counts` in `ProjectsView`). Ties break by
 * code point, not `localeCompare`: the same data must produce the same chip
 * order on every machine, regardless of the OS display language.
 */
export function tagVocabulary(
  repos: Record<string, RepoState | undefined>,
): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const state of Object.values(repos)) {
    const tags = sanitiseTags(state?.tags);
    if (!tags) continue;
    for (const tag of tags) {
      const key = tagKey(tag);
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  );
}

/**
 * Whether a card's tags satisfy an active tag selection.
 *
 * Intersection, in both senses: no chips active means no opinion (everything
 * passes, so a tag filter is never a wall the user has to opt out of), and with
 * chips active the card must carry **at least one** of them. The multi-chip case
 * is deliberately OR-not-AND, because "show me everything I filed under 后端 or
 * 前端" is the question a chip row answers; AND over two tags on one axis would
 * just be a narrower list the same two clicks cannot express honestly.
 */
export function matchesTagFilter(tags: TagList, active: readonly string[]): boolean {
  if (active.length === 0) return true;
  const current = sanitiseTags(tags);
  if (!current) return false;
  return active.some((tag) => hasRepoTag(current, tag));
}

/**
 * One card's answer to "add all of these tags", with the cap's decisions reported.
 *
 * This is the shape `BatchBar` needs and the shape a test can check: a card that
 * took two of three chips did not "succeed", and the words that say which landed
 * are computed here rather than re-derived in the view. `added`/`refused` are in
 * the order they were asked for, so the result row reads in the same order as the
 * chips the user clicked.
 */
export function applyTagsTo(
  tags: TagList,
  add: readonly string[],
): { next: string[] | null; added: string[]; refused: string[] } {
  const added: string[] = [];
  const refused: string[] = [];
  let acc = sanitiseTags(tags) ?? [];
  for (const raw of add) {
    const tag = sanitiseTag(raw);
    // Junk is neither added nor refused, and a tag the card already carries is
    // satisfied rather than rejected: both belong to no report at all, or the row
    // would claim a problem where the batch did exactly what was asked.
    if (!tag || hasRepoTag(acc, tag)) continue;
    const after = addRepoTag(acc, tag) ?? [];
    if (hasRepoTag(after, tag)) {
      added.push(tag);
      acc = after;
    } else {
      refused.push(tag);
    }
  }
  return { next: acc.length > 0 ? acc : null, added, refused };
}

/**
 * One card's answer to "remove all of these tags".
 *
 * `removed` reports the card's own spelling, because that is the string that left
 * the card: echoing the chip back would print `rust` on a card that read `Rust`, and
 * the result row is a statement about the repository, not about what was clicked.
 */
export function stripTagsFrom(
  tags: TagList,
  remove: readonly string[],
): { next: string[] | null; removed: string[] } {
  let acc = sanitiseTags(tags) ?? [];
  const removed: string[] = [];
  for (const raw of remove) {
    const stored = findStoredTag(acc, raw);
    if (!stored) continue;
    acc = removeRepoTag(acc, stored) ?? [];
    removed.push(stored);
  }
  return { next: acc.length > 0 ? acc : null, removed };
}

/**
 * How much work the add step has for one card (`BatchAction.appliesTo`).
 *
 * Delegated to the step itself rather than recomputed as `missing` vs `room`: two
 * formulas had to agree for the bar to disable for the right reason, and only one of
 * them could be wrong about the cap or about a duplicated chip. Now the number that
 * enables the button and the number the batch reports are the same call.
 */
export function tagWorkFor(tags: TagList, add: readonly string[]): number {
  return applyTagsTo(tags, add).added.length;
}

/** How much work the remove step has for one card (`BatchAction.appliesTo`). */
export function tagRemovalWorkFor(tags: TagList, remove: readonly string[]): number {
  return stripTagsFrom(tags, remove).removed.length;
}

export type WallPrefs = {
  sort: SortId;
  filter: FilterId;
  grouped: boolean;
  density: WallDensity;
};

const DEFAULT_PREFS: WallPrefs = {
  sort: "name",
  filter: "all",
  grouped: false,
  density: "standard",
};

/**
 * Validate a loose context object against the known wall-preference values.
 *
 * The view-context bridge (`apply` in ProjectsView) receives a
 * `Record<string, unknown>` that may originate from another machine's storage or
 * a hand-edited blob, so unknown or wrong-typed values are dropped rather than
 * trusted. Only the keys that pass are returned, letting the caller apply them
 * type-safely instead of via `as never`.
 */
export function coerceWallPref(ctx: Record<string, unknown>): Partial<WallPrefs> {
  const out: Partial<WallPrefs> = {};
  if (typeof ctx.sort === "string" && SORTS.some((s) => s.id === ctx.sort)) {
    out.sort = ctx.sort as SortId;
  }
  if (typeof ctx.filter === "string" && FILTERS.some((f) => f.id === ctx.filter)) {
    out.filter = ctx.filter as FilterId;
  }
  // Booleans have no table to check against; only a real boolean is accepted so a
  // stored `"no"` / `1` can't sneak in as truthy.
  if (typeof ctx.grouped === "boolean") {
    out.grouped = ctx.grouped;
  }
  if (typeof ctx.density === "string" && WALL_DENSITIES.some((d) => d.id === ctx.density)) {
    out.density = ctx.density as WallDensity;
  }
  return out;
}

const STORAGE_KEY = "devhub.wall.v1";

type Wall = WallPrefs & {
  repos: Record<string, RepoState>;
  setPref: <K extends keyof WallPrefs>(key: K, value: WallPrefs[K]) => void;
  setRepo: (slug: string, patch: RepoState) => void;
  togglePin: (slug: string) => void;
  toggleHidden: (slug: string) => void;
  /**
   * Writes the dragged sequence as the new overlay, over the whole wall.
   *
   * The caller must pass every card — the moved block first, then the rest in
   * their current relative order — because the index is one contiguous run for
   * the wall, not a per-filter scheme. Whatever the sequence does NOT name
   * loses its `index` here: a stale position from an older drag would otherwise
   * sit inside the new 0..n-1 run and surface as cards jumping when the filter
   * clears (the residue rule `resetOrder` applies, at drag time).
   */
  applyOrder: (orderedSlugs: string[]) => void;
  resetOrder: () => void;
  unhideAll: () => void;
  resetAll: () => void;
  /**
   * Applies an imported wall export (see `wall-xfer.ts`). Prefs not present in
   * the patch keep their current value; `repos` replaces the per-card overlay
   * wholesale, because an import is "make my wall look like that machine's".
   */
  applyXfer: (
    prefs: Partial<WallPrefs>,
    repos: Record<string, RepoState>,
  ) => void;
};

/**
 * One stored repo entry, field by field.
 *
 * `parsed.repos` used to flow into the store as whatever disk happened to
 * hold — a string `pinned`, an `index: "abc"` — and the structural "empty"
 * check in setRepo only treats `undefined`/`false` as empty, so junk
 * survived and reached the overlay and CSS paths. Another machine's export
 * is untrusted JSON, so every field is re-checked here (the same rule the
 * prefs above follow).
 */
function sanitiseRepo(v: unknown): RepoState | null {
  if (!v || typeof v !== "object") return null;
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
  // Folded away when empty, so an entry that only carried `tags: []` still reads
  // as empty and drops out (`sanitiseTags`).
  const note = sanitiseNote(r.note);
  if (note) out.note = note;
  const tags = sanitiseTags(r.tags);
  if (tags) out.tags = tags;
  return Object.keys(out).length > 0 ? out : null;
}

function sanitiseRepos(raw: unknown): Record<string, RepoState> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, RepoState> = {};
  for (const [slug, v] of Object.entries(raw as Record<string, unknown>)) {
    const entry = sanitiseRepo(v);
    if (entry) out[slug] = entry;
  }
  return out;
}

function readStored(): { prefs: WallPrefs; repos: Record<string, RepoState> } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { prefs: DEFAULT_PREFS, repos: {} };
    const parsed = JSON.parse(raw) as Partial<{
      prefs: WallPrefs;
      repos: Record<string, RepoState>;
    }>;
    const prefs = { ...DEFAULT_PREFS, ...(parsed.prefs ?? {}) };
    // A stored id that no longer exists would silently do nothing in the CSS, so
    // the values are re-checked against the tables rather than trusted from disk.
    if (!SORTS.some((s) => s.id === prefs.sort)) prefs.sort = "name";
    if (!FILTERS.some((f) => f.id === prefs.filter)) prefs.filter = "all";
    if (!WALL_DENSITIES.some((d) => d.id === prefs.density)) prefs.density = "standard";
    // Booleans have no table to check against; `??` would keep `"no"` as truthy.
    if (typeof prefs.grouped !== "boolean") prefs.grouped = DEFAULT_PREFS.grouped;
    return { prefs, repos: sanitiseRepos(parsed.repos) };
  } catch {
    return { prefs: DEFAULT_PREFS, repos: {} };
  }
}

function persist(state: Wall) {
  // Coalesced in lib/storage: this used to stringify and write synchronously on
  // every setRepo, and a cover pick or a drag burst fires dozens per second. The
  // JSON shape is unchanged — only the timing moved.
  scheduleStorageWrite(
    STORAGE_KEY,
    JSON.stringify({
      prefs: {
        sort: state.sort,
        filter: state.filter,
        grouped: state.grouped,
        density: state.density,
      },
      repos: state.repos,
    }),
  );
}

const initial = readStored();

export const useWall = create<Wall>((set) => ({
  ...initial.prefs,
  repos: initial.repos,

  setPref: (key, value) =>
    set((s) => {
      const next = { ...s, [key]: value } as Wall;
      persist(next);
      return { [key]: value };
    }),

  setRepo: (slug, patch) =>
    set((s) => {
      const merged: RepoState = { ...s.repos[slug], ...patch };
      // A field handed over as `undefined` or as an empty list is the caller
      // switching it off, not a value to keep. Removing a card's last tag gives
      // `tags: []`, and leaving that key in place would keep the entry "non-empty"
      // below, so the card would hold a storage slot and an export entry saying
      // nothing - and `applyOrder`'s `Object.keys(rest).length` test would count
      // it as a surviving field too.
      for (const key of Object.keys(merged) as (keyof RepoState)[]) {
        const value = merged[key];
        if (value === undefined || (Array.isArray(value) && value.length === 0)) {
          delete merged[key];
        }
      }
      const repos = { ...s.repos };
      // Structural, not a hand-written field list: the previous version enumerated
      // alias/pinned/hidden/index, and a 封面-only entry matched "empty" and was
      // deleted on the spot. `index: 0` is a real position, so only absent and off
      // count as empty.
      const empty = Object.values(merged).every((v) => v === false);
      if (empty) delete repos[slug];
      else repos[slug] = merged;
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  togglePin: (slug) =>
    set((s) => {
      const repos = { ...s.repos, [slug]: { ...s.repos[slug], pinned: !s.repos[slug]?.pinned } };
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  toggleHidden: (slug) =>
    set((s) => {
      const repos = { ...s.repos, [slug]: { ...s.repos[slug], hidden: !s.repos[slug]?.hidden } };
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  applyOrder: (orderedSlugs) =>
    set((s) => {
      const named = new Set(orderedSlugs);
      const repos: Record<string, RepoState> = {};
      // Two numbering schemes in one overlay is the card-jump bug: an entry the
      // caller did not name keeps the previous drag's index, which interleaves
      // with the new 0..n-1 run as soon as a filter comes off. Strip it — and
      // apply `setRepo`'s structural emptiness rule, so an entry that carried
      // nothing but a position disappears instead of lingering as `{}`.
      for (const [slug, state] of Object.entries(s.repos)) {
        if (named.has(slug)) continue;
        const { index: _index, ...rest } = state;
        if (Object.keys(rest).length) repos[slug] = rest;
      }
      orderedSlugs.forEach((slug, i) => {
        repos[slug] = { ...s.repos[slug], index: i };
      });
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  resetOrder: () =>
    set((s) => {
      const repos: Record<string, RepoState> = {};
      for (const [slug, state] of Object.entries(s.repos)) {
        const { index: _index, ...rest } = state;
        if (Object.keys(rest).length) repos[slug] = rest as RepoState;
      }
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  unhideAll: () =>
    set((s) => {
      const repos: Record<string, RepoState> = {};
      for (const [slug, state] of Object.entries(s.repos)) {
        const { hidden: _hidden, ...rest } = state;
        if (Object.keys(rest).length) repos[slug] = rest as RepoState;
      }
      const next = { ...s, repos };
      persist(next);
      return { repos };
    }),

  resetAll: () =>
    set(() => {
      persist({ ...DEFAULT_PREFS, repos: {} } as Wall);
      return { ...DEFAULT_PREFS, repos: {} };
    }),

  applyXfer: (prefs, repos) =>
    set((s) => {
      const next: Wall = {
        ...s,
        ...prefs,
        repos,
      };
      persist(next);
      return { sort: next.sort, filter: next.filter, grouped: next.grouped, density: next.density, repos };
    }),
}));

/**
 * The canonical slug, byte-identical to the `repo:<slug>` usage key and the backend's.
 *
 * A pass-through of `lib/slug`, not a second implementation. It stays addressable
 * from here only while `ProjectsView` and `settings/ProjectsSection` still import
 * the slug from the wall store (round-12 交接); once they import `lib/slug`
 * directly this line goes, because a re-export is how `types.ts`/`formatBytes`
 * ended up with two import paths for one function.
 */
export { slugOf } from "../lib/slug";

/**
 * The overlay, applied to an already tier-sorted list.
 *
 * Stable on purpose: two pinned cards with no explicit index keep whatever order
 * the tier gave them, so turning a sort can never shuffle cards the user has not
 * touched.
 */
export function applyOverlay<T extends { slug: string }>(
  tierSorted: T[],
  states: Record<string, RepoState>,
  running?: { has(slug: string): boolean },
): T[] {
  return [...tierSorted].sort((a, b) => {
    const sa = states[a.slug] ?? {};
    const sb = states[b.slug] ?? {};
    const pin = Number(!!sb.pinned) - Number(!!sa.pinned);
    if (pin !== 0) return pin;
    // A project that is running is the one the user is waiting on, so it floats
    // next after 置顶 and above any dragged position. `Array.sort` is stable, so
    // two running cards keep the order they arrived in rather than trading places
    // every time the poll ticks.
    if (running) {
      const live = Number(running.has(b.slug)) - Number(running.has(a.slug));
      if (live !== 0) return live;
    }
    const ia = sa.index ?? Number.MAX_SAFE_INTEGER;
    const ib = sb.index ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
}
