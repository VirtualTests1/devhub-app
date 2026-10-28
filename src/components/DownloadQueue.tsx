import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pause,
  Play,
  Rocket,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { confirmDestructive } from "../lib/confirm";
import { slugFromRef } from "../lib/slug";
import { browserScheduler, createRefTicker } from "../lib/ref-ticker";
import { rowOwnsKey } from "../lib/useDismiss";
import { copyLogWithToast } from "../lib/clipboard";
import { reportError } from "../lib/report-error";
import { DownloadProgress } from "./DownloadProgress";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { countByStatus, useDownloads, type DownloadTask } from "../store/downloads";
import { QUEUE_FINISHED_CAP } from "../lib/queue-retention";
import { reg } from "../store/customize";
import { useUI } from "../store/ui";
import { useI18n } from "../lib/useI18n";

/**
 * The download queue panel.
 *
 * One `DownloadProgress` per task. The panel as a whole is registered as
 * `download-queue` so it can be hidden or moved, and each task shows its own
 * phase indicator, status line and log — which is the actual point of the
 * change: before this, a second download would have overwritten the first one's
 * progress readout.
 *
 * ## Round 9 (需求 6) — collapse and a context menu
 *
 * "下载队列缺失折叠功能。缺失右键菜单栏." Two additions:
 *
 *   - **The whole panel collapses** to a one-line summary, because a queue of
 *     six finished downloads is history, not status.
 *   - **Each task collapses to one row** (dot · ref · progress · elapsed), with
 *     running/queued tasks expanded by default and finished ones collapsed —
 *     the detail a *running* download needs is not the detail a *finished* one
 *     has left to say.
 *   - **Right-click on a task** opens the queue menu: open the landing
 *     directory, open the project, retry a failure, copy the log, remove.
 *     The row's own ✕ stays for the common case; the menu is for the rest.
 *
 * ## Round 12 (D7-3) — what the panel subscribes to
 *
 * The container used to read `s.tasks`. `applyProgress` rewrites one task object
 * several times a second, and a new array each time, so every download event
 * re-rendered the header *and* every row *and* the menu. The panel now subscribes
 * to two shallow things it genuinely renders — the ids in display order and the
 * status tally — and each row selects its own task, which is the split the
 * shared `Elapsed` ticker (`useActiveSecond`) already made for the clock.
 */
