import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDestructive } from "../lib/confirm";
import {
  CalendarClock,
  CircleCheck,
  Clock,
  Download,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Languages,
  Network,
  ScrollText,
  Search,
  Shield,
  SlidersHorizontal,
  SquarePen,
  Stethoscope,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { cn } from "../lib/utils";
import { messageOf, reportError, swallow } from "../lib/report-error";
import { isCommitEnter } from "../lib/ime";
import { numberKeyHandler } from "../lib/number-keys";
import { useSettingsAutosave } from "../lib/useSettingsAutosave";
import { LOCALE_OPTIONS, sectionTitle, type TFunc } from "../lib/i18n";
import { searchSettings } from "../lib/settings-search";
import { useI18n } from "../lib/useI18n";
import { describeTokenReport, type TokenReport } from "../lib/token-report";
import { ViewHeader } from "../shell/AppShell";
import { PathInput } from "../components/PathInput";
import {
  ActionRow,
  ChoiceRow,
  FieldRow,
  SettingsGroup,
  SwitchRow,
} from "../components/SettingsRows";
import { toast } from "../components/Toast";
import { confirmAndClearActivity } from "../lib/activity";
import {
  ChromeGroup,
  ContentGroup,
  ResetGroup,
  SizeGroup,
  TemplateGroup,
  ThemeGroup,
} from "./AppearanceView";
import { InterfaceSection } from "../components/InterfaceRegistry";
import { AboutSection } from "./settings/AboutSection";
import { useUI } from "../store/ui";
import { SaveIndicator, SettingHeadingRow, SettingRowLite } from "./settings/rows";
import { ProjectsWallSection } from "./settings/ProjectsSection";
import { TimeFormatRow } from "./settings/TimeFormatRow";
import { CacheUsageRow } from "./settings/CacheUsageRow";
import { SettingsXferRow } from "./settings/SettingsXferRow";
import { SavedSearchesXferRow } from "./settings/SavedSearchesXferRow";
import {
  clampInt,
  DIRECTORY_KIND_HINT,
  DIRECTORY_KIND_LABEL,
  directoryRowsOf,
  type DirectoryRow,
} from "./settings/helpers";
import {
  SETTINGS_SECTIONS,
  isSettingsSectionId,
  type SettingsSectionId,
} from "../settingsCatalog";
import type {
  RepoRef,
  RootCheck,
  SettingsSave,
  SettingsView as Settings,
  ToolInfo,
} from "../types";

/** Words people search for that the section title does not contain (r25-N1).
 * Dictionary-backed: aliases are UI vocabulary, so they follow the locale
 * instead of adding another Chinese table to this file. */
const settingsSearchKeywords = (t: TFunc): Record<SettingsSectionId, readonly string[]> => ({
  roots: t("settings.search.kw.roots").split(","),
  projects: t("settings.search.kw.projects").split(","),
  network: t("settings.search.kw.network").split(","),
  editors: t("settings.search.kw.editors").split(","),
  records: t("settings.search.kw.records").split(","),
  diagnostics: t("settings.search.kw.diagnostics").split(","),
  deps: t("settings.search.kw.deps").split(","),
  token: t("settings.search.kw.token").split(","),
  appearance: t("settings.search.kw.appearance").split(","),
  interface: t("settings.search.kw.interface").split(","),
  about: t("settings.search.kw.about").split(","),
});

/**
 * Settings view.
 *
 * Everything here persists to disk and takes effect immediately - there is no
 * "apply and restart". The project root is validated by the backend before
 * saving, because a read-only location would otherwise only fail later, during
 * a download.
 *
 * Two reports shaped this component.
 *
 *   "项目目录更改之后没有生效，刷新之后又回归默认了" / "通过浏览修改项目目录不生效"
 *
 *   1. Typing a path did nothing until 保存 was clicked. The field now commits
 *      on blur and on Enter.
 *   2. A refresh re-adopted server values over an edit in progress. Refreshes
 *      leave edits alone, and `App` drops a settings payload an older save has
 *      already superseded.
 *   3. The commit path trusted a cached `check` describing the PREVIOUS path, so
 *      a picked directory was silently rejected. The commit now always validates
 *      the exact value it is about to save.
 *   4. The remaining half of "没有生效" was that nothing re-read the repository
 *      list after a root change, so the wall kept showing the old directory.
 *      A save now returns what changed, and `App` re-pulls the wall when the
 *      root moved.
 *
 *   "切换目录后旧项目消失"
 *   5. The backend now folds the previous root into 附加目录 automatically, so
 *      the old projects stay on the wall without the user noticing the setting.
 *
 * The layout is the shared row component: one setting per row, control on the
 * right, so this page and 外观 read the same way.
 */

/** Round 13 (d5-6): monotonic uid source for mirror rows; see the state below. */
let mirrorUidSeq = 0;
const nextMirrorUid = () => `mirror-${++mirrorUidSeq}`;

const FailureHistorySection = lazy(() =>
  import("./settings/FailureHistorySection").then((m) => ({ default: m.FailureHistorySection })),
);

const DockerDiagnosticsSection = lazy(() =>
  import("./settings/DockerDiagnosticsSection").then((m) => ({ default: m.DockerDiagnosticsSection })),
);

const DepsUpdateSection = lazy(() =>
  import("./settings/DepsUpdateSection").then((m) => ({ default: m.DepsUpdateSection })),
);

const DeepLinkSection = lazy(() =>
  import("./settings/DeepLinkSection").then((m) => ({ default: m.DeepLinkSection })),
);

export function SettingsView({
  settings,
  repos,
  onSaved,
  openSection,
}: {
  settings: Settings | null;
  /** The wall, so 已隐藏的项目 can be listed by name rather than by slug. */
  repos: RepoRef[];
  onSaved: (r: SettingsSave) => void;
  /**
   * A catalog page to open on mount.
   *
   * This is how "double-click a status-strip card → the setting that owns it"
   * and the 常用 page's chips work: the caller names a section, and this page —
   * which is the only one that knows its own layout — selects and flashes it.
   * (Round 9: it used to scroll; the catalog turned that into a page switch.)
   */
  openSection?: string;
}) {
  // r16-n2-2: the catalog's section titles and the 语言 row resolve through
  // the dictionary. Inner effects below bind their own `t` (terminals list,
  // root-check timer) — those are separate scopes and shadow this on purpose;
  // nothing in those closures needs a translator.
  const { locale, setLocale, t } = useI18n();
  const [root, setRoot] = useState(settings?.projectRoot ?? "");
  const [extraRoots, setExtraRoots] = useState<string[]>(settings?.extraRoots ?? []);
  const [mirror, setMirror] = useState(settings?.mirrorEnabled ?? false);
  const [ipPin, setIpPin] = useState(settings?.ipPinEnabled ?? true);
  const [proxy, setProxy] = useState(settings?.proxy ?? "");
  const [searchRoute, setSearchRoute] = useState<string>(settings?.searchRoute ?? "bypass");
  const [downloadRoute, setDownloadRoute] = useState<string>(settings?.downloadRoute ?? "bypass");
  // Empty string is a real value here, not a missing one: it is what the backend reads
  // as `full`, the default. Seeding from `settings` keeps the row honest about a
  // hand-edited config, which is the case that a "just show the default" would hide.
  const [cloneStrategy, setCloneStrategy] = useState<string>(settings?.cloneStrategy ?? "");
  const [debounce, setDebounce] = useState(String(settings?.searchDebounceMs ?? 700));
  const [parallel, setParallel] = useState(String(settings?.parallelDownloads ?? 3));
  const [mirrors, setMirrors] = useState<string[]>(settings?.effectiveMirrors ?? []);
  /**
   * Round 13 (d5-6): stable per-row identity for the mirror list. `key={i}` on a
   * list whose rows can be deleted costs the user the focus and the IME
   * pre-edit of the row they are typing in (delete a row above it and the DOM
   * node is reused by position, not by identity) — the same defect
   * `dialogs/launch/step-keys.ts` was written to fix for the launch steps.
   * The value itself cannot be the key: it changes on every keystroke. Uids are
   * assigned at creation and survive value edits; the saved payload stays a
   * plain `string[]`.
   */
  const [mirrorUids, setMirrorUids] = useState<string[]>(() =>
    (settings?.effectiveMirrors ?? []).map(() => nextMirrorUid()),
  );
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  // r18 R3: the self-check answer. Kept in this view rather than a store — one button,
  // one line, nothing else in the app asks the question, and the answer must not survive
  // a section switch (a stale "令牌被接受" under an edited field is worse than no line).
  const [tokenReport, setTokenReport] = useState<TokenReport | null>(null);
  const [tokenChecking, setTokenChecking] = useState(false);
  const [retention, setRetention] = useState(String(settings?.activityRetentionDays ?? 30));
  const [cleanupMode, setCleanupMode] = useState(settings?.cleanupMode ?? "manual");
  const [cleanupKeepDays, setCleanupKeepDays] = useState(String(settings?.cleanupKeepDays ?? 30));
  const [check, setCheck] = useState<RootCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<ToolInfo[]>([]);
  const [ides, setIdes] = useState<ToolInfo[]>([]);
  /**
   * Round 13 (d4-2): the pickers used to render "本机未检测到" on an IPC
   * failure, because the `catch` was empty and the lists stayed `[]`. That is an
   * assertion about the user's machine made from a backend error - the same
   * commands in `ProjectSettingsDialog` report the failure. Three states now:
   * loading (asked, no answer yet), failed (asked, refused), ready (answered).
   */
  const [toolsState, setToolsState] = useState<"loading" | "failed" | "ready">("loading");

  /**
   * 需求2：没有「未保存的改动」这回事了。
   *
   * 改动分两种，只有一种值得提示：开关/选择类点下去就写完了（用户看得见自己
   * 点的什么），文本类在 800ms 防抖窗口内还没落盘——这段窗口里切走页面才会
   * 真的丢东西，所以它是唯一需要说出来的那一种。`dirtyRef` 原本还兼着"别用
   * 服务端值覆盖正在编辑的内容"这个职责，那个职责改由 `editingRef` 承担。
   */
  const editingRef = useRef(false);

  // Adopt late-arriving settings once - but never over an edit in progress.
  useEffect(() => {
    if (!settings || editingRef.current) return;
    setRoot(settings.projectRoot);
    setExtraRoots(settings.extraRoots);
    setMirror(settings.mirrorEnabled);
    setIpPin(settings.ipPinEnabled);
    setProxy(settings.proxy);
    setMirrors(settings.effectiveMirrors);
    // Same length → the rows are the same rows; regenerating uids here would
    // remount (and unfocus) every row on each debounced save while typing.
    setMirrorUids((prev) =>
      prev.length === settings.effectiveMirrors.length
        ? prev
        : settings.effectiveMirrors.map(() => nextMirrorUid()),
    );
    setRetention(String(settings.activityRetentionDays));
    setCleanupMode(settings.cleanupMode);
    setCleanupKeepDays(String(settings.cleanupKeepDays));
    setSearchRoute(settings.searchRoute);
    setDownloadRoute(settings.downloadRoute);
    setCloneStrategy(settings.cloneStrategy);
    setDebounce(String(settings.searchDebounceMs));
    setParallel(String(settings.parallelDownloads));
  }, [settings]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, i] = await Promise.all([
          invoke<ToolInfo[]>("list_terminals"),
          invoke<ToolInfo[]>("list_ides"),
        ]);
        if (!alive) return;
        setTerminals(t);
        setIdes(i);
        setToolsState("ready");
      } catch (e) {
        // Not silent any more: an empty picker next to "本机未检测到" is a claim
        // about the machine that a failed IPC cannot make (d4-2).
        if (!alive) return;
        setToolsState("failed");
        reportError(e, t("settings.page.toolsListFailed"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  // Monotonic id for the root check below (the App.tsx `settingsSeq` idea): the
  // 300 ms debounce only sequences the timers, not the awaited invokes — type
  // path A, then quickly B, and A's slow reply can land last and overwrite B's
  // verdict with a check for a path nobody typed last.
  const rootCheckSeq = useRef(0);
  useEffect(() => {
    const mine = ++rootCheckSeq.current;
    const t = setTimeout(async () => {
      if (!root.trim()) {
        if (mine === rootCheckSeq.current) setCheck(null);
        return;
      }
      try {
        const res = await invoke<RootCheck>("validate_project_root", { path: root });
        if (mine === rootCheckSeq.current) setCheck(res);
      } catch {
        if (mine === rootCheckSeq.current) setCheck(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [root]);

  /**
   * Persists the whole page as one settings document.
   *
   * 需求2（自动保存）的两个要点：
   *
   * 1. `silent` —— 自动保存意味着一次保存可能只是用户拨动了一个开关，弹出
   *    「设置已保存」对这种动作是噪声。真正需要告知的是它**改变了什么**（切主
   *    目录会牵动项目墙、删 Token 会失效登录），那正是后端 `notes` 的用途。
   *
   * 2. 值一律从 `latestRef` 读，而不是从闭包里的 state 读。设置页是整页一个
   *    文档：后端 `apply_settings_update` 会把没传的字段原样保留，所以每次保存
   *    实际都提交了**全部**字段。若这里读闭包值，用户在一次防抖窗口内连改
   *    「代理」和「同时下载数」，第二次保存就会带着第一次之前的 `proxy` 落盘，
   *    把刚写对的值又改回去——而界面上仍然显示新值，看起来"保存了却没生效"。
   *    ref 在每次渲染后刷新，因此无论这次保存由谁触发，读到的都是最新值。
   */
  const latestRef = useRef<Record<string, unknown>>({});
  latestRef.current = {
    projectRoot: root,
    mirrorEnabled: mirror,
    ipPinEnabled: ipPin,
    mirrors,
    proxy,
    githubToken: token,
    clearGithubToken: clearToken,
    extraRoots,
    activityRetentionDays: Number(retention),
    cleanupMode,
    cleanupKeepDays: Number(cleanupKeepDays),
    searchRoute,
    downloadRoute,
    cloneStrategy,
    searchDebounceMs: Number(debounce) || 0,
    parallelDownloads: Number(parallel) || 1,
  };

  const save = async (
    overrides?: Record<string, unknown>,
    opts?: { silent?: boolean },
  ): Promise<SettingsSave | null> => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<SettingsSave>("save_settings", {
        // A "switch to this directory" click has the new path in hand and
        // cannot wait for React to flush `setRoot` first, so explicit overrides
        // still win over the snapshot.
        value: { ...latestRef.current, ...overrides },
      });
      onSaved(next);
      setToken("");
      setClearToken(false);
      // Say what changed, not just that something was saved.
      if (next.notes.length > 0) toast.success(next.notes.join("；"));
      else if (!opts?.silent) toast.success(t("settings.page.savedNoChange"));
      return next;
    } catch (e) {
      // The reason goes in the page's own banner — which has no heading of its
      // own, so the verb rides in the string — and the toast stays terse, or the
      // same sentence shows twice within six seconds.
      setError(t("settings.page.saveFailed", { msg: messageOf(e) }));
      toast.error(t("settings.page.saveFailedShort"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------------------
  // 自动保存（防抖/合并调度器抽到 lib/useSettingsAutosave，并修好"单飞"守卫）
  // ---------------------------------------------------------------------------

  const { saveNow, saveSoon, commitSoon, discardPending, queued } = useSettingsAutosave(save);

  const debounceKeys = numberKeyHandler({
    min: 0,
    max: 30000,
    step: 100,
    apply: (n) => {
      setDebounce(String(n));
      saveSoon({ searchDebounceMs: n });
    },
    commit: commitSoon,
  });
  const parallelKeys = numberKeyHandler({
    min: 1,
    max: 6,
    step: 1,
    apply: (n) => {
      setParallel(String(n));
      saveSoon({ parallelDownloads: n });
    },
    commit: commitSoon,
  });

  // A queued write must not be dropped by closing the view mid-debounce: that
  // unmount flush now lives inside useSettingsAutosave (flush is fire-and-forget
  // — the save only touches the backend and the store, not this component).

  /**
   * Applies the project directory as soon as the field is left (or Enter is
   * pressed, or 浏览 picked a folder). Validation is ALWAYS re-run against the
   * value being saved: the debounced `check` in state may still describe the
   * previous path, which is exactly why a picked directory used to be silently
   * rejected.
   *
   * `editingRef` is cleared at the end whatever the outcome — including the
   * early return for an unchanged path and the validation failure. It means
   * "a keystroke has not been committed yet"; leaving it set would freeze this
   * view's adoption of every later settings payload (from `forget_recent_root`,
   * a tool choice, a root switch elsewhere) for the rest of the session, and the
   * symptom would be a list that refuses to update no matter what you click.
   */
  const commitRoot = async () => {
    const value = root.trim();
    if (!value || value === settings?.projectRoot) {
      editingRef.current = false;
      return;
    }
    setBusy(true);
    let ok = false;
    try {
      const c = await invoke<RootCheck>("validate_project_root", { path: value });
      setCheck(c);
      ok = c.ok;
    } catch {
      ok = false;
    } finally {
      setBusy(false);
    }
    if (!ok) {
      // Still an edit in progress — the field keeps the rejected text so the
      // user can correct it rather than have it silently snap back.
      // But editingRef must be reset: leaving it true would freeze this
      // view's adoption of every later settings payload for the rest of the
      // session, and the symptom would be a list that refuses to update.
      editingRef.current = false;
      return;
    }
    editingRef.current = false;
    await save();
  };

  /** Adds a directory to the extra-roots list, validating it first. */
  const addExtraRoot = async (picked: string) => {
    const value = picked.trim();
    if (!value) return;
    if (value === root.trim() || extraRoots.some((r) => r === value)) {
      toast.info(t("settings.page.dirAlreadyListed"));
      return;
    }
    try {
      const c = await invoke<RootCheck>("validate_project_root", { path: value });
      if (!c.ok) {
        toast.error(t("settings.page.dirUnavailable", { msg: c.message }));
        return;
      }
    } catch {
      toast.error(t("settings.page.dirCheckFailed"));
      return;
    }
    setExtraRoots((r) => {
      const next = [...r, value];
      saveNow({ extraRoots: next });
      return next;
    });
    toast.success(t("settings.page.addedExtra"));
  };

  const browseExtraRoot = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.page.pickExtraDir"),
      });
      if (typeof picked === "string" && picked) await addExtraRoot(picked);
    } catch {
      /* picker cancelled or failed: nothing to add */
    }
  };

  /** A manually specified IDE executable: the escape hatch for missed installs. */
  const addCustomIde = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        title: t("settings.page.pickIdeExe"),
        filters: [{ name: t("settings.page.exeFilter"), extensions: ["exe"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const list = await invoke<ToolInfo[]>("add_custom_ide", { path: picked });
      setIdes(list);
      toast.success(t("settings.page.addedNamed", { name: picked.split(/[\\/]/).pop() ?? picked }));
    } catch (e) {
      reportError(e, t("settings.page.addIdeFailed"));
    }
  };

  const removeCustomIde = async (path: string) => {
    try {
      const list = await invoke<ToolInfo[]>("remove_custom_ide", { path });
      setIdes(list);
      toast.success(t("settings.page.removed"));
    } catch (e) {
      reportError(e, t("settings.page.removeIdeFailed"));
    }
  };

  const rootBlocked = check != null && !check.ok;
  const customIdes = settings?.customIdes ?? [];

  // 需求3：把附加目录与历史目录合成一张列表。
  //
  // 优先级：当前主目录 > 附加 > 历史。同一条路径可能在两边都存在（例如切换
  // 主目录时后端会自动把旧主目录收进附加，而它同时还留在 recent_roots 里），
  // 这时只保留一行并按更强的那个身份显示——两行同路径会让「移除」看起来没生效。
  // 合并、判重（忽略大小写）与三段排序的完整规则在 helpers.directoryRowsOf
  // 里，连同它的单测一起。
  const directoryRows: DirectoryRow[] = useMemo(
    () => directoryRowsOf({ current: root, extra: extraRoots, recent: settings?.recentRoots ?? [] }),
    [root, extraRoots, settings?.recentRoots],
  );

  /**
   * Removes one directory from the merged list (需求2/需求3).
   *
   * 两条路的落盘时机不同，原因是后端的：附加目录走既有的 save_settings 通路
   * 即可；而历史目录**不能**走那条路——apply_settings_update 每次都会把
   * recent_roots 整体重算，把刚删的条目原样写回来（见该函数注释），所以它有
   * 自己的 forget_recent_root 命令。附加目录的删除因此也立刻保存，否则用户
   * 点完「移除」看到它消失、刷新又回来。
   */
  const forgetDirectory = async (path: string, kind: DirectoryRow["kind"]) => {
    if (kind === "recent") {
      setBusy(true);
      try {
        const next = await invoke<SettingsSave>("forget_recent_root", { path });
        onSaved(next);
        toast.success(t("settings.page.recentRemoved"));
      } catch (e) {
        reportError(e, t("settings.page.removeRecentFailed"));
      } finally {
        setBusy(false);
      }
      return;
    }
    setExtraRoots((r) => {
      const next = r.filter((x) => x.trim().toLowerCase() !== path.toLowerCase());
      void saveNow({ extraRoots: next });
      return next;
    });
  };

  /**
   * Which catalog page is showing (round 9, 需求 10).
   *
   * Local rather than in the UI store: it is this page's own navigation state
   * and the deep-link effect below is its only outside writer. Text-field
   * drafts survive a page switch because the save debounce lives in this
   * component, not in the sections - unmounting a section cannot drop a queued
   * save, and clicking the catalog blurs the field first anyway.
   */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() =>
    isSettingsSectionId(openSection ?? "") ? (openSection as SettingsSectionId) : "roots",
  );

  // r25-N1: filter the catalog by what the page actually shows. The data label is
  // searchable too (it is what tests key against), but the visible title comes
  // from the dictionary so EN users can type English.
  const [sectionQuery, setSectionQuery] = useState("");
  const sectionHits = useMemo(
    () => {
      const keywords = settingsSearchKeywords(t);
      return searchSettings(
        SETTINGS_SECTIONS.map((s) => ({
          id: s.id,
          label: sectionTitle(t, s.id),
          keywords: keywords[s.id],
        })),
        sectionQuery,
      );
    },
    [t, sectionQuery],
  );
  const visibleSections = useMemo(
    () =>
      sectionQuery.trim()
        ? sectionHits.flatMap((hit) => SETTINGS_SECTIONS.filter((s) => s.id === hit.id))
        : SETTINGS_SECTIONS,
    [sectionHits, sectionQuery],
  );

  // Deep link: switch to the named catalog page (round 9, 需求 10 - the page
  // used to be one long scroll and a link could only jump down it) and flash
  // the section, then clear the request so a later re-render does not yank
  // the page back.
  const pendingSection = useUI((s) => s.settingsSection);
  const clearPendingSection = useUI((s) => s.setSettingsSection);
  useEffect(() => {
    const id = pendingSection ?? openSection;
    // `return undefined`, not a bare `return`: the branch below hands React a
    // cleanup function, and `noImplicitReturns` refuses a callback that returns
    // a value on one path and nothing on another. Behaviour is identical — React
    // treats both as "nothing to clean up" — but the types now say what they mean.
    if (!id) return undefined;
    if (isSettingsSectionId(id)) {
      setActiveSection(id);
      // The section mounts with the switch, so the flash waits a frame for it.
      // The inner timer is tracked too: the old cleanup only cleared the 80 ms
      // one, so leaving the page within 1.7 s left a timeout writing to a class
      // on an element that may no longer exist (or worse, reusing the id).
      let flashTimer: number | null = null;
      const t = window.setTimeout(() => {
        const el = document.querySelector(`[data-section="${id}"]`);
        if (el) {
          el.classList.add("section-flash");
          flashTimer = window.setTimeout(() => el.classList.remove("section-flash"), 1600);
        }
      }, 80);
      if (pendingSection) clearPendingSection(null);
      return () => {
        window.clearTimeout(t);
        if (flashTimer !== null) window.clearTimeout(flashTimer);
      };
    }
    if (pendingSection) clearPendingSection(null);
    // The third path: an id that is not a known section. Also "nothing to clean
    // up", and now stated — this fall-through is the reason the flag is worth
    // having, since a bare `return` above only covers half of them.
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSection, openSection]);

  /** A tool-choice change writes through its own command, so re-pull settings. */
  const reloadAfterToolChoice = () => {
    // The choice already reached disk through its own command; drop anything
    // still sitting in the debounce queue so a later flush cannot write the
    // pre-change value back over it.
    discardPending();
    void invoke<Settings>("get_settings")
      .then((s) => onSaved({ settings: s, notes: [], rootChanged: false }))
      // The reason belongs in the parameter, which is why it is not optional.
      .catch((e) => swallow(e, "the tool choice was already saved and reported by its own command; this read only refreshes the display"));
  };

  return (
    <>
      <ViewHeader
        title={t("view.settings")}
        hint={t("settings.page.hint")}
        actions={<SaveIndicator busy={busy} queued={queued} blocked={rootBlocked} />}
      />

      {rootBlocked && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("settings.page.rootBlocked", { msg: check?.message ?? "" })}</span>
        </div>
      )}

      {/* 需求 10: a catalog on the left, one page on the right. The page used
          to be every section stacked in one scroll, which is what "设置页面中
          应当有目录功能，将设置中的功能划分为多个页面" asked to change. */}
      <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-3">
        <nav
          aria-label={t("settings.page.catalogAria")}
          onKeyDown={(e) => {
            // ↑↓/Home/End 在目录里循环移动焦点——和侧栏、Segmented 一致。
            // 搜索框自己处理 Enter/Esc；在输入框里按方向键不应抢走焦点。
            if (e.target instanceof HTMLInputElement) return;
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
            const stops = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
            if (stops.length === 0) return;
            e.preventDefault();
            const idx = stops.indexOf(document.activeElement as HTMLElement);
            if (e.key === "Home") stops[0]?.focus();
            else if (e.key === "End") stops[stops.length - 1]?.focus();
            else {
              const next =
                e.key === "ArrowDown"
                  ? (idx + 1 + stops.length) % stops.length
                  : (idx - 1 + stops.length) % stops.length;
              stops[idx < 0 ? (e.key === "ArrowDown" ? 0 : stops.length - 1) : next]?.focus();
            }
          }}
          className="sticky top-0 z-[var(--z-panel)] flex flex-col gap-0.5 rounded-xl border border-border-weak bg-card p-1.5"
        >
          <input
            value={sectionQuery}
            type="search"
            onChange={(e) => setSectionQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = sectionHits[0];
                if (first) setActiveSection(first.id as SettingsSectionId);
              } else if (e.key === "Escape") {
                setSectionQuery("");
              }
            }}
            placeholder={t("settings.search.placeholder")}
            aria-label={t("settings.search.aria")}
            className="mb-1 w-full rounded-md border border-border-weak bg-background px-2 py-1 text-caption text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {visibleSections.length === 0 && (
            <p className="px-2 py-1.5 text-caption text-muted-foreground">{t("settings.search.empty")}</p>
          )}
          {visibleSections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              aria-current={activeSection === s.id ? "page" : undefined}
              className={cn(
                "skin-ctl flex items-center gap-2 px-2 py-1.5 text-left text-caption transition-colors",
                activeSection === s.id
                  ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className={cn("shrink-0", activeSection === s.id && "text-primary")}>{s.icon}</span>
              {/* r16-n2-2: title from the dictionary; the catalog keeps its own
                  zh-CN label as the source the dictionary was keyed against. */}
              <span className="min-w-0 flex-1 truncate">{sectionTitle(t, s.id)}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0">
      {activeSection === "roots" && (
      <>
      <SettingsGroup
        title={t("settings.page.rootsTitle")}
        regId="settings-group-roots"
        sectionId="roots"
        footnote={
          <>
            {t("settings.page.rootsFootnoteLead")}<code>&lt;repo&gt;_&lt;owner&gt;</code>{t("settings.page.rootsFootnoteTail")}
          </>
        }
      >
        <FieldRow
          icon={<FolderOpen className="h-4 w-4" />}
          align="stack"
          title={t("settings.page.mainDirTitle")}
          hint={
            <>
              {t("settings.page.mainDirHint")}
              {settings?.projectRootIsDefault && t("settings.page.mainDirHintDefault")}
            </>
          }
        >
          <PathInput
            value={root}
            onChange={(v) => {
              setRoot(v);
              // Not auto-saved like the other text fields: a half-typed path
              // ("D:\app\项" on the way to "D:\app\项目") is not a directory, and
              // the backend creates whatever it is handed. commitRoot validates
              // first and commits on blur / Enter / 浏览.
              editingRef.current = true;
            }}
            onCommit={() => void commitRoot()}
            placeholder={t("settings.page.rootPlaceholder")}
            label={t("settings.page.mainDirField")}
            invalid={rootBlocked}
          />
          {check && (
            <div
              className={cn(
                "mt-2 flex items-start gap-2 rounded-lg p-2 text-caption",
                check.ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
              )}
            >
              {check.ok ? (
                <CircleCheck className="mt-0.5 h-3 w-3 shrink-0" />
              ) : (
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span>{check.message}</span>
            </div>
          )}
        </FieldRow>

        {/* 需求3：附加目录与历史目录合并为一张列表。
            原来是两个独立列表，各说各的（「这些也一起显示」/「你以前放在这儿」）。
            分开的后果是同一个目录出现在两个地方、而"切回这里"和"移除"分属两处，
            用户要判断自己面对的到底是哪一个。合并后每行用徽章说明它凭什么在列表里，
            当前主目录置顶且不可移除。 */}
        {directoryRows.length === 0 ? (
          <ActionRow
            icon={<SlidersHorizontal className="h-4 w-4" />}
            title={t("settings.page.rootsTitle")}
            hint={t("settings.page.rootsEmptyHint")}
            actionLabel={t("settings.page.browse")}
            secondary
            onAction={() => void browseExtraRoot()}
          />
        ) : (
          <>
            <SettingHeadingRow
              title={t("settings.page.rootsTitle")}
              hint={t("settings.page.rootsListHint")}
              onBrowse={() => void browseExtraRoot()}
            />
            {directoryRows.map((row) => (
              <SettingRowLite key={row.path}>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-caption",
                    row.kind === "current" && "bg-primary/15 text-primary",
                    row.kind === "extra" && "bg-border/60 text-muted-foreground",
                    row.kind === "recent" && "bg-border/40 text-muted-foreground",
                  )}
                  title={DIRECTORY_KIND_HINT[row.kind]}
                >
                  {DIRECTORY_KIND_LABEL[row.kind]}
                </span>
                <code
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-caption",
                    row.kind === "current" && "font-medium text-foreground",
                  )}
                  title={row.path}
                >
                  {row.path}
                </code>
                {row.kind !== "current" && (
                  <>
                    {row.kind === "recent" && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = extraRoots.includes(row.path)
                            ? extraRoots
                            : [...extraRoots, row.path];
                          setExtraRoots(next);
                          void saveNow({ extraRoots: next });
                        }}
                        className="shrink-0 rounded px-1.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        title={t("settings.page.addExtraHint")}
                      >
                        {t("settings.page.addExtra")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRoot(row.path);
                        void save({ projectRoot: row.path });
                      }}
                      disabled={busy}
                      className="shrink-0 rounded px-1.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                      title={t("settings.page.setMainTitle", { path: row.path })}
                    >
                      {t("settings.page.setMain")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void forgetDirectory(row.path, row.kind)}
                      disabled={busy}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      title={row.kind === "recent" ? t("settings.page.removeRecent") : t("settings.page.remove")}
                      aria-label={row.kind === "recent" ? t("settings.page.removeRecent") : t("settings.page.remove")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </SettingRowLite>
            ))}
          </>
        )}
        <SettingsXferRow
          settings={settings}
          onImport={(patch) => saveNow(patch)}
        />
        <SavedSearchesXferRow />
      </SettingsGroup>
      {/* r21 N3-1: deep link 注册自成一组（有自己的标题与状态），与上面的目录组
          并列而不是塞进「项目目录」标题下——它写的是注册表，不是目录。放在这一页
          是因为它是默认落地页、且这一页本就承载应用级工具行（设置/搜索的导入导出）。 */}
      <Suspense fallback={null}>
        <DeepLinkSection />
      </Suspense>
      </>
      )}

      {activeSection === "projects" && <ProjectsWallSection repos={repos} />}

      {activeSection === "network" && (
      <SettingsGroup
        title={t("settings.section.network")}
        regId="settings-group-network"
        sectionId="network"
        footnote={t("settings.page.networkFootnote")}
      >
        <SwitchRow
          icon={<Shield className="h-4 w-4" />}
          title={t("settings.page.ipPinTitle")}
          hint={t("settings.page.ipPinHint")}
          checked={ipPin}
          onChange={(v) => {
            setIpPin(v);
            void saveNow({ ipPinEnabled: v });
          }}
        />
        <SwitchRow
          icon={<Network className="h-4 w-4" />}
          title={t("settings.page.mirrorTitle")}
          hint={t("settings.page.mirrorHint")}
          checked={mirror}
          onChange={(v) => {
            setMirror(v);
            void saveNow({ mirrorEnabled: v });
          }}
        />
        <FieldRow
          icon={<Zap className="h-4 w-4" />}
          align="stack"
          title={t("settings.page.proxyTitle")}
          hint={
            <>
              {t("settings.page.proxyHintLead")}
              <strong className="text-foreground">{t("settings.page.proxyHintStrong")}</strong>
              {t("settings.page.proxyHintTail")}
            </>
          }
        >
          <input
            value={proxy}
            aria-label={t("settings.page.proxyAria")}
            onChange={(e) => {
              setProxy(e.target.value);
              saveSoon({ proxy: e.target.value });
            }}
            onBlur={commitSoon}
            onKeyDown={(e) => {
              if (isCommitEnter(e)) commitSoon();
            }}
            placeholder={t("settings.page.proxyPlaceholder")}
            spellCheck={false}
            className="w-full skin-ctl border border-input bg-background px-3 py-2 font-mono text-caption outline-none focus:border-primary"
          />
        </FieldRow>
        <FieldRow
          icon={<Search className="h-4 w-4" />}
          align="stack"
          title={t("settings.page.mirrorsTitle")}
          hint={t("settings.page.mirrorsHint")}
        >
          <div className="space-y-2">
            {mirrors.map((m, i) => (
              <div key={mirrorUids[i] ?? `mirror-fallback-${i}`} className="flex gap-2">
                <input
                  value={m}
                  aria-label={t("settings.page.mirrorAria", { i: i + 1 })}
                  onChange={(e) => {
                    const next = [...mirrors];
                    next[i] = e.target.value;
                    setMirrors(next);
                    saveSoon({ mirrors: next });
                  }}
                  onBlur={commitSoon}
                  onKeyDown={(e) => {
                    if (isCommitEnter(e)) commitSoon();
                  }}
                  placeholder={t("settings.page.mirrorPlaceholder")}
                  spellCheck={false}
                  className="min-w-0 flex-1 skin-ctl border border-input bg-background px-2 py-1.5 font-mono text-caption outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = mirrors.filter((_, j) => j !== i);
                    setMirrors(next);
                    setMirrorUids(mirrorUids.filter((_, j) => j !== i));
                    void saveNow({ mirrors: next });
                  }}
                  className="rounded-lg border border-border px-2 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                  title={t("settings.page.remove")}
                  aria-label={t("settings.page.removeMirror")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {mirrors.length === 0 && (
              <p className="text-caption text-muted-foreground">{t("settings.page.mirrorsEmpty")}</p>
            )}
            <button
              type="button"
              onClick={() => {
                // Only the empty row is added here — it is not written until the
                // user types a value, because an empty mirror URL is not a
                // setting, it is a half-typed one.
                setMirrors([...mirrors, ""]);
                setMirrorUids([...mirrorUids, nextMirrorUid()]);
              }}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FolderPlus className="h-3 w-3" />
              {t("settings.page.addMirror")}
            </button>
          </div>
        </FieldRow>

        {/* 链路选择。默认「绕过」：当本地加速工具改写 hosts 时，跟随它会让 curl
            撞上它的自签证书并卡在吊销检查上——这正是被报告的那个报错。 */}
        <ChoiceRow
          icon={<Shield className="h-4 w-4" />}
          title={t("settings.page.searchRouteTitle")}
          hint={t("settings.page.searchRouteHint")}
          value={searchRoute}
          options={[
            { id: "bypass", label: t("settings.page.routeBypass") },
            { id: "useHosts", label: t("settings.page.routeUseHosts") },
          ]}
          onChange={(id) => {
            setSearchRoute(id);
            void saveNow({ searchRoute: id });
          }}
          regId="settings-row-search-route"
        />
        <ChoiceRow
          icon={<Network className="h-4 w-4" />}
          title={t("settings.page.downloadRouteTitle")}
          hint={t("settings.page.downloadRouteHint")}
          value={downloadRoute}
          options={[
            { id: "bypass", label: t("settings.page.routeBypass") },
            { id: "useHosts", label: t("settings.page.routeUseHosts") },
          ]}
          onChange={(id) => {
            setDownloadRoute(id);
            void saveNow({ downloadRoute: id });
          }}
          regId="settings-row-download-route"
        />
        <ChoiceRow
          icon={<Network className="h-4 w-4" />}
          title={t("settings.page.cloneStrategyTitle")}
          hint={t("settings.page.cloneStrategyHint")}
          value={cloneStrategy}
          options={[
            { id: "", label: t("settings.page.cloneFull") },
            { id: "shallow", label: t("settings.page.cloneShallow") },
            { id: "blobless", label: t("settings.page.cloneBlobless") },
          ]}
          onChange={(id) => {
            setCloneStrategy(id);
            void saveNow({ cloneStrategy: id });
          }}
          regId="settings-row-clone-strategy"
        />
        {settings?.hostsHijacked && (
          <div className="flex items-start gap-2 border-t border-dashed border-border-weak bg-info/5 px-2.5 py-2 text-caption text-info">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {t("settings.page.hostsNotice", {
                by: settings.hostsBy ? t("settings.page.hostsByParen", { by: settings.hostsBy }) : "",
                search: searchRoute === "bypass" ? t("settings.page.routeBypassed") : t("settings.page.routeUseHostsShort"),
                download: downloadRoute === "bypass" ? t("settings.page.routeBypassed") : t("settings.page.routeUseHostsShort"),
              })}
            </span>
          </div>
        )}
        <FieldRow
          icon={<Search className="h-4 w-4" />}
          title={t("settings.page.debounceTitle")}
          hint={t("settings.page.debounceHint")}
          regId="settings-row-debounce"
        >
          <input
            type="number"
            min={0}
            max={30000}
            step={100}
            value={debounce}
            aria-label={t("settings.page.debounceAria")}
            onChange={(e) => {
              setDebounce(e.target.value);
              // Committed on blur, not per keystroke: a number field passes
              // through "" and "7" on the way to "700", and writing those would
              // be saving two settings the user never chose.
              saveSoon({ searchDebounceMs: clampInt(e.target.value, 0, 30000, 700) });
            }}
            onKeyDown={debounceKeys}
            onBlur={commitSoon}
            className="w-24 skin-ctl border border-input bg-background px-2 py-1 text-caption tabular-nums outline-none focus:border-primary"
          />
        </FieldRow>
        <FieldRow
          icon={<Download className="h-4 w-4" />}
          title={t("settings.page.parallelTitle")}
          hint={t("settings.page.parallelHint")}
          regId="settings-row-parallel"
        >
          <input
            type="number"
            min={1}
            max={6}
            step={1}
            value={parallel}
            aria-label={t("settings.page.parallelAria")}
            onChange={(e) => {
              setParallel(e.target.value);
              saveSoon({ parallelDownloads: clampInt(e.target.value, 1, 6, 3) });
            }}
            onKeyDown={parallelKeys}
            onBlur={commitSoon}
            className="w-24 skin-ctl border border-input bg-background px-2 py-1 text-caption tabular-nums outline-none focus:border-primary"
          />
        </FieldRow>
        {/* r18 N2: 这一页的开关控制链路怎么走，但「现在到底出了什么问题」
            需要一次读数 + 分级结论——交给网络诊断对话框，它每次打开都重新探测。 */}
        <ActionRow
          icon={<Stethoscope className="h-4 w-4" />}
          title={t("netdiag.title")}
          hint={t("netdiag.paletteNote")}
          actionLabel={t("netdiag.open")}
          onAction={() => useUI.getState().setNetDiagOpen(true)}
          secondary
        />
      </SettingsGroup>
      )}

      {activeSection === "editors" && (
      <SettingsGroup
        title={t("settings.page.editorsTitle")}
        regId="settings-group-editors"
        sectionId="editors"
        footnote={t("settings.page.editorsFootnote")}
      >
        <ChoiceRow
          icon={<Terminal className="h-4 w-4" />}
          title={t("settings.page.terminalTitle")}
          hint={
            toolsState === "failed"
              ? t("settings.page.terminalFailed")
              : toolsState === "loading"
                ? t("settings.page.terminalLoading")
                : terminals.length === 0
                  ? t("settings.page.terminalEmpty")
                  : t("settings.page.terminalCount", { n: terminals.length })
          }
          value={settings?.terminalChoice ?? ""}
          options={[
            { id: "", label: t("settings.page.terminalAuto") },
            ...terminals.map((tool) => ({ id: tool.id, label: tool.label })),
          ]}
          onChange={async (id) => {
            try {
              await invoke("save_tool_choice", { kind: "terminal", id });
              toast.success(t("settings.page.terminalUpdated"));
              reloadAfterToolChoice();
            } catch (e) {
              reportError(e, t("settings.page.terminalUpdateFailed"));
            }
          }}
        />
        <ChoiceRow
          icon={<SquarePen className="h-4 w-4" />}
          title={t("settings.page.ideTitle")}
          hint={
            toolsState === "failed"
              ? t("settings.page.ideFailed")
              : toolsState === "loading"
                ? t("settings.page.ideLoading")
                : ides.length === 0
                  ? t("settings.page.ideEmpty")
                  : t("settings.page.ideCount", { n: ides.length, list: ides.map((i) => i.label).join("、") })
          }
          value={settings?.ideChoice ?? ""}
          options={[{ id: "", label: t("settings.page.ideAuto") }, ...ides.map((tool) => ({ id: tool.id, label: tool.label }))]}
          onChange={async (id) => {
            try {
              await invoke("save_tool_choice", { kind: "ide", id });
              toast.success(t("settings.page.ideUpdated"));
              reloadAfterToolChoice();
            } catch (e) {
              reportError(e, t("settings.page.ideUpdateFailed"));
            }
          }}
        />
        <ActionRow
          icon={<FolderPlus className="h-4 w-4" />}
          title={t("settings.page.customIdeTitle")}
          hint={t("settings.page.customIdeHint")}
          actionLabel={t("settings.page.chooseApp")}
          secondary
          onAction={() => void addCustomIde()}
        />
        {customIdes.map((p) => (
          <SettingRowLite key={p}>
            <code className="min-w-0 flex-1 truncate font-mono text-caption" title={p}>
              {p}
            </code>
            <button
              type="button"
              onClick={() => void removeCustomIde(p)}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
              aria-label={t("settings.page.removeCustomIde")}
              title={t("settings.page.removeCustomIde")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </SettingRowLite>
        ))}
      </SettingsGroup>
      )}

      {activeSection === "records" && (
      <SettingsGroup
        title={t("settings.section.records")}
        regId="settings-group-records"
        sectionId="records"
        footnote={t("settings.page.recordsFootnote")}
      >
        <ChoiceRow
          icon={<Clock className="h-4 w-4" />}
          title={t("records.retention.title")}
          hint={t("records.retention.hint")}
          value={retention}
          options={[
            { id: "7", label: t("records.retention.days", { n: 7 }) },
            { id: "30", label: t("records.retention.days", { n: 30 }) },
            { id: "90", label: t("records.retention.days", { n: 90 }) },
            { id: "0", label: t("records.retention.forever") },
          ]}
          onChange={(id) => {
            setRetention(id);
            void saveNow({ activityRetentionDays: Number(id) });
          }}
        />
        <ChoiceRow
          icon={<CalendarClock className="h-4 w-4" />}
          title={t("records.cleanup.title")}
          hint={t("settings.page.cleanupHint")}
          value={cleanupMode}
          options={[
            { id: "manual", label: t("records.cleanup.manual") },
            { id: "daily", label: t("records.cleanup.daily") },
            { id: "weekly", label: t("records.cleanup.weekly") },
            { id: "monthly", label: t("records.cleanup.monthly") },
          ]}
          onChange={(id) => {
            setCleanupMode(id as Settings["cleanupMode"]);
            void saveNow({ cleanupMode: id });
          }}
        />
        {cleanupMode !== "manual" ? (
          <ChoiceRow
            icon={<Clock className="h-4 w-4" />}
            title={t("records.keep.title")}
            hint={t("records.keep.hint")}
            value={cleanupKeepDays}
            options={[
              { id: "7", label: t("records.retention.days", { n: 7 }) },
              { id: "30", label: t("records.retention.days", { n: 30 }) },
              { id: "90", label: t("records.retention.days", { n: 90 }) },
              { id: "0", label: t("records.retention.forever") },
            ]}
            onChange={(id) => {
              setCleanupKeepDays(id);
              void saveNow({ cleanupKeepDays: Number(id) });
            }}
          />
        ) : (
          /* Same reason as 记录页: hiding it outright reads as a broken
             setting. Say why it is not here. */
          <div className="flex items-start gap-2 px-2.5 py-1.5 text-caption text-muted-foreground">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
            <span>
              {t("settings.page.keepDisabledNote")}
            </span>
          </div>
        )}
        <TimeFormatRow />
        <CacheUsageRow />
        <ActionRow
          icon={<ScrollText className="h-4 w-4" />}
          title={t("settings.page.clearRecordsTitle")}
          hint={t("settings.page.clearRecordsHint")}
          actionLabel={t("settings.page.clear")}
          danger
          onAction={async () => {
            // 确认→清空→提示 与记录页共用一条路径（src/lib/activity.ts）。
            await confirmAndClearActivity();
          }}
        />
      </SettingsGroup>
      )}

      {activeSection === "diagnostics" && (
        <>
          <Suspense fallback={null}>
            <FailureHistorySection />
          </Suspense>
          {/* 第二个独立面板，不并进 FailureHistorySection：它有自己的 IPC 探针与
              自己的刷新节奏，而失败历史是纯本地档案（读 store，不发请求）。
              它不带第二个 data-section，深链滚动因此仍落在失败历史那块，即本段
              顶部——Docker 面板就在它下面。 */}
          <Suspense fallback={null}>
            <DockerDiagnosticsSection />
          </Suspense>
        </>
      )}

      {/* r21-N1b-2：跨仓库依赖更新。自己的段、自己的 IPC 扫描（多仓库并发），
          与诊断段并列而不是塞进去——它回答的问题（哪个包在多少个仓库里旧着）
          和失败历史/Docker 都不是一件事。 */}
      {activeSection === "deps" && (
        <Suspense fallback={null}>
          <DepsUpdateSection repos={repos} />
        </Suspense>
      )}

      {activeSection === "token" && (
      <SettingsGroup
        title={t("settings.section.token")}
        regId="settings-group-token"
        sectionId="token"
        footnote={t("settings.page.tokenFootnote", { path: settings?.configPath ?? "—" })}
      >
        <FieldRow
          icon={<KeyRound className="h-4 w-4" />}
          align="stack"
          title={
            settings?.tokenUnreadable
              ? t("settings.page.tokenUnreadable")
              : settings?.hasGithubToken
                ? t("settings.page.tokenSaved")
                : t("settings.page.tokenMissing")
          }
          hint={settings?.tokenUnreadable ? t("settings.page.tokenUnreadableHint") : t("settings.page.tokenHint")}
        >
          <div className="flex flex-wrap gap-2">
            <input
              value={token}
              aria-label={t("settings.section.token")}
              onChange={(e) => {
                setToken(e.target.value);
                // Debounced, not immediate: a pasted token fires one change per
                // character, and writing each prefix would save several
                // half-valid credentials.
                if (e.target.value.trim()) saveSoon({ githubToken: e.target.value });
              }}
              onBlur={() => {
                // Only commit a non-empty token. The backend reads an empty
                // string as "unchanged", so submitting "" would be a silent
                // no-op anyway — but it would also *look* like it saved.
                if (token.trim()) commitSoon();
              }}
              onPaste={(e) => {
                // Tokens are pasted with a trailing newline about as often as
                // not; saving it verbatim would store a value that never
                // authenticates.
                const text = e.clipboardData.getData("text").trim();
                if (!text) return;
                e.preventDefault();
                setToken(text);
                saveNow({ githubToken: text });
              }}
              type="password"
              placeholder={settings?.hasGithubToken ? t("settings.page.tokenKeepPlaceholder") : t("settings.page.tokenPastePlaceholder")}
              spellCheck={false}
              className="min-w-0 flex-1 skin-ctl border border-input bg-background px-3 py-2 font-mono text-caption outline-none focus:border-primary"
            />
            {(settings?.hasGithubToken || settings?.tokenUnreadable) && (
              <button
                type="button"
                onClick={() => {
                  // Deleting a credential is not reversible and there is no undo
                  // record for it — the other destructive action on this page
                  // (清空全部操作记录) already asks first.
                  void (async () => {
                    const ok = await confirmDestructive(
                      t("settings.page.tokenDeleteConfirm"),
                      { title: t("settings.page.tokenDeleteTitle"), okLabel: t("settings.page.delete") },
                    );
                    if (!ok) return;
                    setClearToken(true);
                    setToken("");
                    await saveNow({ clearGithubToken: true });
                  })();
                }}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-2 text-caption transition-colors",
                  clearToken
                    ? "border-danger/60 bg-danger/10 text-danger"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {clearToken ? t("settings.page.tokenDeleted") : t("settings.page.tokenDeleteButton")}
              </button>
            )}
            {/* r18 R3. The check verifies the token in the config file, not the string
                being edited: the command reads the config on the Rust side and the
                webview never holds the value. The debounced save fires before a click
                in normal use, and the difference is documented rather than hidden. */}
            <button
              type="button"
              disabled={tokenChecking || !settings?.hasGithubToken}
              onClick={() => {
                setTokenChecking(true);
                invoke<TokenReport>("verify_github_token")
                  .then((r) => setTokenReport(r))
                  .catch((e) =>
                    setTokenReport({
                      valid: false,
                      status: null,
                      login: null,
                      scopes: null,
                      expiredScopes: null,
                      remaining: null,
                      limit: null,
                      note: messageOf(e),
                    }),
                  )
                  .finally(() => setTokenChecking(false));
              }}
              className="shrink-0 rounded-lg border border-border px-3 py-2 text-caption text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {tokenChecking ? t("settings.page.tokenVerifying") : t("settings.page.tokenVerifyButton")}
            </button>
            {tokenReport && !tokenChecking && (
              <p className="w-full text-caption leading-snug text-muted-foreground">
                {describeTokenReport(tokenReport, t)}
              </p>
            )}
          </div>
        </FieldRow>
      </SettingsGroup>
      )}

      {/* 外观 merged in (brief item 10): the real controls, not a jump row.
          Round 6 left a "前往外观" entry here because the groups lived on a
          standalone page; round 9 moves the groups themselves into the
          catalog, so the merge the brief asks for is finally literal. */}
      {activeSection === "appearance" && (
        <div data-section="appearance" className="scroll-mt-3">
          <SizeGroup />
          <ThemeGroup />
          <ContentGroup />
          <ChromeGroup />
          <TemplateGroup />
          <ResetGroup />
        </div>
      )}

      {/* r16-n2-2: the language row lives at the top of the 界面 page — a
          frontend-held preference (localStorage, see lib/i18n for why the
          Rust config was not an option), so its natural home is the page
          that already owns local interface choices. The hint is honest about
          the partial scope: only the wired surfaces switch language. */}
      {activeSection === "interface" && (
        <>
          <SettingsGroup title={t("i18n.groupTitle")} sectionId="language">
            <ChoiceRow
              icon={<Languages className="h-4 w-4" />}
              title={t("i18n.rowTitle")}
              hint={t("i18n.rowHint")}
              value={locale}
              options={LOCALE_OPTIONS}
              onChange={(id) => {
                // ChoiceRow hands back a plain string; the option set is the
                // two locales, and anything else is ignored by setLocale too.
                if (id === "zh-CN" || id === "en") setLocale(id);
              }}
            />
          </SettingsGroup>
          <InterfaceSection />
        </>
      )}

      {activeSection === "about" && <AboutSection />}

      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-caption leading-relaxed text-danger">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {settings?.configSource === "backup" && (
        <div role="status" className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption leading-relaxed text-warning">
          {t("settings.page.configRecovered", { backup: settings.configBackupPath })}
        </div>
      )}
      {settings?.configSource === "default" && settings.configError && (
        <div role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-caption leading-relaxed text-danger">
          {t("settings.page.configCorrupt", { reason: settings.configError })}
        </div>
      )}

      <p className="app-desc truncate pb-2 text-caption text-muted-foreground" title={settings?.configPath}>
        {t("settings.page.configPathLead")}<code>{settings?.configPath ?? "—"}</code>
      </p>
        </div>
      </div>
    </>
  );

}
