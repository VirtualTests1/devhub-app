import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Download, LoaderCircle, RefreshCw, Star, TriangleAlert } from "lucide-react";
import { cn } from "../lib/utils";
import { formatNumber } from "../lib/format";
import { messageOf } from "../lib/report-error";
import { toast } from "../components/Toast";
import { useUI } from "../store/ui";
import { useDownloads } from "../store/downloads";
import { useCorpus } from "../store/corpus";
import { useI18n } from "../lib/useI18n";
import { reg } from "../store/customize";
import type { RepoHit, StarPage } from "../types";

/**
 * 星标导入（r18 N3）：把 GitHub 账号的 Star 批量搬进下载队列。
 *
 * The work split with the backend is deliberate: `stars.rs` owns the token,
 * the request and the paging rules; this panel owns selection and the queue
 * handover. Nothing here talks to GitHub directly — the token does not exist
 * in the webview at all (`docs/security-posture.md`).
 *
 * Loading is an explicit click rather than an effect on expand: one request
 * per visit that the user may never use is exactly the kind of background
 * spend the search panel's rate-guard history was about, and the stars list
 * changes rarely enough that "stale until asked" is fine.
 *
 * This panel is deliberately not gated behind a settings section and not
 * behind the search block's visibility toggle: it answers a different
 * question (what do I already want) than search does (what exists), and the
 * collapsed header keeps it out of the way until asked.
 */
