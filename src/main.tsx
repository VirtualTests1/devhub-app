import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installContextMenuGuard } from "./lib/context-menu";
import { decideFatal, rememberFatal, type FatalPhase } from "./lib/fatal-policy";
import { getLocale, tFor, type TFunc } from "./lib/i18n";
import { installQuotaStorage, type QuotaEvent } from "./lib/kv-store";
import { megabytes, nextStorageHealth, STORAGE_HEALTH_INITIAL } from "./lib/storage-health";
import { toast } from "./store/toast";
import { messageOf, reportError } from "./lib/report-error";
import { recordFailure, type FailureKind } from "./store/failures";
import { useUI } from "./store/ui";
import "./index.css";

/** Non-React translation edge for the bootstrap and fatal surfaces (no provider). */
const t: TFunc = (key, vars) => tFor(getLocale(), key, vars);

/**
 * Fatal-error overlay.
 *
 * Without this, any throw during render unmounts the whole tree and leaves a
 * blank window with no way to tell what happened - which is exactly what made an
 * earlier debugging round guess wrong. The overlay is part of the product, not
 * just a dev aid: a shipped build that silently shows nothing is worse than one
 * that says what broke.
 *
 * What it is NOT for, since round 12 (让失败可见 8.1): anything after boot.
 * `root.innerHTML = ""` is a teardown, and wiring it to `unhandledrejection`
 * meant the one missing `.catch` anywhere in the app replaced a running window
 * with a stack dump. Post-boot failures go to the app's own error surface —
 * see `routeFatal` and `lib/fatal-policy.ts`.
 */
let overlayInstalled = false;

function showFatal(title: string, detail: unknown) {
  // Twice is never acceptable: the second call used to wipe a dump the user was
  // mid-way through reading. The DOM check covers the case where this module was
  // evaluated again (a dev reload) while the first overlay stayed on screen.
  if (overlayInstalled || document.getElementById("fatal-overlay")) return;
  const root = document.getElementById("root");
  if (!root) return;
  overlayInstalled = true;
  const text = detail instanceof Error ? `${detail.message}\n\n${detail.stack ?? ""}` : String(detail);
  root.innerHTML = "";
  const box = document.createElement("div");
  box.id = "fatal-overlay";
  box.setAttribute(
    "style",
    // var() with the old hex as fallback: by the time this runs the stylesheet
    // has usually loaded, but a boot-time failure paints before it — the
    // fallback is that case. Tokens, not hex, are what the rest of the app uses.
    "padding:24px;font:12px/1.6 ui-monospace,Consolas,monospace;color:var(--color-danger, #fca5a5);background:var(--color-background, #0c0d10);height:100%;overflow:auto;white-space:pre-wrap",
  );
  box.textContent = `${title}\n\n${text}`;
  root.appendChild(box);
}

/**
 * The one router for things that escaped every `catch`.
 *
 * `phase` is the whole boot/running distinction, and it flips when the first
 * real frame is on screen (`dissolveBoot`). `seenFailures` is why a poll failing
 * every three seconds produces one toast instead of a wall: the queue holds
 * three, so the repeats would push the *other* failures off screen with
 * duplicates of a message already read.
 *
 * Every branch except `skip` also writes into the failure history (r18 N1),
 * because neither destination remembers: the overlay replaces the page, and a
 * toast disappears after six seconds. The overlay branch records directly (no
 * toast exists to ride); the report branch rides `reportError`, which the
 * command call sites use too. `skip` records nothing on purpose — the failure
 * it dedupes was recorded seconds ago, and the store's own 10-second fold is
 * what keeps a burst's count roughly right without double-writing.
 *
 * The console line is unconditional and comes first, in both phases: routing a
 * failure to a toast must not lose the stack that explains it.
 */
let phase: FatalPhase = "boot";
let seenFailures = new Map<string, number>();

function routeFatal(title: string, verb: string, reason: unknown, kind: FailureKind): void {
  const now = Date.now();
  const verdict = decideFatal({ reason, phase, now, seen: seenFailures });
  if (verdict.action === "skip") return;
  if (verdict.action === "overlay") {
    recordFailure(kind, verb, messageOf(reason));
    showFatal(title, reason);
    return;
  }
  seenFailures = rememberFatal(seenFailures, verdict.key, now);
  reportError(reason, verb, kind);
}

function markBooted() {
  phase = "running";
}

