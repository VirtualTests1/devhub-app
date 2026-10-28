import { useEffect, useState } from "react";
import { CircleCheck, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { ActionRow } from "../../components/SettingsRows";
import { useI18n } from "../../lib/useI18n";

/** A row that is a heading for the list under it, not a setting itself. */
export function SettingHeadingRow({
  title,
  hint,
  onBrowse,
}: {
  title: string;
  hint: string;
  onBrowse: () => void;
}) {
  const { t } = useI18n();
  return (
    <ActionRow
      icon={<SlidersHorizontal className="h-4 w-4" />}
      title={title}
      hint={hint}
      actionLabel={t("settings.page.browse")}
      secondary
      onAction={onBrowse}
    />
  );
}

/** A compact list item inside a group panel - a path with its remove button. */
export function SettingRowLite({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 pl-11 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak">
      {children}
    </div>
  );
}

/**
 * 需求2：页头右侧取代了原来的「保存」按钮。
 *
 * 它只报告**还没写下去**的那一小段时间。之所以需要一个指示器而不是纯静默：
 * 自动保存最令人不安的不是"它不告诉我"，而是"我不知道刚才那一改到底算不算
 * 数"。一个会自己回到「已保存」的状态灯把这件事说清楚了。
 */
export function SaveIndicator({
  busy,
  queued,
  blocked,
}: {
  busy: boolean;
  queued: boolean;
  blocked: boolean;
}) {
  const [shown, setShown] = useState(false);
  const { t } = useI18n();
  // Hold 「已保存」 for a moment. A flash that vanishes in one frame is not a
  // confirmation, it is a flicker.
  useEffect(() => {
    if (busy || queued) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), 200);
    return () => window.clearTimeout(t);
  }, [busy, queued]);

  // The wrapper is always in the DOM: a live region that mounts and unmounts
  // with its content never announces the first change.
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-1.5">
      {blocked ? (
        <>
          <TriangleAlert className="h-3.5 w-3.5" />
          {t("settings.page.save.blocked")}
        </>
      ) : busy ? (
        t("settings.page.save.busy")
      ) : queued ? (
        <span className="text-warning">{t("settings.page.save.queued")}</span>
      ) : shown ? (
        <>
          <CircleCheck className="h-3.5 w-3.5 text-success/80" />
          {t("settings.page.save.done")}
        </>
      ) : (
        t("settings.page.save.idle")
      )}
    </span>
  );
}
