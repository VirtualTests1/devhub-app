import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import { confirmDestructive } from "../lib/confirm";
import {
  Activity,
  ArrowRight,
  ChevronUp,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  Route,
  ShieldAlert,
  Square,
  Stethoscope,
  TriangleAlert,
  Wifi,
  WifiLow,
  WifiOff,
} from "lucide-react";
import { cn } from "../lib/utils";
import { hasOwnActivation, useDismiss } from "../lib/useDismiss";
import { useLayerExit } from "../lib/motion";
import { messageOf, reportError } from "../lib/report-error";
import { fmtElapsed, formatBytes } from "../lib/format";
import {
  createNetStatusPoller,
  describeNetStatus,
  NET_POLL_MS,
  parseNetStatus,
  type NetStatusPoller,
  type NetStatusReport,
} from "../lib/net-status";
import type { TFunc } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { toast } from "../components/Toast";
import type { EnvironmentReport, GitBootstrapStatus, ProcessState } from "../types";
import { StatusCard } from "../components/StatusCard";
import { reg, useCustomize } from "../store/customize";
import { countByStatus, useDownloads } from "../store/downloads";
import {
  liveElapsedMs,
  useLiveProcesses,
  useProcessSecond,
  useRunningProcessCount,
} from "../store/processes";
import { useUI } from "../store/ui";

/**
 * Persistent bottom status strip.
 *
 * The requirement it exists to satisfy has not changed: the UI must always say
 * which network path is actually in use. What *was* wrong is the word "actual".
 * This build used to answer that by TCP-probing eight forward-proxy ports, and
 * on a machine where Watt Toolkit accelerates GitHub by rewriting `hosts` and
 * terminating TLS on 127.0.0.1:443, that probe correctly printed 未发现 — while
 * every request the app made was in fact going through a third-party local
 * proxy. Technically true, practically misleading.
 *
 * So the strip now reports the **source** of the link, from four independent
 * signals: hosts redirection, the Windows system proxy, a listening forward
 * proxy, and plain DNS. And it says what the app decided to do about it
 * (bypassed / used), because that is the thing a user actually needs to know
 * before trusting a download.
 *
 * Round 21 N4 adds an orthogonal signal beside it: the Wifi segment says whether
 * `github.com:443` answers *right now*, not how traffic is routed. A direct path
 * can be offline and a proxied path can be online, so neither segment may be
 * derived from the other. The liveness half is a 2.5 s DNS+TCP probe cached for
 * 10 s, polled every 60 s only while the window is visible, and forced past the
 * cache by a click. "Not measured" is its own state; it is never painted as
 * offline.
 *
 * Round 3 also made it behave like a popover instead of a stuck-out rectangle:
 * it is its own rounded panel, it closes when you click anywhere outside, and
 * double-clicking a card jumps to the setting that controls it.
 */
