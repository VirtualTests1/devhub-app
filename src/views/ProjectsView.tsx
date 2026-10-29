import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDestructive } from "../lib/confirm";
import {
  BookmarkPlus,
  BookOpen,
  Broom,
  Download,
  Eye,
  FileSearch,
  FolderOpen,
  FolderTree,
  LoaderCircle,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SquareArrowOutUpRight,
  SquareCheckBig,
  SquareStop,
  Stethoscope,
  Tags,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { ViewHeader } from "../shell/AppShell";
import { RepoTile, type TileRunning } from "../components/RepoTile";
import { BatchBar, type BatchAction, type BatchItemResult } from "../components/BatchBar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { MenuSelect, Segmented } from "../components/Controls";
import { toast } from "../components/Toast";
import { cn } from "../lib/utils";
import type { TFunc, TranslationKey } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { mapBounded } from "../lib/bounded-map";
import {
  FRESHNESS_CAP,
  FRESHNESS_WIDTH,
  errorVerdict,
  freshnessVerdict,
  notReachedVerdict,
  planFreshnessScan,
  scanSummaryLine,
  summarizeScan,
  uncheckedNote,
  type FreshnessTone,
} from "../lib/freshness-scan";
import { useAutoLayers, useEntranceGate, useLayerExit } from "../lib/motion";
import { filterWallCards, groupCardsByOwner, tierSortCards } from "../lib/wall-derive";
import { messageOf, reportError } from "../lib/report-error";
import { requestCompletionAttention } from "../lib/use-completion-attention";
import { updateFailureLine, updateOneRepo, type UpdateInvoker } from "../lib/update-repo";
import { worktreeWarningLine, type WorktreeProbe } from "../lib/worktree-warning";
import { registerViewContext, useUI } from "../store/ui";
import { useLiveProcesses } from "../store/processes";
import { useMeta } from "../store/meta";
import { useHeat } from "../store/heat";
import { heatNames } from "../lib/heat";
import { useSelection } from "../store/selection";
import { useWallViews } from "../store/wall-views";
import {
  WALL_VIEW_LIMIT,
  criteriaOf,
  hasViewCriteria,
  sameCriteria,
  type WallViewCriteria,
} from "../lib/wall-views";
import { reg, useCustomize } from "../store/customize";
import {
  WALL_DENSITIES,
  WALL_DENSITY_MIN,
  FILTERS,
  REPO_TAG_LIMIT,
  SORTS,
  applyOverlay,
  applyTagsTo,
  coerceWallPref,
  hasRepoTag,
  slugOf,
  stripTagsFrom,
  tagRemovalWorkFor,
  tagVocabulary,
  tagWorkFor,
  useWall,
  type FilterId,
  type RepoState,
  type SortId,
} from "../store/wall";
import { openHttpUrl } from "../lib/external-url";
import { fmtRelative } from "../lib/format";
import { windowGroups } from "../lib/wall-window";
import { useWallWindow } from "../lib/use-wall-window";
import { isWallNavKey, nextCardIndex } from "../lib/wall-keyboard";
import {
  CATEGORY_LABEL,
  formatBytes,
  type Freshness,
  type FreshnessManyRow,
  type ProcessState,
  type RepoRef,
  type UpdateOutcome,
  type WorktreeStatus,
} from "../types";

/** One row of the 检查更新 result list: the display name plus a verdict. */
type ScanRow = { name: string; tone: FreshnessTone; text: string; detail: string; checkedAt: number };

/** A verdict about one slug, before the row's display name is attached. */
type ScanAnswer = Omit<ScanRow, "name">;

/**
 * Projects view — the default view and the product's actual core.
 *
 * Two states, and the empty one matters because it is what a first-time user (and
 * a store screenshot) sees:
 *
 *   populated: a filterable, reorderable repository wall filling the columns
 *   empty:     a real call to action, not a dead dashed box
 *
 * ## What filtering can honestly be built here
 *
 * The wall is a `RepoRef[]`, and `RepoRef` is exactly five fields:
 * `host / owner / repo / local / path`. Everything below is computed from those
 * plus the per-device usage record and the live process list. That is the honest
 * ceiling, and it rules two things out rather than faking them:
 *
 *   - 有启动命令 / 未确认 — `LaunchConfig.userConfirmed` is not on `RepoRef`. It
 *     only exists per repository, behind `repo_detail`, so a 40-tile wall would
 *     issue 40 IPC calls and the chips would fill in one at a time while you
 *     looked at them. Left out instead of guessed from the folder name.
 *   - 已下载 / 未下载 — every entry the wall lists came off disk, so `path` is
 *     always set and `local` always null (`repo_ref_of` in the backend). A chip
 *     that matches 100% of the list is decoration, not a filter.
 *   - 有新提交 badge per tile — ruled out for a different reason: cost, not
 *     data. One `repo_freshness` is one `git ls-remote` subprocess plus one TLS
 *     session (`downloader.rs:2023`), and the five-minute cache (`lib.rs:1301`)
 *     is only filled *after* a call completes (`lib.rs:1342`), so a cold wall has
 *     no answer for any tile. A badge would therefore be either absent-on-first-
 *     look or paid for with N round trips per load.
 *     Round-17 O1 built the backend half the previous revision of this note asked
 *     for: `update_repo` now evicts the slug it just changed (`lib.rs:1259`), and
 *     `repo_freshness_many(slugs, maxParallel)` (`lib.rs:1521`) answers a whole
 *     batch in one IPC — cached hits immediately, fresh misses with bounded
 *     concurrency, and a "no answer yet" row for anything it did not reach. A
 *     per-tile badge still ships nothing of its own, because on a cold wall the
 *     batch has an answer only for the tiles it reached, so a badge would be
 *     missing for most of them — which is the same "left out instead of guessed"
 *     trade. What ships instead is the explicit 检查更新 over the filtered set,
 *     now driven through that batch (`lib/freshness-scan.ts`, `runFreshnessScan`).
 *     See 需求 8.2.
 *
 * ## Why the toolbar is a grid and not a wrapping flex row
 *
 * Reported against a sibling view: "点击'启动'和点击'终端'时的页面元素布局不一致，
 * 存在移位". The cause is the `ml-auto` idiom — a right-aligned element pushed by
 * `margin-left:auto` moves whenever anything to its left changes width, and on a
 * *wrapping* row a width change can also re-decide where the line breaks, so the
 * whole toolbar drops a row. Here every slot owns a grid track of its own, the
 * search input is always track one, the count is a fixed-width box, and the chip
 * set is constant (labels never change with selection, counts reserve their box).
 * Selecting a filter therefore repaints colours and nothing else.
 *
 * ## Round 4: the wall is arrangeable
 *
 * Display order is `sort tier → overlay`, where the overlay is 置顶 plus whatever
 * the person dragged (see `store/wall.ts`). Dragging is disabled while 按拥有者分组
 * is on, and the page says why under the toolbar rather than going quiet: a control
 * that stops working without an explanation reads as a bug.
 *
 * ## 需求 9.1: 多选, and what it deliberately does not change
 *
 * Every verb here used to be single-target. Selection is therefore an explicit mode
 * (工具条 多选, or a Ctrl+click on a card) rather than a redefinition of a plain
 * click: click-open, right-click-menu and drag-reorder all still work inside 多选,
 * because a wall where selecting costs you the operations is a worse wall.
 *
 * The batch verbs are exactly the per-repository commands that already exist —
 * `stop_process`, `update_repo`, `scan_cache` + `clear_cache`, `trash_repo` — so no
 * backend work was needed. Each one is the same function the card menu calls,
 * fanned out: 批量更新 and 更新 share `lib/update-repo.ts` rather than each keeping
 * their own sentence for "已快进 a1b2c3d → e4f5g6h".
 * 批量删除 is 移入回收站 only: REQUIREMENTS.md §3.1 makes 彻底删除
 * require typing that repository's own slug, and a batch mode cannot honour a
 * per-repository typing gate without either faking it or asking twelve times. One
 * confirmation naming every affected repository, then the reversible verb. The
 * irreversible one stays per-project in 启动面板 → 清理与删除. 批量更新 gets no
 * confirmation at all, and the reason is `downloader.rs:1953-1968` — a `--ff-only`
 * pull refuses instead of overwriting, so there is nothing to warn about beyond
 * what the per-repository result list already names.
 */

/** A wall entry with its canonical slug carried along. */
type Card = RepoRef & { slug: string };

/*
 * Six card-scoped dialogs are lazy (r22-O4, plus the file browser in r22-N2). All of them are opened from a card's
 * context menu, never on the wall's first paint, but their static imports put the
 * settings panels (compose/python/worktrees/ports), the Markdown parser and the grep
 * dialog into the eager entry chunk. Splitting them out is what the App-level dialogs
 * already do for the same reason. `preloadCardDialogs` below fetches them once the
 * wall has settled, so the first open still has no visible chunk-fetch hop.
 */
const ProjectSettingsDialog = lazy(() =>
  import("../dialogs/ProjectSettingsDialog").then((m) => ({ default: m.ProjectSettingsDialog })),
);
const RepoReadmeDialog = lazy(() =>
  import("../dialogs/RepoReadmeDialog").then((m) => ({ default: m.RepoReadmeDialog })),
);
const RepoDiagnoseDialog = lazy(() =>
  import("../dialogs/RepoDiagnoseDialog").then((m) => ({ default: m.RepoDiagnoseDialog })),
);
const RepoGrepDialog = lazy(() =>
  import("../dialogs/RepoGrepDialog").then((m) => ({ default: m.RepoGrepDialog })),
);
const RepoFilesDialog = lazy(() =>
  import("../dialogs/RepoFilesDialog").then((m) => ({ default: m.RepoFilesDialog })),
);
const RepoTagsDialog = lazy(() =>
  import("../components/RepoTagsDialog").then((m) => ({ default: m.RepoTagsDialog })),
);
const WallViewDialog = lazy(() =>
  import("../dialogs/WallViewDialog").then((m) => ({ default: m.WallViewDialog })),
);

/**
 * Fetch the card dialogs after first paint, not during it. A fixed 1.5 s timer rather
 * than `requestIdleCallback`: the latter is absent from the WebView2 typings this repo
 * compiles against, and a timer is enough — the wall has long painted by then, and a
 * failed preload is harmless because `lazy()` retries on the real open.
 */
function preloadCardDialogs(): () => void {
  const id = window.setTimeout(() => {
    void import("../dialogs/ProjectSettingsDialog");
    void import("../dialogs/RepoReadmeDialog");
    void import("../dialogs/RepoDiagnoseDialog");
    void import("../dialogs/RepoGrepDialog");
    void import("../dialogs/RepoFilesDialog");
    void import("../components/RepoTagsDialog");
    void import("../dialogs/WallViewDialog");
  }, 1500);
  return () => window.clearTimeout(id);
}

/**
 * The one registered 更新 command (`lib.rs:1209`), wrapped once at module scope.
 *
 * Module scope rather than inside the component because it closes over nothing:
 * the card menu and 批量更新 both call `updateOneRepo(slug, updateInvoker)`, and
 * an arrow function recreated per render would be a second copy of the invoke on
 * the next reader's bad day.
 */
const updateInvoker: UpdateInvoker = (slug) => invoke<UpdateOutcome>("update_repo", { slug });

type Menu = { slug: string; x: number; y: number } | null;

export function ProjectsView({
  repos,
  reposLoaded,
  onDownload,
  onWallChanged,
  downloadBusy,
  downloadDisabledReason,
}: {
  repos: RepoRef[];
  /** False until the first `list_repositories` resolves; gates the empty CTA. */
  reposLoaded: boolean;
  /** `source` is the 界面归属 written into 记录; this view issues 项目. */
  onDownload: (ref: string, source: string) => void;
  /** Re-reads the wall after an action that changed the disk. */
  onWallChanged: () => void;
  downloadBusy: boolean;
  downloadDisabledReason: string | null;
}) {
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  // r17-n1-2 / r17-n2-3: one locale subscription for this view. The card's
  // right-click menu (buildMenu below) and the 查看 README… row resolve through the
  // dictionary; only that menu is wired in this file, not the wall's toolbar. Without
  // subscribing, the row would keep the previous language until something else
  // repainted the wall.
  const { t } = useI18n();
  const usage = useCustomize((s) => s.usage);
  const states = useWall((s) => s.repos);
  const sort = useWall((s) => s.sort);
  const filter = useWall((s) => s.filter);
  const grouped = useWall((s) => s.grouped);
  const density = useWall((s) => s.density);
  const setPref = useWall((s) => s.setPref);
  const togglePin = useWall((s) => s.togglePin);
  const toggleHidden = useWall((s) => s.toggleHidden);
  const applyOrder = useWall((s) => s.applyOrder);
  const resetOrder = useWall((s) => s.resetOrder);
  const wallRecoveredAt = useWall((s) => s.recoveredAt);
  const dismissWallRecovery = useWall((s) => s.dismissRecovery);
  const metaBySlug = useMeta((s) => s.bySlug);
  // r18 N4. Keyed by `owner/repo` (GitHub's own identity), not by the wall's
  // `host/owner/repo` slug — see `src/lib/wall-derive.ts:WallSortContext`.
  const heatByOwnerRepo = useHeat((s) => s.bySlug);
  // Live processes come from the store, not from props: the two-second poll
  // re-renders this view (which builds the running badge) but not `App`, the
  // shell, or the other views. With `RepoTile` memoized and its callbacks
  // stabilized, a tick only re-renders the tiles whose running state actually
  // changed — see `store/processes.ts`.
  const live = useLiveProcesses();

  // Warm the card dialogs after first paint (see `preloadCardDialogs`).
  useEffect(() => preloadCardDialogs(), []);

  // 需求 9.1. Two subscriptions only (mode + the set); the actions are reached
  // through `useSelection.getState()` in the handlers, the same way this view
  // already reaches `useUI.getState()` from a click.
  const selMode = useSelection((s) => s.mode);
  const selSlugs = useSelection((s) => s.slugs);

  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu stays in the DOM for one exit-duration after 关闭, which is what lets
  // it leave with motion instead of blinking out. `menu` keeps the items so the
  // closing frames still render content.
  const menuLayer = useLayerExit(menuOpen);
  const [settingsSlug, setSettingsSlug] = useState<string | null>(null);
  /** Which card the 本地 README 预览 dialog is open on (round 17, n2-3). */
  const [readmeSlug, setReadmeSlug] = useState<string | null>(null);
  /** Which card the 仓库健康诊断 dialog is open on (round 17, N3-2). */
  const [diagnoseSlug, setDiagnoseSlug] = useState<string | null>(null);
  // 「在项目中搜索」对话框（r21-N1-1）：与诊断同款的按-slug 挂载，卡片给它 root。
  const [grepSlug, setGrepSlug] = useState<string | null>(null);
  const [filesSlug, setFilesSlug] = useState<string | null>(null);
  /** Which card the 标签… sheet is open on (需求 N3-2). */
  const [tagsSlug, setTagsSlug] = useState<string | null>(null);
  /**
   * The active 标签 chips (需求 N3-2).
   *
   * View state, not `WallPrefs`, and that is the honest choice rather than less
   * persistence: `filter` is a closed id table that `coerceWallPref` and
   * `readStored` validate against, and `query` is in the same boat this field is
   * in - a search nobody wants restored from disk after a restart, because the
   * wall it matched is not the wall there is now. 标签 inherits that rule.
   */
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // Which card is mid-flight, and what is happening to it. The card menu reads
  // this to disable the verb that would collide with it — 更新 and 删除 both touch
  // the directory on disk, so they cannot run at once — and the *reason* travels
  // with it, because a disabled control whose "why" only lives in a tooltip is
  // unreadable once the pointer events go away (the pattern 批量更新 and the 下载
  // gate already follow).
  const [busy, setBusy] = useState<{ slug: string; note: string } | null>(null);
  // A live batch, named by its own label (批量更新 / 批量删除…). The card menu needs
  // it because a batch holds the repository it is pulling, so 更新/删除 on one of
  // *those* cards must be disabled with the reason — and only on those cards, not
  // on the forty the batch has no business touching.
  const [batchBusy, setBatchBusy] = useState<string | null>(null);

  /** One row of the 检查更新 result list. */
  const [scan, setScan] = useState<{
    /** Slugs in display order — the list renders this, not the response order. */
    order: string[];
    rows: Record<string, ScanRow>;
    /** Cards the per-scan cap left out. */
    skipped: number;
    /** Whether the last scan demanded fresh answers (the 重新检查 button). */
    force: boolean;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  // Set on 关闭 so a scan in flight stops writing rows into a panel that is gone;
  // the in-flight `git ls-remote` itself is the backend's to finish.
  const scanAbort = useRef(false);

  /** What is running on this card, in the words a disabled row prints. */
  const busyNoteFor = (slug: string): string | null => {
    if (busy?.slug === slug) return busy.note;
    if (batchBusy && selSlugs.includes(slug)) return `${batchBusy}${t("wall.busSuffix")}`;
    return null;
  };
  // The last 更新 that failed, so its reason and its retry outlive the menu.
  // A toast goes away in six seconds and has no button; a refusal the user has
  // to act on (dirty tree, diverged branch, dead remote) needs somewhere to sit.
  const [updateFailure, setUpdateFailure] = useState<{
    slug: string;
    detail: string;
    remedy: string | null;
    retryable: boolean;
  } | null>(null);

  // Every hook runs before the empty-state return below, so the empty wall is a
  // separate component rather than an early `return` with its own `useState`:
  // a hook count that depends on `repos.length` re-mounts the view the moment the
  // first download lands, which is exactly when the wall must not lose its filter.
  const q = query.trim().toLowerCase();

  /** The newest live process per repository - what the card badge shows. */
  const runningBySlug = useMemo(() => {
    const m = new Map<string, TileRunning>();
    for (const p of live) {
      if (p.state === "exited") continue;
      const prev = m.get(p.slug);
      // Several steps of one launch run as several processes; the card shows the
      // one that has been up longest, because that is "this project has been
      // running since".
      if (prev && prev.elapsedMs >= p.elapsedMs) continue;
      m.set(p.slug, { state: p.state, elapsedMs: p.elapsedMs, label: p.label });
    }
    return m;
  }, [live]);

  const cards = useMemo<Card[]>(
    () => repos.map((r) => ({ ...r, slug: slugOf(r) })),
    [repos],
  );

  const visible = useMemo(
    () => cards.filter((c) => !states[c.slug]?.hidden),
    [cards, states],
  );

  /**
   * The 标签 chip row (需求 N3-2).
   *
   * Counted over `visible`, exactly like `counts` below: a chip for a tag that
   * only a hidden card carries would filter the wall to nothing, and the toolbar
   * is supposed to be a map of what is actually reachable.
   */
  const tagChips = useMemo(
    () => tagVocabulary(Object.fromEntries(visible.map((c) => [c.slug, states[c.slug]]))),
    [visible, states],
  );

  /**
   * Chips that still name something on the wall.
   *
   * Removing the last card's tag, hiding a tagged card or importing someone else's
   * wall can all retire a tag out from under a live selection. Keeping the stale
   * term would filter to an empty wall with no chip left on screen to click off,
   * so the selection is read through this and a term with no owner drops out.
   */
  const activeTags = useMemo(() => {
    const kept: string[] = [];
    for (const chip of tagChips) {
      // Read through the vocabulary, so the canonical spelling the chip shows is the
      // one that reaches the filter and the batch verb.
      if (hasRepoTag(tagFilter, chip.tag) && !hasRepoTag(kept, chip.tag)) kept.push(chip.tag);
    }
    return kept;
  }, [tagChips, tagFilter]);

  const wallViews = useWallViews((s) => s.views);
  const wallViewActiveId = useWallViews((s) => s.activeId);
  const wallViewApply = useWallViews((s) => s.applyRequest);
  const [viewDialog, setViewDialog] = useState<
    { mode: "save" } | { mode: "rename"; id: string; name: string } | null
  >(null);

  /** What the toolbar currently asks for; a saved view is one of these. */
  const currentCriteria = useMemo<WallViewCriteria>(
    () => ({
      query: query.trim(),
      language: langFilter,
      category: catFilter,
      tags: [...activeTags],
      sort,
      filter,
    }),
    [query, langFilter, catFilter, activeTags, sort, filter],
  );

  /**
   * The saved view the wall is still showing.
   *
   * Derived rather than trusted: a stored `activeId` plus a later manual edit is
   * not "that view anymore", and a select that kept the old name would claim the
   * wall is filtered by something it is not. The store keeps the id so the
   * palette can re-apply it; the toolbar only shows it while the criteria match.
   */
  const activeView = useMemo(() => {
    const view = wallViews.find((v) => v.id === wallViewActiveId);
    return view && sameCriteria(currentCriteria, criteriaOf(view)) ? view : null;
  }, [wallViews, wallViewActiveId, currentCriteria]);

  /**
   * Palette → wall hand-off. The palette may run while this view is unmounted,
   * so it writes a request instead of trying to call state setters that do not
   * exist yet; the effect consumes it once and clears the request.
   */
  useEffect(() => {
    if (!wallViewApply) return;
    const store = useWallViews.getState();
    const view = store.views.find((v) => v.id === wallViewApply.id);
    if (!view) {
      store.consume(wallViewApply.seq);
      return;
    }
    setQuery(view.query);
    setLangFilter(view.language);
    setCatFilter(view.category);
    setTagFilter(view.tags);
    setPref("sort", view.sort);
    setPref("filter", view.filter);
    useWallViews.setState({ activeId: view.id });
    store.consume(wallViewApply.seq);
  }, [wallViewApply, setPref]);

  const saveCurrentView = (name: string) => {
    const result = useWallViews.getState().save(name, currentCriteria);
    if (!result.ok) {
      toast.error(
        result.reason === "duplicate"
          ? t("wall.views.duplicate")
          : result.reason === "full"
            ? t("wall.views.full", { n: WALL_VIEW_LIMIT })
            : t("wall.views.emptyName"),
      );
      return;
    }
    setViewDialog(null);
    toast.success(t("wall.views.saved", { name: result.view.name }));
  };

  const renameView = (id: string, name: string) => {
    const result = useWallViews.getState().rename(id, name);
    if (!result.ok) {
      toast.error(
        result.reason === "duplicate"
          ? t("wall.views.duplicate")
          : result.reason === "full"
            ? t("wall.views.full", { n: WALL_VIEW_LIMIT })
            : t("wall.views.emptyName"),
      );
      return;
    }
    setViewDialog(null);
    toast.success(t("wall.views.renamed", { name }));
  };

  const deleteActiveView = async () => {
    if (!activeView) return;
    const ok = await confirmDestructive(t("wall.views.deleteConfirm", { name: activeView.name }), {
      title: t("wall.views.deleteTitle"),
      okLabel: t("wall.views.delete"),
    });
    if (!ok) return;
    useWallViews.getState().remove(activeView.id);
    toast.success(t("wall.views.removed", { name: activeView.name }));
  };

  const languageOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visible) {
      const lang = metaBySlug[c.slug]?.language;
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    return [
      { id: "", label: t("wall.facet.all"), note: String(visible.length) },
      ...Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, n]) => ({ id, label: id, note: String(n) })),
    ];
  }, [visible, metaBySlug, t]);

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visible) {
      const cat = metaBySlug[c.slug]?.category;
      if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return [
      { id: "", label: t("wall.facet.all"), note: String(visible.length) },
      ...Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, n]) => ({ id, label: CATEGORY_LABEL[id] ?? id, note: String(n) })),
    ];
  }, [visible, metaBySlug, t]);

  const matched = useMemo(
    // 派生管道抽到 lib/wall-derive.ts（r17-o2-3）：谓词原先写在这个 .tsx 里，
    // Node 的 type-stripping 无法从 JSX 取类型，于是「标签与筛选如何相交」这一层
    // 从没被单测钉住（tests/wall-selectors.test.ts:5-9 记录的正是这个缺口）。
    () =>
      filterWallCards(visible, {
        query: q,
        filter,
        states,
        usage,
        running: runningBySlug,
        activeTags,
        metaBySlug,
        language: langFilter,
        category: catFilter,
      }),
    [visible, q, filter, usage, states, runningBySlug, activeTags, metaBySlug, langFilter, catFilter],
  );

  /**
   * One tier comparator, applied to whichever list it is given.
   *
   * Two callers: the rows on screen (`matched`, below) and — when a drag has to
   * number the **whole** wall rather than the filtered subset it moved inside —
   * `cards`. Taking the input as an argument is the point: the off-filter cards
   * have to be stamped in tier order, not in whatever order the backend hands
   * the repositories over in, or clearing the search would show them in a
   * sequence no tier ever chose.
   */
  const tierSort = useCallback(
    (input: Card[]) => tierSortCards(input, { sort, usage, metaBySlug, heatByOwnerRepo }),
    [sort, usage, metaBySlug, heatByOwnerRepo],
  );

  /**
   * r18 N4: heat is the one wall fact that comes from GitHub rather than from the clone,
   * so it is asked for **only** when the wall is actually ordered by it — and never on a
   * timer. `useHeat` drops a second load while one is in flight and owns the request
   * sequence, and the backend holds the answers for six hours and revalidates the rest
   * with `If-None-Match`, so picking 按 Star 数 twice in a row costs nothing.
   */
  useEffect(() => {
    if (sort !== "stars") return;
    void useHeat.getState().load(heatNames(cards));
  }, [sort, cards]);

  /** Tier order first; 置顶 and the dragged positions are applied after. */
  const tierSorted = useMemo(() => tierSort(matched), [matched, tierSort]);

  const sorted = useMemo(
    () => applyOverlay(tierSorted, states, runningBySlug),
    [tierSorted, states, runningBySlug],
  );

  /**
   * Chip counts are taken over the **whole** wall, not over the current search.
   * A chip reading "打开过 3" above a list showing 2 would be a small lie either
   * way, but the real reason is geometry: a count that changes as you type changes
   * chip width, and chip width decides where the chip row wraps.
   */
  const counts = useMemo(() => {
    let opened = 0;
    for (const c of visible) if (usage[`repo:${c.slug}`]) opened += 1;
    const running = new Set(
      visible.filter((c) => runningBySlug.has(c.slug)).map((c) => c.slug),
    );
    return {
      all: visible.length,
      opened,
      unopened: visible.length - opened,
      running: running.size,
    };
  }, [visible, usage, runningBySlug]);

  const hiddenCount = useMemo(
    () => cards.filter((c) => states[c.slug]?.hidden).length,
    [cards, states],
  );

  /** Repositories per owner, handed to the tile so its tooltip can say it. */
  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of visible) m.set(c.owner, (m.get(c.owner) ?? 0) + 1);
    return m;
  }, [visible]);

  const groups = useMemo(() => {
    if (!grouped) return null;
    return groupCardsByOwner(sorted);
  }, [grouped, sorted]);

  // --- 多选与批量操作（需求 9.1）-------------------------------------------
  /** What is chosen, and what the wall can act on. */
  const selectedSet = useMemo(() => new Set(selSlugs), [selSlugs]);

  /** Display order of everything the wall knows, which is what Shift ranges walk. */
  const order = useMemo(() => sorted.map((c) => c.slug), [sorted]);

  /*
   * `order` behind a ref, read at click time.
   *
   * A Shift range has to be extended over whatever the wall shows *right now*, so
   * the value is the one the render produced. Keeping it in a ref instead of in
   * the callback's dependency list is what lets `onSelectTile` below stay stable:
   * `order` is recomputed on every keystroke in 搜索项目, and a `useCallback` that
   * depended on it would hand a new function identity to all N tiles exactly when
   * the list is otherwise unchanged — the failure `handleContextMenu`'s comment
   * documents and `memo` on `RepoTile` exists to avoid.
   */
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  const cardBySlug = useMemo(() => new Map(cards.map((c) => [c.slug, c] as const)), [cards]);

  /** The name the card itself prints, so a batch report names things the way the wall does. */
  const nameOf = (slug: string): string => {
    const c = cardBySlug.get(slug);
    return states[slug]?.alias ?? (c ? `${c.owner}/${c.repo}` : slug);
  };

  /**
   * Live processes per repository, from the list the shell already polls. This is
   * the whole reason 批量停止 needs no new command: it is the same `stop_process`
   * call the 状态栏 makes per PID, just fanned out.
   */
  const pidsBySlug = useMemo(() => {
    const m = new Map<string, ProcessState[]>();
    for (const p of live) {
      if (p.state === "exited") continue;
      const arr = m.get(p.slug);
      if (arr) arr.push(p);
      else m.set(p.slug, [p]);
    }
    return m;
  }, [live]);

  const onSelectTile = useCallback(
    (slug: string, mods: { additive: boolean; range: boolean }) => {
      const s = useSelection.getState();
      if (mods.range) s.extendTo(orderRef.current, slug);
      else s.toggle(slug);
    },
    [],
  );

  // Escape 退出多选. Guarded against the layers that own Escape first — the tile
  // menu and the launch panel both close on it, and taking the key away from them
  // would leave a menu that cannot be dismissed by the key that always dismissed it.
  useEffect(() => {
    if (!selMode) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (menu || useUI.getState().openSlug) return;
      ev.preventDefault();
      useSelection.getState().exit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selMode, menu]);

  /** One repository's share of 批量停止: every live PID it owns, sequentially. */
  const stopOneRepo = async (slug: string): Promise<BatchItemResult> => {
    const procs = pidsBySlug.get(slug) ?? [];
    if (!procs.length) return { ok: true, detail: t("wall.stopNone") };
    const stopped: number[] = [];
    const errors: string[] = [];
    // Sequential, not `Promise.all`: these are the same PID the 启动面板 is watching,
    // and two kills of one tree answer with whichever failure arrived last.
    for (const p of procs) {
      if (!p.stoppable) {
        errors.push(t("wall.pidNoStop", { pid: p.pid }));
        continue;
      }
      try {
        await invoke("stop_process", { pid: p.pid });
        stopped.push(p.pid);
      } catch (err) {
        errors.push(t("wall.pidFail", { pid: p.pid, reason: messageOf(err) }));
      }
    }
    if (errors.length)
      return { ok: false, detail: t("wall.stopPartial", { done: stopped.length, total: procs.length, errors: errors.join("；") }) };
    return { ok: true, detail: t("wall.stopOk", { n: stopped.length }) };
  };

  /** Scan then clear, exactly the two stages the launch panel uses. */
  const clearOneRepoCache = async (slug: string): Promise<BatchItemResult> => {
    let items: { rel: string }[];
    try {
      const report = await invoke<{ items: { rel: string; bytes: number }[]; totalBytes: number }>(
        "scan_cache",
        { slug },
      );
      items = report.items;
    } catch (err) {
      return { ok: false, detail: t("wall.scanFail", { reason: messageOf(err) }) };
    }
    if (!items.length) return { ok: true, detail: t("wall.cacheNone") };
    try {
      const res = await invoke<{ freedBytes: number; removed: string[]; failed: string[] }>(
        "clear_cache",
        { slug, rels: items.map((i) => i.rel) },
      );
      const freed = formatBytes(res.freedBytes);
      if (res.failed.length)
        return { ok: false, detail: t("wall.cachePartial", { freed, n: res.failed.length, items: res.failed.join("；") }) };
      return { ok: true, detail: t("wall.cacheOk", { freed, n: res.removed.length }) };
    } catch (err) {
      return { ok: false, detail: t("wall.cacheFail", { reason: messageOf(err) }) };
    }
  };

  const trashOneRepo = async (slug: string): Promise<BatchItemResult> => {
    try {
      const r = await invoke<{ removedRepo: boolean; freedBytes: number; failed: string[] }>(
        "trash_repo",
        { slug },
      );
      const freed = formatBytes(r.freedBytes);
      if (r.failed.length)
        return { ok: false, detail: t("wall.trashPartial", { items: r.failed.join("；"), freed }) };
      if (!r.removedRepo) return { ok: false, detail: t("wall.trashStuck") };
      return { ok: true, detail: t("wall.trashOk", { freed }) };
    } catch (err) {
      // `messageOf`, not `String(err)`: a batch row that printed `[object Object]`
      // or `undefined` instead of the backend's sentence is the failure
      // `lib/report-error.ts` exists to make impossible, and 批量更新 proves the
      // point one line below — the two verbs must not describe failures
      // differently from each other.
      return { ok: false, detail: messageOf(err) };
    }
  };

  /**
   * 批量更新's per-repository step: `updateOneRepo`, with the remedy folded into
   * the one line a result row has room for.
   *
   * Declared as its own function rather than inline in `batchActions` because the
   * card menu calls the same underlying thing and must keep the two-line shape
   * (`detail` + `remedy` in a banner). The command, the success sentence and the
   * failure classification all live in `lib/update-repo.ts`; this is the only
   * adapter, and there is only one of it.
   */
  const updateOneRepoForBatch = async (slug: string): Promise<BatchItemResult> => {
    const r = await updateOneRepo(slug, updateInvoker);
    return r.ok ? r : { ok: false, detail: updateFailureLine(r) };
  };

  /* --- 批量打标签 / 批量去标签（需求 N3-3）-------------------------------
   *
   * The target is the chip row's own selection, so these two verbs add no state of
   * their own and cannot disagree with the filter the user is looking at. With no
   * chip lit the pure functions report 0 work, which is how `BatchBar` disables the
   * button and prints the reason on its face - not "apply nothing to everything".
   *
   * All the arithmetic (what landed, what the 8-cap refused) lives in `wall.ts`;
   * these are adapters, the way 批量更新 delegates its decisions to
   * `lib/update-repo.ts` and keeps only the wording here.
   *
   * `useWall.getState()` inside the step, not the render's `states`: a batch runs one
   * step per card against the same render, and reading a snapshot would let a second
   * touch of one card write over the first.
   */
  const tagsNow = (slug: string): string[] | undefined => useWall.getState().repos[slug]?.tags;

  const tagAddOne = async (slug: string): Promise<BatchItemResult> => {
    const { next, added, refused } = applyTagsTo(tagsNow(slug), activeTags);
    if (added.length === 0 && refused.length === 0) {
      return { ok: true, detail: t("wall.tagHave") };
    }
    // The part that fit is still written: one chip blocked by the cap is no reason to
    // discard the two the card had room for.
    if (added.length > 0) useWall.getState().setRepo(slug, { tags: next ?? undefined });
    if (refused.length === 0) return { ok: true, detail: t("wall.tagAdded", { tags: added.join("、") }) };
    // A card that took two of three chips is reported as a failure, because that is
    // what it is: the batch was asked to do three things and did two. `BatchBar`
    // prints `detail` either way, so the row says exactly which chips landed.
    return {
      ok: false,
      detail: added.length
        ? t("wall.tagAddedRefused", { added: added.join("、"), refused: refused.join("、"), n: REPO_TAG_LIMIT })
        : t("wall.tagNoneAdded", { n: REPO_TAG_LIMIT }),
    };
  };

  const tagRemoveOne = async (slug: string): Promise<BatchItemResult> => {
    const { next, removed } = stripTagsFrom(tagsNow(slug), activeTags);
    if (removed.length === 0) return { ok: true, detail: t("wall.tagRemoveNone") };
    useWall.getState().setRepo(slug, { tags: next ?? undefined });
    return { ok: true, detail: t("wall.tagRemoved", { tags: removed.join("、") }) };
  };

  const batchActions: BatchAction[] = [
    {
      id: "stop",
      label: t("wall.batch.stop"),
      icon: <SquareStop className="h-3.5 w-3.5" />,
      appliesTo: (slug) => pidsBySlug.get(slug)?.length ?? 0,
      run: stopOneRepo,
    },
    {
      id: "update",
      label: t("wall.batch.update"),
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      // One `git pull` subprocess per repository, so three at a time — see
      // `BatchAction.concurrency` and `lib/bounded-map.ts`.
      concurrency: 3,
      // THE same per-slug function the card menu calls. No second invoke, no
      // second wording, no second failure classifier: a batch that described
      // "已快进 a1b2c3d → e4f5g6h" differently from the single action would be the
      // first place this app contradicted itself about a repository's state.
      run: updateOneRepoForBatch,
      // NO confirmation dialog, and the reason is in the Rust, not in taste.
      // `run_pull` (`downloader.rs:1953-1968`) is literally
      // `git -C <repo> pull --ff-only` with `GIT_TERMINAL_PROMPT=0`, and
      // `is_transient_pull` (`:1712-1729`) matches *only* connection-shaped
      // phrases. So a dirty working tree or a diverged branch is not retried and
      // not worked around: git exits non-zero, the layer gives up at once, and the
      // command returns `Err` carrying git's own sentence. A fast-forward cannot
      // move a repository backwards and cannot overwrite local edits — it refuses
      // instead. Nothing here is irreversible, so there is nothing to confirm;
      // 批量删除 asks because a recycle bin does not un-decide for you.
      //
      // What the backend CAN still surprise a user with is the *report*: each
      // refusal arrives under `AllLayersFailed`'s download-shaped header, so
      // `updateFailureLine` folds it to one readable cause plus the next step and
      // the result list names every repository that refused. That list is the
      // affordance; a modal in front of it would only be an extra click.
    },
    {
      id: "cache",
      label: t("wall.batch.cache"),
      icon: <Broom className="h-3.5 w-3.5" />,
      run: clearOneRepoCache,
    },
    {
      // 需求 N3-3. The verb writes the tags the chip row already has lit, so it adds
      // no second selection state and needs no input box: the click that narrowed
      // the wall to what is filed under 后端 is the same click that says what to
      // file the selection under. Nothing active is not "apply nothing to
      // everything" - `appliesTo` returns 0 for every card, which is how BatchBar
      // disables the button and prints the reason on its face.
      id: "tag-add",
      label: activeTags.length ? t("wall.batch.tagAddLit", { tags: activeTags.join("」「") }) : t("wall.batch.tagAddIdle"),
      icon: <Tags className="h-3.5 w-3.5" />,
      appliesTo: (slug) => tagWorkFor(tagsNow(slug), activeTags),
      run: tagAddOne,
    },
    {
      id: "tag-remove",
      label: activeTags.length ? t("wall.batch.tagRemoveLit", { tags: activeTags.join("」「") }) : t("wall.batch.tagRemoveIdle"),
      icon: <X className="h-3.5 w-3.5" />,
      appliesTo: (slug) => tagRemovalWorkFor(tagsNow(slug), activeTags),
      run: tagRemoveOne,
    },
    {
      id: "trash",
      label: t("wall.batch.trash"),
      danger: true,
      icon: <Trash2 className="h-3.5 w-3.5" />,
      // One confirmation naming every repository that is about to be touched.
      // 彻底删除 is not on offer in a batch: §3.1 gates it behind typing that
      // repository's own slug, and a mode that acted on twelve repositories could
      // only either drop the gate or ask twelve times - so the reversible verb is
      // the batch one, and the irreversible one stays per-project in the launch panel.
      confirm: (names) =>
        confirmDestructive(t("wall.batch.trashConfirm", { n: names.length, names: names.join("\n") }), {
          title: t("wall.batch.trashTitle"),
          okLabel: t("wall.batch.trashOk", { n: names.length }),
        }),
      run: trashOneRepo,
    },
  ];

  const onBatchDone = (actionId: string, okSlugs: string[]) => {
    if (!okSlugs.length) return;
    if (actionId === "trash") {
      // A card that went to the recycle bin leaves the selection, or 已选 would go on
      // counting projects that are no longer on the wall.
      const gone = new Set(okSlugs);
      useSelection.getState().prune(new Set(cards.map((c) => c.slug).filter((s) => !gone.has(s))));
      onWallChanged();
      return;
    }
    // The other two verbs that change what is on *disk* — HEAD moved for
    // 批量更新, bytes freed for 批量清缓存. Both feed facts the wall renders and
    // sorts on (`store/meta`'s size / installedAt / hasCache, `ProjectsView`'s
    // 按大小 / 按缓存 tiers), so leaving them unre-read is how a card keeps
    // advertising a cache it no longer has, or an update that already landed.
    // 批量停止 is deliberately absent: nothing on disk moved. Nor are the two 标签
    // verbs — a tag is a localStorage fact about this wall and writes nothing to the
    // clone, so re-reading the repository would cost a disk walk to learn a number
    // that cannot have changed.
    if (actionId === "update" || actionId === "cache") {
      onWallChanged();
    }
    // Same rule as the single-card path, for every repository that moved.
    if (actionId === "update") forgetFreshness(okSlugs);
  };

  const batchItems = selSlugs.map((slug) => ({ slug, name: nameOf(slug) }));

  // --- 项目墙的动效 -------------------------------------------------------
  // auto-animate owns card add / remove / reorder: a filter change used to snap
  // the whole wall into a new arrangement, which is the single most visible
  // "no motion" in the app. It is disabled while a drag is live, because dnd-kit
  // writes `transform` on the very same elements and two engines writing one
  // transform shows up as a card sitting in two places for a frame.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const walls = useAutoLayers();

  // r20-O1-1: the wall mounts one window of cards instead of all of them. `sorted`
  // is the full matched set, so the cap is taken from it even in 分组 mode, where
  // the budget is shared across the owner sections rather than per section.
  const wallWindow = useWallWindow(sorted.length, dragging);

  useEntranceGate(rootRef);

  // 需求 3: the wall's filter / sort / grouping are part of *where the user was*,
  // so 后退 from 添加 must land on "运行中 + 最近使用", not on the defaults. The
  // bridge is registered once and reads a ref, so navigating does not re-register it.
  const ctxRef = useRef({ sort, filter, grouped, density });
  ctxRef.current = { sort, filter, grouped, density };
  useEffect(
    () =>
      registerViewContext("projects", {
        get: () => ({ ...ctxRef.current }),
        apply: (ctx) => {
          // Validate against the known values first, then apply only what
          // passed — no `as never`, and a junk `ui.*` context can't write a bad
          // sort/filter/density into the store.
          const patch = coerceWallPref(ctx);
          if (patch.sort !== undefined) setPref("sort", patch.sort);
          if (patch.filter !== undefined) setPref("filter", patch.filter);
          if (patch.grouped !== undefined) setPref("grouped", patch.grouped);
          if (patch.density !== undefined) setPref("density", patch.density);
        },
      }),
    [setPref],
  );

  useEffect(() => {
    walls.setEnabled(!dragging);
  }, [dragging, walls]);

  const sensors = useSensors(
    // 6 px, not "immediately": a card is also a button, and a press that wobbles is
    // meant to be a click. Below this distance the pointer never becomes a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (_e: DragStartEvent) => setDragging(true);

  /**
   * Stable so `RepoTile` can be memoized. The old inline lambda handed every tile
   * a fresh function identity on each render, which made `memo` inert — the tile
   * re-rendered even when nothing about *it* had changed. Its only dependencies
   * are the two `useState` setters, which React guarantees to keep stable, so the
   * dependency list is empty and the callback never changes.
   */
  const handleContextMenu = useCallback((slug: string, x: number, y: number) => {
    setMenu({ slug, x, y });
    setMenuOpen(true);
  }, []);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(false);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Written against the order *without* the running tier. The rendered list
    // floats running cards to the front, so indexing that sequence would persist a
    // slot that only exists while the process lives - and the card would stay at
    // the front after it stopped, instead of 回到原位.
    const ids = applyOverlay(tierSorted, states).map((c) => c.slug);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    // The moved block is only the rows the current search/filter shows, but the
    // numbering it writes is for the whole wall: moved block first, then every
    // other card in the order it already has — the same overlay over the same
    // tier order, taken across `cards` instead of the filtered `matched`, so a
    // never-dragged off-filter card keeps tier order and an already-dragged one
    // keeps its position among its peers. Stamping `ids` alone left the
    // off-filter cards holding the *previous* drag's numbering, so clearing the
    // filter interleaved two schemes and the cards jumped — the manual order was
    // damaged by a drag those cards never took part in (wall.ts's applyOrder
    // contract).
    const moved = arrayMove(ids, from, to);
    const movedSet = new Set(moved);
    const rest = applyOverlay(tierSort(cards), states)
      .map((c) => c.slug)
      .filter((slug) => !movedSet.has(slug));
    applyOrder([...moved, ...rest]);
  };

  const removeRepo = async (card: Card, permanent: boolean) => {
    const name = states[card.slug]?.alias ?? `${card.owner}/${card.repo}`;
    // Round 11 (需求 8.3): what git says about the working tree, asked *before*
    // the irreversible answer. Two local git calls, fetched here rather than on
    // mount because the status only matters at the moment of deletion - and a
    // failed probe must never block the delete itself.
    //
    // Round 12 (让失败可见 8.3): "never block" was implemented as a bare
    // `catch {}`, which made "问不到 git" render the same confirmation as
    // "工作树干净". The probe now carries its failure into the wording; the three
    // states and their copy live in `lib/worktree-warning.ts`, where they have a
    // test instead of a comment.
    let probe: WorktreeProbe;
    try {
      probe = {
        ok: true,
        status: await invoke<WorktreeStatus>("repo_worktree_status", { slug: card.slug }),
      };
    } catch (err) {
      probe = { ok: false, reason: err };
    }
    const statusLine = worktreeWarningLine(probe, permanent);
    const ok = await confirmDestructive(
      permanent
        ? t("wall.del.permanentConfirm", { name, status: statusLine })
        : t("wall.del.trashConfirm", { name, status: statusLine }),
      {
        title: permanent ? t("wall.del.permanentTitle") : t("wall.del.trashTitle"),
        okLabel: permanent ? t("wall.del.okPermanent") : t("wall.del.okTrash"),
      },
    );
    if (!ok) return;
    setBusy({ slug: card.slug, note: t("wall.del.busy") });
    try {
      const r = await invoke<{ removedRepo: boolean; freedBytes: number; failed: string[] }>(
        permanent ? "delete_repo" : "trash_repo",
        { slug: card.slug },
      );
      const verb = permanent ? t("wall.del.done") : t("wall.del.doneTrash");
      const mb = (r.freedBytes / 1024 / 1024).toFixed(1);
      if (r.failed.length) toast.error(t("wall.del.someFailed", { verb, items: r.failed.join("；") }));
      else if (r.removedRepo) toast.success(t("wall.del.released", { verb, mb }));
      else toast.error(t("wall.del.stuck", { verb }));
      onWallChanged();
    } catch (err) {
      reportError(err, t("wall.del.fail"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 需求 8.1's wall half: 更新 one repository, `git pull --ff-only`.
   *
   * The command already existed and the launch panel already called it; the wall
   * never did, even though `lib.rs:1204` says "The wall's 更新 action and the
   * launch dialog's button both land here". This is that action — and it is also
   * the *only* place the invoke is written, because 批量更新 below hands the same
   * function to `BatchBar` per selected card. Two copies of an invoke is how the
   * batch version stops refreshing the wall, or starts wordling the failure
   * differently from the single one.
   *
   * Success goes to `toast`, the surfacing this file already uses for one-shot
   * outcomes, and then to `onWallChanged()`: HEAD moved, so the size, the cache
   * footprint and the marker the wall reads are all stale (`App.tsx:161-166`
   * re-reads `list_repositories` and the metadata store behind that callback).
   *
   * Failure deliberately does *not* go to `toast`: a refusal the user has to act
   * on (工作树未提交、分支分叉、没有 git 历史) is useless in a six-second toast with
   * no button, so it lands in the strip under the toolbar with its reason and,
   * where retrying can change the answer, 重试.
   *
   * `repo_freshness` caches per slug for five minutes (`lib.rs:1301`, written by
   * `freshness_store` at `lib.rs:1342`). The backend now evicts the slug it just
   * changed: `update_repo` drops the entry on a successful pull (`lib.rs:1259`), so
   * the launch panel's 检查新鲜度 re-reads the moved HEAD instead of answering
   * "与远程不一致" about a repository that was just fast-forwarded. The frontend
   * still drops its own panel row below, because the verdict it printed was about
   * the pre-pull HEAD.
   */
  const runUpdate = async (card: Card) => {
    setBusy({ slug: card.slug, note: t("wall.upd.busy") });
    setUpdateFailure(null);
    try {
      const res = await updateOneRepo(card.slug, updateInvoker);
      if (res.ok) {
        toast.success(res.detail);
        onWallChanged();
        // HEAD moved, so the verdict the 检查更新 panel printed for this repository
        // describes a commit that is no longer checked out. The backend evicted its
        // own cache entry for the slug (`update_repo`, `lib.rs:1259`); the panel row
        // is the frontend's half of the same cleanup.
        forgetFreshness([card.slug]);
      } else {
        setUpdateFailure({
          slug: card.slug,
          detail: res.detail,
          remedy: res.remedy,
          retryable: res.retryable,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  /** Same verb, same function, entered from the failure strip instead of the menu. */
  const retryUpdate = () => {
    const slug = updateFailure?.slug;
    setUpdateFailure(null);
    if (!slug) return;
    const card = cardBySlug.get(slug);
    // The card can have been deleted or hidden while the banner sat there. Then
    // there is nothing to retry and the banner was the only mention — drop it.
    if (!card) return;
    void runUpdate(card);
  };

  /**
   * 需求 8.2 on the wall, honestly: one explicit 检查更新 over the
   * **visible/filtered** set, never a per-tile badge.
   *
   * The badge was the natural design and it was rejected on the backend's own
   * numbers. `repo_freshness` is one `git ls-remote` subprocess plus one TLS
   * session per call (`downloader.rs:2023`), and the five-minute cache
   * (`lib.rs:1301`, read by `freshness_cached` at `lib.rs:1330`) is only populated
   * *after* a completed call (`lib.rs:1342`). So on a cold start a badge per tile
   * means N network round trips before anything is painted — and the honest
   * alternative, painting nothing until the answers arrive, means the wall shows
   * no signal at all the first time you look, which is the same "left out instead
   * of guessed" trade this file's header already makes for 有启动命令.
   *
   * What survives here is the part that can be defended: the user asks once, at
   * most `FRESHNESS_CAP` repositories are touched, at most `FRESHNESS_WIDTH`
   * `git ls-remote` processes run at once, the answer set is capped explicitly
   * (`uncheckedNote` says what was *not* checked), and every row keeps its own age
   * — `checkedAt` is the only thing that makes "与远程一致" a claim about now.
   *
   * The default path answers the whole filtered set in ONE IPC now
   * (`repo_freshness_many`): cached hits come back immediately, fresh misses run
   * with bounded concurrency, and a slug the backend did not reach comes back with
   * `freshness: null` — an honest 「本轮没有答案」 row (`notReachedVerdict`), never a
   * fabricated 「无新提交」. 重新检查 still goes per slug, because the batch answers
   * cache hits by design and takes no `force` argument; it re-asks the remote for
   * the ≤CAP slugs the user explicitly chose.
   */
  const runFreshnessScan = (force: boolean) => {
    if (scanning) return;
    const list = sorted.map((c) => c.slug);
    if (!list.length) return;
    const plan = planFreshnessScan(list);
    if (!plan.willCheck.length) return;
    scanAbort.current = false;
    setScanning(true);
    setScan({ order: plan.willCheck, rows: {}, skipped: plan.skipped.length, force });

    // Fold answers into the panel, one row per slug, leaving any already-written
    // row alone. `answer` is a verdict without its display name; the name is
    // resolved from the slug here so callers do not each repeat it.
    const writeAnswers = (answers: Record<string, ScanAnswer>) => {
      if (scanAbort.current) return;
      setScan((prev) => {
        if (!prev) return prev;
        const rows = { ...prev.rows };
        for (const [slug, a] of Object.entries(answers)) {
          if (rows[slug]) continue;
          rows[slug] = { name: nameOf(slug), ...a };
        }
        return { ...prev, rows };
      });
    };

    if (force) {
      // 重新检查 bypasses the five-minute cache, and `repo_freshness_many` answers
      // cache hits by design (it takes no `force` argument). So a forced re-read
      // stays per slug — bounded by the same width, over the ≤CAP slugs the user
      // explicitly asked for, which is not the per-wall-load storm the batch
      // exists to remove.
      void mapBounded(plan.willCheck, FRESHNESS_WIDTH, async (slug) => {
        if (scanAbort.current) return;
        let answer: ScanAnswer;
        try {
          const f = await invoke<Freshness>("repo_freshness", { slug, force: true });
          const v = freshnessVerdict(f);
          answer = { tone: v.tone, text: v.text, detail: v.detail, checkedAt: f.checkedAt };
        } catch (err) {
          // The command itself failing (no such directory on disk, task panic) is
          // a per-row answer, not a dead scan: one broken card must not erase the
          // other twenty-nine verdicts the user is waiting for.
          const v = errorVerdict(messageOf(err));
          answer = { tone: v.tone, text: v.text, detail: v.detail, checkedAt: Date.now() };
        }
        writeAnswers({ [slug]: answer });
      }).then(() => {
        if (!scanAbort.current) setScanning(false);
      });
      return;
    }

    // One IPC for the whole filtered set. A `freshness: null` row is a slug the
    // backend did not reach; `notReachedVerdict` renders it as 「本轮没有答案」 and
    // never as 无新提交 — showing "no new commits" for a slug nobody checked is
    // exactly the lie this panel exists to refuse.
    void invoke<FreshnessManyRow[]>("repo_freshness_many", {
      slugs: plan.willCheck,
      maxParallel: FRESHNESS_WIDTH,
    })
      .then((many) => {
        if (scanAbort.current) return;
        const bySlug = new Map(many.map((r): [string, Freshness | null] => [r.slug, r.freshness]));
        const answers: Record<string, ScanAnswer> = {};
        for (const slug of plan.willCheck) {
          const f = bySlug.get(slug) ?? null;
          const v = f ? freshnessVerdict(f) : notReachedVerdict();
          answers[slug] = {
            tone: v.tone,
            text: v.text,
            detail: v.detail,
            checkedAt: f ? f.checkedAt : Date.now(),
          };
        }
        writeAnswers(answers);
      })
      .catch((err) => {
        // The batch failing wholesale (a task panic, an IPC error) is still one
        // row per slug: every requested slug reads 无法确认 with the reason, never
        // a silent pass and never a fabricated 「与远程一致」.
        if (scanAbort.current) return;
        const v = errorVerdict(messageOf(err));
        const answers: Record<string, ScanAnswer> = {};
        for (const slug of plan.willCheck) {
          answers[slug] = { tone: v.tone, text: v.text, detail: v.detail, checkedAt: Date.now() };
        }
        writeAnswers(answers);
      })
      .finally(() => {
        if (!scanAbort.current) setScanning(false);
      });
  };

  /** A pull moved HEAD, so any earlier verdict about that repository is about the *old* one. */
  const forgetFreshness = (slugs: string[]) => {
    if (!slugs.length) return;
    setScan((prev) => {
      if (!prev) return prev;
      const gone = new Set(slugs);
      if (!slugs.some((s) => prev.rows[s])) return prev;
      const rows: NonNullable<typeof prev.rows> = {};
      for (const [slug, row] of Object.entries(prev.rows)) if (!gone.has(slug)) rows[slug] = row;
      return { ...prev, rows };
    });
  };

  const closeScan = () => {
    scanAbort.current = true;
    setScanning(false);
    setScan(null);
  };

  if (repos.length === 0) {
    // Before the first disk scan resolves, an empty wall is "still loading",
    // not "you have nothing" — showing the CTA here reads as data loss on
    // every cold start.
    if (!reposLoaded) {
      return (
        <>
          <ViewHeader title={t("wall.view.title")} count={0} hint={t("wall.view.loadingHint")} headerId="projects-header" />
          <div className="repo-grid" aria-busy="true" aria-label={t("wall.view.loadingAria")}>
            {Array.from({ length: 8 }, (_, i) => (
              <div
                key={i}
                className="aspect-[4/3] animate-pulse rounded-xl border border-border-weak bg-muted/40"
              />
            ))}
          </div>
        </>
      );
    }
    return (
      <EmptyWall
        onDownload={onDownload}
        busy={downloadBusy}
        disabledReason={downloadDisabledReason}
      />
    );
  }

  const gridMin = WALL_DENSITY_MIN[density] ?? WALL_DENSITY_MIN.standard;

  /**
   * Arrow-key movement across the wall. Only plain arrows are claimed:
   * Ctrl/Alt/Meta/Shift and an active drag stay with their owners (dnd-kit owns
   * Space/Enter as its activator; our handler is on the grid and lets other keys
   * bubble). Focus is moved to the target card, not merely scrolled to it, so
   * Enter/Space and the context menu keep working on whatever is "current".
   */
  const onWallKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (dragging || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!isWallNavKey(e.key)) return;
    const target = e.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>("[data-wall-card]");
    if (!card || !e.currentTarget.contains(card)) return;
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-wall-card]"));
    const at = cards.indexOf(card);
    if (at < 0) return;
    const next = nextCardIndex(
      cards.map((c) => c.getBoundingClientRect()),
      at,
      e.key,
    );
    if (next < 0 || next === at) return;
    e.preventDefault();
    cards[next]?.focus();
  };

  const wall = (list: Card[]) => (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragCancel={() => setDragging(false)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={list.map((c) => c.slug)} strategy={rectSortingStrategy}>
        <div
          ref={walls.register}
          {...reg("projects-repo-grid")}
          onKeyDown={onWallKeyDown}
          className="repo-grid motion-stagger"
          style={gridMin ? ({ "--skin-grid-min": gridMin } as React.CSSProperties) : undefined}
        >
          {list.map((c) => (
            <RepoTile
              key={c.slug}
              repo={c}
              slug={c.slug}
              onOpen={setOpenSlug}
              onContextMenu={handleContextMenu}
              ownerCount={ownerCounts.get(c.owner) ?? 1}
              alias={states[c.slug]?.alias}
              coverOverride={states[c.slug]?.cover}
              coverFit={states[c.slug]?.coverFit}
              coverFocus={states[c.slug]?.coverFocus}
              coverRatio={states[c.slug]?.coverRatio}
              coverLook={states[c.slug]?.coverLook}
              pinned={states[c.slug]?.pinned}
              tags={states[c.slug]?.tags}
              note={states[c.slug]?.note}
              running={runningBySlug.get(c.slug)}
              sortable={!grouped}
              meta={metaBySlug[c.slug]}
              heat={heatByOwnerRepo[`${c.owner}/${c.repo}`]}
              selectMode={selMode}
              selected={selectedSet.has(c.slug)}
              onSelect={onSelectTile}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );

  const menuCard = menu ? cards.find((c) => c.slug === menu.slug) : undefined;
  // Resolved here rather than at the JSX so a card that left the wall mid-sheet
  // (批量删除, 移除) closes the editor on its own instead of handing `undefined`
  // to a dialog that would then have no slug to write back to.
  const tagsCard = tagsSlug ? cards.find((c) => c.slug === tagsSlug) : undefined;
  // Whether the repository named by the failure banner is being worked on right
  // now — by a single-card verb or by a 批量更新 that includes it. Read once, so
  // the 重试 button and its label cannot disagree about what is running.
  const failureBusyNote = updateFailure ? busyNoteFor(updateFailure.slug) : null;
  /** The friendly name of the active single-select filter, for the empty rows. */
  const filterLabel = t(`wall.filter.${filter}` as TranslationKey);

  return (
    <div ref={rootRef} data-entered="false">
      <ViewHeader
        title={t("wall.view.title")}
        count={repos.length}
        hint={t("wall.view.hint")}
        headerId="projects-header"
      />

      {wallRecoveredAt !== null && (
        <div
          role="status"
          className="mb-3 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-muted-foreground"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-warning">{t("wall.recovered.title")}</p>
            <p className="mt-0.5 leading-relaxed">
              {t("wall.recovered.body", {
                time: new Date(wallRecoveredAt).toLocaleString(),
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={dismissWallRecovery}
            className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("wall.recovered.dismiss")}
          </button>
        </div>
      )}

      <div
        {...reg("projects-toolbar")}
        className="skin-panel mb-3 border border-border-weak bg-card p-2"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="relative min-w-0">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("wall.search.placeholder")}
              aria-label={t("wall.search.aria")}
              spellCheck={false}
              className="h-[1.85rem] w-full skin-ctl border border-input bg-background pl-7 pr-8 text-caption
                         outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            {/* Always mounted: an ✕ that appeared only when there was text would
                change the row's content width, which is the shift this toolbar
                exists to avoid. Disabled + transparent keeps its box and drops the
                click. */}
            <button
              type="button"
              onClick={() => setQuery("")}
              disabled={!query}
              aria-label={t("wall.search.clearAria")}
              className={cn(
                "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-opacity",
                "hover:text-foreground",
                !query && "pointer-events-none opacity-0",
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Fixed-width readout: `显示 3 / 128` and `显示 128 / 128` must occupy
                the same box or the sort control beside it slides. */}
            <span className="w-[8rem] text-right text-body tabular-nums text-muted-foreground">
              {t("wall.showNofM", { got: sorted.length, total: visible.length })}
            </span>
            <MenuSelect<SortId>
              value={sort}
              options={SORTS.map((s) => ({ id: s.id, label: t(`wall.sort.${s.id}` as TranslationKey), note: undefined}))}
              onChange={(v) => {
                // 需求 1: "排序功能无法使用" - and this was the mechanism. One
                // drag writes an index onto *every* visible card, so from then
                // on the overlay restored the dragged sequence no matter which
                // tier was picked and the control read as dead. A chosen tier
                // is an explicit ordering decision, so it now wins: the manual
                // order is dropped, 置顶 stays (a per-item state, not a mode),
                // and the running float stays (transient).
                if (v !== sort) resetOrder();
                setPref("sort", v);
              }}
              ariaLabel={t("wall.sort.aria")}
              prefix={t("wall.sort.prefix")}
            />
          </div>

          <div className="col-span-2 flex flex-wrap items-center gap-2">
            <MenuSelect
              value={langFilter}
              options={languageOptions}
              onChange={setLangFilter}
              ariaLabel={t("wall.facet.language")}
              prefix={t("wall.facet.language")}
            />
            <MenuSelect
              value={catFilter}
              options={categoryOptions}
              onChange={setCatFilter}
              ariaLabel={t("wall.facet.category")}
              prefix={t("wall.facet.category")}
            />
            <MenuSelect
              value={activeView?.id ?? "__current"}
              options={[
                { id: "__current", label: t("wall.views.current"), note: undefined },
                ...wallViews.map((v) => ({ id: v.id, label: v.name, note: undefined })),
              ]}
              onChange={(id) => {
                if (id !== "__current") useWallViews.getState().requestApply(id);
              }}
              ariaLabel={t("wall.views.aria")}
              prefix={t("wall.views.label")}
            />
            <button
              type="button"
              onClick={() => setViewDialog({ mode: "save" })}
              disabled={!hasViewCriteria(currentCriteria)}
              aria-label={t("wall.views.saveAria")}
              title={
                hasViewCriteria(currentCriteria) ? t("wall.views.saveHint") : t("wall.views.nothingToSave")
              }
              className="skin-ctl border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
            </button>
            {activeView && (
              <>
                <button
                  type="button"
                  onClick={() => setViewDialog({ mode: "rename", id: activeView.id, name: activeView.name })}
                  aria-label={t("wall.views.renameAria")}
                  title={t("wall.views.rename")}
                  className="skin-ctl border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void deleteActiveView()}
                  aria-label={t("wall.views.deleteAria")}
                  title={t("wall.views.delete")}
                  className="skin-ctl border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <Segmented<FilterId>
              value={filter}
              ariaLabel={t("wall.filterSeg.aria")}
              options={FILTERS.map((f) => ({
                id: f.id,
                // The count rides inside the label so the thumb measures the text it
                // is highlighting; a separate badge would change the width without
                // ever moving the thumb.
                label: `${t(`wall.filter.${f.id}` as TranslationKey)} ${
                  f.id === "all"
                    ? counts.all
                    : f.id === "opened"
                      ? counts.opened
                      : f.id === "unopened"
                        ? counts.unopened
                        : counts.running
                }`,
              }))}
              onChange={(v) => setPref("filter", v)}
            />

            {/* A divider, not a gap: 分组 and 密度 are display modes while the chips
                are a single-select filter. Blending them silently is how a filter row
                stops being readable. */}
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />

            <button
              type="button"
              onClick={() => setPref("grouped", !grouped)}
              aria-pressed={grouped}
              title={
                grouped
                  ? t("wall.group.titleOn")
                  : t("wall.group.titleOff")
              }
              className={cn(
                "skin-ctl border px-2.5 py-1 text-caption",
                grouped
                  ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                  : "border-border-weak bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
              )}
            >
              {t("wall.group.button")}
            </button>

            {/* 需求 9.1: the wall's verbs were all single-target. The label is fixed
                ("多选", never "多选 3") because a chip whose text grows with selection
                is exactly the width change this toolbar was rebuilt to avoid; the
                count lives in the bar instead. */}
            <button
              type="button"
              onClick={() => {
                const s = useSelection.getState();
                if (s.mode) s.exit();
                else s.enter();
              }}
              aria-pressed={selMode}
              aria-label={t("wall.selmulti.aria")}
              title={
                selMode
                  ? t("wall.selmulti.titleOn")
                  : t("wall.selmulti.titleOff")
              }
              className={cn(
                "skin-ctl flex items-center gap-1 border px-2.5 py-1 text-caption",
                selMode
                  ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                  : "border-border-weak bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
              )}
            >
              <SquareCheckBig className="h-3 w-3" />
              {t("wall.selmulti.button")}
            </button>

            {/* 需求 8.2's honest form on the wall. Deliberately not a per-tile badge:
                see `runFreshnessScan` for what one call costs and what the
                five-minute cache does *not* guarantee. The label never changes —
                the progress lives in the panel below — because this toolbar exists
                to stop controls sliding when their text changes. */}
            <button
              type="button"
              onClick={() => runFreshnessScan(false)}
              disabled={scanning || sorted.length === 0}
              title={t("wall.fresh.headTitle", { n: FRESHNESS_CAP })}
              aria-label={t("wall.fresh.headAria")}
              className={cn(
                "skin-ctl flex items-center gap-1 border px-2.5 py-1 text-caption",
                "border-border-weak bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              {scanning ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {t("wall.fresh.title")}
              {!scanning && sorted.length === 0 && (
                <span className="text-muted-foreground">{t("wall.fresh.nothing")}</span>
              )}
            </button>

            <MenuSelect
              value={density}
              options={WALL_DENSITIES.map((d) => ({
                id: d.id,
                label: t(`wall.density.${d.id}` as TranslationKey),
                note: t(`wall.density.${d.id}Note` as TranslationKey),
              }))}
              onChange={(v) => setPref("density", v)}
              ariaLabel={t("wall.density.aria")}
              prefix={t("wall.density.prefix")}
              width="w-[7.5rem]"
            />

            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  useUI.getState().go("settings");
                  useUI.getState().setSettingsSection("projects");
                }}
                title={t("wall.fresh.hiddenTitle")}
                className="flex items-center gap-1 rounded px-1 text-caption text-muted-foreground transition-colors hover:text-foreground"
              >
                <Eye className="h-3 w-3" />
                {t("wall.fresh.hidden", { n: hiddenCount })}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 标签筛选（需求 N3-2）. Its own row rather than more buttons in the row
          above: that one is single-select 筛选 plus display modes, and a second
          vocabulary of multi-select chips squeezed in beside it is how a toolbar
          stops being readable. Same chip anatomy as 按拥有者分组 - `aria-pressed`,
          the same border/primary-active classes - so 已选中的样子 is one language
          across the page. Only mounted once the wall has a tag, because an empty
          chip row is a strip of chrome that does nothing. */}
      {(tagChips.length > 0 || activeTags.length > 0) && (
        <div
          {...reg("projects-tag-chips")}
          className="mb-2 flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("wall.tagChips.groupAria")}
        >
          <span className="skin-label text-caption text-muted-foreground">{t("wall.tagChips.label")}</span>
          {tagChips.map(({ tag, count }) => {
            const on = hasRepoTag(activeTags, tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  // `hasRepoTag`, so a chip toggles off on the same case-folded rule
                  // that made it a single chip in the first place - a hand-written
                  // `.includes(tag)` would let `Rust` and `rust` both go active and
                  // the row would filter to nothing.
                  setTagFilter((prev) =>
                    hasRepoTag(prev, tag) ? prev.filter((t) => !hasRepoTag([t], tag)) : [...prev, tag],
                  )
                }
                aria-pressed={on}
                title={on ? t("wall.tagChips.offTitle", { tag }) : t("wall.tagChips.onTitle", { tag })}
                className={cn(
                  "skin-ctl border px-2 py-0.5 text-caption",
                  on
                    ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                    : "border-border-weak bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
                )}
              >
                {tag}
                {/* Fixed-width count, the same reason the 显示 N / M readout is a
                    `w-[8rem]` box: a chip whose text widens on click slides the
                    chips after it. */}
                <span className="ml-1 tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
          {activeTags.length > 0 && (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              aria-label={t("wall.tagChips.clearAria")}
              className="skin-ctl flex items-center gap-1 border border-border-weak px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
              {t("wall.tagChips.clear")}
            </button>
          )}
        </div>
      )}

      {grouped && (
        <p className="app-desc -mt-1 mb-2 px-0.5 text-caption text-muted-foreground">
          {t("wall.groupNote")}
        </p>
      )}

      {/* 更新 refused, and stayed. `toast` would have retired it in six seconds
          with no way to act on it; the reason plus the next step plus 重试 (when
          retrying can change the answer) live here instead. Same shape as the
          launch panel's failure banner, which is the pattern this app agreed on. */}
      {updateFailure && (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-2 text-caption leading-snug text-danger"
        >
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">
              {t("wall.failure.title", { name: nameOf(updateFailure.slug), detail: updateFailure.detail })}
            </span>
            {updateFailure.remedy && (
              <span className="app-desc block text-muted-foreground">{updateFailure.remedy}</span>
            )}
          </span>
          {updateFailure.retryable && (
            <button
              type="button"
              onClick={retryUpdate}
              disabled={!!failureBusyNote}
              className="skin-ctl shrink-0 border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-40"
            >
              {failureBusyNote ? t("wall.failure.busyNote", { note: failureBusyNote }) : t("wall.failure.retry")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setUpdateFailure(null)}
            aria-label={t("wall.failure.closeAria")}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 检查更新 result. One row per repository, in the order the wall shows them,
          each labelled with the age of its own answer: `checkedAt` is what makes
          "与远程一致" a claim about *now* rather than about five minutes ago. */}
      {scan && (
        <div
          data-layer="panel"
          className="skin-panel mb-2 border border-border-weak bg-card p-2"
          role="region"
          aria-label={t("wall.scan.panelAria")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium">
              {scanning
                ? t("wall.scan.progress", { done: Object.keys(scan.rows).length, total: scan.order.length })
                : t("wall.scan.summary", { summary: scanSummaryLine(summarizeScan(Object.values(scan.rows).map((r) => ({ tone: r.tone })))) })}
            </span>
            {!scan.force && !scanning && (
              <span className="text-caption text-muted-foreground">
                {t("wall.scan.cacheNote")}
              </span>
            )}
            <button
              type="button"
              onClick={() => runFreshnessScan(true)}
              disabled={scanning}
              title={t("wall.scan.forceTitle")}
              className="skin-ctl ml-auto shrink-0 border border-border-weak px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              {t("wall.scan.force")}
            </button>
            <button
              type="button"
              onClick={closeScan}
              aria-label={t("wall.scan.closeAria")}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {uncheckedNote(scan.skipped) && (
            <p className="app-desc mt-1 text-caption leading-snug text-warning">{uncheckedNote(scan.skipped)}</p>
          )}

          <ul className="mt-1 max-h-[26vh] space-y-0.5 overflow-y-auto" role="log" aria-live="polite">
            {scan.order.map((slug) => {
              const r = scan.rows[slug];
              return (
                <li key={slug} className="flex items-start gap-2 px-1 text-caption">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      !r
                        ? "bg-border"
                        : r.tone === "same"
                          ? "bg-success"
                          : r.tone === "diff"
                            ? "bg-warning"
                            : "bg-muted-foreground/50",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="truncate font-medium">{r?.name ?? nameOf(slug)}</span>
                    <span className="app-desc text-muted-foreground">
                      {!r ? t("wall.scan.rowPending") : ` ${r.text} · ${fmtRelative(r.checkedAt)}`}
                    </span>
                    {r && (
                      <span className="app-desc block break-words text-muted-foreground">{r.detail}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>

          {!scanning && (
            <p className="app-desc mt-1 px-1 text-caption leading-snug text-muted-foreground">
              {t("wall.scan.noteTitle")}
            </p>
          )}
        </div>
      )}

      {/* Nothing matched — deliberately not the big empty state above, which means
          "you have no projects at all" and would be a lie here. */}
      {sorted.length === 0 ? (
        <div className="skin-panel border border-border-weak bg-card px-3 py-6 text-center">
          <p className="text-body font-medium">{t("wall.rows.head")}</p>
          <p className="app-desc mt-1 text-caption text-muted-foreground">
            {q ? (
              <>
                {t("wall.rows.qPrefix")} <code>{query.trim()}</code>
                {t("wall.rows.qJoin")}
                {filterLabel}
                {t("wall.rows.fClose")}
              </>
            ) : (
              <>
                {t("wall.rows.fOpen")}
                {filterLabel}
                {t("wall.rows.fClose")}
              </>
            )}
            {/* The chips are a third condition, so they have to be named: "标签
                「前端」" is the only explanation for an empty wall when 全部 is
                selected and the search box is empty, and without it the page reads
                as broken rather than as filtered. */}
            {activeTags.length > 0 && (
              <>{t("wall.rows.tags", { tags: activeTags.map((t2) => `「${t2}」`).join("") })}</>
            )}
            {t("wall.rows.miss", { total: visible.length })}
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setPref("filter", "all");
              setTagFilter([]);
              setLangFilter("");
              setCatFilter("");
            }}
            className="skin-ctl mt-3 border border-border px-3 py-1 text-caption text-muted-foreground
                       transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
          >
            {t("wall.rows.reset")}
          </button>
        </div>
      ) : groups ? (
        <div className="space-y-3">
          {windowGroups(groups, wallWindow.shown).map(([owner, list]) => (
            <section key={owner} className="min-w-0">
              {/* Not marked `app-desc`: the owner is the content the grouping is
                  organised by, so 隐藏描述性文字 must not delete the only label
                  that says which segment is whose. */}
              <h2 className="skin-label mb-1 flex items-baseline gap-1.5 px-0.5 text-caption text-muted-foreground">
                {owner}
                <span className="tabular-nums opacity-70">{list.length}</span>
              </h2>
              {wall(list)}
            </section>
          ))}
        </div>
      ) : (
        wall(sorted.slice(0, wallWindow.shown))
      )}

      {/* r20-O1-1 window sentinel. One element, outside both wall branches, so the
          grouped and flat cases grow on the same budget. `aria-hidden` because it is
          a measurement target, not content — a screen reader announcing an empty div
          would be a new thing to explain. */}
      <div ref={wallWindow.sentinelRef} aria-hidden="true" className="h-px" />

      <BatchBar
        active={selMode}
        items={batchItems}
        actions={batchActions}
        onExit={() => useSelection.getState().exit()}
        onSelectAll={() => useSelection.getState().selectAll(order)}
        onClear={() => useSelection.getState().clear()}
        onAfterRun={onBatchDone}
        onSettled={(id, ok, total, skipped) => {
          // Only the network verb is worth a taskbar flash; local stop/clear/
          // tag batches finish in under a second and the user is usually looking.
          // A deliberate 停止后续 is neither success nor failure, so it does not
          // request the failure flash either.
          if (id === "update" && skipped === 0) {
            void requestCompletionAttention(ok === total ? "success" : "failure");
          }
        }}
        onRunningChange={setBatchBusy}
      />

      {menuLayer.render && menu && menuCard && (
        <ContextMenu
          items={buildMenu(t, menuCard, {
            state: states[menuCard.slug] ?? {},
            running: runningBySlug.get(menuCard.slug),
            busy: !!busyNoteFor(menuCard.slug),
            busyNote: busyNoteFor(menuCard.slug),
            t,
            onPanel: () => {
              setOpenSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onUpdate: () => {
              setMenuOpen(false);
              void runUpdate(menuCard);
            },
            onPin: () => {
              togglePin(menuCard.slug);
              setMenuOpen(false);
            },
              onHide: () => {
              toggleHidden(menuCard.slug);
              toast.success(t("wall.failure.removed"));
              setMenuOpen(false);
            },
            onSettings: () => {
              setSettingsSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onReadme: () => {
              setReadmeSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onDiagnose: () => {
              setDiagnoseSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onGrep: () => {
              setGrepSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onFiles: () => {
              setFilesSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onTags: () => {
              setTagsSlug(menuCard.slug);
              setMenuOpen(false);
            },
            onDelete: (permanent) => {
              setMenuOpen(false);
              void removeRepo(menuCard, permanent);
            },
          })}
          x={menu.x}
          y={menu.y}
          closing={menuLayer.state === "closed"}
          onClose={() => setMenuOpen(false)}
          label={t("menu.forNamed", { name: menuCard.repo })}
        />
      )}

      <Suspense fallback={null}>
      {settingsSlug && (
        <ProjectSettingsDialog
          card={cards.find((c) => c.slug === settingsSlug) ?? null}
          state={states[settingsSlug]}
          onClose={() => setSettingsSlug(null)}
          onChanged={onWallChanged}
          // Closes 项目设置 first: two open dialogs would fight over the same
          // Escape / focus trap, and the README is a read of the same card.
          onOpenReadme={() => {
            const slug = settingsSlug;
            setSettingsSlug(null);
            setReadmeSlug(slug);
          }}
        />
      )}

      {readmeSlug && (
        <RepoReadmeDialog
          card={cards.find((c) => c.slug === readmeSlug) ?? null}
          onClose={() => setReadmeSlug(null)}
        />
      )}

      {diagnoseSlug && (
        <RepoDiagnoseDialog
          card={cards.find((c) => c.slug === diagnoseSlug) ?? null}
          running={!!runningBySlug.get(diagnoseSlug)}
          onClose={() => setDiagnoseSlug(null)}
          // 关掉对话框再执行跳转：两层浮层叠加会争同一套 Escape / 焦点。
          onJump={(jump) => {
            setDiagnoseSlug(null);
            if (jump.kind === "panel") setOpenSlug(jump.slug);
            else if (jump.kind === "repoSettings") setSettingsSlug(jump.slug);
            else useUI.getState().go("settings");
          }}
        />
      )}

      {grepSlug && (
        <RepoGrepDialog
          card={cards.find((c) => c.slug === grepSlug) ?? null}
          onClose={() => setGrepSlug(null)}
        />
      )}

      {filesSlug && (
        <RepoFilesDialog
          card={cards.find((c) => c.slug === filesSlug) ?? null}
          onClose={() => setFilesSlug(null)}
        />
      )}

      {tagsCard && (
        <RepoTagsDialog
          card={tagsCard}
          state={states[tagsCard.slug]}
          suggestions={tagChips.map((c) => c.tag)}
          onClose={() => setTagsSlug(null)}
        />
      )}

      {viewDialog && (
        <WallViewDialog
          mode={viewDialog.mode}
          initialName={viewDialog.mode === "rename" ? viewDialog.name : ""}
          onClose={() => setViewDialog(null)}
          onSubmit={(name) => {
            const dialog = viewDialog;
            if (!dialog) return;
            if (dialog.mode === "save") saveCurrentView(name);
            else renameView(dialog.id, name);
          }}
        />
      )}
      </Suspense>
    </div>
  );
}

/**
 * The card's right-click menu.
 *
 * Ordered by how often each verb is wanted, with the two destructive ones below a
 * separator and the reversible one first: 移入回收站 is the delete you would choose
 * by accident-on-purpose, and 永久删除 is the one you have to mean.
 *
 * 更新 sits after the four ways to *look* at a project (面板 / 资源管理器 /
 * 浏览器 / README) and before the four ways to *arrange* it (置顶 / 隐藏 / 标签 /
 * 项目设置): pulling is periodic, so it outranks a display preference you set once,
 * but it is not what a click on a card is *for*, so it does not outrank the panel.
 * Its `note` is the honesty part — `git pull --ff-only` in the label, 只接受快进 in
 * the note, because a verb called 更新 that silently merged would be the second
 * time this app has been accused of doing git behind the user's back.
 * REQUIREMENTS.md §3.1 keeps diff/merge/rebase UI out of the product, so there
 * is no third option here.
 */
function buildMenu(
  t: TFunc,
  card: Card,
  ctx: {
    state: RepoState;
    running?: TileRunning;
    busy: boolean;
    /** What is running on this card, so a disabled row can *say* why. */
    busyNote: string | null;
    /** Resolves the one dictionary-backed label in this menu (查看 README…). */
    t: TFunc;
    onPanel: () => void;
    onUpdate: () => void;
    onPin: () => void;
    onHide: () => void;
    onTags: () => void;
    onSettings: () => void;
    onReadme: () => void;
    onDiagnose: () => void;
    onGrep: () => void;
    onFiles: () => void;
    onDelete: (permanent: boolean) => void;
  },
): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: "panel",
      label: t("menu.panel"),
      icon: <SquareArrowOutUpRight className="h-3.5 w-3.5" />,
      onSelect: ctx.onPanel,
    },
    {
      id: "reveal",
      label: t("menu.reveal"),
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      disabled: !card.path,
      // Disabled rows say why on their face: `ContextMenu`'s row is
      // `disabled:pointer-events-none`, so the `title` a user would reach for
      // never opens and the row otherwise reads as a broken button.
      note: card.path ? undefined : t("menu.revealNoPath"),
      onSelect: () => {
        // Choosing this menu item IS the request to open the folder; the tile's
        // own 删除/移动 paths all report, so a silent reject here was the odd one
        // out — the menu closes and nothing happens.
        if (card.path) {
          void invoke("reveal_path", { path: card.path }).catch((e) =>
            reportError(e, ctx.t("wall.revealFail")),
          );
        }
      },
    },
    {
      id: "homepage",
      label: t("menu.homepage"),
      icon: <Search className="h-3.5 w-3.5" />,
      note: `${card.owner}/${card.repo}`,
      onSelect: () => void openHttpUrl(`https://${card.host}/${card.owner}/${card.repo}`),
    },
    {
      id: "readme",
      label: ctx.t("readme.open"),
      icon: <BookOpen className="h-3.5 w-3.5" />,
      // Never disabled: whether a README exists, and why one cannot be read, is
      // the dialog's answer to give (it probes the disk), and a row that guessed
      // "no README" without asking would be the silent blank this direction forbids.
      onSelect: ctx.onReadme,
    },
    {
      id: "diagnose",
      label: t("diagnose.menu"),
      icon: <Stethoscope className="h-3.5 w-3.5" />,
      // 从不置灰：诊断本身就是「把各探针的结论摊开」，探针失败的诚实回答由对话框给出，
      // 在菜单里预先猜「没什么可诊断的」只会把入口藏起来。
      onSelect: ctx.onDiagnose,
    },
    {
      // r21-N1-1：项目内的行级内容搜索。与 README / 诊断同属「只读地看这个仓库」
      // 一组，所以排在更新（会动仓库）之前。没有本地目录就问不了——置灰并把原因
      // 写在脸上，与上面 reveal 的 `note` 同一纪律。
      id: "grep",
      label: t("grep.menu"),
      icon: <FileSearch className="h-3.5 w-3.5" />,
      disabled: !card.path,
      note: card.path ? undefined : t("grep.noPath"),
      onSelect: ctx.onGrep,
    },
    {
      id: "files",
      label: t("files.menu"),
      icon: <FolderTree className="h-3.5 w-3.5" />,
      disabled: !card.path,
      note: card.path ? undefined : t("files.noPath"),
      onSelect: ctx.onFiles,
    },
    {
      id: "update",
      label: ctx.busy && ctx.busyNote === ctx.t("wall.upd.busy") ? t("menu.updateBusy") : t("menu.update"),
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      // A disabled menu row still has to *say* why: `ContextMenu`'s row is
      // `disabled:pointer-events-none`, so a tooltip would never open and the row
      // would read as a dead button — the same reason 批量更新 prints its reason on
      // the face of the button (`BatchBar.tsx:203-213`).
      disabled: ctx.busy,
      note: ctx.busy ? (ctx.busyNote ?? t("menu.busy")) : t("wall.menu.notePull"),
      onSelect: ctx.onUpdate,
    },
    {
      id: "pin",
      label: ctx.state.pinned ? t("menu.unpin") : t("menu.pin"),
      icon: <Pin className="h-3.5 w-3.5" />,
      checked: !!ctx.state.pinned,
      note: t("menu.pinNote"),
      onSelect: ctx.onPin,
    },
    {
      id: "hide",
      label: t("menu.hide"),
      icon: <Eye className="h-3.5 w-3.5" />,
      note: ctx.running ? t("menu.hideRunningNote") : t("menu.hideNote"),
      onSelect: ctx.onHide,
    },
    {
      id: "tags",
      label: t("menu.tags"),
      icon: <Tags className="h-3.5 w-3.5" />,
      // Renders the count rather than a generic label, so the menu answers "is
      // this one already filed?" without opening the sheet first.
      note: ctx.state.tags?.length ? t("menu.tagsCount", { n: ctx.state.tags.length }) : t("menu.tagsNone"),
      onSelect: ctx.onTags,
    },
    {
      id: "settings",
      label: t("menu.settings"),
      icon: <Settings2 className="h-3.5 w-3.5" />,
      onSelect: ctx.onSettings,
    },
    {
      id: "trash",
      label: ctx.busy && ctx.busyNote === ctx.t("wall.del.busy") ? t("menu.trashBusy") : t("menu.trash"),
      icon: <Trash2 className="h-3.5 w-3.5" />,
      disabled: ctx.busy,
      note: ctx.busy ? (ctx.busyNote ?? t("menu.busy")) : t("menu.trashNote"),
      separatorBefore: true,
      onSelect: () => ctx.onDelete(false),
    },
    {
      id: "permanent",
      label: t("menu.permanent"),
      danger: true,
      disabled: ctx.busy,
      note: ctx.busy ? (ctx.busyNote ?? t("menu.busy")) : t("menu.permanentNote"),
      onSelect: () => ctx.onDelete(true),
    },
  ];
  return items;
}

/**
 * The zero-repository wall. Its own component because the seed field is state
 * this view otherwise would not need, and because the toolbar and the wall must
 * not have to guard against a filter being applied to nothing.
 */
function EmptyWall({
  onDownload,
  busy,
  disabledReason,
}: {
  onDownload: (ref: string, source: string) => void;
  busy: boolean;
  disabledReason: string | null;
}) {
  const { t } = useI18n();
  const [seed, setSeed] = useState("");

  return (
    <>
      <ViewHeader title={t("wall.view.title")} count={0} hint={t("wall.empty.title")} headerId="projects-header" />
      <div
        {...reg("projects-empty-state")}
        className="flex flex-col items-center justify-center skin-panel border border-border-weak bg-card px-6 py-9 text-center"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15">
          <Download className="h-6 w-6 text-primary" />
        </span>
        <p className="mt-4 text-display font-medium">{t("wall.empty.cta")}</p>
        <p className="mt-1 max-w-md text-caption leading-snug text-muted-foreground">
          {t("wall.empty.seedPre")} <code>owner/repo</code> {t("wall.empty.seedPost")}
        </p>
        <div className="mt-4 flex w-full max-w-md gap-2">
          <input
            value={seed}
            aria-label={t("wall.empty.seedAria")}
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => {
              // Round 13 (d5-4): the button beside this field is disabled while
              // `disabledReason` is set (no git), but Enter never checked it —
              // the keyboard path could start a download the mouse path refuses.
              if (e.key === "Enter" && seed.trim() && !busy && !disabledReason) {
                onDownload(seed.trim(), t("wall.empty.seedSource"));
              }
            }}
            placeholder={t("wall.empty.seedPh")}
            spellCheck={false}
            className="min-w-0 flex-1 skin-ctl border border-input bg-background px-3 py-2 text-body
                       outline-none transition-colors placeholder:text-muted-foreground/60
                       focus:border-primary focus:ring-0"
          />
          <button
            type="button"
            onClick={() => seed.trim() && onDownload(seed.trim(), t("wall.empty.seedSource"))}
            disabled={busy || !seed.trim() || !!disabledReason}
            title={disabledReason ?? undefined}
            className="flex shrink-0 items-center gap-2 skin-ctl bg-primary px-4 py-2 text-body
                       font-medium text-primary-foreground transition-colors hover:brightness-95
                       disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {busy ? t("wall.empty.downloading") : t("wall.empty.download")}
          </button>
        </div>
        {disabledReason && <p className="mt-2 text-caption text-warning">{disabledReason}</p>}
        <button
          type="button"
          onClick={() => useUI.getState().go("add")}
          className="mt-3 flex items-center gap-1 text-caption text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("wall.empty.addHint")}
        </button>
      </div>
    </>
  );
}
