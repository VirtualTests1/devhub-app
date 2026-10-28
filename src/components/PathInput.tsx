import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { cn } from "../lib/utils";
import { messageOf } from "../lib/report-error";
import { isCommitEnter } from "../lib/ime";
import { useI18n } from "../lib/useI18n";

/**
 * Text input with a native folder picker.
 *
 * Typing a Windows path by hand is error-prone and the folder browser is what
 * users expect; the text field stays editable so a path can also be pasted.
 *
 * `onCommit` fires when the field is left or Enter is pressed. It exists because a
 * path field that only takes effect after clicking a separate 保存 button reads as
 * broken: the user typed a new project directory, nothing happened, and the value
 * reverted on the next refresh. Enter only commits when no IME composition is open,
 * so picking a pinyin candidate never lands a half-typed path.
 *
 * `kind` decides what the native picker offers. The default is a folder browser,
 * which is right for a project root or a venv; 项目设置's cover picker needs a file
 * browser restricted to images, and a folder dialog would have been the wrong tool
 * wearing this component's clothes.
 */
export function PathInput({
  value,
  onChange,
  onCommit,
  placeholder,
  invalid,
  kind = "directory",
  pickerTitle,
  name,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  placeholder?: string;
  invalid?: boolean;
  kind?: "directory" | "image";
  pickerTitle?: string;
  /** Set on the input so a caller (and the CDP scenario) can find THIS field. */
  name?: string;
  /** The field's accessible name — placeholder alone is not one. */
  label?: string;
}) {
  const [pickerError, setPickerError] = useState<string | null>(null);
  const { t } = useI18n();

  const browse = async () => {
    setPickerError(null);
    try {
      const picked = await openDialog(
        kind === "image"
          ? {
              multiple: false,
              defaultPath: value || undefined,
              title: pickerTitle ?? t("path.pickCover"),
              filters: [{ name: t("path.images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
            }
          : {
              directory: true,
              multiple: false,
              defaultPath: value || undefined,
              title: pickerTitle ?? t("path.pickDir"),
            },
      );
      if (typeof picked === "string" && picked) {
        onChange(picked);
        // Picking a folder is a complete decision, so apply it at once.
        onCommit?.();
      }
    } catch (e) {
      setPickerError(t("path.pickerFailed", { msg: messageOf(e) }));
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={value}
          name={name}
          aria-label={label ?? placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onCommit?.()}
          onKeyDown={(e) => {
            // Enter commits the path, but only a real Enter: while an IME
            // candidate window is open Enter is picking a word, not finishing
            // the field, and committing then lands a half-typed path.
            if (isCommitEnter(e)) {
              e.preventDefault();
              onCommit?.();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 font-mono text-caption outline-none transition-colors focus:border-primary",
            invalid ? "border-warning/60" : "border-input",
          )}
        />
        <button
          type="button"
          onClick={() => void browse()}
          title={t("path.browseHint")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("settings.page.browse")}
        </button>
      </div>
      {pickerError && <p className="mt-1 text-caption text-danger">{pickerError}</p>}
    </div>
  );
}
