import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask as askDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  GitFork,
  GripVertical,
  Pin,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { ViewHeader } from "../shell/AppShell";
import { SettingsGroup } from "../components/SettingsRows";
import { RepoTile } from "../components/RepoTile";
import { toast } from "../components/Toast";
import { cn } from "../lib/utils";
import { useDismiss, restoreFocusWhenLost, reorderById } from "../lib/useDismiss";
import { useLayerExit } from "../lib/motion";
import { reportError } from "../lib/report-error";
import { slugOf } from "../lib/slug";
import { repoScoreBySlug, topSettingUsage, usageScoreDay } from "../lib/usage-score";
import { sectionTitle, viewTitle, type TFunc } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { displayTarget } from "./records/format";
import { useMeta } from "../store/meta";
import { useUI, type ViewId } from "../store/ui";
import { useCustomize, ELEMENT_BY_ID, pinnedElements } from "../store/customize";
import {
  PINNABLE_VIEWS,
  SETTINGS_SECTIONS,
  entryId,
  type FrequentEntry,
} from "../settingsCatalog";
import { canonicalEntries, type PinnedEntry } from "./frequent/entries";
import type { RepoMeta, RepoRef } from "../types";

/**
 * 常用 — pins first, recent usage underneath, and now any function too.
 *
 * Round 4 reworked this page around one audit fact: 常用项目 used to be *purely*
 * derived from `usage` (`repo:<slug>` hit counts), which can remember what you
 * clicked but not the repository you only touch weekly and must never lose. So
 * the page became two blocks - a hand-arranged list and a recency ranking.
 *
 * Round 9 (需求 7) answered three reports against that version:
 *
 *   1. "点击自定义之后仍旧能打开项目信息页" — edit mode only locked the pinned
 *      block; the 最近使用 cards underneath stayed live, so a mis-click during
 *      arranging still opened a launch panel. Edit mode now locks the whole
 *      page: every card on it is inert until 完成.
 *   2. "在固定之后又缺失移除功能" — removing required entering edit mode first.
 *      Pinned cards now carry a hover ✕ in browse mode as well.
 *   3. "常用中当前仅有常用项目，但是应当是所有的功能都应当包含在可选项之中" —
 *      the pinned list holds *entries*: a project, a view, or a settings page.
 *      Pre-round-9 lists (bare repository slugs) migrate on load.
 *
 * The page also gained what the brief called the modern shape: an inline `+`
 * tile at the end of the grid (not a mode you must enter first), and covers on
 * the project cards — the same `RepoTile` the 项目 wall uses, so a pinned
 * project looks exactly like it does over there instead of like a list row.
 *
 * Click behaviour matches the repository wall exactly: open = `recordUsage` +
 * `setOpenSlug` (the launch dialog).
 */
