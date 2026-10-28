import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, FolderOpen, LoaderCircle, Plus, Trash2, TriangleAlert } from "lucide-react";
import { FieldRow, SettingRow } from "./SettingsRows";

import type { WorktreeInfo, WorktreeList, WorktreeRemoveReport } from "../types";
import { messageOf, reportError } from "../lib/report-error";
import { useI18n } from "../lib/useI18n";
import { isCommitEnter } from "../lib/ime";
import { reg } from "../store/customize";
import {
  worktreeCanCreate,
  worktreeConfirmLine,
  worktreeDeleteRefusal,
  worktreeEmptyLine,
  worktreeLabel,
  worktreePlacement,
  worktreeRemovalLine,
  worktreeRowNote,
} from "../lib/worktree-panel";

/**
 * Per-repository git worktrees (第十六轮方向 N1-2).
 *
 * The app has known where a worktree goes since round 11 — `<项目根>\_worktrees\<slug
 * 扁平>` is what 删除项目 sweeps, and `downloader.rs` reserves the directory name so a
 * worktree is never scanned as a project — but it never made, listed or removed one.
 * So the directory could only be reached by hand, in Explorer, and the sweep was
 * cleaning a shape nothing produced.
 *
 * This panel is the missing half, and it deliberately does **not** invent a second
 * set of rules:
 *
 *   - the placement it previews is `gitwt::worktree_dir_name`, mirrored in
 *     `lib/worktree-panel.ts` and pinned by fixtures on both sides;
 *   - the dirty numbers come from `launch::worktree_status`, the same probe the
 *     delete confirmation runs, and their wording is `worktree-warning.ts`'s;
 *   - a row is offered for deletion only when `managed` says the directory is one
 *     level inside `_worktrees` — the same containment `gitwt::check_worktree_target`
 *     enforces before it touches git, so the button cannot offer what the backend
 *     would refuse.
 *
 * What it refuses to do:
 *   - **pretend a git-less directory is an empty worktree list.** Three facts share
 *     the shape `[]` (没有 git / 没有工作树 / git 没回答) and they get three sentences
 *     (`worktreeEmptyLine`).
 *   - **delete the main checkout.** That is 删除项目's job, with its own three
 *     confirmation levels; a second verb on the same directory is how you end up
 *     not knowing which one you pressed.
 *   - **decide "clean" from a probe that did not answer.** The dirty gate is git's
 *     own (`git worktree remove` refuses, and its refusal is what reveals the 强制
 *     option here), so an unreadable tree is never silently deletable.
 *
 * Round 18 (r18-o1-1) moved the panel's own sentences into the dictionary
 * (tests/i18n.test.ts, 5e, pins them byte-for-byte). The composed lines built by
 * `lib/worktree-panel.ts` — `worktreeEmptyLine`, `worktreeDeleteRefusal`,
 * `worktreeRowNote`, `worktreeConfirmLine`, `worktreeRemovalLine` — stay there for
 * a later batch: a pure module takes the translator as an argument (the
 * `records/filter-words` pattern), which is a change of its own.
 */

