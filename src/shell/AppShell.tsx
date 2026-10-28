import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUI } from "../store/ui";
import {
  useAppearance,
  applyAppearance,
  watchSystemTheme,
} from "../store/appearance";
import { useRunningProcessCount } from "../store/processes";
import { reg } from "../store/customize";
import { ArrowUp } from "lucide-react";
/* Opened by shortcut, never on first paint. Splitting them keeps the palette's BM25 /
 * settings-catalog imports out of the entry chunk (r22-O4-2); the 1.5 s warm-up below
 * means the first Ctrl+K still finds the chunk already fetched. */
const CommandPalette = lazy(() =>
  import("../components/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ShortcutHelpDialog = lazy(() =>
  import("../components/ShortcutHelpDialog").then((m) => ({ default: m.ShortcutHelpDialog })),
);
import { SHORTCUT_ACTIONS } from "../lib/shortcut-actions";
import { currentKeyMap } from "../lib/shortcut-bindings";
import { isTextField, matchAction } from "../lib/shortcuts";
import { useLayerExit } from "../lib/motion";
import { useI18n } from "../lib/useI18n";
import { Sidebar } from "./Sidebar";
import { StatusStrip } from "./StatusStrip";
import { TitleBar } from "./TitleBar";
import type { EnvironmentReport, GitBootstrapStatus } from "../types";

/**
 * Resolution the 阅读进度 line is stored at: 1/512 of the page.
 *
 * The line renders its width to 0.01 of a percent, so a step of 1/512 (0.195%) is
 * already coarser than the drawing is asked to be — but it is the number of *state
 * writes* per wheel gesture that matters, not the number of pixels. See `onScroll`.
 */
const SCROLL_BUCKET = 512;

/**
 * Application shell: title bar + sidebar + view container + status strip.
 *
 * The shell owns layout only. It deliberately does not fetch anything;
 * `App.tsx` loads data and hands it down, so a view can be developed against
 * props.
 *
 * Round 3 made the chrome layered instead of flush. Before: one full-bleed
 * window, a sidebar butted against the page, and a strip butted against the
 * page — three rectangles sharing one background, which is why the report was
 * "侧边栏和界面之间要有层次感". Now the window itself is the darkest surface
 * (`--color-strip`), and the sidebar, the page and the status strip are each
 * their own rounded, bordered, shadowed panel floating on it. The elevation
 * comes from geometry plus one lightness step, not from colour.
 *
 * The title bar exists because the window is `decorations: false`; without it
 * the app cannot be minimised or closed by mouse at all.
 */
export function AppShell({
  env,
  gitStatus,
  repoCount,
  version,
  refreshing,
  onRefresh,
  children,
}: {
  env: EnvironmentReport | null;
  gitStatus: GitBootstrapStatus | null;
  repoCount: number;
  version: string;
  refreshing: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  const view = useUI((s) => s.view);
  const { t } = useI18n();
  const goBack = useUI((s) => s.back);
  const goForward = useUI((s) => s.forward);
  const paletteOpen = useUI((s) => s.paletteOpen);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const paletteLayer = useLayerExit(paletteOpen);
  // 需求 5 的滚动反馈：长页面（记录、设置）此前只有右侧那条默认隐藏的滚动条，
  // 而它按需求是关着的 —— 于是"我滚到哪儿了"完全没有反馈。
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [scroll, setScroll] = useState({ pct: 0, deep: false });

  // Warm the shortcut-only surfaces after first paint. Same trade as the card dialogs
  // in ProjectsView: a timer the typings guarantee, not requestIdleCallback.
  useEffect(() => {
    const id = window.setTimeout(() => {
      void import("../components/CommandPalette");
      void import("../components/ShortcutHelpDialog");
    }, 1500);
    return () => window.clearTimeout(id);
  }, []);

  /*
   * `scroll` is the shell's own state, so every write re-renders the chrome. A wheel
   * gesture fires ~60 scroll events per second, and storing `{pct, deep}` verbatim
   * meant 60 renders per second for a line that is 2 px tall and is painted to 0.01%
   * (`toFixed(2)`): two consecutive events differed by less than a pixel of width.
   *
   * Two guards, both in the setter:
   *   - `pct` is bucketed to 1/512 (a 0.2% width step, under one CSS pixel on the
   *     widest window), so sub-pixel movement never becomes a render;
   *   - the updater returns the *previous* object when nothing changed, which is how
   *     React skips the render (a fresh object with equal fields is a new state).
   * A gesture now costs one render per 1/512 of the page travelled, and the 回到页首
   * threshold (`deep`) still flips on the exact same condition it always did.
   */
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 8 ? Math.min(1, el.scrollTop / max) : 0;
    const pct = Math.round(ratio * SCROLL_BUCKET) / SCROLL_BUCKET;
    const deep = max > 0 && el.scrollTop > el.clientHeight * 1.2;
    setScroll((prev) => (prev.pct === pct && prev.deep === deep ? prev : { pct, deep }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [onScroll, view]);
  const showStatusStrip = useAppearance((s) => s.showStatusStrip);
  const runningCount = useRunningProcessCount();

  // Push the whole appearance state to the document on every change: root
  // font-size, theme, skin, density, font family and description visibility.
  //
  // This used to be `const appearance = useAppearance(); useEffect(…, [appearance])`.
  // With no selector that subscribed to the entire store, so every single appearance
  // field change re-rendered AppShell — the shell, the sidebar, the whole view subtree
  // under `children` — just to run a document-level side effect. `applyAppearance`
  // needs the full state, but the shell does not: subscribe to the store imperatively
  // and write to the document there, leaving the component's render untouched. The
  // immediate call covers the mount (before the first store event).
  //
  // Nothing here may read the result back during render: the shell does not re-render
  // for an appearance change, so a px value sampled from the document would be the
  // previous font's. That is why the rail's geometry (`shell/geometry.ts`) is derived
  // from a `uiFontPx` subscription inside `Sidebar`, which does re-render for it.
  useEffect(() => {
    applyAppearance(useAppearance.getState());
    return useAppearance.subscribe((s) => applyAppearance(s));
  }, []);

  // 跟随系统：OS 切换深浅色时立即重算（仅当主题设为「跟随系统」）。
  useEffect(() => watchSystemTheme(() => applyAppearance(useAppearance.getState())), []);

  // ---- global keyboard routing (需求 3; key map rebuilt in r20-N1-3) ----------
  // This used to be three hand-written `if`s over `e.key`. They worked, and they were
  // the whole mechanism: nothing could answer "what key opens the palette", two
  // bindings could take the same chord and settle it by listener order, and adding a
  // shortcut meant editing shell code. The table is now `lib/shortcut-actions.ts`, the
  // matching is `lib/shortcuts.ts`, the user's overrides are `lib/shortcut-bindings.ts`
  // — all this file still owns is what each action *does*.
  //
  // Capture phase, unchanged: the palette and the dialogs install their own listeners,
  // and a chord the shell owns must be seen before a focused control swallows it.
  // `Alt+Arrow` is still not swallowed inside a text field — that gate is now
  // `allowInField` in the table rather than a comment.
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  const runShortcut = useCallback(
    (id: string) => {
      const ui = useUI.getState();
      switch (id) {
        case "palette":
          setPaletteOpen(!ui.paletteOpen);
          return;
        case "back":
          // 后退 first closes whatever is floating, exactly like a browser tab:
          // otherwise the page moves under an open dialog and the dialog is left
          // pointing at a project that is no longer on screen.
          if (ui.closeTopLayer()) return;
          goBack();
          return;
        case "forward":
          if (ui.closeTopLayer()) return;
          goForward();
          return;
        case "view-projects":
          ui.go("projects");
          return;
        case "view-add":
          ui.go("add");
          return;
        case "view-frequent":
          ui.go("frequent");
          return;
        case "view-records":
          ui.go("records");
          return;
        case "view-settings":
          ui.go("settings");
          return;
        case "help":
          setShortcutHelpOpen((open) => !open);
          return;
      }
    },
    [setPaletteOpen, goBack, goForward],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { bindings } = currentKeyMap();
      const id = matchAction(SHORTCUT_ACTIONS, bindings, e, isTextField(e.target));
      if (!id) return;
      e.preventDefault();
      runShortcut(id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runShortcut]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-strip">
      <TitleBar version={version} />

      <div className="flex min-h-0 min-w-0 flex-1 gap-1.5 p-1.5">
        <Sidebar
          repoCount={repoCount}
          runningCount={runningCount}
          version={version}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />

        <div
          {...reg("view-panel")}
          className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-weak bg-background shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
        >
          {/* A 2px reading-progress line at the top of the panel: it reports where
              you are without taking any width away, which a visible scrollbar does. */}
          <div
            aria-hidden
            className="relative h-0.5 shrink-0 overflow-hidden rounded-t-xl bg-transparent"
          >
            <span
              className="absolute inset-y-0 left-0 bg-primary/70"
              style={{
                width: `${(scroll.pct * 100).toFixed(2)}%`,
                transition: "width var(--motion-micro) linear, opacity var(--motion-quick)",
                opacity: scroll.pct > 0.005 ? 1 : 0,
              }}
            />
          </div>

          <main ref={scrollerRef} className="app-main-pad relative min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div
              {...reg("view-container")}
              // Keyed by `view` so `.app-view-enter` replays on every navigation.
              // This used to be a `useState` mirror updated by an effect: on a
              // view change the first render kept the OLD key, so the child
              // element type swap mounted the new view, and the effect's key
              // change then unmounted and remounted that fresh subtree — every
              // lazy view's `[]`-dep mount effect ran twice per navigation.
              key={view}
              className="app-view-enter mx-auto"
            >
              {/* 外观 is a settings catalog page (round 9, 需求 10), so there is
                  no per-view route swap here any more: every view renders
                  through `children`, and the shell owns layout only. */}
              {children}
            </div>
          </main>

          {scroll.deep && (
            <button
              type="button"
              data-layer="menu"
              onClick={() =>
                scrollerRef.current?.scrollTo({
                  top: 0,
                  behavior: useAppearance.getState().reduceMotion ? "auto" : "smooth",
                })
              }
              title={t("shell.backToTop")}
              aria-label={t("shell.backToTop")}
              className="elevation-menu absolute bottom-12 right-4 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-raised text-muted-foreground hover:text-foreground"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}

          {showStatusStrip && <StatusStrip env={env} gitStatus={gitStatus} />}
        </div>
      </div>

      <Suspense fallback={null}>
        {paletteLayer.render && (
          <CommandPalette
            closing={paletteLayer.state === "closed"}
            onClose={() => setPaletteOpen(false)}
            onRefresh={onRefresh}
          />
        )}
      </Suspense>

      {/* r20-N1-3: the key map's own surface. Opened by F1 (or by the palette), it is
          the only place that can answer "what key does this", which is the question
          three hand-written `if`s could never answer. */}
      <Suspense fallback={null}>
        {shortcutHelpOpen && <ShortcutHelpDialog onClose={() => setShortcutHelpOpen(false)} />}
      </Suspense>
    </div>
  );
}

/**
 * Shared view header: title + count + optional inline actions.
 *
 * Kept as a component so all views line up on the same baseline; the old
 * build had three different ad-hoc headings. The hint is marked `app-desc` so
 * "隐藏描述性文字" can remove it globally.
 *
 * `headerId` lets each view register its own header block, so hiding the
 * 记录页页头 and hiding the 设置页页头 are two different switches.
 */
export function ViewHeader({
  title,
  count,
  hint,
  actions,
  headerId,
}: {
  title: string;
  count?: number;
  hint?: string;
  actions?: React.ReactNode;
  headerId?: string;
}) {
  return (
    <div {...(headerId ? reg(headerId) : {})} className="mb-3 flex items-center gap-2.5">
      {/* The title must never wrap: at the minimum window width a long hint plus
          four header actions used to squeeze 记录 onto two lines, which moved
          every row below it down by a line height. */}
      <h1 className="page-title shrink-0 whitespace-nowrap">{title}</h1>
      {/* The count is the one number worth reading at a glance, so it sits on the
          stat step rather than being another caption chip. role=status announces
          it when a filter or a delete changes the number. */}
      {count !== undefined && (
        <span
          role="status"
          aria-live="polite"
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-stat leading-none font-semibold tabular-nums text-muted-foreground"
        >
          {count}
        </span>
      )}
      {hint && (
        <span className="app-desc min-w-0 flex-1 truncate text-caption text-muted-foreground">
          {hint}
        </span>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
