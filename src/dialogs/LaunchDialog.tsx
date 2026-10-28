import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CircleCheck,
  CodeXml,
  Copy,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Play,
  SquareTerminal,
  TriangleAlert,
  WandSparkles,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { messageOf } from "../lib/report-error";
import { confirmDestructive } from "../lib/confirm";
import { hasDanger, riskListText, riskText } from "../lib/launch-risk";
import { toolGuidanceFor } from "../lib/tool-install";
import { useI18n } from "../lib/useI18n";
import { DialogShell } from "../components/DialogShell";
import { RepoSyncPanel } from "../components/RepoSyncPanel";
import { RepoPortPanel } from "../components/RepoPortPanel";
import { toast } from "../components/Toast";
import { useAppearance } from "../store/appearance";
import { useCustomize, reg } from "../store/customize";
import { SplitButton } from "./launch/SplitButton";
import { RunStatus } from "./launch/RunStatus";
import { StepsEditor } from "./launch/StepsEditor";
import { DetectionEvidence } from "./launch/DetectionEvidence";
import { CleanupSection } from "./launch/CleanupSection";
import { effectiveStepsOf } from "./launch/effectiveSteps";
import { withoutKeys, withKeys, type KeyedStep } from "./launch/step-keys";
import { repoUrlOf } from "./launch/format";
import {
  type Candidate,
  type DetectionReport,
  type Environments,
  type LaunchStarted,
  type LaunchStep,
  type ProcessState,
  type ProgressEvent,
  type RepoDetail,
  type RiskHit,
  type SettingsView as Settings,
  type StepsRunReport,
  type ToolInfo,
} from "../types";

/**
 * Repository action dialog.
 *
 * Shape of this rework (from the round of reports):
 *
 *   - 一键启动 / 打开终端 / 打开 IDE / 复制路径 moved to a top action bar; the
 *     path itself opens Explorer on click, and 复制路径 sits right after it.
 *   - 打开终端 and 打开 IDE carry a dropdown of the tools actually present on
 *     the machine (auto-detected); picking one runs with it and remembers it.
 *   - 待确认 no longer forces the 自定义 → 确认 detour: clicking a detected
 *     candidate confirms it in place, and the primary button reads
 *     「确认并启动」 until a command is confirmed.
 *   - 一键启动 shows a real loading state (spinner + 阶段文案) and the run
 *     output wraps instead of scrolling sideways.
 *   - Multi-step commands: each step has a name, a command and a
 *     顺序/并行 mode; steps can be run individually or all together.
 */
