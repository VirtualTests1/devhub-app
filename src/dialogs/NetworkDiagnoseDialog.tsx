import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleAlert,
  CircleCheckBig,
  Info,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { toast } from "../components/Toast";
import { useI18n } from "../lib/useI18n";
import { severityLabel, type DiagSeverity } from "../lib/diagnose";
import { diagnoseNetwork, netDiagText, type NetIssue } from "../lib/netdiag";
import { cn } from "../lib/utils";
import { useUI } from "../store/ui";
import type { EnvironmentReport } from "../types";

/**
 * 网络诊断对话框（r18 方向 N2）。
 *
 * ## 它把哪里已经有的东西拿到了一处
 *
 * 网络事实散在三处：状态栏弹出的三张网络卡片 + 一条事实行、设置 → 网络 一页
 * 开关。哪一处都回答不了「整体上链路有没有毛病、为什么」。这里的结论来自
 * `lib/netdiag.ts`——和 `diagnose.ts` 同一条纪律的纯规则（判定全在纯函数里，
 * 因此单测覆盖的就是屏幕上真正在跑的那套），事实区只是一次读数的完整陈列。
 *
 * ## 每次打开都 force 一次
 *
 * 打开这个对话框本身就是「诊断」这个动作，所以不蹭 20 秒 TTL 的缓存结果：
 * `environment` 带 `force: true`，链路状态绕过 5 秒缓存，真正的重新探测。
 * 「重新诊断」按钮同样 force——一个悄悄返回缓存事实的按钮就是「诊断没反应」
 * 那份报告的重演（n2-1 给后端加 `force` 参数就是为了这件事）。
 *
 * ## 探针失败是一个界面状态，不是异常
 *
 * IPC 报错落下 `env = null`，界面画「取不到网络状态」——`diagnoseNetwork(null)`
 * 返回空清单，「问不出来」与「没问题」在本对话框是两个看起来不同的状态。
 * 不在 console 里再喊一遍：对话框本身就是那个喊的地方。
 *
 * ## 事实区里的 `linkAdvice` 是后端中文
 *
 * `link.rs` 生成的建议句只作为**数据**陈列（与状态栏的 tooltip 同一用法），
 * 不在这条 i18n 语言行里翻译——这条边界与 `lib/netdiag.ts` 头部的说明一致。
 */
type Load = { kind: "loading" } | { kind: "ready"; env: EnvironmentReport | null };

type Translate = ReturnType<typeof useI18n>["t"];

/** 与 strip 网络卡片同一句法，避免两处对「hosts 是否被改写」各说各话。 */
function hostsValue(t: Translate, env: EnvironmentReport): string {
  if (!env.hostsHijacked) return t("strip.hostsNotRewritten");
  return env.hostsBy
    ? t("strip.hostsRewrittenBy", { n: env.hostsRedirectCount ?? "", by: env.hostsBy })
    : t("strip.hostsRewritten", { n: env.hostsRedirectCount ?? "" });
}

/** 复制出去的报告：结论在前、事实在后，粘进 issue 时读起来是自上而下的。 */
function reportLines(
  t: Translate,
  env: EnvironmentReport,
  issues: NetIssue[],
): string[] {
  const lines = [`${t("netdiag.title")} · ${env.linkLabel}`];
  if (issues.length > 0) {
    lines.push("", t("diagnose.listTitle", { n: issues.length }));
    for (const issue of issues) {
      lines.push(`[${severityLabel(t, issue.severity)}] ${netDiagText(t, issue)}`);
    }
  } else {
    lines.push("", t("netdiag.emptyTitle"));
  }
  lines.push(
    "",
    t("netdiag.factsTitle"),
    `- ${t("strip.localProxyTitle")}: ${env.localProxy ?? t("strip.proxyNotFound")}`,
    `- ${t("strip.hostsTitle")}: ${hostsValue(t, env)}`,
    `- ${t("strip.resolvedTitle")}: ${env.resolvedIp ?? t("strip.resolversDisagree")}`,
    `- ${t("strip.ipPinLabel")}: ${env.ipPinEnabled ? t("strip.enabled") : t("strip.disabled")}`,
    `- ${t("strip.mirrorLabel")}: ${env.mirrorEnabled ? t("strip.mirrorEnabled") : t("strip.disabled")}`,
    `- ${t("strip.privLabel")}: ${env.elevated ? t("strip.privElevated") : t("strip.privStandard")}`,
  );
  if (env.linkAdvice) lines.push("", env.linkAdvice);
  return lines;
}

