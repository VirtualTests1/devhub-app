import { useEffect, useId, useMemo, useRef, useState } from "react";
import { applyModalInert } from "../lib/modal-inert";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  Bookmark,
  FolderOpen,
  History,
  LayoutGrid,
  Moon,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Sun,
  Terminal,
  Zap,
} from "lucide-react";
import { cn } from "../lib/utils";
import { reportError } from "../lib/report-error";
import { slugOf } from "../lib/slug";
import { sectionTitle, type TFunc } from "../lib/i18n";
import { scoreRow } from "../lib/palette-score";
import { useI18n } from "../lib/useI18n";
import { buildLocalIndex, searchLocal } from "../lib/local-index";
import {
  filterByScope,
  groupsForScope,
  parsePaletteQuery,
  type PaletteScope,
} from "../lib/palette-scope";
import { pushRecent, rankByRecent, readRecent, recentBoost } from "../lib/palette-recent";
import { corpusEntryOf } from "../lib/corpus";
import {
  fusePaletteScores,
  localFieldLabelOf,
  paletteEvidenceOf,
  type PaletteEvidence,
} from "../lib/palette-hit";
import { ELEMENTS, SHELL_GROUP, reg, useCustomize } from "../store/customize";
import { resolveTheme, useAppearance } from "../store/appearance";
import { useWall } from "../store/wall";
import { useWallViews } from "../store/wall-views";
import { useCorpus } from "../store/corpus";
import { SETTINGS_SECTIONS } from "../settingsCatalog";
import { useUI, type ViewId } from "../store/ui";
import type { ActivityEntry, RepoRef } from "../types";

/**
 * Global search (需求 3): one entry point for the four things a person actually
 * looks for — a project, an action, a setting, and a past operation.
 *
 * Why it is local-only by decision: the brief's option C would also have searched
 * GitHub through the existing 搜索链路 switch. That was declined, so nothing here
 * touches the network. Every source below is either already in memory or a single
 * local command.
 *
 * The keyboard is the point. A palette you have to click open is a button, not a
 * palette — Ctrl+K opens it from anywhere, ↑/↓ walk the flattened result list,
 * Enter runs it, Esc closes it, and typing narrows it. Results are grouped by
 * source but ranked as one list, because "the best match" should not be buried
 * under whichever group happens to be listed first.
 */

type Command = {
  id: string;
  group: GroupId;
  label: string;
  note?: string;
  icon: React.ReactNode;
  keywords: string;
  run: () => void;
  /** 项目 rows only: the wall slug the local BM25 index is keyed by. */
  repoSlug?: string;
  /** 项目 rows only, once a BM25 hit said this row has evidence beyond the name. */
  evidence?: PaletteEvidence;
};

/**
 * 分组标识是英文（r21-o2-2），显示名在渲染处过词表（`groupLabel`）：标识只活在
 * 这个文件里、既不落盘也不外传，改成英文才能让 `.tsx` 里不再留中文字面量。
 */
type GroupId = "projects" | "actions" | "settings" | "records";

const GROUP_ORDER: GroupId[] = ["projects", "actions", "settings", "records"];

/** 分组标题：项目 / 设置 / 记录复用 `view.*`（同一个词、同一份 EN），「动作」是新键。 */
function groupLabel(t: TFunc, g: GroupId): string {
  if (g === "projects") return t("view.projects");
  if (g === "actions") return t("palette.groupActions");
  if (g === "settings") return t("view.settings");
  return t("view.records");
}

/** 与 DialogShell:9 同一份可聚焦集合：焦点陷阱只绕着真正可交互的元素转。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 作用域名字：`>` 用「动作」，另两个复用视图名，不另造一套词。 */
function scopeLabel(t: TFunc, scope: PaletteScope): string {
  if (scope === "commands") return t("palette.groupActions");
  if (scope === "projects") return t("view.projects");
  return t("view.records");
}

/** `RepoRef` carries host/owner/repo; the slug is the identity the rest of the app
 *  (and each repository's own `.devhub.json`) uses — see `lib/slug`. */