export function FrequentView({ repos }: { repos: RepoRef[] }) {
  const usage = useCustomize((s) => s.usage);
  const entries = useCustomize((s) => s.frequentEntries);
  const addEntry = useCustomize((s) => s.addFrequentEntry);
  const setEntries = useCustomize((s) => s.setFrequentEntries);
  const togglePin = useCustomize((s) => s.togglePin);
  const record = useCustomize((s) => s.recordUsage);
  const metaBySlug = useMeta((s) => s.bySlug);
  const go = useUI((s) => s.go);
  const setSettingsSection = useUI((s) => s.setSettingsSection);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  // r16-n2-2: every 项目/页面/设置 name this page shows (picker rows, cards,
  // the remove dialog) resolves through the dictionary instead of the catalog
  // tables' Chinese labels. The catalog stays the source the keys were keyed
  // against; unknown ids fall back to the raw id, same as before.
  const { t } = useI18n();

  /** In-page edit mode. The header switch flips it; Escape leaves it. */
  const [editing, setEditing] = useState(false);
  /** The picker, positioned where it was opened from (header or the + tile). */
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null);
  // The picker stays where it was opened from, so the exit has to remember that
  // position after the state carrying it has been cleared.
  const lastPickerAt = useRef<{ x: number; y: number } | null>(null);
  if (pickerAt) lastPickerAt.current = pickerAt;
  const pickerLayer = useLayerExit(pickerAt !== null);
  const pickerPos = pickerAt ?? lastPickerAt.current;
  /** 选择器面板本体：外部按下关闭它的判定点。 */
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // r15-a11y-9: 面板的触发器与搜索框。触发器在 openPicker 里记下来（页眉
  // 「添加」和网格里的 + 都算），dismiss 后焦点若掉到 body 就还给它；
  // 在面板里连选几项时，被卸载的那一行把焦点还给搜索框。
  const pickerTriggerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");

  /** Entry id being dragged / insertion index into the list without it. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!editing && !pickerAt) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        const hadPicker = pickerAt !== null;
        setEditing(false);
        setPickerAt(null);
        // r15-a11y-9: Escape 由这个页面自己负责（useDismiss 的 escape 关着），
        // 所以焦点归还也要在这里补上：面板在、且焦点随着卸载掉回了文档根，
        // 才把焦点交还给「添加」（restoreFocusWhenLost 不会抢走点到别处的焦点）。
        if (hadPicker) restoreFocusWhenLost(pickerTriggerRef);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, pickerAt]);

  // Click-away closes the picker (the same contract the toolbar menus use);
  // it deliberately does NOT leave edit mode, which is a separate decision.
  // Escape 仍由上面那个「editing 与 picker 共用」的监听负责，这里不再重复。
  useDismiss(pickerRef, () => setPickerAt(null), {
    enabled: pickerAt !== null,
    capture: true,
    escape: false,
    // r15-a11y-9: 点掉浮层后焦点原本掉在 <body>；还给触发它打开的那个按钮，
    // 键盘用户不必重新 Tab 整块面板。
    returnFocusTo: pickerTriggerRef,
  });

  const repoBySlug = useMemo(() => new Map(repos.map((r) => [slugOf(r), r])), [repos]);

  /**
   * 以「天」为粒度的时钟，喂给下面的 useMemo。
   *
   * `usageScore`（lib/usage-score.ts，r17-o2-3）的衰减随墙上时间连续变化，而
   * memo 只在依赖变化时重算——页面开着过夜，排名还是昨天的。按天换桶：`now`
   * 取这一天的起点，同一整天里两次渲染看到的分数逐毫秒相同、只在跨天时变，重算
   * 每天至多一次，恰好落在「放一天就明显改排名」的粒度上。
   */
  const scoreDay = usageScoreDay(Date.now());

  /** Recency-weighted hit counts per repository slug. */
  const repoScores = useMemo(
    () => repoScoreBySlug(usage, scoreDay * 86_400_000),
    [usage, scoreDay],
  );

  /**
   * 固定项的唯一列表：parse → 丢掉解析不出的 → 按 canonical id 去重，顺序即存储顺序。
   *
   * 此前页面有两份列表：卡片按解析后的数组渲染，拖拽算术、第 N/M 项和 key 却
   * 按原始字符串数组下标走。存储里只要有一条 parseEntry 解析不出的记录（空串、
   * 只剩前缀），渲染与下标就错开一格，键盘重排变成 no-op、指示线落在错误的卡
   * 片之间；round-9 之前的裸 slug 与它的 `repo:` 前缀并存时 key 还会撞车。渲染、
   * index/total、拖拽过滤、key 现在全部只认这一份（canonicalEntries 有单测）。
   */
  const pinned = useMemo(() => canonicalEntries(entries), [entries]);

  const pinnedRepoSlugs = useMemo(
    () => new Set(pinned.filter((i) => i.entry.kind === "repo").map((i) => i.entry.id)),
    [pinned],
  );

  /** Usage-ranked repos that are not pinned yet; gone slugs show as placeholders. */
  const recentEntries = useMemo(() => {
    return [...repoScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([slug]) => !pinnedRepoSlugs.has(slug))
      .slice(0, 8)
      .map(([slug]) => ({ slug, repo: repoBySlug.get(slug) ?? null }));
  }, [repoScores, repoBySlug, pinnedRepoSlugs]);

  const frequentSettings = useMemo(() => topSettingUsage(usage, 12), [usage]);

  // 订阅窄一点（r16-o2-4）：固定块只由 overrides 决定，之前 `useCustomize((s) => s)`
  // 把整个 store 拉下来——usage 每点一下、布局每次拖动都换引用、作废这个 memo，
  // 计数在别处涨，这边的固定块却跟着一起重算。签名收窄成 Pick 之后，函数读不到
  // overrides 以外的字段，订阅也就只剩它。
  const overrides = useCustomize((s) => s.overrides);

  const pinnedBlocks = useMemo(
    () => pinnedElements({ overrides }),
    [overrides],
  );

  const empty =
    pinned.length === 0 &&
    recentEntries.length === 0 &&
    frequentSettings.length === 0 &&
    pinnedBlocks.length === 0;

  const openEntry = (entry: FrequentEntry) => {
    if (entry.kind === "repo") {
      // Identical contract to the repository wall: the write feeds 最近使用
      // and the 打开过 filter, the read opens the launch dialog.
      record(`repo:${entry.id}`);
      setOpenSlug(entry.id);
    } else if (entry.kind === "view") {
      go(entry.id as ViewId);
    } else {
      go("settings");
      setSettingsSection(entry.id);
    }
  };

  const reveal = (repo: RepoRef | null) => {
    if (!repo?.path) {
      toast.error(t("frequent.repoMissing"));
      return;
    }
    void invoke("reveal_path", { path: repo.path }).catch((e) => reportError(e, t("frequent.openDirFailed")));
  };

  const confirmRemove = async (item: PinnedEntry) => {
    const entry = item.entry;
    const repo = entry.kind === "repo" ? repoBySlug.get(entry.id) ?? null : null;
    const name = repo ? `${repo.owner}/${repo.repo}` : entryLabel(entry, t);
    const ok = await askDialog(t("frequent.removeConfirm", { name }), {
      title: t("frequent.removeDialogTitle"),
      kind: "info",
      okLabel: t("frequent.removeOk"),
      cancelLabel: t("frequent.removeCancel"),
    });
    if (!ok) return;
    // Removal rewrites from the canonical list rather than deleting one raw
    // string by exact match: a pre-round-9 bare slug and its `repo:` twin are
    // one item on screen but two different stored strings, so exact-match
    // deletion could not remove the card the person was looking at. The store's
    // `removeFrequentEntry` stays for anyone who wants exact-string semantics;
    // the page's own removal operates on THE list the page shows.
    setEntries(pinned.filter((i) => i.id !== item.id).map((i) => i.id));
    toast.success(t("frequent.removedNamed", { name }));
  };

  // --- reorder (edit mode only): pointer drag + r15-a11y-8 keyboard grab ---

  const finishDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const dropAt = (targetId: string, ev: React.DragEvent) => {
    if (!dragId || dragId === targetId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    const rect = ev.currentTarget.getBoundingClientRect();
    const filtered = pinned.filter((i) => i.id !== dragId);
    const pos = filtered.findIndex((i) => i.id === targetId);
    // Grid, not a vertical list: decide before/after by whichever edge the
    // pointer is closest to, so a same-row drag reads horizontally too.
    const rx = (ev.clientX - rect.left) / rect.width;
    const ry = (ev.clientY - rect.top) / rect.height;
    const before = Math.min(rx, 1 - rx) < Math.min(ry, 1 - ry) ? rx < 0.5 : ry < 0.5;
    setDropIndex(before ? pos : pos + 1);
  };

  const commitDrop = () => {
    if (!dragId) return;
    // The list written back is the canonical one minus the dragged item, so a
    // reorder also normalises whatever the storage held (legacy bare slugs,
    // duplicates, unparsable strings) — the page was already rendering only
    // that list, so nothing visible moves except the dragged card.
    const without = pinned.filter((i) => i.id !== dragId);
    const at = Math.max(0, Math.min(dropIndex ?? without.length, without.length));
    const ids = without.map((i) => i.id);
    setEntries([...ids.slice(0, at), dragId, ...ids.slice(at)]);
    finishDrag();
  };

  /**
   * r15-a11y-8: 键盘重排的一次请求。指针路径（dropAt/commitDrop）原样保留，
   * 这里只是把「空格拿起后的 ←/→」接到同一个 setEntries 上；边界与失效 id
   * 交给纯函数 reorderById 判定（它有单测）。下标来自 canonical 列表，和渲染
   * 用的是同一份（r16-o2-3）。
   */
  const moveEntry = (id: string, delta: number) => {
    const ids = pinned.map((i) => i.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    setEntries(reorderById(ids, id, delta));
  };

  // --- picker ----------------------------------------------------------------

  const q = query.trim().toLowerCase();
  const pinnedSet = useMemo(() => new Set(pinned.map((i) => i.id)), [pinned]);

  const pickableRepos = useMemo(
    () =>
      repos.filter((r) => {
        if (pinnedRepoSlugs.has(slugOf(r))) return false;
        return !q || `${r.repo} ${r.owner} ${r.path ?? ""}`.toLowerCase().includes(q);
      }),
    [repos, pinnedRepoSlugs, q],
  );

  /** Views and settings pages, minus whatever is pinned already.
   *  r16-n2-2: the filter matches against the *translated* label (typing
   *  "Projects" under the English locale finds the same row "项目" found
   *  under zh-CN), so `t` is a dep — exhaustive-deps is a gate error. */
  const pickableFunctions = useMemo(() => {
    const views = PINNABLE_VIEWS.filter((v) => {
      if (pinnedSet.has(entryId("view", v.id))) return false;
      const label = viewTitle(t, v.id);
      return !q || label.toLowerCase().includes(q);
    });
    const sections = SETTINGS_SECTIONS.filter((s) => {
      if (pinnedSet.has(entryId("settings", s.id))) return false;
      const label = sectionTitle(t, s.id);
      return !q || label.toLowerCase().includes(q);
    });
    return { views, sections };
  }, [pinnedSet, q, t]);

  const openPicker = (ev: React.MouseEvent<HTMLElement>) => {
    // r15-a11y-9: 记下这次是谁开的面板（页眉「添加」/网格 +），dismiss 后
    // 焦点还给同一个元素，而不是硬编码某一个触发器。
    pickerTriggerRef.current = ev.currentTarget;
    const r = ev.currentTarget.getBoundingClientRect();
    setPickerAt({ x: Math.min(r.left, window.innerWidth - 328), y: r.bottom + 6 });
  };

  /**
   * 固定一项。被点的那一行随即卸载（它已从可选项里消失），焦点会掉到
   * body —— 每次继续固定都得重 Tab 整块面板。选择后面板保持打开，把焦点
   * 交还搜索框，连选连按就还像原来那样是打字的事。（r15-a11y-9）
   */
  const pin = (id: string) => {
    addEntry(id);
    searchRef.current?.focus({ preventScroll: true });
  };

  const exitEditing = () => {
    setEditing(false);
    setPickerAt(null);
    setQuery("");
    finishDrag();
  };

  const line = <div aria-hidden className="mx-1 h-0.5 shrink-0 rounded-full bg-primary" />;

  return (
    <>
      <ViewHeader
        title={t("view.frequent")}
        count={pinned.length > 0 ? pinned.length : undefined}
        hint={t("frequent.hint")}
        headerId="frequent-header"
        actions={
          <span className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={openPicker}
              aria-pressed={pickerAt !== null}
              className={cn(
                "skin-ctl flex items-center gap-1.5 border px-2.5 py-1.5 text-caption transition-colors",
                pickerAt
                  ? "border-primary/60 bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("view.add")}
            </button>
            <button
              type="button"
              onClick={() => (editing ? exitEditing() : setEditing(true))}
              aria-pressed={editing}
              className={cn(
                "skin-ctl flex items-center gap-1.5 border px-2.5 py-1.5 text-caption transition-colors",
                editing
                  ? "border-primary/60 bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {editing ? <Check className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
              {editing ? t("frequent.editDone") : t("frequent.editStart")}
            </button>
          </span>
        }
      />

      {pickerLayer.render && pickerPos && (
        <div
          ref={pickerRef}
          data-no-row-click
          data-layer="menu"
          data-state={pickerLayer.state}
          className="skin-pop fixed z-50 w-80 border border-border bg-raised p-2"
          style={{ left: pickerPos.x, top: pickerPos.y }}
        >
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("frequent.searchPlaceholder")}
              aria-label={t("frequent.searchAria")}
              spellCheck={false}
              className="h-8 w-full skin-ctl border border-input bg-background pl-7 pr-7 text-caption
                         outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("frequent.clearSearch")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 max-h-56 overflow-y-auto">
            {pickableRepos.length === 0 &&
              pickableFunctions.views.length === 0 &&
              pickableFunctions.sections.length === 0 && (
                <p className="px-1 py-3 text-center text-caption text-muted-foreground">
                  {q ? t("frequent.noMatch") : t("frequent.allPinned")}
                </p>
              )}
            {pickableRepos.length > 0 && (
              <>
                <p className="px-2 pb-0.5 pt-1 text-caption font-medium text-muted-foreground">{t("view.projects")}</p>
                {pickableRepos.map((r) => (
                  <button
                    key={slugOf(r)}
                    type="button"
                    onClick={() => pin(entryId("repo", slugOf(r)))}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <GitFork className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption font-medium">{r.repo}</span>
                      <span className="block truncate text-caption text-muted-foreground">{r.owner}</span>
                    </span>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </>
            )}
            {pickableFunctions.views.length > 0 && (
              <>
                <p className="px-2 pb-0.5 pt-1 text-caption font-medium text-muted-foreground">{t("frequent.groupViews")}</p>
                {pickableFunctions.views.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => pin(entryId("view", v.id))}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption transition-colors hover:bg-accent"
                  >
                    <span className="shrink-0 text-muted-foreground">{v.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{viewTitle(t, v.id)}</span>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </>
            )}
            {pickableFunctions.sections.length > 0 && (
              <>
                <p className="px-2 pb-0.5 pt-1 text-caption font-medium text-muted-foreground">{t("view.settings")}</p>
                {pickableFunctions.sections.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pin(entryId("settings", s.id))}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption transition-colors hover:bg-accent"
                  >
                    <span className="shrink-0 text-muted-foreground">{s.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{sectionTitle(t, s.id)}</span>
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {empty && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border-weak bg-card px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15">
            <Sparkles className="h-5 w-5 text-primary" />
          </span>
          <p className="mt-3 text-body font-medium">{t("frequent.emptyTitle")}</p>
          <p className="app-desc mt-1 max-w-md text-caption leading-snug text-muted-foreground">
            {t("frequent.emptyHint")}
          </p>
        </div>
      )}

      {/* --- 固定项 ----------------------------------------------------------- */}
      {(pinned.length > 0 || editing) && (
        <SettingsGroup
          title={t("frequent.pinnedTitle")}
          footnote={
            editing
              ? t("frequent.pinnedEditHint")
              : t("frequent.pinnedHint", { x: "✕" })
          }
          regId="frequent-repos"
        >
          {pinned.length === 0 ? (
            <p className="px-3 py-4 text-center text-caption text-muted-foreground">
              {t("frequent.pinnedEmpty")}
            </p>
          ) : (
            <div className="repo-grid repo-grid-tight p-1.5">
              {(() => {
                // While dragging, the indicator addresses the list minus the
                // dragged item; convert back to render positions for the line.
                // Same canonical list, same ids — comparing against the raw
                // string array is what let the line land one card off.
                const filtered = dragId ? pinned.filter((i) => i.id !== dragId) : pinned;
                return (
                  <>
                    {pinned.map((item, index) => {
                      const entry = item.entry;
                      const id = item.id;
                      const isDragging = dragId === id;
                      const lineBefore =
                        dragId !== null &&
                        dropIndex !== null &&
                        filtered[dropIndex]?.id === id;
                      return (
                        <div key={id} className="flex flex-col">
                          {lineBefore && line}
                          {editing ? (
                            <EditingEntryCard
                              entry={entry}
                              repo={entry.kind === "repo" ? repoBySlug.get(entry.id) ?? null : null}
                              isDragging={isDragging}
                              index={index}
                              total={pinned.length}
                              onMove={(delta) => moveEntry(id, delta)}
                              onRemove={() => void confirmRemove(item)}
                              onDragStart={(ev) => {
                                ev.dataTransfer.effectAllowed = "move";
                                ev.dataTransfer.setData("text/plain", id);
                                setDragId(id);
                                setDropIndex(null);
                              }}
                              onDragEnd={finishDrag}
                              onDragOver={(ev) => dropAt(id, ev)}
                              onDrop={(ev) => {
                                ev.preventDefault();
                                commitDrop();
                              }}
                            />
                          ) : (
                            <BrowseEntryCard
                              entry={entry}
                              repo={entry.kind === "repo" ? repoBySlug.get(entry.id) ?? null : null}
                              meta={entry.kind === "repo" ? metaBySlug[entry.id] : undefined}
                              onOpen={() => openEntry(entry)}
                              onRemove={() => void confirmRemove(item)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {dragId !== null && dropIndex !== null && dropIndex >= filtered.length && line}
                    {/* The inline add tile: the brief's "直接在页面中进行嵌入
                        添加按钮" - available without entering a mode first. */}
                    <button
                      type="button"
                      onClick={openPicker}
                      className="flex min-h-[4.75rem] flex-col items-center justify-center gap-1 rounded-lg
                                 border border-dashed border-border text-muted-foreground transition-colors
                                 hover:border-primary/50 hover:text-foreground"
                    >
                      <Plus className="h-4 w-4" />
                      <span className="text-caption">{t("view.add")}</span>
                    </button>
                  </>
                );
              })()}
            </div>
          )}
        </SettingsGroup>
      )}

      {/* --- 最近使用 -------------------------------------------------------- */}
      {recentEntries.length > 0 && (
        <SettingsGroup
          title={t("frequent.recentTitle")}
          footnote={t("frequent.recentHint")}
          regId="frequent-recent"
        >
          <div className="repo-grid repo-grid-tight p-1.5">
            {recentEntries.map((entry) => (
              <RecentEntryCard
                key={entry.slug}
                entry={entry}
                usage={usage}
                locked={editing}
                onOpen={() => {
                  record(`repo:${entry.slug}`);
                  setOpenSlug(entry.slug);
                }}
                onReveal={() => reveal(entry.repo)}
                onPin={() => addEntry(entryId("repo", entry.slug))}
              />
            ))}
          </div>
        </SettingsGroup>
      )}

      {/* --- 钉选的区块 ------------------------------------------------------- */}
      {pinnedBlocks.length > 0 && (
        <SettingsGroup title={t("frequent.blocksTitle")} regId="frequent-pinned">
          <div className="grid grid-cols-2 gap-1.5 p-1.5 sm:grid-cols-3">
            {pinnedBlocks.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2 rounded-lg border border-border-weak bg-background px-2.5 py-2 transition-colors hover:border-primary/50 hover:bg-accent"
              >
                <button
                  type="button"
                  onClick={() => jumpToBlock(e.id, go, setSettingsSection)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-caption font-medium">{e.label}</span>
                  <span className="app-desc block truncate text-caption text-muted-foreground">
                    {e.group}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(e.id)}
                  title={t("frequent.unpin")}
                  aria-label={t("frequent.unpin")}
                  className="shrink-0 rounded p-1 text-primary transition-colors hover:bg-accent"
                >
                  <Pin className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </SettingsGroup>
      )}

      {/* --- 常用设置 --------------------------------------------------------- */}
      {frequentSettings.length > 0 && (
        <SettingsGroup title={t("frequent.settingsTitle")} footnote={t("frequent.settingsHint")} regId="frequent-settings">
          <div className="flex flex-wrap gap-1.5 p-1.5">
            {frequentSettings.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  go("settings");
                  setSettingsSection(sectionFor(s.key));
                }}
                className="skin-ctl flex items-center gap-1.5 border border-border px-2 py-1 text-caption text-muted-foreground t-state hover:bg-accent hover:text-foreground active:scale-[0.98]"
              >
                {displayTarget(s.key)}
                <span className="tabular-nums opacity-60">{s.hits}</span>
              </button>
            ))}
          </div>
        </SettingsGroup>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * One pinned entry, browse mode.
 *
 * A project is the wall's own tile - cover, metadata line, hover badge and all -
 * because a pinned project should be indistinguishable from the same project on
 * the 项目 wall (that is the "封面等更加显眼的实现" the brief asked for, and it
 * costs nothing to reuse). A function is a compact card with the destination's
 * own icon. Both carry a hover ✕: removing no longer requires entering edit
 * mode first (需求 7, "在固定之后又缺失移除功能").
 */
function BrowseEntryCard({
  entry,
  repo,
  meta,
  onOpen,
  onRemove,
}: {
  entry: FrequentEntry;
  repo: RepoRef | null;
  meta?: RepoMeta;
  onOpen: () => void;
  onRemove: () => void;
}) {
  // r16-n2-2: called before the repo early-returns below — rules of hooks,
  // and the function cards further down are the only ones that need it.
  const { t } = useI18n();
  if (entry.kind === "repo") {
    if (!repo) {
      return (
        <div className="group/rm relative flex items-center gap-2.5 rounded-lg border border-dashed border-border-weak px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground" title={entry.id}>
            {entry.id}
          </span>
          <span className="shrink-0 text-caption text-muted-foreground">{t("frequent.offDisk")}</span>
          <RemoveBtn onRemove={onRemove} />
        </div>
      );
    }
    return (
      <div className="group/rm relative">
        {/* r15-a11y-7: no `onContextMenu` — the 常用 page has no tile menu,
            and the tile now stops cancelling the native menu / advertising
            `aria-haspopup="menu"` when none was ever supplied (the previous
            `() => undefined` made right-click and Shift+F10 silently dead).
            The smaller honest fix: do not advertise what does not exist. */}
        <RepoTile
          repo={repo}
          slug={entry.id}
          onOpen={onOpen}
          sortable={false}
          meta={meta}
        />
        <RemoveBtn onRemove={onRemove} />
      </div>
    );
  }

  const def = entry.kind === "view" ? PINNABLE_VIEWS.find((v) => v.id === entry.id) : undefined;
  const section =
    entry.kind === "settings" ? SETTINGS_SECTIONS.find((s) => s.id === entry.id) : undefined;
  // r16-n2-2: the name comes from the dictionary (unknown ids fall back to the
  // raw id, same as the old `?? entry.id`); the catalog tables stay the icon
  // source and the zh-CN source the dictionary was keyed against.
  const label = entry.kind === "view" ? viewTitle(t, entry.id) : sectionTitle(t, entry.id);
  const icon = def?.icon ?? section?.icon ?? <SlidersHorizontal className="h-3.5 w-3.5" />;
  const note = entry.kind === "view" ? t("frequent.groupViews") : t("view.settings");

  return (
    <div className="group/rm relative">
      <button
        type="button"
        onClick={onOpen}
        className="skin-card flex h-full w-full flex-col justify-between gap-2 rounded-lg border border-border-weak bg-card p-2.5 text-left transition-colors hover:border-primary/40"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body font-medium">{label}</span>
          <span className="app-desc block truncate text-caption text-muted-foreground">{note}</span>
        </span>
      </button>
      <RemoveBtn onRemove={onRemove} />
    </div>
  );
}

/** The hover ✕ every browse card carries. */
function RemoveBtn({ onRemove }: { onRemove: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onRemove}
      title={t("frequent.remove")}
      aria-label={t("frequent.remove")}
      className="absolute bottom-2 right-2 rounded bg-black/50 p-1 text-white/80 opacity-0 backdrop-blur-sm
                 hover:bg-black/70 hover:text-white
                 group-hover/rm:opacity-100 group-focus-within/rm:opacity-100"
    >
      <X className="h-3 w-3" />
    </button>
  );
}

/**
 * One pinned entry, edit mode: a grip, the name, a trash. Not a navigation
 * target — that is the whole point of the mode (需求 7: "点击自定义之后仍旧能
 * 打开项目信息页").
 *
 * r15-a11y-8: 固定项此前**只有**拖拽一条重排路（原生 `draggable` + pointer
 * handlers，行都不可聚焦），而邻页项目墙早有 dnd-kit 的 KeyboardSensor
 * （ProjectsView:539）。现在行可 Tab 聚焦：空格/Enter「拿起」，方向键移动，
 * 空格/Enter/Esc 放下；指针拖拽原样保留。没有选 Alt+←/→ —— AppShell 在
 * window 捕获层把它定为前进/后退（AppShell:112-127），组件层抢不到也不该抢。
 * 位移算术在 `lib/useDismiss` 的纯函数 `reorderById` 里，能被单测钉住。
 */
function EditingEntryCard({
  entry,
  repo,
  isDragging,
  index,
  total,
  onMove,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  entry: FrequentEntry;
  repo: RepoRef | null;
  isDragging: boolean;
  /** 本卡片在固定项里的位置，播报「第 N / M 项」用。 */
  index: number;
  total: number;
  /** 键盘重排的一次请求：-1 前移，+1 后移。 */
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDragStart: (ev: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (ev: React.DragEvent) => void;
  onDrop: (ev: React.DragEvent) => void;
}) {
  const [grabbed, setGrabbed] = useState(false);
  // r16-n2-2: the card's accessible name follows the language row, same as
  // the browse card and the remove dialog above.
  const { t } = useI18n();
  const label =
    entry.kind === "repo" ? (repo ? `${repo.owner}/${repo.repo}` : entry.id) : entryLabel(entry, t);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      role="group"
      // 行内还嵌着「移除」按钮，所以外层不能用 role=button（button 不允许有
      // 可交互后代）。group 可聚焦、可带按钮，拿起状态写进 aria-label 文本
      // （group 没有 aria-pressed 这种状态属性），移动结果另走下方 status 区。
      aria-roledescription={t("frequent.sortableItem")}
      tabIndex={0}
      aria-label={t("frequent.itemAria", {
        label,
        i: index + 1,
        n: total,
        state: grabbed ? t("frequent.itemStateGrabbed") : t("frequent.itemStateIdle"),
      })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setGrabbed((v) => !v);
          return;
        }
        if (!grabbed) return;
        if (e.key === "Escape") {
          e.preventDefault();
          // 只放下，不退出编辑：页面的 window 层 Escape 在冒泡阶段，
          // 这里掐掉传播，一次 Escape 不再「放下+退出」双杀。
          e.stopPropagation();
          setGrabbed(false);
          return;
        }
        const dir =
          e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : e.key === "ArrowRight" || e.key === "ArrowDown"
              ? 1
              : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopPropagation();
        onMove(dir);
      }}
      // 焦点离开（Tab 走、点别处）即放下，不留一个看不见的「已拿起」状态。
      onBlur={() => setGrabbed(false)}
      className={cn(
        "skin-card flex items-center gap-2 rounded-lg border border-border-weak bg-card p-2.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isDragging && "opacity-40",
        grabbed && "border-primary/60 shadow-[0_0_0_1px_var(--color-primary)_inset]",
      )}
    >
      <GripVertical
        aria-hidden
        className={cn(
          "h-4 w-4 shrink-0 cursor-grab text-muted-foreground/50",
          grabbed && "text-primary",
        )}
      />
      {entry.kind === "repo" ? (
        <GitFork className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="shrink-0 text-muted-foreground">
          {entry.kind === "view"
            ? PINNABLE_VIEWS.find((v) => v.id === entry.id)?.icon
            : SETTINGS_SECTIONS.find((s) => s.id === entry.id)?.icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-caption font-medium" title={label}>
        {label}
      </span>
      {/* 播报位：内容随每次移动变化，role=status 把它读出来。 */}
      <span role="status" aria-live="polite" className="sr-only">
        {grabbed ? t("frequent.position", { i: index + 1, n: total }) : ""}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title={t("frequent.remove")}
        aria-label={t("frequent.remove")}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * One 最近使用 card. `locked` is edit mode: the body stops navigating so
 * arranging cannot open a launch panel by accident, and the pin button becomes
 * the row's one action.
 */
function RecentEntryCard({
  entry,
  usage,
  locked,
  onOpen,
  onReveal,
  onPin,
}: {
  entry: { slug: string; repo: RepoRef | null };
  usage: Record<string, { count: number; last: number }>;
  locked: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onPin: () => void;
}) {
  const { slug, repo } = entry;
  const { t } = useI18n();

  if (!repo) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border-weak px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground" title={slug}>
          {slug}
        </span>
        <span className="shrink-0 text-caption text-muted-foreground">{t("frequent.offDisk")}</span>
        {locked && (
          <button
            type="button"
            onClick={onPin}
            title={t("frequent.pinAnyway")}
            aria-label={t("frequent.pinAnyway")}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  const count = usage[`repo:${slug}`]?.count ?? 0;

  if (locked) {
    return (
      <div className="skin-card flex items-center gap-2 rounded-lg border border-border-weak bg-card p-2.5">
        <GitFork className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption font-medium">{repo.repo}</span>
          <span className="block truncate text-caption text-muted-foreground">{repo.owner}</span>
        </span>
        <button
          type="button"
          onClick={onPin}
          title={t("frequent.pin")}
          aria-label={t("frequent.pin")}
          className="shrink-0 rounded p-1 text-primary transition-colors hover:bg-accent"
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="skin-card group relative flex items-center gap-2 rounded-lg border border-border-weak bg-card p-2.5 transition-colors hover:border-primary/40">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <GitFork className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption font-medium">{repo.repo}</span>
          <span className="block truncate text-caption text-muted-foreground">{repo.owner}</span>
        </span>
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 text-caption tabular-nums text-muted-foreground"
          title={t("frequent.openCountTitle", { n: count })}
        >
          {count}
        </span>
      </button>
      <button
        type="button"
        onClick={onPin}
        title={t("frequent.pin")}
        aria-label={t("frequent.pin")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Pin className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onReveal}
        disabled={!repo.path}
        title={repo.path ? t("frequent.revealDir") : t("frequent.offDiskTitle")}
        aria-label={t("frequent.revealDir")}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labels and jumps (unchanged from round 4)
// ---------------------------------------------------------------------------

/**
 * Where a setting lives in 设置, so a chip can jump to the right section.
 *
 * Jump targets only — the *name* of a setting comes from the shared catalog via
 * `displayTarget`, and this file used to carry a second key→中文 table that had
 * already drifted from it. `ui.font` is gone from here: `store/appearance.ts`
 * deletes the legacy `font` field on every load, so no current build can produce
 * that key; a stale `setting:ui.font` usage entry from an older install now falls
 * through to the raw key, which is honest, and still jumps to the right section.
 */
const SETTING_SECTION: Record<string, string> = {
  "config.projectRoot": "roots",
  "config.extraRoots": "roots",
  "config.mirrorEnabled": "network",
  "config.ipPinEnabled": "network",
  "config.searchRoute": "network",
  "config.downloadRoute": "network",
  "config.searchDebounceMs": "network",
  "config.parallelDownloads": "network",
  "config.proxy": "network",
  "config.githubToken": "token",
  "config.terminalChoice": "editors",
  "config.ideChoice": "editors",
  "config.activityRetentionDays": "records",
  "config.cleanupMode": "records",
  "ui.theme": "appearance",
  "ui.skin": "appearance",
  "ui.fontScale": "appearance",
  "ui.density": "appearance",
  "ui.covers": "appearance",
};

function sectionFor(key: string): string {
  return SETTING_SECTION[key] ?? "network";
}

/** Human name for any entry, used by dialogs and edit cards.
 *  r16-n2-2: takes the translator — view/section names come from lib/i18n
 *  (dictionary + fallback to the raw id), not from the catalog tables. */
function entryLabel(entry: FrequentEntry, t: TFunc): string {
  if (entry.kind === "repo") return entry.id;
  if (entry.kind === "view") return viewTitle(t, entry.id);
  return sectionTitle(t, entry.id);
}

/** Pinned blocks route by which page they live on. */
function jumpToBlock(
  id: string,
  setView: (v: ViewId) => void,
  setSettingsSection: (s: string | null) => void,
) {
  const def = ELEMENT_BY_ID[id];
  if (!def) return;
  const target = GROUP_VIEW[def.group];
  if (target) setView(target);
  if (def.group === "设置页") {
    setSettingsSection(id.replace(/^settings-(group|row)-/, ""));
  }
}

const GROUP_VIEW: Partial<Record<string, ViewId>> = {
  侧边栏: "settings",
  状态栏: "settings",
  项目页: "projects",
  添加页: "add",
  记录页: "records",
  设置页: "settings",
  常用页: "frequent",
};