export function StatusStrip({
  env,
  gitStatus,
}: {
  env: EnvironmentReport | null;
  gitStatus: GitBootstrapStatus | null;
}) {
  const [open, setOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [netStatus, setNetStatus] = useState<NetStatusReport | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const netPollerRef = useRef<NetStatusPoller | null>(null);
  const go = useUI((s) => s.go);
  const setSettingsSection = useUI((s) => s.setSettingsSection);
  // r16-n2-2: the strip's own words. `t` from `useI18n` is the subscription *and*
  // the translator: it re-renders the strip when the language row flips, and it is
  // memoised on the locale, so an unrelated render does not churn it. Every string
  // below resolves through it — including the one inside the download tally
  // selector, which is why that selector reads `t` rather than a module-level
  // literal (a language switch re-runs the selector with the new translator).
  const { t } = useI18n();
  const showActive = useCustomize((s) => !s.overrides["status-seg-active"]?.hidden);
  const showDownloadSeg = useCustomize((s) => !s.overrides["status-seg-download"]?.hidden);
  const showNet = useCustomize((s) => !s.overrides["status-seg-net"]?.hidden);
  // One subscription over the download tasks, not five passes per progress
  // event. The strip used to run four separate `s.tasks.filter(...).length`
  // selectors plus a fifth loop for `headline` — five walks of the array every
  // time a download reported. `countByStatus` (store/downloads) is the store's
  // own one-pass tally, the same helper `DownloadQueue`'s header subscribes to,
  // so the three displayed counts and the 未完成 number come from that one
  // result and `headline` folds into the same selector. Every field is a
  // primitive, so `useShallow` re-renders the strip only when a value actually
  // moves — progress events (which change `progress`/`lastLine`, not a count or
  // a ref) leave all five untouched. The popover's per-task detail lives in
  // `DownloadPopoverSection`, which subscribes to the array and mounts only
  // while that popover is open.
  const { running: dlRunning, queued: dlQueued, failed: dlFailed, unfinished: dlUnfinished, headline } =
    useDownloads(
      useShallow((s) => {
        const tally = countByStatus(s.tasks);
        /**
         * The one download the strip names, so the segment says *what* is
         * happening and not only that something is. A running task beats a
         * queued one, and a single task needs no count to disambiguate it.
         */
        let runningRef: string | null = null;
        let firstRef: string | null = null;
        let active = 0;
        for (const t of s.tasks) {
          if (t.status === "running" || t.status === "queued") {
            active += 1;
            if (firstRef === null) firstRef = t.ref;
            if (t.status === "running" && runningRef === null) runningRef = t.ref;
          }
        }
        const ref = runningRef ?? firstRef;
        return {
          running: tally.running,
          queued: tally.queued,
          failed: tally.failed,
          // 未完成 = 还没落成 done 的行（含失败的），也就是 `status !== "done"` 那个
          // 定义。它不是 `finished` 的补集：countByStatus 的 finished = done+failed
          // （clearFinished 清掉的行），补集只会是 running+queued。两个数各归各，
          // 这里按 running+queued+failed 还原，对真实状态联合与旧的 filter 等价。
          unfinished: tally.running + tally.queued + tally.failed,
          headline: ref === null ? "" : active > 1 ? t("strip.activeGroup", { ref, n: active }) : ref,
        };
      }),
    );
  const dlActive = dlRunning + dlQueued;

  // A primitive count, so a poll tick that keeps it constant does not re-render
  // the strip at all. The popover's per-process rows live in `RunningProcessPanel`,
  // which subscribes to the full list and only mounts while that popover is open.
  const runningCount = useRunningProcessCount();
  // The 运行中 trigger unmounts at `runningCount === 0` (see its render guard
  // below), which means the only places that ever cleared `runOpen` — its own
  // toggle, the row, the 链路 button, dismiss — can no longer fire once the last
  // process exits. Without this reset the strip remembers "open" across the empty
  // stretch: the chevron stays rotated, `useDismiss` stays armed, and the next
  // launch pops the panel open unprompted, because `runLayer` below reads the
  // stale `runOpen` again. Deriving those consumers from
  // `runOpen && runningCount > 0` instead would fix only the first two symptoms
  // and leave the stale state to fire on the next launch, so the state itself is
  // reset here — one effect, and `aria-expanded={runOpen}` stays truthful for
  // free.
  useEffect(() => {
    if (runningCount === 0) setRunOpen(false);
  }, [runningCount]);

  useEffect(() => {
    if (!showNet) return;
    setNetStatus(null);
    const poller = createNetStatusPoller({
      probe: (force) => invoke<unknown>("net_status", { force }),
      onResult: (value) => setNetStatus(parseNetStatus(value)),
      onError: () => setNetStatus(null),
      everyMs: NET_POLL_MS,
      schedule: (cb, ms) => window.setTimeout(cb, ms),
      unschedule: (id) => window.clearTimeout(id),
      isVisible: () => document.visibilityState !== "hidden",
    });
    netPollerRef.current = poller;
    const onVisibility = () => poller.setVisible(document.visibilityState !== "hidden");
    const onFocus = () => poller.refresh(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    poller.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      poller.stop();
      netPollerRef.current = null;
    };
  }, [showNet]);
  // 需求 1：弹层的消失动画。两个面板过去靠 `animation: dialogIn` 进场、卸载即消失，
  // 而 dialogIn 这个 keyframe 在 S2 已被 data-layer 机制取代。
  const runLayer = useLayerExit(runOpen && runningCount > 0);
  const envLayer = useLayerExit(open);

  // Click-away covers both popovers, and Escape closes whichever is open - the
  // strip's own trigger is inside `rootRef`, so a toggle click cannot close itself
  // back down again.
  useDismiss(
    rootRef,
    () => {
      setOpen(false);
      setRunOpen(false);
    },
    { enabled: open || runOpen, capture: true },
  );

  const link = describeLink(env, t);
  const netView = describeNetStatus(netStatus, t);
  const netAria = `${netView.label} · ${netView.title}`;
  const NetIcon =
    netStatus?.state === "offline" ? WifiOff : netStatus?.state === "degraded" ? WifiLow : Wifi;
  const netToneClass = {
    ok: "text-success",
    warn: "text-warning",
    danger: "text-danger",
    muted: "text-muted-foreground",
  }[netView.tone];
  const toneClass = {
    ok: "text-success",
    warn: "text-warning",
    info: "text-info",
    muted: "text-muted-foreground",
  }[link.tone];
  const dotClass = {
    ok: "bg-success",
    warn: "bg-warning",
    info: "bg-info",
    muted: "bg-muted-foreground",
  }[link.tone];

  const gitText = env?.git
    ? env.git.version.replace(/^git version\s*/i, "").replace(/\.windows\.\d+$/, "")
    : t("strip.gitMissing");

  /** Double-click a card → the setting that owns it. */
  const jump = (section: string) => {
    setOpen(false);
    go("settings");
    setSettingsSection(section);
  };

  return (
    <div ref={rootRef} {...reg("status-strip")} className="relative shrink-0 p-1.5 pt-0">
      {/* A group, not a button (r15-correct-11). This row used to be a
          `role="button"` div wrapping the whole strip - and ARIA makes everything
          inside a button presentational, so the two live counts it carries (运行中,
          下载中/下载失败) were not merely badly styled: their labels, their own
          `aria-expanded` and their existence were hidden from a screen reader, and
          the 停止 / 队列 actions behind them were unreachable by keyboard or AT
          however you got there. The strip is now what it actually is - a group of
          controls that share a row.
          The comment this replaces justified the fake button by the nested-`<button>`
          parser hoist. That hoist only happens inside a real `<button>` element, so
          with a group container the inner controls get to be honest buttons: the
          disclosure is a `<button>` on the 链路 segment, 运行中 is a `<button>`, 下载
          always was one. Being real `<button>`s is also what puts them under the
          shell's one focus language (`index.css:485`) and its press feedback
          (`index.css:378`) instead of a hand-rolled approximation of both. Mouse
          behaviour is untouched - clicking anywhere in the row still toggles the
          popover - and the row stops being a second tab stop, so nothing now has to
          fight over Enter: the keys that used to be re-implemented in two
          `onKeyDown` handlers are the browser's own. */}
      <div
        role="group"
        aria-label={t("strip.ariaGroup")}
        onClick={(e) => {
          // The click-anywhere contract stays for the mouse, but a click that
          // belongs to a control inside the row is that control's, not the row's —
          // the same guard the settings rows and the queue rows got in r15-a11y-1/2.
          if (hasOwnActivation(e.target)) return;
          setOpen((v) => !v);
          setRunOpen(false);
        }}
        title={open ? t("strip.collapse") : t("strip.expand")}
        style={{ height: "var(--reg-strip-h, 32px)" }}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border-weak bg-raised px-2.5 text-left text-caption shadow-[var(--shadow-strip)] transition-colors hover:bg-raised/70"
      >
        {/* 需求 2: the strip used to be one flat row of equal-weight segments
            joined by │ characters - nothing said what mattered. Now the link
            (the one fact the app exists to report) carries the weight, the two
            live counts are pills, and the static facts (git, root) are demoted
            to the quiet end of the row.
            The link segment is the strip's disclosure trigger: it is the first tab
            stop in the row and its `aria-expanded` is the popover's state. */}
        <button
          type="button"
          {...reg("status-seg-link")}
          aria-expanded={open}
          onClick={(e) => {
            // Own activation: the row would otherwise toggle a second time on the
            // way up to this handler's parent.
            e.stopPropagation();
            setOpen((v) => !v);
            setRunOpen(false);
          }}
          className="flex min-w-0 items-center gap-1.5 rounded-md transition-colors"
          title={env?.linkAdvice || undefined}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} />
          <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={cn("truncate font-medium transition-colors duration-[var(--motion-quick)]", toneClass)}>
            {t("strip.link", { label: env?.linkLabel || link.label })}
          </span>
        </button>

        {showNet && (
          <>
            <Divider />
            <button
              type="button"
              {...reg("status-seg-net")}
              onClick={(e) => {
                e.stopPropagation();
                netPollerRef.current?.refresh(true);
              }}
              title={netAria}
              aria-label={netAria}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent"
            >
              <NetIcon className={cn("h-3 w-3 shrink-0", netToneClass)} />
              <span className={cn("shrink-0 font-medium", netToneClass)}>{netView.label}</span>
            </button>
          </>
        )}

        <Divider />

        <span {...reg("status-seg-git")} className="shrink-0 tabular-nums text-muted-foreground/70">
          git {gitText}
        </span>

        <Divider />

        <span {...reg("status-seg-root")} className="flex min-w-0 flex-1 items-center gap-1.5">
          <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate text-muted-foreground/70">{env?.projectRoot ?? "—"}</span>
        </span>

        {showActive && runningCount > 0 && (
          <button
            {...reg("status-seg-active")}
            type="button"
            aria-expanded={runOpen}
            onClick={(e) => {
              // The strip's own toggle is on the parent, so this has to stop
              // there or clicking 运行中 would open the environment popover too.
              e.stopPropagation();
              setRunOpen((v) => !v);
              setOpen(false);
            }}
            title={
              runOpen
                ? t("strip.runCollapse")
                : t("strip.runExpand", { n: runningCount })
            }
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 tabular-nums transition-colors",
              // Tinted background + coloured text. `bg-success text-success` (what
              // this line used to be) paints the label in its own background colour
              // — `--color-success` is one token for both (`index.css:108`), so the
              // pill rendered 运行中 N as an invisible blob (r15-correct-10). Same
              // idiom as the sidebar's collapsed count (`Sidebar.tsx:327`). The
              // ternary that used to sit here had two identical branches — the open
              // state never did come from colour; it comes from `aria-expanded`, the
              // `title`, and the chevron that rotates at the end of the row.
              "bg-success/15 text-success hover:bg-success/25",
            )}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            {t("strip.running", { n: runningCount })}
          </button>
        )}

        {showDownloadSeg && (dlActive > 0 || dlFailed > 0) && (
          <button
            type="button"
            {...reg("status-seg-download")}
            onClick={(e) => {
              // The segment is a shortcut to the queue, not a popover toggle:
              // jumping straight to the 添加页 where the per-task panels live
              // answers "what is it doing" faster than a summary card.
              e.stopPropagation();
              setOpen(false);
              go("add");
            }}
            className={cn(
              "flex min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 tabular-nums transition-colors",
              // Same contrast rule as 运行中 above: the hue goes on the text, a
              // 15 % wash goes behind it. `bg-danger text-danger` made 下载失败 N
              // unreadable in exactly the same way (r15-correct-10), and the
              // `hover:` pair that trailed each branch re-applied the identical
              // colours, i.e. was a no-op.
              dlFailed > 0 && dlActive === 0
                ? "bg-danger/15 text-danger hover:bg-danger/25"
                : "bg-success/15 text-success hover:bg-success/25",
            )}
            title={t("strip.downloadTitle")}
          >
            {dlActive > 0 ? (
              <>
                <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" />
                <span className="shrink-0">
                  {t("strip.downloading", { n: dlRunning })}
                  {dlQueued > 0 && ` ${t("strip.queued", { n: dlQueued })}`}
                </span>
                {/* Which one. A count alone answers "is something happening"
                    and not "what", which is the question being asked. */}
                {headline && (
                  <span className="min-w-0 max-w-[10rem] truncate font-normal text-muted-foreground" title={headline}>
                    {headline}
                  </span>
                )}
              </>
            ) : (
              <>
                <Download className="h-3 w-3 shrink-0" />
                <span className="shrink-0">{t("strip.downloadFailed", { n: dlFailed })}</span>
              </>
            )}
          </button>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {env?.mirrorEnabled && <TriangleAlert className="h-3 w-3 text-warning" />}
          {env?.hostsHijacked && <ShieldAlert className="h-3 w-3 text-info" />}
          <ChevronUp className={cn("h-3 w-3 transition-transform duration-[var(--motion-state)]", (open || runOpen) && "rotate-180")} />
        </span>
      </div>

      {/* The process list. The count in the strip has always been correct and has
          never been actionable, which is the report this panel exists for: "点击
          状态栏之后没有对应、具体的显示". Each row can be suspended, resumed,
          stopped, or traced back to the project it belongs to. The per-process
          detail is `RunningProcessPanel`, which subscribes to the full live list and
          so is only mounted while this popover is up — the strip itself stays on the
          primitive count. */}
      {runLayer.render && (
        <RunningProcessPanel state={runLayer.state} onClose={() => setRunOpen(false)} />
      )}

      {envLayer.render && (
        <div
          data-layer="panel"
          data-state={envLayer.state}
          className="skin-pop absolute bottom-full left-1.5 right-1.5 z-40 mb-1 max-h-[72vh] overflow-y-auto border border-border bg-raised p-3"
        >
          {/* 需求 2: the popover used to be a flat 4-column card grid with a
              footnote hanging off it - five facts of five different kinds with
              nothing saying which belonged together. Now it reads top-down:
              one summary line, then titled groups (环境 / 网络 / 进行中), the
              toggle states as a facts row inside 网络 instead of small print. */}
          <div className="mb-2.5 flex items-center gap-2">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} />
            <span className={cn("text-body font-medium", toneClass)}>{link.label}</span>
            <span className="app-desc ml-auto shrink-0 text-caption text-muted-foreground">
              {t("strip.doubleClickHint")}
            </span>
          </div>

          <PanelSection title={t("strip.sectionEnv")}>
            <StatusCard
              regId="status-card-git"
              onDoubleClick={() => jump("git")}
              icon={<Activity className="h-3.5 w-3.5" />}
              title="git"
              value={env?.git ? env.git.version : t("strip.gitNotFound")}
              tone={env?.git ? "good" : "bad"}
              hint={
                env?.git
                  ? env.git.source === "system"
                    ? t("strip.gitSourceSystem")
                    : t("strip.gitSourceBuiltin") +
                      (gitStatus?.marker ? t("strip.gitSourceBuiltinTag", { tag: gitStatus.marker.tag }) : "")
                  : t("strip.gitWillBootstrap")
              }
            />
            <StatusCard
              regId="status-card-project-root"
              onDoubleClick={() => jump("roots")}
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              title={t("strip.projectRoot")}
              value={env?.projectRoot ?? t("strip.detecting")}
              tone={env?.rootIsFallback ? "warn" : "default"}
              hint={env?.rootIsFallback ? t("strip.rootFallback") : t("strip.rootFixed")}
            />
          </PanelSection>

          <PanelSection title={t("strip.sectionNetwork")}>
            <StatusCard
              regId="status-card-proxy"
              onDoubleClick={() => jump("network")}
              icon={<Route className="h-3.5 w-3.5" />}
              title={t("strip.localProxyTitle")}
              value={env?.localProxy ?? t("strip.proxyNotFound")}
              tone={env?.localProxy ? "good" : "default"}
              hint={t("strip.proxyHint")}
            />
            <StatusCard
              regId="status-card-hosts"
              onDoubleClick={() => jump("network")}
              icon={<ShieldAlert className="h-3.5 w-3.5" />}
              title={t("strip.hostsTitle")}
              value={
                !env?.hostsHijacked
                  ? t("strip.hostsNotRewritten")
                  : env.hostsBy
                    ? t("strip.hostsRewrittenBy", { n: env.hostsRedirectCount ?? "", by: env.hostsBy })
                    : t("strip.hostsRewritten", { n: env.hostsRedirectCount ?? "" })
              }
              tone={env?.hostsHijacked ? "warn" : "default"}
              hint={
                env?.hostsHijacked
                  ? t("strip.hostsHijackLead") +
                    // types.ts 的联合类型被写入守卫阻断，后端已可返回 auto
                    ((env.searchRoute as string) === "auto"
                      ? t("strip.policyAuto")
                      : env.searchRoute === "useHosts"
                        ? t("strip.policyUseHosts")
                        : t("strip.policyBypass"))
                  : t("strip.hostsClean")
              }
            />
            <StatusCard
              regId="status-card-resolved-ip"
              onDoubleClick={() => jump("network")}
              icon={<Route className="h-3.5 w-3.5" />}
              title={t("strip.resolvedTitle")}
              value={env?.resolvedIp ?? t("strip.resolversDisagree")}
              tone={env?.resolvedIp ? "good" : "warn"}
              hint={t("strip.resolvedHint")}
            />
            {/* The three switch states, as a facts row rather than footnote
                small print: they answer "what did the app decide to do", which
                is the same kind of question the cards above answer. */}
            <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-weak pt-2 text-caption text-muted-foreground">
              <span>
                {t("strip.ipPinLabel")}
                {env?.ipPinEnabled ? (
                  <span className="text-success">{t("strip.enabled")}</span>
                ) : (
                  t("strip.disabled")
                )}
              </span>
              <span>
                {t("strip.mirrorLabel")}
                {env?.mirrorEnabled ? (
                  <span className="text-warning">{t("strip.mirrorEnabled")}</span>
                ) : (
                  t("strip.disabled")
                )}
              </span>
              <span>
                {t("strip.privLabel")}
                {env?.elevated ? (
                  <span className="text-warning">{t("strip.privElevated")}</span>
                ) : (
                  <span className="text-success">{t("strip.privStandard")}</span>
                )}
              </span>
            </div>
            <p className="app-desc col-span-full text-caption text-muted-foreground/80">
              {t("strip.ipPinNote")}
            </p>
            {/* r18 N2: 三张卡片各自只说一件事，整体「链路有没有毛病」没有地方回答。
                这条按钮把整张网络事实连同一份分级结论交给网络诊断对话框。 */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                useUI.getState().setNetDiagOpen(true);
              }}
              className="skin-ctl col-span-full inline-flex w-fit items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Stethoscope className="h-3 w-3" />
              {t("netdiag.open")}
            </button>
          </PanelSection>

          {dlUnfinished > 0 && (
            <DownloadPopoverSection
              onViewAll={() => {
                setOpen(false);
                go("add");
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The 下载 group inside the environment popover.
 *
 * It is the one part of the strip that genuinely needs the whole `tasks` array — it
 * renders the six newest unfinished rows with their live log line — so it subscribes
 * to the array here instead of the strip doing so. Because this component only mounts
 * while `envLayer.render` is true (the popover is up), the per-progress-event
 * subscription exists only while someone is actually looking at it; a download running
 * in the background no longer re-renders the strip several times a second.
 */
function DownloadPopoverSection({ onViewAll }: { onViewAll: () => void }) {
  const { t } = useI18n();
  const downloadTasks = useDownloads((s) => s.tasks);

  const revealDownload = (path: string | undefined) => {
    if (!path) return;
    // The click's only job is to open that folder, so a rejection here is not
    // bookkeeping beside a success — it is the action failing and the button just
    // looks broken. Same copy as the other reveal_path clicks in the app.
    void invoke("reveal_path", { path }).catch((e) => reportError(e, t("strip.revealFolderFailed")));
  };

  return (
    <PanelSection title={t("strip.sectionDownloads")}>
      <div className="col-span-full">
        <div className="mb-1.5 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Download className="h-3 w-3" />
          <span className="font-medium">{t("strip.downloadQueue")}</span>
          <button
            type="button"
            onClick={onViewAll}
            className="ml-auto transition-colors hover:text-foreground"
          >
            {t("strip.viewAll")}
            <ArrowRight className="h-3 w-3 shrink-0" />
          </button>
        </div>
        <ul className="space-y-1">
          {downloadTasks
            .filter((task) => task.status !== "done")
            // The store is newest-first (需求 9), so the head of the
            // array is the recent end - `slice(-6)` used to show the
            // six *oldest* unfinished tasks here.
            .slice(0, 6)
            .map((task) => {
              const revealable = task.outcome?.path ?? task.targetDir ?? undefined;
              return (
                <li
                  key={task.id}
                  className="flex items-center gap-2 rounded-md border border-border-weak bg-background px-2 py-1 text-caption"
                >
                  {task.status === "running" ? (
                    <LoaderCircle className="h-3 w-3 shrink-0 animate-spin text-success" />
                  ) : task.status === "failed" ? (
                    <TriangleAlert className="h-3 w-3 shrink-0 text-danger" />
                  ) : (
                    <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{task.ref}</span>
                  <span className="shrink-0 truncate text-muted-foreground">
                    {task.status === "failed"
                      ? (task.failure ?? t("strip.taskFailed"))
                      : task.lastLine || (task.status === "queued" ? t("strip.taskQueued") : t("strip.taskRunning"))}
                  </span>
                  {revealable && (
                    <button
                      type="button"
                      onClick={() => revealDownload(revealable)}
                      title={t("strip.revealTarget")}
                      aria-label={t("strip.revealTarget")}
                      className="shrink-0 rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <FolderOpen className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </PanelSection>
  );
}

/**
 * The 运行中 popover's content.
 *
 * Extracted from `StatusStrip` and mounted only while that popover is open, so the
 * full live-process subscription exists for exactly as long as the panel is up. The
 * strip itself stays on `useRunningProcessCount`, a primitive.
 *
 * The comment here used to justify the extraction by saying `live` "changes on every
 * two-second tick because `elapsedMs` advances". That stopped being true when the
 * poller began writing the store only when something besides the clock moved
 * (`sameProcessList` in `store/processes`) — which is precisely what a row is keyed
 * on. So the elapsed figure is reconstructed below from the last reported value plus
 * the time since it was reported, on the shared second hand; without that, this
 * panel shows a stopped clock next to processes that are still running.
 */
function RunningProcessPanel({
  state,
  onClose,
}: {
  state: "open" | "closed";
  onClose: () => void;
}) {
  const { t } = useI18n();
  const live = useLiveProcesses();
  // The store now rewrites `live` only when something besides the clock moved, so the
  // instant this array was replaced *is* the instant its `elapsedMs` values were
  // reported. Re-deriving here keeps the panel ticking without making the 2 s poller
  // rebuild the whole list. The stamp lives in a ref keyed on the array's identity:
  // `useMemo(() => Date.now(), [live])` is the same thing, but the linter cannot see
  // that the dependency is the trigger rather than a value the callback reads.
  const reportedAtRef = useRef({ live, at: Date.now() });
  if (reportedAtRef.current.live !== live) {
    reportedAtRef.current = { live, at: Date.now() };
  }
  const reportedAt = reportedAtRef.current.at;
  useProcessSecond(live.length > 0);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const running = live.filter((p) => p.state !== "exited");
  // 全部停止's own progress and its per-item verdict live here rather than in the
  // strip: this component is the one that holds the full list (the strip stays on
  // the primitive count, see `useRunningProcessCount`), and keeping the verdict out
  // of the rows means it survives the poll that drops a stopped process from `live`.
  const [stopping, setStopping] = useState(false);
  const [stopReport, setStopReport] = useState<{
    stopped: number;
    total: number;
    failed: { label: string; detail: string }[];
  } | null>(null);

  /** Freezes a process tree, or lets it run again. One command, both directions. */
  const setSuspended = async (pid: number, suspended: boolean) => {
    try {
      await invoke("suspend_process", { pid, suspended });
    } catch (err) {
      reportError(err, suspended ? t("strip.suspendFailed") : t("strip.resumeFailed"));
    }
  };

  /**
   * The one stop path (需求 9.2). It answers with the reason or `null`, so 停止 on a
   * row and 全部停止 cannot report the same rejection in two different words — and so
   * the batch version keeps every failure instead of stopping at the first one.
   *
   * 挂起 is not touched by this: a suspended process is frozen, not dead, and
   * `ProcessState` keeps those as separate states on purpose. 全部停止 does end a
   * suspended one — it is a stop, and saying so in the confirmation is what makes it
   * honest rather than surprising.
   */
  const stopPid = async (p: ProcessState): Promise<string | null> => {
    if (!p.stoppable) return t("strip.cannotStopReason");
    try {
      await invoke("stop_process", { pid: p.pid });
      return null;
    } catch (err) {
      return messageOf(err);
    }
  };

  const stopOne = async (pid: number) => {
    const p = running.find((x) => x.pid === pid);
    if (!p) return;
    const reason = await stopPid(p);
    if (reason) toast.error(t("strip.stopFailed", { reason }));
  };

  /**
   * 全部停止: every tracked process, one confirmation that names how many and which
   * projects, then the same per-PID command. Results are per item — a run that
   * stopped eleven of thirteen says which two failed and why, rather than a toast
   * that could only report the first rejection.
   */
  const stopAll = async () => {
    const targets = running;
    if (!targets.length) return;
    const slugs = [...new Set(targets.map((p) => p.slug.split("/").slice(1).join("/") || p.slug))];
    const suspended = targets.filter((p) => p.state === "suspended").length;
    const ok = await confirmDestructive(
      t("strip.stopAllConfirm", { n: targets.length, slugs: slugs.join("、") }) +
        (suspended ? t("strip.stopAllSuspendedNote", { n: suspended }) : ""),
      {
        title: t("strip.stopAllTitle"),
        okLabel: t("strip.stopAllOk", { n: targets.length }),
      },
    );
    if (!ok) return;
    setStopping(true);
    setStopReport(null);
    let stopped = 0;
    const failed: { label: string; detail: string }[] = [];
    for (const p of targets) {
      const reason = await stopPid(p);
      if (reason) failed.push({ label: `${p.label} · PID ${p.pid}`, detail: reason });
      else stopped += 1;
    }
    setStopping(false);
    setStopReport({ stopped, total: targets.length, failed });
    if (failed.length) {
      toast.error(
        t("strip.stoppedReport", { stopped, total: targets.length }) +
          t("strip.stoppedReportFailed", { n: failed.length }),
      );
    } else toast.success(t("strip.stoppedAll", { n: stopped }));
  };

  return (
    <div
      data-layer="panel"
      data-state={state}
      className="elevation-panel-up absolute bottom-full left-1.5 right-1.5 z-40 mb-1 rounded-xl border border-border bg-raised p-2"
    >
      <div className="mb-1 flex items-baseline gap-2 px-1">
        <span className="text-caption font-medium text-foreground">{t("strip.runningProcesses")}</span>
        <span className="app-desc text-caption text-muted-foreground">
          {t("strip.suspendNote")}
        </span>
        {/* 需求 9.2: the count has always been the strip's own fact, so the way out of
            it belongs here too rather than being N clicks of 停止. */}
        <button
          type="button"
          onClick={() => void stopAll()}
          disabled={stopping || running.length === 0}
          aria-label={t("strip.stopAllAria", { n: running.length })}
          title={t("strip.stopAllHint", { n: running.length })}
          className="skin-ctl ml-auto flex shrink-0 items-center gap-1 border border-danger/40 px-2 py-0.5 text-caption text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
        >
          {stopping ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Square className="h-3 w-3" />
          )}
          {stopping ? t("strip.stopping") : t("strip.stopAll")}
        </button>
      </div>

      {stopReport && stopReport.failed.length > 0 && (
        <div className="mb-1 rounded-lg border border-danger/30 bg-danger/5 p-2 text-caption text-danger">
          <span className="font-medium">
            {t("strip.stopProgress", { stopped: stopReport.stopped, total: stopReport.total })}
            {t("strip.stoppedReportFailed", { n: stopReport.failed.length })}
          </span>
          <ul className="mt-1 space-y-0.5">
            {stopReport.failed.map((f) => (
              <li key={f.label} className="break-words text-muted-foreground">
                <span className="text-danger">{f.label}</span>：{f.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="max-h-[40vh] space-y-1 overflow-y-auto">
        {running.map((p) => (
          <li
            key={p.pid}
            className="flex items-center gap-2 rounded-lg border border-border-weak bg-card px-2 py-1.5"
          >
            {/* 状态点：颜色之外再给形状与文字两种冗余信号（已挂起的行有
                「已挂起」字样，运行中的没有，所以点本身必须可念出来）。 */}
            <span
              role="img"
              aria-label={p.state === "suspended" ? t("strip.stateSuspended") : t("strip.stateRunning")}
              title={p.state === "suspended" ? t("strip.stateSuspended") : t("strip.stateRunning")}
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                p.state === "suspended" ? "border border-warning bg-transparent" : "bg-success",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-caption text-foreground" title={p.label}>
                {p.label}
              </span>
              <span className="app-desc block truncate text-caption text-muted-foreground">
                {p.slug.split("/").slice(1).join("/") || p.slug} · PID {p.pid} ·{" "}
                {fmtElapsed(liveElapsedMs(p.elapsedMs, reportedAt))}
                {p.workingSetBytes != null && (
                  <> · {t("strip.procRam", { v: formatBytes(p.workingSetBytes) })}</>
                )}
                {p.cpuMs != null && (
                  <> · {t("strip.procCpu", { v: `${(p.cpuMs / 1000).toFixed(1)}s` })}</>
                )}
                {p.ioReadBytes != null && p.ioWriteBytes != null && (p.ioReadBytes > 0 || p.ioWriteBytes > 0) && (
                  <>
                    {" "}· {t("strip.procIo", {
                      read: formatBytes(p.ioReadBytes),
                      write: formatBytes(p.ioWriteBytes),
                    })}
                  </>
                )}
                {p.state === "suspended" ? t("strip.suspendedSuffix") : ""}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void setSuspended(p.pid, p.state !== "suspended")}
              title={
                p.state === "suspended"
                  ? t("strip.resumeHint")
                  : t("strip.suspendHint")
              }
              className="skin-ctl flex items-center gap-1 px-1.5 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {p.state === "suspended" ? (
                <Play className="h-3 w-3" />
              ) : (
                <Pause className="h-3 w-3" />
              )}
              {p.suspendable ? (p.state === "suspended" ? t("strip.resume") : t("strip.suspend")) : t("strip.cannotSuspend")}
            </button>
            <button
              type="button"
              onClick={() => void stopOne(p.pid)}
              disabled={!p.stoppable}
              title={p.stoppable ? t("strip.stopTitle") : t("strip.cannotStopTitle")}
              className="skin-ctl flex items-center gap-1 px-1.5 py-1 text-caption text-danger transition-colors hover:bg-danger disabled:opacity-40"
            >
              <Square className="h-3 w-3" />
              {t("strip.stop")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenSlug(p.slug);
                onClose();
              }}
              title={t("strip.openProjectPanel")}
              className="skin-ctl flex items-center gap-1 px-1.5 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              {t("strip.project")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type LinkTone = "ok" | "warn" | "info" | "muted";

/**
 * A hairline between strip segments (round 9, 需求 2).
 *
 * Replaces the `│` text character: a glyph inherits the text colour of
 * whatever it sits between and reads as content, while a 1 px rule reads as
 * structure - which is all a separator should be.
 */
function Divider() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />;
}

/**
 * A titled group inside the expanded popover: the hierarchy the flat card grid
 * lacked. Cards keep their own grid; the title says what kind of fact the group
 * holds.
 */
function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 last:mb-0">
      <h3 className="skin-label mb-1.5 flex items-center gap-1.5 px-0.5 text-caption font-medium text-muted-foreground">
        <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-primary/70" />
        {title}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

/**
 * Turns the four independent signals into one sentence.
 *
 * Ordered by how much it changes what the app should do: a hosts rewrite is
 * the only one that silently redirects traffic without the app opting in, so it
 * leads; a listening forward proxy is still a real path the downloader prefers.
 *
 * Takes the translator instead of calling the module-level `t`: this runs inside
 * the strip's render, and the `t` from `useI18n` is the one that is guaranteed to
 * be the language currently on screen.
 *
 * Honest limit, stated because it is the strip's headline: when the backend has
 * already decided the sentence (`EnvironmentReport.linkLabel`, produced by
 * `link::strip_label` in `src-tauri/src/lib.rs`), that string wins and it is
 * Chinese whatever the interface language is. This function is the pre-boot and
 * no-report path, so localising it localises the strip *until* an environment
 * report arrives. Fixing the rest means moving the label out of the Rust payload
 * (send the status, let the frontend phrase it) — a backend change, outside this
 * round's no-cargo rule and outside `StatusStrip.tsx`.
 */
function describeLink(
  env: EnvironmentReport | null,
  t: TFunc,
): { label: string; tone: LinkTone } {
  if (!env) return { label: t("link.probing"), tone: "muted" };
  if (env.mirrorEnabled) return { label: t("link.mirror"), tone: "warn" };
  if (env.hostsHijacked) {
    const who = env.hostsBy ? ` · ${env.hostsBy}` : "";
    // 需求 4：auto 模式的实际链路在每次请求时由探测决定（加速器在线则沿用，
    // 不在线则绕过），状态条如实说「自动」，不假装知道下一次的结果。
    // types.ts 联合类型被守卫阻断，见报告
    if ((env.searchRoute as string) === "auto") {
      return { label: t("link.accelAuto", { who }), tone: "info" };
    }
    // "已绕过" is only a true statement if there is a public address to bypass
    // to. An accelerator that rewrites hosts can poison public DNS as well, in
    // which case the bypass is configured but unreachable, and saying 已绕过
    // would be the same kind of technically-true misreading as 未发现 used to be.
    if (env.searchRoute !== "useHosts" && !env.resolvedIp) {
      return { label: t("link.accelUnavailable", { who }), tone: "warn" };
    }
    return env.searchRoute === "useHosts"
      ? { label: t("link.accelUseHosts", { who }), tone: "info" }
      : { label: t("link.accelBypassed", { who }), tone: "info" };
  }
  if (env.localProxy) return { label: t("link.localProxy", { addr: env.localProxy }), tone: "muted" };
  if (env.systemProxy) return { label: t("link.systemProxy", { addr: env.systemProxy }), tone: "muted" };
  if (env.resolvedIp) return { label: t("link.direct", { ip: env.resolvedIp }), tone: "ok" };
  return { label: t("link.directUnresolved"), tone: "muted" };
}
