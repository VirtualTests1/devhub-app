import { cn } from "../lib/utils";

/**
 * Switch control.
 *
 * The old version drew a 20px pill with a white knob and, when off, still showed
 * a fairly bright knob on a grey track - which made "off" ambiguous at a glance.
 * This one gives each state a distinct *shape and fill*, not just a colour shift:
 *
 *   off: outlined track, knob on the LEFT, no fill
 *   on:  filled primary track, solid knob on the RIGHT
 *
 * Hit area is the whole row, so it is clickable well beyond the visual 36×20.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "border-border-weak bg-card hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors duration-[var(--motion-quick)]",
          checked ? "border-primary bg-primary" : "border-border bg-transparent",
        )}
      >
        <span
          className={cn(
            "h-3.5 w-3.5 rounded-full transition-transform duration-[var(--motion-quick)]",
            checked ? "translate-x-4 bg-primary-foreground" : "translate-x-0 bg-muted-foreground",
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-body font-medium">{label}</span>
        {hint && (
          <span className="app-desc mt-0.5 block text-caption leading-snug text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
