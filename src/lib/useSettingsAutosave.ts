import { useEffect, useRef, useState } from "react";

/**
 * The low-level settings writer a view owns. It touches the store, the error
 * banner and the toasts; this hook owns only *when* it runs, not what it does.
 */
export type SettingsSaveFn = (
  overrides?: Record<string, unknown>,
  opts?: { silent?: boolean },
) => Promise<unknown>;

export type SettingsAutosave = {
  /** 开关 / 选择类：一次点击是一个完整意图，立即写。 */
  saveNow: (patch?: Record<string, unknown>) => Promise<void>;
  /** 文本类：防抖 800ms；失焦 / 回车用 commitSoon 立即提交。 */
  saveSoon: (patch?: Record<string, unknown>) => void;
  /** 取消防抖计时并立即提交（失焦 / 回车）。 */
  commitSoon: () => void;
  /** 丢弃尚未落盘的队列值（外部载荷覆盖本地待写值时用）。 */
  discardPending: () => void;
  /** 是否有一个防抖写入在等待。头部唯一需要展示的自动保存状态。 */
  queued: boolean;
};

/** Coalescing window for 文本类 fields. */
const DEBOUNCE_MS = 800;

export type AutosaveEngineOptions = {
  /**
   * Resolved at *flush* time, never captured at construction.
   *
   * This is the whole r15-correct-1 fix. `SettingsView`'s `save` is a plain
   * `async` function declared in the component body (`SettingsView.tsx:323`), so
   * it is a brand-new function object on every render. As long as the scheduler
   * held the function itself — or a `useCallback` built from it — every keystroke
   * (setX → re-render → new `save`) produced a new `flush`, which tore down the
   * effect that depended on it (`clearTimeout(timerRef); void flush()`), which
   * flushed the pending patch immediately. The 800 ms window therefore never
   * opened at all: one `save_settings` invoke per character, and the coalescing
   * the module exists for was dead in production while reading as correct.
   *
   * Taking a getter means the engine has no captured identity to be invalidated
   * by, so the timer survives identity churn by construction rather than by
   * remembering to add another `useCallback` dependency in the right place.
   */
  getSave: () => SettingsSaveFn;
  /** Injected so the debounce window is testable without a `window`. */
  schedule: (cb: () => void, ms: number) => number;
  unschedule: (id: number) => void;
  /** Reports the 已排队 state the header shows. Optional: an engine can run headless. */
  onQueuedChange?: (queued: boolean) => void;
  /** Overridable for tests; production uses `DEBOUNCE_MS`. */
  debounceMs?: number;
};

export type AutosaveEngine = {
  saveNow: (patch?: Record<string, unknown>) => Promise<void>;
  saveSoon: (patch?: Record<string, unknown>) => void;
  commitSoon: () => void;
  discardPending: () => void;
  /** Cancels any pending timer and submits what is queued (unmount path). */
  dispose: () => void;
  /** Whether a debounced write is waiting. */
  isQueued: () => boolean;
};

/**
 * The debounce / coalesce engine, with no React in it.
 *
 * 文本类字段逐字符触发 onChange，若每次都直接保存，一个镜像地址会被写成二十几次，
 * 还会在后端排队二十几次全量校验。`pending` 存的是**下一次提交时要用的值**而不
 * 是一个布尔——React 状态更新是异步的，800ms 后调用方（onChange 回调）拿到的是旧闭包，
 * 所以必须由调度器自己持有一份。
 *
 * 同时只允许一个保存在进行：连点两个开关时，第二次不能等第一次的响应（期间用户
 * 可能又改了别的），而是排在后面合并成一次。`saving` 是这个"单飞"守卫——它必须
 * 在发起 await 前置 true、finally 里置 false；只置 false 不置 true 会让守卫永远为
 * 假、并发写入互相覆盖（这正是抽离前内联版本的 bug）。
 *
 * 卸载时若还有一个防抖写入在排队，`dispose` 会立即 flush 它，避免切走页面丢一次
 * 改动。flush 是 fire-and-forget：save 只碰后端与 store，不碰本组件状态。
 */
