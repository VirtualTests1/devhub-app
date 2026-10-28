import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import { MenuSelect } from "./Controls";
import { SettingRow } from "./SettingsRows";
import { toast } from "./Toast";
import type { PythonInstall } from "../types";
import { messageOf, reportError } from "../lib/report-error";
import { useI18n } from "../lib/useI18n";
import {
  type VenvRemovalMode,
  type VenvReport,
  type VenvState,
  venvCreateLabel,
  venvDestroyIsIrreversible,
  venvHasSomethingToClean,
  venvRemovalLine,
  venvStateHint,
} from "../lib/venv-removal";

/**
 * Per-repository Python: which interpreter, and the venv made from it
 * (需求 8.5 + 8.6).
 *
 * This exists because REQUIREMENTS §3.6 records a live risk, not a historical one:
 * this machine carries several real Pythons (`python` → 3.11.5, `py -3.12`,
 * `py -3.10`), and nothing used to lock one per repository, so "装完依赖起不来"
 * had no explanation. The two halves fix that in the order they depend on:
 *
 *   - **选择解释器** writes `.devhub.json`, and `child_env` prepends that
 *     interpreter's directory to `PATH` - after the venv, so an existing
 *     environment still wins, which is what a venv is for.
 *   - **创建虚拟环境** then runs `<python> -m venv 项目\venvs\<repo>_<owner>`, the
 *     directory `venv_dir_for` already computes and `looks_like_venv` already
 *     validates. `venvs` is a reserved root name, so the environment is never
 *     scanned as a project.
 *
 * Round 16 added the third half, because the first two had no way back: creation
 * existed for five rounds and its removal did not, so an environment whose
 * directory had been moved or half-deleted could only be cleaned up in Explorer —
 * and the row itself reported the *marker's* path as if it were the disk's state.
 * The panel now renders `venvState` (what `looks_like_venv` says) rather than
 * `venvPath` (what was last written), and the cleanup row is the opposite verb.
 *
 * What it refuses to do:
 *   - **guess when `py` is missing.** `list_pythons` then reports the single
 *     `PATH` python and this panel says so in one line, instead of pretending there
 *     is a choice;
 *   - **delete a directory it did not create.** `remove_repo_venv` only ever
 *     removes one level below `项目\venvs` (`launch::check_venv_target`); a
 *     `venvPath` pointing elsewhere is *forgotten*, not removed, and the row says
 *     which of the two happened rather than printing 「已删除」;
 *   - **claim success from a compile.** Creation is reported from the backend's own
 *     `Ok/Err`, and a repository whose marker did not change shows as a failure.
 *
 * Round 18 (r18-o1-1) moved the panel's own sentences into the dictionary
 * (tests/i18n.test.ts, 5e, pins them byte-for-byte against the pre-wiring
 * source). The lines still composed by `lib/venv-removal.ts` — `venvStateHint`,
 * `venvCreateLabel`, `venvRemovalLine` — stay there for a later batch: they are
 * a pure module, and wiring them means passing `t` in (the `records/filter-words`
 * pattern), not rewriting them here.
 */

const FOLLOW_VENV = "";

