import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CircleCheck,
  Download,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  Tag,
  TriangleAlert,
} from "lucide-react";
import { toast } from "./Toast";
import { fmtRelative } from "../lib/format";
import { messageOf } from "../lib/report-error";
import { openHttpUrl } from "../lib/external-url";
import { useI18n } from "../lib/useI18n";
import {
  LAYER_LABEL,
  type Freshness,
  type InstallPlan,
  type LaunchStarted,
  type LaunchStep,
  type ReleaseInfo,
  type RepoDetail,
  type UpdateOutcome,
} from "../types";

/**
 * One repository's "it is already on disk" actions: 更新仓库 (需求 8.1),
 * 新鲜度 (需求 8.2) and 装依赖 (需求 8.4).
 *
 * Why a component rather than more code in the dialogs: all three ask a question of
 * a clone that exists, all three are network-or-process calls with a busy state, and
 * the 启动面板 / 项目设置 / 项目墙 all have a legitimate claim to show them. One
 * owner for the wording and the failure text is the difference between "更新只有三条
 * 链路" being said consistently and being said in one place and contradicted in two.
 *
 * The promises this file keeps:
 *   - **更新 is three roads, not four.** The mirror layer rewrites the *clone URL*,
 *     and a pull has no URL to rewrite - `origin` is what the clone recorded. Saying
 *     四层回退 here would be a claim the code does not support.
 *   - **An unknown freshness is never "已是最新".** `state: "unknown"` gets its own
 *     text and its own reason; a badge that lies about being current is worse than no
 *     badge, because the user cancels the update they needed.
 *   - **装依赖 is a proposal until the user confirms it.** The exact command and the
 *     files it came from are shown before anything runs, and running it goes through
 *     the same `confirm_launch_steps` → `launch_step` path as any other step
 *     (REQUIREMENTS §3.2: the confirmation *is* the correctness guarantee). It is
 *     written as step 1 of the repository's own step list, and the panel says so.
 *
 * Round 18 (r18-o1-1) moved every sentence of this panel into the dictionary
 * (tests/i18n.test.ts, 5e, pins them byte-for-byte). The freshness state→words
 * mapping is a literal switch inside the component for a reason: a module-level
 * `Record<string, string>` would hide the keys from the reverse i18n guard
 * ("registered but never resolved"), while `t("sync.state…")` literals keep both
 * directions of that guard able to see them. `LAYER_LABEL` (the 链路 names in
 * `types.ts`) and `fmtRelative` still speak Chinese from modules used by many
 * surfaces; wiring those is a direction of its own.
 */

/** `x 分钟前`, from the check's own timestamp - the answer is cached, so its age
 *  is part of the answer. Now delegated to `fmtRelative` in `lib/format`. */

