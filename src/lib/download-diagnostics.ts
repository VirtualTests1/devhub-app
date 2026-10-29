/**
 * Download failures as something a person can act on (r30-N3).
 *
 * The queue already showed the backend's sentence verbatim, which is honest but
 * not always useful: "RPC failed; curl 56 Recv failure" says what happened, not
 * what to do, and a failed task's log is the only place the layer that died is
 * visible. This module turns that text into one stable kind, provides the
 * dictionary keys for a remedy, and builds the report copied from the queue.
 *
 * ## Classification is deliberately conservative
 *
 * A wrong diagnosis is worse than "未归类": telling someone to check their token
 * when the disk is full sends them down the wrong path. So each pattern is a
 * concrete symptom (an HTTP status, git's own phrase, a Windows error string),
 * the first match wins, and everything else stays `unknown`. The log is read
 * only to find those same symptoms; it never overrides the failure text.
 *
 * ## The report is a diagnostic artifact, not a log dump
 *
 * It carries versions, counts, one row per failed task and the last few log
 * lines of each. It is capped in characters and lines, and every credential
 * shape the download layer can print is redacted before the text reaches the
 * clipboard. Paths stay: they are the user's own machine, and "which disk" is
 * half of what a storage failure needs.
 */
import { t } from "./i18n";

export type DownloadFailureKind =
  | "cancelled"
  | "auth"
  | "notFound"
  | "disk"
  | "target"
  | "network"
  | "git"
  | "unknown";

export type DownloadFailureInfo = {
  kind: DownloadFailureKind;
  /** A short kind label key; resolved by the caller through `t`. */
  labelKey:
    | "diag.kind.cancelled"
    | "diag.kind.auth"
    | "diag.kind.notFound"
    | "diag.kind.disk"
    | "diag.kind.target"
    | "diag.kind.network"
    | "diag.kind.git"
    | "diag.kind.unknown";
  /** The remedy that belongs to this kind — still only a key. */
  hintKey:
    | "diag.hint.cancelled"
    | "diag.hint.auth"
    | "diag.hint.notFound"
    | "diag.hint.disk"
    | "diag.hint.target"
    | "diag.hint.network"
    | "diag.hint.git"
    | "diag.hint.unknown";
};

const KINDS: Record<DownloadFailureKind, Omit<DownloadFailureInfo, "kind">> = {
  cancelled: { labelKey: "diag.kind.cancelled", hintKey: "diag.hint.cancelled" },
  auth: { labelKey: "diag.kind.auth", hintKey: "diag.hint.auth" },
  notFound: { labelKey: "diag.kind.notFound", hintKey: "diag.hint.notFound" },
  disk: { labelKey: "diag.kind.disk", hintKey: "diag.hint.disk" },
  target: { labelKey: "diag.kind.target", hintKey: "diag.hint.target" },
  network: { labelKey: "diag.kind.network", hintKey: "diag.hint.network" },
  git: { labelKey: "diag.kind.git", hintKey: "diag.hint.git" },
  unknown: { labelKey: "diag.kind.unknown", hintKey: "diag.hint.unknown" },
};

/**
 * Which failure this text describes.
 *
 * `log` is optional and only consulted when the failure text itself is empty or
 * unhelpful; the caller passes the tail, not the whole stream.
 */
