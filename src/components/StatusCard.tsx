import { cn } from "../lib/utils";
import { reg } from "../store/customize";
import { useI18n } from "../lib/useI18n";

/**
 * Small labelled panel used inside the environment popover.
 *
 * Extracted from the old single-file App.tsx with only the type scale changed
 * (`text-[11px]` → `text-caption`), so the information shown is identical.
 *
 * Round 3 added two things:
 *
 *   - `onDoubleClick` — the cards are the only place these five facts are
 *     explained, so they should be the way you get to the setting that changes
 *     them.
 *   - `tip` — a hover line that must **not** repeat the value. The old card set
 *     `title={value}` on the value element, so hovering showed the same string
 *     that was already on screen. `tip` is for the thing that is *not* shown:
 *     the full path when the displayed one is truncated, the reason a value is
 *     what it is, how long the probe took.
 */
export function StatusCard({
  icon,
  title,
  value,
  tone = "default",
  hint,
  tip,
  onDoubleClick,
  regId,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  tone?: "default" | "good" | "warn" | "bad";
  hint?: string;
  tip?: string;
  onDoubleClick?: () => void;
  regId?: string;
}) {
  const { t } = useI18n();
  const interactive = typeof onDoubleClick === "function";
  const toneClass = {
    default: "text-foreground",
    good: "text-success",
    warn: "text-warning",
    bad: "text-danger",
  }[tone];

  return (
    <div
      {...(regId ? reg(regId) : {})}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onDoubleClick={onDoubleClick}
      onKeyDown={
        interactive
          ? (e) => {
              // Enter/Space are the two keys every role="button" must accept;
              // double-click alone made the promised jump unreachable by keyboard.
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onDoubleClick();
            }
          : undefined
      }
      aria-keyshortcuts={interactive ? "Enter Space" : undefined}
      title={interactive ? t("status.doubleClickHint") : undefined}
      className={cn(
        "rounded-lg border border-border-weak bg-card p-2.5 transition-colors",
        interactive &&
          "cursor-pointer hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div className="skin-label flex items-center gap-2 text-caption text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <div className={cn("mt-1 truncate text-body font-medium", toneClass)} title={tip}>
        {value}
      </div>
      {hint && (
        <div className="app-desc mt-1 text-caption leading-snug text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}