export function createAutosaveEngine(opts: AutosaveEngineOptions): AutosaveEngine {
  const { getSave, schedule, unschedule, onQueuedChange } = opts;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

  let pending: Record<string, unknown> | null = null;
  let timer: number | null = null;
  let saving = false;
  let rerun = false;
  let queued = false;

  const setQueued = (next: boolean) => {
    if (queued === next) return;
    queued = next;
    onQueuedChange?.(next);
  };

  const cancelTimer = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
  };

  const flush = async (): Promise<void> => {
    if (saving) {
      // A save is in flight. Remember that more arrived; it runs right after.
      rerun = true;
      return;
    }
    const patch = pending;
    if (!patch) return;
    pending = null;
    saving = true;
    // d7-4: on rejection the patch goes BACK into the queue instead of
    // vanishing with the pre-await clear — the old flow dropped the user's
    // edit silently (stale settings, no retry) the moment save() rejected.
    // The error itself is not this hook's to show: `save` owns the error
    // banner and toasts (see SettingsView). No immediate retry on failure,
    // or a down backend becomes an infinite flush loop; the value retries on
    // the next saveNow / commitSoon / fresh debounce. `rerun` keeps its
    // meaning: an edit that arrived while this save was in flight is a new
    // intent, not a retry of the failed one.
    let failed = false;
    try {
      await getSave()(patch, { silent: true });
    } catch {
      failed = true;
      pending = { ...patch, ...(pending ?? {}) };
    } finally {
      saving = false;
      setQueued(pending !== null);
    }
    if (rerun || (!failed && pending)) {
      rerun = false;
      void flush();
    }
  };

  return {
    saveNow: (patch = {}) => {
      pending = { ...(pending ?? {}), ...patch };
      cancelTimer();
      return flush();
    },

    saveSoon: (patch = {}) => {
      pending = { ...(pending ?? {}), ...patch };
      setQueued(true);
      // One trailing timer for the whole burst: a second `saveSoon` replaces the
      // deadline instead of arming another writer.
      cancelTimer();
      timer = schedule(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },

    commitSoon: () => {
      cancelTimer();
      void flush();
    },

    discardPending: () => {
      cancelTimer();
      pending = null;
      setQueued(false);
    },

    dispose: () => {
      cancelTimer();
      void flush();
    },

    isQueued: () => queued,
  };
}

/** Real timers. Only reached from the hook, which only ever runs in the webview;
 *  the Node tests drive `createAutosaveEngine` with an injected clock instead. */
function scheduleReal(cb: () => void, ms: number): number {
  return window.setTimeout(cb, ms);
}

function unscheduleReal(id: number): void {
  window.clearTimeout(id);
}

/**
 * The hook 设置 mounts. All the scheduling policy lives in `createAutosaveEngine`,
 * which is what lets the coalescing be tested where `.tsx` components cannot be.
 */
export function useSettingsAutosave(save: SettingsSaveFn): SettingsAutosave {
  /**
   * Evergreen slot for the caller's writer. Written during render, read at flush
   * time, so a `save` recreated by a re-render is picked up without the engine
   * ever seeing it as a change of its own dependencies.
   */
  const saveRef = useRef(save);
  saveRef.current = save;

  const engineRef = useRef<AutosaveEngine | null>(null);
  const [queued, setQueued] = useState(false);

  if (engineRef.current === null) {
    engineRef.current = createAutosaveEngine({
      getSave: () => saveRef.current,
      schedule: scheduleReal,
      unschedule: unscheduleReal,
      onQueuedChange: setQueued,
    });
  }

  // Empty deps, and that is the point: this cleanup is the *unmount* flush. It
  // used to depend on `flush`, which depended on `save`, so it re-ran on every
  // re-render and flushed the debounced write on every keystroke.
  useEffect(() => {
    const engine = engineRef.current;
    return () => engine?.dispose();
  }, []);

  const engine = engineRef.current;
  return {
    saveNow: engine.saveNow,
    saveSoon: engine.saveSoon,
    commitSoon: engine.commitSoon,
    discardPending: engine.discardPending,
    queued,
  };
}
