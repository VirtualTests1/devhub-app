import { useEffect, useRef, useState } from "react";
import { ChevronDown, CodeXml, LoaderCircle } from "lucide-react";
import { useI18n } from "../../lib/useI18n";

/** Button with a right-side dropdown of concrete tool choices. */
export function SplitButton({
  icon,
  label,
  items,
  onPick,
  disabled,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  /** `icon` is the tool's own extracted icon when detection found one. */
  items: { id: string; label: string; icon?: string; hint?: string }[];
  onPick: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  /**
   * Round 13 (d5-3): the dropdown had no keyboard path at all — no Escape, no
   * arrows, focus stayed on the trigger, and the list carried no role. The app's
   * other two flyouts (`MenuSelect`, `ContextMenu`) implement the full contract;
   * this was the third hand-written one that skipped it. The contract below is
   * theirs, minus the prefix search (these lists are short): trigger opens
   * (ArrowUp on the last entry, like a native select), the list takes focus,
   * arrows/Home/End move, Enter/Space pick, Escape closes and hands focus back.
   */
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = "splitbutton-tools";

  useEffect(() => {
    if (open) listRef.current?.focus();
    else setActive(0);
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    onPick(id);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (disabled || items.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      if (e.key === "ArrowUp") setActive(Math.max(0, items.length - 1));
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = items.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => (i <= 0 ? last : i - 1));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(last);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (items[active]) pick(items[active].id);
        return;
      case "Escape":
        e.preventDefault();
        // The dialog also listens for Escape on the document (DialogShell);
        // consuming it here keeps the list from closing the whole dialog too.
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      case "Tab":
        // Leave without picking; the browser moves focus on its own.
        setOpen(false);
        return;
      default:
        break;
    }
  };

  return (
    <div className="relative flex">
      <button
        type="button"
        disabled={disabled || items.length === 0}
        title={items.length === 0 ? t("split.noToolsHint") : undefined}
        onClick={() => {
          const firstItem = items[0];
          if (firstItem) onPick(firstItem.id);
        }}
        className="flex items-center gap-2 rounded-l-lg border border-border px-3 py-2 text-body text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : icon}
        {label}
      </button>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || items.length === 0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        aria-label={t("split.pickTool")}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center rounded-r-lg border border-l-0 border-border px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          {/* click-away layer. aria-hidden + focusable is an axe violation, so
              tabIndex=-1 takes it out of the tab order like CustomizeLayer's. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            ref={listRef}
            role="listbox"
            aria-label={t("split.pickTool")}
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            tabIndex={-1}
            onKeyDown={onListKey}
            className="absolute left-0 top-full z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl outline-none"
          >
            {items.map((it, i) => (
              <button
                key={it.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                title={it.hint}
                onClick={() => pick(it.id)}
                onPointerMove={() => setActive(i)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-caption transition-colors hover:bg-accent hover:text-foreground ${
                  i === active ? "bg-accent text-foreground" : ""
                }`}
              >
                {it.icon ? (
                  <img
                    src={it.icon}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded"
                    width={16}
                    height={16}
                  />
                ) : (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <CodeXml className="h-2.5 w-2.5" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
              </button>
            ))}
            {items.length === 0 && (
              <p className="px-2 py-1.5 text-caption text-muted-foreground">{t("split.noTools")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
