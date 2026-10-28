import { Clock } from "lucide-react";
import { ChoiceRow } from "../../components/SettingsRows";
import { useAppearance, type RecordTimeFormat } from "../../store/appearance";
import { useI18n } from "../../lib/useI18n";

/**
 * 记录页's 显示时间 switch, offered here so the 记录 group is complete.
 * Same control and same store as the records page's inline one: it is a
 * display fact (the stored `ts` never changes), so it applies immediately
 * instead of riding the dirty/save flow.
 */
export function TimeFormatRow() {
  const timeFormat = useAppearance((s) => s.recordTimeFormat);
  const setAppearance = useAppearance((s) => s.set);
  const { t } = useI18n();
  return (
    <ChoiceRow
      icon={<Clock className="h-4 w-4" />}
      title={t("records.time.title")}
      hint={t("settings.records.timeHint")}
      value={timeFormat}
      options={[
        { id: "relative", label: t("records.timeFormat.relative") },
        { id: "hm", label: t("records.timeFormat.hm") },
        { id: "hms", label: t("records.timeFormat.hms") },
        { id: "full", label: t("records.timeFormat.full") },
      ]}
      onChange={(id) => setAppearance("recordTimeFormat", id as RecordTimeFormat)}
    />
  );
}