export function LaunchDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<RepoDetail | null>(null);
  const [report, setReport] = useState<DetectionReport | null>(null);
  const [envs, setEnvs] = useState<Environments | null>(null);
  /**
   * The step list as edited. Carries an in-memory `uid` per row (`launch/step-keys.ts`)
   * so the editor can key rows by identity instead of position; every write that
   * leaves this component goes through `withoutKeys`.
   */
  const [steps, setSteps] = useState<KeyedStep[]>([]);
  /** One hit list per step, in step order; `[]` means no recognised risk. */
  const [stepRisks, setStepRisks] = useState<RiskHit[][]>([]);
  /** True while the deferred detection / tool-enumeration calls are in flight. */
  const [extrasLoading, setExtrasLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stepBusy, setStepBusy] = useState<number | null>(null);
  const [launchState, setLaunchState] = useState<"idle" | "busy" | "started">("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * What re-running the failed action would do, or `null`. Set alongside a
   * retryable failure so the error banner can offer 重试 the way `RepoPortPanel`
   * does, instead of leaving the user to hunt for the button that starts over.
   * Cleared whenever a fresh error (or a retry) replaces it.
   */
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [copied, setCopied] = useState(false);
  const [output, setOutput] = useState<string[]>([]);

  const [terminals, setTerminals] = useState<ToolInfo[]>([]);
  const [ides, setIdes] = useState<ToolInfo[]>([]);
  const [terminalChoice, setTerminalChoice] = useState("");
  const [ideChoice, setIdeChoice] = useState("");
  /** Per-step outcome of the last multi-step run, for the ✓/✗ badges. */
  const [stepResults, setStepResults] = useState<StepsRunReport | null>(null);
  /**
   * Live state of the processes this project launched, polled from the backend.
   *
   * The dialog used to guess "started" from the first line of output, which
   * could not distinguish a server still booting from one that died two seconds
   * later with code 1 - the reported "看不出是否执行完成". The backend now keeps
   * each child handle and reports running / exited + code + elapsed.
   */
  const [procs, setProcs] = useState<ProcessState[]>([]);
  /** The step currently running, so its row can carry a spinner. */
  const [runningStep, setRunningStep] = useState<string | null>(null);
  /**
   * 逐步确认: after each step finishes, stop and wait for a click before the
   * next one runs. Off by default — "一键启动" must stay one click.
   */
  const [stepwise, setStepwise] = useState(false);
  /** Index of the step awaiting confirmation, or null when not paused. */
  const [awaitingNext, setAwaitingNext] = useState<number | null>(null);
  const autoScroll = useAppearance((s) => s.autoScrollOutput);
  const outputRef = useRef<HTMLPreElement | null>(null);
  /**
   * Liveness guard for every async write below. Closing the panel while
   * `load`/`loadExtras`/`process_states` are still in flight used to land their
   * setState on this unmounted instance — the same race ProjectSettingsDialog
   * and SettingsView already guard with an `alive` flag; a dialog owns its flag
   * in a ref because the callbacks live outside the effect.
   */
  const aliveRef = useRef(true);
  /**
   * The 已复制 badge resets on a timer fired from a click handler, i.e. outside
   * any effect — closing the panel inside those 1.4 s left it writing setCopied
   * on a dead instance. The id lives in a ref and the unmount clears it.
   */
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const pollProcs = useCallback(async () => {
    try {
      const list = await invoke<ProcessState[]>("process_states", { slug });
      if (aliveRef.current) setProcs(list);
    } catch {
      /* a failed poll just leaves the previous state on screen */
    }
  }, [slug]);

  /**
   * Record a failure in the banner, taking the already-composed line
   * (`动词失败：后端原话`, from the dictionary) rather than a bare verb —
   * r18-o1-2 moved the wording into the tables, and a template literal with
   * `：${messageOf(e)}` in it cannot be a single-line `t("key")` call.
   * `again`, when given, makes the banner offer 重试 — reserved for actions
   * where running them again is the correct response (a launch, a step), not
   * for a load that already retried itself on reopen.
   */
  const fail = (line: string, again?: () => void) => {
    setError(line);
    setRetry(() => again ?? null);
  };

  /**
   * The two things the panel cannot render without.
   *
   * Deliberately separate from `loadExtras`: issuing all six invokes at once
   * meant the dialog had nothing to paint until the slowest one returned, which
   * is what "每次打开这个项目界面都会触发加载" looked like. The title, path and
   * command list come from these two.
   */
  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        invoke<RepoDetail>("repo_detail", { slug }),
        invoke<Settings>("get_settings"),
      ]);
      if (!aliveRef.current) return;
      setDetail(d);
      // The global choice is the floor; an override written into this repository's
      // `.devhub.json` wins, because 项目设置 exists precisely for the project that
      // does not want the machine default.
      setTerminalChoice(d.terminalChoice || s.terminalChoice);
      setIdeChoice(d.ideChoice || s.ideChoice);
      if (d.stepwise !== null) setStepwise(d.stepwise);
      setSteps(withKeys(effectiveStepsOf(d)));
    } catch (err) {
      if (aliveRef.current) fail(t("launch.loadDetailFailed", { msg: messageOf(err) }));
    }
  }, [slug, t]);

  /**
   * Detection, environments and the installed-tool lists.
   *
   * Kept off the first paint because the *first* open of a session pays for them:
   * `detect_launch_commands` opens a dozen files inside the repository, and
   * `list_ides` reads three registry hives and may shell out to PowerShell for
   * icons. The machine-wide answers are memoised in the backend - `list_ides`,
   * `list_terminals` including the `wsl -l -q` behind it, and every PATH lookup
   * behind `repo_environments` - so reopening a panel is cheap, which is the half
   * of "每次打开项目都要等一下" that deferring alone never fixed.
   */
  const loadExtras = useCallback(async () => {
    setExtrasLoading(true);
    try {
      const [r, e, terms, ids] = await Promise.all([
        invoke<DetectionReport>("detect_launch_commands", { slug }),
        invoke<Environments>("repo_environments", { slug }),
        invoke<ToolInfo[]>("list_terminals"),
        invoke<ToolInfo[]>("list_ides"),
      ]);
      if (!aliveRef.current) return;
      setReport(r);
      setEnvs(e);
      setTerminals(terms);
      setIdes(ids);
    } catch (err) {
      if (aliveRef.current) fail(t("launch.loadExtrasFailed", { msg: messageOf(err) }));
    } finally {
      // Deferred loading must announce itself: a greyed-out 打开 IDE with no
      // explanation reads as "this app cannot find my editor", which is the same
      // class of complaint as a download with no progress.
      if (aliveRef.current) setExtrasLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    // Deferred to the next macrotask so the first paint is the core data, not a
    // spinner waiting on registry reads. (Named, not `t`: `t` is the translator.)
    const extrasTimer = window.setTimeout(() => void loadExtras(), 0);
    void pollProcs();
    useCustomize.getState().recordUsage(`repo:${slug}`);
    const un = listen<ProgressEvent>("launch://progress", (ev) => {
      const { stage, message } = ev.payload;
      // Step transitions drive the UI; they are not output lines and must not
      // be dumped into the log as `label|code`.
      if (stage === "step-started") {
        setRunningStep(message);
        return;
      }
      if (stage === "step-done") {
        setRunningStep(null);
        const [label, code] = message.split("|");
        setOutput((o) => {
          const next = [
            ...o,
            code === "0"
              ? `✓ ${t("launch.stepDone", { label: label ?? "" })}`
              : `✗ ${t("launch.stepExit", { label: label ?? "", code: code ?? "" })}`,
          ];
          return next.length > 400 ? next.slice(-400) : next;
        });
        return;
      }
      setOutput((o) => {
        const next = [...o, message];
        return next.length > 400 ? next.slice(-400) : next;
      });
      // Any streamed line means the child is alive and producing output.
      setLaunchState((s) => (s === "busy" ? "started" : s));
    });
    // One second is coarse enough to be free and fine enough that "it died on
    // startup" is visible almost immediately after it happens.
    const timer = window.setInterval(() => void pollProcs(), 1000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      window.clearTimeout(extrasTimer);
      void un.then((f) => f());
    };
  }, [load, loadExtras, pollProcs, slug, t]);

  // Keep the log pinned to the newest line unless the user turned that off.
  useEffect(() => {
    if (!autoScroll) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, autoScroll]);

  const stopProcess = async (pid: number) => {
    try {
      await invoke("stop_process", { pid });
      toast.success(t("launch.stoppedPid", { pid }));
      await pollProcs();
    } catch (e) {
      toast.error(t("launch.stopFailed", { msg: messageOf(e) }));
    }
  };

  /**
   * 挂起 / 恢复. Freezes the process tree rather than ending it, so a dev server
   * keeps its port, its open sockets and its terminal.
   *
   * The backend does this through `NtSuspendProcess`, which is undocumented —
   * see `proc::nt_process_gate` for why there is no supported alternative. When
   * the call is unavailable it errors, and the error is surfaced verbatim rather
   * than shown as a state change that did not happen.
   */
  const suspendProcess = async (pid: number, suspended: boolean) => {
    try {
      await invoke("suspend_process", { pid, suspended });
      toast.success(
        suspended ? t("launch.suspendedPid", { pid }) : t("launch.resumedPid", { pid }),
      );
      await pollProcs();
    } catch (e) {
      toast.error(
        suspended
          ? t("launch.suspendFailed", { msg: messageOf(e) })
          : t("launch.resumeFailed", { msg: messageOf(e) }),
      );
    }
  };

  const confirmed = detail?.launch?.userConfirmed ?? false;
  // The uid is React's, not the marker's: comparing the draft as-is against
  // `effectiveStepsOf` would call every list dirty on every render.
  const dirtySteps = useMemo(
    () =>
      detail != null &&
      JSON.stringify(withoutKeys(steps)) !== JSON.stringify(effectiveStepsOf(detail)),
    [steps, detail],
  );

  // Live risk badges for edited commands. Debounced so typing does not fire an
  // IPC call per keystroke; the classifier itself is pure regex in Rust, but the
  // bridge is still a round trip. A failure leaves the previous empty state —
  // the launch gate re-checks synchronously before starting, so this panel can
  // never be the only place a danger is caught.
  useEffect(() => {
    const commands = steps.map((s) => s.command.trim());
    if (!commands.some(Boolean)) {
      setStepRisks([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void invoke<RiskHit[][]>("assess_launch_commands", { commands })
        .then((r) => {
          if (alive) setStepRisks(r);
        })
        .catch(() => {
          if (alive) setStepRisks([]);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [steps]);

  /** Asks once more when any step carries a danger hit. Warn-only commands run. */
  const guardRisk = async (commands: string[]): Promise<boolean> => {
    let hits: RiskHit[][];
    try {
      hits = await invoke<RiskHit[][]>("assess_launch_commands", { commands });
    } catch {
      // The gate is advisory; a failed classifier must not block a launch the
      // user already confirmed. The panel may simply be absent.
      return true;
    }
    const danger = hits.flat().filter((h) => h.severity === "danger");
    if (danger.length === 0) return true;
    return confirmDestructive(t("launch.risk.confirm", { list: riskListText(t, danger) }), {
      title: t("launch.risk.confirmTitle"),
      okLabel: t("launch.risk.confirmOk"),
    });
  };

  /** Persists the current step list. Single-step lists stay single-command. */
  const saveSteps = async (list: KeyedStep[]) => {
    try {
      await invoke("confirm_launch_steps", { slug, steps: withoutKeys(list) });
      const fresh = await invoke<RepoDetail>("repo_detail", { slug });
      if (!aliveRef.current) return;
      setDetail(fresh);
      setEditing(false);
      setStatus(t("launch.stepsSaved"));
      toast.success(t("launch.stepsSaved"));
    } catch (e) {
      fail(t("launch.saveStepsFailed", { msg: messageOf(e) }), () => void saveSteps(list));
    }
  };

  const launchAll = async () => {
    if (!(await guardRisk(steps.map((s) => s.command)))) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setOutput([]);
    setLaunchState("busy");
    setStepResults(null);
    try {
      if (!confirmed || dirtySteps) {
        await invoke("confirm_launch_steps", { slug, steps: withoutKeys(steps) });
        const fresh = await invoke<RepoDetail>("repo_detail", { slug });
        if (!aliveRef.current) return;
        setDetail(fresh);
      }
      if (stepwise && steps.length > 1) {
        setBusy(false);
        setLaunchState("started");
        await runStepwise(0);
        return;
      }
      if (steps.length > 1) {
        // `launch_steps_all` reports per-step outcome, which is what powers the
        // ✓/✗ badges. `launch_repo` cannot: it returns a single PID.
        const report = await invoke<StepsRunReport>("launch_steps_all", {
          slug,
          steps: withoutKeys(steps),
        });
        if (!aliveRef.current) return;
        setStepResults(report);
        setLaunchState(report.failed.length > 0 ? "idle" : "started");
        setStatus(
          `${t("launch.startedSteps", { n: report.started.length })}${
            report.failed.length > 0
              ? t("launch.startedStepsFailed", { n: report.failed.length })
              : ""
          }`,
        );
      } else {
        const res = await invoke<LaunchStarted>("launch_repo", { slug });
        if (!aliveRef.current) return;
        setLaunchState("started");
        setStatus(t("launch.startedPid", { pid: res.pid, command: res.command }));
      }
    } catch (e) {
      setLaunchState("idle");
      fail(t("launch.launchFailed", { msg: messageOf(e) }), () => void launchAll());
    } finally {
      // Round 13 (d5-5): the finally runs on the early returns above too, so
      // its writes need the same guard — otherwise the guard is decorative.
      if (aliveRef.current) {
        setBusy(false);
        setRunningStep(null);
      }
      // Immediately, rather than on the next tick of the poll, so the first
      // thing visible after a click is a real state. `pollProcs` guards itself.
      void pollProcs();
    }
  };

  /**
   * Runs one step, then stops and waits for a click before the next.
   *
   * "执行完" here means "this step has been started", not "this step has
   * exited": a step that launches a dev server never exits, so waiting on the
   * process would leave the sequence stuck on step one forever. What the user
   * confirms is the visible result — the process state row and the output —
   * which is the thing they said they wanted to be able to check.
   */
  const runStepwise = async (index: number) => {
    const label = steps[index]?.name || t("launch.stepLabel", { n: index + 1 });
    setStepBusy(index);
    setRunningStep(label);
    try {
      const res = await invoke<LaunchStarted>("launch_step", { slug, index });
      if (!aliveRef.current) return;
      setStatus(t("launch.stepwiseStarted", { n: index + 1, label, pid: res.pid }));
    } catch (e) {
      if (!aliveRef.current) return;
      fail(t("launch.runStepFailed", { msg: messageOf(e) }), () => void runStepwise(index));
      setStepBusy(null);
      setRunningStep(null);
      setAwaitingNext(null);
      return;
    }
    setStepBusy(null);
    setRunningStep(null);
    void pollProcs();
    if (index + 1 < steps.length) {
      setAwaitingNext(index + 1);
    } else {
      setAwaitingNext(null);
      setStatus(t("launch.allStepsDone", { n: steps.length }));
    }
  };

  const runOneStep = async (index: number) => {
    if (!(await guardRisk([steps[index]?.command ?? ""]))) return;
    setStepBusy(index);
    setError(null);
    setStatus(null);
    try {
      // Unsaved edits must not be silently ignored: save, then run.
      if (!confirmed || dirtySteps) {
        await invoke("confirm_launch_steps", { slug, steps: withoutKeys(steps) });
        const fresh = await invoke<RepoDetail>("repo_detail", { slug });
        if (!aliveRef.current) return;
        setDetail(fresh);
      }
      const res = await invoke<LaunchStarted>("launch_step", { slug, index });
      if (!aliveRef.current) return;
      setStatus(t("launch.stepStarted", { n: index + 1, pid: res.pid }));
    } catch (e) {
      if (!aliveRef.current) return;
      fail(t("launch.runStepFailed", { msg: messageOf(e) }), () => void runOneStep(index));
    } finally {
      if (aliveRef.current) setStepBusy(null);
      void pollProcs();
    }
  };

  const openTerminal = async (kind: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setTerminalChoice(kind);
    try {
      const res = await invoke<LaunchStarted>("open_terminal_with", { slug, kind });
      if (!aliveRef.current) return;
      const label = terminals.find((tool) => tool.id === kind)?.label ?? kind;
      setStatus(t("launch.openedIn", { label, pid: res.pid }));
    } catch (e) {
      if (!aliveRef.current) return;
      fail(t("launch.openTerminalFailed", { msg: messageOf(e) }), () => void openTerminal(kind));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const openIde = async (id: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setIdeChoice(id);
    try {
      const res = await invoke<LaunchStarted>("open_ide_with", { slug, id });
      if (!aliveRef.current) return;
      const label = ides.find((tool) => tool.id === id)?.label ?? id;
      setStatus(t("launch.openedVia", { label, pid: res.pid }));
    } catch (e) {
      if (!aliveRef.current) return;
      fail(t("launch.openIdeFailed", { msg: messageOf(e) }), () => void openIde(id));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const openExplorer = async () => {
    if (!detail) return;
    try {
      await invoke("open_in_explorer", { path: detail.path });
    } catch (e) {
      toast.error(t("launch.explorerFailed", { msg: messageOf(e) }));
    }
  };

  /** Clicking a detected candidate picks AND confirms it in one action. */
  const pickCandidate = async (c: Candidate) => {
    if (!(await guardRisk([c.command]))) return;
    const list: LaunchStep[] = [
      // r18-o1-2: 步骤名是持久化数据（.devhub.json 的 name 字段），不译。
      { name: "启动", command: c.command, cwd: "", parallel: false },
    ];
    // `list` itself is what goes over IPC — un-keyed on purpose; the state copy
    // gets the uid the editor rows need.
    setSteps(withKeys(list));
    try {
      await invoke("confirm_launch_steps", { slug, steps: list });
      const fresh = await invoke<RepoDetail>("repo_detail", { slug });
      if (!aliveRef.current) return;
      setDetail(fresh);
      setStatus(t("launch.confirmedCommand", { command: c.command }));
    } catch (e) {
      fail(t("launch.confirmFailed", { msg: messageOf(e) }));
    }
  };

  // r18-o1-2: 这三行 push 的标签是 toolGuidanceFor() 的查找键（数据），不译。
  const missing: string[] = [];
  if (envs) {
    if (report?.projectType === "node" && !envs.node) missing.push("Node.js");
    if (report?.projectType === "python" && !envs.python) missing.push("Python");
    if (ides.length === 0) missing.push("任意可用 IDE");
  }
  // 需求 5.1 promises the UI says not only 缺什么 but 怎么装: turn each missing
  // label into an install row (winget command + official page) and attach the
  // version the project's own detection notes declare, when they do.
  const guidance = toolGuidanceFor(missing, report?.notes ?? []);

  // Resolve the chosen tool labels once; the second `find` in the old code could
  // return undefined after `loadExtras` repopulated `terminals`/`ides` between
  // the condition check and the JSX evaluation, while the `!` would throw.
  const term = terminalChoice ? terminals.find((t) => t.id === terminalChoice) : null;
  const ide = ideChoice ? ides.find((t) => t.id === ideChoice) : null;

  return (
    <DialogShell
      title={slug}
      titleHref={repoUrlOf(slug)}
      width="lg"
      onClose={onClose}
      regId="launch-dialog"
      subheader={
        detail && (
          /* One compact row where the duplicated path line used to be: the path
             itself is the tooltip, and the affordance is the point. */
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void openExplorer()}
              title={detail.path}
              className="flex min-w-0 items-center gap-1.5 rounded-md border border-border-weak bg-background px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              {t("launch.openExplorer")}
            </button>
            <button
              {...reg("launch-action-copy-path")}
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(detail.path);
                  setCopied(true);
                  if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
                  copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
                } catch {
                  // 需求 5: a failed copy used to fail silently - the button
                  // looked pressed and nothing happened. Clipboard access is
                  // denied in some WebView2 configurations, so say so.
                  toast.error(t("launch.clipboardDenied"));
                }
              }}
              title={t("launch.copyPathTitle", { path: detail.path })}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-weak bg-background px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              {copied ? t("launch.copied") : t("launch.copyPath")}
            </button>
          </div>
        )
      }
    >
      {/* ---- top action bar ------------------------------------------------ */}
      <div {...reg("launch-action-bar")} className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          {...reg("launch-action-primary")}
          disabled={busy || stepBusy !== null || steps.length === 0}
          onClick={() => void launchAll()}
          className="skin-ctl flex items-center gap-2 bg-primary px-3.5 py-2 text-body font-medium text-primary-foreground t-state hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {launchState === "busy" ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {launchState === "busy"
            ? t("launch.launching")
            : confirmed
              ? t("launch.launchAll")
              : t("launch.confirmAndLaunch")}
        </button>

        {/* 逐步确认: run one step, stop, show its result, wait for the click.
            Orchestrated here rather than in `launch_steps_all` because the pause
            is a UI concern — the backend already has `launch_step`, and a
            long-lived "waiting for user" job on the Rust side would have to be
            cancelled correctly when this dialog closes. */}
        <label
          className="flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent"
          title={t("launch.stepwiseHint")}
        >
          <input
            type="checkbox"
            className="accent-[var(--color-primary)]"
            checked={stepwise}
            onChange={(e) => setStepwise(e.target.checked)}
          />
          {t("launch.stepwise")}
        </label>

        <span {...reg("launch-action-terminal")} className="inline-flex">
        <SplitButton
          icon={
            extrasLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <SquareTerminal className="h-4 w-4" />
            )
          }
          label={
            extrasLoading
              ? t("launch.detectingTerminals")
              : term
                ? t("launch.terminalWith", { label: term.label })
                : t("launch.openTerminal")
          }
          disabled={busy || stepBusy !== null || extrasLoading}
          loading={busy && launchState !== "busy"}
          items={terminals.map((tool) => ({ id: tool.id, label: tool.label }))}
          onPick={(id) => void openTerminal(id)}
        />
        </span>

        <span {...reg("launch-action-ide")} className="inline-flex">
        <SplitButton
          icon={
            extrasLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <CodeXml className="h-4 w-4" />
            )
          }
          label={
            extrasLoading
              ? t("launch.detectingIdes")
              : ide
                ? t("launch.openWithIde", { label: ide.label })
                : t("launch.openIde")
          }
          disabled={busy || stepBusy !== null || ides.length === 0 || extrasLoading}
          loading={busy && launchState !== "busy"}
          items={ides.map((tool) => ({
            id: tool.id,
            label: tool.label,
            icon: tool.icon,
            hint: tool.detail ? `${tool.detail}\n${tool.path ?? ""}` : tool.path,
          }))}
          onPick={(id) => void openIde(id)}
        />
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-caption leading-relaxed text-danger"
        >
          <span className="min-w-0 flex-1">{error}</span>
          {retry && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setRetry(null);
                retry();
              }}
              className="skin-ctl shrink-0 rounded px-2 py-0.5 transition-colors hover:bg-accent"
            >
              {t("launch.retry")}
            </button>
          )}
        </div>
      )}
      {status && (
        <div role="status" className="mt-2 flex items-center gap-2 rounded-lg bg-success/10 p-2 text-caption text-success">
          <CircleCheck className="h-3 w-3" />
          {status}
        </div>
      )}
      <RunStatus
        launching={launchState === "busy"}
        procs={procs}
        runningStep={runningStep}
        onStop={(pid) => void stopProcess(pid)}
        onSuspend={(pid, s) => void suspendProcess(pid, s)}
      />

      {/* ---- launch command ------------------------------------------------- */}
      <div {...reg("launch-command-panel")} className="mt-3 skin-panel border border-border-weak bg-background p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WandSparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-caption font-medium">{t("launch.commandTitle")}</span>
            {steps.length > 1 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
                {t("launch.stepCount", { n: steps.length })}
              </span>
            )}
            {confirmed ? (
              <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-caption text-success">
                <CircleCheck className="h-2.5 w-2.5" />
                {t("launch.confirmed")}
              </span>
            ) : (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-caption text-warning">
                {t("launch.pending")}
              </span>
            )}
            {dirtySteps && confirmed && (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-caption text-warning">
                {t("launch.unsaved")}
              </span>
            )}
          </div>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              {t("launch.edit")}
            </button>
          )}
        </div>

        {editing ? (
          <StepsEditor
            steps={steps}
            onChange={setSteps}
            onCancel={() => {
              if (detail) setSteps(withKeys(effectiveStepsOf(detail)));
              setEditing(false);
            }}
            onSave={() => void saveSteps(steps)}
            busy={busy}
          />
        ) : (
          <div className="mt-2 space-y-1.5">
            {steps.map((s, i) => (
              <div
                key={s.uid}
                className="flex items-center gap-2 rounded-lg border border-border-weak bg-card px-2 py-1.5"
              >
                <span className="w-5 shrink-0 text-center text-caption tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-caption font-medium">
                      {s.name || t("launch.defaultStepName")}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 text-caption",
                        s.parallel
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {s.parallel ? t("launch.parallel") : t("launch.sequential")}
                    </span>
                  </div>
                  <code
                    className="mt-0.5 block truncate text-caption text-muted-foreground"
                    title={s.command}
                  >
                    {s.command}
                  </code>
                </div>
                <button
                  type="button"
                  disabled={stepBusy !== null || busy || !s.command.trim()}
                  onClick={() => void runOneStep(i)}
                  title={t("launch.runOneHint")}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  {stepBusy === i ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  {t("launch.run")}
                </button>
              </div>
            ))}
            {awaitingNext !== null && (
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 p-2 text-caption">
                <span className="min-w-0 flex-1">
                  {t("launch.awaitingNext", { n: awaitingNext, next: awaitingNext + 1 })}
                </span>
                <button
                  type="button"
                  onClick={() => void runStepwise(awaitingNext)}
                  className="skin-ctl flex shrink-0 items-center gap-1 bg-primary px-2 py-1 font-medium text-primary-foreground t-state hover:brightness-95 active:scale-[0.98]"
                >
                  <Play className="h-3 w-3" />
                  {t("launch.runNext", { n: awaitingNext + 1 })}
                </button>
                <button
                  type="button"
                  onClick={() => setAwaitingNext(null)}
                  className="shrink-0 rounded px-2 py-1 text-muted-foreground hover:text-foreground"
                >
                  {t("launch.stopHere")}
                </button>
              </div>
            )}
            {steps.length === 0 && (
              <p className="text-caption text-muted-foreground">{t("launch.noSteps")}</p>
            )}

            {/* per-step outcome of the last run.
                The badge is looked up by LABEL — `StepsRunReport` is
                `{ started: string[]; failed: string[] }` (types.ts:301), the only
                identity the backend reports — while the row used to be keyed by
                INDEX. After a reorder those two disagree about which step a DOM
                node belongs to, so a ✓ could sit on the row whose label it never
                matched. Keyed by `uid` the node and the label travel together;
                the `i + 1` prefix stays positional because that is a display
                ordinal, not an identity. Two steps sharing one label are still
                indistinguishable — that needs a step id in the report, which is
                Rust's side. */}
            {stepResults && steps.length > 1 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {steps.map((s, i) => {
                  const label = s.name.trim() || s.command;
                  const failed = stepResults.failed.includes(label);
                  const started = stepResults.started.includes(label);
                  return (
                    <span
                      key={s.uid}
                      className={cn(
                        "flex items-center gap-1 rounded-full px-2 py-0.5 text-caption",
                        failed
                          ? "bg-danger/15 text-danger"
                          : started
                            ? "bg-success/10 text-success"
                            : "bg-muted text-muted-foreground",
                      )}
                      title={label}
                    >
                      {failed ? (
                        <X className="h-2.5 w-2.5" />
                      ) : started ? (
                        <CircleCheck className="h-2.5 w-2.5" />
                      ) : null}
                      {i + 1}. {label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {stepRisks.some((h) => h.length > 0) && (
          <div
            className={cn(
              "mt-2 rounded-lg border p-2",
              stepRisks.some(hasDanger)
                ? "border-danger/30 bg-danger/5"
                : "border-warning/30 bg-warning/5",
            )}
          >
            <div className="flex items-center gap-1.5 text-caption font-medium">
              <TriangleAlert
                className={cn(
                  "h-3 w-3 shrink-0",
                  stepRisks.some(hasDanger) ? "text-danger" : "text-warning",
                )}
              />
              {t("launch.risk.title")}
            </div>
            <ul className="mt-1 space-y-1">
              {steps.map((s, i) => {
                const hits = stepRisks[i] ?? [];
                if (hits.length === 0) return null;
                return (
                  <li key={s.uid} className="flex flex-wrap items-baseline gap-1 text-caption">
                    <code className="max-w-full truncate rounded bg-muted px-1">{s.command}</code>
                    <span
                      className={cn(
                        "rounded px-1 text-caption",
                        hasDanger(hits) ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning",
                      )}
                    >
                      {hits.map((h) => riskText(t, h.code)).join(t("launch.risk.separator"))}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-caption text-muted-foreground">{t("launch.risk.inlineHint")}</p>
          </div>
        )}

        {report && !editing && (
          <DetectionEvidence report={report} onPick={(c) => void pickCandidate(c)} />
        )}
      </div>

      {missing.length > 0 && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
            <p className="app-desc text-caption leading-relaxed text-muted-foreground">
              {t("launch.missing", { list: missing.join("、") })}
            </p>
          </div>
          <ul className="mt-2 space-y-1.5 pl-5">
            {guidance.map((g) => (
              <li key={g.name} className="app-desc text-caption leading-relaxed">
                <span className="text-foreground">{g.name}</span>
                {g.version ? (
                  <span className="text-muted-foreground">
                    {t("launch.needsVersion", { version: g.version })}
                  </span>
                ) : null}
                <span className="text-muted-foreground"> · </span>
                <code className="rounded bg-muted px-1 py-0.5 select-all">{g.how}</code>
                {g.url ? (
                  <button
                    type="button"
                    className="ml-2 text-primary underline-offset-2 hover:underline"
                    onClick={() => void openUrl(g.url as string)}
                  >
                    {t("launch.openHomepage")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {output.length > 0 && (
        <details {...reg("launch-output-details")} className="mt-3" open>
          <summary className="cursor-pointer text-caption text-muted-foreground">
            {t("launch.outputTitle", { n: output.length })}
          </summary>
          <pre
            ref={outputRef}
            className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-caption leading-relaxed text-muted-foreground"
          >
            {output.join("\n")}
          </pre>
        </details>
      )}

      <RepoSyncPanel slug={slug} detail={detail} onChanged={() => void load()} />

      {/* Round 11 (需求 8.9): the ports this repository reserved, and whether
          anything answers on them. Live only while a process is alive - a
          stopped project's "已监听" is a lie about the past. */}
      <RepoPortPanel
        slug={slug}
        active={
          launchState === "busy" ||
          procs.some((p) => p.state === "running" || p.state === "suspended")
        }
      />

      <CleanupSection slug={slug} onDeleted={onClose} />
    </DialogShell>
  );
}
