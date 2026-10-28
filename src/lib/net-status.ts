import type { TFunc } from "./i18n";

/** The three verdicts the Rust probe can return. */
export type NetState = "online" | "degraded" | "offline";

/** What `net_status` answers, after the Rust serde boundary. */
export type NetStatusReport = {
  state: NetState;
  resolved: boolean;
  connected: boolean;
  latencyMs: number | null;
};

/** The strip's polling cadence. The backend cache is deliberately shorter. */
export const NET_POLL_MS = 60_000;

/**
 * The payload guard at the IPC seam.
 *
 * A typed `invoke<NetStatusReport>` is a promise about the backend, not a runtime
 * check. A stale binary, a rename on one side, or a malformed answer would
 * otherwise reach `describeNetStatus` and paint a claim from fields that are not
 * there. Rejecting the whole report makes the UI say "untested", which is the
 * only honest answer when the probe did not produce a usable verdict.
 *
 * The state/field agreement is part of the contract, not decoration: `offline`
 * means DNS never answered, so it cannot carry a latency; `online` means DNS
 * answered and TCP connected; `degraded` requires a resolved address. A report
 * that contradicts itself is treated like no report at all.
 */
export function parseNetStatus(value: unknown): NetStatusReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (
    report.state !== "online" &&
    report.state !== "degraded" &&
    report.state !== "offline"
  ) {
    return null;
  }
  if (typeof report.resolved !== "boolean" || typeof report.connected !== "boolean") {
    return null;
  }
  const latency = report.latencyMs;
  if (
    latency !== null &&
    (typeof latency !== "number" ||
      !Number.isFinite(latency) ||
      !Number.isInteger(latency) ||
      latency < 0)
  ) {
    return null;
  }
  if (report.state === "offline") {
    if (report.resolved || report.connected || latency !== null) return null;
  } else if (!report.resolved || typeof latency !== "number") {
    return null;
  }
  if (report.state === "online" && !report.connected) return null;
  return {
    state: report.state,
    resolved: report.resolved,
    connected: report.connected,
    latencyMs: latency,
  };
}

export type NetTone = "ok" | "warn" | "danger" | "muted";

export type NetStatusView = {
  label: string;
  title: string;
  tone: NetTone;
};

function measuredTitle(latencyMs: number, t: TFunc): string {
  return `${t("strip.netLatency", { ms: latencyMs })} · ${t("strip.netRetry")}`;
}

/**
 * The strip's words for one report.
 *
 * `null` is "not measured", never "offline": an IPC rejection and a probe that
 * has not landed yet are both unknown, and showing the previous verdict would
 * turn a dead command into a live-looking claim. The label names GitHub because
 * the probe measures `github.com:443`, not the whole internet.
 */
export function describeNetStatus(
  status: NetStatusReport | null,
  t: TFunc,
): NetStatusView {
  if (status === null) {
    return { label: t("strip.netUnknown"), title: t("strip.netRetry"), tone: "muted" };
  }
  switch (status.state) {
    case "online":
      return {
        label: t("strip.netOnline"),
        title: status.latencyMs === null ? t("strip.netRetry") : measuredTitle(status.latencyMs, t),
        tone: "ok",
      };
    case "degraded":
      return {
        label: t("strip.netDegraded"),
        title: status.latencyMs === null ? t("strip.netRetry") : measuredTitle(status.latencyMs, t),
        tone: "warn",
      };
    case "offline":
      return { label: t("strip.netOffline"), title: t("strip.netRetry"), tone: "danger" };
  }
}

export type NetStatusPollerOptions = {
  /** One probe. `force` asks the backend to bypass its short cache. */
  probe: (force: boolean) => Promise<unknown>;
  onResult: (value: unknown) => void;
  onError: (err: unknown) => void;
  everyMs?: number;
  schedule: (cb: () => void, ms: number) => number;
  unschedule: (id: number) => void;
  isVisible: () => boolean;
};

export type NetStatusPoller = {
  /** Starts the first probe when visible, and is idempotent. */
  start: () => void;
  /** Stops the timer and makes an in-flight answer land nowhere. */
  stop: () => void;
  /** Probes now. A click passes `true`; focus and visibility pass `false`. */
  refresh: (force?: boolean) => void;
  /** Pauses polling while hidden and probes immediately when shown again. */
  setVisible: (visible: boolean) => void;
};

/**
 * A 60-second poll with the two races named in the contract:
 *
 *   * A probe that settles after `stop` writes nothing and schedules nothing.
 *   * A forced probe that arrives while one is in flight is coalesced into one
 *     trailing forced probe instead of stacking concurrent `net_status` calls. A
 *     burst of clicks cannot outrun the 2.5 s backend budget. Non-forced nudges
 *     (focus, visibility) are dropped while a probe is already running: that
 *     probe is the fresh answer they were asking for.
 *
 * Hidden windows do not poll. The in-flight answer is still delivered if it
 * lands before `stop`, but the next timer is not armed while hidden; becoming
 * visible probes at once.
 */
export function createNetStatusPoller(opts: NetStatusPollerOptions): NetStatusPoller {
  const everyMs = opts.everyMs ?? NET_POLL_MS;
  let started = false;
  let stopped = false;
  let visible = opts.isVisible();
  let timer: number | null = null;
  let inFlight = false;
  let queued = false;
  let token = 0;

  const clearTimer = () => {
    if (timer !== null) {
      opts.unschedule(timer);
      timer = null;
    }
  };

  function afterSettle(): void {
    if (stopped) return;
    if (queued) {
      queued = false;
      startProbe(true);
      return;
    }
    if (!visible) return;
    timer = opts.schedule(() => {
      timer = null;
      startProbe(false);
    }, everyMs);
  }

  function startProbe(force: boolean): void {
    if (stopped || !started) return;
    clearTimer();
    if (!visible) return;
    if (inFlight) {
      if (!force) return;
      queued = true;
      return;
    }
    inFlight = true;
    const mine = ++token;
    Promise.resolve()
      .then(() => opts.probe(force))
      .then(
        (value) => {
          if (stopped || mine !== token) return;
          inFlight = false;
          try {
            opts.onResult(value);
          } finally {
            afterSettle();
          }
        },
        (err) => {
          if (stopped || mine !== token) return;
          inFlight = false;
          try {
            opts.onError(err);
          } finally {
            afterSettle();
          }
        },
      );
  }

  return {
    start: () => {
      if (stopped || started) return;
      started = true;
      if (visible) startProbe(false);
    },
    stop: () => {
      stopped = true;
      token += 1;
      clearTimer();
    },
    refresh: (force = false) => {
      if (stopped || !started) return;
      startProbe(force);
    },
    setVisible: (next) => {
      if (next === visible) return;
      visible = next;
      if (stopped) return;
      if (!visible) {
        clearTimer();
        return;
      }
      if (!started) return;
      startProbe(false);
    },
  };
}
