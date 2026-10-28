import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, ask as askDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Trash,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { filterRecordEntries, recordCutoff } from "../lib/records-derive";
import { type TFunc } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { ViewHeader } from "../shell/AppShell";
import { toast } from "../components/Toast";
import { useAutoLayers } from "../lib/motion";
import { messageOf, reportError, swallow } from "../lib/report-error";
import { confirmAndClearActivity } from "../lib/activity";
import { useUI } from "../store/ui";
import { useAppearance } from "../store/appearance";
import { useDownloads } from "../store/downloads";
import { reg } from "../store/customize";
import {
  TAGS,
  RANGES,
  RECORDS_SEARCH_DEBOUNCE_MS,
  RECORDS_GROUP_PAGE,
} from "./records/constants";
import {
  formatTime,
  groupKeyOf,
  groupLabelOf,
} from "./records/format";
import { RecordRow } from "./records/RecordRow";
import { filterWordsOf, hasActiveFilter, type ChipAxis } from "./records/filter-words";
import { pickedCount, pickedIsAll, prunePicked } from "./records/picked";
import { RetentionRows } from "./records/RetentionRows";
import { StatsPanel } from "./records/StatsPanel";
import { StorageOverviewCard } from "./records/StorageOverviewCard";
import { applyUiValue, settingsPayload } from "./records/undo";
import {
  type ActivityEntry,
  type SettingsView as Settings,
  type UndoPlan,
} from "../types";

/**
 * 记录 view: what happened, grouped by the thing it happened to.
 *
 * ## The three things this view used to get wrong
 *
 * **A record could not be read.** "修改设置" with no value told you nothing, so
 * entries now carry `before` / `after` and a `target`, and the row shows
 * `前值 → 后值`. Entries written before those fields existed show 未知 rather
 * than being hidden.
 *
 * **Repeated adjustments buried the pattern.** Changing one project's launch
 * command five times produced five rows scattered through the list. `target` is
 * the grouping key, so they now fold into one block that says "5 次" and expands
 * to the individual attempts — which is also what makes a 回退 meaningful, since
 * you can see what the value was before each change.
 *
 * **The layout moved under the cursor.** The filter row was a wrapping flex with
 * `ml-auto` on the search box, so the box jumped to a second line the moment the
 * chips got wide enough — and every row's height depended on which optional
 * fields that particular entry happened to have. Switching from 终端 (2 rows) to
 * 启动 (19 rows) also toggled the page scrollbar, shifting the whole column.
 * Both are fixed here: the filter bar is a two-column grid whose slots never
 * move, rows reserve every slot, and `scrollbar-gutter: stable` keeps the
 * gutter whether or not the page scrolls.
 *
 * Retention and the clean-up schedule are editable *here* now, inline, because
 * this is the page where you are looking at the history and can judge how much
 * of it you want.
 */

type Group = { key: string; label: string; entries: ActivityEntry[] };

