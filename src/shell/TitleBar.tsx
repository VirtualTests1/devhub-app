import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { reg, useCustomize } from "../store/customize";
import { toast } from "../components/Toast";
import { useAppearance } from "../store/appearance";
import { useUI } from "../store/ui";
import { viewTitle } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";

/**
 * Self-drawn title bar for the frameless window.
 *
 * Why this exists at all: the window is `decorations: false`, so without these
 * three buttons the app could not be minimised or closed with a mouse. That is
 * also why `onClosed` is wired through the Rust side rather than trusting the
 * webview to go away on its own.
 *
 * Dragging uses `data-tauri-drag-region`, which routes through the OS's own
 * non-client drag (WM_NCLBUTTONDOWN) rather than a JS mousedown handler. That
 * distinction is what keeps Windows 11 snap layouts and "drag to the top edge
 * maximises" working on a window with no title bar — a hand-rolled drag makes
 * those disappear.
 */
export function TitleBar({ version }: { version: string }) {
  const collapsed = useCustomize((s) => s.sidebarCollapsed);
  const setCollapsed = useCustomize((s) => s.setSidebarCollapsed);
  const devMode = useCustomize((s) => s.devMode);
  const showVersion = useAppearance((s) => s.showVersion);
  // 自救入口只在真的有自定义时出现（G4）。
  const overrideCount = useCustomize((s) => Object.keys(s.overrides).length);
  const draggedWidth = useCustomize((s) => s.sidebarWidth);
  const hasCustomization = overrideCount > 0 || draggedWidth > 0;
  const view = useUI((s) => s.view);
  const back = useUI((s) => s.back);
  const forward = useUI((s) => s.forward);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  // Tooltips name the *destination*, not the verb — "后退" already says what the
  // button does, and a tooltip that repeats the label adds nothing.
  // r16-n2-2: the selectors yield the raw ViewId (a selector cannot depend on
  // `t`, which changes with the locale); the label itself is resolved in render
  // through `viewTitle(t, id)` so an English tooltip follows the language row.
  const backTarget = useUI((s) => (s.pointer > 0 ? s.history[s.pointer - 1]?.view ?? null : null));
  const fwdTarget = useUI((s) =>
    s.pointer < s.history.length - 1 ? s.history[s.pointer + 1]?.view ?? null : null);
  const go = useUI((s) => s.go);
  const settingsEntry = useCustomize((s) => s.settingsEntry);
  const [maximised, setMaximised] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void win.isMaximized().then((v) => {
      if (cancelled) return;
      setMaximised(v);
    });
    const p = win.onResized(async () => {
      setMaximised(await win.isMaximized());
    });
    void p.then((f) => {
      if (cancelled) f();
      else unlisten = f;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div
      {...reg("titlebar")}
      data-tauri-drag-region
      onDoubleClick={() => void win.toggleMaximize()}
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b border-border-weak bg-strip px-1.5",
        "select-none",
      )}
    >
      <button
        type="button"
        {...reg("sidebar-collapse")}
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? t("shell.sidebar.expand") : t("shell.sidebar.collapse")}
        className="skin-ctl flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {collapsed ? (
          <PanelLeftOpen className="h-3.5 w-3.5" />
        ) : (
          <PanelLeftClose className="h-3.5 w-3.5" />
        )}
      </button>

      {/* 需求 3：无边框窗口里没有任何系统导航可以借，前进/后退必须自己给。
          禁用态保留在 DOM 里而不是消失，否则工具条宽度会随历史长度跳动。 */}
      <button
        type="button"
        {...reg("titlebar-back")}
        onClick={back}
        disabled={!backTarget}
        aria-label={backTarget ? t("titlebar.backTo", { target: viewTitle(t, backTarget) }) : t("titlebar.noBack")}
        title={backTarget ? t("titlebar.backTo", { target: viewTitle(t, backTarget) }) : t("titlebar.noBack")}
        className="skin-ctl flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        {...reg("titlebar-forward")}
        onClick={forward}
        disabled={!fwdTarget}
        aria-label={fwdTarget ? t("titlebar.fwdTo", { target: viewTitle(t, fwdTarget) }) : t("titlebar.noFwd")}
        title={fwdTarget ? t("titlebar.fwdTo", { target: viewTitle(t, fwdTarget) }) : t("titlebar.noFwd")}
        className="skin-ctl flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        {...reg("titlebar-search")}
        onClick={() => setPaletteOpen(true)}
        title={t("shell.search.open")}
        className="skin-ctl ml-0.5 flex h-7 items-center gap-1.5 rounded-md border border-border-weak bg-card px-1.5 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">{t("shell.search.label")}</span>
        <kbd className="rounded border border-border-weak px-1 text-caption text-muted-foreground">Ctrl K</kbd>
      </button>

      <span
        data-tauri-drag-region
        className="flex h-4 w-4 shrink-0 items-center justify-center text-primary"
      >
        <Box className="h-3 w-3" />
      </span>
      <span data-tauri-drag-region className="skin-title truncate text-caption font-medium">
        DevHub
      </span>
      <span data-tauri-drag-region className="app-desc truncate text-caption text-muted-foreground">
        {viewTitle(t, view)}
      </span>
      {devMode && (
        <span
          className="ml-1 shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-caption text-primary"
          title={t("shell.devMode.title")}
        >
          {t("shell.devMode.label")}
        </span>
      )}
      {/* 审计 G4：界面被改得找不到北时的自救入口 —— 只要存在任何自定义
          （隐藏/档位/拖宽），标题栏就给出一个常驻恢复按钮，不再需要用户
          会背 localStorage 键名。
          审计 N1：原先还带 `!devMode` 条件，而 devMode 恰恰是唯一能隐藏
          titlebar 本身的状态 —— 那等于「关掉开发者模式前先失去自救能力」。
          自救入口必须无条件常驻。*/}
      {hasCustomization && (
        <button
          type="button"
          onClick={() => {
            void (async () => {
              // Statically imported: five other modules pull this same module in
              // at the top level, so the dynamic form never split it out of the
              // main chunk anyway — it only cost a bundler warning.
              const ok = await ask(
                t("shell.reset.confirm"),
                {
                  title: t("shell.reset.title"),
                  kind: "warning",
                  okLabel: t("shell.reset.ok"),
                  cancelLabel: t("shell.reset.cancel"),
                },
              );
              if (ok) {
                useCustomize.getState().resetAll();
                // 需求 5: every state-changing action reports. This one used to
                // be silent, which read as "the click did nothing" on the very
                // screen the user was trying to fix.
                toast.success(t("shell.reset.done"));
              }
            })();
          }}
          title={t("shell.reset.hint")}
          className="ml-1 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t("shell.reset.label")}
        </button>
      )}

      <span className="ml-auto" />

      {/* 需求 10: the optional title-bar placement for the settings entry.
          Exactly one of this and the sidebar-footer button renders - the
          choice lives in 外观 → 界面区块 - and both carry the same
          `nav-item-settings` registry id, so 界面's 显示/隐藏 switch governs
          the entry wherever it is. */}
      {settingsEntry === "titlebar" && (
        <button
          type="button"
          onClick={() => go("settings")}
          {...reg("nav-item-settings")}
          title={t("view.settings")}
          aria-label={t("view.settings")}
          className={cn(
            "skin-ctl mr-1 flex h-7 w-7 shrink-0 items-center justify-center transition-colors",
            view === "settings"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      )}

      <WinBtn label={t("shell.win.minimize")} onClick={() => void win.minimize()}>
        <Minus className="h-3.5 w-3.5" />
      </WinBtn>
      <WinBtn label={maximised ? t("shell.win.restore") : t("shell.win.maximize")} onClick={() => void win.toggleMaximize()}>
        {/* Drawn with boxes rather than an icon component: the two states are a
            square and an offset square, and that reads correctly at every DPI
            without depending on which glyph names the pinned lucide version
            happens to export. */}
        {maximised ? (
          <span className="relative block h-2.5 w-2.5">
            <span className="absolute right-0 top-0 h-2.5 w-2.5 border border-current" />
            <span className="absolute -left-0.5 -bottom-0.5 h-2.5 w-2.5 border border-current bg-strip" />
          </span>
        ) : (
          <span className="block h-2.5 w-2.5 border border-current" />
        )}
      </WinBtn>
      <WinBtn label={t("shell.win.close")} danger onClick={() => void win.close()}>
        <X className="h-3.5 w-3.5" />
      </WinBtn>
      {version && showVersion && (
        <span className="app-desc sr-only">v{version}</span>
      )}
    </div>
  );
}



function WinBtn({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 w-11 items-center justify-center text-muted-foreground transition-colors",
        danger ? "hover:bg-danger/80 hover:text-white" : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
