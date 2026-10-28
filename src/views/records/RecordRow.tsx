import { memo } from "react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { useI18n } from "../../lib/useI18n";
import { ACTIVITY_TAG_LABEL, type ActivityEntry } from "../../types";
import { displayTarget, displayValue, formatTime } from "./format";

/**
 * One activity record row.
 *
 * Fixed-height slot design: rows share the same height rather than dropping
 * the line, because rows that grow and shrink as optional fields appear are
 * exactly the "移位" that was reported.
 *
 * `memo`, and the handlers take the entry instead of closing over one: a fresh
 * arrow per row would give every prop a new identity on every parent render and
 * make the `memo` decorative. Keep the call-site props primitive-or-stable when
 * adding to this list.
 */
export const RecordRow = memo(function RecordRow({
  entry: e,
  grouped,
  selecting,
  picked,
  onPick,
  onOpen,
  onDelete,
  deleting,
  onUndo,
  undoing,
  timeFormat,
}: {
  entry: ActivityEntry;
  grouped: boolean;
  selecting: boolean;
  picked: boolean;
  onPick: (entry: ActivityEntry) => void;
  onOpen: (slug: string) => void;
  onDelete: (entry: ActivityEntry) => void;
  deleting: boolean;
  onUndo?: (entry: ActivityEntry) => void;
  undoing: boolean;
  timeFormat: string;
}) {
  const openable = e.slug.length > 0;
  // r17-n1-1: the row's own copy and tooltips resolve through the dictionary. The
  // hook subscribes this memo'd row to the locale, so a language switch repaints it.
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 px-2.5 py-2 transition-colors hover:bg-accent/30",
        "[&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak",
        grouped && "pl-7",
        picked && "bg-primary/10",
      )}
    >
      {selecting ? (
        <button
          type="button"
          onClick={() => onPick(e)}
          aria-pressed={picked}
          aria-label={t("records.row.select")}
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
            picked ? "border-primary bg-primary text-primary-foreground" : "border-input",
          )}
        >
          {picked && <Check className="h-3 w-3" />}
        </button>
      ) : (
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {openable ? <FolderOpen className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-body leading-snug font-medium">{e.action}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
            {ACTIVITY_TAG_LABEL[e.tag] ?? e.tag}
          </span>
          {e.undoneTs ? (
            <span
              className="rounded bg-primary/15 px-1.5 py-0.5 text-caption text-primary"
              title={t("records.row.undoneTitle")}
            >
              {t("records.row.undone")}
            </span>
          ) : null}
          <span className="app-desc text-caption text-muted-foreground">
            {e.source || t("records.row.sourceUnknown")}
          </span>
        </div>

        {/* 前值 → 后值 */}
        {(e.before || e.after) && (
          <p
            className="app-desc mt-0 break-all text-caption leading-snug text-muted-foreground"
            title={e.target ? t("records.row.targetTitle", { target: displayTarget(e.target) }) : undefined}
          >
            <span className="text-muted-foreground/70">
              {e.before ? displayValue(e.target, e.before) : t("records.row.none")}
            </span>
            <ArrowRight aria-hidden className="mx-1 inline-block h-3 w-3 shrink-0 translate-y-0.5 text-primary" />
            <span className="text-foreground">
              {e.after ? displayValue(e.target, e.after) : t("records.row.none")}
            </span>
          </p>
        )}

        {e.detail && (
          <p className="app-desc mt-0 break-words text-caption leading-snug text-muted-foreground">
            {e.detail}
          </p>
        )}

        {/* The path and the project chip render only when they exist.

            Rows used to reserve a slot for every optional field, which was the
            wrong answer to the reported layout shift: entries in one group share
            a target and therefore a shape, so reserving bought nothing inside a
            group and cost two blank lines on every settings record. The shift
            that was actually observed happened at the *filter bar*, and that is
            fixed by the grid above. */}
        {e.path && (
          <p
            className="mt-0.5 truncate font-mono text-caption text-muted-foreground/80"
            title={e.path}
          >
            {e.path}
          </p>
        )}

        {openable && (
          <button
            type="button"
            onClick={() => onOpen(e.slug)}
            className="mt-1 flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:text-foreground"
            title={t("records.row.openPanelTitle", { slug: e.slug })}
          >
            <code className="min-w-0 truncate">{e.slug}</code>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <time className="text-caption tabular-nums text-muted-foreground">
          {formatTime(e.ts, timeFormat)}
        </time>
        <span className="flex items-center gap-0.5">
          {onUndo && (
            <button
              type="button"
              onClick={() => onUndo?.(e)}
              disabled={undoing}
              className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-40"
              title={t("records.row.undo")}
              aria-label={t("records.row.undo")}
            >
              {undoing ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(e)}
            disabled={deleting}
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
            title={t("records.row.delete")}
            aria-label={t("records.row.delete")}
          >
            {deleting ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        </span>
      </div>
    </div>
  );
});