export function RepoPythonPanel({
  slug,
  venvPath,
  venvState,
  venvDir,
  pythonChoice,
  onChanged,
}: {
  slug: string;
  /** The path recorded in the marker right now, so 创建虚拟环境 can say where. */
  venvPath: string | null;
  /** What the disk says about that path. `venvPath` alone cannot answer this. */
  venvState: VenvState;
  /** `项目\venvs\<repo>_<owner>` — where a creation would go, recorded or not. */
  venvDir: string | null;
  /** The interpreter pinned in the marker; `null` follows the venv / PATH. */
  pythonChoice: string | null;
  /** Re-reads `repo_detail` after a write, exactly like the other rows in this dialog. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [pythons, setPythons] = useState<PythonInstall[] | null>(null);
  // Seeded from the marker rather than left at the default: a select that renders
  // 「跟随默认」 next to a pinned interpreter is a lie of omission, and the pin is the
  // one thing this row exists to make visible.
  const [picked, setPicked] = useState<string>(pythonChoice ?? FOLLOW_VENV);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<VenvRemovalMode | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [noteIsWarn, setNoteIsWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    setPicked(pythonChoice ?? FOLLOW_VENV);
  }, [pythonChoice]);

  useEffect(() => {
    aliveRef.current = true;
    let alive = true;
    (async () => {
      try {
        const list = await invoke<PythonInstall[]>("list_pythons");
        if (!alive) return;
        setPythons(list);
      } catch (e) {
        if (alive) setError(t("py.listFailed", { msg: messageOf(e) }));
      }
    })();
    return () => {
      alive = false;
      aliveRef.current = false;
    };
  }, [t]);

  const showLine = (line: { tone: "ok" | "warn"; text: string }) => {
    if (!aliveRef.current) return;
    setNote(line.text);
    setNoteIsWarn(line.tone === "warn");
  };

  const saveChoice = async (id: string) => {
    setBusy(true);
    setError(null);
    // Apply only on success. The old code ran `setPicked(id)` *before* the
    // invoke and, on a rejection, only wrote `error` — so the MenuSelect kept
    // showing an interpreter the backend had never stored, a lie about what
    // this repository actually pins. Leaving `picked` untouched until the write
    // lands means a failed save shows the previous, still-correct choice.
    try {
      await invoke("set_python_choice", { slug, python: id });
      if (!aliveRef.current) return;
      setPicked(id);
      onChanged();
      toast.success(id ? t("py.locked") : t("py.followed"));
    } catch (e) {
      if (aliveRef.current)
        setError(t("py.saveFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const createVenv = async () => {
    if (!picked) {
      setError(t("py.needInterpreter"));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const path = await invoke<string>("create_repo_venv", { slug, python: picked });
      void invoke("clear_env_cache");
      onChanged();
      if (aliveRef.current) setNote(t("py.ready", { path }));
    } catch (e) {
      if (aliveRef.current) setError(t("py.createFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  /**
   * The opposite verb. `mode` is which of the three the user pressed, and the
   * backend decides from the *disk* whether that means deleting a directory or
   * only dropping a pointer — so the sentence shown afterwards comes from the
   * report, never from the button that was clicked.
   */
  const removeVenv = async (mode: VenvRemovalMode) => {
    setRemoving(mode);
    setError(null);
    setNote(null);
    try {
      const r = await invoke<VenvReport>("remove_repo_venv", { slug, mode });
      showLine(venvRemovalLine(r));
      setConfirming(false);
      setTyped("");
      void invoke("clear_env_cache");
      onChanged();
    } catch (e) {
      if (aliveRef.current) setError(t("py.opFailed", { msg: messageOf(e) }));
    } finally {
      if (aliveRef.current) setRemoving(null);
    }
  };

  const openVenv = () => {
    // Round 13 (d4-5): this button's *entire* job is opening the directory, so
    // a failure here is the click failing — not bookkeeping to swallow. The same
    // scene in `ProjectSettingsDialog` already says so in a comment; this was
    // the silent counterpart.
    const target = venvPath ?? venvDir;
    if (target) {
      void invoke("reveal_path", { path: target }).catch((e) => reportError(e, t("py.revealFailed")));
    }
  };

  const list = pythons ?? [];
  const sourceNote =
    pythons === null
      ? t("py.loading")
      : list.length === 0
        ? t("py.empty")
        : list.every((p) => p.source === "PATH")
          ? t("py.fallback")
          : t("py.count", { n: list.length });
  const hasDir = venvState === "ready" || venvState === "unrecorded" || venvState === "notAVenv";
  const busyAny = busy || removing !== null;

  return (
    <div className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card">
      <SettingRow
        title={t("py.title")}
        hint={sourceNote}
        control={
          <MenuSelect
            value={picked}
            options={[
              { id: FOLLOW_VENV, label: t("py.follow") },
              ...list.map((p) => ({
                id: p.id,
                label: p.version ? `${p.version} · ${p.id}` : p.id,
              })),
            ]}
            onChange={(v) => void saveChoice(v)}
            ariaLabel={t("py.selectAria")}
            width="w-[16rem]"
          />
        }
      />

      <SettingRow
        title={t("py.venvTitle")}
        hint={
          list.length === 0 && venvState === "nothing"
            ? t("py.venvBlocked")
            : venvStateHint(venvState, venvPath, venvDir)
        }
        control={
          <div className="flex gap-1.5">
            {(venvPath || venvDir) && venvState !== "nothing" && (
              <button
                type="button"
                onClick={openVenv}
                className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent"
              >
                <FolderOpen className="h-3 w-3" />
                {t("py.open")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void createVenv()}
              disabled={busyAny || list.length === 0}
              title={t("py.createVenvTitle")}
              className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <CircleCheck className="h-3 w-3" />}
              {venvCreateLabel(venvState)}
            </button>
          </div>
        }
      />

      {venvHasSomethingToClean(venvState) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <span className="text-caption text-muted-foreground">{t("py.cleanupLabel")}</span>
          <button
            type="button"
            onClick={() => void removeVenv("toBin")}
            disabled={busyAny || !hasDir}
            title={
              hasDir
                ? t("py.toBinTitle")
                : t("py.toBinNoDirTitle")
            }
            className="skin-ctl px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
          >
            {removing === "toBin" ? t("py.toBinBusy") : t("py.toBin")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (venvDestroyIsIrreversible(venvState)) {
                setConfirming((v) => !v);
              } else {
                void removeVenv("destroy");
              }
            }}
            disabled={busyAny || !hasDir}
            title={t("py.destroyTitle")}
            className="skin-ctl border-danger/40 px-2 py-1 text-caption text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            {removing === "destroy" ? t("py.destroyBusy") : t("py.destroy")}
          </button>
          <button
            type="button"
            onClick={() => void removeVenv("forgetRecord")}
            disabled={busyAny}
            title={t("py.forgetTitle")}
            className="skin-ctl px-2 py-1 text-caption hover:bg-accent disabled:opacity-40"
          >
            {removing === "forgetRecord" ? t("py.forgetBusy") : t("py.forget")}
          </button>
        </div>
      )}

      {confirming && (
        <div className="space-y-1.5 px-3 pb-2">
          <p className="text-caption leading-snug text-warning">
            {t("py.destroyLead")}
            <strong>{t("py.destroyStrong")}</strong>
            {t("py.destroyTail", { dir: venvPath ?? venvDir ?? t("py.thisDir") })}
            <code className="rounded bg-muted px-1">{slug}</code>
            {t("py.destroySuffix")}
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={slug}
            aria-label={t("py.destroyAria", { slug })}
            spellCheck={false}
            className="skin-ctl w-full border border-input bg-background px-2 py-1.5 font-mono text-caption outline-none focus:border-danger/60"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void removeVenv("destroy")}
              disabled={busyAny || typed.trim() !== slug}
              className="rounded-lg bg-danger px-3 py-1.5 text-caption font-medium text-white disabled:opacity-40"
            >
              {t("py.destroyConfirm")}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-caption text-muted-foreground hover:bg-accent"
            >
              {t("py.cancel")}
            </button>
          </div>
        </div>
      )}

      {note && (
        <p
          className={`flex items-start gap-1.5 px-3 pb-2 text-caption leading-snug ${
            noteIsWarn ? "text-warning" : "text-success"
          }`}
        >
          {noteIsWarn ? (
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <CircleCheck className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          {note}
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
