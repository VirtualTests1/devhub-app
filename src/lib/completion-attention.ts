/**
 * When a background completion should ask for the user's attention (r27-N3).
 *
 * The queue already produces toasts, but a toast in an unfocused window is
 * invisible. Windows' taskbar flash is the right channel for that case and the
 * wrong one for a window the user is already looking at, so the decision is a
 * pure function of focus, the user's setting, the outcome and a small throttle.
 *
 * Failure is never throttled: a failed clone is the one event that must survive
 * a burst. Success is throttled so ten finishes in a batch do not flash ten times.
 */
export type AttentionLevel = "none" | "informational" | "critical";

export type AttentionInput = {
  /** `document.hasFocus()` — the webview's own answer, no IPC needed. */
  focused: boolean;
  /** The 设置 → 界面 switch. */
  enabled: boolean;
  outcome: "success" | "failure";
  now: number;
  /** When this module last asked for attention (0 = never). */
  lastAt: number;
  /** Minimum gap between two *success* flashes. */
  minGapMs?: number;
};

export type AttentionDecision = { level: AttentionLevel; lastAt: number };

export const ATTENTION_MIN_GAP_MS = 15_000;

export function decideAttention(input: AttentionInput): AttentionDecision {
  if (!input.enabled || input.focused) return { level: "none", lastAt: input.lastAt };
  if (input.outcome === "failure") {
    return { level: "critical", lastAt: input.now };
  }
  const gap = Math.max(0, input.minGapMs ?? ATTENTION_MIN_GAP_MS);
  if (input.lastAt > 0 && input.now - input.lastAt < gap) {
    return { level: "none", lastAt: input.lastAt };
  }
  return { level: "informational", lastAt: input.now };
}
