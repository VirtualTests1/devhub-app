import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DownloadOutcome, ProgressEvent, SettingsView as SettingsPayload } from "../types";
import { toast } from "../store/toast";
import { boundQueueTasks } from "../lib/queue-retention";
import { messageOf, swallow } from "../lib/report-error";
import { t } from "../lib/i18n";
import {
  captureRecovered,
  takeRecovered,
  writeRecovered,
} from "../lib/download-recovery";

/**
 * The download queue.
 *
 * ## Why concurrent downloads were blocked in the frontend
 *
 * `download_repo` already built a fresh `Downloader` per call and ran it on
 * `spawn_blocking`, so the backend could clone two repositories at the same
 * time on day one. What it could not do was *report* two at a time: there was
 * one `downloadBusy` boolean and one each of `log` / `stages` / `outcome`, all
 * owned by `App.tsx`, so a second download would have overwritten the first
 * one's progress and the UI would have shown one merged, meaningless stream.
 *
 * So the fix is a store keyed by task, plus a `task` id on every progress
 * event. `maxParallel` is a setting (设置 → 网络 → 同时下载数) that the store
 * now reads itself when it initialises — see `capReady` — and the queue holds
 * the rest rather than failing them, because "点第二个开始下载，第一个就断了"
 * is worse than waiting.
 *
 * ## Order: newest first on screen, first-come first-served in the scheduler
 *
 * Round 9 (需求 9): "发现很多需要排序处的功能实现都是从上到下依次排序的，但
 * 应当是最新的显示在最上方". The array is therefore kept newest-first - a new
 * task is unshifted - so every consumer that renders `tasks` in order shows
 * the latest download on top without remembering to reverse. The scheduler
 * ([`pump`]) walks the array backwards, so a freed slot still goes to the
 * task that has waited longest: display order and service order are different
 * questions and only one of them is about recency.
 */

export type DownloadTask = {
  id: string;
  ref: string;
  source: string;
  /** One-off landing-directory override from the add view's 高级选项. */
  targetDir?: string;
  /**
   * Re-download over an occupied landing directory (round 11, 需求 8.7).
   * Set only by the add view's 高级选项 checkbox - the one place the user can
   * see what they are replacing before the queue runs.
   */
  overwrite?: boolean;
  /**
   * Branch the user asked for (r27-N1). Empty/undefined = the remote default.
   * Kept on the row so a retry re-downloads the same code, not the default branch.
   */
  branch?: string;
  startedAt: number;
  endedAt?: number;
  log: string[];
  /** Distinct stages reached, in order, for the phase indicator. */
  stages: string[];
  progress: ProgressEvent | null;
  /** Arrival time of the last progress event; ETA keys off it, not render time. */
  progressAt?: number;
  /** A row recovered after restart: failed, with no logs from the lost session. */
  interrupted?: boolean;
  outcome: DownloadOutcome | null;
  failure: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /**
   * The user asked to stop this running download. It stays true until the
   * backend settles (successfully or as `cancelled`); the row shows 取消中…
   * so a slow tree kill is visible rather than looking like a dead button.
   */
  cancelRequested?: boolean;
  /**
   * A queued task the user is holding back. `pump` skips it and the backend is
   * never asked to clone it. Only meaningful while `status === "queued"`: a
   * running clone cannot be suspended — the backend has no such control, and
   * killing it would leave a half-written landing directory.
   */
  paused?: boolean;
  /** Bytes/sec-ish text taken from git's own progress line. */
  lastLine: string;
};

