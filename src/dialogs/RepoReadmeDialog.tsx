import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LoaderCircle } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { parseMarkdown, type MdBlock, type MdInline, type MdListItem } from "../lib/markdown";
import { README_CANDIDATES, capUtf8, isMissingFileReason } from "../lib/readme";
import { useI18n } from "../lib/useI18n";
import type { TFunc } from "../lib/i18n";
import { cn } from "../lib/utils";
import type { RepoRef } from "../types";

/**
 * 本地仓库的 README 预览（round 17, n2-2）.
 *
 * ## Why a new dialog, and why it goes through `read_text_file`
 *
 * `repo_readme(full_name)` (添加页的远端预览) fetches from GitHub, so it is
 * useless for a repository already on disk — and offline. The backend already
 * exposes the two pieces this needs: `repo_detail` returns the clone's absolute
 * `path`, and `read_text_file` reads one UTF-8 file **inside the container's
 * roots** (its `path_guard` refuses anything else, and it reports the failing
 * case with a machine-readable reason). So this dialog asks the backend for the
 * directory and then for the file; it never builds a path from a guess of its
 * own, and it does not need a new Rust command.
 *
 * ## The probe, and why "missing" is read from a code rather than a guess
 *
 * README filenames differ per project, so the dialog tries the four spellings
 * in order. `read_text_file` answers a non-existent file with
 * `路径不存在或无法解析：… (missing)` — the guard's stable `code()` — so
 * "this candidate is not there, try the next" is decided by that token, not by
 * sniffing the Chinese sentence around it. Any *other* rejection (outside roots,
 * denied, too large, not UTF-8) is a real failure for that candidate and is
 * surfaced verbatim instead of being swallowed and reported as "no README".
 *
 * ## Where the pure decisions live
 *
 * The candidate list, the truncation cut and the "is this a missing-file
 * refusal" rule all moved to `lib/readme.ts` (round 17, n2-3): the Node runner
 * cannot import a `.tsx`, so anything that is only a decision about strings and
 * bytes is unreachable to a unit test unless it sits in a `.ts` module. This
 * file keeps the IPC, the state machine and the renderer.
 *
 * ## Honest scope
 *
 * This was verified at the type / build / test layer only. It has **not** been
 * driven in a real WebView2 over CDP (`scripts/verify-fixes.ps1`), so nothing
 * here is claimed as visually verified — see DEVELOPMENT.md §6.
 */

type Card = RepoRef & { slug: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "no-path" }
  | { kind: "missing" }
  | { kind: "error"; reason: string }
  | { kind: "ok"; file: string; dir: string; text: string; truncated: boolean };

export function RepoReadmeDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { t } = useI18n();
  const slug = card?.slug ?? "";
  // Read as primitives so the load effect keys on identity, not on the object
  // `ProjectsView` re-creates each render.
  const cardPath = card?.path ?? "";

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setState({ kind: "loading" });
    (async () => {
      let dir = cardPath;
      if (!dir) {
        try {
          const detail = await invoke<{ path: string }>("repo_detail", { slug });
          dir = detail.path || "";
        } catch (e) {
          if (alive) setState({ kind: "error", reason: String(e) });
          return;
        }
      }
      if (!dir) {
        if (alive) setState({ kind: "no-path" });
        return;
      }
      const base = dir.replace(/[\\/]+$/, "");
      for (const name of README_CANDIDATES) {
        try {
          const raw = await invoke<string>("read_text_file", { path: `${base}/${name}` });
          if (!alive) return;
          const capped = capUtf8(raw);
          setState({ kind: "ok", file: name, dir: base, text: capped.text, truncated: capped.truncated });
          return;
        } catch (e) {
          const reason = String(e);
          if (isMissingFileReason(reason)) continue;
          if (alive) setState({ kind: "error", reason });
          return;
        }
      }
      if (alive) setState({ kind: "missing" });
    })();
    return () => {
      alive = false;
    };
  }, [slug, cardPath]);

  const blocks = useMemo<MdBlock[]>(
    () => (state.kind === "ok" && mode === "rendered" ? parseMarkdown(state.text) : []),
    [state, mode],
  );

  if (!card) return null;

  const subtitle =
    state.kind === "ok" ? `${state.file} · ${state.dir}` : cardPath || undefined;

  return (
    <DialogShell
      title={t("readme.dialogTitle")}
      subtitle={subtitle}
      onClose={onClose}
      width="lg"
    >
      {state.kind === "loading" && (
        <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("readme.loading")}
        </p>
      )}

      {state.kind === "no-path" && (
        <p className="py-2 text-caption text-muted-foreground">{t("readme.noPath")}</p>
      )}
      {state.kind === "missing" && (
        <p className="py-2 text-caption text-muted-foreground">{t("readme.notFound")}</p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          {t("readme.error", { reason: state.reason })}
        </p>
      )}

      {state.kind === "ok" && (
        <>
          <div className="mb-2 flex items-center gap-2">
            {(["rendered", "raw"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "skin-ctl border px-2.5 py-1 text-caption t-state",
                  mode === m
                    ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {m === "rendered" ? t("readme.viewRendered") : t("readme.viewRaw")}
              </button>
            ))}
            {state.truncated && (
              <span className="text-caption text-warning">{t("readme.truncated")}</span>
            )}
          </div>

          {state.text.trim() === "" ? (
            <p className="py-2 text-caption text-muted-foreground">{t("readme.emptyFile")}</p>
          ) : mode === "raw" ? (
            // The 原文 view is plain text, never markup: a <pre> with the file's
            // own bytes is the honest fallback when the renderer is not trusted
            // for a construct.
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border-weak bg-background p-3 text-caption leading-relaxed text-muted-foreground">
              {state.text}
            </pre>
          ) : (
            <div className="leading-relaxed text-foreground">
              {blocks.map((b, i) => renderBlock(b, i, t))}
            </div>
          )}
        </>
      )}
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// The renderer. It maps the parser's node tree onto elements — which is the
// second half of the parser's security model: no string of the document is ever
// handed to `dangerouslySetInnerHTML`, so a README cannot inject markup.
// ---------------------------------------------------------------------------

