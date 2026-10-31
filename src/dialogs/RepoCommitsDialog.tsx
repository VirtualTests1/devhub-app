import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, LoaderCircle, RefreshCw } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";
import { fmtDateTime } from "../lib/format";
import { messageOf } from "../lib/report-error";
import { toast } from "../components/Toast";
import type { CommitInfo, RepoRef } from "../types";

type Card = RepoRef & { slug: string };

type Load =
  | { kind: "loading" }
  | { kind: "ready"; rows: CommitInfo[] }
  | { kind: "error"; message: string };

function when(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmtDateTime(ms) : iso;
}

/**
 * Read-only commit history for one repository (r32-N4).
 *
 * The backend is asked for a bounded list (30 rows) and does not check out,
 * fetch or write anything. The dialog's only action besides 刷新 is copying a
 * full hash; opening a specific commit is a separate product decision and is
 * deliberately absent rather than half-built.
 */
export function RepoCommitsDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { t } = useI18n();
  const slug = card?.slug ?? "";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    if (!slug) {
      setState({ kind: "ready", rows: [] });
      return () => {
        live = false;
      };
    }
    setState({ kind: "loading" });
    void invoke<CommitInfo[]>("repo_commits", { slug, limit: 30 })
      .then((rows) => {
        if (live) setState({ kind: "ready", rows });
      })
      .catch((e: unknown) => {
        if (live) setState({ kind: "error", message: messageOf(e) });
      });
    return () => {
      live = false;
    };
  }, [slug, nonce]);

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      toast.success(t("commits.copied"));
    } catch {
      toast.error(t("commits.copyFailed"));
    }
  };

  return (
    <DialogShell
      title={t("commits.title")}
      subtitle={card ? `${card.owner}/${card.repo}` : undefined}
      onClose={onClose}
      width="lg"
    >
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          disabled={state.kind === "loading"}
          className="inline-flex items-center gap-1 rounded border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="h-3 w-3" />
          {t("commits.refresh")}
        </button>
        {state.kind === "ready" && state.rows.length > 0 && (
          <span className="text-caption text-muted-foreground">
            {t("commits.count", { n: state.rows.length })}
          </span>
        )}
      </div>

      {state.kind === "loading" && (
        <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("commits.loading")}
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          {t("commits.failed", { reason: state.message })}
        </p>
      )}
      {state.kind === "ready" && state.rows.length === 0 && (
        <p className="py-2 text-caption text-muted-foreground">{t("commits.empty")}</p>
      )}
      {state.kind === "ready" && state.rows.length > 0 && (
        <ol className="max-h-[55vh] divide-y divide-border-weak overflow-y-auto rounded-lg border border-border-weak">
          {state.rows.map((c) => (
            <li key={c.hash} className="flex items-start gap-2 px-2.5 py-2">
              <code className="shrink-0 pt-0.5 text-caption font-medium text-muted-foreground">{c.short}</code>
              <div className="min-w-0 flex-1">
                <p className="truncate text-caption text-foreground" title={c.subject}>
                  {c.subject || "—"}
                </p>
                <p className="truncate text-caption text-muted-foreground">
                  {c.author} · {when(c.date)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void copyHash(c.hash)}
                aria-label={t("commits.copyAria", { hash: c.short })}
                title={t("commits.copy")}
                className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <Copy className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </DialogShell>
  );
}