type State = {
  tasks: DownloadTask[];
  maxParallel: number;
  /**
   * How many downloads have *succeeded*, ever. Monotonic — see `finish`.
   *
   * `App.tsx` refreshes the wall off this number. It cannot use
   * `tasks.filter(status === "done").length`, because that count also goes DOWN
   * when a row is dismissed or 清除已完成 runs, and the effect could not tell a
   * completed download from tidying up the list: clearing the queue re-ran a whole
   * `list_repositories` (r15-correct-6).
   */
  doneSeq: number;
  add: (
    ref: string,
    source: string,
    targetDir?: string,
    overwrite?: boolean,
    branch?: string,
  ) => void;
  applyProgress: (ev: ProgressEvent & { task?: string }) => void;
  finish: (id: string, outcome: DownloadOutcome | null, failure: string | null) => void;
  /** Hold a queued row back from the scheduler. A running row is not pausable. */
  pause: (id: string) => void;
  /** Release a held row; `pump` gets a fresh chance to start it immediately. */
  resume: (id: string) => void;
  /** Stop a running clone. The backend kills the tree and removes the partial dir. */
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
  /** Re-queue every failed row; returns how many were reset. */
  retryFailed: () => number;
  clearFinished: () => void;
  setMaxParallel: (n: number) => void;
};

/**
 * How much of a log is kept when it grows past the cap.
 *
 * The old rule was `slice(-300)`: whatever fell off the front was gone, and what
 * falls off the front of a download log is the parse stage and the fallback plan
 * — the two lines that explain *why* the download chose the path it did, and
 * therefore the first thing anyone asks for when it fails. Keeping both ends and
 * saying how much is missing in between costs nothing and loses nothing that
 * matters.
 */
const LOG_HEAD = 150;
const LOG_TAIL = 150;

/**
 * Wall-clock time for one log line: `16:04:12.318`.
 *
 * Not a duration, and deliberately not `fmtElapsed`: these two helpers together
 * are one machine-readable log line (`16:04:12.318 +12.4s [stage] msg`), where
 * the fixed-width decimal seconds are what make a slow layer measurable. Folding
 * it into the human 已运行 chip wording would cost that precision.
 */