export function classifyDownloadFailure(
  failure: string | null | undefined,
  log: readonly string[] = [],
): DownloadFailureKind {
  const own = typeof failure === "string" ? failure : "";
  const tail = log.slice(-40).join("\n");
  const text = `${own}\n${tail}`.toLowerCase();

  if (!text.trim()) return "unknown";
  // Cancellation is the store's own state; the backend's kill text also lands
  // here. Checked first because "fatal: ..." from a killed git is not a fault.
  if (
    text.includes("已取消") ||
    text.includes("cancelled") ||
    text.includes("canceled") ||
    text.includes("操作被取消") ||
    text.includes("killed")
  ) {
    return "cancelled";
  }
  if (
    text.includes("no space left") ||
    text.includes("not enough space") ||
    text.includes("disk full") ||
    text.includes("磁盘空间") ||
    text.includes("空间不足") ||
    text.includes("enospc")
  ) {
    return "disk";
  }
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("invalid username or password") ||
    text.includes("permission denied (publickey)") ||
    text.includes("bad credentials") ||
    text.includes("401") ||
    (text.includes("403") && !text.includes("rate limit")) ||
    text.includes("token") && text.includes("invalid")
  ) {
    return "auth";
  }
  if (
    text.includes("repository not found") ||
    text.includes("could not read from remote repository") && text.includes("not found") ||
    text.includes("404") ||
    text.includes("repo not found")
  ) {
    return "notFound";
  }
  if (
    text.includes("already exists") ||
    text.includes("not empty") ||
    text.includes("非空") ||
    text.includes("已存在") ||
    text.includes("would be overwritten") ||
    text.includes("refusing to overwrite") ||
    text.includes("目标目录")
  ) {
    return "target";
  }
  if (
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("could not resolve") ||
    text.includes("could not resolve host") ||
    text.includes("connection timed out") ||
    text.includes("operation timed out") ||
    text.includes("timeout") ||
    text.includes("unable to access") ||
    text.includes("recv failure") ||
    text.includes("early eof") ||
    text.includes("rpc failed") ||
    text.includes("tls") ||
    text.includes("ssl") ||
    text.includes("proxy")
  ) {
    return "network";
  }
  if (
    text.includes("not a git repository") ||
    text.includes("git: command not found") ||
    text.includes("git 不可用") ||
    text.includes("unsupported") ||
    text.includes("no such file or directory") && text.includes(".git")
  ) {
    return "git";
  }
  return "unknown";
}

export function failureInfoOf(
  failure: string | null | undefined,
  log: readonly string[] = [],
): DownloadFailureInfo {
  const kind = classifyDownloadFailure(failure, log);
  return { kind, ...KINDS[kind] };
}

/**
 * The kind as a sentence.
 *
 * Literal `t("…")` calls rather than `t(info.labelKey)`: the dictionary's
 * coverage test finds resolved keys by scanning literal call sites, so a
 * template key would read as registered-but-never-used. The switch is the one
 * place that enumeration has to happen.
 */
export function failureLabelForKey(kind: DownloadFailureKind): string {
  switch (kind) {
    case "cancelled":
      return t("diag.kind.cancelled");
    case "auth":
      return t("diag.kind.auth");
    case "notFound":
      return t("diag.kind.notFound");
    case "disk":
      return t("diag.kind.disk");
    case "target":
      return t("diag.kind.target");
    case "network":
      return t("diag.kind.network");
    case "git":
      return t("diag.kind.git");
    case "unknown":
      return t("diag.kind.unknown");
  }
}

/** The remedy as a sentence; same literal-call rule as {@link failureLabelForKey}. */
export function failureHintForKey(kind: DownloadFailureKind): string {
  switch (kind) {
    case "cancelled":
      return t("diag.hint.cancelled");
    case "auth":
      return t("diag.hint.auth");
    case "notFound":
      return t("diag.hint.notFound");
    case "disk":
      return t("diag.hint.disk");
    case "target":
      return t("diag.hint.target");
    case "network":
      return t("diag.hint.network");
    case "git":
      return t("diag.hint.git");
    case "unknown":
      return t("diag.hint.unknown");
  }
}

/** One line a failed card can render: the kind and the remedy. */
export function failureHintText(
  failure: string | null | undefined,
  log: readonly string[] = [],
): string {
  const kind = classifyDownloadFailure(failure, log);
  return t("dl.failureHint", { kind: failureLabelForKey(kind), hint: failureHintForKey(kind) });
}

/**
 * What a report needs from a task. Structural so the builder can be tested with
 * plain objects; the queue's `DownloadTask` satisfies it.
 */
export type DiagnosticTask = {
  ref: string;
  source: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  paused?: boolean;
  branch?: string;
  targetDir?: string;
  startedAt: number;
  endedAt?: number;
  failure: string | null;
  log: readonly string[];
  interrupted?: boolean;
};

export type DiagnosticsEnv = {
  appVersion: string;
  platform: string;
  /** Injected for a deterministic test. */
  now?: Date;
  /** Log lines kept per failed task; default 20. */
  logLines?: number;
  /** Hard character ceiling; default 12000. */
  maxChars?: number;
};

