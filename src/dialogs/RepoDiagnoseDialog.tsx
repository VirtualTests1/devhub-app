import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, CircleCheckBig, Info, LoaderCircle, RefreshCw } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";
import {
  diagnose,
  diagAction,
  diagText,
  missingProbes,
  severityLabel,
  type Diagnostic,
  type DiagJump,
} from "../lib/diagnose";
import { cn } from "../lib/utils";
import type {
  ClearReport,
  DependencyReport,
  EnvironmentReport,
  Environments,
  Freshness,
  InstallPlan,
  PortHealth,
  RepoDetail,
  RepoRef,
  WorktreeStatus,
} from "../types";

/**
 * 仓库健康诊断对话框（round 17, N3-2）。
 *
 * ## 入口与职责
 *
 * 卡片右键菜单的「诊断…」打开这里。它是**一个只读的读取器**：把 `lib/diagnose.ts`
 * 的分级清单渲染成「严重度 + 结论 + 一键跳到修复入口」，自己不做任何判定——判定全在
 * 那个纯函数里，这样单测覆盖的就是屏幕上真正在跑的那套规则，而不是副本。
 *
 * ## 为什么这一档「一键跳到修复入口」是有意义的
 *
 * 每条问题都带一个 `DiagJump`。对话框关闭自己，再把跳转交回 `ProjectsView`（它才知道
 * 怎么打开操作面板 / 项目设置，以及怎么切到设置页）。这正是本方向与 `export_diagnostics`
 * 的分野：那个只把事实写成文件，这个把每条事实接到一个能动手的地方。
 *
 * ## 探针的诚实性
 *
 * 每个探针都走 `probe`，失败（IPC 报错）记成 `null`，而不是把失败当成「这项没问题」。
 * `lib/diagnose.ts` 对 `null` 的处理就是整条规则不产生——「问不出来」和「没问题」不同。
 */
type Card = RepoRef & { slug: string };

type Load =
  | { kind: "loading" }
  | { kind: "ready"; issues: Diagnostic[]; failed: string[] };

/** 一次探针调用：成功取值，失败（含命令返回空）记成 `null`。 */
async function probe<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const out = await invoke<T>(name, args);
    return out ?? null;
  } catch {
    return null;
  }
}