export function StarImportPanel({
  onDownload,
  owned,
}: {
  onDownload: (ref: string, source: string) => void;
  /** Slugs already on disk (`github.com/owner/repo`, lower-cased). */
  owned: Set<string>;
}) {
  const { t } = useI18n();
  const go = useUI((s) => s.go);
  const setSettingsSection = useUI((s) => s.setSettingsSection);
  const tasks = useDownloads((s) => s.tasks);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RepoHit[]>([]);
  /** Last successfully fetched page; 0 = nothing loaded yet. */
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  /**
   * Same monotonic guard as SearchBlock: pages answer out of order on a slow
   * connection, and an old response appending after a reload would interleave
   * two different snapshots of the list.
   */
  const seq = useRef(0);

  /** Refs with an unfinished download, so a row can say so before it is added twice. */
  const queued = useMemo(() => {
    const s = new Set<string>();
    for (const task of tasks) {
      if (task.status !== "done" && task.status !== "failed") s.add(task.ref.trim().toLowerCase());
    }
    return s;
  }, [tasks]);

  const isOwned = (fullName: string) => owned.has(`github.com/${fullName.toLowerCase()}`);
  const isQueued = (fullName: string) => queued.has(fullName.toLowerCase());
  const isBlocked = (fullName: string) => isOwned(fullName) || isQueued(fullName);

  const fetchPage = async (p: number) => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const out = await invoke<StarPage>("list_starred_repos", { page: p });
      if (mine !== seq.current) return;
      // r21-n2-2: this page already paid for its rows — file their descriptions
      // into the local-index corpus (zero extra requests; see `lib/corpus.ts`).
      useCorpus.getState().absorbDescriptions(out.items);
      // The same repo can appear on two pages if it was starred while the
      // list was being walked; the first copy wins, the list must not grow
      // duplicate keys.
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.fullName));
        return [...prev, ...out.items.filter((i) => !seen.has(i.fullName))];
      });
      setPage(out.page);
      setHasMore(out.hasMore);
      setRemaining(out.remaining ?? null);
    } catch (e) {
      if (mine === seq.current) setError(messageOf(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  const reload = () => {
    setItems([]);
    setPage(0);
    setHasMore(false);
    setSelected(new Set());
    // The reset is synchronous state; `seq` is bumped inside fetchPage, which
    // is what invalidates any page still in flight from before the reload.
    void fetchPage(1);
  };

  const toggle = (fullName: string) => {
    if (isBlocked(fullName)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  const filterLower = filter.trim().toLowerCase();
  const visible = filterLower
    ? items.filter((i) => i.fullName.toLowerCase().includes(filterLower))
    : items;
  const selectableVisible = visible.filter((i) => !isBlocked(i.fullName));

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of selectableVisible) next.add(i.fullName);
      return next;
    });
  };

  const downloadSelected = () => {
    // Re-checked at click time: the library and the queue move between tick
    // and click, and refs that became blocked would each end as a refused
    // duplicate — one toast per repo instead of one summary.
    const picks = items.filter((i) => selected.has(i.fullName) && !isBlocked(i.fullName));
    if (picks.length === 0) {
      toast.info(t("stars.allSkipped"));
    } else {
      for (const p of picks) onDownload(p.fullName, t("stars.source"));
      toast.success(t("stars.enqueued", { n: picks.length }));
    }
    setSelected(new Set());
  };

  /**
   * The one backend error with a better remedy than retry is the missing
   * token, and it is recognised by its stable ASCII marker rather than by
   * exact sentence — the wording may change, the two words "GitHub Token"
   * are the contract the jump button hangs on.
   */
  const tokenMissing = !!error && error.includes("GitHub Token");
  const retry = () => void fetchPage(page === 0 ? 1 : page + 1);

  const smallButton =
    "skin-ctl flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption " +
    "text-muted-foreground t-state hover:bg-accent hover:text-foreground active:scale-[0.97] " +
    "disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section {...reg("add-stars-panel")} className="skin-panel mt-3 border border-border-weak bg-card p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <Star className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="skin-label text-body font-medium">{t("stars.title")}</span>
        <span className="ml-1 hidden min-w-0 truncate text-caption text-muted-foreground sm:inline">
          {t("stars.hint")}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-state)]",
            !open && "-rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="mt-2.5">
          {error && (
            <div className="rounded-xl border border-border-weak bg-background p-3">
              <p className="flex items-start gap-1.5 text-caption leading-snug text-danger">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                {error}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={retry} disabled={busy} className={smallButton}>
                  {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {page === 0 ? t("stars.load") : t("stars.loadMore")}
                </button>
                {tokenMissing && (
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsSection("token");
                      go("settings");
                    }}
                    className={smallButton}
                  >
                    {t("stars.goToken")}
                  </button>
                )}
              </div>
            </div>
          )}

          {!error && page === 0 && (
            <button
              type="button"
              onClick={() => void fetchPage(1)}
              disabled={busy}
              className="skin-ctl flex items-center gap-1.5 bg-primary px-3 py-1.5 text-caption font-medium
                         text-primary-foreground t-state hover:brightness-95 active:scale-[0.98]
                         disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
              {busy ? t("stars.loading") : t("stars.load")}
            </button>
          )}

          {page > 0 && (
            <>
              {items.length === 0 ? (
                <p className="text-caption leading-relaxed text-muted-foreground">{t("stars.empty")}</p>
              ) : (
                <>
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t("stars.filterPlaceholder")}
                    aria-label={t("stars.filterPlaceholder")}
                    spellCheck={false}
                    className="w-full skin-ctl border border-input bg-background px-3 py-1.5 text-caption
                               outline-none transition-colors placeholder:text-muted-foreground/60
                               focus:border-primary sm:max-w-xs"
                  />
                  <ul className="mt-2.5 space-y-2">
                    {visible.map((h) => {
                      const [owner, ...rest] = h.fullName.split("/");
                      const name = rest.join("/");
                      const have = isOwned(h.fullName);
                      const q = isQueued(h.fullName);
                      const blocked = have || q;
                      return (
                        <li key={h.fullName}>
                          <label
                            className={cn(
                              "flex items-start gap-2.5 rounded-xl border border-border-weak bg-background p-2.5 t-state",
                              blocked
                                ? "cursor-not-allowed opacity-60"
                                : "cursor-pointer hover:border-primary/40 focus-within:border-primary/40",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(h.fullName)}
                              disabled={blocked}
                              onChange={() => toggle(h.fullName)}
                              className="mt-0.5 accent-[var(--color-primary)]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <span className="min-w-0 truncate text-body">
                                  <span className="text-muted-foreground">{owner}/</span>
                                  <span className="font-medium">{name}</span>
                                </span>
                                <span className="flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
                                  <Star className="h-2.5 w-2.5" />
                                  {formatNumber(h.stars)}
                                </span>
                                {h.language && (
                                  <span className="shrink-0 rounded bg-muted px-1 py-px text-caption text-muted-foreground">
                                    {h.language}
                                  </span>
                                )}
                                {h.archived && (
                                  <span className="shrink-0 rounded bg-warning/15 px-1 py-px text-caption text-warning">
                                    {t("stars.archived")}
                                  </span>
                                )}
                                {have && (
                                  <span className="shrink-0 rounded bg-success/15 px-1 py-px text-caption text-success">
                                    {t("stars.owned")}
                                  </span>
                                )}
                                {q && (
                                  <span className="shrink-0 rounded bg-muted px-1 py-px text-caption text-muted-foreground">
                                    {t("stars.queued")}
                                  </span>
                                )}
                              </span>
                              {h.description && (
                                <span className="mt-1 line-clamp-2 block text-caption leading-snug text-muted-foreground">
                                  {h.description}
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {visible.length === 0 && (
                    <p className="mt-2 text-caption text-muted-foreground">{t("stars.filterEmpty")}</p>
                  )}
                </>
              )}

              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span>
                  {t("stars.loaded", { n: items.length })}
                  {remaining != null && ` · ${t("stars.remaining", { n: remaining })}`}
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <span>{t("stars.selected", { n: selected.size })}</span>
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    disabled={selectableVisible.length === 0}
                    className={smallButton}
                  >
                    {t("stars.selectAll")}
                  </button>
                  {selected.size > 0 && (
                    <button type="button" onClick={() => setSelected(new Set())} className={smallButton}>
                      {t("stars.clearSelected")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={downloadSelected}
                    disabled={selected.size === 0}
                    className="skin-ctl flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-caption
                               font-medium text-primary-foreground t-state hover:brightness-95
                               active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3 w-3" />
                    {t("stars.download", { n: selected.size })}
                  </button>
                  <button
                    type="button"
                    onClick={reload}
                    disabled={busy}
                    title={t("stars.reload")}
                    aria-label={t("stars.reload")}
                    className={smallButton}
                  >
                    <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
                  </button>
                  {hasMore && (
                    <button
                      type="button"
                      onClick={() => void fetchPage(page + 1)}
                      disabled={busy}
                      className={smallButton}
                    >
                      {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
                      {t("stars.loadMore")}
                    </button>
                  )}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
