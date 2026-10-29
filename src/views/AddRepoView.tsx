import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { openHttpUrl } from "../lib/external-url";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  History,
  LoaderCircle,
  RotateCcw,
  Search,
  Star,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn, parseGithubRepoUrl } from "../lib/utils";
import { BULK_MAX, parseBulkRefs } from "../lib/bulk-refs";
import { readBranches, rememberBranch } from "../lib/branch-recent";
import { useLayerExit } from "../lib/motion";
import { useDismiss } from "../lib/useDismiss";
import { formatBytes, formatNumber } from "../lib/format";
import { ViewHeader } from "../shell/AppShell";
import { Toggle } from "../components/Toggle";
import { PathInput } from "../components/PathInput";
import { DownloadQueue } from "../components/DownloadQueue";
import { MenuSelect } from "../components/Controls";
import { toast } from "../components/Toast";
import { messageOf, reportError, swallow } from "../lib/report-error";
import { isTranslationKey, type TFunc } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { isCommitEnter, isImeComposing } from "../lib/ime";
import { useUI } from "../store/ui";
import { useAppearance } from "../store/appearance";
import { useCustomize, reg } from "../store/customize";
import { useLanding } from "../store/landing";
import { useSavedSearches } from "../store/searches";
import { useDownloads } from "../store/downloads";
import { useCorpus } from "../store/corpus";
import type { RefPreview, RemotePreview, RepoRef, SearchOutcome, SearchStatus } from "../types";

/**
 * Add view: download + search in one place, because searching for a repository
 * and downloading it are the same task.
 *
 * ## What changed here and why
 *
 *   - **The debounce is a setting, editable in both places.** It used to be a
 *     literal `1000` in this file; then a read-only number that pointed at the
 *     settings page. The read-only version reported "调整停顿毫秒数没有反应",
 *     so the field here is now a real input: blur or Enter writes it back
 *     through `onSaveDebounce`, and the settings page shows the same value.
 *   - **The composer is the one primary action.** Everything else - the slug
 *     preview, the landing-path editor, the conflict warning - reads as
 *     information rows around it, not as competing controls.
 *   - **The landing path can be overridden per download.** 高级选项 carries a
 *     path editor; the preview above recomputes from it, and the download
 *     itself receives the override. Clicking the path opens it in Explorer
 *     (creating it first), because at preview time it usually does not exist.
 *   - **There is a 搜索 button.** Debounce-only means every search is implicit,
 *     and there is no way to say "run it now" without typing another character.
 *   - **A result can be opened, previewed, or filled.** The report asked for the
 *     browser link *or* an in-app README, and for the choice to be configurable.
 *     So the row carries all three actions and one switch decides what clicking
 *     the row itself does.
 *   - **高级选项 is a real disclosure.** It was a text button that swapped its
 *     own label, which reads as a link rather than something expandable.
 */
const StarImportPanel = lazy(() =>
  import("../components/StarImportPanel").then((m) => ({ default: m.StarImportPanel })),
);

