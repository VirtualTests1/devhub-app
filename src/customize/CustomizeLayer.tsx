import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, TriangleAlert } from "lucide-react";
import { create } from "zustand";
import { confirmDestructive } from "../lib/confirm";
import {
  ELEMENT_BY_ID,
  LAYOUT_MIN_H,
  LAYOUT_MIN_W,
  buildStyleSheet,
  sanitizeUserCss,
  useCustomize,
  type LayoutRect,
} from "../store/customize";
import { cn } from "../lib/utils";
import { useI18n } from "../lib/useI18n";

/**
 * The runtime half of the element registry: injects the generated stylesheet and
 * provides the in-page editing surface for 开发者模式.
 *
 * Split from `store/customize.ts` because that file is pure data (and therefore
 * testable and importable from the 设置 view), while everything here touches the
 * document.
 */

// ---------------------------------------------------------------------------
// Selection (transient — never persisted)
// ---------------------------------------------------------------------------

type SelectionState = {
  /** The element the inspector is showing. */
  selected: string | null;
  /** Hover outline follows the pointer in developer mode. */
  hovered: string | null;
  /** Set while a drag/resize gesture is in flight, to suppress the click. */
  dragging: boolean;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  setDragging: (v: boolean) => void;
};

export const useSelection = create<SelectionState>((set) => ({
  selected: null,
  hovered: null,
  dragging: false,
  select: (selected) => set({ selected }),
  hover: (hovered) => set({ hovered }),
  setDragging: (dragging) => set({ dragging }),
}));

