/**
 * The 快捷键 panel (r20-N1-3).
 *
 * Two jobs, both of which the ad-hoc handlers could not do: show what a key does, and
 * let a person change it. Showing is possible because the actions live in one table
 * (`src/lib/shortcut-actions.ts`); changing is possible because the bindings are data
 * (`src/lib/shortcut-bindings.ts`). This component is only the view — no matching, no
 * conflict logic, no chord parsing lives here, so `tests/shortcuts.test.ts` and
 * `tests/shortcut-bindings.test.ts` remain the whole proof of the behaviour.
 *
 * Every string comes from `t()`; the repo's ratchet
 * (`tests/zh-hardcode-ratchet.test.ts`) counts Chinese literals in the `.tsx` files
 * under `src/` and only ever allows that number down.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { DialogShell } from "./DialogShell";
import { SHORTCUT_ACTIONS, SHORTCUT_GROUPS } from "../lib/shortcut-actions";
import {
  clearBinding,
  currentKeyMap,
  defaultChord,
  resetBindings,
  setBinding,
} from "../lib/shortcut-bindings";
import { chordFromEvent, formatChord } from "../lib/shortcuts";
import { useI18n } from "../lib/useI18n";

type Props = { onClose: () => void };

export function ShortcutHelpDialog({ onClose }: Props) {
  const { t } = useI18n();
  // A tick rather than the map itself: `currentKeyMap()` reads localStorage, and the
  // only writes are the ones this panel makes, so a counter is a sufficient and honest
  // invalidation signal — no subscription, no store, nothing that can drift from the
  // shell's copy of the truth. The read below is direct rather than memoised: a
  // `useMemo` here would depend ONLY on the counter (an invalidation trigger, not a
  // value the callback reads) — the exact shape `react-hooks/exhaustive-deps` rejects,
  // and a new eslint-disable to silence it would trip check-lint's ratchet.
  const [, setRevision] = useState(0);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { bindings, conflicts } = currentKeyMap();

  // Labels are resolved through literal `t()` calls, not `t(action.labelKey)`.
  // This repo's i18n guard (`tests/i18n.test.ts`) fails any dictionary key that no
  // call site names — a computed lookup is invisible to it, and "registered but
  // never read" is precisely the debt that rule exists to catch. The table below is
  // the price of keeping the guard honest.
  const labels = useMemo<Record<string, string>>(
    () => ({
      "shortcut.palette": t("shortcut.palette"),
      "shortcut.back": t("shortcut.back"),
      "shortcut.forward": t("shortcut.forward"),
      "shortcut.viewProjects": t("shortcut.viewProjects"),
      "shortcut.viewAdd": t("shortcut.viewAdd"),
      "shortcut.viewFrequent": t("shortcut.viewFrequent"),
      "shortcut.viewRecords": t("shortcut.viewRecords"),
      "shortcut.viewSettings": t("shortcut.viewSettings"),
      "shortcut.help": t("shortcut.help"),
    }),
    [t],
  );
  const groupLabels = useMemo<Record<string, string>>(
    () => ({
      nav: t("shortcut.groupNav"),
      layer: t("shortcut.groupLayer"),
      help: t("shortcut.groupHelp"),
    }),
    [t],
  );

  const finishCapture = useCallback((chordText: string) => {
    setCapturing((id) => {
      if (!id) return id;
      const result = setBinding(id, chordText);
      setNotice(
        result.ok
          ? result.over.length > 0
            ? t("shortcutHelp.takenFrom", { names: result.over.join(", ") })
            : null
          : t("shortcutHelp.unparsable", { chord: chordText }),
      );
      return null;
    });
    setRevision((r) => r + 1);
  }, [t]);

  // While capturing, the panel owns the keyboard: one keydown becomes one chord.
  // Capture phase and `preventDefault`, because a bare `Alt+2` would otherwise also
  // fire the shell's own (now superseded) binding for 切到添加.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      // A lone modifier is not a chord; keep waiting instead of reporting an error the
      // user did not cause.
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      finishCapture(formatChord(chordFromEvent(e)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, finishCapture]);

  const conflictLines = Object.entries(conflicts).map(([chord, ids]) =>
    t("shortcutHelp.conflict", {
      chord,
      names: ids
        .map((id) => SHORTCUT_ACTIONS.find((a) => a.id === id))
        .filter((a): a is (typeof SHORTCUT_ACTIONS)[number] => !!a)
        .map((a) => labels[a.labelKey])
        .join(", "),
    }),
  );

  return (
    <DialogShell
      title={t("dialog.shortcutHelp")}
      subtitle={t("shortcutHelp.subtitle")}
      onClose={onClose}
      regId="shell-shortcut-help"
      width="md"
      footer={
        <button
          type="button"
          className="skin-ctl border border-border px-3 py-1 text-caption text-muted-foreground
                     hover:bg-accent hover:text-foreground active:scale-[0.98]"
          onClick={() => {
            resetBindings();
            setNotice(null);
            setRevision((r) => r + 1);
          }}
        >
          {t("shortcutHelp.resetAll")}
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        {conflictLines.length > 0 && (
          <ul className="text-caption text-danger" aria-live="polite">
            {conflictLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {notice && <p className="text-caption text-muted-foreground">{notice}</p>}
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group} className="min-w-0">
            <h3 className="skin-label mb-1 text-caption text-muted-foreground">
              {groupLabels[group]}
            </h3>
            <ul className="flex flex-col gap-1">
              {SHORTCUT_ACTIONS.filter((a) => a.group === group).map((a) => {
                const chord = bindings[a.id] ?? "";
                const customized = chord !== (defaultChord(a.id) ?? "");
                return (
                  <li key={a.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      className="skin-ctl min-w-0 flex-1 truncate rounded border border-border-weak
                                 bg-card px-2 py-1 text-left text-caption text-foreground
                                 hover:bg-accent active:scale-[0.99]"
                      onClick={() => setCapturing(a.id)}
                      aria-label={t("shortcutHelp.pressToRebind")}
                    >
                      {labels[a.labelKey]}
                    </button>
                    <span
                      className="tabular-nums rounded border border-border-weak px-2 py-0.5 text-caption
                                 text-foreground"
                      data-capturing={capturing === a.id ? "true" : "false"}
                    >
                      {capturing === a.id ? t("shortcutHelp.capturing") : chord}
                    </span>
                    {customized && (
                      <span className="text-caption text-muted-foreground">
                        {t("shortcutHelp.customized")}
                      </span>
                    )}
                    <button
                      type="button"
                      className="skin-ctl shrink-0 rounded border border-border-weak px-2 py-0.5
                                 text-caption text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        clearBinding(a.id);
                        setNotice(null);
                        setRevision((r) => r + 1);
                      }}
                    >
                      {t("shortcutHelp.resetOne")}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </DialogShell>
  );
}
