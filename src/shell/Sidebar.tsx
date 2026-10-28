import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GitFork,
  LayoutGrid,
  History,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useAutoLayers } from "../lib/motion";
import { viewTitle } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { useUI, type ViewId } from "../store/ui";
import { useAppearance } from "../store/appearance";
import { railWidths } from "./geometry";
import { reg, useCustomize } from "../store/customize";

/**
 * Navigation rail.
 *
 * `memo`: the rail is a child of `AppShell`, which owns the 阅读进度 state and
 * therefore re-renders while the page scrolls. Everything the rail draws comes from
 * its own store subscriptions plus five props, so a scroll gesture has nothing to
 * tell it — without this the whole nav subtree re-rendered per render of the shell.
 *
 * Round 3 changed three things here, all of them registry-driven:
 *
 *   - it collapses to an icon rail (title-bar button, or drag the edge to 0),
 *   - its width is a real user setting — a 档位 in 设置, or dragged pixel-exact
 *     with the handle on its right edge,
 *   - every block in it carries a `data-reg-id`, so 显示/隐藏/顺序 no longer
 *     needs a bespoke `show*` boolean per block.
 *
 * The nav items themselves can be drag-reordered (HTML5 draggable, with a
 * drop indicator line); the sequence is stored as each item's registry `order`,
 * so it persists in the same localStorage blob as everything else 界面 and
 * survives a restart or a layout export/import unchanged.
 *
 * The rail is now a rounded, shadowed panel sitting *on* the window background
 * rather than a flush column: that gap is where the "侧边栏和界面之间要有层次感"
 * comes from. Colour still does no hierarchy work here — the elevation ladder in
 * index.css does (`--color-sidebar` is one step above `--color-strip`).
 *
 * Round 9 (需求 10): 设置 and 外观 left the primary navigation. 外观 became a
 * settings catalog page and 设置 became a secondary destination, so the rail
 * carries four content views and a separated footer zone holds 设置 above
 * 刷新 — the conventional place for it, and visibly not a peer of 项目.
 */

// r16-n2-2: the rail's own NAV table no longer carries hardcoded Chinese
// labels — they duplicated VIEW_LABEL byte for byte but were a second table
// the shell never read from (the false premise this round corrected: the
// rail did not consume VIEW_LABEL at all). The rendered label now resolves
// through `viewTitle(t, id)` (lib/i18n), so one dictionary owns both the
// rail and the title bar, and the English locale reaches the nav without a
// second table. The registry/icon halves are unchanged.
const NAV: {
  id: ViewId;
  icon: React.ReactNode;
  regId: string;
}[] = [
  { id: "projects", icon: <LayoutGrid className="h-4 w-4" />, regId: "nav-item-projects" },
  { id: "add", icon: <Plus className="h-4 w-4" />, regId: "nav-item-add" },
  { id: "records", icon: <History className="h-4 w-4" />, regId: "nav-item-records" },
  { id: "frequent", icon: <Sparkles className="h-4 w-4" />, regId: "nav-item-frequent" },
];

/** Below this the rail stops being a rail; above it the labels come back.
 *
 *  These are rem multiples, not px constants: at the default 16px root they resolve
 *  to the 52 / 148 / 340 px the rail was measured at, but a 20-22px 界面字号 no
 *  longer leaves the collapsed rail narrower than its own icons.
 *
 *  They are resolved through `railWidths(uiFontPx)` (see `shell/geometry.ts`) and
 *  re-rendered from the `uiFontPx` subscription below — not read back off the
 *  document with `getComputedStyle` per render, which was both a forced layout and
 *  a value that went stale, because the shell applies appearance without re-rendering. */