export function NetworkDiagnoseDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      let env: EnvironmentReport | null = null;
      try {
        // force: 打开动作本身就是「诊断」——见组件头部说明。
        env = (await invoke<EnvironmentReport>("environment", { force: true })) ?? null;
      } catch {
        // 失败不是异常路径而是一个界面状态（probeFailed），见头部说明。
      }
      if (alive) setState({ kind: "ready", env });
    })();
    return () => {
      alive = false;
    };
  }, [nonce]);

  const ready = state.kind === "ready" ? state.env : null;
  const issues = ready ? diagnoseNetwork(ready) : [];

  /**
   * 关掉对话框再跳转（RepoDiagnoseDialog 的 onJump 同一约定）：两层浮层
   * 叠加会争同一套 Escape / 焦点；跳转镜像状态栏卡片的 double-click——
   * `go("settings")` + 指定 section。
   */
  function openNetworkSettings() {
    onClose();
    useUI.getState().go("settings");
    useUI.getState().setSettingsSection("network");
  }

  async function copyReport() {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(reportLines(t, ready, issues).join("\n"));
      toast.success(t("netdiag.copied"));
    } catch {
      toast.error(t("settings.page.failuresClipboardDenied"));
    }
  }

  return (
    <DialogShell
      title={t("netdiag.title")}
      subtitle={ready?.linkLabel}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted-foreground">
            {state.kind === "ready" && ready && issues.length > 0
              ? t("diagnose.listTitle", { n: issues.length })
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openNetworkSettings}
              className="skin-ctl border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t("netdiag.openSettings")}
            </button>
            <button
              type="button"
              onClick={() => void copyReport()}
              disabled={!ready}
              className="skin-ctl border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              {t("netdiag.copy")}
            </button>
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
        </div>
      }
    >
      {state.kind === "loading" && (
        <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("netdiag.loading")}
        </p>
      )}

      {state.kind === "ready" && ready === null && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p className="text-caption leading-snug text-danger">{t("netdiag.probeFailed")}</p>
        </div>
      )}

      {state.kind === "ready" && ready && issues.length === 0 && (
        <div className="flex items-start gap-2 py-1">
          <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-body font-medium text-foreground">{t("netdiag.emptyTitle")}</p>
            <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
              {t("netdiag.emptyHint")}
            </p>
          </div>
        </div>
      )}

      {state.kind === "ready" && ready && issues.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, i) => (
            <li
              key={`${issue.code}:${i}`}
              className="flex items-start gap-2 rounded-lg border border-border-weak bg-background px-2.5 py-2"
            >
              <SeverityIcon severity={issue.severity} />
              <div className="min-w-0 flex-1">
                <span className={cn("text-caption font-medium", SEVERITY_TONE[issue.severity])}>
                  {severityLabel(t, issue.severity)}
                </span>
                <p className="mt-0.5 text-body leading-snug text-foreground">
                  {netDiagText(t, issue)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {state.kind === "ready" && ready && (
        <div className="mt-3 rounded-lg border border-border-weak bg-background p-2.5">
          <p className="text-caption font-medium text-muted-foreground">
            {t("netdiag.factsTitle")}
          </p>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
            <Fact
              label={t("strip.localProxyTitle")}
              value={ready.localProxy ?? t("strip.proxyNotFound")}
              tone={ready.localProxy ? "good" : "plain"}
            />
            <Fact
              label={t("strip.hostsTitle")}
              value={hostsValue(t, ready)}
              tone={ready.hostsHijacked ? "warn" : "plain"}
            />
            <Fact
              label={t("strip.resolvedTitle")}
              value={ready.resolvedIp ?? t("strip.resolversDisagree")}
              tone={ready.resolvedIp ? "good" : "warn"}
            />
            <Fact
              label={t("strip.ipPinLabel")}
              value={ready.ipPinEnabled ? t("strip.enabled") : t("strip.disabled")}
              tone={ready.ipPinEnabled ? "good" : "plain"}
            />
            <Fact
              label={t("strip.mirrorLabel")}
              value={ready.mirrorEnabled ? t("strip.mirrorEnabled") : t("strip.disabled")}
              tone={ready.mirrorEnabled ? "warn" : "plain"}
            />
            <Fact
              label={t("strip.privLabel")}
              value={ready.elevated ? t("strip.privElevated") : t("strip.privStandard")}
              tone={ready.elevated ? "warn" : "good"}
            />
          </dl>
          {ready.linkAdvice && (
            <p className="mt-2 text-caption leading-snug text-muted-foreground/80">
              {ready.linkAdvice}
            </p>
          )}
        </div>
      )}
    </DialogShell>
  );
}

const SEVERITY_TONE: Record<DiagSeverity, string> = {
  error: "text-danger",
  warn: "text-warning",
  info: "text-muted-foreground",
};

function SeverityIcon({ severity }: { severity: DiagSeverity }) {
  if (severity === "error") return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />;
  if (severity === "warn") return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />;
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "plain" | "good" | "warn";
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "m-0 break-words",
          tone === "good" ? "text-success" : tone === "warn" ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </>
  );
}