export function RepoWorktreesPanel({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [list, setList] = useState<WorktreeList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [branch, setBranch] = useState("");
  const [subdir, setSubdir] = useState("");
  const [createNew, setCreateNew] = useState(true);
  const [busy, setBusy] = useState(false);
  /** The row whose deletion is being confirmed, with `force` decided here rather
   *  than in the backend: the second click is a user decision, not a default. */
  const [confirming, setConfirming] = useState<{ path: string; force: boolean } | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const got = await invoke<WorktreeList>("list_repo_worktrees", { slug });
      if (aliveRef.current) setList(got);
    } catch (e) {
      // Not a silent empty list: 读不到 and 没有 是两句话, and the panel has to say
      // which one the user is looking at (`worktree-warning.ts`'s own lesson).
      if (aliveRef.current) setError(t("wt.loadFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    setList(null);
    setConfirming(null);
    void load();
  }, [load]);

  const create = async () => {
    const b = branch.trim();
    if (!worktreeCanCreate(b)) {
      setError(t("wt.needBranch"));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const info = await invoke<WorktreeInfo>("add_repo_worktree", {
        slug,
        branch: b,
        createNew,
        subdirName: subdir.trim() || null,
      });
      setNote({ tone: "ok", text: t("wt.created", { path: info.path, label: worktreeLabel(info) }) });
      setBranch("");
      setSubdir("");
      await load();
    } catch (e) {
      if (aliveRef.current) setError(t("wt.createFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const remove = async (path: string, force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<WorktreeRemoveReport>("remove_repo_worktree", { slug, path, force });
      setNote(worktreeRemovalLine(r));
      setConfirming(null);
      await load();
    } catch (e) {
      if (aliveRef.current) setError(t("wt.removeFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const open = (path: string) => {
    // This button's entire job is opening the directory, so a failure here is the
    // click failing, not bookkeeping to swallow (`RepoPythonPanel`'s round-13 note).
    void invoke("reveal_path", { path }).catch((e) => reportError(e, t("wt.revealFailed")));
  };

  const rows = list?.worktrees ?? [];
  const preview = list && branch.trim()
    ? worktreePlacement(list.container, slug, branch, subdir)
    : "";
  const busyAny = busy || loading;

  return (
    <div {...reg("project-row-worktrees")} className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card">
      <SettingRow
        icon={<FolderOpen className="h-3.5 w-3.5" />}
        title={t("wt.title")}
        hint={
          list === null
            ? loading
              ? t("wt.loading")
              : t("wt.empty")
            : t("wt.summary", { n: rows.length, dir: list.container })
        }
        control={
          <button
            type="button"
            onClick={() => void load()}
            disabled={busyAny}
            className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
          >
            {loading ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <CircleCheck className="h-3 w-3" />}
            {t("wt.refresh")}
          </button>
        }
      />

      {list && !list.hasGit && (
        <p className="px-3 pb-2 text-caption leading-snug text-warning">
          {worktreeEmptyLine(list)}
        </p>
      )}

      {list?.error && (
        <p role="alert" className="flex items-start gap-1.5 px-3 pb-2 text-caption leading-snug text-danger">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {worktreeEmptyLine(list)}
        </p>
      )}

      {rows.map((w) => {
        const refusal = worktreeDeleteRefusal(w);
        const rowNote = worktreeRowNote(w);
        return (
          <div key={w.path} className="px-2.5 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-body leading-snug font-medium">{worktreeLabel(w)}</span>
                  {w.isMain && (
                    <span className="rounded border border-primary/40 px-1 text-caption text-primary">{t("wt.badgeMain")}</span>
                  )}
                  {w.prunable && (
                    <span className="rounded border border-warning/40 px-1 text-caption text-warning">{t("wt.badgeStale")}</span>
                  )}
                  {!w.exists && !w.prunable && (
                    <span className="rounded border border-border px-1 text-caption text-muted-foreground">{t("wt.badgeMissing")}</span>
                  )}
                </span>
                <span className="app-desc mt-0 block truncate text-caption leading-snug text-muted-foreground" title={w.path}>
                  {w.path}
                </span>
                {rowNote && (
                  <span className={`app-desc mt-0.5 block text-caption leading-snug ${w.status && worktreeContentHasBits(w) ? "text-warning" : "text-muted-foreground"}`}>
                    {rowNote}
                  </span>
                )}
                {refusal && (
                  <span className="app-desc mt-0.5 block text-caption leading-snug text-muted-foreground">
                    {refusal}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => open(w.path)}
                  disabled={!w.exists}
                  title={t("wt.reveal")}
                  className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
                >
                  <FolderOpen className="h-3 w-3" />
                  {t("wt.open")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // 强制 is never a default: the first click shows what is inside,
                    // and the second click is the one that may destroy it.
                    setConfirming({ path: w.path, force: false });
                  }}
                  disabled={busyAny || refusal !== null}
                  title={refusal ?? t("wt.removeTitle")}
                  className="skin-ctl border-danger/40 px-2 py-1 text-caption text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  <Trash2 className="mr-1 inline h-3 w-3" />
                  {t("wt.remove")}
                </button>
              </span>
            </div>

            {confirming?.path === w.path && (
              <div className="mt-1.5 space-y-1.5 rounded-lg border border-border-weak bg-muted/30 p-2">
                <p className="text-caption leading-snug text-foreground">
                  {t("wt.removeLead", { path: w.path })}
                  <strong>{t("wt.removeStrong")}</strong>
                  {t("wt.removeTail")}
                  {w.branch ? t("wt.branchKept", { branch: w.branch }) : t("wt.detached")}
                </p>
                {worktreeConfirmLine(w) && (
                  <p className="app-desc whitespace-pre-line text-caption leading-snug text-warning">
                    {worktreeConfirmLine(w)}
                  </p>
                )}
                <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={confirming.force}
                    onChange={(e) => setConfirming({ path: w.path, force: e.target.checked })}
                    className="accent-[var(--color-primary)]"
                  />
                  {t("wt.forceHint")}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void remove(w.path, confirming.force)}
                    disabled={busyAny}
                    className="rounded-lg bg-danger px-3 py-1.5 text-caption font-medium text-white disabled:opacity-40"
                  >
                    {busy ? t("wt.removing") : confirming.force ? t("wt.confirmForce") : t("wt.confirmRemove")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-lg border border-border px-3 py-1.5 text-caption text-muted-foreground hover:bg-accent"
                  >
                    {t("wt.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {list?.hasGit && (
        <FieldRow
          icon={<Plus className="h-3.5 w-3.5" />}
          title={t("wt.createTitle")}
          regId="project-row-worktrees-add"
          hint={
            preview
              ? t("wt.createCommand", { cmd: createNew ? `-b ${branch.trim()} ` : "", placement: preview })
              : t("wt.branchHint")
          }
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={(e) => {
                if (isCommitEnter(e)) void create();
              }}
              placeholder={createNew ? t("wt.branchPlaceholderNew") : t("wt.branchPlaceholderExisting")}
              aria-label={t("wt.branchAria")}
              maxLength={100}
              spellCheck={false}
              className="min-w-0 flex-1 skin-ctl border border-input bg-background px-2 py-1 font-mono text-caption outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            <input
              value={subdir}
              onChange={(e) => setSubdir(e.target.value)}
              placeholder={t("wt.subdirPlaceholder")}
              aria-label={t("wt.subdirAria")}
              maxLength={60}
              spellCheck={false}
              className="w-32 skin-ctl border border-input bg-background px-2 py-1 text-caption outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <input
                type="checkbox"
                checked={createNew}
                onChange={(e) => setCreateNew(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              {t("wt.newBranch")}
            </label>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busyAny || !worktreeCanCreate(branch)}
              className="skin-ctl flex items-center gap-1 border border-primary/50 px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {t("wt.create")}
            </button>
          </div>
          {preview && (
            <p className="app-desc mt-1 truncate text-caption text-muted-foreground" title={preview}>
              {t("wt.preview", { preview })}
            </p>
          )}
        </FieldRow>
      )}

      {note && (
        <p
          className={`flex items-start gap-1.5 px-3 pb-2 text-caption leading-snug ${
            note.tone === "warn" ? "text-warning" : "text-success"
          }`}
        >
          {note.tone === "warn" ? (
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <CircleCheck className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          {note.text}
        </p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 px-3 pb-2 text-caption leading-snug text-danger">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** Whether a row's status actually carries content, for the tone of its note line. */
function worktreeContentHasBits(w: WorktreeInfo): boolean {
  const st = w.status;
  return !!st && st.dirty + st.untracked > 0;
}
