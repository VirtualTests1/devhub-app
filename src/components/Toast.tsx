import { useEffect, useRef } from "react";
import autoAnimate from "@formkit/auto-animate";
import { motionMs } from "../lib/motion";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "../lib/utils";
import { reg } from "../store/customize";
import { ensureTicker, useToast } from "../store/toast";
import { useI18n } from "../lib/useI18n";

// The queue itself lives in `store/toast.ts` so a non-DOM importer (the error
// reporter, and its Node test) can reach `toast.error` without pulling JSX into
// a runtime that cannot parse it. Re-exported here because every call site in
// the app already imports `toast` from this path.
export { toast, useToast } from "../store/toast";
export type { ToastItem, ToastKind } from "../store/toast";

/**
 * Global toast notifications — the drawing half.
 *
 * ## Round 9 (需求 5) — what changed and why
 *
 * The old host was top-right, showed up to four full-paragraph errors at once,
 * and kept errors on screen until clicked. The report was blunt: "内容部分…
 * 一大片的提示内容，占居大量视线区域…缺失自动消退功能，点一下才消失，这个
 * 功能逻辑也不太合理". Four changes, each backed by the conventions the round
 * researched (LogRocket/NNG on placement and duration; WCAG 2.2.1 on timing):
 *
 *   1. **Bottom-right.** The corner users expect, and the one that does not
 *      cover the title bar or the sidebar — the two places this app keeps its
 *      controls.
 *   2. **Everything auto-dismisses**, by kind (the durations live with the
 *      store now): an error that must be *seen* is a dialog's job (the Git
 *      gate and the root-blocked banner already are); a toast's job is to
 *      report and get out of the way.
 *   3. **Hover or focus pauses the countdown** (WCAG 2.2.1, Timing
 *      Adjustable). One ticker drives every visible toast; `paused` is a
 *      store flag the host flips on pointer enter/leave and focus in/out.
 *   4. **One line.** Long text is clamped to a single ellipsised line with
 *      the whole message in the tooltip — a toast is a headline, not a log.
 *      At most three are visible; a fourth pushes the oldest out.
 */

/** Single-line budget before the ellipsis takes over. */
const MAX_CHARS = 72;

/** The visible line: the whole message when it fits, a headline when it does not. */
function summaryOf(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_CHARS ? `${oneLine.slice(0, MAX_CHARS - 1)}…` : oneLine;
}

/**
 * Renders the current toasts, fixed to the bottom-right of the window.
 *
 * The host owns the pause: pointer-enter/leave and focus-in/out flip the store
 * flag, which freezes every countdown at once (WCAG: focusing one toast must
 * pause all of them, not just that one). Clicking a toast still dismisses it.
 */
export function ToastHost() {
  const items = useToast((s) => s.items);
  const dismiss = useToast((s) => s.dismiss);
  const setPaused = useToast((s) => s.setPaused);
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Defensive: if the ticker was ever cleared while items remained, the next
  // render would strand them on screen forever.
  useEffect(() => {
    if (items.length > 0) ensureTicker();
  }, [items.length]);

  // 需求 1：出现/消失动画。host 常驻（不再 items.length===0 就 return null），
  // 否则容器随通知一起挂载/卸载，auto-animate 无法观察到子节点的增减，
  // 消失动画也就无从播放。空 host 无子节点、pointer-events-none，不可见也不吃事件。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const controller = autoAnimate(el, { duration: motionMs("--motion-enter") });
    return () => controller.disable();
  }, []);

  return (
    <div
      ref={rootRef}
      {...reg("toast-host")}
      role="region"
      aria-label={t("toast.region")}
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[var(--z-toast)] flex w-80 flex-col gap-2"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {items.map((item) => (
        <div
          key={item.id}
          onClick={() => dismiss(item.id)}
          role={item.kind === "error" ? "alert" : undefined}
          className={cn(
            "pointer-events-auto flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-left text-caption shadow-lg backdrop-blur-sm t-state",
            item.kind === "success" && "border-success/30 bg-success/10 text-success",
            item.kind === "error" && "border-danger/30 bg-danger/10 text-danger",
            item.kind === "info" && "border-border bg-card text-foreground",
          )}
        >
          {item.kind === "success" && <Check className="h-3.5 w-3.5 shrink-0" />}
          {item.kind === "error" && <TriangleAlert className="h-3.5 w-3.5 shrink-0" />}
          {item.kind === "info" && <Info className="h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 truncate" title={item.text}>
            {summaryOf(item.text)}
          </span>
          {/* 真正的关闭 affordance：整行点击只有鼠标能用，键盘用户 Tab 进来
              按 Enter 关闭。宿主已有 onFocusCapture 暂停倒计时，正好满足
              WCAG 2.2.1 —— 焦点落到关闭按钮时通知不会自己消失。 */}
          <button
            type="button"
            aria-label={t("toast.close")}
            title={t("app.dismiss")}
            onClick={() => dismiss(item.id)}
            className="shrink-0 rounded p-0.5 text-current opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