// r21-R1-2: the matching rule moved to `lib/palette-score` — a `.tsx` cannot be
// loaded under Node's type stripping, so a private `score()` declared in this file
// was untestable and un-comparable (docs/local-search-bm25.md §6). Same body, now
// importable by the bake-off and pinned by tests/palette-score.test.ts.

export function CommandPalette({
  closing = false,
  onClose,
  onRefresh,
}: {
  closing?: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecent());
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [records, setRecords] = useState<ActivityEntry[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  // 按下点是否落在面板里：从面板内按住拖到遮罩再松手会触发遮罩上的 click，
  // 但那不是「点遮罩关闭」（同 DialogShell:61-63）。
  const downInPanel = useRef(false);
  const ui = useUI;
  // The stored preference, as a primitive — the palette used to read it
  // imperatively inside the `commands` memo, whose deps do not include
  // appearance, so the theme command's label went stale for as long as the
  // palette stayed open. Subscribing narrowly (the raw `theme`, not the whole
  // appearance object) keeps it fresh; the *effective* colour is derived with
  // `resolveTheme` inside the memo, the same function `applyAppearance` writes
  // `data-theme` from.
  const theme = useAppearance((s) => s.theme);
  // r16-n2-2: same staleness argument as `theme`, one level up — `t` changes
  // when the language row flips, so it belongs in the `commands` deps below;
  // the memo then rebuilds the five 去… actions and every 设置 page command
  // in the new language instead of keeping the old labels until reopen.
  const { t } = useI18n();

  // r21-n2: the local BM25 corpus. `wallStates` carries alias/tags (the words
  // this person chose for the card), `extras` the produced description /
  // readmeHeadings (`store/corpus.ts`). Freshness rides on `extras` identity:
  // every producer write builds a new map (`loadReadmes`, `absorbDescriptions`
  // when it moved, `retain` prune), and `absorbDescriptions` deliberately
  // returns `prev` unchanged when nothing moved — so a no-op refresh cannot
  // rebuild the index for free. Narrow subscriptions, same staleness argument
  // as `theme` above.
  const wallStates = useWall((s) => s.repos);
  const savedViews = useWallViews((s) => s.views);
  const extras = useCorpus((s) => s.extras);
  const localIndex = useMemo(() => {
    const entries = repos.map((r) => {
      const slug = slugOf(r);
      return corpusEntryOf(r, wallStates[slug], extras[slug]);
    });
    return buildLocalIndex(entries);
  }, [repos, wallStates, extras]);

  // r24-N1: a leading >/@/# narrows the ranking before scoring. Parsing here
  // (rather than in the input's onChange) keeps the field's value exactly what
  // was typed, so Backspace deletes the prefix like any other character.
  const parsedQuery = useMemo(() => parsePaletteQuery(query), [query]);

  // r15-a11y-3: 记住打开面板前的焦点。它声明在下面那个把焦点给输入框的
  // 挂载 effect 之前，effect 按声明顺序执行，所以这里读到的还是触发方
  // （Ctrl+K 时按亮的那个按钮）—— 卸载时归还焦点，同 DialogShell:71/:105。
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    // Both sources are local reads; they are fetched on open rather than on boot
    // so the palette costs nothing until someone asks for it. `alive` is the
    // liveness guard this repo already uses (ProjectSettingsDialog, SettingsView):
    // closing and reopening quickly can unmount this instance while the invokes
    // are still in flight, and the late resolve would write state on an unmounted
    // component or overwrite the freshly reopened lists.
    let alive = true;
    void invoke<RepoRef[]>("list_repositories")
      .then((r) => alive && setRepos(r))
      .catch((e) => {
        if (!alive) return;
        // An empty list and a failed list used to be the same screen: the palette
        // would offer "no projects" while the backend had actually said no. The
        // fallback stays (a palette with nothing in it is still usable), but the
        // reason now reaches the one error surface the app has.
        setRepos([]);
        reportError(e, t("palette.loadReposFailed"));
      });
    void invoke<ActivityEntry[]>("list_activity")
      .then((a) => alive && setRecords(a))
      .catch((e) => {
        if (!alive) return;
        setRecords([]);
        reportError(e, t("palette.loadActivityFailed"));
      });
    return () => {
      alive = false;
    };
    // `t` joins the deps only so the two 读取…失败 verbs follow the language row;
    // the palette cannot be open while the language row is being clicked, so in
    // practice this never refetches (exhaustive-deps is a gate error here).
  }, [t]);

  // r21-n2: once the wall is known, (a) prune corpus extras to the slugs still
  // on it — anti-stale for repositories deleted since the last open — and
  // (b) fire the zero-network README probe for every clone with a path. Both
  // are idempotent per slug (`retain` is a set operation, `loadReadmes` keeps
  // a tried-set), so reopening the palette does not refetch anything.
  useEffect(() => {
    if (repos.length === 0) return;
    useCorpus.getState().retain(repos.map(slugOf));
    void useCorpus
      .getState()
      .loadReadmes(repos.map((r) => ({ slug: slugOf(r), path: r.path ?? null })));
  }, [repos]);

  const commands = useMemo<Command[]>(() => {
    const go = (view: ViewId) => () => {
      ui.getState().go(view);
      onClose();
    };
    const setTheme = (theme: "dark" | "light") => () => {
      useAppearance.getState().set("theme", theme);
      onClose();
    };
    // The colour the app is actually showing, not the stored enum: `theme` can
    // be "system", and comparing that to "light" is what made the command read
    // 切换到浅色 while the app was already light (跟随系统 + a light OS) — the
    // click then wrote `theme: "light"` with nothing visible happening. Writing
    // the opposite *explicit* theme is always a visible change.
    const isLight = resolveTheme(theme) === "light";
    const list: Command[] = [
      {
        id: "act-refresh",
        group: "actions",
        label: t("palette.refresh"),
        note: t("palette.refreshNote"),
        icon: <RefreshCw className="h-4 w-4" />,
        keywords: t("palette.kwRefresh"),
        run: () => {
          onRefresh();
          onClose();
        },
      },
      {
        id: "act-projects",
        group: "actions",
        // r16-n2-2: `去 ${view}` composes as palette.go + a space + view.*,
        // byte-identical to the old `去 项目` template in zh-CN.
        label: `${t("palette.go")} ${t("view.projects")}`,
        icon: <LayoutGrid className="h-4 w-4" />,
        keywords: t("palette.kwProjects"),
        run: go("projects"),
      },
      {
        id: "act-add",
        group: "actions",
        label: `${t("palette.go")} ${t("view.add")}`,
        icon: <FolderOpen className="h-4 w-4" />,
        keywords: t("palette.kwAdd"),
        run: go("add"),
      },
      {
        id: "act-records",
        group: "actions",
        label: `${t("palette.go")} ${t("view.records")}`,
        icon: <History className="h-4 w-4" />,
        keywords: t("palette.kwRecords"),
        run: go("records"),
      },
      {
        id: "act-frequent",
        group: "actions",
        label: `${t("palette.go")} ${t("view.frequent")}`,
        icon: <Sparkles className="h-4 w-4" />,
        keywords: t("palette.kwFrequent"),
        run: go("frequent"),
      },
      {
        id: "act-settings",
        group: "actions",
        label: `${t("palette.go")} ${t("view.settings")}`,
        icon: <Settings2 className="h-4 w-4" />,
        keywords: t("palette.kwSettings"),
        run: go("settings"),
      },
      ...savedViews.map(
        (view): Command => ({
          id: `wall-view-${view.id}`,
          group: "actions",
          label: t("wall.views.apply", { name: view.name }),
          note: view.query || view.language || view.category || view.tags.join(" · ") || undefined,
          icon: <Bookmark className="h-4 w-4" />,
          keywords: `view ${view.name} ${view.query} ${view.tags.join(" ")}`,
          run: () => {
            // The request survives until ProjectsView consumes it; `go` below is
            // what mounts the view when the palette was opened elsewhere.
            useWallViews.getState().requestApply(view.id);
            ui.getState().go("projects");
            onClose();
          },
        }),
      ),
      {
        id: "act-theme",
        group: "actions",
        label: isLight ? t("palette.themeDark") : t("palette.themeLight"),
        icon: isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />,
        keywords: t("palette.kwTheme"),
        run: setTheme(isLight ? "dark" : "light"),
      },
      {
        id: "act-devmode",
        group: "actions",
        label: t("palette.devMode"),
        note: t("palette.devModeNote"),
        icon: <Zap className="h-4 w-4" />,
        keywords: t("palette.kwDev"),
        run: () => {
          useCustomize.getState().setDevMode(true);
          onClose();
        },
      },
      {
        id: "act-terminal",
        group: "actions",
        label: t("palette.revealContainer"),
        icon: <Terminal className="h-4 w-4" />,
        keywords: t("palette.kwReveal"),
        run: () => {
          // reveal_path takes a path, and the container is only known to the
          // backend's settings, so this reads the same command the 设置 page shows.
          // Both halves are the request itself, so a reject on either is reported;
          // the palette has had no error surface of its own until here.
          void invoke<{ projectRoot: string }>("get_settings")
            .then((st) => invoke("reveal_path", { path: st.projectRoot }))
            .catch((e) => reportError(e, t("wt.revealFailed")));
          onClose();
        },
      },
      {
        // r17-n3-2: 无边框窗口的最小化/最大化按钮在 TitleBar 上只能鼠标点；
        // 命令面板的意义就是键盘可达，把这两个窗口动作也放进来（Ctrl+K → 打「最小」回车）。
        id: "act-minimize",
        group: "actions",
        label: t("palette.minimize"),
        icon: <ArrowRight className="h-4 w-4 rotate-90" />,
        keywords: t("palette.kwMinimize"),
        run: () => {
          void getCurrentWindow()
            .minimize()
            .catch((e) => reportError(e, t("palette.minimizeFailed")));
          onClose();
        },
      },
      {
        id: "act-maximize",
        group: "actions",
        label: t("palette.maximize"),
        icon: <ArrowRight className="h-4 w-4 rotate-45" />,
        keywords: t("palette.kwMaximize"),
        run: () => {
          void getCurrentWindow()
            .toggleMaximize()
            .catch((e) => reportError(e, t("palette.maximizeFailed")));
          onClose();
        },
      },
      {
        // r18 N2: 网络诊断的键盘入口（Ctrl+K → 打「网络」回车）。
        // 新动作的文案一律走 t()：旧动作的硬编码中文是存量基线债，不加新债。
        id: "act-netdiag",
        group: "actions",
        label: t("netdiag.title"),
        note: t("netdiag.paletteNote"),
        icon: <Stethoscope className="h-4 w-4" />,
        keywords: "network diagnose link dns hosts proxy netdiag",
        run: () => {
          onClose();
          ui.getState().setNetDiagOpen(true);
        },
      },
      {
        // r17-n3-3: 排障时要把环境信息贴出来，以前得截图拼；这里一键导出 Markdown。
        id: "act-export-diag",
        group: "actions",
        label: t("palette.exportDiag"),
        note: t("palette.exportDiagNote"),
        icon: <SlidersHorizontal className="h-4 w-4" />,
        keywords: t("palette.kwDiag"),
        run: () => {
          onClose();
          void (async () => {
            const picked = await saveDialog({
              title: t("palette.exportDiag"),
              defaultPath: `devhub-diagnostics-${new Date().toISOString().slice(0, 10)}.md`,
              filters: [{ name: "Markdown", extensions: ["md"] }],
            });
            if (!picked) return;
            await invoke("export_diagnostics", { path: picked });
          })().catch((e) => reportError(e, t("palette.exportDiagFailed")));
        },
      },
      {
        // r26-N2: the same facts for a script. A separate action, not a dropdown:
        // the palette is keyboard-first and two rows need no extra state.
        id: "act-export-diag-json",
        group: "actions",
        label: t("palette.exportDiagJson"),
        note: t("palette.exportDiagJsonNote"),
        icon: <SlidersHorizontal className="h-4 w-4" />,
        keywords: t("palette.kwDiag"),
        run: () => {
          onClose();
          void (async () => {
            const picked = await saveDialog({
              title: t("palette.exportDiagJson"),
              defaultPath: `devhub-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
              filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!picked) return;
            await invoke("export_diagnostics", { path: picked, format: "json" });
          })().catch((e) => reportError(e, t("palette.exportDiagFailed")));
        },
      },
    ];

    const repoCmds: Command[] = repos.map((r) => ({
      id: `repo:${slugOf(r)}`,
      group: "projects",
      label: r.repo,
      note: `${r.owner} · ${t("menu.panel")}`,
      icon: <LayoutGrid className="h-4 w-4" />,
      keywords: `${r.repo} ${r.owner} ${slugOf(r)} ${r.path ?? ""}`,
      repoSlug: slugOf(r),
      run: () => {
        ui.getState().go("projects");
        ui.getState().setOpenSlug(slugOf(r));
        onClose();
      },
    }));

    // Round 9 turned 设置 into a catalog of pages, so a deep link names a page id
    // rather than a scroll position. Blocks live on the 界面 page; ELEMENTS already
    // carries a Chinese label plus a hint for each, so there is no index to drift.
    // r16-n2-2: the page label resolves through the dictionary (sectionTitle) so
    // the 设置 group follows the language row. One resolved label feeds both the
    // row and its keywords — the catalog's own `s.label` is the zh-CN reference
    // the dictionary was keyed against, and printing it next to the translated
    // one would show the same word twice under `en`.
    const pageCmds: Command[] = SETTINGS_SECTIONS.map((s) => {
      const label = sectionTitle(t, s.id);
      return {
        id: `set:${s.id}`,
        group: "settings",
        label,
        note: t("errorboundary.labels.settings"),
        icon: s.icon,
        keywords: `${label} ${t("palette.kwSettings")} ${s.id}`,
        run: () => {
          ui.getState().go("settings");
          ui.getState().setSettingsSection(s.id);
          onClose();
        },
      };
    });

    const blockCmds: Command[] = ELEMENTS.filter((e) => e.group !== SHELL_GROUP).map((e) => ({
      id: `blk:${e.id}`,
      group: "settings",
      label: e.label,
      note: e.hint ?? e.group,
      icon: <SlidersHorizontal className="h-4 w-4" />,
      keywords: `${e.label} ${e.hint ?? ""} ${e.group} ${e.id}`,
      run: () => {
        ui.getState().go("settings");
        ui.getState().setSettingsSection("interface");
        onClose();
      },
    }));

    const recordCmds: Command[] = records.slice(0, 200).map((a) => ({
      id: `rec:${a.id || `${a.ts}-${a.action}`}`,
      group: "records",
      label: a.action,
      note: [a.source, a.target ?? a.slug].filter(Boolean).join(" · "),
      icon: <History className="h-4 w-4" />,
      keywords: `${a.action} ${a.detail} ${a.source} ${a.slug}`,
      run: () => {
        ui.getState().go("records");
        ui.getState().setRecordsSeed(a.action);
        onClose();
      },
    }));

    return [...repoCmds, ...list, ...pageCmds, ...blockCmds, ...recordCmds];
    // `t` joins the deps so a language switch rebuilds the 去… / 设置 page
    // labels while the palette is open (exhaustive-deps is a gate error here).
  }, [repos, records, onRefresh, onClose, ui, theme, t, savedViews]);

  const ranked = useMemo<Command[]>(() => {
    const q = parsedQuery.text.trim();
    const scope = parsedQuery.scope;
    if (!q) {
      // With no query, show a slice of each group rather than every 界面区块.
      // A scope narrows the groups themselves: `@` with nothing typed is the
      // project picker, not the whole command list with projects first.
      const picked: Command[] = [];
      for (const g of groupsForScope(scope) ?? GROUP_ORDER) {
        // Recency reorders the shelf before the slice, so a command used yesterday
        // is visible even when it sits past the first six in source order.
        picked.push(
          ...rankByRecent(
            commands.filter((c) => c.group === g),
            recentIds,
          ).slice(0, g === "settings" ? 8 : 6),
        );
      }
      return picked;
    }
    // Both ranking paths narrow before scoring; see filterByScope's contract.
    const scoped = filterByScope(commands, scope);
    // r21-n2-3: BM25 answers for the fields the if-chain cannot see — the
    // produced description / README headings, plus alias and tags. A hit
    // carries the evidence the row renders next to the name; non-project
    // commands never carry a repoSlug, so their hit stays undefined.
    // r21-r1-2: the two lists fuse per query via `fusePaletteScores`
    // (wsum-40-60, the measured winner over the old band-join).
    // Two passes: the min-max norms are computed over every row of this query,
    // so a per-row score function cannot produce them.
    const bm25Hits = searchLocal(localIndex, q, { limit: 40 });
    const hitBySlug = new Map(bm25Hits.map((h) => [h.slug, h]));
    const rows = scoped.map((c) => {
      const base = scoreRow(c.label, c.keywords, q);
      const hit = c.repoSlug === undefined ? undefined : hitBySlug.get(c.repoSlug);
      const evidence = hit ? paletteEvidenceOf(localIndex.docs, hit, q) : null;
      return { c: { ...c, evidence: evidence ?? undefined }, base, hit };
    });
    const fused = fusePaletteScores(rows);
    return rows
      .map((row, i) => ({ c: row.c, s: (fused[i] ?? 0) + recentBoost(row.c.id, recentIds) }))
      .filter((x) => x.s > 0)
      // 组内并列次序按 GROUP_ORDER 排（英文标识的 localeCompare 会按字母打散分组）。
      .sort(
        (a, b) =>
          b.s - a.s ||
          GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group) ||
          a.c.label.localeCompare(b.c.label),
      )
      .slice(0, 40)
      .map((x) => x.c);
  }, [commands, parsedQuery, localIndex, recentIds]);

  useEffect(() => setActive(0), [query]);

  /**
   * Every execution path goes through here, so a command cannot be run by mouse
   * and forgotten by recency (or the other way round). The Enter path reaches it
   * through `nav.current`, which is refreshed every render.
   */
  const runCommand = (command: Command) => {
    setRecentIds(pushRecent(command.id));
    command.run();
  };

  // r20-O4-3: the palette is the app's second modal layer, so it owes the same
  // promise as DialogShell (r20-O4-1): what the scrim covers stops being reachable,
  // not merely hard to reach. Same helper, same restore-on-unmount rule — including
  // the `closing` unmount, so a dismissed palette cannot leave the wall inert.
  useEffect(() => {
    const scrim = scrimRef.current;
    if (!scrim) return;
    return applyModalInert(Array.from(scrim.parentElement?.children ?? []), scrim);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // r15-a11y-3: keyboard handling moves to a document listener, the shape
  // DialogShell:74-102 already proves in this codebase. The old React onKeyDown
  // on the panel meant Escape stopped working the moment focus left the panel —
  // which is exactly what a stray click inside a modal does. The per-render
  // values (ranked/active/closing/onClose) live in a ref so the subscription
  // is mounted once.
  const nav = useRef({ ranked, active, closing, onClose, runCommand });
  nav.current = { ranked, active, closing, onClose, runCommand };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = panelRef.current;
      if (!el || nav.current.closing) return;
      const target = e.target as Node | null;
      // Accept keys from inside the panel, plus keys whose focus leaked to
      // the document root — an aria-modal surface must stay closable even
      // when the active element is `<body>`.
      const leaked = !target || target === document.body || target === document.documentElement;
      if (!leaked && !el.contains(target)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        nav.current.onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (nav.current.ranked.length ? (i + 1) % nav.current.ranked.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) =>
          nav.current.ranked.length
            ? (i - 1 + nav.current.ranked.length) % nav.current.ranked.length
            : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const { ranked: list, active: at, runCommand: run } = nav.current;
        if (list[at]) run(list[at]);
      } else if (e.key === "Tab") {
        // Focus trap, identical rule to DialogShell:84-100.
        const items = el.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        const activeEl = document.activeElement;
        if (e.shiftKey && activeEl === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        } else if (!el.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  let lastGroup: GroupId | null = null;

  // r15-a11y-4: listbox/option semantics, the pattern ContextMenu:156-158 and
  // Controls:390-392 already use. The input is the combobox: focus stays on it
  // (typing is the point), and `aria-activedescendant` names the active row, so
  // the AT reads the option plus 第 N / M 项 from `aria-posinset`/`aria-setsize`
  // (spelled out because the options sit in per-row wrapper divs, where the
  // automatic position counting does not apply). Plain buttons + a
  // `data-active` ArrowRight glyph announced nothing; the glyph stays for eyes.
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  return (
    <div
      ref={scrimRef}
      data-layer="scrim"
      data-state={closing ? "closed" : "open"}
      className={cn(
        "fixed inset-0 z-[80] flex items-start justify-center bg-black/55 px-6 pt-[12vh] backdrop-blur-[var(--blur-scrim)]",
        closing && "pointer-events-none",
      )}
      onPointerDown={(e) => {
        downInPanel.current = !!panelRef.current?.contains(e.target as Node);
      }}
      onClick={() => {
        if (downInPanel.current) {
          downInPanel.current = false;
          return;
        }
        onClose();
      }}
    >
      <div
        {...reg("command-palette")}
        ref={panelRef}
        // r15-a11y-3: the panel is a dialog — it always looked like one and
        // trapped nothing. Same three attributes DialogShell:131-133 carries;
        // the name is static because the input inside announces 全局搜索 itself.
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        data-layer="dialog"
        data-state={closing ? "closed" : "open"}
        className="elevation-overlay flex w-full max-w-[38rem] flex-col overflow-hidden rounded-xl border border-border bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-weak px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.inputAria")}
            role="combobox"
            aria-expanded={ranked.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={ranked.length ? optionId(active) : undefined}
            aria-describedby={`${uid}-scope-hint`}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="shrink-0 rounded border border-border-weak px-1.5 py-0.5 text-caption text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* The prefix is typed, not a chip: this row explains it once and then
            states the active scope. `aria-describedby` on the input means the
            rule reaches a screen reader without moving focus. */}
        <div
          id={`${uid}-scope-hint`}
          className="border-b border-border-weak px-3 py-1 text-caption text-muted-foreground"
        >
          {parsedQuery.scope
            ? t("palette.scopeActive", { scope: scopeLabel(t, parsedQuery.scope) })
            : t("palette.scopeHint")}
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={t("palette.listAria")}
          className="max-h-[52vh] overflow-y-auto p-1.5"
        >
          {ranked.length === 0 && (
            <p className="px-3 py-6 text-center text-body text-muted-foreground">
              {t("palette.noResults", { query: parsedQuery.text || query })}
            </p>
          )}
          {ranked.map((c, i) => {
            const header: GroupId | null = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && (
                  <p
                    aria-hidden
                    className="skin-label px-2 pt-2 pb-1 text-caption text-muted-foreground"
                  >
                    {groupLabel(t, header)}
                  </p>
                )}
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-posinset={i + 1}
                  aria-setsize={ranked.length}
                  // 分组标题对 AT 隐藏（listbox 的合法子代只有 option），
                  // 分组信息因此进可及名称：「项目：owner/repo · 说明」。
                  aria-label={
                    c.note
                      ? t("palette.ariaRowNote", {
                          group: groupLabel(t, c.group),
                          label: c.label,
                          note: c.note,
                        })
                      : t("palette.ariaRow", { group: groupLabel(t, c.group), label: c.label })
                  }
                  tabIndex={-1}
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runCommand(c)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-body",
                    i === active ? "bg-primary/12 text-foreground" : "text-foreground",
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                    {c.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.note && (
                    <span className="shrink-0 max-w-[45%] truncate text-caption text-muted-foreground">
                      {c.note}
                    </span>
                  )}
                  {/* r21-n2-3: the BM25 evidence row — dictionary word for the
                      field (描述 / README / …) plus a window of the matched
                      text; `data-evidence` carries the raw identifier for
                      assistive tech and tests. */}
                  {c.evidence && (
                    <span
                      data-evidence={c.evidence.reason}
                      title={c.evidence.snippet ?? undefined}
                      className="shrink-0 max-w-[35%] truncate text-caption text-muted-foreground"
                    >
                      {localFieldLabelOf(c.evidence.reason, t)}
                      {c.evidence.snippet ? ` · ${c.evidence.snippet}` : ""}
                    </span>
                  )}
                  {i === active && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
