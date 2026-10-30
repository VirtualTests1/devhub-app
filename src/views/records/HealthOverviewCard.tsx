import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Activity, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";

import { useI18n } from "../../lib/useI18n";
import { reg } from "../../store/customize";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/report-error";
import { csvSafe } from "../../lib/license-overview";
import { sortHealthRows, summarizeHealth, worstSeverity } from "../../lib/health-overview";
import type { HealthIssue, HealthOverview, HealthRow } from "../../types";

/**
 * 记录页的仓库健康总览（r34-D5）.
 *
 * The per-repository 诊断 dialog stays the deep tool; this is the collection
 * answer: which clones are dirty, detached, missing their marker, or pointing at
 * a venv that no longer exists. It is on demand because it spawns one bounded
 * `git status` per repository; nothing here touches the network.
 */
const RENDER_ROWS = 60;

type Translate = ReturnType<typeof useI18n>["t"];

function issueLabel(t: Translate, issue: HealthIssue): string {
  switch (issue.code) {
    case "marker":
      return t("records.health.issue.marker");
    case "no-git":
      return t("records.health.issue.noGit");
    case "git-status":
      return t("records.health.issue.gitStatus");
    case "dirty":
      return t("records.health.issue.dirty");
    case "detached":
      return t("records.health.issue.detached");
    case "no-upstream":
      return t("records.health.issue.noUpstream");
    case "venv-missing":
      return t("records.health.issue.venvMissing");
    case "venv-invalid":
      return t("records.health.issue.venvInvalid");
    case "no-readme":
      return t("records.health.issue.noReadme");
    case "no-launch":
      return t("records.health.issue.noLaunch");
    default:
      return issue.code;
  }
}

function severityClass(severity: "error" | "warn" | "info" | "ok"): string {
  if (severity === "error") return "text-danger";
  if (severity === "warn") return "text-warning";
  if (severity === "info") return "text-muted-foreground";
  return "text-success";
}

function severityDot(severity: "error" | "warn" | "info" | "ok"): string {
  if (severity === "error") return "bg-danger";
  if (severity === "warn") return "bg-warning";
  if (severity === "info") return "bg-muted-foreground";
  return "bg-success";
}

function healthCsv(rows: readonly HealthRow[]): string {
  const header = ["slug", "path", "marker", "git", "branch", "detached", "upstream", "dirty", "readme", "launch", "venv", "issues"];
  const lines = [header.map(csvSafe).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.slug,
        row.path,
        row.markerState,
        String(row.hasGit),
        row.branch ?? "",
        String(row.detached),
        row.upstream ?? "",
        String(row.dirty),
        String(row.hasReadme),
        String(row.hasLaunch),
        row.venvState,
        row.issues.map((i) => i.code).join("|"),
      ]
        .map(csvSafe)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function HealthOverviewCard() {
  const { t } = useI18n();
  const [data, setData] = useState<HealthOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const summary = useMemo(() => (data ? summarizeHealth(data.rows) : null), [data]);
  const rows = useMemo(() => (data ? sortHealthRows(data.rows) : []), [data]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await invoke<HealthOverview>("repo_health_overview"));
    } catch (e) {
      setError(t("records.health.scanFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const picked = await saveDialog({
        title: t("records.health.exportTitle"),
        defaultPath: "repo-health.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!picked) return;
      await invoke("write_text_file", { path: picked, text: healthCsv(data.rows) });
      toast.success(t("records.health.exported", { n: data.rows.length }));
    } catch (e) {
      toast.error(t("records.health.exportFailed", { msg: messageOf(e) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section
      {...reg("records-health-overview")}
      className="skin-panel mb-3 border border-border-weak bg-card px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="skin-label text-body font-medium">{t("records.health.title")}</h2>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy}
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {busy ? t("records.health.scanning") : t("records.health.scan")}
        </button>
        {data && (
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting || data.rows.length === 0}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {t("records.health.export")}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-caption text-danger">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}

      {!data && !error && (
        <p className="mt-1.5 text-caption text-muted-foreground">{t("records.health.hint")}</p>
      )}

      {data && summary && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5 text-caption">
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-success">
              {t("records.health.clean", { n: summary.clean })}
            </span>
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
              {t("records.health.warnings", { n: summary.warnings })}
            </span>
            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-danger">
              {t("records.health.errors", { n: summary.errors })}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
              {t("records.health.infos", { n: summary.infos })}
            </span>
            {summary.byIssue.slice(0, 4).map(([code, n]) => (
              <span key={code} className="rounded-full border border-border-weak px-2 py-0.5 text-muted-foreground">
                {code} × {n}
              </span>
            ))}
            {data.capped && <span className="text-caption text-warning">{t("records.health.capped")}</span>}
          </div>

          {rows.length === 0 ? (
            <p className="mt-2 text-caption text-muted-foreground">{t("records.health.empty")}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border-weak">
              {rows.slice(0, RENDER_ROWS).map((row) => {
                const severity = worstSeverity(row);
                return (
                  <li key={row.slug} className="flex items-start gap-2 py-1 text-caption">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${severityDot(severity)}`} />
                    <span className="min-w-0 flex-1 truncate" title={row.path}>{row.slug}</span>
                    <span
                      className={`min-w-0 max-w-[55%] truncate text-right ${severityClass(severity)}`}
                      title={row.issues.map((i) => issueLabel(t, i)).join(" · ")}
                    >
                      {row.issues.length === 0
                        ? t("records.health.ok")
                        : row.issues.map((i) => issueLabel(t, i)).join(" · ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > RENDER_ROWS && (
            <p className="mt-1 text-caption text-muted-foreground">
              {t("records.health.more", { n: rows.length - RENDER_ROWS })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