export const Sidebar = memo(function Sidebar({
  repoCount,
  runningCount,
  version,
  onRefresh,
  refreshing,
}: {
  repoCount: number;
  /** Live processes, so leaving the 项目 page does not hide the fact that something is running. */
  runningCount: number;
  version: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const view = useUI((s) => s.view);
  const go = useUI((s) => s.go);
  // r16-n2-2: one subscription re-renders the rail on a language switch;
  // `t` is memoised on the locale (lib/useI18n), so an unrelated render
  // does not churn the nav's children.
  const { t } = useI18n();
  // 界面区块 switches (需求 6): these three used to store state nothing read;
  // they now gate the actual blocks.
  const showBrand = useAppearance((s) => s.showBrand);
  const showRefresh = useAppearance((s) => s.showRefresh);
  const showVersion = useAppearance((s) => s.showVersion);
  /**
   * The rail's px geometry follows 界面字号 through this subscription: the rem
   * multiples above resolve against exactly the px value `applyAppearance` writes to
   * the root, so the collapsed width and the drag clamps change on the same tick the
   * setting does instead of waiting for an unrelated render.
   */
  const uiFontPx = useAppearance((s) => s.uiFontPx);
  const rail = useMemo(() => railWidths(uiFontPx), [uiFontPx]);
  const collapsed = useCustomize((s) => s.sidebarCollapsed);
  const setCollapsed = useCustomize((s) => s.setSidebarCollapsed);
  const settingsEntry = useCustomize((s) => s.settingsEntry);
  const manualWidth = useCustomize((s) => s.sidebarWidth);
  const setManualWidth = useCustomize((s) => s.setSidebarWidth);
  const overrides = useCustomize((s) => s.overrides);
  const setOrder = useCustomize((s) => s.setOrder);
  const dragging = useRef(false);

  // 拖拽调序: order lives in the element registry (overrides[regId].order),
  // the same channel 设置 → 界面 and export/importLayout already use, so the
  // sequence survives restarts and travels with a layout export.
  const [dragId, setDragId] = useState<string | null>(null);
  /** Insertion index into the list *without* the dragged item. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const orderedNav = useMemo(
    () =>
      [...NAV].sort(
        (a, b) =>
          (overrides[a.regId]?.order ?? NAV.indexOf(a)) -
          (overrides[b.regId]?.order ?? NAV.indexOf(b)),
      ),
    [overrides],
  );

  const finishDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const dropAt = (target: (typeof NAV)[number], ev: React.DragEvent) => {
    if (!dragId || dragId === target.id) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    const rect = ev.currentTarget.getBoundingClientRect();
    const filtered = orderedNav.filter((n) => n.id !== dragId);
    const pos = filtered.findIndex((n) => n.id === target.id);
    setDropIndex(ev.clientY < rect.top + rect.height / 2 ? pos : pos + 1);
  };

  const commitDrop = () => {
    if (!dragId) return;
    const dragged = orderedNav.find((n) => n.id === dragId);
    const filtered = orderedNav.filter((n) => n.id !== dragId);
    const at = Math.max(0, Math.min(dropIndex ?? filtered.length, filtered.length));
    const next = [...filtered.slice(0, at), ...(dragged ? [dragged] : []), ...filtered.slice(at)];
    // Every item gets an explicit order, so the generated stylesheet and the
    // DOM agree and a partial set of overrides cannot reshuffle the rest.
    next.forEach((n, p) => setOrder(n.regId, p));
    finishDrag();
  };

  // A dragged width always beats a 档位, because the user measured it by hand.
  // The 档位 still writes `--reg-width` for the stylesheet, which loses here.
  const width = collapsed ? rail.collapsed : manualWidth > 0 ? manualWidth : undefined;
  // The handle no longer lives inside the rail (需求 3), so the drag maths reads the
  // rail's own rect rather than `event.currentTarget.parentElement`.
  const railRef = useRef<HTMLElement | null>(null);
  /**
   * The window listeners while a width drag is live — same leak as the
   * developer-mode drag: `onUp` was their only way off, and unmounting the rail
   * mid-drag leaves two listeners on window forever. Parked in a ref so the
   * unmount cleanup can detach whatever is still attached.
   */
  const resizeAttached = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  const detachResize = useCallback(() => {
    if (!resizeAttached.current) return;
    window.removeEventListener("pointermove", resizeAttached.current.move);
    window.removeEventListener("pointerup", resizeAttached.current.up);
    resizeAttached.current = null;
  }, []);
  useEffect(() => detachResize, [detachResize]);

  const startResize = (ev: React.PointerEvent) => {
    if (collapsed) return;
    ev.preventDefault();
    dragging.current = true;
    const startX = ev.clientX;
    const startW = railRef.current?.getBoundingClientRect().width ?? rail.min;
    setCollapsed(false);
    const onMove = (e: PointerEvent) => {
      const next = Math.min(rail.max, Math.max(rail.min, Math.round(startW + (e.clientX - startX))));
      setManualWidth(next);
    };
    const onUp = () => {
      dragging.current = false;
      detachResize();
    };
    resizeAttached.current = { move: onMove, up: onUp };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 导航项可以被界面自定义隐藏/显示，也可以被拖动换位；这两种变化过去都是瞬变。
  const nav = useAutoLayers();

  /**
   * Arrow-key traversal for the rail. Tab alone makes the six stops (4 views +
   * 设置 + 刷新) a chore; ↑↓/Home/End match every other composite in the app
   * (Segmented, ContextMenu) and cost no extra tab stops.
   */
  const onRailKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const root = railRef.current;
    if (!root) return;
    const stops = [...root.querySelectorAll<HTMLElement>("button:not([disabled])")];
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
      // idx is -1 when focus is outside the rail; ArrowDown then lands on 0.
      stops[idx < 0 ? (e.key === "ArrowDown" ? 0 : stops.length - 1) : next]?.focus();
    }
  };

  return (
    <>
    <aside
      ref={railRef}
      {...reg("sidebar-rail")}
      data-collapsed={collapsed}
      onKeyDown={onRailKeyDown}
      style={
        width
          ? { width, minWidth: width, maxWidth: width }
          : collapsed
            ? undefined
            : // Audit G6: the size preset writes --reg-width, but nothing read it
              // before; all four presets were inert switches. It is honoured now
              // only until the rail is dragged to an explicit width.
              {
                width: "var(--reg-width, 200px)",
                minWidth: "var(--reg-width, 200px)",
                maxWidth: "var(--reg-width, 200px)",
              }
      }
      className="relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-border-weak bg-sidebar shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-[width,min-width,max-width] duration-[var(--motion-quick)]"
    >
      {showBrand && (
        <div {...reg("sidebar-brand")} className={cn("flex items-center gap-2.5 px-3 py-3.5", collapsed && "justify-center px-0")}>
          <span {...reg("sidebar-brand-icon")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15">
            <GitFork className="h-3.5 w-3.5 text-primary" />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-brand font-semibold leading-tight">DevHub</span>
              <span {...reg("sidebar-brand-tagline")} className="app-desc block truncate text-caption text-muted-foreground">
                {t("shell.sidebar.brandTagline")}
              </span>
            </span>
          )}
        </div>
      )}

      <nav ref={nav.register} {...reg("sidebar-nav")} aria-label={t("shell.sidebar.mainNav")} className="flex flex-col gap-0.5 px-1.5">
        {(() => {
          // While dragging, the indicator addresses the list minus the dragged
          // item; convert back to render positions for the line placement.
          const filtered = dragId ? orderedNav.filter((n) => n.id !== dragId) : orderedNav;
          const line = (
            <div aria-hidden className="mx-2 h-0.5 shrink-0 rounded-full bg-primary" />
          );
          return (
            <>
              {orderedNav.map((item) => {
                const active = view === item.id;
                const isProjects = item.id === "projects";
                const isDragging = dragId === item.id;
                const lineBefore =
                  dragId !== null && dropIndex !== null && filtered[dropIndex]?.id === item.id;
                return (
                  <span key={item.id} className="flex flex-col">
                    {lineBefore && line}
                    <button
                      type="button"
                      onClick={() => go(item.id)}
                      data-active={active}
                      aria-current={active ? "page" : undefined}
                      {...reg(item.regId)}
                      title={collapsed ? viewTitle(t, item.id) : t("shell.sidebar.dragOrder")}
                      draggable={!collapsed}
                      onDragStart={(ev) => {
                        ev.dataTransfer.effectAllowed = "move";
                        ev.dataTransfer.setData("text/plain", item.id);
                        setDragId(item.id);
                        setDropIndex(null);
                      }}
                      onDragEnd={finishDrag}
                      onDragOver={(ev) => dropAt(item, ev)}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        commitDrop();
                      }}
                      className={cn(
                        "skin-nav group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-body transition-colors",
                        collapsed && "justify-center px-0",
                        isDragging && "opacity-40",
                        active
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn("skin-nav-icon relative shrink-0", active && "text-primary")}
                      >
                        {item.icon}
                        {/* Collapsed, the dot on the icon is the only channel left,
                            so the count moves into the tooltip instead of vanishing. */}
                        {isProjects && runningCount > 0 && collapsed && (
                          <span
                            aria-hidden
                            className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-success ring-2 ring-sidebar"
                          />
                        )}
                      </span>
                      {!collapsed && <span className="flex-1 truncate text-left">{viewTitle(t, item.id)}</span>}
                      {isProjects && runningCount > 0 && !collapsed && (
                        <span
                          title={t("shell.sidebar.running", { n: runningCount })}
                          className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 text-caption tabular-nums text-success"
                        >
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                          {runningCount}
                        </span>
                      )}
                      {isProjects && repoCount > 0 && !collapsed && (
                        <span
                          {...reg("sidebar-nav-badge")}
                          className="shrink-0 rounded-full bg-muted px-1.5 text-caption tabular-nums text-muted-foreground"
                        >
                          {repoCount}
                        </span>
                      )}
                    </button>
                  </span>
                );
              })}
              {dragId !== null && dropIndex !== null && dropIndex >= filtered.length && line}
            </>
          );
        })()}
      </nav>

      <div {...reg("sidebar-footer")} className="mt-auto border-t border-border-weak p-1.5">
        {/* 需求 10: 设置的常规位置——侧边栏底部独立区，与主导航之间有分隔，
            不再与项目/添加同级。位置可在 外观 → 界面区块 换成标题栏（此时由
            TitleBar 渲染同一个注册 id 的入口，同一时刻只存在一个）。 */}
        {settingsEntry === "footer" && (
          <button
            type="button"
            onClick={() => go("settings")}
            aria-current={view === "settings" ? "page" : undefined}
            {...reg("nav-item-settings")}
            title={t("view.settings")}
            className={cn(
              "skin-ctl flex w-full items-center gap-2.5 px-2 py-1.5 text-body transition-colors",
              collapsed && "justify-center px-0",
              view === "settings"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="flex-1 truncate text-left">{t("view.settings")}</span>}
          </button>
        )}
        {showRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            {...reg("sidebar-refresh")}
            title={collapsed ? t("shell.sidebar.refresh") : undefined}
            className={cn(
              "skin-ctl flex w-full items-center gap-2.5 px-2 py-1.5 text-body text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-50",
              collapsed && "justify-center px-0",
            )}
          >
            <RefreshCw className={cn("h-4 w-4 shrink-0", refreshing && "animate-spin")} />
            {!collapsed && <span className="flex-1 truncate text-left">{refreshing ? t("shell.sidebar.refreshing") : t("shell.sidebar.refresh")}</span>}
          </button>
        )}

        {showVersion && !collapsed && (
          <div {...reg("sidebar-version")} className="px-2 pb-0.5 pt-0.5 text-caption tabular-nums text-muted-foreground/70">
            v{version}
          </div>
        )}
      </div>

    </aside>

      {/* 需求 3：分隔条属于两个面板之间，不属于侧边栏内部。
          It is a sibling of the rail, sitting in the shell's 6px gap (the negative
          margins cancel its own width out, so nothing reflows), and the hairline
          only appears when the pointer is on it — a permanent line between the two
          panels would read as a border, not as something you can grab. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setCollapsed(!collapsed)}
        title={collapsed ? t("shell.sidebar.expandHint") : t("shell.sidebar.resizeHint")}
        className={cn(
          "group/rail-edge relative z-10 -mx-[3px] my-1 flex w-1.5 shrink-0 items-center justify-center rounded-full",
          collapsed ? "cursor-pointer" : "cursor-col-resize",
        )}
      >
        <span className="h-full w-px rounded-full bg-transparent transition-colors group-hover/rail-edge:bg-primary/55" />
      </div>
    </>
  );
});
