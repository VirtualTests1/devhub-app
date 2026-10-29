import { useEffect, useRef, useState } from "react";

import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";
import { WALL_VIEW_NAME_MAX, sanitiseViewName } from "../lib/wall-views";

/**
 * Name one saved wall view (r30-N1).
 *
 * A dialog rather than an inline field: a view name is the one part of this
 * feature the user authors, and an inline input in a toolbar that is already four
 * controls wide would either push the wall down or hide the name behind a menu.
 * The frame's own focus trap and Esc handling are also what make this keyboard-
 * finishable — the toolbar can be reached by Tab, and the name box is the first
 * focusable element.
 */
export function WallViewDialog({
  mode,
  initialName,
  onClose,
  onSubmit,
}: {
  mode: "save" | "rename";
  initialName?: string;
  onClose: () => void;
  /** Receives a trimmed, non-empty name. The caller owns duplicate/full feedback. */
  onSubmit: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clean = sanitiseViewName(name);

  // DialogShell focuses its close button on mount (the safe default for a panel
  // whose first element is a button). This dialog's only job is typing, so take
  // focus back after the frame's effect has run.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const submit = () => {
    if (!clean) return;
    onSubmit(clean);
  };

  return (
    <DialogShell
      title={mode === "save" ? t("wall.views.saveTitle") : t("wall.views.renameTitle")}
      onClose={onClose}
      width="md"
      regId="wall-view-dialog"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="skin-ctl px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("wall.views.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!clean}
            className="skin-ctl bg-primary px-2.5 py-1 text-caption text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {mode === "save" ? t("wall.views.saveAction") : t("wall.views.renameAction")}
          </button>
        </div>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-muted-foreground">{t("wall.views.nameLabel")}</span>
        <input
          ref={inputRef}
          value={name}
          maxLength={WALL_VIEW_NAME_MAX}
          placeholder={t("wall.views.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="skin-ctl border border-input bg-background px-2.5 py-1.5 text-body outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
        />
      </label>
      <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
        {t("wall.views.dialogHint")}
      </p>
    </DialogShell>
  );
}
