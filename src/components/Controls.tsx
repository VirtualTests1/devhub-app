import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useLayerExit } from "../lib/motion";
import { useDismiss } from "../lib/useDismiss";
import { cn } from "../lib/utils";

/**
 * The app's pick-one controls: a segmented control and one listbox menu.
 *
 * ## What round 3 built, and what round 9 fixed
 *
 * Round 3 replaced the toolbar's plain-HTML pill buttons and a system
 * `<select>` with the two controls below ("项目页的按钮并不美观"). The rule it
 * set still holds: **the control shows where it is and animates the move.**
 *
 * Round 9's audit found the job half done, and in a way that only shows up when
 * two controls stand side by side:
 *
 *   1. **Two button languages for peers.** The toolbar's 筛选/分组 were
 *      `rounded-full` pills while the dropdown triggers right beside them were
 *      rectangles — and both are simply "controls in a toolbar". Worse, the
 *      hardcoded `rounded-full` defeated the skin system: `--skin-radius-ctl`
 *      exists so a skin can set 0.125/0.5/0.6875 rem, and no pill can obey it.
 *      Now every *action* control is drawn with `skin-ctl` (radius from the
 *      skin); `rounded-full` is kept for **status badges only** (运行中,
 *      有缓存, 步骤徽标), where a pill is the right grammar.
 *   2. **A system `<select>` was still in the building.** Any row with more
 *      than four options — 项目墙列数, 默认排序, 界面字重, 默认终端 — fell back
 *      to a Windows dropdown: the one element that visibly belongs to the OS
 *      rather than the product, which is exactly what round 3 set out to
 *      remove. There is now one listbox for every case.
 *   3. **Three border tokens and two panel elevations.** Triggers used
 *      `border-border-weak`, `border-input` and `border-border`; panels used
 *      `bg-card` in two places and `bg-raised` in two others. The rule now:
 *      an *interactive* control draws `border-border` (the visible token its
 *      neighbours use), a *container* (segmented track) or *floating panel*
 *      draws `border-border-weak` / `border-border` on `bg-raised`.
 *   4. **No keyboard path.** The self-drawn menu only handled Escape, so
 *      replacing the native `<select>` would have *removed* keyboard support.
 *      The listbox below implements the full contract: Arrow/Home/End move,
 *      Enter/Space pick, Escape returns focus to the trigger, Tab leaves
 *      without picking, and letters do prefix search — which matters most on
 *      the two lists this app cannot control the length of (本机终端、IDE).
 *
 * References, as asked: shadcn/ui's Select and DropdownMenu (the Radix
 * primitives most of this ecosystem now standardises on), Linear's filter bar,
 * and Raycast's list menus. Concretely adopted: the **left check gutter** so
 * labels do not jump when the selection moves (Radix/shadcn) — the earlier
 * right-hand check pushed the label left exactly when it became current;
 * `aria-activedescendant` rather than per-item focus; a viewport-clamped,
 * flip-when-tight panel; and one surface token for every floating layer.
 */

export type Option<T extends string> = { id: T; label: string; note?: string };