export function RecordsView({ onWallChanged }: { onWallChanged?: () => void }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState("all");
  const [range, setRange] = useState("all");
  const [query, setQuery] = useState("");
  /**
   * The debounced mirror of `query` that the filter actually reads. `query` stays
   * the instant input value (typing feels live); `filtered` recomputes only once the
   * pause settles. A records list is the biggest `filter(…)` in the app — every
   * keystroke used to re-scan all entries — and a shared quiet period is the whole
   * fix. Same shape as 添加页's search debounce (setTimeout + clearTimeout cleanup),
   * but shorter: this filter is local and CPU-bound, not a rate-limited network call,
   * so it wants to feel instant rather than wait out 700 ms.
   */
  const [deferredQuery, setDeferredQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDeferredQuery(query), RECORDS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const recordsSeed = useUI((s) => s.recordsSeed);
  const setRecordsSeed = useUI((s) => s.setRecordsSeed);
  // A palette result that names a past operation lands here as a search string, so
  // "find the record" and "read the record" are one gesture instead of two.
  useEffect(() => {
    if (!recordsSeed) return;
    setQuery(recordsSeed);
    setRecordsSeed("");
  }, [recordsSeed, setRecordsSeed]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** Selection mode is opt-in: a stray click must never start selecting rows. */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  /** How many groups are on screen. Initial cap, raised by 显示更多 (see render). */
  const [groupLimit, setGroupLimit] = useState(RECORDS_GROUP_PAGE);

  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const go = useUI((s) => s.go);
  const setSettingsSection = useUI((s) => s.setSettingsSection);
  const timeFormat = useAppearance((s) => s.recordTimeFormat);
  const addDownload = useDownloads((s) => s.add);
  // r17-n1-1: the whole records surface renders through the dictionary now.
  const { t } = useI18n();
  /** The chip row's label resolver — the same words `filterWordsOf` names a condition with. */
  const chipLabelOf = useCallback((axis: ChipAxis, id: string) => chipLabel(t, axis, id), [t]);

  /**
   * What the 保留 badge reports. Two different numbers govern pruning:
   * 保留时长 cuts on read, 清理时保留 is the floor a scheduled clean-up keeps.
   * While an automatic schedule is on, the badge must track the schedule's
   * floor — that is the value a change of 清理时保留 actually moves.
   */
  const autoCleanup = !!settings && settings.cleanupMode !== "manual";
  const badgeDays = settings
    ? autoCleanup
      ? settings.cleanupKeepDays
      : settings.activityRetentionDays
    : null;

  const load = useCallback(async (force = false) => {
    try {
      const [list, s] = await Promise.all([
        invoke<ActivityEntry[]>("list_activity", force ? { force: true } : undefined),
        invoke<Settings>("get_settings"),
      ]);
      setEntries(list);
      setSettings(s);
      setError(null);
    } catch (e) {
      // The banner below has no heading of its own, so the verb has to ride in the
      // string or the page shows a bare sentence nobody knows the origin of.
      setError(t("records.loadFailed", { msg: messageOf(e) }));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Keeps the list honest about work this page started.
   *
   * A 回退 that re-downloads writes its record when the clone *finishes*, which
   * is minutes after the button was clicked — so without this the row for the
   * thing you just did only appears after you leave the page and come back. The
   * download store's settled count is the signal: the backend has already
   * recorded the outcome by the time a task flips to done or failed.
   */
  const settled = useDownloads(
    (s) => s.tasks.filter((t) => t.status === "done" || t.status === "failed").length,
  );
  const seenSettled = useRef(settled);
  useEffect(() => {
    if (settled === seenSettled.current) return;
    seenSettled.current = settled;
    void load();
  }, [settled, load]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    // 派生管道抽到 lib/records-derive.ts（r17-o2-3）：谓词原先是这个 .tsx 里的
    // 内联函数，Node 跑不了 JSX，于是「全部 = 无下界而非 0 秒」「八个字段的
    // haystack 跳过空值」这些规则从没被单测钉住。
    const secs = RANGES.find((r) => r.id === range)?.seconds ?? 0;
    return filterRecordEntries(entries, {
      tag,
      cutoff: recordCutoff(secs, Date.now()),
      query: deferredQuery,
    });
  }, [entries, tag, range, deferredQuery]);

  /**
   * Ids the current result set can actually put a checkmark on. The log can carry
   * rows with no id (they say so in 删除 and point at 清空记录); those are never
   * selectable, so they stay out of every selection count below rather than
   * letting a count and the visible checkboxes disagree forever.
   */
  const filteredIds = useMemo(() => filtered.map((e) => e.id).filter(Boolean), [filtered]);

  /**
   * Selection is scoped to the result set: switch the 类别 / 时间 / 搜索 and the
   * rows behind the old choice are gone, so the choice goes with them. Without
   * this `picked` kept ids no filter could ever show again — the header counted
   * them and 删除所选 deleted them (the defect `records/picked.ts` documents).
   * One new `Set` only when something is actually dropped, so this effect is a
   * no-op on every keystroke that leaves the selection intact.
   */
  useEffect(() => {
    setPicked((p) => prunePicked(p, filteredIds));
  }, [filteredIds]);

  /**
   * What the header and the 全选 toggle read. Both are membership questions over
   * `filtered` — never `picked.size`, which counts ids the current tag/range/search
   * may not be showing (that mismatch is the whole bug).
   */
  const selectedCount = useMemo(() => pickedCount(picked, filteredIds), [picked, filteredIds]);
  const allSelected = useMemo(() => pickedIsAll(picked, filteredIds), [picked, filteredIds]);

  /** Entries folded by `target`, most recent group first. */
  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const e of filtered) {
      const key = groupKeyOf(e);
      const g = m.get(key);
      if (g) g.entries.push(e);
      else m.set(key, { key, label: groupLabelOf(e), entries: [e] });
    }
    return [...m.values()];
  }, [filtered]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries ?? []) m.set(e.tag, (m.get(e.tag) ?? 0) + 1);
    return m;
  }, [entries]);

  // A new filter, range, or (debounced) search is a fresh result set — reset the cap
  // so it paints its first page again instead of carrying an enlarged list over.
  useEffect(() => {
    setGroupLimit(RECORDS_GROUP_PAGE);
  }, [tag, range, deferredQuery]);

  const removeOne = useCallback(async (e: ActivityEntry) => {
    if (!e.id) {
      toast.error(t("records.lineNoId"));
      return;
    }
    setDeleting(e.id);
    try {
      await invoke("delete_activity", { id: e.id });
      setEntries((list) => (list ?? []).filter((x) => x.id !== e.id));
      toast.success(t("records.oneDeleted"));
    } catch (err) {
      reportError(err, t("records.deleteFail"));
    } finally {
      setDeleting(null);
    }
  }, [t]);

  const deletePicked = async () => {
    // 交集而不是 `picked` 原样：删除的必须是「界面上这些行」，不是同一份日志里
    // 另一个筛选条件下选中的 id。prunePicked 已经在筛选变化时清过一轮，这里的
    // 重新求交是让删除本身不依赖那次 effect 的时序。
    const visible = new Set(filteredIds);
    const ids = [...picked].filter((id) => visible.has(id));
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const [removed] = await invoke<[number, number]>("delete_activity_many", { ids });
      const gone = new Set(ids);
      setEntries((list) => (list ?? []).filter((x) => !gone.has(x.id)));
      toast.success(t("records.batchDeleted", { n: removed }));
      setPicked(new Set());
      setSelecting(false);
    } catch (err) {
      reportError(err, t("records.batchDeleteFail"));
    } finally {
      setBatchBusy(false);
    }
  };

  /**
   * Writes an honest row when a revert did not go through, following the same
   * precedent as the backend's partial-failure records: the failure is part
   * of the history, not just a toast that vanishes.
   */
  const recordUndoFailure = useCallback((e: ActivityEntry, reason: string) => {
    invoke("log_activity", {
      tag: e.tag,
      action: t("records.undoFailedAction", { action: e.action }),
      detail: reason,
      target: e.target ?? "",
      before: "",
      after: "",
      slug: e.slug,
      source: "记录页",
      undoValue: "",
      undoKey: "",
    }).catch((logErr) =>
      swallow(logErr, "the caller already surfaced this undo failure; a second red line for the missing history entry would be noise"),
    );
  }, [t]);

  const applyUndo = useCallback(async (
    kind: string,
    scope: string | undefined,
    key: string | undefined,
    value: string | undefined,
    args: string[] | undefined,
  ) => {
    if (kind === "value" && scope === "config" && key) {
      await invoke("apply_config_value", { key, value: value ?? "" });
      setSettings(await invoke<Settings>("get_settings"));
      return;
    }
    if (kind === "value" && scope === "ui" && key) {
      // The webview owns its own display state, so the backend cannot write it
      // back — it hands the previous value over and this side applies it.
      applyUiValue(key, value ?? "");
      return;
    }
    if (kind === "value" && scope === "steps" && key) {
      // The previous step list, JSON-encoded. Putting it back re-uses the same
      // command the launch dialog confirms with, so the reversal validates
      // exactly like a manual edit.
      const steps = JSON.parse(value ?? "[]") as unknown[];
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error(t("records.undoStepsCorrupt"));
      }
      await invoke("confirm_launch_steps", { slug: key, steps });
      return;
    }
    if (kind === "value" && scope === "launch" && key) {
      // Same rule as applyUiValue: an undo blob from the log is validated before
      // it is written anywhere. The old cast promised {command?, cwd?} and
      // believed it — a number or an array in either slot reached
      // confirm_launch as garbage.
      const raw: unknown = JSON.parse(value ?? "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(t("records.undoCfgCorrupt"));
      }
      const cfg = raw as { command?: unknown; cwd?: unknown };
      if (cfg.command !== undefined && typeof cfg.command !== "string") {
        throw new Error(t("records.undoCmdCorrupt"));
      }
      if (cfg.cwd !== undefined && typeof cfg.cwd !== "string") {
        throw new Error(t("records.undoCwdCorrupt"));
      }
      await invoke("confirm_launch", {
        slug: key,
        command: cfg.command ?? "",
        cwd: cfg.cwd ?? "",
      });
      return;
    }
    if (kind === "redownload" && args?.[0]) {
      addDownload(args[0], t("records.redownloadSource"));
      return;
    }
    if (kind === "delete" && value) {
      // `value` is the absolute path the download record wrote to, so it goes to
      // the command that takes a path and re-checks it against the project
      // directories — not to `delete_repo`, which resolves a `owner/repo` slug
      // and would answer 未找到仓库 for every path it is handed.
      await invoke("delete_downloaded", { path: value });
      // The wall is listing a project that no longer exists on disk.
      onWallChanged?.();
      return;
    }
    if (kind === "restore_trash" && args?.length) {
      // The recycle-bin level of the delete menu is reversible by the app because
      // `trash` exposes the bin's item list with each entry's original path - so
      // this is a real restore, not a message telling the user to go do it.
      const r = await invoke<{ restored: string[]; missing: string[] }>("restore_from_trash", {
        paths: args,
      });
      onWallChanged?.();
      if (!r.restored.length) {
        throw new Error(t("records.trashMissing"));
      }
      if (r.missing.length) {
        throw new Error(
          t("records.trashPartial", { restored: r.restored.length, missing: r.missing.join("；") }),
        );
      }
      return;
    }
    throw new Error(t("records.undoUnknown"));
  }, [addDownload, onWallChanged, setSettings, t]);

  /**
   * Reverts one record, by asking the backend what that means first.
   *
   * The plan is fetched rather than assumed: only the backend knows whether a
   * given entry carries an undo descriptor, and a record written before that
   * existed must say so instead of presenting a button that does nothing.
   */
  const undo = useCallback(async (e: ActivityEntry) => {
    setUndoing(e.id);
    try {
      const plan = await invoke<UndoPlan>("undo_plan", { id: e.id });
      const u = plan.undo;
      if (!u || u.kind === "none") {
        toast.error(plan.reason || u?.reason || t("records.undoNoReason"));
        return;
      }
      if (u.kind === "delete" || u.kind === "redownload" || u.kind === "restore_trash") {
        // A dialog rather than window.confirm: these three touch the disk (delete a
        // directory, start a clone, pull something back out of the Recycle Bin),
        // and the text has to say which, where, and what the second-order
        // consequence is.
        const what =
          u.kind === "delete"
            ? t("records.undo.delete", { value: u.value ?? "" })
            : u.kind === "restore_trash"
              ? t("records.undo.restoreTrash", { paths: (u.args ?? []).join("\n\n") })
              : t("records.undo.redownload", { url: u.args?.[0] ?? "" });
        const title =
          u.kind === "delete"
            ? t("records.undoTitle.delete")
            : u.kind === "restore_trash"
              ? t("records.undoTitle.restoreTrash")
              : t("records.undoTitle.redownload");
        const ok = await askDialog(what, {
          title,
          kind: u.kind === "delete" ? "warning" : "info",
          okLabel:
            u.kind === "delete"
              ? t("records.undoOk.delete")
              : u.kind === "restore_trash"
                ? t("records.undoOk.restoreTrash")
                : t("records.undoOk.redownload"),
          cancelLabel: t("records.undoCancel"),
        });
        if (!ok) return;
      }
      await applyUndo(u.kind, u.scope, u.key, u.value, u.args);
      // Stamp the entry only after the reversal actually happened: a failed
      // revert must stay retryable, and the row must still read as reverted
      // after a restart (the mark lives in the log, not in component state).
      await invoke("mark_activity_undone", { id: e.id }).catch((markErr) =>
        swallow(markErr, t("records.undoStampFail")),
      );
      toast.success(t("records.undone", { action: plan.action }));
      await load();
    } catch (err) {
      reportError(err, t("records.undoFail"));
      recordUndoFailure(e, messageOf(err));
    } finally {
      setUndoing(null);
    }
  }, [applyUndo, load, recordUndoFailure, t]);

  /** Exports the visible history. The bytes are written by the backend. */
  const exportFile = async (kind: "jsonl" | "markdown" | "markdown-grouped" | "csv") => {
    setExporting(true);
    try {
      const ext = kind === "jsonl" ? "jsonl" : kind === "csv" ? "csv" : "md";
      const picked0 = await saveDialog({
        title:
          kind === "markdown-grouped"
            ? t("records.exportGroupedTitle")
            : kind === "markdown"
              ? t("records.exportMdTitle")
              : kind === "csv"
                ? t("records.exportCsvTitle")
                : t("records.exportJsonlTitle"),
        defaultPath: `devhub-records-${new Date().toISOString().slice(0, 10)}.${ext}`,
        filters: [
          {
            name: ext === "md" ? "Markdown" : ext === "csv" ? "CSV" : "JSONL",
            extensions: [ext],
          },
        ],
      });
      if (!picked0) return;
      const n = await invoke<number>("export_activity", { path: picked0, kind });
      toast.success(t("records.exported", { n }));
    } catch (e) {
      reportError(e, t("records.exportFail"));
    } finally {
      setExporting(false);
    }
  };

  const clearAll = async () => {
    // 确认→清空→提示 与设置页共用一条路径（src/lib/activity.ts）；本页清完
    // 还要刷新列表，所以看返回值。
    if (await confirmAndClearActivity()) await load();
  };

  const saveRetention = async (days: number) => {
    if (!settings) return;
    try {
      await invoke("save_settings", {
        value: settingsPayload(settings, { activityRetentionDays: days }),
      });
      setSettings(await invoke<Settings>("get_settings"));
      toast.success(days === 0 ? t("records.retentionKeep") : t("records.retentionKeepDays", { n: days }));
      await load();
    } catch (e) {
      reportError(e, t("records.saveFail"));
    }
  };

  const saveCleanup = async (patch: Partial<Pick<Settings, "cleanupMode" | "cleanupKeepDays">>) => {
    if (!settings) return;
    try {
      await invoke("save_settings", { value: settingsPayload(settings, patch) });
      setSettings(await invoke<Settings>("get_settings"));
      toast.success(t("records.cleanupSaved"));
    } catch (e) {
      reportError(e, t("records.saveFail"));
    }
  };

  const togglePick = useCallback((id: string) => {
    // 没有编号的记录既不能单删也不能批删（removeOne 指向清空记录），把它勾进
    // picked 只会造出一个永远删不掉、也不进「已选 N」的幽灵选中。
    if (!id) return;
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /*
   * Row handlers passed to `RecordRow` *as-is*.
   *
   * `RecordRow` is `memo`'d, and `memo` only compares props. Handing each row a
   * fresh `() => togglePick(e.id)` arrow gives every prop a new identity on
   * every render, so the memo did nothing and 显示更多 re-rendered the whole
   * column. These three are stable for the life of the mounted view (the
   * underlying callbacks are `useCallback`'d), and the row hands the entry back
   * to them instead of closing over it.
   */
  const rowPick = useCallback((e: ActivityEntry) => togglePick(e.id), [togglePick]);
  const rowDelete = useCallback((e: ActivityEntry) => void removeOne(e), [removeOne]);
  const rowUndo = useCallback((e: ActivityEntry) => void undo(e), [undo]);
  const rowOpen = useCallback((slug: string) => setOpenSlug(slug), [setOpenSlug]);

  /**
   * Clears every condition in the filter bar, from the 没有匹配 panel.
   *
   * `deferredQuery` is written as well as `query`: the debounced mirror is what the
   * filter actually applied, so without this the sentence below would keep naming the
   * search term that was just cleared for the 150 ms before the timer lands.
   */
  const clearFilters = useCallback(() => {
    setTag("all");
    setRange("all");
    setQuery("");
    setDeferredQuery("");
  }, []);

  /**
   * The conditions that filtered everything out, and whether anything did.
   *
   * Both come from `records/filter-words.ts`, a pure module with its own test: the
   * one failure this panel must not have is falling back to the ids behind the chips
   * and telling the user that `appearance` and `7d` matched nothing.
   */
  const activeFilterWords = useMemo(
    () => filterWordsOf(tag, range, deferredQuery, chipLabelOf, t),
    [tag, range, deferredQuery, chipLabelOf, t],
  );
  const filtering = hasActiveFilter(tag, range, deferredQuery);

  // Rows appearing at the top of the list, a day-group collapsing, and a filter
  // that removes whole groups all used to be instant. auto-animate handles the
  // children it is pointed at, so both the group list and each group get one.
  const layers = useAutoLayers();

  return (
    <>
      <ViewHeader
        title={t("view.records")}
        hint={t("records.hint")}
        headerId="records-header"
        actions={
          <div className="flex items-center gap-1.5">
            {selecting ? (
              <>
                <span className="text-caption tabular-nums text-muted-foreground">
                  {t("records.selectedCount", { n: selectedCount })}
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(allSelected ? new Set() : new Set(filteredIds))}
                  className="skin-ctl border border-border px-2 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {allSelected ? t("records.deselectAll") : t("records.selectAll")}
                </button>
                <button
                  type="button"
                  onClick={() => void deletePicked()}
                  disabled={selectedCount === 0 || batchBusy}
                  className="skin-ctl flex items-center gap-1 border border-danger/40 px-2 py-1 text-caption text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                >
                  {batchBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  {t("records.deleteSelected")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelecting(false);
                    setPicked(new Set());
                  }}
                  className="skin-ctl flex items-center gap-1 border border-border px-2 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  {t("records.exitSelection")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setSelecting(true)}
                  disabled={!entries || entries.length === 0}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Check className="h-3.5 w-3.5" />
                  {t("records.batchSelect")}
                </button>
                <button
                  type="button"
                  disabled={!entries || entries.length === 0 || exporting}
                  onClick={() => void exportFile("markdown")}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("records.exportMd")}
                </button>
                <button
                  type="button"
                  disabled={!entries || entries.length === 0 || exporting}
                  onClick={() => void exportFile("jsonl")}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("records.exportJsonl")}
                </button>
                <button
                  type="button"
                  disabled={!entries || entries.length === 0 || exporting}
                  onClick={() => void exportFile("csv")}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("records.exportCsv")}
                </button>
                <button
                  type="button"
                  onClick={() => void load(true)}
                  disabled={!entries || entries.length === 0}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("records.refresh")}
                </button>
                <button
                  type="button"
                  onClick={() => void clearAll()}
                  disabled={!entries || entries.length === 0}
                  className="skin-ctl flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash className="h-3.5 w-3.5" />
                  {t("records.clearAll")}
                </button>
              </>
            )}
          </div>
        }
      />

      {/* Filter bar. Two fixed grid columns: the chips always own the left slot
          and the search box always owns the right one, at the same width, so
          neither the chip count nor the result count can move anything. */}
      <div
        {...reg("records-filter")}
        className="mb-2 grid grid-cols-[minmax(0,1fr)_12rem] items-start gap-2"
      >
        <div className="flex flex-wrap gap-1.5" {...reg("records-tag-chip-row")}>
          {TAGS.map((chip) => {
            const n = chip.id === "all" ? (entries?.length ?? 0) : (counts.get(chip.id) ?? 0);
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setTag(chip.id)}
                aria-pressed={tag === chip.id}
                className={cn(
                  "skin-ctl px-2.5 py-1 text-caption tabular-nums",
                  tag === chip.id
                    ? "bg-primary/15 font-medium text-foreground shadow-[0_0_0_1px_var(--color-primary)_inset]"
                    : "bg-muted text-muted-foreground hover:text-foreground active:scale-[0.97]",
                  n === 0 && tag !== chip.id && "opacity-45",
                )}
              >
                {chipLabelOf("tag", chip.id) ?? chip.label}
                {n > 0 && <span className="ml-1">{n}</span>}
              </button>
            );
          })}
        </div>
        <input
          value={query}
          aria-label={t("records.searchAria")}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("records.searchPlaceholder")}
          spellCheck={false}
          className="h-[1.85rem] w-full skin-ctl border border-input bg-background px-2.5 text-caption outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
        />

        <div className="col-span-2 flex flex-wrap items-center gap-1.5" {...reg("records-time-range-row")}>
          <span className="app-desc text-caption text-muted-foreground">{t("records.show")}</span>
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              aria-pressed={range === r.id}
              className={cn(
                "skin-ctl px-2 py-0.5 text-caption",
                range === r.id
                  ? "bg-primary/15 font-medium text-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground active:scale-[0.97]",
              )}
            >
              {chipLabelOf("range", r.id) ?? r.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowConfig((v) => !v)}
            className="app-desc ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-muted-foreground underline decoration-dotted transition-colors hover:text-foreground"
            title={
              autoCleanup
                ? t("records.retentionTitleAuto")
                : t("records.retentionTitleRead")
            }
          >
            <Settings2 className="h-3 w-3" />
            {badgeDays === null
              ? t("records.retentionPending")
              : badgeDays === 0
                ? t("records.retentionForever")
                : t("records.retentionDays", { n: badgeDays })}
            <ChevronDown
              className={cn("h-3 w-3 transition-transform duration-[var(--motion-state)]", showConfig && "rotate-180")}
            />
          </button>
        </div>
      </div>

      <StorageOverviewCard />

      {/* 统计洞察（r19-N1-2）：对**全部**历史的汇总，不是对当前筛选的——筛选回答
          「哪一行在哪」，面板回答「这段历史说了什么」。计算全在纯函数模块
          `lib/records-stats.ts`（有单测），没有记录时整个面板不渲染。 */}
      {entries && entries.length > 0 && (
        <StatsPanel entries={entries} t={t} tagLabel={(tag) => chipLabelOf("tag", tag) ?? tag} />
      )}

      {showConfig && (
        <div
          {...reg("records-retention-panel")}
          className="skin-panel mb-3 border border-border-weak bg-card"
        >
          <RetentionRows
            settings={settings}
            onRetention={(d) => void saveRetention(d)}
            onCleanup={(patch) => void saveCleanup(patch)}
            onGoSettings={() => {
              go("settings");
              setSettingsSection("records");
            }}
            timeFormat={timeFormat}
          />
        </div>
      )}

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-caption text-danger">
          {error}
        </div>
      )}

      {entries === null && !error && (
        <div className="flex items-center gap-2 rounded-xl border border-border-weak bg-card p-5 text-caption text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t("records.loading")}
        </div>
      )}

      {entries !== null && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border-weak bg-card px-6 py-9 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15">
            <History className="h-5 w-5 text-primary" />
          </span>
          {entries.length === 0 ? (
            <>
              <p className="mt-3 text-body font-medium">{t("records.emptyTitle")}</p>
              <p className="app-desc mt-1 max-w-md text-caption leading-snug text-muted-foreground">
                {t("records.emptyHint")}
              </p>
            </>
          ) : (
            <>
              {/* Records exist and the bar filtered all of them out — a different fact
                  from the empty log above, and one the copy has to state in the words
                  the chips use, with the way back in the same panel. Same shape as
                  项目 的「没有匹配的项目 · 清除搜索与筛选」.

                  The 清除筛选 affordance is gated on `filtering` rather than always
                  shown: an offer to clear nothing is the button equivalent of the
                  sentence this panel used to print for the wrong case. */}
              <p className="mt-3 text-body font-medium">
                {filtering ? t("records.noMatchTitle") : t("records.noVisibleTitle")}
              </p>
              {filtering && (
                <p className="app-desc mt-1 max-w-md text-caption leading-snug text-muted-foreground">
                  {t("records.noMatchHint", { words: activeFilterWords, n: entries.length })}
                </p>
              )}
              {filtering && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="skin-ctl mt-3 border border-border px-3 py-1 text-caption text-muted-foreground
                             transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
                >
                  {t("records.clearFilters")}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div ref={layers.register} className="space-y-1.5">
          {groups.slice(0, groupLimit).map((g) => {
            const isCollapsed = collapsed.has(g.key) && g.entries.length > 1;
            const latest = g.entries[0];
            return (
              <div
                key={g.key}
                ref={layers.register}
                {...reg("records-list")}
                className="skin-panel border border-border-weak bg-card"
              >
                {g.entries.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    className="flex w-full items-center gap-2 border-b border-dashed border-border-weak px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-state)]",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-caption font-medium">
                      {g.label}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 text-caption tabular-nums text-muted-foreground">
                      {t("records.times", { n: g.entries.length })}
                    </span>
                    <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                      {latest ? formatTime(latest.ts, timeFormat) : null}
                    </span>
                  </button>
                ) : null}

                {!isCollapsed &&
                  g.entries.map((e) => (
                    <RecordRow
                      key={e.id || `${e.ts}-${e.action}`}
                      entry={e}
                      grouped={g.entries.length > 1}
                      selecting={selecting}
                      picked={picked.has(e.id)}
                      onPick={rowPick}
                      onOpen={rowOpen}
                      onDelete={rowDelete}
                      deleting={deleting === e.id}
                      onUndo={e.undo && !e.undoneTs ? rowUndo : undefined}
                      undoing={undoing === e.id}
                      timeFormat={timeFormat}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Initial render is capped so a huge history paints fast; 显示更多 raises the
          cap explicitly rather than a virtualizer (no new dependency). The count in
          the label is honest — it says how many groups remain, not how many rows. */}
      {groups.length > groupLimit && (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            onClick={() => setGroupLimit((n) => n + RECORDS_GROUP_PAGE)}
            className="skin-ctl flex items-center gap-1 border border-border px-3 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
          >
            {t("records.showMore", { n: groups.length - groupLimit })}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The 记录 filter chips' dictionary lookup (r17-n1-1).
 *
 * A `switch` rather than a `Record<string, TranslationKey>` table on purpose: the
 * key-set guard in `tests/i18n.test.ts` reads call sites by the literal name `t`
 * followed by a quoted key, so a composed ``records.tag.${id}`` template would
 * register as a key nobody reads and fail the run. An unknown id returns
 * `undefined` — the caller keeps the constants table's label, exactly what the old
 * `?? t.id` lookup did for an id the row never listed.
 */
function chipLabel(t: TFunc, axis: ChipAxis, id: string): string | undefined {
  if (axis === "tag") {
    switch (id) {
      case "all":
        return t("records.tag.all");
      case "download":
        return t("records.tag.download");
      case "delete":
        return t("records.tag.delete");
      case "clear":
        return t("records.tag.clear");
      case "launch":
        return t("records.tag.launch");
      case "terminal":
        return t("records.tag.terminal");
      case "ide":
        return t("records.tag.ide");
      case "settings":
        return t("records.tag.settings");
      case "appearance":
        return t("records.tag.appearance");
      case "interface":
        return t("records.tag.interface");
      default:
        return undefined;
    }
  }
  switch (id) {
    case "all":
      return t("records.range.all");
    case "1d":
      return t("records.range.1d");
    case "7d":
      return t("records.range.7d");
    case "30d":
      return t("records.range.30d");
    case "90d":
      return t("records.range.90d");
    default:
      return undefined;
  }
}