function clockOf(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** `+12.4s` since this task started running, so a slow layer is visible. */
function elapsedOf(startedAt: number, at: number): string {
  return `+${Math.max(0, (at - startedAt) / 1000).toFixed(1)}s`;
}

function appendLog(log: string[], line: string): string[] {
  const next = [...log, line];
  const max = LOG_HEAD + LOG_TAIL + 1;
  if (next.length <= max) return next;
  const omitted = next.length - max;
  return [
    ...next.slice(0, LOG_HEAD),
    `……（中间 ${omitted + 1} 行已省略）……`,
    ...next.slice(next.length - LOG_TAIL),
  ];
}

/**
 * The array in *service* order — longest-waiting first.
 *
 * `tasks` is kept newest-first for the screen (需求 9), which means the tail of
 * the array is the head of the queue. Both consumers that care about who is
 * actually running now read through this one function:
 *
 *   - `pump` walks it to hand a freed slot to the task that asked first;
 *   - `applyProgress` takes its first `running` entry as the owner of an
 *     untagged `download://progress` event.
 *
 * Those two used to disagree (r15-correct-3): the router used `find`, i.e. the
 * **newest** running task, while the scheduler deliberately served the **oldest**.
 * With a concurrent queue that is not a cosmetic split — the event carries no
 * `task` id on an older backend or during bootstrap, so one download's log lines
 * and progress bar painted onto another download's card, and the one that looked
 * stalled was the one whose output had been silently donated to its neighbour.
 * Deriving both answers from one ordering is the fix; a comment on the other
 * side of the file would have rotted.
 */
export function inServiceOrder(tasks: readonly DownloadTask[]): readonly DownloadTask[] {
  return [...tasks].reverse();
}

/** Which task an untagged progress event belongs to: the one `pump` started first. */
export function untaggedProgressTarget(
  tasks: readonly DownloadTask[],
): DownloadTask | undefined {
  return inServiceOrder(tasks).find((t) => t.status === "running");
}

/**
 * Whether the user may hold this row back.
 *
 * Only a queued row: the clone itself has not started, so pausing is just a
 * scheduling decision. A running clone is a child process writing to a landing
 * directory; the queue has no suspend/resume contract with it, and killing it to
 * "pause" would leave a partial directory behind.
 */
export function isPausable(task: Pick<DownloadTask, "status">): boolean {
  return task.status === "queued";
}

/**
 * The tasks `pump` should start now, in service order (longest-waiting first).
 *
 * Pure so the "paused rows are invisible to the scheduler" rule is testable
 * without invoking a single clone. `slots` is what is left after the running
 * count; paused rows are skipped rather than removed, so resuming one does not
 * change its place in the queue.
 */
export function startableTasks(
  tasks: readonly DownloadTask[],
  slots: number,
): DownloadTask[] {
  const limit = Number.isFinite(slots) ? Math.max(0, Math.floor(slots)) : 0;
  const out: DownloadTask[] = [];
  for (const task of inServiceOrder(tasks)) {
    if (out.length >= limit) break;
    if (task.status !== "queued" || task.paused) continue;
    out.push(task);
  }
  return out;
}

let seq = 0;
const nextId = () => `dl-${Date.now().toString(36)}-${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// The parallel cap is a setting, not a constant (r15-correct-2)
// ---------------------------------------------------------------------------

/**
 * What the store falls back to when 设置 cannot be read.
 *
 * The value used to be the store's only source of truth: `maxParallel: 3` was
 * hard-coded and the real setting (`parallelDownloads`, 设置 → 网络 → 同时下载数)
 * only ever reached the queue indirectly, through a `maxParallel` field on a
 * `download://progress` payload — i.e. *after* a download was already running.
 * So a cold start ran three concurrent clones for a user who had set one, and
 * `DownloadQueue`'s header printed 3 next to a queue that the user had capped
 * at 1. The backend has been reporting the configured number all along
 * (`lib.rs:999` reads `parallel_downloads`); the frontend just never asked.
 */
const DEFAULT_MAX_PARALLEL = 3;

/** Bounds of 同时下载数 — mirrors the input's `min`/`max` in 设置. */
const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 6;

/**
 * How long a first enqueue waits for 设置 before the default takes over.
 *
 * Waiting is what makes the fix real — pumping before the answer lands is just
 * the old hard-coded 3 with extra steps. But the queue must not deadlock behind
 * a wedged settings read either, so the wait is bounded and the fallback is the
 * same number the store has always shipped.
 */
const CAP_WAIT_MS = 1_500;

/** Coerce anything to a usable cap, falling back to the shipped default. */
export function clampMaxParallel(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_PARALLEL;
  return Math.max(MAX_PARALLEL_MIN, Math.min(MAX_PARALLEL_MAX, Math.round(raw)));
}

/** Pull 并行下载数 out of a settings payload without trusting its shape. */
export function parallelFromSettings(raw: unknown): number {
  if (!raw || typeof raw !== "object") return DEFAULT_MAX_PARALLEL;
  return clampMaxParallel((raw as { parallelDownloads?: unknown }).parallelDownloads);
}

let capPromise: Promise<void> | null = null;

function loadCap(): Promise<void> {
  capPromise = (async () => {
    try {
      const s = await invoke<SettingsPayload>("get_settings");
      useDownloads.getState().setMaxParallel(parallelFromSettings(s));
    } catch (e) {
      // Deliberate drop with a reason: the queue still has a usable cap (the
      // default), so a settings read failure must not stall a download.
      capPromise = null;
      swallow(e, "读取并行下载数失败，队列按默认上限继续，进度事件仍会纠正");
    }
  })();
  return capPromise;
}

/**
 * Resolves once the cap is known — or once `CAP_WAIT_MS` has passed.
 *
 * Idempotent: one read per app lifetime, and every later caller gets the
 * already-settled promise back (plus a microtask), so only the first enqueue
 * of a session ever actually waits.
 */
export function capReady(): Promise<void> {
  if (!capPromise) void loadCap();
  if (!capPromise) return Promise.resolve();
  const settled = capPromise;
  return new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, CAP_WAIT_MS);
    settled.then(finish, finish);
  });
}

/** Rows from a previous run, shown as failed so the retry path is the normal one. */
function recoveredTasks(): DownloadTask[] {
  return takeRecovered().map((row, i) => ({
    id: `recovered-${row.id}-${i}`,
    ref: row.ref,
    source: row.source,
    targetDir: row.targetDir,
    overwrite: row.overwrite,
    branch: row.branch,
    startedAt: row.startedAt,
    endedAt: row.startedAt,
    log: [t("queue.interruptedLog")],
    stages: [],
    progress: null,
    outcome: null,
    failure: t("queue.interrupted"),
    status: "failed" as const,
    lastLine: "",
    interrupted: true,
  }));
}