export function AddRepoView({
  onDownload,
  settings,
  mirrorEnabled,
  ipPinEnabled,
  onToggleMirror,
  onToggleIpPin,
  onSaveDebounce,
  gitReady,
  repos,
}: {
  onDownload: (
    ref: string,
    source: string,
    targetDir?: string,
    overwrite?: boolean,
    branch?: string,
  ) => void;
  settings: {
    searchDebounceMs: number;
    searchRoute: string;
    downloadRoute: string;
    hostsHijacked: boolean;
    hostsBy: string | null;
    /** Directories that have been the project root before, newest first. */
    recentRoots: string[];
  } | null;
  mirrorEnabled: boolean;
  ipPinEnabled: boolean;
  onToggleMirror: (v: boolean) => void;
  onToggleIpPin: (v: boolean) => void;
  onSaveDebounce: (ms: number) => void;
  gitReady: boolean;
  /** What is already on disk, so a search result can say so. */
  repos?: RepoRef[];
}) {
  const seed = useUI((s) => s.composerSeed);
  const setComposerSeed = useUI((s) => s.setComposerSeed);
  const showSearchBlock = useAppearance((s) => s.showSearchBlock);
  const busyCount = useDownloads((s) => s.tasks.filter((x) => x.status === "running").length);
  const landingHistory = useLanding((s) => s.history);
  const rememberLanding = useLanding((s) => s.remember);
  const { t } = useI18n();
  const [input, setInput] = useState(seed);
  const [branch, setBranch] = useState("");
  const [branchRecent, setBranchRecent] = useState<string[]>(() => readBranches());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** The 高级选项 block, scrolled to when 落位's 更改 is pressed. */
  const advancedRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(true);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [preview, setPreview] = useState<RefPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemotePreview | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  // Raw text of the 落位 override editor. Empty = the computed default path.
  const [targetDraft, setTargetDraft] = useState("");
  // Round 11 (需求 8.7): replace an occupied landing directory instead of
  // refusing. Off by default, lives in 高级选项 beside the override it can
  // destroy, and resets when the input is cleared - a stale "overwrite" that
  // outlives the download it was meant for is how a wrong directory gets eaten.
  const [overwrite, setOverwrite] = useState(false);

  /**
   * The 历史路径 dropdown's contents (需求 3): the overrides this person chose
   * by hand first, then the directories that have been the project root. Two
   * different questions - "where did I put things" and "what roots have I
   * used" - answered from two different stores, deduplicated case-insensitively
   * because `D:\X` and `d:\x` are one directory.
   */
  const historyPaths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...landingHistory, ...(settings?.recentRoots ?? [])]) {
      const key = p.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= 8) break;
    }
    return out;
  }, [landingHistory, settings?.recentRoots]);

  useEffect(() => {
    if (seed) setInput(seed);
  }, [seed]);

  // The override that actually takes part in preview/download: trimmed, and
  // empty when the user cleared the editor back to "follow the default".
  const targetOverride = targetDraft.trim();

  // Preview the landing path as the user types. Debounced, and it never touches
  // the network - the backend only parses the ref and computes a path. The
  // override is passed through so the preview shows exactly where a download
  // with these settings would land.
  useEffect(() => {
    const term = input.trim();
    if (!term) {
      setPreview(null);
      setPreviewError(null);
      setRemote(null);
      setRemoteError(null);
      return;
    }
    // A new ref or landing path invalidates the old remote answer; leaving it on
    // screen would attribute the previous repository's facts to the next one.
    setRemote(null);
    setRemoteError(null);
    const tid = setTimeout(async () => {
      try {
        setPreview(
          await invoke<RefPreview>("preview_ref", {
            input: term,
            targetDir: targetOverride || null,
          }),
        );
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        setPreviewError(t("add.parseFail", { m: messageOf(e) }));
      }
    }, 250);
    return () => clearTimeout(tid);
    // `t` is memoised on the locale (useI18n); a switch re-runs the preview so
    // an error message already in state comes back in the new language.
  }, [input, targetOverride, t]);

  /**
   * Remote facts are fetched **only on demand**: the repository endpoint has its own
   * rate-limit budget, and a debounced keystroke is not consent to spend it. The
   * button lives beside the local preview so the two answers read together.
   */
  const loadRemote = async () => {
    const term = input.trim();
    if (!term) return;
    setRemoteBusy(true);
    setRemoteError(null);
    try {
      const r = await invoke<RemotePreview>("preview_remote", {
        input: term,
        targetDir: preview?.target ?? null,
      });
      setRemote(r);
    } catch (e) {
      setRemote(null);
      setRemoteError(t("add.remoteFail", { m: messageOf(e) }));
    } finally {
      setRemoteBusy(false);
    }
  };

  const startDownload = () => {
    const term = input.trim();
    if (term) {
      // Remembered at click time rather than on success: the list is "paths
      // you chose", and a choice that failed to download is still a choice
      // the person may want to repeat.
      if (targetOverride) rememberLanding(targetOverride);
      const branchName = branch.trim();
      if (branchName) setBranchRecent(rememberBranch(branchName));
      // 来源名是写进记录归档的数据标识（records 的 source 字段），不是界面文案，
      // 有意不接词表——归档里的旧记录按字节匹配它。
      onDownload(term, "添加页", targetOverride || undefined, overwrite, branchName || undefined);
      // One-shot: the next download starts from the safe default again.
      setOverwrite(false);
    }
  };

  const bulk = useMemo(() => parseBulkRefs(bulkText), [bulkText]);

  /**
   * Queue every accepted ref. Two deliberate choices:
   *
   *   - `overwrite` is always false here. The checkbox in 高级选项 was clicked
   *     for one repository; applying it to twenty pasted lines would destroy
   *     directories nobody looked at.
   *   - The accepted lines leave the box, but invalid lines and refs over the cap
   *     stay, so the user can fix them instead of re-pasting the whole block.
   */
  const queueBulk = () => {
    if (!bulk.accepted.length || !gitReady) return;
    for (const ref of bulk.accepted) {
      onDownload(
        ref,
        t("add.bulkSource"),
        targetOverride || undefined,
        false,
        branch.trim() || undefined,
      );
    }
    toast.success(t("add.bulkQueued", { n: bulk.accepted.length }));
    if (bulk.overflow > 0) return;
    setBulkText(bulk.invalid.map((i) => i.text).join("\n"));
  };

  const revealTarget = (path: string) => {
    // `String(e)` is exactly the shape `messageOf`/`reportError` were extracted to
    // end: on a real Error it produced "Error: 后端原话", and the copy rule
    // (`report-error.ts:15-17`, full-width colon, verb first) wants the sentence.
    void invoke("reveal_path", { path }).catch((e) => reportError(e, t("add.revealFail")));
  };

  /**
   * Slugs of repositories already on disk, lower-cased. A search that cannot
   * tell you which of its results you already have makes you open each one to
   * find out — GitHub's own search has this problem and it is not worth copying.
   */
  const owned = useMemo(() => {
    const s = new Set<string>();
    for (const r of repos ?? []) s.add(`${r.host}/${r.owner}/${r.repo}`.toLowerCase());
    return s;
  }, [repos]);

  return (
    <>
      <ViewHeader title={t("add.header")} hint={t("add.headerHint")} headerId="add-header" />

      {/* composer: the one primary action of this view */}
      <section {...reg("add-composer-panel")} className="skin-panel border border-border-weak bg-card p-4">
        <div className="flex gap-2.5">
          <input
            value={input}
            aria-label={t("add.inputAria")}
            onChange={(e) => {
              setInput(e.target.value);
              setComposerSeed("");
            }}
            onKeyDown={(e) => {
              // Enter starts the download, but a composition Enter only picks an
              // IME candidate — committing that would clone a half-typed ref.
              if (isCommitEnter(e)) startDownload();
            }}
            placeholder={t("add.inputPh")}
            spellCheck={false}
            className="min-w-0 flex-1 skin-ctl border border-input bg-background px-3.5 py-2 text-body
                       outline-none transition-colors placeholder:text-muted-foreground/60
                       focus:border-primary"
          />
          <button
            type="button"
            onClick={startDownload}
            disabled={!input.trim() || !gitReady}
            className="skin-ctl flex shrink-0 items-center gap-2 bg-primary px-5 py-2 text-body
                       font-medium text-primary-foreground shadow-sm t-state hover:brightness-95
                       active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busyCount > 0 ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {busyCount > 0 ? t("add.busyN", { n: busyCount }) : t("add.download")}
          </button>
        </div>

        {/* A disabled control swallows the pointer and leaves the tab order, so the
            title "需要先安装 Git" would never show. Say it as visible text instead,
            the way the 项目页 下载 gate does with `disabledReason`. */}
        {!gitReady && (
          <p className="mt-2 flex items-start gap-1.5 text-caption leading-snug text-warning">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {t("add.gitMissing")}
          </p>
        )}

        {previewError && <p className="mt-2 text-caption text-danger">{previewError}</p>}

        {/* resolved facts as information rows: label + mono value + action */}
        {preview && !previewError && (
          <div
            {...reg("add-preview-lines")}
            className="mt-3 space-y-1 rounded-xl bg-muted/30 px-3 py-2 text-caption"
          >
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-muted-foreground/70">slug</span>
              <code className="min-w-0 truncate rounded bg-background px-1.5 py-0.5 font-mono">
                {preview.slug}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-10 shrink-0 text-muted-foreground/70">{t("add.landing")}</span>
              <button
                type="button"
                onClick={() => revealTarget(preview.target)}
                title={t("add.openTargetTitle")}
                className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 text-left
                           font-mono text-primary transition-colors hover:bg-accent/60 hover:underline"
              >
                {preview.target}
              </button>
              {/* 需求 3: a dropdown of paths used before, instead of retyping
                  one. The folder icon that sat here was removed - it read as
                  "choose a directory" while it only opened this one. */}
              <HistoryPicker paths={historyPaths} onPick={setTargetDraft} />
              {/* 落位 is 需求 3's whole point, and it used to be two levels down:
                  collapsed 高级选项, then a path editor inside it. One click here
                  opens that section and brings it into view. */}
              <button
                type="button"
                onClick={() => {
                  setAdvancedOpen(true);
                  advancedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }}
                className="skin-ctl t-state shrink-0 border border-border px-2 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97]"
              >
                {t("add.change")}
              </button>
            </div>
            {preview.exists && (
              <div className="flex items-center gap-1.5 pt-0.5 text-warning">
                <TriangleAlert className="h-3 w-3 shrink-0" />
                {t("add.existsWarn")}
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void loadRemote()}
                disabled={remoteBusy}
                className="skin-ctl t-state border border-border px-2 py-1 text-caption text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] disabled:opacity-50"
              >
                {remoteBusy ? t("add.remoteLoading") : t("add.remoteLoad")}
              </button>
              <span className="text-caption text-muted-foreground">{t("add.remoteHint")}</span>
            </div>
          </div>
        )}

        {remoteError && (
          <p role="alert" className="mt-2 text-caption text-danger">
            {remoteError}
          </p>
        )}

        {remote && (
          <div className="mt-2 rounded-xl border border-border-weak bg-muted/20 px-3 py-2 text-caption">
            {remote.facts ? (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                  <RemoteFact label={t("add.remoteStars")} value={formatNumber(remote.facts.stars)} />
                  <RemoteFact label={t("add.remoteLanguage")} value={remote.facts.language ?? "—"} />
                  <RemoteFact label={t("add.remoteLicense")} value={remote.facts.license ?? "—"} />
                  <RemoteFact label={t("add.remoteBranch")} value={remote.facts.defaultBranch ?? "—"} />
                  <RemoteFact
                    label={t("add.remoteSize")}
                    value={remote.facts.size == null ? "—" : String(remote.facts.size)}
                  />
                  <RemoteFact
                    label={t("add.remotePushed")}
                    value={remote.facts.pushedAt ? remote.facts.pushedAt.slice(0, 10) : "—"}
                  />
                </div>
                {remote.facts.description && (
                  <p className="mt-1.5 line-clamp-3 leading-snug text-muted-foreground">{remote.facts.description}</p>
                )}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {remote.facts.archived && <RemoteBadge text={t("add.remoteArchived")} />}
                  {remote.facts.private && <RemoteBadge text={t("add.remotePrivate")} />}
                  {remote.facts.fork && <RemoteBadge text={t("add.remoteFork")} />}
                </div>
              </>
            ) : (
              <p role="alert" className="text-danger">
                {t("add.remoteUnavailable", { reason: remote.error ?? "—" })}
              </p>
            )}
            <p className="mt-1.5 border-t border-border-weak pt-1 text-muted-foreground">
              {remote.diskFreeBytes != null
                ? t("add.remoteDisk", {
                    free: formatBytes(remote.diskFreeBytes),
                    total: remote.diskTotalBytes != null ? formatBytes(remote.diskTotalBytes) : "—",
                    path: remote.diskPath,
                  })
                : t("add.remoteDiskUnknown", { path: remote.diskPath, reason: remote.diskError ?? "—" })}
            </p>
          </div>
        )}

        {/* advanced: per-download overrides and set-once switches, collapsed by default */}
        <div {...reg("add-advanced-block")} ref={advancedRef} className="mt-3 border-t border-border-weak pt-2.5">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-caption text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-transform duration-[var(--motion-state)]",
                advancedOpen && "rotate-180",
              )}
            />
            <span className="skin-label font-medium">{t("add.advanced")}</span>
            {targetOverride && (
              <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-caption text-foreground">
                {t("add.landingCustom")}
              </span>
            )}
            {mirrorEnabled && (
              <span className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-caption text-warning">
                <TriangleAlert className="h-2.5 w-2.5" />
                {t("add.mirrorOn")}
              </span>
            )}
            {settings?.hostsHijacked && (
              <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-caption text-info">
                {/* 兜底名只在 hosts 探测没拿到进程名时展示，不是界面词条，
                    与后端探测文案共用同一来源，有意保持字面量。 */}
                {t("add.hostsFound", { by: settings.hostsBy ?? t("add.hostsFallback") })} ·{" "}
                {settings.searchRoute === "useHosts" ? t("add.hostsUse") : t("add.hostsBypass")}
              </span>
            )}
          </button>
          <div
            className={cn(
              "grid disclosure",
              advancedOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="overflow-hidden">
              <div className="mt-2 space-y-2.5 rounded-xl bg-muted/20 p-3">
                {/* 落位覆盖: the effective path is previewed above and travels
                    with the download call. */}
                <div className="rounded-lg border border-border-weak bg-card p-2.5">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-body font-medium">{t("add.landingDir")}</span>
                    {targetOverride && (
                      <button
                        type="button"
                        onClick={() => setTargetDraft("")}
                        title={t("add.resetDefaultTitle")}
                        className="ml-auto flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5
                                   text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <RotateCcw className="h-2.5 w-2.5" />
                        {t("add.resetDefault")}
                      </button>
                    )}
                  </div>
                  <p className="app-desc mt-1 text-caption leading-snug text-muted-foreground">
                    {t("add.landingHint")}
                  </p>
                  <div className="mt-2">
                    <PathInput
                      value={targetDraft}
                      onChange={setTargetDraft}
                      label={t("add.dirLabel")}
                      placeholder={t("add.dirPh")}
                    />
                  </div>
                </div>

                {/* r27-N1: branch selection. Empty means the remote's default
                    branch; the backend validates it with git check-ref-format
                    before any clone, so a typo fails before a directory exists. */}
                <div className="rounded-lg border border-border-weak bg-card p-2.5">
                  <label className="skin-label text-caption" htmlFor="add-branch-input">
                    {t("add.branchLabel")}
                  </label>
                  <input
                    id="add-branch-input"
                    list="add-branch-recent"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder={t("add.branchPh")}
                    spellCheck={false}
                    className="mt-1 w-full rounded border border-input bg-background px-2 py-1 font-mono text-caption outline-none focus:border-primary"
                  />
                  <datalist id="add-branch-recent">
                    {branchRecent.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                  <p className="app-desc mt-1 text-caption leading-snug text-muted-foreground">
                    {t("add.branchHint")}
                  </p>
                </div>

                {/* Round 11 (需求 8.7): the one destructive option, so it sits
                    right under the directory it can destroy and reads as a
                    warning rather than a preference. One-shot - it clears when
                    the download starts, so the next one is safe by default. */}
                <div className="rounded-lg border border-border-weak bg-card p-2.5">
                  <Toggle
                    checked={overwrite}
                    onChange={setOverwrite}
                    label={t("add.overwriteLabel")}
                    hint={t("add.overwriteHint")}
                  />
                  {preview?.exists && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-caption leading-snug text-warning">
                      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                      {t("add.overwriteWarn")}
                    </p>
                  )}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <span {...reg("add-toggle-ip-pin")} className="contents">
                    <Toggle
                      checked={ipPinEnabled}
                      onChange={onToggleIpPin}
                      label={t("add.ipPinLabel")}
                      hint={t("add.ipPinHint")}
                    />
                  </span>
                  <span {...reg("add-toggle-mirror")} className="contents">
                    <Toggle
                      checked={mirrorEnabled}
                      onChange={onToggleMirror}
                      label={t("add.mirrorLabel")}
                      hint={t("add.mirrorHint")}
                    />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* bulk: many refs pasted at once, each queued through the same
          onDownload the composer uses. Collapsed by default — the single
          composer stays the primary action. */}
      <section {...reg("add-bulk-panel")} className="skin-panel mt-3 border border-border-weak bg-card p-4">
        <button
          type="button"
          onClick={() => setBulkOpen((v) => !v)}
          aria-expanded={bulkOpen}
          className="flex w-full items-center gap-2 text-left"
        >
          <Download className="h-4 w-4 text-muted-foreground" />
          <span className="skin-label text-body font-medium">{t("add.bulkTitle")}</span>
          <ChevronDown
            className={cn(
              "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-[var(--motion-state)]",
              !bulkOpen && "-rotate-90",
            )}
          />
        </button>
        {bulkOpen && (
          <div className="mt-2.5">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={t("add.bulkPlaceholder")}
              aria-label={t("add.bulkTitle")}
              spellCheck={false}
              rows={5}
              className="w-full resize-y skin-ctl border border-input bg-background px-3 py-2 font-mono text-caption
                         leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <span>{t("add.bulkReady", { n: bulk.accepted.length, max: BULK_MAX })}</span>
              {bulk.duplicates.length > 0 && <span>{t("add.bulkDup", { n: bulk.duplicates.length })}</span>}
              {bulk.invalid.length > 0 && (
                <span className="text-warning">
                  {t("add.bulkInvalid", { n: bulk.invalid.length })}
                  {" "}
                  {bulk.invalid
                    .slice(0, 3)
                    .map((i) => `#${i.at} ${i.text}`)
                    .join(" · ")}
                </span>
              )}
              {bulk.overflow > 0 && (
                <span className="text-warning">{t("add.bulkOverflow", { n: bulk.overflow })}</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={queueBulk}
                disabled={!bulk.accepted.length || !gitReady}
                className="skin-ctl flex items-center gap-2 bg-primary px-4 py-1.5 text-body font-medium
                           text-primary-foreground shadow-sm t-state hover:brightness-95 active:scale-[0.98]
                           disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-3.5 w-3.5" />
                {t("add.bulkQueue", { n: bulk.accepted.length })}
              </button>
              <span className="text-caption text-muted-foreground">{t("add.bulkHint", { max: BULK_MAX })}</span>
            </div>
          </div>
        )}
      </section>

      {/* search: the origin of most downloads; hideable from 设置 → 界面 */}
      {showSearchBlock && (
        <section {...reg("add-search-panel")} className="skin-panel mt-3 border border-border-weak bg-card p-4">
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            aria-expanded={searchOpen}
            className="flex w-full items-center gap-2 text-left"
          >
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="skin-label text-body font-medium">{t("sp.header")}</span>
            <ChevronDown
              className={cn(
                "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-[var(--motion-state)]",
                !searchOpen && "-rotate-90",
              )}
            />
          </button>
          {searchOpen && (
            <SearchBlock
              onDownload={onDownload}
              debounceMs={settings?.searchDebounceMs ?? 700}
              onSaveDebounce={onSaveDebounce}
              owned={owned}
            />
          )}
        </section>
      )}

      {/* stars: what you already want, as opposed to search's what exists
          (r18 N3). Collapsed by default — one request only when asked. */}
      <Suspense fallback={null}>
        <StarImportPanel onDownload={onDownload} owned={owned} />
      </Suspense>

      {/* process: the queue, one panel per task */}
      <DownloadQueue />
    </>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * GitHub search with a configurable quiet period and an explicit trigger.
 *
 * The unauthenticated search API allows only 10 requests/minute, so the debounce
 * and the backend cache are what keep a typing user inside it — but the number
 * itself is now the user's, editable right here (blur/Enter writes it back), and
 * 搜索 is always available for the case where the debounce is set long and you
 * simply want the answer now.
 *
 * Round 9 (需求 4) added the rule that makes a long pause honest: above 5000 ms
 * the quiet period stops being a debounce and becomes a wait, so auto-search
 * switches off entirely and the query only runs on 搜索 / Enter. The control row
 * shows 仅手动搜索 while that is in effect, so the field never appears to be
 * ignored.
 */
function SearchBlock({
  onDownload,
  debounceMs,
  onSaveDebounce,
  owned,
}: {
  onDownload: (ref: string, source: string, targetDir?: string) => void;
  debounceMs: number;
  onSaveDebounce: (ms: number) => void;
  /** Slugs already on disk, so a result can be marked rather than re-downloaded. */
  owned: Set<string>;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("");
  const [page, setPage] = useState(1);
  /** r17-n2-1: 结果集内的客户端语言过滤。空串=不过滤。切查询时重置。 */
  const [langFilter, setLangFilter] = useState("");
  /** r17-n2-2: 最近跑过的查询（仅本次会话，内存里），和收藏查询分开。 */
  const [recents, setRecents] = useState<string[]>([]);
  const [result, setResult] = useState<SearchOutcome | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  /**
   * Round 13 (d5-2): `loading` is explicit because an empty README is a legal
   * answer. The old render branched on `readme.text` alone, so a repository
   * whose README file is empty (or whitespace) sat on 「正在读取…」 forever —
   * the loading state and the empty state were the same pixels.
   */
  const [readme, setReadme] = useState<{
    name: string;
    text: string;
    error: string | null;
    loading: boolean;
  } | null>(null);
  // Local draft of the debounce field: typing must not fire a save per
  // keystroke, and an invalid value must fall back instead of persisting.
  const [debounceDraft, setDebounceDraft] = useState(String(debounceMs));
  const resultClick = useCustomize((s) => s.resultClick);
  const setResultClick = useCustomize((s) => s.setResultClick);
  const setComposerSeed = useUI((s) => s.setComposerSeed);
  const savedSearches = useSavedSearches((s) => s.items);
  const pinSearch = useSavedSearches((s) => s.save);
  const unpinSearch = useSavedSearches((s) => s.remove);
  const seq = useRef(0);
  /**
   * Round 13 (d5-1): the README preview's own monotonic counter, separate from
   * `seq` on purpose — sharing it would let opening a preview invalidate an
   * in-flight search response (and vice versa), which is a different bug.
   */
  const readmeSeq = useRef(0);
  const { t } = useI18n();

  // A save made elsewhere (settings page, or this field's own commit echoing
  // back through App state) becomes the new draft when the field is idle.
  useEffect(() => {
    setDebounceDraft(String(debounceMs));
  }, [debounceMs]);

  const commitDebounce = () => {
    const n = Number(debounceDraft);
    if (!Number.isFinite(n) || n < 0 || n > 30000) {
      // Illegal value: fall back to the stored setting and tell the user why
      // the number they typed did not stick.
      setDebounceDraft(String(debounceMs));
      toast.error(t("sp.debounceErr"));
      return;
    }
    const ms = Math.round(n);
    setDebounceDraft(String(ms));
    if (ms !== debounceMs) onSaveDebounce(ms);
  };

  const run = async (term: string, p: number, s: string) => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const out = await invoke<SearchOutcome>("search_repositories", {
        query: term,
        page: p,
        sort: s,
      });
      // A slow earlier response must not replace a newer one.
      if (mine === seq.current) {
        setResult(out);
        // r21-n2-2: this search already paid for these rows — file their
        // descriptions into the local-index corpus (zero extra requests;
        // coverage and rejected alternatives in `lib/corpus.ts`).
        useCorpus.getState().absorbDescriptions(out.items);
        // 新结果集，旧语言过滤不再适用
        setLangFilter("");
        // r17-n2-2: 记下这条查询（去重、置顶、最多 5 条）。
        setRecents((r) => [term, ...r.filter((x) => x !== term)].slice(0, 5));
      }
    } catch (e) {
      if (mine === seq.current) {
        setResult({
          items: [],
          totalCount: 0,
          fromCache: false,
          notModified: false,
          remaining: null,
          resetIn: null,
          throttled: false,
          error: t("sp.searchFail", { m: messageOf(e) }),
        });
      }
    } finally {
      if (mine === seq.current) setBusy(false);
        // The budget read is decoration, not a gate: a search still works without it,
      // so swallowing is the right call — but `report-error.ts:109` makes an
      // intentional swallow state its reason out loud rather than leave it in a
      // comment nobody reads after the failure.
      void invoke<SearchStatus>("search_status")
        .then(setStatus)
        .catch((e) => swallow(e, t("sp.quotaFail")));
    }
  };

  useEffect(() => {
    void invoke<SearchStatus>("search_status")
      .then(setStatus)
      .catch((e) => swallow(e, t("sp.quotaFail")));
  }, [t]);

  // Round 9 (需求 4): "超过5s之后应当自动替换为不自动搜索，点击搜索才执行".
  // A quiet period longer than five seconds is not a debounce - it is a wait
  // the user already gave up on. Past the threshold there is no timer at all:
  // only 搜索 or Enter runs a query, and the control row says so.
  const MANUAL_AFTER_MS = 5000;
  const manualOnly = debounceMs > MANUAL_AFTER_MS;

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResult(null);
      return;
    }
    if (manualOnly) return;
    // A pasted repository link is not a query (round 11, 需求 8.8): searching
    // GitHub for the URL's own text finds nothing useful, and the composer
    // above would have taken the same string happily. The debounce path hands
    // it over exactly like Enter does.
    const pasted = parseGithubRepoUrl(term);
    if (pasted) {
      setComposerSeed(pasted);
      setQ("");
      toast.success(t("sp.pasteOk", { u: pasted }));
      return;
    }
    const tid = setTimeout(() => void run(term, page, sort), debounceMs);
    return () => clearTimeout(tid);
    // `run` is recreated every render on purpose; the effect is keyed to the
    // inputs that should actually re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, sort, debounceMs, manualOnly]);

  const openReadme = async (fullName: string) => {
    // Round 13 (d5-1): `run()` above has had this guard since round 4 — open A's
    // README, then B's, and A's slow reply used to land last and render A's text
    // under B's name, with `previewOf` already pointing at B. A dedicated
    // counter (not `seq`) so a preview and a search cannot invalidate each other.
    const mine = ++readmeSeq.current;
    setPreviewOf(fullName);
    setReadme({ name: fullName, text: "", error: null, loading: true });
    try {
      const text = await invoke<string>("repo_readme", { fullName });
      if (mine === readmeSeq.current) setReadme({ name: fullName, text, error: null, loading: false });
    } catch (e) {
      if (mine === readmeSeq.current) {
        setReadme({ name: fullName, text: "", error: t("sp.readmeFail", { m: messageOf(e) }), loading: false });
      }
    }
  };

  /** What a click on the row itself does — the configurable part. */
  const onRowClick = (fullName: string) => {
    if (resultClick === "browser") void openHttpUrl(`https://github.com/${fullName}`);
    else if (resultClick === "readme") void openReadme(fullName);
    else {
      setQ(fullName);
      setComposerSeed(fullName);
    }
  };

  const star = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          aria-label={t("sp.inputAria")}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          onKeyDown={(e) => {
            // Ignore anything that is not a real commit-Enter: other keys, and an
            // Enter that only accepts an in-progress IME candidate.
            if (e.key !== "Enter" || isImeComposing(e)) return;
            // A pasted link goes to the composer, not to GitHub's search
            // (round 11, 需求 8.8): the query would be the URL's own text.
            const pasted = parseGithubRepoUrl(q);
            if (pasted) {
              setComposerSeed(pasted);
              setQ("");
              toast.success(t("sp.pasteOk", { u: pasted }));
              return;
            }
            if (q.trim().length >= 2) void run(q.trim(), page, sort);
          }}
          placeholder={t("sp.inputPh")}
          spellCheck={false}
          className="min-w-0 flex-1 skin-ctl border border-input bg-background px-3 py-1.5 text-body
                     outline-none transition-colors placeholder:text-muted-foreground/60
                     focus:border-primary"
        />
        <span {...reg("add-search-sort")}>
          <MenuSelect
            value={sort}
            options={SEARCH_SORTS.map((s) => ({ id: s.id, label: sortLabel(t, s.id) }))}
            onChange={(v) => {
              setSort(v);
              setPage(1);
            }}
            ariaLabel={t("sp.sortAria")}
            width="w-[7.5rem]"
          />
        </span>
        <button
          type="button"
          onClick={() => {
            // Same recognition as Enter (round 11, 需求 8.8): the button is the
            // mouse path to the same answer.
            const pasted = parseGithubRepoUrl(q);
            if (pasted) {
              setComposerSeed(pasted);
              setQ("");
              toast.success(t("sp.pasteOk", { u: pasted }));
              return;
            }
            if (q.trim().length >= 2) void run(q.trim(), page, sort);
          }}
          disabled={busy || q.trim().length < 2}
          className="skin-ctl flex items-center gap-1.5 bg-primary px-3 py-1.5 text-caption font-medium
                     text-primary-foreground t-state hover:brightness-95 active:scale-[0.98]
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          {t("sp.run")}
        </button>
        {/* 保存这条查询：一句要试三次才凑对的关键词（`language:rust http client
            topic:server`）此前离开这一页就没了——落位目录有历史，搜索没有。排序档
            跟着一起存，因为「星标最多」是问题的一部分，不是顺带的设置。 */}
        <button
          type="button"
          onClick={() => {
            const term = q.trim();
            if (term.length < 2) return;
            pinSearch({ q: term, sort });
            toast.success(t("sp.saveOk", { q: term }));
          }}
          disabled={q.trim().length < 2}
          aria-label={t("sp.saveAria")}
          title={t("sp.saveTitle")}
          className="skin-ctl flex items-center gap-1 border border-border px-2 py-1.5 text-caption text-muted-foreground
                     transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Star className="h-3.5 w-3.5" />
          {t("sp.save")}
        </button>
        <SavedPicker
          entries={savedSearches}
          onPick={(entry) => {
            setQ(entry.q);
            setSort(entry.sort);
            setPage(1);
            void run(entry.q, 1, entry.sort);
          }}
          onRemove={unpinSearch}
        />
      </div>

      {/* r17-n2-2: 最近跑过的查询（内存、未收藏）。收藏查询在 SavedPicker，这里是
          「我刚搜过、不想存」的那批——点一下就重跑，不必重新打字。 */}
      {recents.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
          <span>{t("sp.recent")}</span>
          {recents.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setQ(r);
                setPage(1);
                void run(r, 1, sort);
              }}
              className="max-w-40 truncate rounded-full border border-border px-2 py-0.5 hover:bg-accent"
              title={r}
            >
              {r}
            </button>
          ))}
        </div>
      )}

      {/* The debounce used to be a 64px number box wedged into a caption line,
          which is the least visible place a real control can be. It is a proper
          control now: same visual weight as 排序, with its unit attached. */}
      <div {...reg("add-search-budget")} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <span>{t("sp.debounce")}</span>
          <span className="flex items-center skin-ctl border border-input bg-background pl-1.5 pr-1 focus-within:border-primary">
            <input
              type="number"
              min={0}
              max={30000}
              step={100}
              value={debounceDraft}
              onChange={(e) => setDebounceDraft(e.target.value)}
              onBlur={commitDebounce}
              onKeyDown={(e) => {
                if (isCommitEnter(e)) {
                  e.preventDefault();
                  commitDebounce();
                }
              }}
              className="w-14 bg-transparent py-0.5 text-right tabular-nums outline-none"
              title={t("sp.debounceTitle")}
              aria-label={t("sp.debounceAria")}
            />
            <span className="shrink-0 text-muted-foreground/70">ms</span>
          </span>
        </label>
        {manualOnly && (
          <span
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-caption text-amber-400"
            title={t("sp.manualOnlyTitle")}
          >
            {t("sp.manualOnly")}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-muted-foreground/70">{t("sp.clickLabel")}</span>
          {(["fill", "browser", "readme"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setResultClick(m)}
              aria-pressed={resultClick === m}
              className={cn(
                "skin-ctl t-state border px-2 py-0.5 text-caption",
                resultClick === m
                  ? "border-primary/60 bg-primary/15 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
              )}
            >
              {t(`sp.click.${m}`)}
            </button>
          ))}
        </span>
        {status && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 tabular-nums",
              status.remainingBudget <= 2
                ? "bg-warning/15 text-warning"
                : "bg-muted text-muted-foreground",
            )}
            title={
              status.hasToken
                ? t("sp.budgetToken")
                : t("sp.budgetAnon")
            }
          >
            {t("sp.budgetLeft", { n: status.remainingBudget, lim: status.limitPerMinute })}
          </span>
        )}
      </div>
      {/* Explanation moved out of the control row so it can be hidden with
          描述性文字 without taking the debounce field with it. */}
      <p className="app-desc mt-1 text-caption leading-snug text-muted-foreground/80">
        {t("sp.debounceDesc")}
      </p>

      {result?.error && (
        <div
          role={result.throttled ? "status" : "alert"}
          className={cn(
            "mt-2 rounded-lg border p-2.5 text-caption leading-relaxed",
            result.throttled
              ? "border-warning/30 bg-warning/5 text-warning"
              : "border-danger/30 bg-danger/5 text-danger",
          )}
        >
          {result.error}
          {result.resetIn != null && result.resetIn > 0 && (
            <span className="ml-1">{t("sp.resetSoon", { n: result.resetIn })}</span>
          )}
        </div>
      )}

      {busy && !result && (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t("sp.searching")}
        </p>
      )}

      {result && !result.error && result.items.length === 0 && !busy && (
        <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
          {t("sp.noMatch")}
        </p>
      )}

      {result && result.items.length > 0 && (() => {
        // r17-n2-1: 从当前结果集里数语言，多于一种才给过滤条。纯客户端——
        // GitHub 本身支持 language: 前缀，但那要重新发请求；这里只是把已经拉回来的一页
        // 按语言收窄，零网络成本，也不污染用户写的查询串。
        const langs = Array.from(
          new Set(result.items.map((h) => h.language).filter((l): l is string => !!l)),
        ).sort();
        const visible =
          langFilter && langs.includes(langFilter)
            ? result.items.filter((h) => h.language === langFilter)
            : result.items;
        return (
        <>
          {langs.length > 1 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1 text-caption">
              <span className="text-muted-foreground">{t("sp.lang")}</span>
              <button
                type="button"
                onClick={() => setLangFilter("")}
                className={
                  !langFilter
                    ? "rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5"
                    : "rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                }
              >
                {t("sp.all")}
              </button>
              {langs.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLangFilter(l === langFilter ? "" : l)}
                  className={
                    langFilter === l
                      ? "rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5"
                      : "rounded-full border border-border px-2 py-0.5 hover:bg-accent"
                  }
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          <ul {...reg("add-search-results")} className="mt-2.5 space-y-2">
            {visible.map((h) => {
              const [owner, ...rest] = h.fullName.split("/");
              const name = rest.join("/");
              const have = owned.has(`github.com/${h.fullName.toLowerCase()}`);
              return (
              <li
                key={h.fullName}
                onDoubleClick={() => {
                  setQ(h.fullName);
                  setComposerSeed(h.fullName);
                }}
                className="group flex cursor-pointer items-start gap-2.5 rounded-xl border border-border-weak bg-background p-2.5
                           t-state hover:border-primary/40 hover:shadow-sm focus-within:border-primary/40"
                title={t("sp.dblClick")}
              >
                <button
                  type="button"
                  onClick={() => onRowClick(h.fullName)}
                  className="min-w-0 flex-1 text-left"
                >
                  {/* The scan anchor: `owner/` de-emphasised, the repository name
                      carrying the weight. One undifferentiated medium-weight
                      string per row is what made a page of results read as a
                      wall of text. */}
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-body">
                      <span className="text-muted-foreground">{owner}/</span>
                      <span className="font-medium">{name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground">
                      <Star className="h-2.5 w-2.5" />
                      {star(h.stars)}
                    </span>
                    {h.language && (
                      <span className="shrink-0 rounded bg-muted px-1 py-px text-caption text-muted-foreground">
                        {h.language}
                      </span>
                    )}
                    {h.archived && (
                      <span className="shrink-0 rounded bg-warning/15 px-1 py-px text-caption text-warning">
                        {t("sp.archived")}
                      </span>
                    )}
                    {have && (
                      <span
                        className="shrink-0 rounded bg-success/15 px-1 py-px text-caption text-success"
                        title={t("sp.hereTitle")}
                      >
                        {t("sp.inLib")}
                      </span>
                    )}
                  </span>
                  {h.description && (
                    <span className="mt-1 line-clamp-2 block text-caption leading-snug text-muted-foreground">
                      {h.description}
                    </span>
                  )}
                </button>
                {/* Secondary actions only on hover/focus: three always-on
                    buttons per row is what made the list feel crowded. 下载
                    stays visible because it is the row's primary action. */}
                <span className="flex shrink-0 items-center gap-1">
                  <span className="flex items-center gap-1 opacity-0 transition-opacity duration-[var(--motion-quick)] group-hover:opacity-100 group-focus-within:opacity-100">
                  <IconBtn
                    title={t("sp.openTitle")}
                    onClick={() => void openHttpUrl(`https://github.com/${h.fullName}`)}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </IconBtn>
                  <IconBtn
                    title={previewOf === h.fullName && readme ? t("sp.readmeCollapse") : t("sp.readmeOpen")}
                    active={previewOf === h.fullName}
                    onClick={() => void openReadme(h.fullName)}
                  >
                    <FileText className="h-3 w-3" />
                  </IconBtn>
                  </span>
                  <button
                    type="button"
                    // 同上：写进记录归档的来源名，数据标识不接词表。
                    onClick={() => onDownload(h.fullName, "搜索结果")}
                    disabled={have}
                    title={have ? t("sp.inLibTitle") : undefined}
                    className="skin-ctl flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption
                               text-muted-foreground t-state hover:bg-accent hover:text-foreground
                               active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3 w-3" />
                    {t("sp.rowDownload")}
                  </button>
                </span>
              </li>
              );
            })}
          </ul>

          {previewOf && readme && (
            <div
              className="mt-2.5 overflow-hidden rounded-xl border border-border-weak bg-background motion-row-in"
            >
              <div className="flex items-center gap-2 border-b border-dashed border-border-weak px-3 py-2">
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-caption font-medium">
                  {readme.name} · README
                </span>
                <span className="app-desc shrink-0 text-caption text-muted-foreground">
                  {t("sp.mdNote")}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewOf(null);
                    setReadme(null);
                  }}
                  className="shrink-0 text-caption text-muted-foreground hover:text-foreground"
                >
                  {t("sp.collapse")}
                </button>
              </div>
              {readme.error ? (
                <p className="p-3 text-caption text-danger">{readme.error}</p>
              ) : readme.loading ? (
                <p className="flex items-center gap-1.5 p-3 text-caption text-muted-foreground">
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                  {t("sp.reading")}
                </p>
              ) : readme.text ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 text-caption leading-relaxed text-muted-foreground">
                  {readme.text}
                </pre>
              ) : (
                // Round 13 (d5-2): the answer arrived and it is empty. That is a
                // fact about the repository, not a pending request.
                <p className="p-3 text-caption text-muted-foreground">
                  {t("sp.noReadme")}
                </p>
              )}
            </div>
          )}

          <div {...reg("add-search-pager")} className="mt-2.5 flex items-center justify-between text-caption text-muted-foreground">
            <span>
              {t("sp.totalN", { n: formatNumber(result.totalCount) })}
              {langFilter ? t("sp.langCount", { n: visible.length }) : ""}
              {result.notModified ? t("sp.notModified") : result.fromCache && t("sp.fromCache")}
              {result.remaining != null && t("sp.remaining", { n: result.remaining })}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-40"
              >
                {t("sp.prev")}
              </button>
              <span className="tabular-nums">{t("sp.pageN", { n: page })}</span>
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                disabled={page * 20 >= result.totalCount}
                className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-40"
              >
                {t("sp.next")}
              </button>
            </span>
          </div>
        </>
        );
      })()}
    </div>
  );
}

