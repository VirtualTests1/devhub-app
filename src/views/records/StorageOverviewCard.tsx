import { useMemo } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import { formatBytes } from "../../lib/format";
import { useI18n } from "../../lib/useI18n";
import { buildStorageOverview } from "../../lib/storage-overview";
import { reg } from "../../store/customize";
import { useMeta } from "../../store/meta";

/**
 * 记录页的存储概览（r23-N1）。
 *
 * 数据来自已经算好的 `repo_metadata`（`useMeta`），不再扫一遍磁盘；「刷新」只是
 * 让那个 store 越过它自己的十分钟缓存重走一次。未知体积单独计数，不并进总量。
 */
export function StorageOverviewCard() {
  const { t } = useI18n();
  const bySlug = useMeta((s) => s.bySlug);
  const loading = useMeta((s) => s.loading);
  const overview = useMemo(() => {
    const items = Object.values(bySlug).map((m) => ({
      slug: m.slug,
      sizeBytes: m.sizeBytes,
      hasCache: m.hasCache,
    }));
    return buildStorageOverview(items, (slug) => slug.split("/").slice(1).join("/") || slug);
  }, [bySlug]);

  if (overview.repoCount === 0) return null;

  return (
    <section {...reg("records-storage-overview")} className="skin-panel mb-3 border border-border-weak bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="skin-label text-body font-medium">{t("storage.title")}</h2>
        <button
          type="button"
          onClick={() => void useMeta.getState().load(true)}
          disabled={loading}
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          {t("storage.refresh")}
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-caption">
        <span>
          <span className="block text-muted-foreground/70">{t("storage.total")}</span>
          <span className="block text-body font-medium tabular-nums">{formatBytes(overview.totalBytes)}</span>
        </span>
        <span>
          <span className="block text-muted-foreground/70">{t("storage.repos")}</span>
          <span className="block text-body font-medium tabular-nums">{overview.repoCount}</span>
        </span>
        <span>
          <span className="block text-muted-foreground/70">{t("storage.cache")}</span>
          <span className="block text-body font-medium tabular-nums">{overview.cacheRepos}</span>
        </span>
      </div>
      {overview.unknownCount > 0 && (
        <p className="mt-1.5 text-caption text-warning">{t("storage.unknown", { n: overview.unknownCount })}</p>
      )}
      <ul className="mt-2 space-y-0.5 text-caption">
        {overview.top.map((row) => (
          <li key={row.slug} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={row.slug}>{row.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(row.sizeBytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