/** Capture the in-flight set after every mutation that can change it. */
function persistRecovery(tasks: readonly DownloadTask[]): void {
  writeRecovered(captureRecovered(tasks));
}

export const useDownloads = create<State>((set, get) => ({
  tasks: recoveredTasks(),
  maxParallel: DEFAULT_MAX_PARALLEL,
  doneSeq: 0,

  add: (ref, source, targetDir, overwrite, branch) => {
    const trimmed = ref.trim();
    if (!trimmed) return;
    // The same repository twice in one queue is never intentional. A confirmed
    // overwrite is the one exception that looks identical on the surface, so it
    // is allowed through rather than being mistaken for a double click.
    if (
      !overwrite &&
      get().tasks.some((t) => t.ref === trimmed && t.status !== "done" && t.status !== "failed")
    ) {
      toast.error(`${trimmed} 已在下载队列里`);
      return;
    }
    const task: DownloadTask = {
      id: nextId(),
      ref: trimmed,
      source,
      targetDir: targetDir?.trim() || undefined,
      overwrite: overwrite || undefined,
      branch: branch?.trim() || undefined,
      startedAt: Date.now(),
      log: [`${clockOf(new Date())} +0.0s [queue] 开始下载 ${trimmed}`],
      stages: [],
      progress: null,
      outcome: null,
      failure: null,
      status: "queued",
      lastLine: "",
    };
    // Newest first (需求 9): the queue reads top-to-bottom as a timeline with
    // now at the top, which is how every other list in the app reads.
    // Finished rows are history; cap them so a long session cannot retain every
    // log it ever produced. The task being added is active, so it is never the
    // row dropped. The in-flight set is persisted right after, for restart recovery.
    set((s) => ({ tasks: boundQueueTasks([task, ...s.tasks]) }));
    persistRecovery(get().tasks);
    // Pump only once the cap is known, otherwise the first download of a session
    // is scheduled against `DEFAULT_MAX_PARALLEL` and a user who set 同时下载数
    // to 1 gets three concurrent clones (r15-correct-2).
    void capReady().then(() => pump());
  },

  applyProgress: (ev) => {
    const id = ev.task;
    set((s) => {
      // Determine which task(s) this event belongs to.
      // Tagged events (from the current backend) match by id or ref.
      // Untagged events (from an older backend or bootstrap) go to the single
      // task the scheduler started *first* — see `untaggedProgressTarget`, which
      // is the same end of the array `pump` serves from. Matching all running
      // tasks would pollute every concurrent download's progress with another
      // task's data, and matching the newest one mislabels which is which.
      let targetId: string | null = null;
      if (id) {
        const tagged = s.tasks.find((t) => t.id === id || t.ref === id);
        if (tagged) targetId = tagged.id;
      } else {
        const serving = untaggedProgressTarget(s.tasks);
        if (serving) targetId = serving.id;
      }
      if (!targetId) return s;
      return {
        tasks: s.tasks.map((t) => {
          if (t.id !== targetId) return t;
          const at = Date.now();
          const isProgressLine = ev.stage.endsWith("-progress");
          if (isProgressLine) {
            return { ...t, progress: ev, lastLine: ev.message, progressAt: at };
          }
          const line = `${clockOf(new Date(at))} ${elapsedOf(t.startedAt, at)} [${ev.stage}] ${ev.message}`;
          const landing = ev.stage === "landing" && !t.targetDir ? ev.message.trim() : undefined;
          return {
            ...t,
            progress: ev,
            targetDir: landing || t.targetDir,
            stages: t.stages.includes(ev.stage) ? t.stages : [...t.stages, ev.stage].slice(-12),
            log: appendLog(t.log, line),
          };
        }),
      };
    });
  },

  finish: (id, outcome, failure) => {
    set((s) => {
      const target = s.tasks.find((t) => t.id === id);
      // Already accounted for. `pump` attaches exactly one `.then`/`.catch` per
      // task, so this is belt-and-braces against a duplicate settle, and
      // `doneSeq` must say how many downloads finished — not how many times
      // something touched a finished row.
      if (!target || target.status === "done" || target.status === "failed" || target.status === "cancelled") {
        return s;
      }
      // The backend reports a cancellation as an error string; the store already
      // knows it asked for one, so it does not have to parse that string. A race
      // where the clone finished before the kill landed keeps the success: the
      // data is on disk and calling it cancelled would be a lie.
      const cancelled = Boolean(target.cancelRequested) && Boolean(failure);
      const tasks = s.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              status: cancelled
                ? ("cancelled" as const)
                : failure
                  ? ("failed" as const)
                  : ("done" as const),
              outcome,
              failure: cancelled ? null : failure,
              endedAt: Date.now(),
              cancelRequested: false,
            }
          : t,
      );
      // Only a success moved a directory onto the disk, so only a success is
      // something the wall has to re-read. `keep` is this id: an old queued task
      // can finish after the cap filled up, and the row that just changed state
      // must not vanish in the same paint that announces it.
      return {
        tasks: boundQueueTasks(tasks, { keep: id }),
        doneSeq: failure ? s.doneSeq : s.doneSeq + 1,
      };
    });
    persistRecovery(get().tasks);
    pump();
  },

  // Tidy-up only. Neither of these changes what is on disk, and neither touches
  // `doneSeq`, which is what 墙 keys its refresh on — that is precisely the
  // distinction the old count-based effect got wrong.
  dismiss: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    persistRecovery(get().tasks);
  },

  pause: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || !isPausable(task) || task.paused) return;
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, paused: true } : t)),
    }));
    // A paused row is explicitly *not* in flight: captureRecovered skips it, so
    // quitting now must not resurrect it as "interrupted" on the next start.
    persistRecovery(get().tasks);
  },

  resume: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || !task.paused || task.status !== "queued") return;
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, paused: false } : t)),
    }));
    persistRecovery(get().tasks);
    pump();
  },

  cancel: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.status !== "running" || task.cancelRequested) return;
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, cancelRequested: true } : t)),
    }));
    void invoke<boolean>("cancel_download", { task: id })
      .then((accepted) => {
        if (accepted) return;
        // The worker already settled and removed its registry entry. Its own
        // finish() owns the row; just clear the transient flag.
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, cancelRequested: false } : t)),
        }));
      })
      .catch((e) => {
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, cancelRequested: false } : t)),
        }));
        toast.error(t("queue.cancelFailed", { ref: task.ref, msg: messageOf(e) }));
      });
  },

  retryFailed: () => {
    const failed = get().tasks.filter((t) => t.status === "failed");
    if (failed.length === 0) return 0;
    const stamp = t("queue.retryLog");
    set((s) => ({
      tasks: s.tasks.map((task) =>
        task.status === "failed"
          ? {
              ...task,
              status: "queued" as const,
              failure: null,
              outcome: null,
              endedAt: undefined,
              startedAt: Date.now(),
              cancelRequested: false,
              interrupted: false,
              progress: null,
              stages: [],
              lastLine: "",
              log: [...task.log, `${clockOf(new Date())} +0.0s [queue] ${stamp}`].slice(-(LOG_HEAD + LOG_TAIL + 1)),
            }
          : task,
      ),
    }));
    persistRecovery(get().tasks);
    pump();
    return failed.length;
  },

  clearFinished: () => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === "running" || t.status === "queued") }));
    persistRecovery(get().tasks);
  },

  setMaxParallel: (n) => {
    const next = clampMaxParallel(n);
    if (get().maxParallel === next) return;
    set({ maxParallel: next });
    pump();
  },
}));

