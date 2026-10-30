import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FileBadge, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";

import { useI18n } from "../../lib/useI18n";
import { reg } from "../../store/customize";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/report-error";
import {
  licenseCsv,
  licenseTone,
  summarizeLicenses,
  type LicenseOverview,
  type LicenseRow,
} from "../../lib/license-overview";

/**
 * 记录页的许可证概览（r33-D7）.
 *
 * On demand, not on mount: the scan reads one licence file and one manifest per
 * repository, which is cheap but pointless for a visitor who came here to read
 * activity. The card answers "what is in my collection, and what has no licence
 * at all" — missing and unknown are separate counts because they need different
 * actions (add a licence vs. ask a human).
 */
const RENDER_ROWS = 60;

function relevantRows(rows: readonly LicenseRow[]): LicenseRow[] {
  const rank = (r: LicenseRow) => (licenseTone(r) === "warn" ? 0 : licenseTone(r) === "muted" ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
}

export function LicenseOverviewCard() {
  const { t } = useI18n();
  const [data, setData] = useState<LicenseOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const summary = useMemo(() => (data ? summarizeLicenses(data.rows) : null), [data]);
  const rows = useMemo(() => (data ? relevantRows(data.rows) : []), [data]);

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await invoke<LicenseOverview>("license_overview"));
    } catch (e) {
      setError(t("records.license.scanFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const picked = await saveDialog({
        title: t("records.license.exportTitle"),
        defaultPath: "licenses.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!picked) return;
      await invoke("write_text_file", { path: picked, text: licenseCsv(data.rows) });
      toast.success(t("records.license.exported", { n: data.rows.length }));
    } catch (e) {
      toast.error(t("records.license.exportFailed", { msg: messageOf(e) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section
      {...reg("records-license-overview")}
      className="skin-panel mb-3 border border-border-weak bg-card px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileBadge className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="skin-label text-body font-medium">{t("records.license.title")}</h2>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy}
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {busy ? t("records.license.scanning") : t("records.license.scan")}
        </button>
        {data && (
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting || data.rows.length === 0}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {t("records.license.export")}
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
        <p className="mt-1.5 text-caption text-muted-foreground">{t("records.license.hint")}</p>
      )}

      {data && summary && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-1.5 text-caption">
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-success">
              {t("records.license.known", { n: summary.known })}
            </span>
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
              {t("records.license.missing", { n: summary.missing })}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
              {t("records.license.unknown", { n: summary.unknown })}
            </span>
            {summary.byLicense.slice(0, 5).map(([name, n]) => (
              <span key={name} className="rounded-full border border-border-weak px-2 py-0.5 text-muted-foreground">
                {name} × {n}
              </span>
            ))}
            {data.capped && (
              <span className="text-caption text-warning">{t("records.license.capped")}</span>
            )}
          </div>

          {summary.known + summary.unknown + summary.missing === 0 ? (
            <p className="mt-2 text-caption text-muted-foreground">{t("records.license.empty")}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border-weak">
              {rows.slice(0, RENDER_ROWS).map((row) => {
                const tone = licenseTone(row);
                return (
                  <li key={row.slug} className="flex items-center gap-2 py-1 text-caption">
                    <span className="min-w-0 flex-1 truncate" title={row.slug}>
                      {row.slug}
                    </span>
                    <span
                      className={
                        tone === "ok"
                          ? "shrink-0 text-success"
                          : tone === "warn"
                            ? "shrink-0 text-warning"
                            : "shrink-0 text-muted-foreground"
                      }
                    >
                      {row.license ??
                        (row.confidence === "missing"
                          ? t("records.license.noLicense")
                          : t("records.license.unrecognised"))}
                    </span>
                    <span className="w-28 shrink-0 truncate text-right text-muted-foreground" title={row.source}>
                      {row.file ?? row.source}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > RENDER_ROWS && (
            <p className="mt-1 text-caption text-muted-foreground">
              {t("records.license.more", { n: rows.length - RENDER_ROWS })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
