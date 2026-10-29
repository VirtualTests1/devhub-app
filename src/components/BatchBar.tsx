import { useRef, useState } from "react";
import { Check, LoaderCircle, SquareCheckBig, X } from "lucide-react";
import { cn } from "../lib/utils";
import { mapBounded } from "../lib/bounded-map";
import { useLayerExit } from "../lib/motion";
import { messageOf } from "../lib/report-error";
import { t } from "../lib/i18n";
import { toast } from "./Toast";

/**
 * The floating 多选 bar over the 项目墙 (需求 9.1).
 *
 * ## Why a bar and not a menu
 *
 * The tile menu (`ProjectsView.buildMenu`) is built per card, so "apply this to
 * these nine cards" has no home in it. The bar is the only surface that can say
 * *how many* are chosen while the choice is being made, and it stays out of the
 * way of the three interactions the tiles already own: click opens the launch
 * panel, right-click opens the menu, dragging reorders.
 *
 * ## What it owns and what it is handed
 *
 * The batch verbs live in the view, because they need the live process list and
 * the wall-reload callback. What lives here is the part that is easy to get
 * wrong in a caller: run the per-repository command over every selection, keep
 * going when one fails, and report **which** repositories failed with the backend's
 * own words. A batch that swallows a rejection is worse than no batch at all, so
 * every item answers `{ ok, detail }` and the list renders one row per selected
 * repository — a batch of nine that says "完成" is a lie if two of them failed.
 *
 * One verb changes the fan-out rule: 批量更新 spawns a `git pull` per repository,
 * so it caps its own width through `mapBounded` instead of starting one process
 * per selected card. The cap is the action's decision, not this component's,
 * because only the verb knows whether it touches the network.
 */

/** One selected repository's answer, kept in selection order. */
export type BatchOutcome = {
  slug: string;
  name: string;
  ok: boolean;
  detail: string | null;
  /** The user stopped the batch before this item was started (r31-O3). */
  skipped?: boolean;
};

/**
 * What one repository's step reports. `detail` is printed either way — on success
 * it is what actually happened ("释放 12.3 MB · 3 项"), on failure the reason.
 */
export type BatchItemResult = { ok: boolean; detail?: string | null };

export type BatchAction = {
  id: string;
  label: string;
  icon: React.ReactNode;
  /**
   * How much work this action has for one repository (process count, cache item
   * count…). An action with nothing to do across the whole selection is disabled
   * rather than reporting "已停止 0 个进程".
   */
  appliesTo?: (slug: string) => number;
  /**
   * One confirmation for the entire batch. `names` are the display names about to
   * be touched, in selection order; returning false aborts without a single call.
   */
  confirm?: (names: string[]) => Promise<boolean>;
  /** Per repository: what happened, and whether it counts as a failure. */
  run: (slug: string) => Promise<BatchItemResult>;
  /** Rendered in the danger colour — for verbs that touch the disk. */
  danger?: boolean;
  /**
   * How many repositories this verb may be running at once. Default: all of
   * them, which is right for the three local verbs (`stop_process`, `clear_cache`,
   * `trash_repo` — short calls the backend serialises itself) and wrong for
   * anything that reaches the network: one 更新 is a `git pull` subprocess, so an
   * uncapped 全选 on a 40-card wall would be 40 simultaneous git processes against
   * one remote. `批量更新` therefore names a width; see `lib/bounded-map.ts`.
   */
  concurrency?: number;
};

/**
 * Aggregation of a finished batch.
 *
 * Pure and exported on its own because the three numbers it produces are the whole
 * user-visible claim ("12 成功、2 失败"), and a claim computed inline at a JSX call
 * site is a claim nobody can check.
 */
export function summarize(outcomes: BatchOutcome[]): {
  total: number;
  ok: number;
  failed: BatchOutcome[];
  skipped: BatchOutcome[];
} {
  // "Not run" is not "failed": the user stopped the batch, and counting those
  // rows as errors would make a deliberate stop look like a broken network.
  const failed = outcomes.filter((o) => !o.ok && !o.skipped);
  const skipped = outcomes.filter((o) => o.skipped);
  return { total: outcomes.length, ok: outcomes.length - failed.length - skipped.length, failed, skipped };
}

