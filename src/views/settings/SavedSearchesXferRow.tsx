import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, Upload } from "lucide-react";
import { ActionRow } from "../../components/SettingsRows";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";
import { normalizeSearch, useSavedSearches, type SavedSearch } from "../../store/searches";

/**
 * 设置 → 导出 / 导入收藏的搜索（r17-n1）。
 *
 * 收藏搜索原本只存在 localStorage（`devhub.searches.v1`），换机/重装就没了。
 * 这里把它跟设置导出并列：导出写一个 JSON，导入用同一份 normalizeSearch 校验后
 * 合并（已有的按 key 去重，新的插到前面）。不碰项目根、不碰 Token。
 */
export function SavedSearchesXferRow() {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const items = useSavedSearches((s) => s.items);
  const save = useSavedSearches((s) => s.save);

  const doExport = useCallback(async () => {
    if (items.length === 0) {
      toast.error(t("settings.searches.empty"));
      return;
    }
    const picked = await saveDialog({
      title: t("settings.searches.exportTitle"),
      defaultPath: "devhub-saved-searches.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    setBusy(true);
    try {
      await invoke("write_text_file", {
        path: picked,
        text: JSON.stringify({ version: 1, kind: "devhub-saved-searches", items }, null, 2),
      });
      toast.success(t("settings.searches.exported", { n: items.length }));
    } catch (e) {
      toast.error(t("settings.searches.exportFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [items, t]);

  const doImport = useCallback(async () => {
    const picked = await openDialog({
      title: t("settings.searches.importTitle"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    setBusy(true);
    try {
      const text = await invoke<string>("read_text_file", { path });
      const parsed: unknown = JSON.parse(text);
      const list = (parsed as { items?: unknown })?.items;
      if (!Array.isArray(list)) {
        toast.error(t("settings.searches.noList"));
        return;
      }
      let added = 0;
      for (const raw of list as unknown[]) {
        const s: SavedSearch | null = normalizeSearch(raw);
        if (s) {
          save(s);
          added++;
        }
      }
      if (added === 0) toast.error(t("settings.searches.none"));
      else toast.success(t("settings.searches.imported", { n: added }));
    } catch (e) {
      toast.error(t("settings.searches.importFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [save, t]);

  return (
    <>
      <ActionRow
        icon={<Download className="h-4 w-4" />}
        title={t("settings.searches.exportTitle")}
        hint={t("settings.searches.exportHint")}
        actionLabel={t("settings.searches.export")}
        secondary
        disabled={busy || items.length === 0}
        onAction={() => void doExport()}
      />
      <ActionRow
        icon={<Upload className="h-4 w-4" />}
        title={t("settings.searches.importTitle")}
        hint={t("settings.searches.importHint")}
        actionLabel={t("settings.searches.import")}
        secondary
        disabled={busy}
        onAction={() => void doImport()}
      />
    </>
  );
}
