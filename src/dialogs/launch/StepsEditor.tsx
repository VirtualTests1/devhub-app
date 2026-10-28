import { Plus, Save, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { LaunchStep } from "../../types";
import { useI18n } from "../../lib/useI18n";
import { STEP_TEMPLATES } from "./effectiveSteps";
import { moveStep, withKeys, type KeyedStep } from "./step-keys";
import {
  deleteTemplate,
  loadUserTemplates,
  saveTemplate,
  type UserTemplate,
} from "../../lib/launch-templates";
import { useEffect, useState } from "react";

/**
 * Inline editor for the step list: name, command, cwd, 顺序/并行, add/remove.
 *
 * Rows are keyed by `uid` (see `step-keys.ts`), never by index. The editor holds
 * controlled inputs, so an index key makes React hand the same DOM node to
 * whichever step happens to sit in that slot: after 上移/下移 the caret and any
 * in-progress IME composition stay behind in the old row while the text moves on
 * — the input you were typing into is suddenly showing a different step.
 */
export function StepsEditor({
  steps,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  steps: KeyedStep[];
  onChange: (s: KeyedStep[]) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUserTemplates(loadUserTemplates());
  }, []);

  const update = (i: number, patch: Partial<LaunchStep>) => {
    // `{ ...s, ...patch }` carries `uid` along, which is what keeps the caret in
    // the input it was in. `patch` can never contain it: it is `Partial<LaunchStep>`.
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const move = (i: number, dir: -1 | 1) => onChange(moveStep(steps, i, dir));

  // Strip the editor-only `uid` before persisting: a template is a clean
  // LaunchStep list, same as what goes over IPC. The next apply re-keys it.
  const handleSaveAsTemplate = () => {
    if (steps.length === 0 || steps.some((s) => !s.command.trim())) return;
    setSaving(true);
    const label = window.prompt(t("steps.templateNamePrompt"));
    if (label === null) {
      setSaving(false);
      return;
    }
    const clean: LaunchStep[] = steps.map(({ uid: _uid, ...rest }) => rest);
    const created = saveTemplate(label || "", clean);
    setUserTemplates(loadUserTemplates());
    setSaving(false);
    // Keep the focus off the prompt's OK button; the editor stays usable.
    void created;
  };

  const handleDeleteTemplate = (id: string) => {
    deleteTemplate(id);
    setUserTemplates(loadUserTemplates());
  };

  const applyTemplate = (tplSteps: LaunchStep[]) => onChange(withKeys(tplSteps));

  return (
    <div className="mt-2 space-y-2">
      {steps.map((s, i) => (
        <div key={s.uid} className="rounded-lg border border-border-weak bg-card p-2">
          <div className="flex items-center gap-2">
            <input
              value={s.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder={t("steps.namePlaceholder", { n: i + 1 })}
              aria-label={t("steps.nameAria", { n: i + 1 })}
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-caption outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={() => update(i, { parallel: !s.parallel })}
              className={cn(
                "shrink-0 rounded px-2 py-1 text-caption transition-colors",
                s.parallel ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
              )}
              title={t("steps.modeHint")}
            >
              {s.parallel ? t("launch.parallel") : t("launch.sequential")}
            </button>
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="shrink-0 rounded px-1 py-1 text-caption text-muted-foreground hover:text-foreground disabled:opacity-30"
              title={t("steps.moveUp")}
              aria-label={t("steps.moveUpAria")}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === steps.length - 1}
              className="shrink-0 rounded px-1 py-1 text-caption text-muted-foreground hover:text-foreground disabled:opacity-30"
              title={t("steps.moveDown")}
              aria-label={t("steps.moveDownAria")}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
              title={t("steps.remove")}
              aria-label={t("steps.remove")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input
            value={s.command}
            onChange={(e) => update(i, { command: e.target.value })}
            placeholder={t("steps.commandPlaceholder")}
            aria-label={t("steps.commandAria", { n: i + 1 })}
            spellCheck={false}
            className="mt-1.5 w-full rounded border border-input bg-background px-2 py-1 font-mono text-caption outline-none focus:border-primary"
          />
          <input
            value={s.cwd}
            onChange={(e) => update(i, { cwd: e.target.value })}
            placeholder={t("steps.cwdPlaceholder")}
            aria-label={t("steps.cwdAria", { n: i + 1 })}
            spellCheck={false}
            className="mt-1.5 w-full rounded border border-input bg-background px-2 py-1 text-caption outline-none focus:border-primary"
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onChange(withKeys([...steps, { name: "", command: "", cwd: "", parallel: false }]))
          }
          className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("steps.add")}
        </button>

        {/* presets: the two-step "install then run" shape most repos need */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="app-desc text-caption text-muted-foreground">
            {t("steps.templatesLabel")}
          </span>
          {STEP_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              title={tpl.steps.map((s) => s.command).join("  →  ")}
              onClick={() => applyTemplate(tpl.steps)}
              className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
            >
              {tpl.label}
            </button>
          ))}
          {userTemplates.map((tpl) => (
            <span
              key={tpl.id}
              className="group inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2 py-0.5 text-caption text-primary"
              title={tpl.steps.map((s) => s.command).join("  →  ")}
            >
              <button
                type="button"
                onClick={() => applyTemplate(tpl.steps)}
                className="transition-opacity hover:opacity-80"
              >
                {tpl.label}
              </button>
              <button
                type="button"
                onClick={() => handleDeleteTemplate(tpl.id)}
                className="ml-0.5 rounded-full text-primary/60 transition-colors hover:bg-danger/20 hover:text-danger"
                aria-label={t("steps.deleteTemplateAria", { name: tpl.label })}
                title={t("steps.deleteTemplateAria", { name: tpl.label })}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={handleSaveAsTemplate}
            disabled={saving || steps.length === 0 || steps.some((s) => !s.command.trim())}
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            title={t("steps.saveTemplateHint")}
          >
            <Save className="h-2.5 w-2.5" />
            {t("steps.saveTemplate")}
          </button>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={busy || steps.length === 0 || steps.some((s) => !s.command.trim())}
            className="rounded-lg bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground disabled:opacity-40"
          >
            {t("steps.save")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-1.5 text-caption text-muted-foreground hover:bg-accent"
          >
            {t("launch.cancel")}
          </button>
        </div>
      </div>
      {steps.length === 0 && (
        <p className="text-caption text-warning">{t("steps.atLeastOne")}</p>
      )}
    </div>
  );
}