export function DownloadQueue() {
  const ids = useDownloads(useShallow((s) => s.tasks.map((t) => t.id)));
  const tally = useDownloads(useShallow((s) => countByStatus(s.tasks)));
  const clearFinished = useDownloads((s) => s.clearFinished);
  const maxParallel = useDownloads((s) => s.maxParallel);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const { t } = useI18n();

  /** Panel-level collapse. Session state: what a collapsed queue should show
   *  is answered by the summary line, so there is nothing to persist. */
  const [panelOpen, setPanelOpen] = useState(true);
  /** Per-task override of the default (running/queued = expanded). */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const toggle = useCallback(
    (id: string, next: boolean) => setExpanded((m) => ({ ...m, [id]: next })),
    [],
  );
  // The menu is anchored by id, not by a task snapshot: a frozen task is what
  // used to make its 打开项目/重新下载 items answer to a stale status.
  const openMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);

  if (ids.length === 0) return null;

  return (
    <section
      {...reg("download-queue")}
      className="skin-panel mt-3 border border-border-weak bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? t("queue.collapse") : t("queue.expand")}
          title={panelOpen ? t("queue.collapseTitle") : t("queue.expandTitle")}
          className="-ml-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          {panelOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <h2 className="skin-label text-body font-medium">{t("queue.title")}</h2>
        <span
          role="status"
          aria-live="polite"
          className="rounded-full bg-muted px-1.5 py-0.5 text-caption tabular-nums text-muted-foreground"
        >
          {t("queue.runningN", { n: tally.running })}
          {tally.queued > 0 && t("queue.queuedTail", { n: tally.queued })}
          {tally.paused > 0 && t("queue.pausedTail", { n: tally.paused })}
          {tally.failed > 0 && t("queue.failedTail", { n: tally.failed })}
        </span>
        <span className="app-desc text-caption text-muted-foreground">
          {t("queue.maxParallel", { n: maxParallel })}
        </span>
        {tally.finished >= QUEUE_FINISHED_CAP && (
          <span className="app-desc text-caption text-muted-foreground">
            {t("queue.keepHint", { n: QUEUE_FINISHED_CAP })}
          </span>
        )}
        {tally.finished > 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="ml-auto text-caption text-muted-foreground underline decoration-dotted hover:text-foreground"
          >
            {t("queue.clearFinished")}
          </button>
        )}
      </div>

      {panelOpen && (
        <div className="mt-2 space-y-3">
          {ids.map((id) => (
            <QueueRow
              key={id}
              id={id}
              forced={expanded[id]}
              onToggle={toggle}
              onMenu={openMenu}
              onOpenProject={setOpenSlug}
            />
          ))}
        </div>
      )}

      {menu && (
        <QueueMenu
          id={menu.id}
          x={menu.x}
          y={menu.y}
          hasFinished={tally.finished > 0}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

/**
 * One task's row.
 *
 * Subscribed to its own task only: `applyProgress` returns the untouched tasks
 * unchanged, so zustand's `Object.is` compare leaves every other row alone.
 */
const QueueRow = memo(function QueueRow({
  id,
  forced,
  onToggle,
  onMenu,
  onOpenProject,
}: {
  id: string;
  /** The user's override for this row; absent means "follow the status default". */
  forced?: boolean;
  onToggle: (id: string, next: boolean) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onOpenProject: (slug: string) => void;
}) {
  const task = useDownloads((s) => s.tasks.find((t) => t.id === id));
  const dismiss = useDownloads((s) => s.dismiss);
  const addTask = useDownloads((s) => s.add);
  const pause = useDownloads((s) => s.pause);
  const resume = useDownloads((s) => s.resume);
  const cancel = useDownloads((s) => s.cancel);
  const { t } = useI18n();
  if (!task) return null;

  // The canonical slug 打开项目 answers with, or null when the ref names no
  // repository (`slugFromRef`, lib/slug). A null slug disables the action with a
  // reason instead of opening a dialog that cannot load anything — which is what
  // a fabricated slug used to do.
  const slug = slugFromRef(task.ref);

  const askCancel = () => {
    if (task.status !== "running" || task.cancelRequested) return;
    void confirmDestructive(t("queue.cancelConfirm", { ref: task.ref }), {
      title: t("queue.cancelConfirmTitle"),
      okLabel: t("queue.cancelConfirmOk"),
    }).then((ok) => {
      if (ok) cancel(id);
    });
  };

  const isExpanded = forced ?? (task.status === "running" || task.status === "queued");

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={t("queue.rowAria", { ref: task.ref })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(id, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        // The row is a group of controls (the disclosure button, the context menu,
        // the dismiss), not a button — so Enter/Space are wired here to toggle the
        // disclosure, while the F10/ContextMenu key opens the menu.
        // r15-a11y-2: the same guard the settings rows got. Enter/Space on the
        // chevron or the ✕ used to bubble in here and `preventDefault()` killed
        // the button's own activation while toggling the disclosure anyway —
        // removing a task also expanded it. The key now stays with the control.
        if (rowOwnsKey(e.target, e.key)) {
          e.preventDefault();
          onToggle(id, !isExpanded);
          return;
        }
        if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(id, r.right - 8, r.bottom - 8);
      }}
      className={cn(
        "rounded-lg border border-border-weak bg-background transition-opacity",
        task.status === "queued" && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2 border-b border-dashed border-border-weak px-2.5 py-1.5">
        <StatusDot task={task} />
        <code className="min-w-0 flex-1 truncate text-caption font-medium">{task.ref}</code>
        <span className="app-desc shrink-0 text-caption text-muted-foreground">{task.source}</span>
        <Elapsed task={task} />
        {task.status === "queued" && (
          <button
            type="button"
            onClick={() => (task.paused ? resume(id) : pause(id))}
            aria-pressed={task.paused === true}
            aria-label={task.paused ? t("queue.resumeAria", { ref: task.ref }) : t("queue.pauseAria", { ref: task.ref })}
            title={task.paused ? t("queue.resume") : t("queue.pause")}
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            {task.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
        )}
        {task.status === "running" && (
          <button
            type="button"
            onClick={askCancel}
            disabled={task.cancelRequested === true}
            aria-label={t("queue.cancelAria", { ref: task.ref })}
            title={task.cancelRequested ? t("queue.cancelling") : t("queue.cancel")}
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          >
            <Square className="h-3 w-3" />
          </button>
        )}
        {/* The row itself is the disclosure: one click expands the
            detail, which is what "折叠" asks for without adding a
            second control to a row that already has five things. */}
        <button
          type="button"
          onClick={() => onToggle(id, !isExpanded)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? t("queue.collapseDetailAria", { ref: task.ref }) : t("queue.expandDetailAria", { ref: task.ref })}
          title={isExpanded ? t("queue.collapseDetail") : t("queue.expandDetail")}
          className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        {task.status !== "running" && (
          <button
            type="button"
            onClick={() => dismiss(id)}
            title={t("queue.removeThis")}
            aria-label={t("queue.removeThis")}
            className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {isExpanded && (
        <div className="px-2.5 pb-2">
          <DownloadProgress
            busy={task.status === "running"}
            progress={task.progress}
            progressAt={task.progressAt}
            stages={task.stages}
            log={task.log}
            outcome={task.outcome}
            failure={task.failure}
          />
          {task.status === "cancelled" && (
            <p role="status" className="mt-1.5 text-caption text-muted-foreground">
              {t("queue.cancelled")}
            </p>
          )}
          {task.outcome && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <QueueAction
                icon={<FolderOpen className="h-3 w-3" />}
                label={t("queue.openDir")}
                onClick={() =>
                  void invoke("open_in_explorer", { path: task.outcome?.path ?? "" }).catch((e) =>
                    reportError(e, t("dl.openDirFail")),
                  )
                }
              />
              <QueueAction
                icon={<Rocket className="h-3 w-3" />}
                label={t("queue.openProject")}
                primary
                disabled={!slug}
                title={slug ? undefined : t("queue.noSlug")}
                onClick={() => {
                  if (slug) onOpenProject(slug);
                }}
              />
            </div>
          )}
          {task.status === "failed" && (
            <div className="mt-1.5">
              <QueueAction
                icon={<RotateCcw className="h-3 w-3" />}
                label={t("queue.redownload")}
                onClick={() => addTask(task.ref, task.source, task.targetDir, task.overwrite, task.branch)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** 与进度卡的「复制日志」共用一条路径——src/lib/clipboard.ts。 */
async function copyLog(task: DownloadTask, message: string) {
  await copyLogWithToast(task.log, message);
}

/** The right-click menu for one task, subscribed to that task by id. */
function QueueMenu({
  id,
  x,
  y,
  hasFinished,
  onClose,
}: {
  id: string;
  x: number;
  y: number;
  hasFinished: boolean;
  onClose: () => void;
}) {
  const task = useDownloads((s) => s.tasks.find((t) => t.id === id));
  const clearFinished = useDownloads((s) => s.clearFinished);
  const dismiss = useDownloads((s) => s.dismiss);
  const addTask = useDownloads((s) => s.add);
  const pause = useDownloads((s) => s.pause);
  const resume = useDownloads((s) => s.resume);
  const cancel = useDownloads((s) => s.cancel);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const { t } = useI18n();
  if (!task) return null;

  const askCancel = () => {
    if (task.status !== "running" || task.cancelRequested) return;
    void confirmDestructive(t("queue.cancelConfirm", { ref: task.ref }), {
      title: t("queue.cancelConfirmTitle"),
      okLabel: t("queue.cancelConfirmOk"),
    }).then((ok) => {
      if (ok) cancel(id);
    });
  };

  // Same rule as the row's own 打开项目 button: a ref that names no repository
  // disables the item and says why, rather than opening a dialog on a slug
  // nothing can be found by.
  const slug = slugFromRef(task.ref);

  const items: MenuItem[] = [
    {
      id: "reveal",
      label: t("queue.menuReveal"),
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      disabled: !(task.outcome?.path ?? task.targetDir),
      onSelect: () => {
        const p = task.outcome?.path ?? task.targetDir;
        // 落位目录开不出来就是这一条菜单项失败了，不是细节——和进度卡上
        // 「打开目录」用同一句话（DownloadProgress.tsx）。
        if (p)
          void invoke("open_in_explorer", { path: p }).catch((e) =>
            reportError(e, t("dl.openDirFail")),
          );
      },
    },
    {
      id: "open",
      label: t("queue.openProject"),
      icon: <Rocket className="h-3.5 w-3.5" />,
      disabled: task.status !== "done" || !slug,
      note:
        task.status !== "done" ? t("queue.openAfterDone") : !slug ? t("queue.noSlug") : undefined,
      onSelect: () => {
        if (slug) setOpenSlug(slug);
      },
    },
    {
      id: "pause-or-resume",
      label: task.paused ? t("queue.resume") : t("queue.pause"),
      icon: task.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />,
      // Pausing only exists for a row that has not started; a running clone has
      // no suspend contract (see `isPausable` in the store).
      disabled: task.status !== "queued",
      note: task.status === "running" ? t("queue.pauseUnavailable") : undefined,
      onSelect: () => (task.paused ? resume(id) : pause(id)),
    },
    {
      id: "cancel",
      label: task.cancelRequested ? t("queue.cancelling") : t("queue.cancel"),
      icon: <Square className="h-3.5 w-3.5" />,
      disabled: task.status !== "running" || task.cancelRequested === true,
      note: task.status !== "running" ? t("queue.cancelUnavailable") : undefined,
      onSelect: askCancel,
    },
    {
      id: "retry",
      label: t("queue.redownload"),
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      disabled: task.status !== "failed",
      separatorBefore: true,
      onSelect: () => addTask(task.ref, task.source, task.targetDir, task.overwrite, task.branch),
    },
    {
      id: "copy-log",
      label: t("queue.menuCopy"),
      icon: <ScrollText className="h-3.5 w-3.5" />,
      onSelect: () => void copyLog(task, t("queue.copyManual")),
    },
    {
      id: "remove",
      label: t("queue.menuRemove"),
      icon: <X className="h-3.5 w-3.5" />,
      separatorBefore: true,
      // Removing a running row used to hide it while its clone kept going. The
      // row now leaves through cancel, and remove is enabled only once it has
      // settled.
      disabled: task.status === "running",
      note: task.status === "running" ? t("queue.cancelFirst") : undefined,
      onSelect: () => dismiss(id),
    },
    {
      id: "clear",
      label: t("queue.menuClear"),
      icon: <Trash2 className="h-3.5 w-3.5" />,
      disabled: !hasFinished,
      onSelect: clearFinished,
    },
  ];

  return (
    <ContextMenu items={items} x={x} y={y} onClose={onClose} label={t("queue.menuAria", { ref: task.ref })} />
  );
}

function QueueAction({
  icon,
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  /** A no-op click is a broken-looking button; a disabled one can say why. */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "skin-ctl flex items-center gap-1.5 border px-2.5 py-1 text-caption t-state active:scale-[0.98] disabled:opacity-40",
        primary
          ? "border-transparent bg-primary font-medium text-primary-foreground hover:brightness-95"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function statusWord(
  t: ReturnType<typeof useI18n>["t"],
  status: DownloadTask["status"],
  paused?: boolean,
): string {
  switch (status) {
    case "queued": return paused ? t("queue.statusPaused") : t("queue.statusQueued");
    case "running": return t("queue.statusRunning");
    case "done": return t("queue.statusDone");
    case "failed": return t("queue.statusFailed");
    case "cancelled": return t("queue.cancelled");
  }
}

function StatusDot({ task }: { task: DownloadTask }) {
  const { t } = useI18n();
  const map = {
    queued: "bg-muted-foreground",
    running: "bg-info",
    done: "bg-success",
    // 折叠行上这个点是状态的唯一信号，所以除了颜色还要有形状（空心环）与文字
    // （title/aria-label）。不引入新颜色——还是 danger，只是从实心改描边。
    failed: "border border-danger bg-transparent",
    cancelled: "border border-muted-foreground bg-transparent",
  } as const;
  const word = task.cancelRequested ? t("queue.cancelling") : statusWord(t, task.status, task.paused);
  return (
    <span role="img" aria-label={word} title={word} className="relative flex h-2 w-2 shrink-0">
      {task.status === "running" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60" />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", map[task.status])} />
    </span>
  );
}

/**
 * A single shared per-second ticker for the queue's live elapsed readouts.
 *
 * Each `Elapsed` row used to spin its own `setInterval(…, 1000)`; a queue of six
 * running downloads meant six timers all firing in lockstep, and every finished
 * row that stayed mounted kept its own timer alive. The behavior we must keep is
 * "the elapsed number ticks once a second while a task runs" (the store does NOT
 * emit per-second progress for a queued-but-not-yet-cloning task, so we still need
 * a clock). One refcounted interval serves every row: it starts when the first
 * active subscriber appears and tears down when the last leaves, and only the leaf
 * `Elapsed` components re-render on it — the queue header and the `DownloadProgress`
 * panels do not.
 *
 * The refcounted interval itself now lives in `lib/ref-ticker.ts` (r17-o2-2): the
 * same "arm on the first subscriber, clear on the last" mechanism was hand-written
 * here *and* in `store/processes.ts`, so it was enforced twice and proven nowhere.
 * The timer contract is a unit test there now; this file keeps only the React half
 * (the `active` flag and the constant snapshot an idle row reads).
 */
const secondTicker = createRefTicker(browserScheduler, 1000);

/** Re-renders the caller once a second while `active`, else never. */
function useActiveSecond(active: boolean): number {
  const subscribe = useCallback(
    (onChange: () => void) => (active ? secondTicker.subscribe(onChange) : () => {}),
    [active],
  );
  // A finished task has no live clock, so return a constant snapshot and don't
  // subscribe at all (the shared interval stops once no active row remains).
  return useSyncExternalStore(subscribe, () => (active ? secondTicker.version() : 0));
}

/** Live elapsed readout, so a stalled download is visible without hovering. */
function Elapsed({ task }: { task: DownloadTask }) {
  const { t } = useI18n();
  const running = task.status === "running" || (task.status === "queued" && !task.paused);
  // Single shared ticker replaces the old per-row setInterval. Reading `Date.now()`
  // at render is what the tick re-triggers; the store gives no per-second events
  // for a queued task, so the clock stays.
  useActiveSecond(running);
  const ms = (task.endedAt ?? Date.now()) - task.startedAt;
  const secs = Math.floor(ms / 1000);
  if (task.status === "queued") return <span className="shrink-0 text-caption text-muted-foreground">{task.paused ? t("queue.statusPaused") : t("queue.statusQueued")}</span>;
  return (
    <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
      {secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`}
    </span>
  );
}