export function BatchBar({
  active,
  items,
  actions,
  onExit,
  onSelectAll,
  onClear,
  onAfterRun,
  onSettled,
  onRunningChange,
}: {
  active: boolean;
  /** The selection, in the order the cards were chosen, each with the name the wall shows. */
  items: { slug: string; name: string }[];
  actions: BatchAction[];
  onExit: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** Lets the view drop repositories the action just removed. */
  onAfterRun: (actionId: string, okSlugs: string[]) => void;
  /** The whole batch is done: how many succeeded, for a one-shot attention cue. */
  onSettled?: (actionId: string, ok: number, total: number, skipped: number) => void;
  /**
   * The running verb's label, or null when the bar goes idle. The view needs this
   * because a live 批量更新 holds a repository's own directory, and the card menu
   * must therefore disable 更新/删除 on exactly those cards *and say so* — the same
   * rule the disabled buttons below follow. Kept as a callback rather than lifted
   * state: `runningId` is this component's, and the view only asks "is anything
   * running, and what is it called".
   */
  onRunningChange?: (label: string | null) => void;
}) {
  const [outcomes, setOutcomes] = useState<BatchOutcome[] | null>(null);
  // Whether the last batch's list is on screen. Kept apart from the data itself:
  // 收起 must still be able to render the rows during its exit frames, which
  // clearing `outcomes` on the click would take away on the very next paint.
  const [showResults, setShowResults] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Set by 停止后续; checked before each new item, never mid-item. */
  const cancelRef = useRef(false);
  // Two layers, one exit each: leaving 多选 and dismissing the result list are
  // different moments, and neither should blink out mid-animation for the other.
  const layer = useLayerExit(active);
  const resultsLayer = useLayerExit(showResults);

  if (!layer.render && !resultsLayer.render) return null;

  const runAction = async (action: BatchAction) => {
    if (runningId) return;
    if (!items.length) return;
    if (action.confirm && !(await action.confirm(items.map((i) => i.name)))) return;
    setRunningId(action.id);
    setCancelling(false);
    cancelRef.current = false;
    onRunningChange?.(action.label);
    let settled: BatchOutcome[];
    try {
      // Bounded, not `Promise.all`: an action that says how wide it may run gets
      // that width, and one that does not keeps the old fan-out. Result order is
      // selection order either way, which is what the list below depends on to
      // name the right repository. `cancelRef` only stops items that have not
      // started; an in-flight git pull is allowed to finish.
      const raw = await mapBounded(
        items,
        action.concurrency ?? items.length,
        async (item): Promise<BatchOutcome> => {
          try {
            const res = await action.run(item.slug);
            return { slug: item.slug, name: item.name, ok: res.ok, detail: res.detail ?? null };
          } catch (err) {
            // A command that throws is a failure like any other: its message is the
            // reason, and it must appear in the list instead of in a toast nobody
            // read. `messageOf` keeps a local TypeError from printing as raw prose.
            return { slug: item.slug, name: item.name, ok: false, detail: messageOf(err) };
          }
        },
        { shouldStop: () => cancelRef.current },
      );
      settled = items.map((item, i) => {
        const row = raw[i];
        return (
          row ?? {
            slug: item.slug,
            name: item.name,
            ok: false,
            skipped: true,
            detail: t("batch.skippedDetail"),
          }
        );
      });
    } finally {
      setRunningId(null);
      setCancelling(false);
      onRunningChange?.(null);
    }
    setOutcomes(settled);
    setShowResults(true);
    onAfterRun(
      action.id,
      settled.filter((o) => o.ok).map((o) => o.slug),
    );
    const sum = summarize(settled);
    onSettled?.(action.id, sum.ok, sum.total, sum.skipped.length);
    const text = t("batch.rowOk", { action: action.label, ok: sum.ok, total: sum.total });
    if (sum.failed.length) toast.error(t("batch.rowFailTail", { text, n: sum.failed.length }));
    else if (sum.skipped.length) toast.info(t("batch.rowSkippedTail", { text, n: sum.skipped.length }));
    else toast.success(text);
  };

  const sum = outcomes ? summarize(outcomes) : null;

  return (
    <div className="pointer-events-none fixed bottom-14 left-1/2 z-[var(--z-layer)] flex w-[min(46rem,calc(100vw-3rem))] -translate-x-1/2 flex-col items-stretch gap-2">
      {resultsLayer.render && outcomes && sum && (
        <div
          data-layer="panel"
          data-state={resultsLayer.state}
          className="elevation-panel-up pointer-events-auto rounded-xl border border-border bg-raised p-2"
        >
          <div className="mb-1 flex items-center gap-2 px-1">
            <span className="text-caption font-medium">
              {t("batch.lastResults", { ok: sum.ok, total: sum.total })}
            </span>
            {sum.failed.length > 0 && (
              <span className="text-caption text-danger">{t("batch.failedCount", { n: sum.failed.length })}</span>
            )}
            {sum.skipped.length > 0 && (
              <span className="text-caption text-muted-foreground">
                {t("batch.skippedCount", { n: sum.skipped.length })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowResults(false)}
              aria-label={t("batch.collapseAria")}
              className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="max-h-[28vh] space-y-0.5 overflow-y-auto" role="log" aria-live="polite">
            {outcomes.map((o) => (
              <li key={o.slug} className="flex items-start gap-2 px-1 text-caption">
                {o.skipped ? (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                ) : o.ok ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                ) : (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-danger" />
                )}
                <span className="min-w-0 flex-1">
                  <span className={cn("truncate font-medium", !o.ok && !o.skipped && "text-danger", o.skipped && "text-muted-foreground")}>
                    {o.name}
                  </span>
                  {o.detail && (
                    <span className="app-desc block break-words text-muted-foreground">{o.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {layer.render && (
        <div
          data-layer="menu"
          data-state={layer.state}
          className="elevation-panel-up pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-border bg-raised px-2.5 py-2"
        >
          <span className="flex shrink-0 items-center gap-1.5 text-caption">
            <SquareCheckBig className="h-3.5 w-3.5 text-primary" />
            <span className="tabular-nums">{t("batch.selected", { n: items.length })}</span>
          </span>

          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

          {actions.map((action) => {
            const appliesTo = action.appliesTo;
            const relevant = appliesTo
              ? items.filter((i) => appliesTo(i.slug) > 0).length
              : items.length;
            const busy = runningId === action.id;
            // A disabled control suppresses pointer events (so its `title` never
            // shows) and drops out of the tab order, so the "why" has to be on the
            // face of the button as visible text — the same reason the 项目页 下载
            // gate prints `disabledReason` instead of tooltiping it.
            const disabled = busy || !!runningId || items.length === 0 || relevant === 0;
            const visibleReason =
              items.length === 0
                ? t("batch.pickFirst")
                : relevant === 0
                  ? t("batch.nothingFor", { action: action.label })
                  : null;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => void runAction(action)}
                disabled={disabled}
                aria-label={t("batch.runAria", { action: action.label, n: items.length })}
                className={cn(
                  "skin-ctl flex items-center gap-1.5 border px-2.5 py-1 text-caption transition-colors",
                  action.danger
                    ? "border-danger/40 text-danger hover:bg-danger/10"
                    : "border-border-weak text-muted-foreground hover:bg-accent hover:text-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : action.icon}
                {busy ? t("batch.running") : action.label}
                {!busy && disabled && visibleReason && (
                  <span className="text-muted-foreground">· {visibleReason}</span>
                )}
              </button>
            );
          })}

          {runningId && (
            <button
              type="button"
              onClick={() => {
                cancelRef.current = true;
                setCancelling(true);
              }}
              disabled={cancelling}
              aria-label={t("batch.stopQueuedAria")}
              className="skin-ctl flex items-center gap-1.5 border border-warning/40 px-2.5 py-1 text-caption text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
            >
              {cancelling ? t("batch.stoppingQueued") : t("batch.stopQueued")}
            </button>
          )}

          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

          <button
            type="button"
            onClick={onSelectAll}
            aria-label={t("batch.selectAllAria")}
            className="skin-ctl border border-border-weak px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("batch.selectAll")}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!items.length}
            aria-label={t("batch.clearAria")}
            className="skin-ctl border border-border-weak px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {t("batch.clear")}
          </button>

          <button
            type="button"
            onClick={onExit}
            aria-label={t("batch.exitAria")}
            className="skin-ctl ml-auto flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption transition-colors hover:bg-accent active:scale-[0.98]"
          >
            <X className="h-3.5 w-3.5" />
            {t("batch.exit")}
          </button>
        </div>
      )}
    </div>
  );
}