export function RepoDiagnoseDialog({
  card,
  running,
  onClose,
  onJump,
}: {
  card: Card | null;
  /** 该仓库此刻是否有本应用启动的进程在跑（端口探针据此才适用）。 */
  running: boolean;
  onClose: () => void;
  onJump: (jump: DiagJump) => void;
}) {
  const { t } = useI18n();
  const slug = card?.slug ?? "";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [deps, setDeps] = useState<DependencyReport | null>(null);
  // 重新诊断的触发：改变这个计数让下面的 effect 再跑一次。
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setState({ kind: "loading" });
    setDeps(null);
    (async () => {
      const [env, freshness, worktree, detail, ports, plan, cache, tools, depReport] =
        await Promise.all([
          probe<EnvironmentReport>("environment"),
          probe<Freshness>("repo_freshness", { slug, force: true }),
          probe<WorktreeStatus>("repo_worktree_status", { slug }),
          probe<RepoDetail>("repo_detail", { slug }),
          probe<PortHealth[]>("repo_port_health", { slug }),
          probe<InstallPlan>("install_plan", { slug }),
          probe<ClearReport>("scan_cache", { slug }),
          probe<Environments>("repo_environments", { slug }),
          probe<DependencyReport>("check_dependencies", { slug }),
        ]);
      if (!alive) return;
      const issues = diagnose({
        repos: [{ slug, running, freshness, worktree, detail, ports, plan, cache, tools }],
        env,
      });
      // `probe` turns an IPC rejection into null, and diagnose drops that rule.
      // Name the dropped inputs so zero issues cannot pose as "all clear".
      const failed = missingProbes({
        environment: env,
        repo_freshness: freshness,
        repo_worktree_status: worktree,
        repo_detail: detail,
        repo_port_health: ports,
        install_plan: plan,
        scan_cache: cache,
        repo_environments: tools,
        check_dependencies: depReport,
      });
      setState({ kind: "ready", issues, failed });
      setDeps(depReport);
    })();
    return () => {
      alive = false;
    };
  }, [slug, running, nonce]);

  if (!card) return null;

  const issues = state.kind === "ready" ? state.issues : [];

  return (
    <DialogShell
      title={t("diagnose.dialogTitle")}
      subtitle={`${card.owner}/${card.repo}`}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted-foreground">
            {state.kind === "ready" && issues.length > 0 ? t("diagnose.listTitle", { n: issues.length }) : ""}
          </span>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            disabled={state.kind === "loading"}
            className="skin-ctl inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className="h-3 w-3" />
            {t("diagnose.rerun")}
          </button>
        </div>
      }
    >
      {state.kind === "loading" && (
        <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("diagnose.loading")}
        </p>
      )}

      {state.kind === "ready" && state.failed.length > 0 && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-2 text-caption text-muted-foreground"
        >
          <p className="font-medium text-warning">
            {t("diagnose.probeFailed", { n: state.failed.length })}
          </p>
          <p className="mt-0.5 break-all font-mono">{state.failed.join(" · ")}</p>
        </div>
      )}

      {state.kind === "ready" && issues.length === 0 && (
        <div className="flex items-start gap-2 py-3">
          <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-body font-medium text-foreground">
              {state.failed.length > 0 ? t("diagnose.partialTitle") : t("diagnose.emptyTitle")}
            </p>
            <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
              {t("diagnose.emptyHint")}
            </p>
          </div>
        </div>
      )}

      {state.kind === "ready" && issues.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, i) => (
            <li
              key={`${issue.code}:${issue.slug ?? ""}:${i}`}
              className="flex items-start gap-2 rounded-lg border border-border-weak bg-background px-2.5 py-2"
            >
              <SeverityIcon severity={issue.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn("text-caption font-medium", SEVERITY_TONE[issue.severity])}>
                    {severityLabel(t, issue.severity)}
                  </span>
                  {issue.slug && (
                    <span className="truncate text-caption text-muted-foreground">{issue.slug}</span>
                  )}
                </div>
                <p className="mt-0.5 text-body leading-snug text-foreground">{diagText(t, issue)}</p>
              </div>
              <button
                type="button"
                onClick={() => onJump(issue.jump)}
                className="skin-ctl shrink-0 border border-border px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {diagAction(t, issue.jump)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {deps && deps.manager !== "none" && (
        <div className="mt-4 border-t border-border-weak pt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-caption font-medium text-foreground">
              {t("diagnose.depTitle", { manager: deps.manager })}
            </h3>
            {deps.outdated.length > 0 && (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-caption text-warning">
                {deps.outdated.length}
              </span>
            )}
          </div>
          {deps.error ? (
            <p className="text-caption text-danger">{deps.error}</p>
          ) : deps.outdated.length === 0 ? (
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <CircleCheckBig className="h-3 w-3 text-primary" />
              {t("diagnose.depUpToDate")}
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border-weak">
              <table className="w-full text-left text-caption">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 font-normal">{t("diagnose.depName")}</th>
                    <th className="px-2 py-1 font-normal">{t("diagnose.depCurrent")}</th>
                    <th className="px-2 py-1 font-normal">{t("diagnose.depLatest")}</th>
                  </tr>
                </thead>
                <tbody>
                  {deps.outdated.map((d) => (
                    <tr key={d.name} className="border-t border-border-weak">
                      <td className="px-2 py-1 font-mono text-foreground">{d.name}</td>
                      <td className="px-2 py-1 font-mono text-muted-foreground">{d.current}</td>
                      <td className="px-2 py-1 font-mono text-warning">{d.latest}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </DialogShell>
  );
}

const SEVERITY_TONE: Record<Diagnostic["severity"], string> = {
  error: "text-danger",
  warn: "text-warning",
  info: "text-muted-foreground",
};

function SeverityIcon({ severity }: { severity: Diagnostic["severity"] }) {
  if (severity === "error") return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
  if (severity === "warn") return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />;
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}
