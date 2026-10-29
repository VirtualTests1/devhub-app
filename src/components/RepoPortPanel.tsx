import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openHttpUrl } from "../lib/external-url";
import { CircleCheck, ExternalLink, LoaderCircle, Radio, TriangleAlert } from "lucide-react";
import { createPollLoop } from "../lib/poll-loop";
import { messageOf } from "../lib/report-error";
import { useI18n } from "../lib/useI18n";
import { cn } from "../lib/utils";
import type { PortHealth } from "../types";

/**
 * Gap between probes: a dev server needs a moment to bind, and this panel is a
 * glance, not a monitor. The launch dialog already polls processes at 1 s.
 */
const POLL_MS = 3000;

/**
 * Port health for one repository (round 11, 需求 8.9).
 *
 * The output stream proves a process *started*; this proves it *served*. Those
 * are different facts, and conflating them is why "启动了但打不开页面" used to
 * have nothing to say: a server that bound nothing, or bound a different port
 * than the marker assigned, looked identical to a healthy one in the log.
 *
 * What it deliberately is not: an HTTP check. The honest question is "does
 * something accept TCP on the port we reserved for this service", answered by
 * a loopback connect - guessing the protocol would turn a database's closed
 * port into a failed health check.
 *
 * Polling runs only while the parent says a process is live: a closed dialog
 * or a stopped project must not keep dialing loopback, and the answer is
 * worthless once nothing is running anyway.
 *
 * Round 12 (让失败可见 8.4) added the third thing this panel can say. It used to
 * have a busy flag and no error state: a probe that failed forever rendered
 * exactly like a project with nothing running (`if (!health) return null`), so
 * the one surface that exists to distinguish "起不来" from "查不到" was silent
 * about which of the two it was. There is now a visible failure with 重试.
 *
 * Round 18 (r18-o1-1) moved every sentence into the dictionary; the words are
 * quoted byte-for-byte from the pre-wiring source (tests/i18n.test.ts, 5e).
 */
export function RepoPortPanel({ slug, active }: { slug: string; active: boolean }) {
  const { t } = useI18n();
  const [health, setHealth] = useState<PortHealth[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why this panel is showing a failure instead of a port list. `null` = no
   *  failure on the last answer, so a recovered probe clears it by itself. */
  const [error, setError] = useState<string | null>(null);
  /** Bumping this re-runs the effect. 重试 = probe now, on the same rules. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) {
      // Stopped: drop the answer rather than leaving a stale "已监听" on screen
      // for a project that is no longer running. Same for the failure — it was
      // about a run that has ended. `busy` goes too: a probe that was still out
      // when the process stopped must not leave 重试 disabled for the next run.
      setHealth(null);
      setError(null);
      setBusy(false);
      return;
    }
    // The loop lives in `lib/poll-loop.ts` so the in-flight case has a test.
    // `stop()` in the cleanup is what the old `clearTimeout(timer)` could not do
    // while a request was still out: `timer` had not been assigned yet, so the
    // cleanup cleared `0` and the tick went on scheduling itself forever.
    //
    // The answer is deliberately kept on screen when a later probe fails: the
    // last known port state is more useful than nothing, as long as the panel
    // also says that this tick did not read anything.
    const loop = createPollLoop<PortHealth[]>({
      everyMs: POLL_MS,
      probe: () => invoke<PortHealth[]>("repo_port_health", { slug }),
      onStart: () => setBusy(true),
      onResult: (h) => {
        setHealth(h);
        setError(null);
        setBusy(false);
      },
      onError: (err) => {
        // 探测失败 ≠ 端口没监听 ≠ 什么都没跑。
        setError(messageOf(err));
        setBusy(false);
      },
      schedule: (cb, ms) => window.setTimeout(cb, ms),
      unschedule: (id) => window.clearTimeout(id),
    });
    loop.start();
    return () => loop.stop();
  }, [slug, active, attempt]);

  if (!active) return null;
  const hasList = !!health && health.length > 0;
  // Nothing assigned (a legacy marker without a port block) and nothing running:
  // both mean "nothing to say". A failure is not nothing to say, so it survives
  // this guard even when there is no list to hang it on.
  if (!hasList && !error) return null;

  const listening = (health ?? []).filter((h) => h.listening).length;

  return (
    <div className="mt-2 rounded-lg border border-border-weak bg-background p-2.5">
      {error && (
        <div
          role="alert"
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 text-caption leading-snug",
            hasList ? "border-warning/40 bg-warning/10 text-warning" : "border-danger/40 bg-danger/5 text-danger",
          )}
        >
          <TriangleAlert className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">
            {/* 有过一次答案、这次读不到：说清是「这次」失败，并把旧结果的身份标出来。
                一次都没读到：直接说检查失败，别让用户以为端口都没在监听。 */}
            {hasList
              ? t("port.staleError", { msg: error })
              : t("port.probeError", { msg: error })}
          </span>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            disabled={busy}
            className="skin-ctl shrink-0 rounded px-2 py-0.5 text-caption transition-colors hover:bg-accent disabled:opacity-40"
          >
            {t("port.retry")}
          </button>
        </div>
      )}
      {!hasList && (
        <p className="app-desc mt-1.5 text-caption leading-snug text-muted-foreground">
          {t("port.noPorts")}
        </p>
      )}
      {hasList && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-caption font-medium">
              <Radio className="h-3 w-3 text-muted-foreground" />
              {t("port.title")}
            </span>
            <span className="text-caption text-muted-foreground">
              {t("port.listeningCount", { up: listening, n: health.length })}
            </span>
            {busy && <LoaderCircle className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {health.map((h) => (
              <span
                key={`${h.service}-${h.port}`}
                title={
                  h.listening
                    ? t("port.chipOpenTitle", { service: h.service, port: h.port })
                    : t("port.chipClosedTitle", { service: h.service, port: h.port })
                }
                className={
                  h.listening
                    ? "flex items-center gap-1 rounded-full border border-success/30 bg-success/15 px-2 py-0.5 text-caption text-success"
                    : "flex items-center gap-1 rounded-full border border-border-weak bg-muted px-2 py-0.5 text-caption text-muted-foreground"
                }
              >
                {h.listening ? (
                  <CircleCheck className="h-2.5 w-2.5 shrink-0" />
                ) : (
                  <Radio className="h-2.5 w-2.5 shrink-0" />
                )}
                {/* The listening/dead distinction is colour-only today, and the two
                    chip texts are identical — so it now also reads as a word, not
                    just a hue (color-blind users see the same green/grey blob). */}
                {h.service} · {h.port}
                <strong className="font-medium">{h.listening ? t("port.listening") : t("port.notListening")}</strong>
                {h.listening && (
                  <button
                    type="button"
                    onClick={() => void openHttpUrl(`http://127.0.0.1:${h.port}`)}
                    title={t("port.openTitle", { url: `http://127.0.0.1:${h.port}` })}
                    className="ml-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-black/10"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    {t("port.open")}
                  </button>
                )}
              </span>
            ))}
          </div>
          <p className="app-desc mt-1.5 text-caption leading-snug text-muted-foreground">
            {t("port.footnote")}
          </p>
        </>
      )}
    </div>
  );
}
