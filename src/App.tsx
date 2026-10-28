import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { AppShell } from "./shell/AppShell";
import { CustomizeLayer } from "./customize/CustomizeLayer";
import { ProjectsView } from "./views/ProjectsView";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { t } from "./lib/i18n";
import { makeDeepLinkCloneHandler, makeDeepLinkOpenHandler } from "./lib/deeplink-client";
import { registerShortcuts } from "./lib/shortcuts";
import { useTaskbarProgress } from "./lib/use-taskbar-progress";
import { ToastHost, toast } from "./components/Toast";
import { useUI } from "./store/ui";
import { reg } from "./store/customize";
import { useDownloads, watchDownloads } from "./store/downloads";
import { subscribeProcessUpdates } from "./store/processes";
import { useMeta } from "./store/meta";
import { slugOf } from "./lib/slug";
import { createReloadGate, registerWatchRoots, watchRepoChanged } from "./lib/repo-watch";
import type {
  EnvironmentReport,
  GitBootstrapStatus,
  RefPreview,
  RepoRef,
  SettingsSave,
  SettingsView as SettingsPayload,
} from "./types";
import { buildSettingsPayload } from "./lib/settings-payload";
import { messageOf, reportError, swallow } from "./lib/report-error";
import { useCompletionAttention } from "./lib/use-completion-attention";

/*
 * Code-split the four non-default views (round-11 D6).
 *
 * 项目 is the landing view and the app's core, so it stays in the eager chunk:
 * making it lazy would put a network/disk hop between cold start and the first
 * paint of the one screen every launch shows — the split would cost the default
 * view and buy nothing. The other four are only reached by navigating, so
 * splitting them keeps their weight (and their heavy leaf deps — the add view's
 * GitHub search block, the settings catalog, the records filter) out of the
 * first-load chunk and pulls each on demand.
 *
 * `AppShell` already wraps `children` in the `.app-view-enter` container (keyed
 * per view, so the enter animation replays on navigation), and every stylesheet
 * rule is in the single static `index.css` in the document head — a lazily
 * arriving JS chunk carries no styles of its own. So a Suspense boundary here
 * can never flash *unstyled* content: the fallback below and the resolved view
 * are both painted by the same CSS that is already loaded. The fallback is a
 * styled skeleton that matches the page shape, so the boundary reads as a load,
 * not a layout jump.
 */
const AddRepoView = lazy(() =>
  import("./views/AddRepoView").then((m) => ({ default: m.AddRepoView })),
);
const SettingsView = lazy(() =>
  import("./views/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const RecordsView = lazy(() =>
  import("./views/RecordsView").then((m) => ({ default: m.RecordsView })),
);
const FrequentView = lazy(() =>
  import("./views/FrequentView").then((m) => ({ default: m.FrequentView })),
);

/*
 * Heavy dialogs also lazy-loaded (O1: 对话框级分包).
 *
 * LaunchDialog / BootstrapDialog / NetworkDiagnoseDialog 都不在首屏渲染路径上：
 * LaunchDialog 只在点击磁贴时打开，BootstrapDialog 只在缺 Git 时打开，
 * NetworkDiagnoseDialog 只在点击诊断入口时打开。它们各自携带着启动步骤编辑器、
 * 网络诊断规则等重型子组件，懒加载让主入口 chunk 不用承担它们的重量。
 *
 * 与视图分包同理：CSS 全在 index.css 里，Suspense fallback 不会出现样式闪烁。
 */
const LaunchDialog = lazy(() =>
  import("./dialogs/LaunchDialog").then((m) => ({ default: m.LaunchDialog })),
);
const BootstrapDialog = lazy(() =>
  import("./dialogs/BootstrapDialog").then((m) => ({ default: m.BootstrapDialog })),
);
const NetworkDiagnoseDialog = lazy(() =>
  import("./dialogs/NetworkDiagnoseDialog").then((m) => ({ default: m.NetworkDiagnoseDialog })),
);

/**
 * Which saved settings the environment probe actually reports on. The strip's
 * link line, proxy and mirror/IP-pin facts all come out of `environment`, so a
 * change to any of them has to re-probe; nothing else does.
 *
 * Module scope on purpose: it used to sit inside `App`, so the identity changed
 * every render and the auto-probe effect had to leave it out of its deps (the one
 * lint finding this file carried). A constant list has no business being rebuilt
 * per render in the first place.
 */
const PROBE_KEYS = [
  "projectRoot",
  "mirrorEnabled",
  "ipPinEnabled",
  "proxy",
  "searchRoute",
  "downloadRoute",
] as const;

/**
 * Suspense fallback: the same panel + `animate-pulse` skeleton language the
 * project wall already uses for its own loading state, sized to a generic page
 * (a header bar over a stack of rows). Kept deliberately plain so it is styled by
 * the loaded CSS with no component-level branching.
 */
function ViewSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="h-6 w-24 animate-pulse rounded-md bg-muted/50" />
        <span className="h-4 w-40 animate-pulse rounded-md bg-muted/30" />
      </div>
      <div className="skin-panel space-y-2 border border-border-weak bg-card p-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />
        ))}
      </div>
    </div>
  );
}


