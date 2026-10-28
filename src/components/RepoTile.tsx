import { memo, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Pause, StickyNote } from "lucide-react";
import { cn } from "../lib/utils";
import { useAppearance } from "../store/appearance";
import { reg, useCustomize } from "../store/customize";
import { sanitiseTags } from "../store/wall";
import { liveElapsedMs, useProcessSecond } from "../store/processes";
import type { CoverImage, RepoHeat, RepoMeta, RepoRef } from "../types";
import { CATEGORY_LABEL } from "../types";
import { formatBytes, fmtAgo, fmtElapsed, pad2 } from "../lib/format";
import { heatBadgeOf } from "../lib/heat";
import { withCoverSlot } from "../lib/cover-gate";
import { useI18n, type I18n } from "../lib/useI18n";
import type { TFunc } from "../lib/i18n";
import { useInView } from "../lib/use-in-view";

/**
 * Repository card — the app's primary content, so it gets the most care.
 *
 * Progressive enhancement (option C): a generated gradient paints instantly and
 * never disappears, and a real OpenGraph cover fades in over it when it arrives.
 * Consequences that matter:
 *   - there is no loading state and no empty tile, ever;
 *   - a slow or unreachable cover CDN degrades to "no image", not to a broken card;
 *   - the card is fully usable before any network call finishes.
 *
 * Measured cover fetch: ~0.5-2.2 s cold, 0 ms warm (cached on disk by the Rust
 * side), 49-88 KB per image.
 *
 * ## What the tooltips are for
 *
 * "悬浮在元素之上的时候的显示内容应当是一些有用的内容，而不是已经在页面中存在的信息。"
 * The four `title` attributes this file used to carry were the repository name,
 * the owner, the path and `host/owner/repo` — three of them restating text that is
 * on the card, and the fourth restating the view's own hint. Now a tooltip only
 * exists when it has something the tile does not show:
 *
 *   - the card: the clone URL (never printed), the on-disk path *while 卡片显示完整路径
 *     is off*, how the cover was obtained, and when the repository was last opened
 *     on this machine.
 *   - the owner line: the owner's profile address and how many other repositories of
 *     theirs are on this wall.
 *   - the path line: the untruncated path, kept because `truncate` means the tail of
 *     a long Windows path is genuinely not on screen.
 *   - the name line: no `title` at all. Its full text is already rendered, so there
 *     is nothing left to say, and an omitted attribute is the honest answer.
 *
 * ## Round 4 additions, and the constraint each one respects
 *
 *   - **Draggable.** `useSortable` spreads its listeners onto the card itself
 *     rather than onto a handle, because a card is one object and a corner grip
 *     would read as "only this part moves". The view's 6 px activation distance is
 *     what keeps a click a click.
 *   - **Right-clickable.** The menu is the parent's (one menu, not 13 instances),
 *     so this file only reports the pointer position.
 *   - **Running state.** A pulsing ring plus a corner chip, and the chip says
 *     挂起 when the process is frozen — the two look identical in every other part
 *     of the UI, and they are not the same fact.
 */

type CoverOrigin = "loading" | "network" | "cache" | "custom" | "fallback" | "failed";

function coverLabel(t: TFunc, origin: CoverOrigin): string {
  // Literal t() calls (not a computed key): tests/i18n.test.ts counts readers by
  // scanning for literals, and a dynamic key would read as an unregistered key.
  switch (origin) {
    case "loading":
      return t("tile.cover.loading");
    case "network":
      return t("tile.cover.network");
    case "cache":
      return t("tile.cover.cache");
    case "custom":
      return t("tile.cover.custom");
    case "fallback":
      return t("tile.cover.fallback");
    case "failed":
      return t("tile.cover.failed");
  }
}

/**
 * Session-wide dedup for cover fetches.
 *
 * Every tile fires `fetch_cover` on mount; switching views remounts the whole
 * wall, so 40 tiles re-issue 40 IPC calls for covers the backend already has on
 * disk. Keyed by `owner/repo` (the backend's own key), resolved promises are
 * kept for the session — consistent with the backend's `force: false` mtime
 * cache, which will not refetch within the session either.
 */
