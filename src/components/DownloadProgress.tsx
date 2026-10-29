import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronRight,
  CircleCheck,
  FolderOpen,
  LoaderCircle,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { reportError } from "../lib/report-error";
import { copyLogWithToast } from "../lib/clipboard";
import { useAppearance } from "../store/appearance";
import { reg } from "../store/customize";
import { LAYER_LABEL, type DownloadOutcome, type ProgressEvent } from "../types";
import { formatBytes } from "../lib/format";
import {
  estimateEta,
  formatEta,
  parseGitProgress,
  pushRateSample,
  type RateSample,
} from "../lib/download-rate";
import { useI18n } from "../lib/useI18n";
import type { TFunc } from "../lib/i18n";
import { browserScheduler } from "../lib/ref-ticker";
import { browserVisibility, createVisibilityInterval } from "../lib/visibility";
import { failureHintForKey, failureInfoOf, failureLabelForKey } from "../lib/download-diagnostics";

/**
 * Download progress, shown instead of a wall of terminal output.
 *
 * Reported problems and what changed:
 *
 *   "下载过程行数过多" — git's in-place progress rewrites are tagged
 *   `<stage>-progress` by the backend and update the bar instead of the log.
 *
 *   "下载完成之后没有显示完成" — finishing now swaps the whole block to an
 *   explicit success banner with the landing path and a button that opens the
 *   folder in Explorer, so completion is impossible to miss.
 *
 *   "详细日志不详细" — the backend now emits parse/network events as regular
 *   log lines too; the collapsed log shows every stage, attempt and retry.
 *
 * ## Round 3's complaint: "没有动效，无法准确区分是否执行中"
 *
 * A progress UI that cannot be told apart from a stuck one is the worst version
 * of itself, so every state now has its own visual treatment *and* its own words,
 * because colour alone is not information:
 *
 *   stage not reached   muted chip + hollow dot
 *   stage in progress   primary chip + solid dot wrapped in an expanding ring
 *   stage done          emerald chip + check, and the connector fills to 100%
 *   indeterminate bar   a band sweeping the track, readout 进度未知
 *   determinate bar     width transition, readout N%
 *   stalled             bar frozen, amber, slow opacity pulse, 已 N 秒无更新
 *
 * Motion is CSS, not JS: `src/index.css` already zeroes durations under
 * `[data-motion="reduced"]`, so anything animated here is animated by the
 * stylesheet and the switch turns it off for free. Where an animation would leave
 * nothing visible when stopped (a sweep that lives off-track at 0%), the element's
 * *base* style is the resting state, so reduced motion shows a calm bar rather than
 * an empty one.
 *
 * The staleness clock is the one thing that cannot be CSS — it is data. A 1 s
 * interval runs only while a download is busy, and `progress` (a fresh object per
 * event from the queue store) is what resets it.
 */

/**
 * Copies the whole log, not the visible slice. Shared with the queue's
 * 复制日志 menu entry — see src/lib/clipboard.ts.
 */
async function copyLog(log: string[], message: string) {
  await copyLogWithToast(log, message);
}

const PHASES: { id: string; stages: string[] }[] = [
  { id: "parse", stages: [] },
  { id: "network", stages: ["check", "resolve", "proxy", "debug"] },
  { id: "clone", stages: ["clone", "download", "bundle", "git-bootstrap"] },
  { id: "done", stages: [] },
];

/**
 * Literal call sites, not a computed key: `tests/i18n.test.ts` proves every
 * registered key has a reader by scanning for `t("…")` literals. A family built
 * with a template string would be invisible to that guard unless the test grew a
 * third exception, so the four phases spell their keys out here instead.
 */
function phaseLabel(t: TFunc, id: string): string {
  switch (id) {
    case "parse":
      return t("dl.phaseParse");
    case "network":
      return t("dl.phaseNetwork");
    case "clone":
      return t("dl.phaseClone");
    default:
      return t("dl.phaseDone");
  }
}

