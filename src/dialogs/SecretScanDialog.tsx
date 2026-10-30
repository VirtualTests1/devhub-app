import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, LoaderCircle, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";

import { DialogShell } from "../components/DialogShell";
import { toast } from "../components/Toast";
import { useI18n } from "../lib/useI18n";
import { messageOf } from "../lib/report-error";
import type { RepoRef, SecretReport } from "../types";

/**
 * 密钥卫生扫描（r34-D7）.
 *
 * One repository, offline, redacted. The dialog says what the scanner is not
 * (not a verdict, not a complete scanner) as loudly as what it found: a false
 * positive costs a look, a false confidence costs a leaked token. Copying the
 * result copies only the masked previews the backend returned.
 */
type Card = RepoRef & { slug: string };

type Translate = ReturnType<typeof useI18n>["t"];

function kindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case "github-token":
      return t("secret.kind.github");
    case "aws-access-key":
      return t("secret.kind.aws");
    case "private-key":
      return t("secret.kind.privateKey");
    case "slack-token":
      return t("secret.kind.slack");
    case "stripe-live":
      return t("secret.kind.stripe");
    case "generic-assignment":
      return t("secret.kind.generic");
    default:
      return kind;
  }
}

export function SecretScanDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { t } = useI18n();
  const slug = card?.slug ?? "";
  const [report, setReport] = useState<SecretReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setBusy(true);
    setError(null);
    setReport(null);
    void invoke<SecretReport>("repo_secret_scan", { slug })
      .then((r) => {
        if (!alive) return;
        if (r.error) setError(r.error);
        else setReport(r);
      })
      .catch((e) => {
        if (alive) setError(t("secret.failed", { msg: messageOf(e) }));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, nonce, t]);

  const grouped = useMemo(() => {
    const map = new Map<string, SecretReport["hits"]>();
    for (const hit of report?.hits ?? []) {
      const list = map.get(hit.file) ?? [];
      list.push(hit);
      map.set(hit.file, list);
    }
    return [...map.entries()];
  }, [report]);

  if (!card) return null;

  const copy = async () => {
    if (!report) return;
    const lines = report.hits.map((h) => `${h.file}:${h.line} [${h.kind}] ${h.preview}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(t("secret.copied", { n: lines.length }));
    } catch {
      toast.error(t("secret.copyFailed"));
    }
  };

  return (
    <DialogShell
      title={t("secret.title")}
      subtitle={card.slug}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="h-3 w-3" />
            {t("secret.hint")}
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              disabled={busy}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {t("secret.rescan")}
            </button>
            <button
              type="button"
              onClick={() => void copy()}
              disabled={!report || report.hits.length === 0}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Copy className="h-3 w-3" />
              {t("secret.copy")}
            </button>
          </span>
        </div>
      }
    >
      {busy && (
        <p className="flex items-center gap-2 py-3 text-caption text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {t("secret.scanning")}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {report && !busy && (
        <>
          <p className="text-caption text-muted-foreground" role="status" aria-live="polite">
            {t("secret.summary", {
              hits: report.hits.length,
              files: report.filesScanned,
              skipped: report.filesSkipped,
              ms: report.elapsedMs,
            })}
          </p>
          {report.truncated && <p className="mt-1 text-caption text-warning">{t("secret.truncated")}</p>}
          {report.timedOut && <p className="mt-1 text-caption text-warning">{t("secret.timedOut")}</p>}

          {report.hits.length === 0 ? (
            <p className="mt-3 rounded-lg border border-border-weak bg-background px-3 py-4 text-center text-caption text-muted-foreground">
              {t("secret.none")}
            </p>
          ) : (
            <ul className="mt-3 max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {grouped.map(([file, hits]) => (
                <li key={file} className="rounded-lg border border-border-weak bg-background">
                  <div className="flex items-center gap-2 border-b border-border-weak px-2.5 py-1.5">
                    <span className="min-w-0 truncate text-caption font-medium">{file}</span>
                    <span className="ml-auto shrink-0 text-caption text-muted-foreground">{hits.length}</span>
                  </div>
                  {hits.map((hit) => (
                    <div key={`${hit.line}:${hit.kind}`} className="flex items-baseline gap-2 px-2.5 py-1 text-caption">
                      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{hit.line}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
                        {kindLabel(t, hit.kind)}
                      </span>
                      <code className="min-w-0 truncate font-mono text-caption text-foreground/90">{hit.preview}</code>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DialogShell>
  );
}