/** Nearest registered ancestor (or self) for a DOM node. */
function regIdOf(node: EventTarget | null): string | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest("[data-reg-id]");
  if (!el) return null;
  const id = el.getAttribute("data-reg-id");
  return id && ELEMENT_BY_ID[id] ? id : null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CustomizeLayer({ children }: { children: React.ReactNode }) {
  const overrides = useCustomize((s) => s.overrides);
  const devMode = useCustomize((s) => s.devMode);
  const sidebarWidth = useCustomize((s) => s.sidebarWidth);
  const selected = useSelection((s) => s.selected);
  const select = useSelection((s) => s.select);
  const hover = useSelection((s) => s.hover);

  const sheet = useMemo(() => {
    const base = buildStyleSheet({ overrides, sidebarWidth });
    // The selected block's marker is transient, so it is appended here rather
    // than pushed through the persisted stylesheet builder.
    return devMode && selected
      ? `${base}\n[data-reg-id="${selected}"] { outline: 2px solid var(--color-primary) !important; }`
      : base;
  }, [overrides, sidebarWidth, devMode, selected]);

  // Developer mode swallows the click on a registered block and opens the
  // inspector for it instead. Capture phase, so a block's own onClick cannot
  // win the race — which is the point: in developer mode a click means "select",
  // not "activate".
  useEffect(() => {
    if (!devMode) {
      hover(null);
      return;
    }
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      // Developer mode selects a block instead of activating it — but only for
      // clicks that are not already aimed at a control. Without the interactive
      // check, a settings row that is itself registered swallowed every switch
      // and 档位 button inside it, so the page became read-only at exactly the
      // moment you wanted to adjust it. Inspectors elsewhere work the same way:
      // click the label to select, click the control to use it.
      if (
        target?.closest?.(
          "[data-dev-panel],[data-no-row-click],button,select,input,textarea,a[href]",
        )
      )
        return;
      const id = regIdOf(ev.target);
      if (!id) return;
      if (useSelection.getState().dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      select(id);
    };
    const onMove = (ev: MouseEvent) => hover(regIdOf(ev.target));
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") select(null);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [devMode, select, hover]);

  return (
    <>
      <style id="devhub-customize">{sheet}</style>
      <div
        className={cn(
          "flex h-full w-full min-h-0 flex-col",
          devMode && "dev-mode-on",
        )}
      >
        {children}
      </div>
      {devMode && <Inspector />}
      {devMode && <LayoutHandles />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

/**
 * The developer panel.
 *
 * Deliberately a fixed side card rather than a modal: the whole point of
 * "直接在页面中进行调整" is that the thing being edited stays visible while it is
 * being edited, and a modal would cover it.
 */
function Inspector() {
  const { t } = useI18n();
  const selected = useSelection((s) => s.selected);
  const select = useSelection((s) => s.select);
  const def = selected ? ELEMENT_BY_ID[selected] : undefined;
  const override = useCustomize((s) => (selected ? s.overrides[selected] : undefined));
  const setOverride = useCustomize((s) => s.setOverride);
  const setSize = useCustomize((s) => s.setSize);
  const setLayout = useCustomize((s) => s.setLayout);
  const setCss = useCustomize((s) => s.setCss);
  const resetElement = useCustomize((s) => s.resetElement);
  const [cssDraft, setCssDraft] = useState(override?.css ?? "");
  /**
   * The x/y/w/h fields hold a string draft and only write on blur/Enter.
   * Committing (and therefore clamping) on every keystroke would turn "4"
   * into "40" before the user could finish typing "45" — which is exactly
   * how the old live-写入 inputs ended up storing whatever `Number()` made
   * of a half-typed value (审计 G11).
   */
  const [layoutDraft, setLayoutDraft] = useState<Record<"x" | "y" | "w" | "h", string> | null>(
    null,
  );
  const overrideCount = useCustomize((s) => Object.keys(s.overrides).length);

  // The draft resets on selection change, and when the stored css itself moves
  // (reset / import while the panel is open). It is keyed on the *value*, so typing
  // in the field — which only writes the draft until commit — does not reset it.
  useEffect(() => setCssDraft(override?.css ?? ""), [selected, override?.css]);
  useEffect(() => setLayoutDraft(null), [selected]);

  // G7 的另一半：过滤本身一直在跑（buildStyleSheet 每次生成都剔除非法声明），
  // 但被丢掉的内容此前只存在于函数返回值里，写的人看到的是「没反应」。
  // 草稿实时过一遍同一套过滤器，把「几段被丢、丢的是什么」摆在输入框下面。
  const cssCheck = useMemo(() => sanitizeUserCss(cssDraft), [cssDraft]);

  // 审计 N1：经Inspector 隐藏常驻区块必须先确认。
  //
  // 自锁链条：devMode 下经这里隐藏 titlebar或sidebar-nav → 自救按钮本身住在
  // titlebar 里（TitleBar.tsx），跟着一起 display:none → 用户既没有导航可
  // 点，也看不到恢复入口，只剩 localStorage 可改。界面管理列表
  //（InterfaceRegistry.onHide）早就为同一条命令加了确认，这里是它的漏网分支。
  const onToggleHidden = useCallback(async () => {
    if (!def) return;
    if (def.critical && !override?.hidden) {
      // titlebar 自带窗口控件与自救按钮，隐藏它的后果比其它区块更重。
      const extra =
        def.id === "titlebar"
          ? t("dev.hideTitlebar")
          : def.id === "sidebar-nav"
            ? t("dev.hideSidebar")
            : "";
      const ok = await confirmDestructive(
        t("dev.hideConfirm", { label: def.label, extra }),
        { title: t("dev.hideTitle"), okLabel: t("dev.hide") },
      );
      if (!ok) return;
    }
    setOverride(def.id, { hidden: !override?.hidden });
  }, [def, override?.hidden, setOverride, t]);

  // 审计 N1 第三层：Inspector 不是注册元素（没有 data-reg-id），因此
  // 任何区块被隐藏都不会把它带走。只要 devMode 开着，它就是最后一道
  // 出口——包括标题栏已经被隐藏、用户点不到任何东西的那种情况。
  const onResetAll = useCallback(async () => {
    const ok = await confirmDestructive(
      t("dev.resetConfirm"),
      { title: t("dev.resetTitle"), okLabel: t("dev.reset") },
    );
    if (ok) useCustomize.getState().resetAll();
  }, [t]);

  if (!def) {
    return (
      <aside
        data-dev-panel
        className="skin-pop fixed right-3 top-14 z-[var(--z-inspector)] w-64 border border-border bg-raised p-3 text-caption"
      >
        <p className="skin-label font-medium">{t("dev.title")}</p>
        <p className="app-desc mt-1 leading-snug text-muted-foreground">
          {t("dev.intro")}
        </p>
        {overrideCount > 0 && (
          <button
            type="button"
            onClick={() => void onResetAll()}
            title={t("dev.resetAllTitle")}
            className="skin-ctl mt-2 w-full border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("dev.resetAll", { n: overrideCount })}
          </button>
        )}
      </aside>
    );
  }

  const layout = override?.layout;

  return (
    <aside
      data-dev-panel
      className="skin-pop fixed right-3 top-14 z-[var(--z-inspector)] flex max-h-[80vh] w-72 flex-col gap-3 overflow-y-auto border border-border bg-raised p-3 text-caption"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{def.label}</p>
          <p className="truncate text-muted-foreground">
            {def.group} · <code>{def.id}</code>
          </p>
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("dev.collapse")}
        </button>
      </div>

      {def.hint && <p className="leading-snug text-muted-foreground">{def.hint}</p>}
      {def.critical && (
        <p className="rounded-lg bg-warning/10 px-2 py-1.5 leading-snug text-warning">
          {t("dev.critical")}
        </p>
      )}

      <Row label={t("dev.show")}>
        <button
          type="button"
          onClick={() => void onToggleHidden()}
          className={cn(
            "skin-ctl border px-2 py-1 transition-colors",
            override?.hidden
              ? "border-border text-muted-foreground"
              : "border-primary/60 bg-primary/10 font-medium",
          )}
        >
          {override?.hidden ? t("dev.hidden") : t("dev.shown")}
        </button>
      </Row>

      {def.sizes && (
        <Row label={t("dev.size")}>
          <div className="flex flex-wrap gap-1">
            {def.sizes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSize(def.id, override?.size === t.id ? undefined : t.id)}
                className={cn(
                  "skin-ctl border px-1.5 py-0.5 transition-colors",
                  override?.size === t.id
                    ? "border-primary/60 bg-primary/10 font-medium"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Row>
      )}

      <Row label={t("dev.order")}>
        <div className="flex items-center gap-1">
          <StepBtn label={t("dev.orderDown")} onClick={() => setOverride(def.id, { order: (override?.order ?? 0) - 1 })}>
            <Minus className="h-3 w-3" />
          </StepBtn>
          <span className="w-8 text-center tabular-nums">{override?.order ?? 0}</span>
          <StepBtn label={t("dev.orderUp")} onClick={() => setOverride(def.id, { order: (override?.order ?? 0) + 1 })}>
            <Plus className="h-3 w-3" />
          </StepBtn>
        </div>
      </Row>

      {def.layoutable && (
        <div className="rounded-lg border border-border-weak p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-muted-foreground">{t("dev.layout")}</span>
            <button
              type="button"
              onClick={() => setLayout(def.id, undefined)}
              className="text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              {t("dev.clear")}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {(["x", "y", "w", "h"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <span className="w-3 text-muted-foreground">{k}</span>
                <input
                  type="number"
                  value={layoutDraft?.[k] ?? String(Math.round(layout?.[k] ?? 0))}
                  onChange={(e) => {
                    const typed = e.target.value;
                    setLayoutDraft((d) => ({
                      x: d?.x ?? String(Math.round(layout?.x ?? 0)),
                      y: d?.y ?? String(Math.round(layout?.y ?? 0)),
                      w: d?.w ?? String(Math.round(layout?.w ?? 0)),
                      h: d?.h ?? String(Math.round(layout?.h ?? 0)),
                      [k]: typed,
                    }));
                  }}
                  onBlur={() => {
                    if (!layoutDraft) return;
                    // Invalid text (an intermediate "-" or "") falls back to the
                    // stored value; setLayout then runs clampLayout, so nothing
                    // the generator would drop can leave this panel (G11).
                    const num = (key: "x" | "y" | "w" | "h") => {
                      const raw = Number(layoutDraft[key]);
                      return Number.isFinite(raw) ? raw : (layout?.[key] ?? 0);
                    };
                    setLayout(def.id, { x: num("x"), y: num("y"), w: num("w"), h: num("h") });
                    setLayoutDraft(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="w-full rounded border border-input bg-background px-1.5 py-0.5 outline-none focus:border-primary"
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              const el = document.querySelector(`[data-reg-id="${def.id}"]`);
              if (!el) return;
              const r = el.getBoundingClientRect();
              setLayout(def.id, { x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) });
            }}
            className="mt-1.5 w-full rounded border border-border px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("dev.useCurrent")}
          </button>
        </div>
      )}

      <div>
        <p className="mb-1 text-muted-foreground">{t("dev.css")}</p>
        <textarea
          value={cssDraft}
          spellCheck={false}
          aria-label={t("dev.cssAria")}
          onChange={(e) => setCssDraft(e.target.value)}
          onBlur={() => setCss(def.id, cssDraft)}
          placeholder={"background-color: oklch(0.2 0.02 200);\ngap: 4px;"}
          className="h-20 w-full resize-y rounded border border-input bg-background p-2 font-mono text-caption outline-none focus:border-primary"
          aria-describedby={cssDraft.trim() !== "" && cssCheck.dropped > 0 ? "css-draft-feedback" : undefined}
        />
        {cssDraft.trim() !== "" && cssCheck.dropped > 0 ? (
          <p
            id="css-draft-feedback"
            role="status"
            className="mt-1 flex items-start gap-1 text-caption text-warning"
            title={cssCheck.rejected.join("\n")}
          >
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {t("dev.cssDropped", { n: cssCheck.dropped })}
            </span>
          </p>
        ) : null}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={() => setCss(def.id, cssDraft)}
            className="skin-ctl bg-primary px-2 py-1 font-medium text-primary-foreground"
          >
            {t("dev.apply")}
          </button>
          <button
            type="button"
            onClick={() => resetElement(def.id)}
            className="skin-ctl border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            {t("dev.resetElement")}
          </button>
        </div>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function StepBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="skin-ctl h-5 w-5 border border-border leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Free-layout drag handles
// ---------------------------------------------------------------------------

/**
 * Wraps a block so developer mode can drag and resize it.
 *
 * Kept as a hook rather than a wrapper element for the same reason `reg()` is:
 * an extra DOM node would change which element is the flex/grid child, and the
 * repository wall's column count is already sensitive to that (see the
 * `min-content` note in index.css).
 */
export function useFreeLayout(id: string) {
  const devMode = useCustomize((s) => s.devMode);
  const setLayout = useCustomize((s) => s.setLayout);
  const setDragging = useSelection((s) => s.setDragging);
  const start = useRef<{ x: number; y: number; rect: DOMRect; base: LayoutRect } | null>(null);
  /**
   * The window listeners while a drag is live. `onUp` was their only way off,
   * and a drag interrupted by devMode flipping (this hook returns null, its
   * handles disappear) or by the host unmounting mid-drag never runs it — two
   * pointermove/pointerup listeners then sit on window forever. The pair is
   * parked in a ref so the effect below can detach whatever is still attached.
   */
  const attached = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  const detach = useCallback(() => {
    if (!attached.current) return;
    window.removeEventListener("pointermove", attached.current.move);
    window.removeEventListener("pointerup", attached.current.up);
    attached.current = null;
  }, []);
  useEffect(() => {
    // devMode going false is an interruption in its own right: the drag handles
    // are unmounted, so no pointerup will ever reach this instance.
    if (!devMode) detach();
    return detach;
  }, [devMode, detach]);

  const begin = useCallback(
    (
      mode: "move" | "resize",
      ev: React.PointerEvent,
      // The overlay handles (LayoutHandles) live outside the registered block,
      // so they pass the element in; prop-style callers keep using closest().
      elOverride?: HTMLElement | null,
    ) => {
      if (!devMode) return;
      const el =
        elOverride ??
        ((ev.currentTarget as HTMLElement).closest("[data-reg-id]") as HTMLElement | null);
      if (!el) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = el.getBoundingClientRect();
      const cur = useCustomize.getState().overrides[id]?.layout;
      // G11: a stored layout of {w:0,h:0} — which the number inputs used to
      // accept — must not become the gesture base; the first resize would jump
      // from zero to (dx+40). Take the live rect for anything degenerate.
      const usable = cur && cur.w > 0 && cur.h > 0;
      const base: LayoutRect = usable
        ? cur
        : { x: cur?.x ?? 0, y: cur?.y ?? 0, w: Math.round(r.width), h: Math.round(r.height) };
      start.current = {
        x: ev.clientX,
        y: ev.clientY,
        rect: r,
        base,
      };
      setDragging(true);
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);

      const onMove = (e: PointerEvent) => {
        const s = start.current;
        if (!s) return;
        let dx = e.clientX - s.x;
        let dy = e.clientY - s.y;
        if (mode === "move") {
          // G11: unclamped translate could push a block clean off the screen
          // with no way back except 清除. Keep at least a grip of it visible.
          const minDx = -r.width + 48 - r.left;
          const maxDx = window.innerWidth - 48 - r.left;
          const minDy = -r.height + 24 - r.top;
          const maxDy = window.innerHeight - 24 - r.top;
          dx = Math.min(maxDx, Math.max(minDx, dx));
          dy = Math.min(maxDy, Math.max(minDy, dy));
          setLayout(id, { ...s.base, x: s.base.x + dx, y: s.base.y + dy });
        } else {
          setLayout(id, {
            ...s.base,
            w: Math.max(LAYOUT_MIN_W, Math.round(s.base.w + dx)),
            h: Math.max(LAYOUT_MIN_H, Math.round(s.base.h + dy)),
          });
        }
      };
      const onUp = () => {
        start.current = null;
        // The click that follows pointerup must not re-open the inspector as if
        // the user had simply clicked the block.
        window.setTimeout(() => setDragging(false), 0);
        detach();
      };
      attached.current = { move: onMove, up: onUp };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [devMode, id, setDragging, setLayout, detach],
  );

  if (!devMode) return null;
  return {
    begin,
    onMovePointerDown: (ev: React.PointerEvent) => begin("move", ev),
    onResizePointerDown: (ev: React.PointerEvent) => begin("resize", ev),
  };
}

// ---------------------------------------------------------------------------
// Free-layout handles (the consumer side of useFreeLayout)
// ---------------------------------------------------------------------------

/**
 * Move/resize affordances for the selected layoutable block, positioned over
 * its live bounding rect. An overlay rather than per-block markup: `reg()`'s
 * whole design is "no extra DOM node" (an inserted wrapper would become the
 * flex/grid child and change the wall's column computation), and the audit's
 * G2 ask — wire the gesture that already existed — is satisfied by driving the
 * same hook from here. Keyboard equivalents stay in the Inspector's x/y/w/h
 * inputs, so the handles are pointer-only (`aria-hidden`, `tabIndex=-1`).
 */
function LayoutHandles() {
  const { t } = useI18n();
  const devMode = useCustomize((s) => s.devMode);
  const selected = useSelection((s) => s.selected);
  const dragging = useSelection((s) => s.dragging);
  const def = selected ? ELEMENT_BY_ID[selected] : undefined;
  const layout = useCustomize((s) => (selected ? s.overrides[selected]?.layout : undefined));
  const hidden = useCustomize((s) => (selected ? s.overrides[selected]?.hidden : undefined));
  const gesture = useFreeLayout(selected ?? "");
  const [rect, setRect] = useState<DOMRect | null>(null);

  const active = Boolean(devMode && selected && def?.layoutable && !hidden && gesture);

  useEffect(() => {
    if (!active || !selected) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-reg-id="${selected}"]`) as HTMLElement | null;
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.left === r.left &&
        prev.top === r.top &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : r,
      );
    };
    measure();
    const target = document.querySelector(`[data-reg-id="${selected}"]`);
    const ro = new ResizeObserver(measure);
    if (target) ro.observe(target);
    window.addEventListener("resize", measure);
    // A scrolling container moves the block under these fixed-position handles.
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, selected, layout, dragging]);

  if (!active || !selected || !gesture || !rect || rect.width === 0) return null;
  const elFor = () =>
    document.querySelector(`[data-reg-id="${selected}"]`) as HTMLElement | null;

  return (
    <div
      data-no-row-click
      aria-hidden="true"
      className="z-[var(--z-inspector)]"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        title={t("dev.dragMove")}
        onPointerDown={(ev) => gesture.begin("move", ev, elFor())}
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          transform: "translate(-50%, -100%)",
          pointerEvents: "auto",
        }}
        className="cursor-move touch-none select-none whitespace-nowrap border border-primary/60 bg-primary/15 px-2 py-0.5 text-caption text-primary backdrop-blur-sm"
      >
        {t("dev.drag")}
      </button>
      <button
        type="button"
        tabIndex={-1}
        title={t("dev.dragResize")}
        onPointerDown={(ev) => gesture.begin("resize", ev, elFor())}
        style={{
          position: "absolute",
          right: -6,
          bottom: -6,
          pointerEvents: "auto",
        }}
        className="h-3.5 w-3.5 cursor-nwse-resize touch-none select-none border border-primary/60 bg-primary/15 backdrop-blur-sm"
      />
    </div>
  );
}
