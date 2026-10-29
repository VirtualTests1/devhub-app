import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HardDrive, RefreshCw } from "lucide-react";
import { formatBytes } from "../lib/format";
import { messageOf } from "../lib/report-error";
import { useI18n } from "../lib/useI18n";
import type { StorageBreakdown } from "../types";

/**
 * 项目设置 → 存储占用: the three places a repository's bytes live.
 *
 * The clone's cache figure is a subset of `repoBytes`; venv and worktrees are
 * outside the clone. The panel is read-only — clearing a cache remains the launch
 * panel's explicit verb, so this view cannot become a second deletion path.
 */
export function RepoStoragePanel({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<StorageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await invoke<StorageBreakdown>("repo_storage_breakdown", { slug }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: { key: keyof StorageBreakdown; label: string }[] = data
    ? [
        { key: "totalBytes", label: t("repoStorage.total") },
        { key: "repoBytes", label: t("repoStorage.repo") },
        { key: "cacheBytes", label: t("repoStorage.cache") },
        { key: "venvBytes", label: t("repoStorage.venv") },
        { key: "worktreesBytes", label: t("repoStorage.worktrees") },
      ]
    : [];

  return (
    <section className="mt-4" data-storage-panel>
      <div className="mb-1 flex items-center gap-2">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="skin-label text-caption font-medium text-muted-foreground">
          {t("repoStorage.title")}
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t("repoStorage.refresh")}
          title={t("repoStorage.refresh")}
          className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {t("repoStorage.failed", { msg: error })}
        </p>
      ) : (
        <div className="skin-panel overflow-hidden rounded-xl border border-border-weak bg-card">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-center justify-between border-b border-border-weak px-3 py-1.5 text-caption last:border-b-0"
            >
              <span className="text-muted-foreground">{row.label}</span>
              <span className="tabular-nums">{formatBytes(data?.[row.key] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="app-desc mt-1 px-0.5 text-caption leading-snug text-muted-foreground">
        {t("repoStorage.hint")}
      </p>
    </section>
  );
}