const DEFAULT_LOG_LINES = 20;
const DEFAULT_MAX_CHARS = 12_000;

/**
 * Remove credential-shaped strings before they reach the clipboard.
 *
 * The downloader already avoids putting a token in the clone URL, but logs can
 * carry a URL a user pasted, an `Authorization` header from a mirror, or a
 * token echoed by a tool. Redaction is shape-based and deliberately narrow: a
 * false positive (a word after `token=`) costs one line; a leak costs a
 * credential.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/(x-access-token:)[^\s@]+/gi, "$1[redacted]")
    .replace(/(authorization:\s*(?:bearer\s+)?)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:token|password|secret)\s*[=:]\s*)[^\s&,;]+/gi, "$1[redacted]");
}

function stamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString();
}

/** Short, stable summary of a failure kind for the report header. */
export function kindCounts(tasks: readonly DiagnosticTask[]): Map<DownloadFailureKind, number> {
  const out = new Map<DownloadFailureKind, number>();
  for (const task of tasks) {
    if (task.status !== "failed") continue;
    const kind = classifyDownloadFailure(task.failure, task.log);
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/**
 * Build the report copied from the queue.
 *
 * Only failed tasks get a section; the counts still describe the whole queue,
 * because "three failed out of two hundred" is a different problem from "three
 * failed out of three". A report with no failures says so instead of ending
 * after the header.
 */
export function buildDownloadDiagnostics(
  tasks: readonly DiagnosticTask[],
  env: DiagnosticsEnv,
): string {
  const counts = { total: tasks.length, running: 0, queued: 0, paused: 0, failed: 0, done: 0 };
  for (const task of tasks) {
    if (task.status === "running") counts.running += 1;
    else if (task.status === "queued") {
      counts.queued += 1;
      if (task.paused) counts.paused += 1;
    } else if (task.status === "failed") counts.failed += 1;
    else if (task.status === "done") counts.done += 1;
  }
  const kinds = kindCounts(tasks);
  const lines: string[] = [
    t("diag.title"),
    `${t("diag.version")}: ${env.appVersion || "—"}`,
    `${t("diag.platform")}: ${env.platform || "—"}`,
    `${t("diag.generatedAt")}: ${(env.now ?? new Date()).toISOString()}`,
    "",
    t("diag.counts", counts),
  ];
  if (kinds.size > 0) {
    lines.push(
      `${t("diag.kinds")}: ${[...kinds.entries()]
        .map(([kind, n]) => `${failureLabelForKey(kind)} ${n}`)
        .join(" · ")}`,
    );
  }
  const failed = tasks.filter((task) => task.status === "failed");
  if (failed.length === 0) {
    lines.push("", t("diag.none"));
  }
  const maxLines = Math.max(0, Math.floor(env.logLines ?? DEFAULT_LOG_LINES));
  for (const [i, task] of failed.entries()) {
    const info = failureInfoOf(task.failure, task.log);
    lines.push(
      "",
      `${i + 1}. ${task.ref} [${failureLabelForKey(info.kind)}]`,
      `   ${t("diag.source")}: ${task.source}`,
      ...(task.branch ? [`   ${t("diag.branch")}: ${task.branch}`] : []),
      ...(task.targetDir ? [`   ${t("diag.target")}: ${task.targetDir}`] : []),
      `   ${t("diag.started")}: ${stamp(task.startedAt)}`,
      `   ${t("diag.ended")}: ${stamp(task.endedAt)}`,
      `   ${t("diag.error")}: ${redactSecrets(task.failure ?? "—")}`,
      `   ${t("diag.hint")}: ${failureHintForKey(info.kind)}`,
    );
    const tail = task.log.slice(-maxLines);
    if (tail.length > 0) {
      lines.push(`   ${t("diag.log")}:`);
      for (const line of tail) lines.push(`     ${redactSecrets(line)}`);
    }
  }
  const text = lines.join("\n");
  const maxChars = Math.max(200, Math.floor(env.maxChars ?? DEFAULT_MAX_CHARS));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n${t("diag.truncated")}`;
}
