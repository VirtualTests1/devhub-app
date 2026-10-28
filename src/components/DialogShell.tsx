import { ExternalLink, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useRef } from "react";
import { cn } from "../lib/utils";
import { useSelfClosing } from "../lib/motion";
import { applyModalInert } from "../lib/modal-inert";
import { useI18n } from "../lib/useI18n";
import { reg } from "../store/customize";

/** Focus trap / 初始焦点用的选择器：面板内所有可交互的后代。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog frame.
 *
 * The old build had four dialogs, each with its own padding, width, heading
 * markup and close button. They are structurally identical, so they now share one
 * frame: same width options, same header height, same scroll boundary, same
 * focus/hover treatment on the close button.
 *
 * Round 3 changed the header's information design. The 项目 panel used to show
 * the repository path three times — as the subtitle, as a full-width row, and
 * again inside that row's "在资源管理器打开" affordance — while the one thing it
 * never showed was a way to reach the project's page. So:
 *
 *   - `titleHref` turns the title into the link it should always have been,
 *     opened through the `opener` plugin rather than `window.open` (the webview
 *     has no meaningful "tab" to open).
 *   - `subheader` is a slot for one row of secondary actions where the duplicate
 *     path line used to be. It is a slot rather than a prop because what belongs
 *     there differs per dialog.
 */
export function DialogShell({
  title,
  subtitle,
  titleHref,
  subheader,
  onClose,
  width = "md",
  children,
  footer,
  regId,
}: {
  title: string;
  subtitle?: string;
  /** Opens in the system browser on click. */
  titleHref?: string;
  subheader?: React.ReactNode;
  onClose: () => void;
  width?: "md" | "lg" | "xl";
  children: React.ReactNode;
  footer?: React.ReactNode;
  regId?: string;
}) {
  // The parent unmounts this on `onClose`, so the exit has to be played before
  // the callback runs — otherwise a dialog appears with motion and leaves by
  // simply not being there anymore.
  const { leaving, close } = useSelfClosing(onClose);
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  // 按下点是否落在面板里：从面板内按住拖到遮罩再松手会触发遮罩上的 click，
  // 但那不是「点遮罩关闭」。以 pointerdown 的位置为准，click 只负责放行。
  const downInPanel = useRef(false);

  // `close` 每次渲染都是新闭包（useSelfClosing 读 leaving），放进 ref 里让
  // 键盘监听只在挂载时订阅一次。
  const closeLatest = useRef(close);
  closeLatest.current = close;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus({ preventScroll: true });

    // r20-O4-1: what the scrim covers stops being reachable, not merely hard to reach.
    // Restored on unmount, including the closing-animation unmount, so a dialog that
    // was open during a view change cannot leave the shell inert behind it.
    const scrim = scrimRef.current;
    const releaseInert = scrim
      ? applyModalInert(Array.from(scrim.parentElement?.children ?? []), scrim)
      : () => {};

    const onKey = (e: KeyboardEvent) => {
      const el = panelRef.current;
      if (!el) return;
      // 只响应发生在本面板内部的按键：两层对话框叠加时一次 Escape 不能全关。
      if (!el.contains(e.target as Node)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeLatest.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!el.contains(active)) {
        // 焦点漏到面板外（例如点了通知）：把它拽回入口处。
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      releaseInert();
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      ref={scrimRef}
      data-layer="scrim"
      data-state={leaving ? "closed" : "open"}
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 p-6 backdrop-blur-[var(--blur-scrim)]",
        leaving && "pointer-events-none",
      )}
      onPointerDown={(e) => {
        downInPanel.current = !!panelRef.current?.contains(e.target as Node);
      }}
      onClick={() => {
        if (downInPanel.current) {
          downInPanel.current = false;
          return;
        }
        close();
      }}
    >
      <div
        {...(regId ? reg(regId) : {})}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // r20-O4-2: the subtitle is what says *which* repository this dialog is about,
        // and a screen reader announces it only if the dialog points at it. Conditional
        // because `aria-describedby` referring to a node that does not exist is worse
        // than not having it.
        aria-describedby={subtitle ? subtitleId : undefined}
        data-layer="dialog"
        data-state={leaving ? "closed" : "open"}
        className={cn(
          "elevation-overlay flex max-h-[88vh] w-full flex-col overflow-hidden rounded-xl border border-border bg-card",
          width === "lg" ? "max-w-3xl" : width === "xl" ? "max-w-5xl" : "max-w-2xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border-weak px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {titleHref ? (
              <button
                type="button"
                id={titleId}
                {...reg("launch-title")}
                onClick={() => void openUrl(titleHref)}
                title={t("dialog.openInBrowser", { href: titleHref })}
                className="group flex min-w-0 items-center gap-1.5 text-left"
              >
                <span className="truncate text-view font-medium transition-colors group-hover:text-primary">
                  {title}
                </span>
                <span className="shrink-0 text-caption text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  <ExternalLink className="h-3 w-3" />
                </span>
              </button>
            ) : (
              <h2 id={titleId} className="truncate text-view font-medium">{title}</h2>
            )}
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 truncate text-caption text-muted-foreground" title={subtitle}>
                {subtitle}
              </p>
            )}
            {subheader && <div className="mt-1">{subheader}</div>}
          </div>
          <button
            type="button"
            ref={closeBtnRef}
            onClick={close}
            title={t("app.dismiss")}
            aria-label={t("app.dismiss")}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer && (
          <footer className="shrink-0 border-t border-border-weak px-4 py-3">{footer}</footer>
        )}
      </div>
    </div>
  );
}