// Read from package.json rather than hard-coding: the version used to live in
// three places (package.json, tauri.conf.json, and a constant here) and drifted -
// the sidebar still reported 0.1.0 after the version had been bumped to 0.2.0.
//
// A named import (`import { version } from "../package.json"`) is deliberate:
// the old default-import form (`import pkg from "../package.json"`) made the
// bundler pull in the entire file — devDependencies, scripts, the lot — because
// it could not prove which fields were read. A named import lets Vite's
// tree-shaker keep only `version`, which is all this component needs.
import { version as APP_VERSION } from "../package.json";

/** How long an environment probe is worth reusing before asking again. */
const ENV_TTL_MS = 20_000;

/**
 * Adaptive TTL: when the network is unstable (consecutive failures), back off
 * and probe less often. When it is stable, probe more often so the status strip
 * stays fresh.
 */
const ENV_TTL_BACKOFF_MS = 60_000;
const ENV_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Composition root.
 *
 * This component owns *data* and nothing else: loading, refreshing, and holding
 * async results. Presentation lives in `shell/` (layout) and `views/` (one per
 * sidebar entry). Data commands that touch the network run on a worker thread in
 * Rust, so none of this blocks the UI.
 *
 * Round 3 took the download state out of here and into `store/downloads.ts`. It
 * was eleven `useState` slots for one download; a queue needs them keyed by task,
 * and a component is the wrong place for that.
 */