/**
 * Starts as many queued downloads as the parallel limit allows.
 *
 * Called after every enqueue and every finish, which is the whole scheduler —
 * no timer, no polling. A task that has left `queued` is never picked up twice
 * because the status flips to `running` synchronously before the await.
 *
 * The walk is **backwards** on purpose: the array is newest-first for display
 * (需求 9), but a freed slot belongs to the task that has waited longest, not
 * to the one that arrived last. `inServiceOrder` is the same helper the progress
 * router uses, so the two cannot drift apart again.
 */
function pump() {
  const s = useDownloads.getState();
  const running = s.tasks.filter((t) => t.status === "running").length;
  const picks = startableTasks(s.tasks, s.maxParallel - running);
  for (const pick of picks) {
    useDownloads.setState((st) => ({
      tasks: st.tasks.map((x) =>
        x.id === pick.id ? { ...x, status: "running" as const, startedAt: Date.now() } : x,
      ),
    }));
    void invoke<DownloadOutcome>("download_repo", {
      input: pick.ref,
      source: pick.source,
      task: pick.id,
      targetDir: pick.targetDir ?? null,
      overwrite: pick.overwrite ?? false,
      branch: pick.branch ?? null,
    })
      .then((res) => {
        useDownloads.getState().finish(pick.id, res, null);
        toast.success(t("queue.doneToast", { ref: pick.ref }));
      })
      .catch((e) => {
        const wasCancelled =
          useDownloads.getState().tasks.find((x) => x.id === pick.id)?.cancelRequested;
        useDownloads.getState().finish(pick.id, null, messageOf(e));
        if (wasCancelled) toast.info(t("queue.cancelledToast", { ref: pick.ref }));
        else toast.error(t("queue.failedToast", { ref: pick.ref }));
      });
  }
}