const coverInflight = new Map<string, Promise<CoverImage>>();
function fetchCoverOnce(slug: string): Promise<CoverImage> {
  let p = coverInflight.get(slug);
  if (!p) {
    // Deduped per slug above, but that says nothing about how many *different*
    // slugs a burst asks for at once — see `src/lib/cover-gate.ts`.
    p = withCoverSlot(() => invoke<CoverImage>("fetch_cover", { slug, force: false }));
    coverInflight.set(slug, p);
    // A rejection must not poison the cache for the whole session: drop it so
    // the next mount (or a later refresh) can try again.
    p.catch(() => coverInflight.delete(slug));
  }
  return p;
}

/**
 * "安装于" as the card prints it (round 9, 需求 1) — returns just the date part.
 *
 * This year reads as `10-03`; an older one keeps its year, because `10-03` alone
 * would place a 2023 clone next to this morning's. The "安装" suffix is the i18n
 * `tile.installedOn` template, composed at the call site so English can reorder it.
 */
function installedDatePart(ms: number): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? md : `${d.getFullYear()}-${md}`;
}

/**
 * The language a category id already implies.
 *
 * 需求 1 asked for 类别 *and* 语言 as card labels, and locally both come from the
 * same marker file - so printing them unconditionally would print the same word
 * twice ("Rust 项目 · Rust"). The rule is therefore: show 语言 only when it says
 * something the 类别 chip does not. `node` is the one ecosystem whose language is
 * genuinely ambiguous (JavaScript *or* TypeScript), so its entry is the language
 * that is *not* worth repeating.
 */
const CATEGORY_LANGUAGE: Record<string, string> = {
  rust: "Rust",
  go: "Go",
  python: "Python",
  java: "Java",
  dotnet: "C#",
  ruby: "Ruby",
  php: "PHP",
  dart: "Dart",
  node: "JavaScript",
  static: "HTML",
};

/**
 * The metadata line: 类别 · 语言(仅当有新信息) · 体积 · 安装时间 · 有缓存 · ★热度.
 *
 * One line rather than a row of chips because the card is as narrow as 168 px
 * in 紧凑 density and a chip row would wrap into a second line - which is the
 * "描述过于占据视野" the round-9 brief complains about, in a new outfit.
 * A fact the walk could not produce is left out rather than printed as a
 * placeholder: the line is only as long as the truth. An unrecognised project
 * therefore still reports its size and install date, and simply omits 类别.
 *
 * The star count is the one part that did not come from the filesystem, and it is
 * the only part that carries a `~`: `src/lib/heat.ts:heatBadgeOf` marks a row the
 * server did not confirm this round (`cached`, or a `failed` round still showing the
 * last known number), and printing that identically to a confirmed one would imply
 * a check that never happened. No label words are added here — `★` and `~` are
 * language-neutral, so the line costs nothing against the 中文硬编码 ratchet.
 */
function metaLine(meta: RepoMeta | undefined, heat: RepoHeat | undefined, t: I18n["t"]): string | null {
  const parts: string[] = [];
  if (meta) {
    const category = CATEGORY_LABEL[meta.category];
    // "未识别" is a placeholder, not a fact: the line says nothing rather than
    // saying nothing useful.
    if (category && meta.category !== "unknown") parts.push(category);
    if (meta.language && meta.language !== CATEGORY_LANGUAGE[meta.category]) {
      parts.push(meta.language);
    }
    if (meta.sizeBytes > 0) parts.push(formatBytes(meta.sizeBytes));
    const installed = installedDatePart(meta.installedAt);
    if (installed) parts.push(t("tile.installedOn", { date: installed }));
    if (meta.hasCache) parts.push(t("tile.cached"));
  }
  const badge = heatBadgeOf(heat);
  if (badge) parts.push(`★${badge.unconfirmed ? "~" : ""}${badge.text}`);
  return parts.length ? parts.join(" · ") : null;
}

export type TileRunning = { state: "running" | "suspended"; elapsedMs: number; label: string };

/** Curated fallback cover pairs: blue family plus one neutral, all deep enough to
 *  hold white caption text (measured ≥ 8:1 against #fff). */
const COVER_FALLBACKS: [string, string][] = [
  ["oklch(0.34 0.10 256)", "oklch(0.19 0.06 256)"],
  ["oklch(0.36 0.11 232)", "oklch(0.20 0.07 240)"],
  ["oklch(0.31 0.05 265)", "oklch(0.17 0.02 265)"],
  ["oklch(0.38 0.10 205)", "oklch(0.21 0.06 215)"],
  ["oklch(0.33 0.06 275)", "oklch(0.18 0.03 280)"],
  ["oklch(0.29 0.04 250)", "oklch(0.15 0.02 250)"],
];

