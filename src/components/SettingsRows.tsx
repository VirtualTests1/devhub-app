import { useState } from "react";
import type { ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { cn } from "../lib/utils";
import { hasOwnActivation, rowOwnsKey } from "../lib/useDismiss";
import { useI18n } from "../lib/useI18n";
import { MenuSelect } from "./Controls";
import { reg, useCustomize } from "../store/customize";
import { useSelection } from "../customize/CustomizeLayer";

/**
 * The row-based settings layout.
 *
 * Shape, taken from the reference the user supplied: a group label sits
 * **outside** the panel, the panel holds one row per setting, and each row is
 * icon + title + description on the left with the control on the right, rows
 * separated by a dashed divider.
 *
 * Why a shared component rather than per-view markup: 外观, 设置 and 记录 all
 * present settings, and they had drifted into three different visual idioms
 * (button groups, bordered switch cards, and a chip row that read as a filter).
 * One row primitive means a new setting is one line wherever it lands.
 *
 * ## What round 3 changed, and why
 *
 *   - **The whole row is the target.** "调整的时候需要每次都点击按钮才能切换，
 *     能否点击那一块区域就能调整" — a row that owns a switch or a segmented
 *     choice now toggles/cycles when clicked anywhere except on a control that
 *     already handles the click itself. `handledInside` / `rowOwnsKey` (both in
 *     `lib/useDismiss`) are the single guards that keep a pointer **or a key**
 *     landing on an inner control from also firing the row.
 *   - **Every row can open its own settings entry.** `regId` puts the row in the
 *     element registry and shows a gear on hover; clicking it opens the
 *     inspector for that row, which is what "每个页面中应当都有对应功能的设置选项
 *     按钮" asked for without adding a page of indirection.
 *   - **Padding came down.** `px-3 py-3` on every row was the single biggest
 *     contributor to "页面元素内的空白略微有点多".
 */

/** True when the pointer landed on something that already handles its own click. */
const handledInside = hasOwnActivation;

/** A titled panel of rows. `footnote` renders under the panel, outside it. */
export function SettingsGroup({
  title,
  footnote,
  children,
  regId,
  sectionId,
}: {
  title?: string;
  footnote?: ReactNode;
  children: ReactNode;
  /** Registry id for the whole panel, so it can be hidden/reordered/sized. */
  regId?: string;
  /** Anchor name a deep link scrolls to, e.g. `network`. */
  sectionId?: string;
}) {
  return (
    <section
      {...(regId ? reg(regId) : {})}
      data-section={sectionId}
      className="mb-3.5 scroll-mt-3"
    >
      {title && (
        <h2 className="skin-label mb-1.5 flex items-center gap-1.5 px-0.5 text-caption font-medium text-muted-foreground">
          {/* 需求 10：分组标题与面板的关联用一根强调短线表达，标题不再是
              悬浮在面板上方的孤儿文字。 */}
          <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-primary/70" />
          {title}
        </h2>
      )}
      <div className="skin-panel overflow-hidden rounded-xl border border-border-weak bg-card shadow-[0_1px_2px_rgba(0,0,0,0.18),0_4px_14px_rgba(0,0,0,0.10)]">
        {children}
      </div>
      {footnote && (
        <p className="app-desc mt-1 px-0.5 text-caption leading-snug text-muted-foreground">
          {footnote}
        </p>
      )}
    </section>
  );
}

/**
 * One setting. Everything except `title` is optional: a row with no icon and no
 * hint still lines up with its neighbours because the slots reserve their box.
 *
 * `onRowClick` makes the entire row an activation target. It is deliberately not
 * applied when the row has no single obvious action (a text-only row, a row with
 * two buttons) — a row that does something unpredictable when clicked anywhere
 * is worse than one that requires a precise click.
 */
export function SettingRow({
  icon,
  title,
  hint,
  control,
  danger,
  regId,
  onRowClick,
  rowHint,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  /** Tints the row for destructive settings (删除、清空). */
  danger?: boolean;
  /** Registry id, so this row can be hidden and gets an inspector entry. */
  regId?: string;
  onRowClick?: () => void;
  /** Short text shown next to the title, e.g. the current value. */
  rowHint?: ReactNode;
}) {
  const devMode = useCustomize((s) => s.devMode);
  const select = useSelection((s) => s.select);
  // r21-N1b-2：这两个 devMode 齿轮提示原来是本文件里仅剩的两行未接线中文
  //（棘轮 -2 的来源），现在走词表——译文是 `settings.adjustBlock`。
  const { t } = useI18n();
  const clickable = !!onRowClick;

  return (
    <div
      {...(regId ? reg(regId) : {})}
      data-row-clickable={clickable || undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={(e) => {
        if (!onRowClick || handledInside(e.target)) return;
        onRowClick();
      }}
      onKeyDown={(e) => {
        if (!onRowClick) return;
        // r15-a11y-1: the click path has had `handledInside` since round 3, the
        // key path had nothing — while focus sat on the inner Switch or an
        // option button, one Enter fired the control *and* the row (flip+flip
        // on a switch = nothing happens; on ChoiceRow it picked the focused
        // option and then cycled to a second one). Same guard, both paths.
        if (!rowOwnsKey(e.target, e.key)) return;
        e.preventDefault();
        onRowClick();
      }}
      className={cn(
        "group/row relative flex items-start gap-2.5 px-2.5 py-2 transition-colors duration-[var(--motion-quick)]",
        "[&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak",
        clickable && "cursor-pointer select-none hover:bg-accent/50 active:bg-accent/70",
        danger && "bg-danger/[0.04]",
      )}
    >
      {/* The icon slot only takes space when there is an icon: a panel of rows
          that all omit it should not carry a column of empty grey boxes. */}
      {icon && (
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted",
            danger ? "text-danger" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="text-body leading-snug font-medium">{title}</span>
          {rowHint && (
            <span className="app-desc truncate text-caption text-muted-foreground">
              {rowHint}
            </span>
          )}
        </span>
        {hint && (
          <span className="app-desc mt-0 block text-caption leading-snug text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {control && <span className="shrink-0 self-center pt-0.5">{control}</span>}
      {regId && devMode && (
        <button
          type="button"
          data-no-row-click
          onClick={(e) => {
            e.stopPropagation();
            select(regId);
          }}
          title={t("settings.adjustBlock", { id: regId })}
          aria-label={t("settings.adjustBlock", { id: regId })}
          className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
        >
          <Settings2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Bare on/off control. The row supplies the label, unlike `Toggle`. */
export function Switch({
  checked,
  onChange,
  label,
  size = "md",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name; the visual label lives in the row. */
  label: string;
  size?: "sm" | "md";
}) {
  const small = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "skin-ctl flex shrink-0 items-center border p-0.5 transition-colors duration-[var(--motion-state)]",
        small ? "h-5 w-9" : "h-6 w-11",
        checked ? "border-primary bg-primary" : "border-border bg-transparent",
      )}
    >
      <span
        className={cn(
          "rounded-full t-state",
          small ? "h-3 w-3" : "h-4 w-4",
          checked
            ? small
              ? "translate-x-4 bg-primary-foreground"
              : "translate-x-5 bg-primary-foreground"
            : "translate-x-0 bg-muted-foreground",
        )}
      />
    </button>
  );
}

/** A row whose control is a switch. Clicking anywhere on the row flips it. */
export function SwitchRow({
  icon,
  title,
  hint,
  checked,
  onChange,
  regId,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  regId?: string;
}) {
  return (
    <SettingRow
      icon={icon}
      title={title}
      hint={hint}
      regId={regId}
      onRowClick={() => onChange(!checked)}
      control={
        <Switch
          checked={checked}
          onChange={onChange}
          label={title}
          size={regId ? "sm" : "md"}
        />
      }
    />
  );
}

export type Choice = { id: string; label: string; hint?: string };

/**
 * A row whose control is a small set of mutually exclusive options.
 *
 * Up to four options render as a segmented control on the right of the row —
 * fewer clicks and every option visible. More than that would wrap and fight
 * the row height, so it becomes the app's listbox menu in its field dress.
 *
 * Round 9: that fallback used to be a **native `<select>`**, which rendered as
 * a Windows dropdown inside an otherwise self-drawn interface (项目墙列数,
 * 默认排序, 界面字重, 默认终端 all hit it). It is now the same `MenuSelect`
 * the toolbars use, so one row's control no longer changes species with its
 * option count.
 *
 * Clicking the row itself cycles to the next option (segmented) or opens the
 * menu (long lists), which is the "点整块区域就能调整" behaviour: with
 * 小/标准/大/特大 you can tap the row until it lands.
 */
export function ChoiceRow({
  icon,
  title,
  hint,
  value,
  options,
  onChange,
  regId,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  value: string;
  options: Choice[];
  onChange: (id: string) => void;
  regId?: string;
}) {
  const segmented = options.length <= 4;
  const [open, setOpen] = useState(false);
  const cycle = () => {
    const i = options.findIndex((o) => o.id === value);
    const next = options[(i + 1) % options.length];
    if (next) onChange(next.id);
  };
  return (
    <SettingRow
      icon={icon}
      title={title}
      hint={hint}
      regId={regId}
      onRowClick={segmented ? cycle : () => setOpen(true)}
      control={
        segmented ? (
          <span className="flex gap-1">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange(o.id)}
                aria-pressed={value === o.id}
                className={cn(
                  "skin-ctl min-w-[2.5rem] border px-2 py-1 text-caption t-state",
                  value === o.id
                    ? "border-primary/60 bg-primary/15 font-medium text-foreground shadow-[0_0_0_1px_var(--color-primary)_inset]"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
                )}
              >
                {o.label}
              </button>
            ))}
          </span>
        ) : (
          <MenuSelect
            variant="field"
            align="end"
            value={value}
            options={options}
            onChange={onChange}
            ariaLabel={title}
            open={open}
            onOpenChange={setOpen}
          />
        )
      }
    />
  );
}

/** A row whose control is a text field (paths, proxy addresses, tokens). */
export function FieldRow({
  icon,
  title,
  hint,
  children,
  align = "center",
  regId,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** The field itself, which owns its own width. */
  children: ReactNode;
  /** Long fields take a full second line instead of squeezing the right slot. */
  align?: "center" | "stack";
  regId?: string;
}) {
  if (align === "stack") {
    return (
      <div
        {...(regId ? reg(regId) : {})}
        className="px-2.5 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak"
      >
        <div className="flex items-start gap-2.5">
          {icon && (
            <span
              aria-hidden
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-body leading-snug font-medium">{title}</div>
            {hint && (
              <div className="app-desc mt-0 text-caption leading-snug text-muted-foreground">
                {hint}
              </div>
            )}
          </div>
        </div>
        <div className="mt-1.5 pl-[2.375rem]">{children}</div>
      </div>
    );
  }
  return <SettingRow icon={icon} title={title} hint={hint} regId={regId} control={children} />;
}

/** A row whose only control is an action, e.g. 浏览… or 打开系统设置. */
export function ActionRow({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  secondary,
  danger,
  disabled,
  regId,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  actionLabel: string;
  onAction: () => void;
  secondary?: boolean;
  danger?: boolean;
  /** Greys the button out and drops the click, for actions with nothing to do. */
  disabled?: boolean;
  regId?: string;
}) {
  return (
    <SettingRow
      icon={icon}
      title={title}
      hint={hint}
      danger={danger}
      regId={regId}
      control={
        <button
          type="button"
          onClick={onAction}
          disabled={disabled}
          className={cn(
            "skin-ctl border px-3 py-1.5 text-caption t-state active:scale-[0.98]",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
            danger
              ? "border-danger/40 text-danger hover:bg-danger/10"
              : secondary
                ? "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                : "border-transparent bg-primary font-medium text-primary-foreground hover:brightness-95",
          )}
        >
          {actionLabel}
        </button>
      }
    />
  );
}