/**
 * Equal-width segmented control with a sliding thumb.
 *
 * The thumb is positioned from measured geometry rather than `100% / n` in CSS,
 * because labels differ in width and a `flex-1` track would otherwise let the
 * thumb drift off the text it is supposed to sit behind.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  size = "sm",
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-value="${value}"]`);
    if (!el) return;
    setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, options.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const idx = options.findIndex((o) => o.id === value);
    if (idx < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown"
      ? (idx + 1) % options.length
      : (idx - 1 + options.length) % options.length;
    const target = options[next];
    if (!target) return;
    onChange(target.id);
    rootRef.current?.querySelector<HTMLElement>(`[data-value="${target.id}"]`)?.focus();
  };

  // r15-a11y-5: roving tabindex, the rule ContextMenu:203 already follows —
  // a radio group is **one** tab stop and the arrow keys move inside it. Every
  // `role="radio"` button used to stay tabbable, so Tab walked the options one
  // by one while the arrows jumped straight to the selection: two disagreeing
  // notions of "where am I". A `value` that matches no option (transitional
  // settings payloads) leaves the first row tabbable rather than stranding
  // the group out of the tab order.
  const tabbable = Math.max(0, options.findIndex((o) => o.id === value));

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        // `skin-ctl`, not `rounded-full`: the track is a normal control and must
        // follow the skin's radius (see the file header).
        "skin-ctl relative flex w-fit items-center border border-border-weak bg-muted/60 p-0.5",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "skin-ctl-inner pointer-events-none absolute top-0.5 bottom-0.5 bg-primary/18",
          "shadow-[0_0_0_1px_var(--color-primary)_inset]",
          "transition-[left,width] duration-[var(--motion-fast)] ease-[var(--ease-out)]",
          thumb === null && "opacity-0",
        )}
        style={{ left: thumb?.left ?? 0, width: thumb?.width ?? 0 }}
      />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          tabIndex={o.id === options[tabbable]?.id ? 0 : -1}
          data-value={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "skin-ctl-inner relative z-10 font-medium transition-colors duration-[var(--motion-quick)]",
            size === "md" ? "px-3 py-1 text-body" : "px-2.5 py-0.5 text-caption",
            value === o.id
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground active:scale-[0.97]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** How the trigger is dressed. Both variants are one control family. */
type TriggerVariant = "toolbar" | "field";

/**
 * Where a floating panel goes, given its trigger — one implementation for the
 * whole app.
 *
 * Two rules, both learned from breakage:
 *
 *   - **The panel is `fixed`, never `absolute`.** Every settings group is a
 *     panel with `overflow-hidden` (SettingsRows), so an absolutely positioned
 *     dropdown inside a row is *clipped* — which is what had happened to the
 *     font picker: it opened, and its lower half was cut off by the group it
 *     lived in.
 *   - **Clamp to the viewport, then flip.** A trigger near the right edge gets
 *     a right-aligned panel; a trigger near the bottom opens upward. Without
 *     this a 24 rem picker simply leaves the window on a 560 px-tall screen.
 *
 * Focus is deliberately *not* handled here: a menu focuses its listbox, a
 * searchable picker focuses its input, and one of them would be wrong.
 */
export function usePopoverPlacement(open: boolean, align: "start" | "end" = "start") {
  const anchorRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ top: 0, left: 0, minWidth: 0, ready: false });

  useLayoutEffect(() => {
    if (!open) {
      setAt((a) => ({ ...a, ready: false }));
      return;
    }
    const r = anchorRef.current?.getBoundingClientRect();
    const pop = popRef.current;
    if (!r || !pop) return;
    const margin = 8;
    const w = Math.max(r.width, pop.offsetWidth);
    const left = align === "end" ? r.right - w : r.left;
    const below = r.bottom + 4;
    const flip =
      below + pop.offsetHeight > window.innerHeight - margin &&
      r.top - pop.offsetHeight - margin > margin;
    setAt({
      top: flip ? r.top - pop.offsetHeight - 4 : below,
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - w - margin)),
      minWidth: r.width,
      ready: true,
    });
  }, [open, align]);

  return { anchorRef, popRef, at };
}