/** GitHub search orders, as the app's own menu control wants them. Labels are
 *  composed from the word list at render time (`sp.sort.<id>`); the persisted
 *  value is the bare id, so the ids here are the storage contract. */
const SEARCH_SORTS: { id: string }[] = [
  { id: "" },
  { id: "stars" },
  { id: "updated" },
  { id: "forks" },
];

/**
 * The 落位 row's 历史路径 dropdown (需求 3).
 *
 * Renders nothing when there is no history: an always-visible button that
 * opens an empty menu is a promise the app cannot keep. Click-away and Escape
 * both close, the same contract the toolbar menus use.
 */
/**
 * The 已保存 dropdown for pinned searches (round 11).
 *
 * Same contract as {@link HistoryPicker} above: nothing renders when the list is
 * empty, click-away and Escape close it, and picking an entry re-runs the query
 * immediately rather than only refilling the box — the point of saving a search is
 * to get its *results* back. Each row carries its own 移除 so one bad pin does not
 * require clearing the whole list.
 */
function SavedPicker({
  entries,
  onPick,
  onRemove,
}: {
  entries: { q: string; sort: string }[];
  onPick: (entry: { q: string; sort: string }) => void;
  onRemove: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const layer = useLayerExit(open);
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useDismiss(rootRef, () => setOpen(false), { enabled: open, capture: true });

  if (entries.length === 0) return null;
  return (
    <span ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t("sp.savedTitle")}
        className={cn(
          "skin-ctl flex items-center gap-1 border px-2 py-1.5 text-caption active:scale-[0.97]",
          open
            ? "border-primary/60 bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Star className="h-3 w-3" />
        {t("sp.savedN", { n: entries.length })}
      </button>
      {layer.render && (
        <div
          role="listbox"
          data-layer="menu"
          data-state={layer.state}
          className="skin-pop absolute right-0 top-full z-[var(--z-menu)] mt-1 max-h-60 w-80 overflow-y-auto border border-border bg-raised p-1"
        >
          {entries.map((entry, i) => (
            <div key={`${entry.q}|${entry.sort}`} className="flex items-center gap-1">
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick(entry);
                  setOpen(false);
                }}
                title={`${entry.q}${entry.sort ? ` · ${sortLabel(t, entry.sort)}` : ""}`}
                className="flex min-w-0 flex-1 flex-col rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <span className="truncate text-caption text-foreground">{entry.q}</span>
                <span className="app-desc truncate text-caption text-muted-foreground">
                  {sortLabel(t, entry.sort)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={t("sp.removeSavedAria", { q: entry.q })}
                title={t("sp.removeTitle")}
                className="skin-ctl shrink-0 p-1 text-muted-foreground transition-colors hover:bg-danger hover:text-primary-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** The sort id back into the words the picker offered, for a saved row's caption.
 *  The id is the persisted value; an id the current word list does not know
 *  (future version, pruned entry) falls back to the best-match label. */
function sortLabel(t: TFunc, id: string): string {
  const key = `sp.sort.${id}`;
  return isTranslationKey(key) ? t(key) : t("sp.sortBest");
}

function HistoryPicker({
  paths,
  onPick,
}: {
  paths: string[];
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const layer = useLayerExit(open);
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useDismiss(rootRef, () => setOpen(false), { enabled: open, capture: true });

  if (paths.length === 0) return null;
  return (
    <span ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t("sp.histTitle")}
        className={cn(
          "skin-ctl flex items-center gap-1 border px-2 py-1 text-caption active:scale-[0.97]",
          open
            ? "border-primary/60 bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <History className="h-3 w-3" />
        {t("sp.hist")}
      </button>
      {layer.render && (
        <div
          role="listbox"
          data-layer="menu"
          data-state={layer.state}
          className="skin-pop absolute right-0 top-full z-[var(--z-menu)] mt-1 max-h-60 w-72 overflow-y-auto border border-border bg-raised p-1"
        >
          {paths.map((p) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                onPick(p);
                setOpen(false);
              }}
              title={p}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-caption transition-colors hover:bg-accent"
            >
              <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  active,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "rounded-md border p-1 transition-colors",
        active
          ? "border-primary/60 bg-primary/15 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** One label/value cell in the remote-facts grid. */
function RemoteFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-muted-foreground/70">{label}</span>
      <span className="block truncate font-medium">{value}</span>
    </span>
  );
}

function RemoteBadge({ text }: { text: string }) {
  return <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{text}</span>;
}