function renderBlock(b: MdBlock, key: number, t: TFunc): ReactNode {
  switch (b.type) {
    case "heading":
      return (
        <Heading key={key} level={b.level}>
          {renderInline(b.inline, t, `h${key}`)}
        </Heading>
      );
    case "paragraph":
      return (
        <p key={key} className="my-2 text-body leading-relaxed">
          {renderInline(b.inline, t, `p${key}`)}
        </p>
      );
    case "code":
      return (
        <div key={key} className="my-2">
          {b.lang !== "" && (
            <p className="text-caption text-muted-foreground">{b.lang}</p>
          )}
          <pre className="overflow-x-auto rounded-lg border border-border-weak bg-muted/40 p-2.5 font-mono text-caption leading-relaxed text-foreground">
            {b.text}
          </pre>
        </div>
      );
    case "quote":
      return (
        <blockquote key={key} className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {b.blocks.map((inner, i) => renderBlock(inner, i, t))}
        </blockquote>
      );
    case "list":
      return b.ordered ? (
        <ol key={key} className="my-2 list-decimal pl-5">
          {b.items.map((item, i) => (
            <ListItem key={i} item={item} t={t} />
          ))}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-disc pl-5">
          {b.items.map((item, i) => (
            <ListItem key={i} item={item} t={t} />
          ))}
        </ul>
      );
    case "hr":
      return <hr key={key} className="my-3 border-border-weak" />;
  }
}

function Heading({ level, children }: { level: number; children: ReactNode }) {
  const cls = "mt-3 mb-1.5 font-medium text-foreground";
  switch (level) {
    case 1:
      return <h1 className={cn(cls, "text-display")}>{children}</h1>;
    case 2:
      return <h2 className={cn(cls, "text-view")}>{children}</h2>;
    case 3:
      return <h3 className={cn(cls, "text-body")}>{children}</h3>;
    case 4:
      return <h4 className={cn(cls, "text-body")}>{children}</h4>;
    case 5:
      return <h5 className={cn(cls, "text-caption")}>{children}</h5>;
    default:
      return <h6 className={cn(cls, "text-caption")}>{children}</h6>;
  }
}

function ListItem({ item, t }: { item: MdListItem; t: TFunc }) {
  return (
    <li className="text-body leading-relaxed">
      {renderInline(item.inline, t, "li")}
      {item.children.length > 0 && (
        <ul className="list-disc pl-5">
          {item.children.map((child, i) => (
            <ListItem key={i} item={child} t={t} />
          ))}
        </ul>
      )}
    </li>
  );
}

function renderInline(nodes: MdInline[], t: TFunc, prefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${prefix}-${i}`;
    switch (n.type) {
      case "text":
        return <span key={key}>{n.text}</span>;
      case "code":
        return (
          <code key={key} className="rounded bg-muted/50 px-1 py-0.5 font-mono text-caption text-foreground">
            {n.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(n.children, t, key)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(n.children, t, key)}</em>;
      case "link":
        // The parser only ever emits http/https here (see isSafeHref), so the
        // href is already whitelisted; the click opens the system browser rather
        // than navigating the webview.
        return (
          <a
            key={key}
            href={n.href}
            title={t("readme.openLink", { href: n.href })}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(n.href);
            }}
            className="text-primary underline decoration-dotted"
          >
            {renderInline(n.children, t, key)}
          </a>
        );
      case "image":
        // A remote image is never fetched from a document just being displayed;
        // the alt text stands in for it.
        return (
          <span key={key} className="text-caption text-muted-foreground">
            {t("readme.imageAlt", { alt: n.alt })}
          </span>
        );
    }
  });
}
