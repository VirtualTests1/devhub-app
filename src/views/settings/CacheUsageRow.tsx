import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDestructive } from "../../lib/confirm";
import { Database, Trash2 } from "lucide-react";
import { ActionRow } from "../../components/SettingsRows";
import { toast } from "../../components/Toast";
import { formatBytes } from "../../lib/format";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";

/**
 * 设置 → 缓存占用。
 *
 * `cover_cache_size` / `clear_cover_cache` / `clear_search_cache` 早已在
 * `lib.rs` 的 `generate_handler!` 里注册，但前端从未调用（`pnpm check` 的
 * `ipc-unused` INFO 点名）。封面缓存从 r25-O3 起有上限（400 张 / 128 MiB，
 * 写入后按最久未改动淘汰）；这一行把已有的查看/清理能力接上，不新增后端命令。
 *
 * 读大小在挂载时做一次；清理后立即重读，不缓存旧值。
 */
export function CacheUsageRow() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();

  const refresh = useCallback(async () => {
    try {
      const n = await invoke<number>("cover_cache_size");
      setBytes(n);
    } catch {
      setBytes(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearCover = useCallback(async () => {
    const ok = await confirmDestructive(t("settings.cache.confirmCover"), {
      title: t("settings.cache.confirmTitle"),
      okLabel: t("settings.cache.confirmOk"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const freed = await invoke<number>("clear_cover_cache");
      toast.success(t("settings.cache.coverCleared", { size: formatBytes(freed) }));
      await refresh();
    } catch (e) {
      toast.error(t("settings.cache.clearFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const clearSearch = useCallback(async () => {
    const ok = await confirmDestructive(t("settings.cache.confirmSearch"), {
      title: t("settings.cache.confirmSearchTitle"),
      okLabel: t("settings.cache.confirmOk"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await invoke("clear_search_cache");
      toast.success(t("settings.cache.searchCleared"));
    } catch (e) {
      toast.error(t("settings.cache.clearFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [t]);

  return (
    <>
      <ActionRow
        icon={<Database className="h-4 w-4" />}
        title={t("settings.cache.coverTitle")}
        hint={
          bytes === null
            ? t("settings.cache.coverUnknown")
            : t("settings.cache.coverUsage", { size: formatBytes(bytes) })
        }
        actionLabel={t("settings.cache.clear")}
        secondary
        disabled={busy || bytes === 0}
        onAction={() => void clearCover()}
      />
      <ActionRow
        icon={<Trash2 className="h-4 w-4" />}
        title={t("settings.cache.searchTitle")}
        hint={t("settings.cache.searchHint")}
        actionLabel={t("settings.cache.clear")}
        secondary
        disabled={busy}
        onAction={() => void clearSearch()}
      />
    </>
  );
}