/**
 * How long without a progress event counts as stalled. A healthy clone rewrites
 * its progress line several times a second, so five seconds of silence is not a
 * slow link — it is git thinking, a proxy buffering, or a dead connection that the
 * backend has not given up on yet.
 */
const STALL_AFTER_MS = 5000;

function currentPhase(busy: boolean, stages: string[], failed: boolean): number {
  // The phase whose stages were last reached - where a failed run died, and
  // where a running one is.
  let reached = 0;
  PHASES.forEach((p, i) => {
    if (p.stages.some((s) => stages.includes(s))) reached = Math.max(reached, i);
  });
  if (!busy) {
    if (!failed) return stages.length === 0 ? 0 : PHASES.length - 1;
    // 需求 6: "明明是下载失败，但是过程中的下载代码显示是绿色和对勾".
    // This used to return the last index on failure, which lit every chip
    // before it as done - including 下载代码 on a clone that never finished.
    // A failed run now marks the phase it died in and mutes the rest.
    return reached;
  }
  // Never show "完成" while work is still running: it is reached only by finishing.
  return Math.min(reached, PHASES.length - 2);
}

// The `dlSweep` / `dlStall` keyframes and the `.dl-sweep` / `.dl-stall` rules now
// live in `src/index.css` (round-11 D6), bound to the `--motion-*` ladder so the
// in-app 减弱动画 switch and the OS `prefers-reduced-motion` block both stop them
// from one place. This panel only adds the class names.