/**
 * A list menu — the app's only pick-one dropdown.
 *
 * `toolbar` is the compact form used in a filter bar (optional 前缀 inside the
 * trigger); `field` is the form used in a settings row's control slot, where it
 * must sit beside a `Segmented` without looking like a different species.
 *
 * Open state can be controlled (`open` + `onOpenChange`) so that a settings row
 * can be clicked anywhere to open it — the "点整块区域就能调整" behaviour the
 * rows already had with the native `<select>`.
 */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  prefix,
  className,
  width,
  variant = "toolbar",
  align = "start",
  disabled,
  open: openProp,
  onOpenChange,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  /** Small label painted inside the trigger, e.g. 排序. */
  prefix?: string;
  className?: string;
  width?: string;
  variant?: TriggerVariant;
  /** Which trigger edge the panel lines up with. */
  align?: "start" | "end";
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? !!openProp : openState;
  const setOpen = (v: boolean) => {
    if (!controlled) setOpenState(v);
    onOpenChange?.(v);
  };

  const [active, setActive] = useState(0);
  const { anchorRef, popRef, at } = usePopoverPlacement(open, align);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // `open` 一变 false，元素就在同一帧卸载；退出动画需要它多留一个 exit 时长。
  const layer = useLayerExit(open);
  const listId = useId();
  const current = options.find((o) => o.id === value);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  // Arm the active row on open, and take focus so the arrow keys land here.
  useLayoutEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    popRef.current?.focus();
    // `selectedIndex` is read once, at the moment the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    popRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // `popRef` comes from `usePopoverPlacement` (a `useRef` box), so its identity is
    // stable — naming it is what the linter needs, not a re-run.
  }, [active, open, popRef]);

  // 外部指针关闭而不抢焦点（这一下点击属于别的元素）；Escape 由面板自己的
  // onListKey 处理，好把焦点交还触发器，所以这里关掉 hook 的 escape。
  useDismiss([btnRef, popRef], () => setOpen(false), {
    enabled: open,
    capture: true,
    escape: false,
  });

  const choose = (o: Option<T>) => {
    onChange(o.id);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      // ArrowUp opens on the last option, matching a native select.
      if (e.key === "ArrowUp") setActive(Math.max(0, options.length - 1));
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i <= 0 ? last : i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(last);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (options[active]) choose(options[active]);
        return;
      case "Escape":
        e.preventDefault();
        // 对话框现在也在 document 层监听 Escape（DialogShell）。列表获得焦点时
        // 必须就地消费这次按键，否则关闭下拉的同时会把整个对话框一起关掉。
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
        return;
      case "Tab":
        // Leave without picking; the browser moves focus on its own.
        setOpen(false);
        return;
      default:
        break;
    }
    // Prefix search. The two lists this app cannot shorten are 本机终端 and
    // IDE, where arrowing through a dozen entries is the slow path.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const order = [...options.slice(active + 1), ...options.slice(0, active + 1)];
      const hit = order.find((o) => o.label.toLowerCase().startsWith(k));
      if (!hit) return;
      e.preventDefault();
      setActive(options.indexOf(hit));
    }
  };

  return (
    <>
      <button
        ref={(el) => {
          // One element, two jobs: the placement anchor and the focus target
          // Escape hands back to.
          btnRef.current = el;
          anchorRef.current = el;
        }}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
        className={cn(
          "skin-ctl flex items-center gap-1.5 border bg-card text-caption text-foreground",
          "transition-colors duration-[var(--motion-quick)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          variant === "field" ? "min-w-[7rem] max-w-[15rem] px-2 py-1" : "px-2.5 py-1",
          open ? "border-primary/60 bg-accent" : "border-border hover:bg-accent",
          disabled && "cursor-not-allowed opacity-50",
          width,
          className,
        )}
      >
        {prefix && <span className="shrink-0 text-muted-foreground">{prefix}</span>}
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? "—"}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-state)]",
            open && "rotate-180",
          )}
        />
      </button>

      {layer.render && (
        <div
          ref={popRef}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
          tabIndex={-1}
          onKeyDown={onListKey}
          data-layer="menu"
          data-state={layer.state}
          className={cn(
            "skin-pop fixed z-[70] max-h-[min(60vh,20rem)] overflow-y-auto",
            "border border-border bg-raised p-1 outline-none",
            !at.ready && "invisible",
            layer.state === "closed" && "pointer-events-none",
          )}
          style={{
            top: at.top,
            left: at.left,
            minWidth: at.minWidth || undefined,
          }}
        >
          {options.map((o, i) => (
            <button
              key={o.id}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={o.id === value}
              data-idx={i}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn(
                "skin-ctl-inner flex w-full items-center gap-2 px-2 py-1 text-left text-caption transition-colors",
                i === active && "bg-accent",
                o.id === value && "text-foreground",
              )}
            >
              {/* Left gutter (Radix/shadcn): the tick occupies the same box
                  whether or not it is drawn, so labels never shift sideways
                  when the selection moves. */}
              <span aria-hidden className="flex w-3.5 shrink-0 items-center justify-center">
                {o.id === value && <Check className="h-3.5 w-3.5 text-primary" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.note && <span className="shrink-0 text-muted-foreground">{o.note}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