/** Subscribes once. Returns the unlisten. */
export function watchDownloads(): () => void {
  let disposed = false;
  // Warm the cap while the app is still idle, so the first click of 下载 does not
  // pay for the settings read at all (see `capReady`).
  void capReady();
  const un = listen<ProgressEvent & { task?: string }>("download://progress", (ev) => {
    if (disposed) return;
    const max = (ev.payload as { maxParallel?: number }).maxParallel;
    if (typeof max === "number" && max > 0) {
      const st = useDownloads.getState();
      if (st.maxParallel !== max) st.setMaxParallel(max);
    }
    useDownloads.getState().applyProgress(ev.payload);
  });
  // `listen` is async: the returned promise rejects if the webview is already
  // torn down or the event name is unknown. Without this handler the rejection
  // is unhandled — the old `void un.then((f) => f())` only covered the resolve
  // path.
  un.catch(() => {});
  return () => {
    disposed = true;
    void un.then((f) => f(), () => {});
  };
}

/** What the queue header shows, and what 清除已完成 is enabled by. */
export type DownloadTally = {
  running: number;
  queued: number;
  /** Queued rows the user is holding back — a subset of `queued`, not a status. */
  paused: number;
  failed: number;
  /** `done` + `failed` — exactly the rows `clearFinished` removes. */
  finished: number;
};

/**
 * The queue's status tally, in one pass.
 *
 * Exported pure so a subscriber can take it instead of the array: `applyProgress`
 * fires several times a second, and `DownloadQueue` used to subscribe to `tasks`
 * to compute these four numbers, which re-rendered every row on every event.
 * All four fields are numbers, so a shallow-compared subscriber re-renders only
 * when a count actually moves — the same rule `StatusStrip`'s segment follows.
 */
export function countByStatus(tasks: readonly DownloadTask[]): DownloadTally {
  let running = 0;
  let queued = 0;
  let paused = 0;
  let failed = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.status === "running") running += 1;
    else if (t.status === "queued") {
      queued += 1;
      if (t.paused) paused += 1;
    } else if (t.status === "failed") failed += 1;
    else done += 1;
  }
  return { running, queued, paused, failed, finished: done + failed };
}

// A normal close kills the spawned trees (the Rust exit hook does that); the rows
// must be captured before the webview disappears. `pagehide` covers the close
// path WebView2 uses in practice, `beforeunload` the other one.
if (typeof window !== "undefined") {
  const flushRecovery = () => persistRecovery(useDownloads.getState().tasks);
  window.addEventListener("beforeunload", flushRecovery);
  window.addEventListener("pagehide", flushRecovery);
}