export function DownloadProgress({
  busy,
  progress,
  progressAt,
  stages,
  log,
  outcome,
  failure,
}: {
  busy: boolean;
  progress: ProgressEvent | null;
  /** Store-side arrival time of `progress`; absent on old task shapes. */
  progressAt?: number;
  stages: string[];
  log: string[];
  outcome: DownloadOutcome | null;
  failure: string | null;
}) {
  const { t } = useI18n();
  const success = !!outcome && !failure;
  const phase = success ? PHASES.length - 1 : currentPhase(busy, stages, !!failure);
  const parsedProgress = parseGitProgress(progress?.message);
  const percent = parsedProgress.percent;
  const phaseDef = PHASES[phase];

  // --- staleness ----------------------------------------------------------
  const lastEventAt = useRef(Date.now());
  const [silentMs, setSilentMs] = useState(0);

  // Any new event — or the transition into busy — restarts the silence count.
  useEffect(() => {
    lastEventAt.current = Date.now();
    setSilentMs(0);
  }, [progress, busy]);

  useEffect(() => {
    if (!busy) return;
    // A hidden window does not need a "seconds without output" number; the clone
    // continues in the backend and the elapsed clock is recomputed on return.
    const clock = createVisibilityInterval(
      () => setSilentMs(Date.now() - lastEventAt.current),
      1000,
      browserScheduler,
      browserVisibility,
      { fireOnResume: true },
    );
    clock.start();
    return () => clock.stop();
  }, [busy]);

  const stalled = busy && silentMs >= STALL_AFTER_MS;
  const silentSec = Math.max(0, Math.round(silentMs / 1000));

  // Speed comes from git's own `3.40 MiB/s`; the ETA is the percentage slope over
  // the samples of this running download. Both reset when the run ends — a stale
  // "12 MB/s" next to a finished bar would be a number about the past.
  const samplesRef = useRef<RateSample[]>([]);
  const [rate, setRate] = useState<{ bytesPerSec: number | null; etaMs: number | null }>({
    bytesPerSec: null,
    etaMs: null,
  });
  useEffect(() => {
    if (!busy) {
      samplesRef.current = [];
      setRate({ bytesPerSec: null, etaMs: null });
      return;
    }
    const parsed = parseGitProgress(progress?.message);
    const samples = pushRateSample(samplesRef.current, parsed.percent, progressAt ?? Date.now());
    samplesRef.current = samples;
    setRate({ bytesPerSec: parsed.bytesPerSec, etaMs: estimateEta(samples) });
  }, [progress, progressAt, busy]);

  // --- log disclosure -----------------------------------------------------
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  /**
   * Two switches, deliberately. `autoScrollOutput` is the app-wide preference
   * (the same one 启动输出 uses, set in 外观); `stick` is this stream's own state
   * and the part the user controls by scrolling: once they drag the log upward,
   * auto-scroll has to let go, or reading history during a download is impossible.
   */
  const autoScrollPref = useAppearance((s) => s.autoScrollOutput);
  const [stick, setStick] = useState(true);
  const autoScrolling = autoScrollPref && stick;

  useEffect(() => {
    if (!autoScrolling || !logOpen) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, autoScrolling, logOpen]);

  // A failure opens the log by itself: the one moment a collapsed 详细日志 is
  // certainly wanted is the moment something went wrong, and making the user
  // hunt for the chevron then is how the report got written in the first place.
  useEffect(() => {
    if (failure) setLogOpen(true);
  }, [failure]);

  const jumpToBottom = () => {
    setStick(true);
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <section className="mt-4 skin-panel border border-border-weak bg-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="skin-title skin-label text-body">{t("dl.title")}</h2>
        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* phase indicator: which stage, and whether it is *this* one running */}
      <ol {...reg("download-phase-indicator")} className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        {PHASES.map((p, i) => {
          // Four mutually exclusive states, because the complaint was precisely
          // that "还没走到" and "正在走" looked identical. `success` lights every
          // chip: finishing means all four happened, and a completed run must not
          // leave one chip still shaped like a question mark.
          const done = i < phase || success;
          const current = !done && i === phase && (busy || !!failure);
          const running = current && busy;
          return (
            <li key={p.id} className="flex items-center gap-2">
              <span
                aria-current={running ? "step" : undefined}
                className={cn(
                  // Same padding, border weight and line box in all four states, so
                  // a chip changing state cannot resize and rewrap the row halfway
                  // through a download.
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption",
                  "transition-colors duration-[var(--motion-medium)] ease-out",
                  done && "border-success/30 bg-success/10 text-success",
                  running && "border-primary/60 bg-primary/15 text-foreground",
                  current && !running && "border-danger/40 bg-danger/10 text-danger",
                  !done && !current && "border-transparent bg-muted text-muted-foreground",
                )}
              >
                {running ? (
                  // The outer ring expands and fades (ping) around a solid dot that
                  // never moves: "in progress" survives even when the ring is frozen
                  // by 减弱动画.
                  <span className="relative flex h-2 w-2 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/70" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                ) : done ? (
                  <Check className="h-2.5 w-2.5" />
                ) : current ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                )}
                {phaseLabel(t, p.id)}
              </span>
              {/* The connector fills as the pipeline moves, so progress reads as
                  movement along the line rather than only as a colour change. It
                  follows `done` and transitions its width, so a stage that just
                  completed visibly *pushes* into the next chip. */}
              {i < PHASES.length - 1 && (
                <span className="relative h-px w-5 overflow-hidden bg-border">
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 bg-primary transition-[width] duration-[var(--motion-slow)] ease-out",
                      done ? "w-full" : "w-0",
                    )}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {busy && (
        <p className="app-desc mt-1.5 text-caption text-muted-foreground">
          {t("dl.currentPhase", {
            phase: phaseDef ? phaseLabel(t, phaseDef.id) : t("dl.phasePreparing"),
            index: phase + 1,
            total: PHASES.length,
          })}
        </p>
      )}

      {/* success banner: the explicit "done" the report asked for.
          role=status so the completion is announced, not just seen. */}
      {outcome && !failure && (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3">
          <CircleCheck className="h-4 w-4 shrink-0 text-success" />
          <span className="text-body font-medium text-success">{t("dl.doneTitle")}</span>
          <span className="app-desc min-w-0 flex-1 truncate text-caption text-muted-foreground" title={outcome.path}>
            {t("dl.landed")} <code className="rounded bg-muted px-1">{outcome.path}</code>
          </span>
          <button
            type="button"
            onClick={() =>
              // A completed download whose folder will not open is the action
              // failing, not a detail: the button has to say so.
              void invoke("open_in_explorer", { path: outcome.path }).catch((e) =>
                reportError(e, t("dl.openDirFail")),
              )
            }
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-success/40 px-2.5 py-1 text-caption text-success transition-colors hover:bg-success/10"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("dl.openDir")}
          </button>
        </div>
      )}

      {/* progress bar: a real number when git printed one, a sweep when it has not
          said yet, and a stalled treatment when it stopped saying. Never a made-up
          percentage. */}
      {busy && (
        <div className="mt-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent != null ? { "aria-valuenow": percent } : {})}
            className={cn(
              "h-1.5 w-full overflow-hidden rounded-full transition-colors duration-[var(--motion-medium)]",
              stalled ? "bg-warning/15" : "bg-muted",
            )}
          >
            {percent != null ? (
              <div
                style={{ width: `${percent}%` }}
                className={cn(
                  "h-full rounded-full transition-[width] duration-[var(--motion-medium)] ease-out",
                  stalled ? "dl-stall bg-warning/80" : "bg-primary",
                )}
              />
            ) : stalled ? (
              <div className="dl-stall h-full w-full rounded-full bg-warning/50" />
            ) : (
              <div className="dl-sweep h-full w-full rounded-full" />
            )}
          </div>

          <div className="mt-1.5 flex items-baseline gap-2">
            <span
              className="min-w-0 flex-1 truncate text-caption text-muted-foreground"
              title={progress?.message}
            >
              {progress?.message ?? t("dl.preparing")}
            </span>
            {/* The words decide what the bar cannot: a stopped bar is either
                "stalled" or "we never had a number", and that difference is data,
                not colour. */}
            {stalled ? (
              <span className="shrink-0 text-caption tabular-nums text-warning">
                {t("dl.silentSeconds", { n: silentSec })}
              </span>
            ) : percent != null ? (
              <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                {percent}%
              </span>
            ) : (
              <span className="shrink-0 text-caption text-muted-foreground">{t("dl.unknownProgress")}</span>
            )}
          </div>

          {/* Facts, labelled and separate from the bar: a speed git printed, and
              an ETA derived from at least two percentages. Hidden while stalled —
              the stall word is the truthful status then. */}
          {!stalled && (rate.bytesPerSec != null || rate.etaMs != null) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption tabular-nums text-muted-foreground">
              {rate.bytesPerSec != null && (
                <span>{t("dl.rate", { speed: `${formatBytes(rate.bytesPerSec)}/s` })}</span>
              )}
              {rate.etaMs != null && <span>{t("dl.eta", { eta: formatEta(rate.etaMs) })}</span>}
            </div>
          )}
        </div>
      )}

      {outcome && <OutcomeBlock outcome={outcome} />}

      {failure && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <div className="flex items-center gap-2 text-caption font-medium text-danger">
            <ShieldOff className="h-3.5 w-3.5" />
            {t("dl.failed")}
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-all text-caption leading-relaxed text-muted-foreground">
            {failure}
          </pre>
          {(() => {
            const info = failureInfoOf(failure, log);
            return (
              <p className="mt-2 border-t border-danger/20 pt-2 text-caption leading-relaxed text-muted-foreground">
                {t("dl.failureHint", {
                  kind: failureLabelForKey(info.kind),
                  hint: failureHintForKey(info.kind),
                })}
              </p>
            );
          })()}
        </div>
      )}

      {log.length > 0 && (
        <div {...reg("download-log")} className="mt-3">
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-caption
                       text-muted-foreground transition-colors duration-[var(--motion-state)]
                       hover:bg-accent/60 hover:text-foreground"
          >
            {/* A real disclosure affordance: the chevron rotates with the state
                instead of the label swapping between 展开/收起, so the control
                itself tells you which way it points. */}
            <ChevronRight
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-[var(--motion-state)] ease-out",
                logOpen && "rotate-90",
              )}
            />
            <span className="shrink-0">{t("dl.logLines", { n: log.length })}</span>
            {/* `min-w-0` because a flex item's automatic minimum size is its
                content, which would push the live chip out of the panel instead of
                ellipsizing this explanation away. */}
            <span className="app-desc hidden min-w-0 truncate sm:inline">
              {t("dl.logHint")}
            </span>
            {busy && (
              <span
                className={cn(
                  "ml-auto flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5",
                  "transition-colors duration-[var(--motion-medium)]",
                  stalled ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary",
                )}
              >
                {stalled ? (
                  <TriangleAlert className="h-2.5 w-2.5" />
                ) : (
                  <span className="relative flex h-1.5 w-1.5 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/70" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                )}
                {stalled ? t("dl.noOutputSeconds", { n: silentSec }) : t("dl.outputting")}
              </span>
            )}
          </button>

          {logOpen && (
            <>
              <pre
                ref={logRef}
                onScroll={(e) => {
                  // Manual scroll-up detaches; 24px of slack because a bar that
                  // lands one pixel short of the bottom is still "at the bottom".
                  const el = e.currentTarget;
                  setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
                }}
                className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg
                           bg-background p-3 text-caption leading-relaxed text-muted-foreground"
              >
                {log.join("\n")}
              </pre>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <button
                  type="button"
                  onClick={() => (autoScrolling ? setStick(false) : jumpToBottom())}
                  aria-pressed={autoScrolling}
                  title={
                    autoScrollPref ? t("dl.autoscrollPausedHint") : t("dl.autoscrollOffHint")
                  }
                  className={cn(
                    "skin-ctl border px-2 py-0.5 t-state",
                    autoScrolling
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]",
                    !autoScrollPref && "opacity-60",
                  )}
                >
                  {t("dl.autoscroll")}
                </button>
                {!autoScrolling && autoScrollPref && (
                  <button
                    type="button"
                    onClick={jumpToBottom}
                    className="underline decoration-dotted transition-colors hover:text-foreground"
                  >
                    {t("dl.backToLatest")}
                  </button>
                )}
                {/* The log is the thing you paste into a bug report, and a
                    `max-h-56` scroll box is a bad way to get it out of there. */}
                <button
                  type="button"
                  onClick={() => void copyLog(log, t("dl.copyManual"))}
                  className="skin-ctl border border-border px-2 py-1 t-state hover:bg-accent hover:text-foreground active:scale-[0.97]"
                  title={t("dl.copyLogTitle")}
                >
                  {t("dl.copyLog")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function OutcomeBlock({ outcome }: { outcome: DownloadOutcome }) {
  const { t } = useI18n();
  return (
    <div {...reg("download-attempts")} className="mt-3 rounded-lg border border-border-weak bg-background p-3">
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="text-muted-foreground">{t("dl.actualPath")}</span>
        <span className="font-medium">{LAYER_LABEL[outcome.layer]}</span>
        {outcome.viaThirdParty ? (
          <span className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-warning">
            <TriangleAlert className="h-3 w-3" />
            {t("dl.thirdParty")}
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-success">
            <ShieldCheck className="h-3 w-3" />
            {t("dl.official")}
          </span>
        )}
        {outcome.degraded && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
            {t("dl.degraded")}
          </span>
        )}
        {outcome.hazards && outcome.hazards.lfsPointers > 0 && (
          <span
            title={t("dl.lfsTitle")}
            className="rounded-full bg-warning/15 px-2 py-0.5 text-warning"
          >
            {t("dl.lfsPointers", { n: outcome.hazards.lfsPointers })}
          </span>
        )}
        {outcome.hazards?.lfsUnchecked && (
          <span title={t("dl.lfsTitle")} className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
            {t("dl.lfsUnchecked")}
          </span>
        )}
        {outcome.hazards?.submodules && (
          <span
            title={t("dl.submodulesTitle")}
            className="rounded-full bg-warning/15 px-2 py-0.5 text-warning"
          >
            {t("dl.submodules")}
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {outcome.attempts.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-caption">
            {a.ok ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{a.label}</span>
              {a.detail && <span className="ml-1 break-all text-muted-foreground">{a.detail}</span>}
            </span>
            {a.ms > 0 && <span className="shrink-0 text-muted-foreground">{a.ms}ms</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
