import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, Upload } from "lucide-react";
import { ActionRow } from "../../components/SettingsRows";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";
import type { SettingsView } from "../../types";
import { buildXfer, parseXfer } from "./settings-xfer";

/**
 * 设置 → 导出 / 导入设置.
 *
 * Export writes a JSON file of the portable fields; import reads one back and
 * hands the validated patch to the page's own save path (so root-change notes,
 * validation and the status light all behave exactly as if the user had typed
 * the values). The GitHub token is never included in either direction.
 */
export function SettingsXferRow({
  settings,
  onImport,
}: {
  settings: SettingsView | null;
  onImport: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();

  const doExport = useCallback(async () => {
    const payload = buildXfer(settings);
    if (!payload) {
      toast.error(t("settings.xfer.notLoaded"));
      return;
    }
    const picked = await saveDialog({
      title: t("settings.xfer.exportTitle"),
      defaultPath: "devhub-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    setBusy(true);
    try {
      await invoke("write_text_file", {
        path: picked,
        text: JSON.stringify(payload, null, 2),
      });
      toast.success(t("settings.xfer.exported"));
    } catch (e) {
      toast.error(t("settings.xfer.exportFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [settings, t]);

  const doImport = useCallback(async () => {
    const picked = await openDialog({
      title: t("settings.xfer.importTitle"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    setBusy(true);
    try {
      const text = await invoke<string>("read_text_file", { path });
      const { patch, dropped } = parseXfer(text);
      if (Object.keys(patch).length === 0) {
        toast.error(t("settings.xfer.noFields"));
        return;
      }
      await onImport(patch);
      if (dropped.length > 0) {
        toast.success(
          t("settings.xfer.importedDropped", { fields: dropped.join(t("settings.xfer.dropSep")) }),
        );
      }
    } catch (e) {
      toast.error(t("settings.xfer.importFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  }, [onImport, t]);

  return (
    <>
      <ActionRow
        icon={<Download className="h-4 w-4" />}
        title={t("settings.xfer.exportTitle")}
        hint={t("settings.xfer.exportHint")}
        actionLabel={t("settings.xfer.export")}
        secondary
        disabled={busy || !settings}
        onAction={() => void doExport()}
      />
      <ActionRow
        icon={<Upload className="h-4 w-4" />}
        title={t("settings.xfer.importTitle")}
        hint={t("settings.xfer.importHint")}
        actionLabel={t("settings.xfer.import")}
        secondary
        disabled={busy}
        onAction={() => void doImport()}
      />
    </>
  );
}