// A dev reload re-evaluates this module without discarding the listeners the
// previous copy installed, so each reload would stack another pair — and a
// rejection would then be reported once per copy of the module. The flag lives on
// `window` precisely because module state is what gets reset.
if (!window.__devhubFatalWired) {
  window.__devhubFatalWired = true;

  window.addEventListener("error", (e) => {
    const reason = e.error ?? e.message;
    console.error("[devhub] runtime error", reason);
    routeFatal(
      t("app.fatal.runtimeTitle"),
      t("app.fatal.runtimeOk"),
      reason,
      "runtime",
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[devhub] unhandled promise rejection", e.reason);
    routeFatal(
      t("app.fatal.rejectionTitle"),
      t("app.fatal.rejectionOk"),
      e.reason,
      "rejection",
    );
    // Post-boot the app handled it — through its own surface, on purpose. Leaving
    // the event unhandled would print a second, uglier copy of the same thing in
    // devtools next to the toast the user is meant to read.
    if (phase === "running") e.preventDefault();
  });
}

/**
 * The boot surface index.html paints.
 *
 * It is a sibling of `#root`, so React mounting does not remove it - this file
 * does, after the first frame of the real UI is on screen. Dissolving rather than
 * unmounting matters on a cold dev start, where the wait is long enough that the
 * switch is watched: a hard cut reads as a second reload.
 */
declare global {
  interface Window {
    __devhubBoot?: {
      setPhase(text: string): void;
      tick(): void;
      timer?: number;
    };
    /**
     * Debug handle for the CDP scenarios, DEV builds only. Declared rather than
     * cast at the assignment: `(window as unknown as { … })` was the last double
     * cast in the entry file, and a declared optional property says the same thing
     * with a type the rest of the file can also read.
     */
    __devhubUI?: typeof useUI;
    /**
     * Set once the fatal listeners exist. Declared rather than cast for the same
     * reason as `__devhubUI`: this file has no `as unknown as` left in it, and a
     * reload-safe flag is exactly the kind of thing module state cannot be.
     */
    __devhubFatalWired?: boolean;
  }
}

function dissolveBoot() {
  const boot = document.getElementById("boot");
  if (!boot) return;
  window.__devhubBoot?.setPhase(t("app.boot.ready"));
  boot.dataset.leaving = "1";
  window.setTimeout(() => {
    boot.remove();
    window.__devhubBoot = undefined;
  }, 320);
}

/**
 * Suppress the WebView2 default page menu.
 *
 * Rule and rationale live in `lib/context-menu.ts` so `index.html`'s pre-React
 * guard and this one cannot drift apart; this is the single install call.
 */
installContextMenuGuard();

/**
 * Quota tripwire over the persisted prefs (r21 R3-3).
 *
 * The inventory in `docs/r21-storage-eval.md` measured all 11 keys at 740 bytes
 * on a fresh profile and 39 KB of *bounded* upper bound — two orders of magnitude
 * under the 5 MiB localStorage quota — so this round's decision is (a): keep
 * localStorage and instrument it rather than migrate. What can actually grow is
 * the handful of unbounded keys (wall repos, customize overrides, the two
 * template lists), which is exactly what this line watches.
 *
 * 1 MiB is deliberately far above the bounded ceiling (25x) so a healthy profile
 * never reaches it, and deliberately far below the quota (about a fifth) so a
 * runaway list is reported with room to spare rather than after the first refused
 * write. Reaching it is the documented trigger to re-evaluate migration, not a
 * user-facing failure: the event only logs, because this round ships no new UI
 * and there is no existing i18n key for "storage is nearly full".
 */
const STORAGE_WARN_BYTES = 1024 * 1024;

let storageHealth = STORAGE_HEALTH_INITIAL;

function onStorageQuotaEvent(event: QuotaEvent): void {
  const decision = nextStorageHealth(storageHealth, event, Date.now());
  storageHealth = decision.state;
  if (!decision.announce) {
    // Still on the console: the de-duplication is about the user's screen, not
    // about hiding the evidence from a developer.
    console.warn(`[devhub] storage ${event.reason} while writing ${event.key}`);
    return;
  }
  if (event.reason === "threshold") {
    toast.info(t("storageHealth.threshold", { mb: megabytes(event.bytes) }));
  } else {
    toast.error(t("storageHealth.writeError", { key: event.key }));
  }
  console.warn(`[devhub] storage ${event.reason} while writing ${event.key}`, event.error);
}

installQuotaStorage({ warnAtBytes: STORAGE_WARN_BYTES, onError: onStorageQuotaEvent });

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    // Keep it in the console too, so devtools still shows the component trace.
    console.error(error);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            font: "12px/1.6 ui-monospace, Consolas, monospace",
            // The stylesheet is guaranteed present at this point (the boundary
            // only renders after mount), so the token needs no fallback.
            color: "var(--color-danger)",
            height: "100%",
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {t("app.crash.body", {
            msg: this.state.error.message,
            stack: this.state.error.stack ?? "",
          })}
        </div>
      );
    }
    return this.props.children;
  }
}

window.__devhubBoot?.setPhase(t("app.boot.rendering"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// After the frame in which React's first paint reaches the screen. Waiting for a
// real frame is the point: dissolving synchronously here would uncover a tree
// that has not been drawn yet, which is the flash this whole surface exists to
// avoid. The same frame is what makes `phase` flip to `running` — from here on a
// rejection is a failure inside a working app, not a boot failure, and the
// overlay must not be used for it.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    markBooted();
    dissolveBoot();
  }),
);

if (import.meta.env.DEV) {
  // Debug handle for the CDP scenarios: the history stack is exactly the kind of
  // state a screenshot cannot show, and without it a probe has to infer the stack
  // from which nav item is highlighted.
  window.__devhubUI = useUI;
}
