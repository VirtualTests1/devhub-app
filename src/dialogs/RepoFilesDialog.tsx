import { useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { File, Folder, LoaderCircle } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { useI18n } from "../lib/useI18n";
import { messageOf } from "../lib/report-error";
import { moveFileIndex } from "../lib/file-list-nav";
import { cn } from "../lib/utils";
import type { RepoFiles } from "../types";

/**
 * Read-only repository file browser (r22-N2).
 *
 * ## Why this dialog exists
 *
 * The README dialog answers "what does the project say"; 在项目中搜索 answers
 * "where does this string appear". Neither answers "what files are in here" —
 * the step between opening a card and knowing which file to read. The backend
 * walk is bounded (depth 4 / 300 entries by default) and skips the same build and
 * dependency directories as `repo_grep`, so the two views cannot disagree about
 * what counts as source.
 *
 * ## What it deliberately is not
 *
 * Not an editor, not a tree with per-folder lazy expansion (the backend returns
 * the already-bounded flat list), and not a previewer for binary files: the
 * preview streams whole lines through `read_text_file_stream` (r25-R2), whose
 * refusal is shown verbatim instead of being rendered as mojibake. If that
 * command is unavailable (an older backend) or fails before the first chunk, the
 * dialog falls back to the one-shot `read_text_file`.
 */
type Card = { path?: string | null };

/**
 * Wire shape of `read_text_file_stream`'s `PreviewEvent`
 * (`src-tauri/src/file_stream.rs`). `kind` is the discriminant the backend tags
 * every message with; a chunk is always whole lines, so concatenation is lossless.
 */
type PreviewEvent =
  | { kind: "started"; bytes: number }
  | { kind: "chunk"; text: string }
  | { kind: "done"; bytes: number; lines: number };

export function RepoFilesDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { t } = useI18n();
  const root = (card?.path ?? "").trim();
  const [listing, setListing] = useState<RepoFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ state: "loading" | "ok" | "error"; text: string } | null>(null);
  const [copy, setCopy] = useState<"idle" | "ok" | "error">("idle");
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Bumped per open: a late chunk from the previous file must not replace this one. */
  const previewSeq = useRef(0);

  // A dialog closed mid-stream must stop painting chunks into a dead component.
  useEffect(() => () => { previewSeq.current += 1; }, []);

  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    setListing(null);
    setError(null);
    void invoke<RepoFiles>("repo_files", { root })
      .then((r) => {
        if (alive) setListing(r);
      })
      .catch((e) => {
        if (alive) setError(messageOf(e));
      });
    return () => {
      alive = false;
    };
  }, [root]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = listing?.entries ?? [];
    return (q ? rows.filter((e) => e.path.toLowerCase().includes(q)) : rows).slice(0, 500);
  }, [listing, filter]);

  const openFile = (path: string) => {
    setSelected(path);
    const gen = ++previewSeq.current;
    setPreview({ state: "loading", text: "" });
    const full = `${root.replace(/[\\/]+$/, "")}/${path}`;
    let received = "";
    const channel = new Channel<PreviewEvent>();
    channel.onmessage = (ev) => {
      if (gen !== previewSeq.current || ev.kind !== "chunk") return;
      received += ev.text;
      setPreview({ state: "ok", text: received });
    };
    void invoke<void>("read_text_file_stream", { path: full, onEvent: channel })
      .then(() => {
        if (gen === previewSeq.current) setPreview({ state: "ok", text: received });
      })
      .catch((e) => {
        if (gen !== previewSeq.current) return;
        if (received) {
          // A refusal after the first batch (e.g. invalid UTF-8 late in the file):
          // show the reason and drop the partial text, as the one-shot command did.
          setPreview({ state: "error", text: messageOf(e) });
          return;
        }
        // Nothing arrived: an older backend without the command, or a refusal
        // before the first batch. The one-shot path gives the same answer.
        void invoke<string>("read_text_file", { path: full })
          .then((text) => {
            if (gen === previewSeq.current) setPreview({ state: "ok", text });
          })
          .catch((e2) => {
            if (gen === previewSeq.current) setPreview({ state: "error", text: messageOf(e2) });
          });
      });
  };

  const copySelected = () => {
    if (!selected) return;
    const full = `${root.replace(/[\\/]+$/, "")}/${selected}`;
    void navigator.clipboard
      .writeText(full)
      .then(() => setCopy("ok"))
      .catch(() => setCopy("error"));
  };

  const previewText = preview?.state === "ok" ? preview.text : "";
  const lineCount = previewText ? previewText.split("\n").length : 0;

  if (!card) return null;

  return (
    <DialogShell title={t("files.title")} subtitle={root} onClose={onClose} width="xl">
      {!root && <p className="py-2 text-caption text-muted-foreground">{t("files.noPath")}</p>}
      {root && !listing && !error && (
        <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("files.loading")}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          {t("files.failed", { reason: error })}
        </p>
      )}
      {listing && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("files.filter")}
              aria-label={t("files.filter")}
              className="min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono outline-none focus:border-primary"
            />
            <span className="tabular-nums">{t("files.count", { n: listing.count })}</span>
            <button
              type="button"
              onClick={copySelected}
              disabled={!selected}
              className="rounded-lg border border-border-weak px-2 py-1 text-caption text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40"
            >
              {copy === "ok" ? t("files.copied") : copy === "error" ? t("files.copyFailed") : t("files.copyPath")}
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-2 text-caption text-muted-foreground">
            {listing.truncated && <span className="text-warning">{t("files.truncated", { n: listing.maxEntries })}</span>}
            {listing.depthLimitReached && <span>{t("files.depth", { n: listing.maxDepth })}</span>}
            {listing.ignored.length > 0 && <span>{t("files.ignored", { names: listing.ignored.join("、") })}</span>}
            {listing.unreadable.length > 0 && (
              <span className="text-warning">{t("files.unreadable", { n: listing.unreadable.length })}</span>
            )}
          </div>

          <div className="grid min-h-0 gap-2 md:grid-cols-2">
            <div
              ref={listRef}
              aria-label={t("files.listAria")}
              onKeyDown={(e) => {
                if (e.target instanceof HTMLInputElement) return;
                const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
                const next = moveFileIndex(
                  [...rows].indexOf(document.activeElement as HTMLButtonElement),
                  e.key,
                  rows.length,
                );
                if (next == null) return;
                e.preventDefault();
                rows[next]?.focus();
              }}
              className="max-h-[55vh] overflow-auto rounded-lg border border-border-weak bg-background p-1"
            >
              {visible.length === 0 ? (
                <p className="p-2 text-caption text-muted-foreground">{t("files.empty")}</p>
              ) : (
                visible.map((e) => (
                  <button
                    key={e.path}
                    type="button"
                    onClick={() => (e.kind === "dir" ? setFilter(`${e.path}/`) : openFile(e.path))}
                    title={e.path}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left font-mono text-caption transition-colors hover:bg-accent",
                      selected === e.path && "bg-primary/15 text-foreground",
                    )}
                    style={{ paddingLeft: `${6 + (e.depth - 1) * 12}px` }}
                  >
                    {e.kind === "dir" ? (
                      <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <File className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{e.path}</span>
                    {e.size != null && <span className="shrink-0 text-muted-foreground/70">{e.size} B</span>}
                  </button>
                ))
              )}
            </div>

            <div className="max-h-[55vh] overflow-auto rounded-lg border border-border-weak bg-background">
              {!preview && (
                <p className="p-3 text-caption text-muted-foreground">{t("files.selectHint")}</p>
              )}
              {preview?.state === "loading" && (
                <p className="flex items-center gap-1.5 p-3 text-caption text-muted-foreground">
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                  {t("files.previewLoading")}
                </p>
              )}
              {preview?.state === "error" && (
                <p role="alert" className="p-3 text-caption text-danger">
                  {t("files.previewFailed", { reason: preview.text })}
                </p>
              )}
              {preview?.state === "ok" && (
                <div className="flex min-w-full">
                  <pre
                    aria-hidden
                    className="select-none border-r border-border-weak/60 px-2 py-3 text-right text-caption leading-relaxed text-muted-foreground/40 tabular-nums"
                  >
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                  </pre>
                  <pre className="min-w-0 flex-1 px-3 py-3 text-caption leading-relaxed text-muted-foreground">
                    {preview.text}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </DialogShell>
  );
}
