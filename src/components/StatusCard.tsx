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
  const toneClass = {
    default: "text-foreground",
    good: "text-success",
    warn: "text-warning",
    bad: "text-danger",
  }[tone];

  return (
    <div
      {...(regId ? reg(regId) : {})}
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? t("status.doubleClickHint") : undefined}
      className={cn(
        "rounded-lg border border-border-weak bg-card p-2.5 transition-colors",
        onDoubleClick && "cursor-pointer hover:border-primary/50 hover:bg-accent/40",
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