export function RepoSyncPanel({
  slug,
  detail,
  onChanged,
}: {
  slug: string;
  /** The repository's marker-backed detail; `null` while the parent is loading. */
  detail: RepoDetail | null;
  /** Re-reads `repo_detail` after a step was written, so the panel stays truthful. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [freshBusy, setFreshBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [planLoaded, setPlanLoaded] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const aliveRef = useRef(true);
  /**
   * Re-running the failed action, or `null`. Every failure in this panel is a
   * network-or-process call the user can safely try again, so the error banner
   * offers 重试 (the way `RepoPortPanel` does) instead of making them find the
   * button again.
   */
  const [retry, setRetry] = useState<null | (() => void)>(null);

  /** Record a failure in the agreed shape, remembering how to retry it. The
   *  sentence arrives already resolved at the call site (`t("sync.…", { msg })`),
   *  so every failure wording is a dictionary literal both guards can see. */
  const fail = (line: string, again?: () => void) => {
    setError(line);
    setRetry(() => again ?? null);
  };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // git's own pull output arrives on the update progress stream. Without a listener
  // the button would look frozen for the whole download, which is the failure mode
  // `scripts/check-events.mjs` exists to catch.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ stage: string; message: string }>("update://progress", (e) => {
      if (!aliveRef.current) return;
      setLines((prev) => [...prev.slice(-199), `[${e.payload.stage}] ${e.payload.message}`]);
    }).then((fn) => {
      if (aliveRef.current) unlisten = fn;
      else fn();
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Nothing is fetched on mount: freshness is a network call and the panel opens as
  // part of a dialog that is already doing several.
  const checkFreshness = async (force: boolean) => {
    setFreshBusy(true);
    setError(null);
    try {
      const f = await invoke<Freshness>("repo_freshness", { slug, force });
      if (aliveRef.current) setFresh(f);
    } catch (e) {
      if (aliveRef.current) fail(t("sync.freshnessFailed", { msg: messageOf(e) }), () => void checkFreshness(true));
    } finally {
      if (aliveRef.current) setFreshBusy(false);
    }
  };

  /**
   * 最新发布 is a read of GitHub's release feed, not an update: it names the tag
   * and opens the page. It is deliberately not fetched on mount — the panel is
   * already several network calls and this one is the least urgent.
   */
  const checkRelease = async (force: boolean) => {
    setReleaseBusy(true);
    setError(null);
    try {
      const r = await invoke<ReleaseInfo>("repo_release", { slug, force });
      if (!aliveRef.current) return;
      setRelease(r);
      if (r.error) fail(r.error, () => void checkRelease(true));
    } catch (e) {
      if (aliveRef.current) {
        fail(t("sync.releaseFailed", { msg: messageOf(e) }), () => void checkRelease(true));
      }
    } finally {
      if (aliveRef.current) setReleaseBusy(false);
    }
  };

  const loadPlan = async () => {
    setPlanLoaded(true);
    setError(null);
    try {
      const p = await invoke<InstallPlan | null>("install_plan", { slug });
      if (aliveRef.current) setPlan(p);
    } catch (e) {
      if (aliveRef.current) fail(t("sync.planFailed", { msg: messageOf(e) }), () => void loadPlan());
    }
  };

  const runUpdate = async () => {
    setUpdateBusy(true);
    setError(null);
    setOutcome(null);
    setLines([]);
    try {
      const o = await invoke<UpdateOutcome>("update_repo", { slug });
      if (!aliveRef.current) return;
      setOutcome(o);
      // A pull moved HEAD, so the freshness answer just cached is about the old one.
      setFresh(null);
      onChanged();
    } catch (e) {
      if (aliveRef.current) fail(t("sync.updateFailed", { msg: messageOf(e) }), () => void runUpdate());
    } finally {
      if (aliveRef.current) setUpdateBusy(false);
    }
  };

  /**
   * 确认并安装: write the install step into the repository's own confirmed step
   * list, then run exactly that step. Deliberately not a new execution route - the
   * command the user just read is the command `launch_step` runs, and the record of
   * it is the same 启动步骤列表 the 启动面板 edits.
   */
  const confirmAndInstall = async () => {
    if (!plan) return;
    setInstallBusy(true);
    setError(null);
    setLines([]);
    try {
      // 「安装依赖」 and 「启动」 are persisted step *names* (the panel dedupes by
      // name), so they stay Chinese on purpose — they are data, not copy.
      const step: LaunchStep = { name: "安装依赖", command: plan.command, cwd: "", parallel: false };
      const rest = (detail?.launch?.steps ?? []).filter((s) => s.name !== "安装依赖");
      const single = !detail?.launch?.steps?.length && detail?.launch?.command.trim()
        ? [{ name: "启动", command: detail.launch.command, cwd: detail.launch.cwd, parallel: false }]
        : rest;
      const list = [step, ...single];
      await invoke("confirm_launch_steps", { slug, steps: list });
      const started = await invoke<LaunchStarted>("launch_step", { slug, index: 0 });
      if (!aliveRef.current) return;
      setFresh(null);
      toast.success(t("sync.ranAsStep", { command: started.command, pid: started.pid }));
      onChanged();
    } catch (e) {
      if (aliveRef.current) fail(t("sync.installFailed", { msg: messageOf(e) }), () => void confirmAndInstall());
    } finally {
      if (aliveRef.current) setInstallBusy(false);
    }
  };

  const freshnessChip = (state: string): { label: string; tone: "ok" | "warn" | "muted" } | null => {
    switch (state) {
      case "fresh":
        return { label: t("sync.stateFresh"), tone: "ok" };
      case "behind":
        return { label: t("sync.stateBehind"), tone: "warn" };
      case "unknown":
        return { label: t("sync.stateUnknown"), tone: "muted" };
      case "no-git":
        return { label: t("sync.stateNoGit"), tone: "muted" };
      case "missing":
        return { label: t("sync.stateMissing"), tone: "warn" };
      default:
        return null;
    }
  };

  const f = fresh ? freshnessChip(fresh.state) : null;

  return (
    <div className="mt-4 rounded-lg border border-border-weak bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">{t("sync.title")}</span>

        <button
          type="button"
          onClick={() => void runUpdate()}
          disabled={updateBusy || freshBusy}
          title={t("sync.updateTitle")}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-caption transition-colors hover:bg-accent disabled:opacity-40"
        >
          {updateBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {updateBusy ? t("sync.updateBusy") : t("sync.update")}
        </button>

        <button
          type="button"
          onClick={() => void checkFreshness(false)}
          disabled={updateBusy || freshBusy}
          title={t("sync.freshnessTitle")}
          className="flex items-center gap-1.5 rounded-lg border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {freshBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {t("sync.freshness")}
        </button>

        {fresh && f && (
          <span
            title={
              fresh.error
                ? t("sync.reason", { msg: fresh.error })
                : t("sync.heads", { local: fresh.localHead ?? "?", remote: fresh.remoteHead ?? "?" })
            }
            className={
              f.tone === "ok"
                ? "flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-caption text-success"
                : f.tone === "warn"
                  ? "flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-caption text-warning"
                  : "rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground"
            }
          >
            {f.tone === "ok" && <CircleCheck className="h-2.5 w-2.5" />}
            {f.tone === "warn" && <TriangleAlert className="h-2.5 w-2.5" />}
            {f.label} · {fmtRelative(fresh.checkedAt)}
          </span>
        )}

        <button
          type="button"
          onClick={() => void checkRelease(false)}
          disabled={releaseBusy}
          title={t("sync.releaseTitle")}
          className="flex items-center gap-1.5 rounded-lg border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {releaseBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Tag className="h-3 w-3" />}
          {t("sync.release")}
        </button>

        {release?.state === "release" && release.url && (
          <button
            type="button"
            onClick={() => void openHttpUrl(release.url!)}
            title={t("sync.releaseOpen", { tag: release.tag ?? "" })}
            className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-caption text-primary transition-colors hover:bg-primary/20"
          >
            <Tag className="h-2.5 w-2.5" />
            {release.tag}
            {release.prerelease ? ` · ${t("sync.releasePrerelease")}` : ""}
            {release.publishedAt ? ` · ${new Date(release.publishedAt).toLocaleDateString()}` : ""}
            {release.fromCache ? ` · ${t("sync.releaseCached")}` : ""}
          </button>
        )}
        {release?.state === "none" && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
            {t("sync.releaseNone")}
          </span>
        )}

        {!planLoaded && (
          <button
            type="button"
            onClick={() => void loadPlan()}
            className="flex items-center gap-1.5 rounded-lg border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PackagePlus className="h-3 w-3" />
            {t("sync.installDeps")}
          </button>
        )}
      </div>

      <p className="app-desc mt-2 text-caption leading-snug text-muted-foreground">
        {t("sync.layerNoteLead")}
        <strong>{t("sync.layerNoteStrong")}</strong>
        {t("sync.layerNoteMid")}
        <code>insteadOf</code>
        {t("sync.layerNoteTail")}
      </p>

      {error && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 p-2 text-caption leading-relaxed text-danger"
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
              {t("sync.retry")}
            </button>
          )}
        </div>
      )}

      {plan && (
        <div className="mt-2 rounded-lg border border-border-weak p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-caption">{plan.command}</code>
            <span className="text-caption text-muted-foreground">{plan.evidence}</span>
          </div>
          <p className="mt-1 text-caption text-muted-foreground">
            {t("sync.basis", { list: plan.inspected.join("、") || t("sync.none") })}
          </p>
          {!plan.toolPresent && (
            <p className="mt-1 flex items-start gap-1.5 text-caption text-warning">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
              {t("sync.toolMissingLead")}
              <code>{plan.toolName}</code>
              {t("sync.toolMissingTail")}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void confirmAndInstall()}
              disabled={installBusy || !plan.toolPresent}
              className="skin-ctl flex items-center gap-1.5 bg-primary px-2.5 py-1 text-caption font-medium text-primary-foreground t-state hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {installBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <PackagePlus className="h-3 w-3" />}
              {installBusy ? t("sync.installBusy") : t("sync.confirmInstall")}
            </button>
            <span className="text-caption text-muted-foreground">
              {t("sync.confirmInstallHint")}
            </span>
          </div>
        </div>
      )}

      {outcome && (
        <div className="mt-2 rounded-lg bg-success/10 p-2 text-caption text-success">
          <p>
            {outcome.before === outcome.after
              ? t("sync.upToDate", { head: outcome.after, layer: LAYER_LABEL[outcome.layer] ?? outcome.layer })
              : t("sync.forwarded", {
                  before: outcome.before,
                  after: outcome.after,
                  commits: outcome.commits === null ? "" : t("sync.commitsAdded", { n: outcome.commits }),
                  layer: LAYER_LABEL[outcome.layer] ?? outcome.layer,
                })}
          </p>
          {outcome.commits === null && outcome.before !== outcome.after && (
            <p className="mt-0.5 text-muted-foreground">
              {t("sync.commitsUnknown")}
            </p>
          )}
          {(outcome.recent?.length ?? 0) > 0 && (
            <details className="mt-1.5 text-foreground">
              <summary className="cursor-pointer text-caption text-muted-foreground">
                {t("sync.recent", { n: outcome.recent?.length ?? 0 })}
              </summary>
              <ul className="mt-1 space-y-0.5">
                {outcome.recent?.map((c) => (
                  <li key={c.hash} className="flex gap-1.5 text-caption">
                    <code className="shrink-0 rounded bg-background px-1 font-mono text-muted-foreground">
                      {c.hash}
                    </code>
                    <span className="min-w-0 break-words">{c.subject}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {outcome.viaThirdParty && (
            <p className="mt-0.5 text-warning">{t("sync.mirrorWarning")}</p>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <details className="mt-2" open={updateBusy || installBusy}>
          <summary className="cursor-pointer text-caption text-muted-foreground">
            {t("sync.output", { n: lines.length })}
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background p-2 font-mono text-caption leading-relaxed text-muted-foreground">
            {lines.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