export default function App() {
  useCompletionAttention();
  const [env, setEnv] = useState<EnvironmentReport | null>(null);
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitBootstrapStatus | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootBusy, setBootBusy] = useState(false);
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const openSlug = useUI((s) => s.openSlug);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const netDiagOpen = useUI((s) => s.netDiagOpen);
  const setNetDiagOpen = useUI((s) => s.setNetDiagOpen);
  const addDownload = useDownloads((s) => s.add);
  const downloadBusy = useDownloads((s) =>
    s.tasks.some((t) => t.status === "running" || t.status === "queued"),
  );
  // One taskbar indicator for the whole queue, mounted at the root so switching
  // pages does not stop the bar from following a download.
  useTaskbarProgress();

  // O4 N4: 全局快捷键注册——Ctrl+1~5 切视图，Ctrl+, 设置。
  // 在 App 根组件 mount 时一次性注册，随组件卸载自动清理。
  useEffect(() => {
    return registerShortcuts([
      ["ctrl+1", () => setView("projects")],
      ["ctrl+2", () => setView("add")],
      ["ctrl+3", () => setView("records")],
      ["ctrl+4", () => setView("frequent")],
      ["ctrl+5", () => setView("settings")],
      ["ctrl+comma", () => setView("settings")],
    ]);
  }, [setView]);

  /**
   * Guard against a stale refresh overwriting a newer save.
   *
   * Reported bug: "项目目录更改之后没有生效，刷新之后又回归默认了". Part of it was the
   * settings view clobbering edits (fixed there), but there is also a real race:
   * a refresh issued just before a save can land *after* it and push the old
   * value back into state. Bumping this counter on every successful save lets a
   * refresh that started earlier drop its now-outdated settings payload.
   */
  const settingsSeq = useRef(0);

  /**
   * The same guard for the wall (r15-correct-5).
   *
   * `settingsSeq` only ever protected settings, but `setRepos` is written by four
   * refresh paths — the download-done effect, the startup clean-up, a root change
   * from `persistSettings`, and closing the launch dialog — and each list arrives
   * whenever its own `list_repositories` settles. An unforced read answered from
   * the backend index is fast; a forced re-walk of the container is slow. So the
   * fast-but-older list could land *after* the slow-but-newer one and put a stale
   * array into state — the freshly downloaded tile disappearing again.
   *
   * Last-started wins: a path stamps this ref before it awaits and only its own
   * newest stamp may write the list (or report its failure). Mirrors the settings
   * guard above rather than inventing a second shape.
   */
  const reposSeq = useRef(0);

  const settingsRef = useRef<SettingsPayload | null>(null);
  settingsRef.current = settings;

  /**
   * The wall, on its own.
   *
   * It used to be fetched *together with* the environment probe and await both,
   * so the tiles could not paint until DNS and eight TCP probes had finished -
   * the "打开软件要等一下才能看到项目" report. `force` re-reads the disk past the
   * backend's index, which is what the 刷新 button means.
   */
  const refreshWall = useCallback(async (force = false) => {
    const seq = ++reposSeq.current;
    try {
      const r = await invoke<RepoRef[]>("list_repositories", { force });
      // Superseded by a later walk: an older list must not land on top of a
      // newer one and drop the tile that just appeared.
      if (seq === reposSeq.current) setRepos(r);
      // Metadata after the wall, never with it: the walk behind it is
      // I/O-bound and the tiles must not wait for it (round 9, 需求 1).
      void useMeta.getState().load(force);
    } catch (err) {
      if (seq === reposSeq.current) setGateError(t("app.gate.reposFailed", { msg: messageOf(err) }));
    } finally {
      // First resolution (success or failure) ends the first-paint loading
      // state; before this the wall must not show the empty-state CTA.
      setReposLoaded(true);
    }
  }, []);

  /**
   * The environment snapshot, decoupled and rate-limited.
   *
   * Nothing in the wall depends on it, and it is the one command whose cost is
   * bounded by the network rather than by the disk.
   *
   * Adaptive TTL: consecutive failures back off to ENV_TTL_BACKOFF_MS to
   * avoid hammering an already-broken network. A single success resets the
   * counter.
   */
  // r18-R1: hand the wall's directories to the change detector, and reload when the
  // backend says one of them was written to. Two effects on purpose: the registration
  // list follows `repos`, while the subscription only needs a stable reload action and
  // must not be torn down every time the wall re-renders.
  useEffect(() => {
    const roots = repos
      .filter((r) => typeof r.path === "string" && r.path.length > 0)
      .map((r) => ({ slug: `${r.owner}/${r.repo}`, path: r.path as string }));
    if (roots.length === 0) return;
    void registerWatchRoots(roots).catch((e) => swallow(e, "watch registration failed; the wall still refreshes on demand"));
  }, [repos]);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    // The gate exists because a reload outlasts the next notification: without folding,
    // three batches during one `npm install` become three full walks in a row.
    const gate = createReloadGate(() => refreshWall(true));
    void watchRepoChanged(() => {
      gate.request();
    })
      .then((f) => {
        if (live) unlisten = f;
        else f();
      })
      .catch((e) => swallow(e, "repo://changed subscription failed; the wall still refreshes on demand"));
    return () => {
      live = false;
      unlisten?.();
    };
  }, [refreshWall]);

  const envAt = useRef(0);
  const envInFlight = useRef<Promise<void> | null>(null);
  const envFailures = useRef(0);
  const refreshEnv = useCallback((force = false) => {
    const ttl = envFailures.current >= ENV_MAX_CONSECUTIVE_FAILURES
      ? ENV_TTL_BACKOFF_MS
      : ENV_TTL_MS;
    if (!force && Date.now() - envAt.current < ttl) return Promise.resolve();
    if (envInFlight.current) return envInFlight.current;
    envAt.current = Date.now();
    const run = (async () => {
      try {
        setEnv(await invoke<EnvironmentReport>("environment"));
        envFailures.current = 0;
      } catch (err) {
        envFailures.current += 1;
        setGateError(t("app.gate.envFailed", { msg: messageOf(err) }));
      } finally {
        envInFlight.current = null;
      }
    })();
    envInFlight.current = run;
    return run;
  }, []);

  /**
   * A settings save can change what the environment probe is supposed to report, and
   * nothing used to re-probe after a save - the strip kept naming the old link.
   *
   * Keyed on those fields' *values*, twice removed from the noise: reacting to the
   * state object changing identity would force a probe on every wall refresh (the
   * coupling the TTL exists to break), and reacting to every settings change would
   * force one per autosave now that 设置 saves as you type.
   */
  const probeSig = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    const s = settings;
    const sig = PROBE_KEYS.map((k) => `${k}=${JSON.stringify(s[k])}`).join("|");
    const previous = probeSig.current;
    probeSig.current = sig;
    // The first value is the initial load, which already probes.
    if (previous === null || previous === sig) return;
    void refreshEnv(true);
  }, [settings, refreshEnv]);

  /**
   * Keeps the wall in step with the download queue.
   *
   * A finished download has added a directory by the time its task says `done`,
   * and without this the new tile only appears after a manual 刷新 - which is
   * exactly the "下载完了但看不出发生了什么" complaint the queue was meant to
   * answer.
   *
   * Keyed on the store's monotonic `doneSeq`, not on the length of the finished
   * rows (r15-correct-6). The old selector counted `status === "done"` entries, so
   * the number also went *down* when a row was dismissed or 清除已完成 was pressed,
   * and the effect could not tell "a download finished" from "I tidied the list":
   * clearing the queue re-ran a whole `list_repositories`. `doneSeq` only moves
   * when something actually completed, and a failure does not move it at all,
   * because a failed download put nothing on disk.
   *
   * Debounced: parallel downloads may finish within milliseconds of each other,
   * and without debounce each finish triggers a separate wall refresh.
   */
  const downloadsDone = useDownloads((s) => s.doneSeq);
  const seenDone = useRef(0);
  useEffect(() => {
    if (downloadsDone <= seenDone.current) return;
    seenDone.current = downloadsDone;
    const timer = window.setTimeout(() => void refreshWall(), 300);
    return () => window.clearTimeout(timer);
  }, [downloadsDone, refreshWall]);

  const refresh = useCallback(
    async (opts?: { announce?: boolean; force?: boolean }) => {
      setRefreshing(true);
      const seq = settingsSeq.current;
      const wallSeq = ++reposSeq.current;
      const before = repos.length;
      // Started, not awaited. The strip fills in whenever the probe finishes;
      // making the wall wait for a DNS query is what this function used to do.
      // The TTL decides whether the probe runs at all - this call used to force it,
      // which made every wall refresh pay a fresh DNS round trip two seconds after
      // the last one. Callers that *know* the answer changed force it themselves
      // (the settings effect below, and the Git bootstrap).
      void refreshEnv();
      try {
        const [r, g, s] = await Promise.all([
          // Only an explicit 刷新 re-walks the container. At startup the point of
          // the on-disk index is precisely that the walk does *not* run, so
          // forcing it here would throw the cold-start win away.
          invoke<RepoRef[]>("list_repositories", { force: opts?.force ?? false }),
          invoke<GitBootstrapStatus>("git_bootstrap_status"),
          invoke<SettingsPayload>("get_settings"),
        ]);
        if (wallSeq === reposSeq.current) setRepos(r);
        setGitStatus(g);
        if (settingsSeq.current === seq) setSettings(s);
        // Only an explicit 刷新 recomputes sizes: the backend cache answers a
        // plain ask from memory, and a background poll must not re-walk.
        void useMeta.getState().load(opts?.force ?? false);
        // "刷新之后没有提示": a spinner that vanishes is indistinguishable from a
        // refresh that found nothing. Say what came back, including "nothing
        // changed", which is itself the answer people are looking for.
        if (opts?.announce) {
          const delta = r.length - before;
          if (delta === 0) toast.success(t("refresh.nochange", { n: r.length }));
          else toast.success(t("refresh.changed", { before, after: r.length }));
        }
      } catch (err) {
        setGateError(`${t("refresh.failed")}：${messageOf(err)}`);
        if (opts?.announce) toast.error(t("refresh.failed"));
      } finally {
        setRefreshing(false);
      }
    },
    [repos.length, refreshEnv],
  );

  useEffect(() => {
    void refresh();
    // The scheduled clean-up runs on the backend at startup. It deletes
    // directories, so the wall has to be re-read once it is done - otherwise a
    // retention pass leaves tiles pointing at paths that no longer exist until
    // the next manual refresh.
    // r27-O1: older builds left a GitHub PAT in each private clone's
    // `.git/config` because it was part of the clone URL. New clones use a
    // per-invocation header; this one-time background pass rewrites the old
    // origins and reports the count, so the user learns about a credential
    // that has been sitting on disk.
    void invoke<number>("scrub_stored_credentials")
      .then((n) => {
        if (n > 0) toast.info(t("app.credentialsScrubbed", { n }));
      })
      .catch((e) =>
        swallow(e, "legacy credential scrub failed; startup continues and the next launch retries"),
      );
    void invoke<number>("run_due_cleanup")
      .then((n) => {
        // Unforced: a clean-up removes directories, and the container stamps
        // notice that on their own. Forcing here would walk twice.
        if (n > 0) void refreshWall();
      })
      .catch((e) =>
        // Round 13 (d4-4): a bare `catch (() => undefined)` here was the one
        // call site in the app that ignored the `lib/report-error.ts` rule —
        // a deliberate drop must carry its reason. This one is deliberate:
        // the startup retention pass is background work, its failure blocks
        // neither the first paint nor the wall, and it runs again next start.
        swallow(e, "scheduled cleanup failed; startup continues and the wall re-reads on the next refresh"),
      );
    const unDownload = watchDownloads();
    const unProcesses = subscribeProcessUpdates();
    const unBoot = listen<{ stage: string; message: string }>(
      "git-bootstrap://progress",
      (ev) => {
        setBootLog((l) => [...l, ev.payload.message].slice(-300));
      },
    );
    return () => {
      unDownload();
      unProcesses();
      void unBoot.then((f) => f());
    };
    // Intended to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The live process poll moved to `store/processes.ts`: `App` no longer holds
  // `live`, so a two-second tick re-renders the composition root zero times. The
  // components that need it (`AppShell`, `StatusStrip`, `ProjectsView`) subscribe
  // to the store directly and only for the slice they render.

  const persistSettings = async (value: Record<string, unknown>) => {
    let res: SettingsSave;
    try {
      res = await invoke<SettingsSave>("save_settings", { value });
    } catch (err) {
      // This was a silent-failure path: the three switches that save through here
      // (镜像、IP 钉死、输入停顿) are read back out of `settings`, so a rejected
      // write left the toggle in its old position and said nothing — the user saw
      // a switch that flipped back on its own, with no reason. Not rethrowing on
      // purpose: every caller here is a `void` event handler that has no better
      // reaction available, and a rejected promise nobody catches is console noise
      // rather than a fix. Anything that must branch on the outcome should call
      // `invoke("save_settings")` itself, the way 设置 does with its own save state.
      reportError(err, t("app.settings.unsaved"));
      return null;
    }
    settingsSeq.current += 1;
    setSettings(res.settings);
    if (res.rootChanged) void refreshWall();
    return res;
  };

  /**
   * Saves one slice of the settings without the caller knowing the full save
   * shape. Built from the *current* settings snapshot every time, so a save
   * issued from the add view (e.g. 输入停顿) cannot reset fields it never saw.
   *
   * Reads from `settingsRef` rather than the `settings` closure variable: a
   * save issued right after a settings change would otherwise capture the
   * pre-change value and silently revert the user's edit.
   */
  const persistSettingsPatch = (overrides: Record<string, unknown>) => {
    return persistSettings(buildSettingsPayload(settingsRef.current, overrides));
  };

  /**
   * Pre-flight before a download enters the queue (round 9, 需求 6).
   *
   * "在下载时应当有校验逻辑，而不是点击下载之后，进入到下载过程中才校验" -
   * a malformed ref or an occupied landing directory used to enter the queue
   * and fail a minute later, inside a task that looked healthy while it ran.
   * The checks here are the ones the backend makes at the start of
   * `download_repo`, run at click time through `preview_ref`, which computes
   * the exact path the downloader will use:
   *
   *   - the ref parses at all;
   *   - the landing directory is free - `exists` on the preview is the
   *     backend's own `is_occupied`, i.e. precisely the case
   *     `download_repo` would refuse with 目录已存在.
   *
   * The duplicate-in-queue check stays in the store, which owns the queue.
   * All of this is local - no network round trip - so the click still feels
   * instant.
   */
  /**
   * Pre-flight before a download enters the queue (round 9, 需求 6).
   *
   * "在下载时应当有校验逻辑，而不是点击下载之后，进入到下载过程中才校验" -
   * a malformed ref or an occupied landing directory used to enter the queue
   * and fail a minute later, inside a task that looked healthy while it ran.
   * The checks here are the ones the backend makes at the start of
   * `download_repo`, run at click time through `preview_ref`, which computes
   * the exact path the downloader will use:
   *
   *   - the ref parses at all;
   *   - the landing directory is free - `exists` on the preview is the
   *     backend's own `is_occupied`, i.e. precisely the case
   *     `download_repo` would refuse with 目录已存在.
   *
   * The duplicate-in-queue check stays in the store, which owns the queue.
   * All of this is local - no network round trip - so the click still feels
   * instant.
   *
   * `overwrite` (round 11, 需求 8.7) is the one case an occupied directory is
   * allowed through: the add view's 高级选项 checkbox is where the user says
   * "replace it", so the pre-flight steps aside for exactly that. Without the
   * flag the toast now names the way out instead of dead-ending.
   */
  const preflight = useCallback(async (
    ref: string,
    targetDir?: string,
    overwrite?: boolean,
  ): Promise<boolean> => {
    const term = ref.trim();
    if (!term) return false;
    const ready = env?.git != null;
    if (!ready && env != null) {
      toast.error(t("git.required"));
      return false;
    }
    try {
      const p = await invoke<RefPreview>("preview_ref", {
        input: term,
        targetDir: targetDir?.trim() || null,
      });
      if (p.exists && !overwrite) {
        toast.error(
          t("download.occupied", { path: p.target }),
        );
        return false;
      }
      return true;
    } catch (err) {
      reportError(err, t("app.download.startFailed"));
      return false;
    }
  }, [env]);

  const startDownload = useCallback(async (
    ref: string,
    source: string,
    targetDir?: string,
    overwrite?: boolean,
    branch?: string,
  ) => {
    if (await preflight(ref, targetDir, overwrite))
      addDownload(ref, source, targetDir, overwrite, branch);
  }, [preflight, addDownload]);

  // N3: Deep Link 监听——放在 startDownload 声明之后避免 TDZ。
  //
  // r21 N3-2：处理器与 payload 校验搬进 lib/deeplink-client.ts（纯模块，Node 里
  // 用假事件钉住整条链），这里只注入三件事。监听这一行**故意留在原地**：
  // check-events.mjs 只认调用点上的字面量，挪进助手函数会让 deeplink://clone
  // 从事件配对表里消失（该文件 :43-54 记着这条）。
  useEffect(() => {
    const onIgnore = (payload: string) => toast.error(t("deeplink.ignored", { payload }));
    const onClone = makeDeepLinkCloneHandler({
      startDownload: (ref, source) => void startDownload(ref, source),
      onCloning: (repo) => toast.info(t("deeplink.cloning", { repo })),
      onIgnored: onIgnore,
    });
    const onOpen = makeDeepLinkOpenHandler({
      open: (repo) => {
        // 现取清单而不是读 React 状态：链接可能刚到达、墙还没刷新，
        // 以磁盘上的仓库为准才不会把“刚加的仓库”误判成不存在。
        void invoke<RepoRef[]>("list_repositories", { force: false })
          .then((list) => {
            const known = list.find((r) => `${r.owner}/${r.repo}` === repo);
            if (!known) {
              // open 只打开已有项目；本地没有时明确说该先添加，不偷偷开始下载。
              toast.error(t("deeplink.openMissing", { repo }));
              setView("add");
              return;
            }
            setView("projects");
            setOpenSlug(slugOf(known));
          })
          .catch((e) => toast.error(messageOf(e)));
      },
      onIgnored: onIgnore,
    });
    const unlistenClone = listen<string>("deeplink://clone", onClone);
    const unlistenOpen = listen<string>("deeplink://open", onOpen);
    return () => {
      void unlistenClone.then((fn) => fn());
      void unlistenOpen.then((fn) => fn());
    };
  }, [startDownload, setView, setOpenSlug]);

  const runBootstrap = async () => {
    setShowBootstrap(true);
    setBootBusy(true);
    setBootError(null);
    setBootLog([t("app.git.installing")]);
    try {
      await invoke("ensure_git");
      // The probe is what decides `gitReady`, and git has just changed, so this one
      // path forces it instead of waiting out the TTL. The wall itself is re-read
      // unforced: installing git does not add or remove a repository directory, and a
      // forced walk here would be a full scan for nothing.
      void refreshEnv(true);
      await refresh();
    } catch (e) {
      setBootError(messageOf(e));
    } finally {
      setBootBusy(false);
    }
  };

  const gitReady = env?.git != null;
  const missingGit = env != null && !gitReady;

  return (
    <CustomizeLayer>
      {/* O1: 三个重型对话框懒加载——Suspense fallback 是一个内联 div，
          只展示「正在加载」文字，保持视觉轻量。CSS 已在 index.css 中，
          不会出现无样式闪烁。*/}
        <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 text-caption text-muted-foreground">{t("app.loading")}</div>}>
        {showBootstrap && (
          <BootstrapDialog
            log={bootLog}
            busy={bootBusy}
            error={bootError}
            onClose={() => setShowBootstrap(false)}
          />
        )}
        {openSlug && (
          // Keyed by slug on purpose: `launch://progress` carries no slug in its
          // payload (the Rust side emits only stage/message), so without the key a
          // A→B switch reused one mounted instance — A's still-streaming output
          // landed in B's panel and output/stepResults never reset. The key makes
          // each project its own instance. The one path that pays for it (switching
          // projects from the palette over an open dialog) loses A's leave
          // transition, which `useSelfClosing` already documents as correct for a
          // parent-driven unmount; the normal close path is untouched because
          // openSlug only clears after the exit has played.
          <LaunchDialog
            key={openSlug}
            slug={openSlug}
            onClose={() => {
              setOpenSlug(null);
              // Only the wall can have changed while the dialog was open, and the
              // environment probe is the slow part of a full refresh — it is what
              // made closing the panel feel like the whole app reloaded.
              void refreshWall();
            }}
          />
        )}

        {netDiagOpen && (
          // Not keyed and not tied to a slug: one instance, one subject (this
          // machine's link), unlike LaunchDialog whose A→B switch needed the key.
          // The dialog probes with `force` on open and on 重新诊断 — see its
          // header — so opening it never shows a cached link state.
          <NetworkDiagnoseDialog onClose={() => setNetDiagOpen(false)} />
        )}
      </Suspense>

      <ToastHost />

      <AppShell
        env={env}
        gitStatus={gitStatus}
        repoCount={repos.length}
        version={APP_VERSION}
        refreshing={refreshing}
        onRefresh={() => void refresh({ announce: true, force: true })}
      >
        {/* Git is a hard requirement for downloading, so this is a gate, not a
            notification: it stays on screen until resolved. */}
        {missingGit && (
          <div
            {...reg("git-missing-gate")}
            className="mb-3 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-warning">{t("app.git.missing")}</p>
              <p className="app-desc mt-0.5 text-caption leading-relaxed text-muted-foreground">
                {t("app.git.requiredLead")}
                <strong className="text-foreground">{t("app.git.noAdmin")}</strong>
                {t("app.git.requiredTail")}
              </p>
              <button
                type="button"
                onClick={() => void runBootstrap()}
                className="skin-ctl mt-1.5 bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground t-state hover:brightness-95 active:scale-[0.98]"
              >
                {t("app.git.autoInstall")}
              </button>
            </div>
          </div>
        )}

        {gateError && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-2.5 text-caption text-danger"
          >
            <span className="min-w-0 flex-1">{gateError}</span>
            <button
              type="button"
              onClick={() => setGateError(null)}
              aria-label={t("app.dismissError")}
              className="shrink-0 rounded p-0.5 text-danger/60 transition-colors hover:bg-danger/10 hover:text-danger"
              title={t("app.dismiss")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {view === "projects" && (
          <ViewErrorBoundary label={t("errorboundary.labels.projects")}>
            <ProjectsView
              repos={repos}
              reposLoaded={reposLoaded}
              onDownload={startDownload}
              onWallChanged={() => void refreshWall()}
              downloadBusy={downloadBusy}
              downloadDisabledReason={!gitReady && env != null ? t("git.required") : null}
            />
          </ViewErrorBoundary>
        )}

        {/* The four navigated-to views are lazily loaded; this single boundary
            covers them all. 项目 above is eager, so the default screen never
            waits on it. The fallback is styled by the already-loaded CSS, so the
            boundary is a graceful load rather than an unstyled flash. */}
        <Suspense fallback={<ViewSkeleton label={t("app.viewLoading")} />}>
          {view === "add" && (
            <ViewErrorBoundary label={t("errorboundary.labels.add")}>
              <AddRepoView
                onDownload={startDownload}
                settings={settings}
                mirrorEnabled={settings?.mirrorEnabled ?? false}
                ipPinEnabled={settings?.ipPinEnabled ?? true}
                onToggleMirror={(v) =>
                  void persistSettingsPatch({ mirrorEnabled: v })
                }
                onToggleIpPin={(v) =>
                  void persistSettingsPatch({ ipPinEnabled: v })
                }
                onSaveDebounce={(ms) =>
                  void persistSettingsPatch({ searchDebounceMs: ms })
                }
                gitReady={gitReady}
                repos={repos}
              />
            </ViewErrorBoundary>
          )}

          {view === "records" && (
            <ViewErrorBoundary label={t("errorboundary.labels.records")}>
              <RecordsView onWallChanged={() => void refreshWall()} />
            </ViewErrorBoundary>
          )}

          {view === "frequent" && (
            <ViewErrorBoundary label={t("errorboundary.labels.frequent")}>
              <FrequentView repos={repos} />
            </ViewErrorBoundary>
          )}

          {/* 外观 has no route of its own any more (round 9, 需求 10): it is a
              settings catalog page, reached through the sidebar's 设置 entry. */}
          {view === "settings" && (
            <ViewErrorBoundary label={t("errorboundary.labels.settings")}>
              <SettingsView
                settings={settings}
                repos={repos}
                onSaved={(r) => {
                  settingsSeq.current += 1;
                  setSettings(r.settings);
                  // The wall is listing directories derived from the root, so a root
                  // change is only visible once it is re-read.
                  if (r.rootChanged) void refreshWall();
                }}
              />
            </ViewErrorBoundary>
          )}
        </Suspense>
      </AppShell>
    </CustomizeLayer>
  );
}
