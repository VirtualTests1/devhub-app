import { cn } from "../../lib/utils";
import { type TFunc } from "../../lib/i18n";
import { useI18n } from "../../lib/useI18n";
import { useAppearance } from "../../store/appearance";
import type { SettingsView as Settings } from "../../types";
import { RETENTIONS } from "./constants";
import { retentionPhrase } from "./format";

/** Retention + schedule + display-time, inline in the records config panel. */
export function RetentionRows({
  settings,
  onRetention,
  onCleanup,
  onGoSettings,
  timeFormat,
}: {
  settings: Settings | null;
  onRetention: (days: number) => void;
  onCleanup: (patch: {
    cleanupMode?: Settings["cleanupMode"];
    cleanupKeepDays?: number;
  }) => void;
  onGoSettings: () => void;
  timeFormat: string;
}) {
  const setAppearance = useAppearance((s) => s.set);
  const mode = settings?.cleanupMode ?? "manual";
  // r17-n1-1: every row title, hint and chip value here renders through the dictionary.
  const { t } = useI18n();
  return (
    <div className="divide-dashed divide-border-weak">
      <MiniRow label={t("records.retention.title")} hint={t("records.retention.hint")}>
        <div className="flex gap-1">
          {RETENTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onRetention(d)}
              aria-pressed={(settings?.activityRetentionDays ?? 30) === d}
              className={cn(
                "skin-ctl border px-2 py-0.5 text-caption t-state",
                (settings?.activityRetentionDays ?? 30) === d
                  ? "border-primary/60 bg-primary/15 font-medium"
                  : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
              )}
            >
              {retentionPhrase(d, t)}
            </button>
          ))}
        </div>
      </MiniRow>

      <MiniRow label={t("records.cleanup.title")} hint={t("records.cleanup.hint")}>
        <div className="flex gap-1">
          {(["manual", "daily", "weekly", "monthly"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onCleanup({ cleanupMode: m })}
              aria-pressed={mode === m}
              className={cn(
                "skin-ctl border px-2 py-0.5 text-caption t-state",
                mode === m
                  ? "border-primary/60 bg-primary/15 font-medium"
                  : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
              )}
            >
              {cleanupLabel(t, m)}
            </button>
          ))}
        </div>
      </MiniRow>

      {mode !== "manual" ? (
        <MiniRow label={t("records.keep.title")} hint={t("records.keep.hint")}>
          <div className="flex gap-1">
            {RETENTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onCleanup({ cleanupKeepDays: d })}
                aria-pressed={(settings?.cleanupKeepDays ?? 30) === d}
                className={cn(
                  "skin-ctl border px-2 py-0.5 text-caption t-state",
                  (settings?.cleanupKeepDays ?? 30) === d
                    ? "border-primary/60 bg-primary/15 font-medium"
                    : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
                )}
              >
                {retentionPhrase(d, t)}
              </button>
            ))}
          </div>
        </MiniRow>
      ) : (
        /* It used to disappear entirely in 手动, which reads as "the setting is
           broken" to anyone who came here to change it. Saying why it is not
           editable costs one line and answers the question. */
        <MiniRow label={t("records.keep.title")} hint={t("records.keep.disabledHint")}>
          <span className="rounded-full border border-border px-2 py-0.5 text-caption text-muted-foreground/70">
            {t("records.keep.notApplicable")}
          </span>
        </MiniRow>
      )}

      <MiniRow label={t("records.time.title")} hint={t("records.time.hint")}>
        <div className="flex gap-1">
          {(["hms", "hm", "relative", "full"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setAppearance("recordTimeFormat", f)}
              aria-pressed={timeFormat === f}
              className={cn(
                "skin-ctl border px-2 py-0.5 text-caption t-state",
                timeFormat === f
                  ? "border-primary/60 bg-primary/15 font-medium"
                  : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
              )}
            >
              {timeFormatLabel(t, f)}
            </button>
          ))}
        </div>
      </MiniRow>

      <div className="px-2.5 py-1.5">
        <button
          type="button"
          onClick={onGoSettings}
          className="app-desc text-caption text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          {t("records.goSettings")}
        </button>
      </div>
    </div>
  );
}

/**
 * Clean-up frequency label. A switch so each key stays a `t("…")` literal.
 */
function cleanupLabel(t: TFunc, mode: "manual" | "daily" | "weekly" | "monthly"): string {
  switch (mode) {
    case "daily":
      return t("records.cleanup.daily");
    case "weekly":
      return t("records.cleanup.weekly");
    case "monthly":
      return t("records.cleanup.monthly");
    default:
      return t("records.cleanup.manual");
  }
}

/** Displayed-time label. A switch so each key stays a `t("…")` literal. */
function timeFormatLabel(t: TFunc, fmt: "hms" | "hm" | "relative" | "full"): string {
  switch (fmt) {
    case "hm":
      return t("records.timeFormat.hm");
    case "relative":
      return t("records.timeFormat.relative");
    case "full":
      return t("records.timeFormat.full");
    default:
      return t("records.timeFormat.hms");
  }
}

function MiniRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-border-weak px-2.5 py-1.5 last:border-b-0">
      <span className="w-20 shrink-0 text-caption font-medium">{label}</span>
      <span className="app-desc min-w-0 flex-1 text-caption text-muted-foreground">{hint}</span>
      {children}
    </div>
  );
}
