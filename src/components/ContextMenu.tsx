import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { useI18n } from "../lib/useI18n";

/**
 * The application's first context menu.
 *
 * There was none before round 4, which is why the 项目墙 had exactly one verb:
 * click a card. 置顶 / 隐藏 / 删除 are all "act on this thing without opening
 * it", and a right-click is where a person looks for those first.
 *
 * ## Why it is written here rather than pulled in
 *
 * The repo's convention is that UI primitives come from shadcn as **source in the
 * tree**, not as a dependency (`lib/utils.ts`, the `skin-*` tokens). A menu is
 * markup and focus management, so it follows that rule; the drag interaction next
 * door is `@dnd-kit` because that owns behaviour this file could only re-implement
 * worse.
 *
 * ## The parts that are not obvious
 *
 *   - It flips itself at the viewport edges, so a card in the bottom-right corner
 *     does not open a menu that runs off screen and becomes unreachable.
 *   - Keyboard: ↑/↓ walk the enabled items, Home/End jump, Escape closes, and
 *     focus returns to whatever opened it. A menu you can only use with a mouse is
 *     a second-class control.
 *   - The pointer-down listener that closes it is registered in the capture phase
 *     and skips its own subtree, otherwise the click that opened the menu (or a
 *     click on its first item) would close it before it ever painted.
 */

export type MenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Renders the state rather than the action: a check box, not a verb. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Right-aligned secondary text, e.g. the shortcut or where it goes. */
  note?: string;
  separatorBefore?: boolean;
  onSelect: () => void;
};

export function ContextMenu({
  items,
  x,
  y,
  onClose,
  closing = false,
  label,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  /**
   * The owner keeps this mounted for one exit-duration and sets `closing`, which
   * is what plays the 消失 animation. It lives on the owner rather than inside
   * this component because a menu has two ways to go away — dismissed by the
   * surface (Escape, click outside) and dismissed by choosing an item, whose own
   * handler closes it — and only the owner sees both.
   */
  closing?: boolean;
  /** Announced to screen readers as what this surface is. */
  label?: string;
}) {
  const { t } = useI18n();
  const menuLabel = label ?? t("menu.label");
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(() => firstEnabled(items));
  const triggerRef = useRef<HTMLElement | null>(null);
  // 高亮项通过 aria-activedescendant 播报（容器保持焦点），行本身不可 Tab 进入。
  const uid = useId();
  const itemId = (id: string) => `${uid}-${id}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    const rect = el.getBoundingClientRect();
    // A keyboard-opened contextmenu (Shift+F10 / the Menu key) arrives with
    // clientX/Y = 0,0 in Chromium — anchoring there parks the menu on the
    // screen's top-left corner, far from the row it belongs to. Fall back to
    // the focused trigger's rect so the menu still appears beside its row.
    const kb = x <= 4 && y <= 4;
    const anchor = kb ? triggerRef.current?.getBoundingClientRect() : null;
    const ax = anchor ? anchor.left + 8 : x;
    const ay = anchor ? anchor.bottom - 4 : y;
    // Flip horizontally/vertically when the menu would leave the viewport. The
    // 8 px margin keeps the rounded corner off the screen edge.
    const nx = ax + rect.width > window.innerWidth - 8 ? Math.max(8, ax - rect.width) : ax;
    const ny = ay + rect.height > window.innerHeight - 8 ? Math.max(8, ay - rect.height) : ay;
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
    el.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    // 消失动画期间不再响应外部点击/按键，否则一层正在淡出的菜单会被重复关闭。
    if (closing) return;
    // Defined inside the effect: it is used only here, and its `onClose` capture
    // should follow this effect's deps rather than leak a second dependency.
    const onCloseWithFocus = () => {
      onClose();
      triggerRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseWithFocus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      const enabled = items.filter((i) => !i.disabled);
      if (!enabled.length) return;
      const at = enabled.findIndex((i) => i.id === active);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nx = enabled[(at + 1 + enabled.length) % enabled.length];
        if (nx) setActive(nx.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const pv = enabled[(at - 1 + enabled.length) % enabled.length];
        if (pv) setActive(pv.id);
      } else if (e.key === "Home") {
        e.preventDefault();
        const hi = enabled[0];
        if (hi) setActive(hi.id);
      } else if (e.key === "End") {
        e.preventDefault();
        const ei = enabled[enabled.length - 1];
        if (ei) setActive(ei.id);
      } else if (e.key === "Enter" || e.key === " ") {
        const item = items.find((i) => i.id === active);
        if (item && !item.disabled) {
          e.preventDefault();
          item.onSelect();
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [items, active, closing, onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menuLabel}
      aria-activedescendant={active ? itemId(active) : undefined}
      tabIndex={-1}
      data-layer="menu"
      data-state={closing ? "closed" : "open"}
      className={cn(
        "skin-pop fixed z-[70] min-w-[190px] overflow-hidden border border-border bg-raised p-1 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        closing && "pointer-events-none",
      )}
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <MenuRow
          key={item.id}
          item={item}
          id={itemId(item.id)}
          active={item.id === active}
          onHover={setActive}
        />
      ))}
    </div>
  );
}

function MenuRow({
  item,
  id,
  active,
  onHover,
}: {
  item: MenuItem;
  /** aria-activedescendant 指向的稳定 id（useId 前缀，避免同页多菜单撞名）。 */
  id: string;
  active: boolean;
  onHover: (id: string) => void;
}) {
  return (
    <>
      {item.separatorBefore && <div aria-hidden className="my-1 h-px bg-border-weak" />}
      <button
        type="button"
        id={id}
        // r15-a11y-6: `aria-checked` on a plain `menuitem` is ignored by AT —
        // 置顶（ProjectsView:1036 passes `checked`）was never announced as on or
        // off. Checkable rows are `menuitemcheckbox`, which is what the flag
        // means to the platform; rows nobody passes `checked` for keep the
        // plain role, and the visual Check icon is untouched.
        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        // 焦点归容器（aria-activedescendant 模式），行本身从 Tab 序列里拿掉，
        // 否则 Tab 会跳过高亮项落到第一个按钮上，两套「当前项」互相矛盾。
        tabIndex={-1}
        disabled={item.disabled}
        aria-checked={item.checked}
        onMouseEnter={() => !item.disabled && onHover(item.id)}
        onClick={item.onSelect}
        className={cn(
          "skin-ctl-inner flex w-full items-center gap-2 px-2 py-1.5 text-left text-body transition-colors",
          "disabled:pointer-events-none disabled:opacity-40",
          active ? "bg-accent" : "bg-transparent",
          item.danger ? "text-danger" : "text-foreground",
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          {item.checked ? (
            <Check className="h-3.5 w-3.5 text-primary" />
          ) : item.icon ? (
            item.icon
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.note && (
          <span className="shrink-0 text-caption text-muted-foreground">{item.note}</span>
        )}
      </button>
    </>
  );
}

function firstEnabled(items: MenuItem[]): string {
  return (items.find((i) => !i.disabled) ?? items[0])?.id ?? "";
}
