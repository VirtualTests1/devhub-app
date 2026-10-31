/**
 * Pure, dependency-free formatters shared across the app.
 *
 * These used to be duplicated in three places (`types.ts`, `LaunchDialog`,
 * `RepoSyncPanel`) with separate local copies that could drift. They are now the
 * single source of truth, so a behavior change is one edit instead of three
 * silently diverged ones.
 *
 * The byte formatter keeps its original tier thresholds (1024, not 1000) and its
 * original corner-case behavior: negatives and non-finite values fall through to
 * the byte / GB tier rather than being clamped. That behavior is pinned by the
 * characterization tests in `tests/types-format.test.ts` (via the `types.ts`
 * re-export) and `tests/format.test.ts`.
 */

/**
 * The units these formatters speak.
 *
 * `i18n.ts` calls `setFormatLocale` whenever the interface language changes, so
 * `fmtElapsed`/`fmtAgo` follow the same switch as the dictionary. It lives here
 * rather than importing `Locale` from `i18n` on purpose: `i18n.ts` imports this
 * module to push the locale, and a type-only import would still make the two
 * modules depend on each other in both directions.
 */
export type FormatLocale = "zh-CN" | "en";

let formatLocale: FormatLocale = "zh-CN";

export function setFormatLocale(next: FormatLocale): void {
  formatLocale = next === "en" ? "en" : "zh-CN";
}

export function getFormatLocale(): FormatLocale {
  return formatLocale;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Two-digit register, so a ticking readout does not change width every second. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The one rendering of "how long has this been running".
 *
 * This is the single source: the 启动对话框 (`RunStatus`), the 状态栏 (`StatusStrip`)
 * and the 项目墙卡片 (`RepoTile`) all print this same string for the same `elapsedMs`,
 * because those three are on screen *at the same time* and two of them used to
 * disagree — `elapsedText` in `RepoTile` answered 15 min as `15 分 0 秒` and 400 ms as
 * `0 秒`, while this file answered `15 分 00 秒` and `400 毫秒`.
 *
 * The contract, in four tiers:
 *
 *   - under a second  → `400 毫秒`. A sub-second lifetime is a real fact here:
 *     `RunStatus` uses it to tell "the shell returned at once" from "it crashed",
 *     so `0 秒` would hide the answer under a rounding.
 *   - under a minute  → `45 秒`.
 *   - under an hour   → `15 分 00 秒`. The seconds are padded: this line ticks.
 *   - beyond          → `2 小时 05 分`. Padded for the same reason — the old
 *     `1 小时 0 分` was the only unpadded register left in the app.
 *
 * Negative input (a clock jump between `startedAt` and now) clamps to zero rather
 * than printing `-500 毫秒`.
 */
export function fmtElapsed(ms: number): string {
  const clamped = ms > 0 ? Math.floor(ms) : 0;
  const s = Math.floor(clamped / 1000);
  const en = formatLocale === "en";
  if (s < 1) return en ? `${clamped} ms` : `${clamped} 毫秒`;
  if (s < 60) return en ? `${s} s` : `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return en ? `${m} min ${pad2(s % 60)} s` : `${m} 分 ${pad2(s % 60)} 秒`;
  return en ? `${Math.floor(m / 60)} h ${pad2(m % 60)} min` : `${Math.floor(m / 60)} 小时 ${pad2(m % 60)} 分`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString(formatLocale);
}

/**
 * The one relative-time ladder: how long ago was `ts`.
 *
 * This ladder used to be written out three times — here, in
 * `views/records/format.ts`, and as `lastOpenedText` in `RepoTile` — and the
 * three copies were *not* identical on purpose, which is the trap: collapsing
 * them by majority would have silently changed two of the surfaces. What is
 * duplicated was the arithmetic (`Math.floor(secs / 60)`, `/ 3600`, `/ 86_400`),
 * now written once; the two legitimate register differences became named style
 * options instead of separate functions:
 *
 *   - `subMinute` — a 记录 row wants `45 秒前` (rows are dense and sub-minute, and
 *     the point is ordering); 同步面板 wants `刚刚`, because there the age answers
 *     "is this answer fresh enough", and `0 秒前` reads like a counter.
 *   - `pastDay` — 记录 wants `43 天前` (a log is a list of ages); the 项目墙 tooltip
 *     wants an absolute stamp, because `43 天前` tells you nothing you can act on
 *     while `2026-08-12 14:20` does. That reasoning is `lastOpenedText`'s own
 *     comment, kept verbatim where it now lives.
 *
 * Takes an explicit `now` so the ladder is deterministic under test instead of
 * reading `Date.now()`; callers that want wall-clock behavior just omit it.
 * A future timestamp (`now - ts < 0`, possible after a clock jump) reads as the
 * smallest answer rather than `-7 分钟前`.
 */
export type AgoStyle = {
  /** Under a minute: `45 秒前` or `刚刚`. Defaults to `seconds`. */
  subMinute?: "seconds" | "justNow";
  /** Past a day: `3 天前` or a local `YYYY-MM-DD HH:mm` stamp. Defaults to `days`. */
  pastDay?: "days" | "date";
};

/** Local `YYYY-MM-DD HH:mm`, the `pastDay: "date"` register. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Localized date + time, replacing `Date#toLocaleString()` at the call sites.
 *
 * `toLocaleString()` without an argument follows the *operating system* locale,
 * so an English UI on a Chinese Windows printed `2026/10/31 14:20:00` inside
 * English sentences. These helpers pin the locale to the app's language switch.
 * `seconds` stays in the time output because the values they replace included
 * them (crash time, download end, commit dates).
 */
export function fmtDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return "Invalid Date";
  return new Intl.DateTimeFormat(formatLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

/** Localized clock time (seconds included), the `toLocaleTimeString()` replacement. */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms)) return "Invalid Date";
  return new Intl.DateTimeFormat(formatLocale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

/** Localized calendar date, the `toLocaleDateString()` replacement. */
export function fmtDate(ms: number): string {
  if (!Number.isFinite(ms)) return "Invalid Date";
  return new Intl.DateTimeFormat(formatLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

export function fmtAgo(ts: number, now: number = Date.now(), style: AgoStyle = {}): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  const en = formatLocale === "en";
  if (secs < 60) {
    if (style.subMinute === "justNow") return en ? "just now" : "刚刚";
    return en ? `${secs}s ago` : `${secs} 秒前`;
  }
  if (secs < 3600) return en ? `${Math.floor(secs / 60)} min ago` : `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86_400) return en ? `${Math.floor(secs / 3600)} h ago` : `${Math.floor(secs / 3600)} 小时前`;
  if (style.pastDay === "date") return localStamp(ts);
  return en ? `${Math.floor(secs / 86_400)} d ago` : `${Math.floor(secs / 86_400)} 天前`;
}

/**
 * `刚刚 / N 分钟前 / N 小时前 / N 天前`, from the event timestamp.
 *
 * The `刚刚` profile: `fmtRelative` is what 同步面板 shows for a cached freshness
 * answer, where a sub-minute age is not a countable thing. `ts === 0` (never
 * checked at all) is not "a very long time ago", so it answers `刚刚` too — that
 * is the caller's "no data" convention, not a fact about the ladder.
 */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  if (!ts) return formatLocale === "en" ? "just now" : "刚刚";
  return fmtAgo(ts, now, { subMinute: "justNow", pastDay: "days" });
}
