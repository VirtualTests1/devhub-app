import { useMemo } from "react";
import { CircleCheck, CircleStop, LoaderCircle, Pause, Play, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/utils";
import { reg } from "../../store/customize";
import type { ProcessState } from "../../types";
import { fmtElapsed } from "../../lib/format";
import { useI18n } from "../../lib/useI18n";

/**
 * 启动中 / 运行中 / 已退出.
 *
 * The three states a launched command can be in, which the dialog previously
 * collapsed into "we saw a line of output". A dev server that is still booting
 * and one that exited with code 1 two seconds ago both looked identical.
 */
export function RunStatus({
  launching,
  procs,
  runningStep,
  onStop,
  onSuspend,
}: {
  launching: boolean;
  procs: ProcessState[];
  runningStep: string | null;
  onStop: (pid: number) => void;
  onSuspend: (pid: number, suspended: boolean) => void;
}) {
  const { t } = useI18n();
  const { running, suspended, exited } = useMemo(() => {
    const running: ProcessState[] = [];
    const suspended: ProcessState[] = [];
    const exited: ProcessState[] = [];
    for (const p of procs) {
      if (p.state === "running") running.push(p);
      else if (p.state === "suspended") suspended.push(p);
      else if (p.state === "exited") exited.push(p);
    }
    return { running, suspended, exited };
  }, [procs]);
  if (!launching && procs.length === 0 && !runningStep) return null;

  return (
    <div {...reg("launch-run-status")} className="mt-2 space-y-1.5">
      {launching && running.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-primary/10 p-2 text-caption">
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1">
            {t("run.startingLead")}
            {runningStep ? t("run.startingStep", { step: runningStep }) : t("run.startingIdle")}
            {t("run.startingTail")}
          </span>
        </div>
      )}

      {[...running, ...suspended].map((p) => (
        <div
          key={p.pid}
          className={cn(
            "flex items-center gap-2 rounded-lg border p-2 text-caption transition-colors",
            p.state === "running"
              ? "border-success/30 bg-success/10 text-success"
              : "border-info/30 bg-info/10 text-info",
          )}
        >
          <span aria-hidden className="relative flex h-2 w-2 shrink-0">
            {p.state === "running" && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            )}
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                p.state === "running" ? "bg-success" : "bg-info",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {p.state === "running" ? t("run.running") : t("run.suspendedState")} · {p.label} ·
            PID {p.pid} · {t("run.elapsed", { elapsed: fmtElapsed(p.elapsedMs) })}
          </span>
          {p.suspendable && (
            <button
              type="button"
              onClick={() => onSuspend(p.pid, p.state === "running")}
              className="flex shrink-0 items-center gap-1 rounded border border-current/40 px-1.5 py-0.5 transition-colors hover:bg-white/10"
              title={p.state === "running" ? t("run.suspendHint") : t("run.resumeHint")}
            >
              {p.state === "running" ? (
                <Pause className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {p.state === "running" ? t("run.suspend") : t("run.resume")}
            </button>
          )}
          {p.stoppable && (
            <button
              type="button"
              onClick={() => onStop(p.pid)}
              className="flex shrink-0 items-center gap-1 rounded border border-current/40 px-1.5 py-0.5 transition-colors hover:bg-white/10"
              title={t("run.stopHint")}
            >
              <CircleStop className="h-3 w-3" />
              {t("run.stop")}
            </button>
          )}
        </div>
      ))}

      {exited.map((p) => {
        /*
         * A command like `Start-Process msedge.exe .\index.html` exits with the
         * *shell's* status within milliseconds while the browser it launched
         * keeps running for hours. Labelling that "已退出（代码 1）" reads as
         * "your project crashed", which is what the report was. Under a second
         * of lifetime plus a non-zero code is the signature, so say what
         * actually happened instead of asserting a crash.
         */
        const shellLike = p.elapsedMs < 1500 && p.exitCode !== 0;
        return (
          <div
            key={p.pid}
            className={cn(
              "flex items-center gap-2 rounded-lg border p-2 text-caption",
              p.exitCode === 0
                ? "border-border-weak bg-background text-muted-foreground"
                : shellLike
                  ? "border-border-weak bg-background text-muted-foreground"
                  : "border-warning/30 bg-warning/5 text-warning",
            )}
          >
            {p.exitCode === 0 ? (
              <CircleCheck className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {p.exitCode === 0
                ? t("run.exitedOk")
                : shellLike
                  ? t("run.shellReturned", { code: p.exitCode ?? t("run.unknown") })
                  : t("run.exitedCode", { code: p.exitCode ?? t("run.unknown") })}
              {" · "}
              {t("run.ranFor", { label: p.label, elapsed: fmtElapsed(p.elapsedMs) })}
            </span>
            {shellLike && (
              <span className="app-desc shrink-0 text-caption text-muted-foreground/80">
                {t("run.maybeRunning")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
