import { LoaderCircle, PackagePlus } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";

/**
 * Portable Git bootstrap dialog.
 *
 * Shown only when the machine has no usable git, because DevHub installs a
 * portable copy rather than asking the user to go install one. It states the
 * measured cost up front (57 MB download, ~400 MB on disk, 2-3 minutes) and that
 * no administrator rights are involved and the system git is untouched.
 */
export function BootstrapDialog({
  log,
  busy,
  error,
  onClose,
}: {
  log: string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <DialogShell
      title={t("boot.title")}
      subtitle={t("boot.subtitle")}
      onClose={busy ? () => undefined : onClose}
    >
      <p className="text-caption leading-relaxed text-muted-foreground">
        {t("boot.body")}
      </p>

      {busy && (
        <div role="status" className="mt-3 flex items-center gap-2 text-caption text-primary">
          <PackagePlus className="h-3.5 w-3.5" />
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {t("boot.running")}
        </div>
      )}

      <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-background p-3 text-caption leading-relaxed text-muted-foreground">
        {log.join("\n") || t("boot.preparing")}
      </pre>

      {error && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-caption leading-relaxed text-danger">
          {error}
        </div>
      )}
    </DialogShell>
  );
}