const COVER_LOOKS = {
  vivid: "saturate(1.25) contrast(1.1)",
  flat: "saturate(0.8) contrast(0.95)",
  mono: "grayscale(1) contrast(1.05)",
} as const;

/** How many tags fit on a card before the list becomes a `+N`. */
const TILE_TAG_VISIBLE = 3;

const hashOf = (v: string) => {
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return h;
};

export const RepoTile = memo(function RepoTile({
  repo,
  slug,
  onOpen,
  onContextMenu,
  ownerCount = 1,
  alias,
  coverOverride,
  coverFit = "fit",
  coverFocus,
  coverRatio = "2/1",
  coverLook = "auto",
  pinned,
  tags,
  note,
  running,
  sortable,
  meta,
  heat,
  selectMode = false,
  selected = false,
  onSelect,
}: {
  repo: RepoRef;
  /** Canonical `host/owner/repo`, computed by the view so both sides agree. */
  slug: string;
  onOpen: (slug: string) => void;
  /**
   * Absent means this tile has **no context menu** (r15-a11y-7, 常用页): the
   * handlers below then neither cancel the native menu nor advertise
   * `aria-haspopup="menu"`. It used to do both unconditionally while
   * FrequentView passed a no-op, so a right-click or Shift+F10 on a pinned
   * card silently did nothing.
   */
  onContextMenu?: (slug: string, x: number, y: number) => void;
  /** How many repositories this wall holds for `repo.owner`, including this one. */
  ownerCount?: number;
  /** Display name from 项目设置. Empty means "no alias". */
  alias?: string;
  /**
   * A local image chosen in 项目设置, used instead of the fetched cover. Empty or
   * absent means "fetch it the usual way". Passed in by the view because it is a
   * display fact stored in `localStorage`, not something derivable from the repo.
   */
  coverOverride?: string;
  coverFit?: "fit" | "contain" | "blur";
  coverFocus?: [number, number];
  coverRatio?: "2/1" | "16/9" | "4/3" | "1/1";
  coverLook?: "auto" | "vivid" | "flat" | "mono";
  pinned?: boolean;
  /**
   * 用户自定义标签（需求 N3-2）. Passed in rather than read from the store here for
   * the same reason `alias` is: this tile is `memo`-ized, and subscribing it to the
   * wall store would re-render all N cards on any card's edit.
   */
  tags?: string[];
  /** Local note (r23-N2); shown as an icon with the full text in the tooltip. */
  note?: string;
  running?: TileRunning;
  /** Off while 按拥有者分组 is on: cross-group dragging would mean re-owning. */
  sortable: boolean;
  /** Locally-derived facts (round 9, 需求 1); absent until the walk answers. */
  meta?: RepoMeta;
  /** GitHub heat (r18 N4); absent until 按 Star 数 has been picked, then batch-filled. */
  heat?: RepoHeat;
  /** 多选 mode: a plain click joins the selection instead of opening the panel. */
  selectMode?: boolean;
  selected?: boolean;
  /** Called instead of `onOpen` while selecting. `additive` is Ctrl/Cmd, `range` Shift. */
  onSelect?: (slug: string, mods: { additive: boolean; range: boolean }) => void;
}) {
  // Two different names, on purpose:
  //   * the cover service wants `owner/repo`
  //   * every backend command wants the canonical `host/owner/repo`
  //
  // They used to share one variable, and the tile handed `owner/repo` to
  // `repo_detail` / `detect_launch_commands` / `open_terminal`, so opening any
  // downloaded project failed with "未找到仓库: owner/repo".
  const coverSlug = `${repo.owner}/${repo.repo}`;
  const usageKey = `repo:${slug}`;
  const [fx, fy] = coverFocus ?? [50, 50];
  // 兜底渐变取自一组蓝/中性配对，而不是任意色相：本文件的色彩宣言是
  // 「色相只来自蓝和封面」，一个随机彩虹渐变正是它最大的破口。
  const coverPair = COVER_FALLBACKS[hashOf(repo.repo) % COVER_FALLBACKS.length];
  // Subscribe to the locale so a language switch repaints the tile's always-visible
  // labels (chip / badge / meta line). The tile is memoised; the subscription re-runs
  // per card but the locale snapshot is a stable string, so this is cheap.
  const { t } = useI18n();
  const metaText = metaLine(meta, heat, t);
  // Sanitised again on the way in: the store's copy went through `sanitiseRepo`,
  // but a card is painted from `RepoState` objects other call sites build by hand,
  // and a junk entry must not be able to render a `+NaN` pill.
  const tagList = sanitiseTags(tags) ?? [];
  const visibleTags = tagList.slice(0, TILE_TAG_VISIBLE);
  const [cover, setCover] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [coverOrigin, setCoverOrigin] = useState<CoverOrigin>("loading");
  // Reading the store through getState() inside the effect keeps this tile from
  // re-rendering on every appearance change; the flag is only consulted when the
  // cover is (not) fetched.
  const covers = useAppearance((s) => s.covers);
  // Subscribed rather than read once because it decides where the path lives in
  // the tooltip: while 卡片显示完整路径 is off the `.repo-path` row is
  // `display:none`, so the path would have nowhere to be shown except here.
  const showPath = useAppearance((s) => s.showRepoPath);
  const usage = useCustomize((s) => s.usage[usageKey]);
  const recordUsage = useCustomize((s) => s.recordUsage);

  // Defer the cover fetch until this card is within ~200 px of the viewport.
  // A 40-card wall otherwise issues 40 `fetch_cover` IPC calls on first paint
  // even though only ~8 are visible. `inView` is monotonic (true once, stays
  // true), so a fetched cover is never re-fetched on scroll-back.
  const [tileRef, inView] = useInView<HTMLButtonElement>();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slug,
    disabled: !sortable,
  });

  /** Why a 项目设置 cover is not showing, when that is the case. */
  const [customNote, setCustomNote] = useState<string | null>(null);

  useEffect(() => {
    if (!covers) return; // off means off on the network too, not just visually
    if (!inView) return; // wait until the card is near the viewport
    let alive = true;
    (async () => {
      const source = coverOverride?.trim() ?? "";
      try {
        if (source) {
          const res = await invoke<CoverImage>("custom_cover", { source });
          if (!alive) return;
          if (res.path) {
            setCover(convertFileSrc(res.path));
            setCoverOrigin("custom");
            setCustomNote(null);
          } else {
            // The chosen file is gone, or is not an image the backend will accept.
            // Say which in the tooltip, and fall back to the gradient rather than
            // leaving a hole where the card's own picture used to be.
            setCover(null);
            setCoverOrigin("fallback");
            setCustomNote(res.error ?? t("tile.localCoverUnavailable"));
          }
          return;
        }
        setCustomNote(null);
        const res = await fetchCoverOnce(coverSlug);
        if (!alive) return;
        // `cached` is the backend's own answer to "did you just download this",
        // which is the one fact about a cover nobody can read off the tile.
        setCoverOrigin(res.path ? (res.cached ? "cache" : "network") : "fallback");
        if (res.path) setCover(convertFileSrc(res.path));
        else setCover(null);
      } catch {
        // Soft failure by design: the gradient is already on screen.
        if (alive) {
          setCover(null);
          setCoverOrigin("fallback");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [coverSlug, covers, coverOverride, inView, t]);

  // The poll writes the store only when the process *situation* changes
  // (`sameProcessList` in `store/processes.ts`) — that is what keeps the wall's
  // filter/sort chain from re-running every two seconds. The price is that
  // `running.elapsedMs` is now a *reported* value rather than "now", so the one
  // place that prints a moving number (this tooltip, and only this tooltip: the
  // badge and the ring read `state`) carries its own clock. The
  // (reported value, moment it was read) pair re-bases when the `running` prop
  // identity moves, which after item 7-2 means a real change or the poll that
  // reported it; in between the shared per-second tick advances it, and only for
  // tiles that have a live process.
  const clockRef = useRef<{ from: TileRunning | undefined; at: number }>({
    from: undefined,
    at: 0,
  });
  if (clockRef.current.from !== running) clockRef.current = { from: running, at: Date.now() };
  useProcessSecond(running !== undefined);
  const liveMs = running ? liveElapsedMs(running.elapsedMs, clockRef.current.at) : 0;

  const lines: string[] = [];
  lines.push(
    repo.local
      ? t("tile.localSource", { path: repo.local })
      : t("tile.cloneUrl", { url: `https://${repo.host}/${coverSlug}` }),
  );
  if (repo.path && !showPath) lines.push(t("tile.diskPath", { path: repo.path }));
  lines.push(
    covers
      ? coverLabel(t, coverOrigin) + (customNote ? `（${customNote}）` : "")
      : t("tile.coverOff") +
        (coverOverride?.trim() ? t("tile.coverOffCustom") : t("tile.coverOffNoRequest")),
  );
  if (running) {
    lines.push(
      running.state === "suspended"
        ? t("tile.tooltip.suspended", { label: running.label, elapsed: fmtElapsed(liveMs) })
        : t("tile.tooltip.running", { label: running.label, elapsed: fmtElapsed(liveMs) }),
    );
  }
  lines.push(
    // Relative inside a day — that is the question a card answers ("did I open
    // this this morning?") — and an absolute stamp past a day, which is the
    // `pastDay: "date"` register of the shared ladder in `lib/format`.
    usage
      ? t("tile.lastOpened", {
          when: fmtAgo(usage.last, Date.now(), { pastDay: "date" }),
          count: usage.count,
        })
      : t("tile.neverOpened"),
  );
  if (selectMode) lines.push(t("tile.selectModeHint"));
  else {
    if (sortable) lines.push(t("tile.dragHint"));
    if (onSelect) lines.push(t("tile.multiHint"));
  }
  lines.push(t("wall.kbdHint"));

  // Merge the sortable node ref and the in-view observer ref: dnd-kit owns
  // `setNodeRef`, and `tileRef` owns IntersectionObserver registration. Both
  // must see the same DOM node, so a single callback ref forwards to both.
  const mergedRef = (el: HTMLButtonElement | null) => {
    setNodeRef(el);
    tileRef(el);
  };

  return (
    <button
      ref={mergedRef}
      type="button"
      // The wall's arrow-key handler finds cards by this attribute and measures
      // their real rectangles; a stable data attribute beats a class name that
      // the density/skin system can change.
      data-wall-card
      data-slug={slug}
      {...attributes}
      {...listeners}
      // Clicking the tile is the app's only way to open a project from the wall,
      // so it is also what makes 最近使用 and the 打开过 filter mean anything:
      // without this write the usage record would only ever grow from the 常用 page.
      //
      // 多选 (需求 9.1) takes the click over *inside* the tile rather than by
      // re-routing the view: plain click still opens, right-click still menus and
      // the 6 px drag threshold still reorders — only the mode switch, or an
      // explicit Ctrl/Shift, changes what one left click means. Selecting is not
      // opening, so no usage record is written for it.
      onClick={(e) => {
        if (onSelect && (selectMode || e.ctrlKey || e.metaKey || e.shiftKey)) {
          onSelect(slug, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
          return;
        }
        recordUsage(usageKey);
        onOpen(slug);
      }}
      // r15-a11y-7: everything menu-shaped is conditional on the parent owning
      // a menu. `onContextMenu={() => undefined}` from the 常用 page used to
      // mean "right-click cancels the native menu and opens nothing" — a
      // silent dead gesture with a `haspopup` lie on top. No handler now means
      // the native menu survives and the tile does not claim one.
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(slug, e.clientX, e.clientY);
            }
          : undefined
      }
      // Shift+F10 and the dedicated Menu key are the keyboard equivalents of a
      // right-click (WHATWG). Without this the verbs 置顶/隐藏/删除 were
      // reachable only by mouse. ContextMenu's anchor fallback picks up the
      // (0,0) coordinates a synthetic contextmenu would carry.
      onKeyDown={(e) => {
        if (!onContextMenu) return;
        if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(slug, r.right - 8, r.bottom - 8);
      }}
      aria-haspopup={onContextMenu ? "menu" : undefined}
      title={lines.join("\n")}
      className={cn(
        // `.skin-card` supplies radius, border weight, elevation, hover lift and
        // duration, so switching skins restyles every tile with no component-level
        // branching. The hover translate therefore lives in the stylesheet too -
        // a Tailwind `hover:-translate-y-*` here would win over the token.
        "skin-card group relative flex flex-col overflow-hidden bg-card text-left",
        "border border-border-weak",
        "hover:border-primary/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-0",
        sortable && "cursor-grab active:cursor-grabbing",
        // 需求 2: a dragged card has to feel picked up. dnd-kit writes translate
        // only, so the scale/rotate below compose with it instead of fighting it for
        // the same property, and the ring says "this is the one you are holding".
        isDragging && "z-30 elevation-drag ring-2 ring-primary/45 cursor-grabbing",
        running && "ring-2 ring-success/70",
        // Selected: border colour, not a ring — a ring would fight 运行中's ring and
        // one of the two facts would silently lose the tie.
        selected && "border-primary",
      )}
      style={{
        transform: `${CSS.Translate.toString(transform) ?? ""}${
          isDragging ? " scale(1.03) rotate(1.1deg)" : ""
        }`,
        transition,
      }}
    >
      {/* Cover box is 2:1 to match GitHub's social preview images (1280x640).
          This matters: at 16:10 the shared image was cropped ~20% horizontally,
          which visibly cut repository names in half ("BurntSushi/ripgrep" showed
          as "urntSushi/ripgrep"). Matching the source ratio shows them whole and
          removes the need for object-contain letterboxing. */}
      <span
        className="relative block w-full overflow-hidden"
        style={{ aspectRatio: coverRatio }}
      >
        <span
          className="absolute inset-0"
          style={{
            background: coverPair
              ? `linear-gradient(140deg, ${coverPair[0]}, ${coverPair[1]})`
              : undefined,
          }}
        />
        {/* sheen: keeps the generated fallback from looking like a flat swatch.
            Tokenised so the light theme can lift it instead of pasting a white
            highlight over a pale surface. */}
        <span className="cover-sheen absolute inset-0" />
        {coverFit === "blur" && cover && (
          <span
            aria-hidden
            className="cover-blur absolute inset-0"
            style={{
              backgroundImage: `url(${cover})`,
              backgroundPosition: `${fx}% ${fy}%`,
            }}
          />
        )}

        {cover && (
          <img
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setCover(null);
              setLoaded(false);
              setCoverOrigin("failed");
            }}
            className={cn(
              "repo-cover skin-cover absolute inset-0 h-full w-full transition-opacity",
              coverFit === "contain" || coverFit === "blur" ? "object-contain" : "object-cover",
              loaded ? "opacity-100" : "opacity-0",
            )}
            style={{
              objectPosition: `${fx}% ${fy}%`,
              // `auto` leaves filter alone so `.skin-cover` (the stylesheet's hook for
              // --skin-cover-filter, and what the skins scenario measures) stays in
              // charge; the other three tiers override it for this one cover.
              filter: coverLook === "auto" ? undefined : COVER_LOOKS[coverLook],
              transitionDuration: "var(--motion-slow)",
              transitionTimingFunction: "var(--ease-out)",
            }}
          />
        )}

        {/* Fallback identity, shown under the cover so a failed fetch still reads
            as a repository rather than a blank rectangle. */}
        {!loaded && (
          <span className="absolute bottom-1.5 left-2.5 text-brand font-semibold tracking-tight text-white/80">
            {repo.repo.slice(0, 2).toUpperCase()}
          </span>
        )}

        {/* scrim: keeps the caption legible over any cover. Height is in rem so it
            grows with 尺度 instead of staying a 40px band under a 17px title. */}
        <span className="cover-scrim absolute inset-x-0 bottom-0" />
        {cover && !loaded && <span className="cover-loading motion-indeterminate absolute inset-x-0 bottom-0 h-0.5" />}

        {/* Running chip. Top-left so it never competes with 置顶 (top-right) and
            the pair stays readable on the same card. */}
        {running && (
          <span
            className={cn(
              "absolute left-2 top-2 flex items-center gap-1 rounded-full px-2 py-0.5",
              "cover-chip text-caption text-white backdrop-blur-sm",
              running.state === "suspended" ? "text-warning" : "text-success",
            )}
          >
            {running.state === "suspended" ? (
              <Pause className="h-3 w-3" />
            ) : (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
            )}
            {running.state === "suspended" ? t("tile.suspended") : t("tile.running")}
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
        {/* No `title`: the whole name is on screen already, and this is the one line
            that must not truncate into a tooltip for its own text. The alias, when
            there is one, replaces the name and the real name moves down a line -
            hiding the repository's identity behind a private label would make the
            card unreadable to anyone else looking at the screen. */}
        {alias ? (
          <>
            <span className="w-full truncate text-body font-medium leading-snug">{alias}</span>
            <span className="w-full truncate text-caption text-muted-foreground">
              {repo.repo}
            </span>
          </>
        ) : (
          <span className="w-full truncate text-body font-medium leading-snug">{repo.repo}</span>
        )}
        {/* The owner line's tooltip is the profile address plus how much of the wall
            belongs to them — the count is a fact about the wall, not about this
            repository, and printing it would push the owner name into truncation on
            a narrow card. */}
        <span
          {...reg("repo-tile-owner")}
          className="w-full truncate text-caption text-muted-foreground"
          title={
            ownerCount > 1
              ? `${t("tile.home", { host: repo.host, owner: repo.owner })}\n${t("tile.homeMore", { n: ownerCount - 1 })}`
              : t("tile.home", { host: repo.host, owner: repo.owner })
          }
        >
          {repo.owner}
        </span>
        {/* C1: the repository description. One line, truncated, with the full
            text in a tooltip. Shown only when non-empty — a card with no
            description does not gain a blank line. The i18n key is optional;
            when absent the line renders the raw text (the common case). */}
        {repo.description && (
          <span
            className="repo-desc w-full truncate text-caption text-muted-foreground/70"
            title={repo.description}
          >
            {repo.description}
          </span>
        )}
        {/* Hidden by [data-repo-path="off"]; the path arrives from the backend so
            it is the real directory, not `<repo>_<owner>` reconstructed.
            The title stays while it is visible because `truncate` hides the tail of
            a long path; while it is hidden the card's own tooltip carries it. */}
        {repo.path && (
          <span
            {...reg("repo-tile-path")}
            className="repo-path w-full truncate font-mono text-caption text-muted-foreground/80"
            title={showPath ? repo.path : undefined}
          >
            {repo.path}
          </span>
        )}
        {/* The metadata line. Not `app-desc`: these are facts about the
            project, not an explanation of the page, so 隐藏描述性文字 must
            not take them away. */}
        {metaText && (
          <span className="w-full truncate text-caption text-muted-foreground/70" title={metaText}>
            {metaText}
          </span>
        )}
        {/* 标签（需求 N3-2）. Three at most, then a count: a card is a 232 px tile,
            and eight pills would push the name off the bottom - the +N form keeps
            the line one row tall and still says how much is there. `title` carries
            the full list because `truncate` would otherwise hide the tail with no
            way to read it. Marked `app-desc`-free on purpose: these are the user's
            own labels for this project, not commentary on the page, so 隐藏描述性文字
            must not delete the reason the 标签 chip row filters anything. */}
        {note && (
          <span
            className="flex w-full items-center gap-1 text-caption text-muted-foreground"
            title={note}
            aria-label={note}
          >
            <StickyNote className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{note}</span>
          </span>
        )}
        {visibleTags.length > 0 && (
          <span
            {...reg("repo-tile-tags")}
            className="flex w-full flex-wrap items-center gap-1"
            title={tagList.join(" · ")}
          >
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className="max-w-[7rem] truncate rounded-full border border-primary/40 bg-primary/10 px-1.5 py-px text-caption leading-tight text-primary"
              >
                {tag}
              </span>
            ))}
            {tagList.length > visibleTags.length && (
              <span className="text-caption text-muted-foreground/70">+{tagList.length - visibleTags.length}</span>
            )}
          </span>
        )}
      </span>

      {/* Pinned and 打开 share the top-right: one is a durable state and the other
          is a hover affordance, so they never need to be legible at once. In 多选
          the hover badge says the wrong thing (a click no longer opens), so the same
          slot carries the selection state instead — and 置顶 stays visible through
          the border, which is why selection did not get a ring. */}
      {selectMode ? (
        <span
          className={cn(
            "pointer-events-none absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-md border backdrop-blur-sm",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-white/70 bg-black/45",
          )}
          title={selected ? t("tile.selected") : t("tile.unselected")}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </span>
      ) : pinned && !running ? (
        <span
          className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/55 px-1.5 py-0.5 text-caption text-white backdrop-blur-sm"
          title={t("tile.pinnedTitle")}
        >
          {t("tile.pinned")}
        </span>
      ) : (
        <span
          {...reg("repo-tile-badge")}
          className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5
                     text-caption text-white opacity-0 backdrop-blur-sm transition-opacity duration-[var(--motion-state)]
                     group-hover:opacity-100"
        >
          {/* `pointer-events-none` means this span never receives the pointer, so a
              `title` here would be unreachable — the "what happens when I click"
              answer lives in the view's header hint instead. */}
          {t("tile.open")}
        </span>
      )}
    </button>
  );
});
