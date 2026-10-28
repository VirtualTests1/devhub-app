import { Copy, Trash2, TriangleAlert } from "lucide-react";

import { ActionRow, SettingsGroup } from "../../components/SettingsRows";
import { toast } from "../../components/Toast";
import { confirmDestructive } from "../../lib/confirm";
import { useI18n } from "../../lib/useI18n";
import { useAppearance } from "../../store/appearance";
import { useFailures, type FailureEntry, type FailureKind } from "../../store/failures";
import { formatTime } from "../records/format";

/**
 * 设置 → 故障与诊断 (r18 N1).
 *
 * The panel behind `src/store/failures.ts`. Before it existed, a failure the
 * user was actually told about existed for at most six seconds (the toast) or
 * until the page went away (the fatal overlay's console line) — 需求 8
 * 「让失败可见」 fixed the telling, and this fixes the remembering. The row of
 * evidence a user needs for an issue is right here instead of in devtools they
 * do not have open.
 *
 * Reading is not the job: `reportError` and `main.tsx`'s `routeFatal` do the
 * recording (see `tests/failure-history-ui.test.ts`), and the store owns the
 * cap/fold rules (see `tests/failures-store.test.ts`). This file only draws
 * what is already in the store and offers copy/clear.
 *
 * Timestamps render through the same `formatTime` + 显示时间 setting as the
 * records page, so "今天 19:24:03" means the same thing wherever it is read.
 * `at` is epoch ms (the store's unit); `formatTime` wants seconds.
 */
type Translate = ReturnType<typeof useI18n>["t"];

/**
 * Kind → badge text.
 *
 * Three literal `t("…")` calls rather than `t(\`…${kind}\`)`: the dictionary
 * tests find "resolved keys" by scanning literal call sites, so a template key
 * would read as a registered-but-never-used entry and fail the gate.
 */
function kindLabel(t: Translate, kind: FailureKind): string {
  if (kind === "runtime") return t("settings.page.failureKind.runtime");
  if (kind === "rejection") return t("settings.page.failureKind.rejection");
  return t("settings.page.failureKind.command");
}

function lineOf(t: Translate, e: FailureEntry, timeFormat: string): string {
  const count = e.count > 1 ? ` ${t("settings.page.failuresCount", { n: e.count })}` : "";
  return `${formatTime(e.at / 1000, timeFormat)} [${kindLabel(t, e.kind)}] ${e.verb}：${e.text}${count}`;
}

export function FailureHistorySection() {
  const { t } = useI18n();
  const entries = useFailures((s) => s.entries);
  const clear = useFailures((s) => s.clear);
  const timeFormat = useAppearance((s) => s.recordTimeFormat);

  /** Same clipboard contract as every other copy action: success and failure
   *  both come back as a toast, and the failure copy says what to do instead. */
  async function copy(text: string[]) {
    try {
      await navigator.clipboard.writeText(text.join("\n"));
      toast.success(t("settings.page.failuresCopied"));
    } catch {
      toast.error(t("settings.page.failuresClipboardDenied"));
    }
  }

  async function onClear() {
    const ok = await confirmDestructive(t("settings.page.failuresClearConfirm"), {
      title: t("settings.page.failuresClearTitle"),
      okLabel: t("settings.page.clear"),
    });
    if (!ok) return;
    clear();
    toast.success(t("settings.page.failuresCleared"));
  }

  return (
    <SettingsGroup
      title={t("settings.section.diagnostics")}
      regId="settings-group-diagnostics"
      sectionId="diagnostics"
      footnote={t("settings.page.diagnosticsFootnote")}
    >
      {entries.length === 0 ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-caption text-muted-foreground">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span>{t("settings.page.failuresEmpty")}</span>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((e) => (
            <li
              // Two identical failures a millisecond apart are two rows by
              // design (the store only folds into the head), so the index is
              // part of the identity here.
              key={`${e.at}-${e.kind}-${e.verb}-${e.text}`}
              className="flex items-start gap-2 border border-border/60 bg-background/40 px-2.5 py-1.5"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger/80" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-caption text-muted-foreground">
                    {formatTime(e.at / 1000, timeFormat)}
                  </span>
                  <span className="border border-border px-1 text-caption text-muted-foreground">
                    {kindLabel(t, e.kind)}
                  </span>
                  <span className="text-caption font-medium text-foreground">{e.verb}</span>
                  {e.count > 1 && (
                    <span className="text-caption text-muted-foreground">
                      {t("settings.page.failuresCount", { n: e.count })}
                    </span>
                  )}
                </div>
                <p className="m-0 mt-0.5 break-words text-caption text-muted-foreground">{e.text}</p>
              </div>
              <button
                type="button"
                title={t("settings.page.failuresCopyRow")}
                aria-label={t("settings.page.failuresCopyRow")}
                onClick={() => void copy([lineOf(t, e, timeFormat)])}
                className="shrink-0 border border-transparent p-1 text-muted-foreground t-state hover:border-border hover:bg-accent hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ActionRow
        icon={<Copy className="h-4 w-4" />}
        title={t("settings.page.failuresCopyAll")}
        hint={t("settings.page.failuresCopyAllHint")}
        actionLabel={t("settings.page.failuresCopyAll")}
        onAction={() => void copy(entries.map((e) => lineOf(t, e, timeFormat)))}
        disabled={entries.length === 0}
        secondary
      />
      <ActionRow
        icon={<Trash2 className="h-4 w-4" />}
        title={t("settings.page.failuresClearTitle")}
        hint={t("settings.page.failuresClearHint")}
        actionLabel={t("settings.page.clear")}
        onAction={() => void onClear()}
        disabled={entries.length === 0}
        danger
      />
    </SettingsGroup>
  );
}
