import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileSearch, LoaderCircle, TriangleAlert } from "lucide-react";

import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";
import { messageOf, reportError } from "../lib/report-error";
import { cn } from "../lib/utils";
import { checkPattern, hitAbsolutePath, PATTERN_MAX, type GrepHit } from "../lib/grep";
import {
  renderableGroups,
  summarizeBatch,
  type GrepBatchResult,
} from "../lib/grep-batch";

/**
 * 在所有项目中搜索（r33-D5）.
 *
 * This is a **line search with an explicit scope**, not a relevance search over
 * the collection: the user names the wall (all slugs), types a pattern, and gets
 * every matching line grouped by repository. The backend bounds the request
 * (200 repos, 50 hits each, 1 000 total, 15 s) and this dialog says when one of
 * those bounds was reached. A cap is not an empty answer: `partial` has its own
 * sentence, and a repository that could not be scanned has its own row.
 *
 * The entry point is the wall header, next to the search box: the question
 * "which of my projects has this line" starts on the wall, and a dialog that
 * inherited the right-clicked card would silently narrow the scope.
 */
function hitLabel(hit: GrepHit): string {
  return `${hit.file}:${hit.line}`;
}

export function CrossRepoGrepDialog({
  open,
  slugs,
  onClose,
}: {
  open: boolean;
  /** Canonical `host/owner/repo` slugs, as the wall carries them. */
  slugs: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pattern, setPattern] = useState("");
  const [ci, setCi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GrepBatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // A dialog opened by a click should be ready to type in. The shell's focus
    // trap starts on its close button; this moves the caret to the field that is
    // the entire point of opening the dialog.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const issue = checkPattern(pattern);
  const canRun = issue === null && !busy && slugs.length > 0;

  const run = async () => {
    if (issue !== null) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await invoke<GrepBatchResult>("repo_grep_many", {
        slugs,
        pattern,
        caseInsensitive: ci,
        perRepoLimit: 50,
        totalLimit: 1000,
      });
      setResult(answer);
      if (answer.error) setError(answer.error);
    } catch (e) {
      setResult(null);
      setError(t("grep.failed", { msg: messageOf(e) }));
      reportError(e, t("grep.search"));
    } finally {
      setBusy(false);
    }
  };

  const reveal = (root: string, hit: GrepHit) => {
    void invoke("reveal_path", { path: hitAbsolutePath(root, hit.file) }).catch((e) =>
      reportError(e, t("wall.revealFail")),
    );
  };

  const summary = result ? summarizeBatch(result) : null;
  const rendered = result ? renderableGroups(result) : null;
  const failedGroups = result?.groups.filter((g) => g.error !== null) ?? [];

  return (
    <DialogShell
      title={t("grep.batch.title")}
      subtitle={t("grep.batch.subtitle", { n: slugs.length })}
      onClose={onClose}
      width="lg"
      footer={
        <span className="text-caption text-muted-foreground">{t("grep.keyboardHint")}</span>
      }
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canRun) void run();
          }}
          placeholder={t("grep.batch.placeholder")}
          aria-label={t("grep.patternAria")}
          maxLength={PATTERN_MAX}
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-caption outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={() => setCi((v) => !v)}
          aria-pressed={ci}
          title={t("grep.caseInsensitive")}
          className={cn(
            "h-8 shrink-0 rounded-lg border px-2 text-caption transition-colors",
            ci
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          Aa
        </button>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!canRun}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-primary/60 bg-primary/15 px-3 text-caption text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
          {t("grep.search")}
        </button>
      </div>

      {issue === "tooLong" && (
        <p className="mt-2 text-caption text-warning">{t("grep.patternTooLong", { max: PATTERN_MAX })}</p>
      )}
      {issue === "empty" && pattern.length > 0 && (
        <p className="mt-2 text-caption text-muted-foreground">{t("grep.needPattern")}</p>
      )}

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {result && summary && rendered && (
        <div className="mt-3">
          <p className="text-caption text-muted-foreground" role="status" aria-live="polite">
            {t("grep.batch.summary", {
              repos: summary.hitRepos,
              hits: summary.totalHits,
              files: result.filesScanned,
              ms: result.elapsedMs,
            })}
          </p>
          {summary.partial && (
            <p className="mt-1 text-caption text-warning">{t("grep.batch.partial")}</p>
          )}
          {failedGroups.length > 0 && (
            <p className="mt-1 text-caption text-warning">
              {t("grep.batch.failedRepos", {
                n: failedGroups.length,
                list: failedGroups.slice(0, 3).map((g) => `${g.slug}: ${g.error}`).join("；"),
              })}
            </p>
          )}

          {summary.totalHits === 0 && failedGroups.length === 0 ? (
            <p className="mt-3 rounded-lg border border-border-weak bg-background px-3 py-4 text-center text-caption text-muted-foreground">
              {t("grep.batch.noHits", { repos: summary.scannedRepos })}
            </p>
          ) : (
            <ul className="mt-3 max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {rendered.shown.map((group) => {
                const full = result.groups.find((g) => g.slug === group.slug);
                return (
                  <li key={group.slug} className="rounded-lg border border-border-weak bg-background">
                    <div className="flex items-center gap-2 border-b border-border-weak px-2.5 py-1.5">
                      <span className="min-w-0 truncate text-caption font-medium">{group.slug}</span>
                      <span className="ml-auto shrink-0 text-caption text-muted-foreground">
                        {t("grep.hitCount", { n: group.hits.length + group.hiddenHits })}
                      </span>
                    </div>
                    {group.error && (
                      <p className="px-2.5 py-1.5 text-caption text-warning">{group.error}</p>
                    )}
                    {group.hits.map((hit) => (
                      <button
                        key={`${hit.file}:${hit.line}`}
                        type="button"
                        onClick={() => reveal(full?.root ?? "", hit)}
                        title={t("grep.revealTitle", { path: `${hit.file}:${hit.line}` })}
                        className="flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors hover:bg-accent"
                      >
                        <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
                          {hitLabel(hit)}
                        </span>
                        <span className="min-w-0 truncate text-caption text-foreground/90">{hit.content}</span>
                      </button>
                    ))}
                    {group.hiddenHits > 0 && (
                      <p className="px-2.5 py-1 text-caption text-muted-foreground">
                        {t("grep.batch.hiddenHits", { n: group.hiddenHits })}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {rendered.hiddenGroups > 0 && (
            <p className="mt-2 text-caption text-muted-foreground">
              {t("grep.batch.hiddenGroups", { n: rendered.hiddenGroups })}
            </p>
          )}
          {result.repositoriesSkipped > 0 && (
            <p className="mt-1 text-caption text-warning">
              {t("grep.batch.skippedRepos", { n: result.repositoriesSkipped })}
            </p>
          )}
        </div>
      )}

      {!result && !error && !busy && (
        <p className="mt-3 text-caption text-muted-foreground">{t("grep.idle")}</p>
      )}
    </DialogShell>
  );
}
