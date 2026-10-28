import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, Trash, TriangleAlert } from "lucide-react";
import { reg } from "../../store/customize";
import type { WorktreeStatus } from "../../types";
import { worktreeWarningLine, type WorktreeProbe } from "../../lib/worktree-warning";
import { formatBytes } from "../../lib/format";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";

/**
 * Two-stage cleanup.
 *
 * Stage one scans and lists exactly what would be deleted, with sizes; only then
 * can the user clear. Deletion is separate and requires typing the slug, because
 * it is irreversible. Nothing is guessed: the list shown is the list sent back.
 */
export function CleanupSection({ slug, onDeleted }: { slug: string; onDeleted: () => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<{
    items: { rel: string; bytes: number; label: string }[];
    totalBytes: number;
  } | null>(null);
  const [scanned, setScanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  /**
   * What the working tree holds, asked the moment the delete gate opens (需求 8.3).
   *
   * Not on mount and not in the wall's bulk path: this is one `git status` per
   * click, and it is only worth its cost when someone is about to delete. `null`
   * means "git has not answered yet" and renders nothing - a delete dialog that
   * claims "clean" on a failed read is the exact way to lose uncommitted work.
   *
   * Round 13 (d4-1): the state is a `WorktreeProbe`, not a bare status. The old
   * `.catch(() => undefined)` left this at `null` when the command rejected, and
   * every block below was `{tree && …}` - so "git 拒绝回答" rendered the same
   * silent confirmation as "工作树干净", the exact defect `lib/worktree-warning.ts`
   * was written to kill in `ProjectsView`. The failure now travels into the same
   * tested wording, and the probe answer is guarded by `probeAliveRef` because the
   * panel can be closed while the two local git calls are in flight.
   */
  const [probe, setProbe] = useState<WorktreeProbe | null>(null);
  const probeAliveRef = useRef(true);
  useEffect(() => {
    // Re-arm in the effect body, not just at `useRef(true)` (r17-o2-2). StrictMode
    // is on (src/main.tsx:191), so React mounts, runs the cleanup, then mounts
    // again: a cleanup that only ever writes `false` leaves this guard dead for
    // the rest of the session, and the 工作树警告 it protects never appears in
    // dev. LaunchDialog and RepoSyncPanel already carry this exact re-arm.
    probeAliveRef.current = true;
    return () => {
      probeAliveRef.current = false;
    };
  }, []);
  /**
   * A successful delete schedules onDeleted (which unmounts the whole panel) 700 ms
   * later so the 已删除 status line is actually seen — a deliberate, user-visible
   * beat, not a delay to shorten. If the panel is closed by hand in that window the
   * timer must not fire onDeleted on an already-dead instance, so the id lives in a
   * ref that the unmount clears.
   */
  const deleteTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (deleteTimerRef.current !== null) window.clearTimeout(deleteTimerRef.current);
    },
    [],
  );

  const scan = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setReport(await invoke("scan_cache", { slug }));
      setScanned(true);
    } catch (e) {
      setError(t("cleanup.scanFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ freedBytes: number; removed: string[]; failed: string[] }>(
        "clear_cache",
        { slug, rels: report.items.map((i) => i.rel) },
      );
      if (res.failed.length > 0)
        setError(t("cleanup.partialFailed", { list: res.failed.join("；") }));
      setStatus(
        t("cleanup.freed", { size: formatBytes(res.freedBytes), n: res.removed.length }),
      );
      setReport(await invoke("scan_cache", { slug }));
    } catch (e) {
      setError(t("cleanup.clearFailed", { msg: messageOf(e) }));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<{ failed: string[]; freedBytes: number }>("delete_repo", { slug });
      if (res.failed.length > 0) {
        setError(t("cleanup.partialFailed", { list: res.failed.join("；") }));
        setBusy(false);
        return;
      }
      setStatus(t("cleanup.deletedFreed", { size: formatBytes(res.freedBytes) }));
      deleteTimerRef.current = window.setTimeout(onDeleted, 700);
    } catch (e) {
      setError(t("cleanup.deleteFailed", { msg: messageOf(e) }));
      setBusy(false);
    }
  };

  return (
    <div {...reg("launch-cleanup-section")} className="mt-4 border-t border-border-weak pt-3">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium">{t("cleanup.title")}</span>
        {!scanned && (
          <button
            type="button"
            onClick={() => void scan()}
            disabled={busy}
            className="rounded-lg border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {busy ? t("cleanup.scanning") : t("cleanup.scan")}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-danger/30 bg-danger/5 p-2 text-caption text-danger">
          {error}
        </div>
      )}
      {status && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-success/10 p-2 text-caption text-success">
          <CircleCheck className="h-3 w-3" />
          {status}
        </div>
      )}

      {scanned && report && (
        <div className="mt-2">
          {report.items.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t("cleanup.nothing")}</p>
          ) : (
            <>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {report.items.map((i) => (
                  <li
                    key={i.rel}
                    className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1 text-caption"
                  >
                    <span className="min-w-0 flex-1 truncate" title={i.rel}>
                      <code>{i.rel}</code>
                      <span className="ml-2 text-muted-foreground">{i.label}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">{formatBytes(i.bytes)}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void clear()}
                disabled={busy}
                className="mt-2 rounded-lg bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground disabled:opacity-40"
              >
                {t("cleanup.clearButton", {
                  n: report.items.length,
                  size: formatBytes(report.totalBytes),
                })}
              </button>
              <p className="app-desc mt-1 text-caption leading-snug text-muted-foreground">
                {t("cleanup.cleanNoteLead")}
                <code>.git</code>
                {t("cleanup.cleanNoteTail")}
              </p>
            </>
          )}

          <div className="mt-3 rounded-lg border border-danger/25 p-2.5">
            <div className="flex items-start gap-2">
              <Trash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <p className="text-caption font-medium text-danger">{t("cleanup.destroyTitle")}</p>
                <p className="app-desc mt-0.5 text-caption leading-snug text-muted-foreground">
                  {t("cleanup.destroyLead")}
                  <strong>{t("cleanup.destroyStrong")}</strong>
                  {t("cleanup.destroyTail")}
                </p>
                {!confirmDelete ? (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDelete(true);
                      void invoke<WorktreeStatus>("repo_worktree_status", { slug })
                        .then((status) => {
                          if (probeAliveRef.current) setProbe({ ok: true, status });
                        })
                        .catch((reason) => {
                          if (probeAliveRef.current) setProbe({ ok: false, reason });
                        });
                    }}
                    disabled={busy}
                    className="mt-2 rounded-lg border border-danger/40 px-2.5 py-1 text-caption text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
                  >
                    {t("cleanup.confirmOpen")}
                  </button>
                ) : (
                  <div className="mt-2 space-y-2">
                    {probe &&
                      (() => {
                        // One source of truth for the three non-silent states
                        // (probe failed / git answered nothing / no git history)
                        // is the tested helper; the structured blocks below only
                        // add detail on top of a real answer, never replace it.
                        const line = worktreeWarningLine(probe, true);
                        const st = probe.ok ? probe.status : null;
                        const rich =
                          st !== null &&
                          st.hasGit &&
                          (st.dirty > 0 ||
                            st.untracked > 0 ||
                            (st.branch !== null && st.branch !== "HEAD"));
                        return (
                          <>
                            {line !== "" && !rich && (
                              <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2 text-caption leading-snug text-warning">
                                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                                <span>{line.trim()}</span>
                              </p>
                            )}
                            {rich && st !== null && (
                              <>
                                {(st.dirty > 0 || st.untracked > 0) && (
                                  <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2 text-caption leading-snug text-warning">
                                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                                    <span>
                                      {t("cleanup.dirtyLead")}
                                      <strong>{st.dirty}</strong>
                                      {t("cleanup.dirtyFiles")}
                                      {st.untracked > 0 ? (
                                        <>
                                          {t("cleanup.untrackedLead")}
                                          <strong>{st.untracked}</strong>
                                          {t("cleanup.untrackedFiles")}
                                        </>
                                      ) : null}
                                      {t("cleanup.dirtyTail")}
                                      <strong>{t("cleanup.destroyStrong")}</strong>
                                      {t("cleanup.dirtyEnd")}
                                      {st.ahead ? t("cleanup.ahead", { n: st.ahead }) : ""}
                                    </span>
                                  </p>
                                )}
                                {st.branch && st.branch !== "HEAD" && (
                                  <p className="text-caption text-muted-foreground">
                                    {t("cleanup.branchLead")}
                                    <code className="rounded bg-muted px-1">{st.branch}</code>
                                    {st.ahead === null ? t("cleanup.branchUnknown") : ""}
                                  </p>
                                )}
                              </>
                            )}
                          </>
                        );
                      })()}
                    <p className="text-caption text-muted-foreground">
                      {t("cleanup.confirmLead")}
                      <code className="rounded bg-muted px-1">{slug}</code>
                      {t("cleanup.confirmTail")}
                    </p>
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={slug}
                      aria-label={t("cleanup.confirmAria", { slug })}
                      spellCheck={false}
                      className="w-full skin-ctl border border-input bg-background px-2 py-1.5 font-mono text-caption outline-none focus:border-danger/60"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void doDelete()}
                        disabled={busy || typed.trim() !== slug}
                        className="rounded-lg bg-danger px-3 py-1.5 text-caption font-medium text-white disabled:opacity-40"
                      >
                        {t("cleanup.confirmDestroy")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDelete(false);
                          setTyped("");
                          setProbe(null);
                        }}
                        className="rounded-lg border border-border px-3 py-1.5 text-caption text-muted-foreground hover:bg-accent"
                      >
                        {t("launch.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
