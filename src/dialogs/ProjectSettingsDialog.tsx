import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openHttpUrl } from "../lib/external-url";
import { BookOpen, Copy, Eye, FolderOpen, FolderTree, Hash, Image as ImageIcon, Pin, Rocket, StickyNote, Terminal } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { PathInput } from "../components/PathInput";
import { RepoPythonPanel } from "../components/RepoPythonPanel";
import { RepoWorktreesPanel } from "../components/RepoWorktreesPanel";
import { RepoStoragePanel } from "../components/RepoStoragePanel";
import { RepoComposePanel } from "../components/RepoComposePanel";
import { ChoiceRow, FieldRow, SettingRow, SwitchRow } from "../components/SettingsRows";
import { MenuSelect } from "../components/Controls";
import { toast } from "../components/Toast";
import { reportError } from "../lib/report-error";
import { isCommitEnter } from "../lib/ime";
import { useI18n } from "../lib/useI18n";
import { useUI } from "../store/ui";
import { useWall, type RepoState } from "../store/wall";
import type { RepoDetail, RepoRef, ToolInfo } from "../types";

/**
 * Per-project settings.
 *
 * The wall's toolbar can only ever hold controls that apply to the whole wall.
 * Everything a person might want to decide *about one repository* needed a home,
 * and this is it. The dialog is split along the line the storage decision drew:
 *
 *   - **显示与位置** → `localStorage` (`store/wall.ts`). Alias, 封面, 置顶, 隐藏,
 *     manual position. These are facts about how this person reads this screen, so
 *     they must not follow the clone to another machine. A 封面 is stored as the
 *     source path the person chose; the copy in `cache/covers` is derived from it on
 *     demand, so clearing that cache costs nothing but one re-copy.
 *   - **启动默认值** → that repository's own `.devhub.json`, through
 *     `set_repo_launch_defaults`. Step confirmation, terminal, IDE, 端口段 and the
 *     recorded venv are choices about *this project*, and writing them into the
 *     marker means the next person to open the same clone - or the same person on
 *     another machine - gets them.
 *
 * The consequence of that second half is stated plainly in the UI rather than
 * hidden: an override here is a decision recorded inside the repository.
 *
 * The launch *actions* (run, stop, open terminal, the three delete levels) are not
 * duplicated here on purpose - the 启动面板 owns execution, and this owns
 * configuration. Two places that can start a process is how you end up not knowing
 * which one did. The confirmed **command list** is shown here read-only with a jump
 * to that panel, because which commands a repository launches with is exactly a
 * per-project fact the brief asked this layer to cover - reading it here and editing
 * it there is the split, not an omission.
 */

/** What `repo_detail` answers, including the fields 项目设置 reads and writes. */
type Detail = RepoDetail;

const FOLLOW_GLOBAL = "";

export function ProjectSettingsDialog({
  card,
  state,
  onClose,
  onChanged,
  onOpenReadme,
}: {
  card: (RepoRef & { slug: string }) | null;
  /** This repository's display facts, straight from `store/wall.ts`. Typed as the
   *  store's own shape so a new display field cannot arrive here already missing. */
  state: RepoState | undefined;
  onClose: () => void;
  /** Re-reads the wall after a marker write, so 端口段 and venv stay truthful. */
  onChanged: () => void;
  /** Opens the 本地 README 预览 for this card (round 17, n2-3). The caller closes
   *  this dialog first: two modals over one card would fight for Escape / focus. */
  onOpenReadme: () => void;
}) {
  const setRepo = useWall((s) => s.setRepo);
  const togglePin = useWall((s) => s.togglePin);
  const toggleHidden = useWall((s) => s.toggleHidden);
  const resetOrder = useWall((s) => s.resetOrder);
  const setOpenSlug = useUI((s) => s.setOpenSlug);
  const { t } = useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<ToolInfo[]>([]);
  const [ides, setIdes] = useState<ToolInfo[]>([]);
  const [alias, setAlias] = useState(state?.alias ?? "");
  const [note, setNote] = useState(state?.note ?? "");
  const [cover, setCover] = useState(state?.cover ?? "");
  // Seeded from the marker rather than typed blind: the panel has to show the block
  // the repository actually holds before someone can be asked to move it.
  const [portDraft, setPortDraft] = useState("");
  const [venvDraft, setVenvDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const slug = card?.slug ?? "";

  /**
   * Liveness guard for the async calls that live *outside* the mount effect below
   * — today that is the Python panel's `onChanged` re-read. The effect has its own
   * local `alive` flag; a click handler is not that closure, so this one has to be
   * a ref. Same shape as `LaunchDialog`'s `aliveRef` and for the same reason:
   * closing the dialog mid-flight used to land a `setDetail` on a dead instance.
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    // Re-arm in the effect body, not only at `useRef(true)` (r17-o2-2): with
    // StrictMode on (src/main.tsx:191) the dev double-mount runs this cleanup
    // between the two mounts, and a cleanup that only writes `false` would leave
    // the guard dead for the rest of the session — the Python panel's `onChanged`
    // re-read below would then silently never apply. LaunchDialog/RepoSyncPanel
    // carry the same re-arm for the same reason.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** What the project would launch with, in the shape the 启动面板 shows: an
   *  explicit step list, or the single confirmed command. */
  const launchSteps = (() => {
    const l = detail?.launch;
    if (!l) return [];
    if (l.steps.length) {
      return l.steps.map((s) => ({
        label: `${l.steps.length > 1 ? `${s.parallel ? t("launch.parallel") : t("launch.sequential")} · ` : ""}${
          s.name ? `${s.name} · ${s.command}` : s.command
        }`,
        command: s.command,
      }));
    }
    return l.command.trim() ? [{ label: l.command, command: l.command }] : [];
  })();

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    (async () => {
      try {
        const d = await invoke<Detail>("repo_detail", { slug });
        if (alive) setDetail(d);
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    // The tool lists are memoised on the Rust side, so asking here is cheap - and
    // this dialog is the one place that needs *both* lists at once.
    // A failed read is not an empty machine: both selects would then offer
    // 跟随全局 only, which reads as "这台电脑没装终端/IDE" and is a claim about
    // the backend, not about the user's installs. Say which read failed.
    void invoke<ToolInfo[]>("list_terminals")
      .then((list) => {
        if (alive) setTerminals(list);
      })
      .catch((err) => {
        if (alive) reportError(err, t("psd.loadTerminalsFailed"));
      });
    void invoke<ToolInfo[]>("list_ides")
      .then((l) => {
        if (alive) setIdes(l);
      })
      .catch((err) => {
        if (alive) reportError(err, t("psd.loadIdesFailed"));
      });
    return () => {
      alive = false;
    };
    // `t` in the deps (r21-o2-1): the two failure verbs resolve through the
    // dictionary, so a locale switch re-runs this read — the same trade
    // `RepoWorktreesPanel`/`LaunchDialog` already take. The visible cost is that
    // the port/venv drafts are re-seeded from the fresh `repo_detail` below,
    // which is exactly what happens after a save anyway.
  }, [slug, t]);

  // Re-seed the two marker-backed fields whenever the marker answer changes, which
  // includes right after a save: the server's reply is the truth about what the block
  // and the venv now are, and a draft left showing the typed value would hide a
  // rejection.
  useEffect(() => {
    if (!detail) return;
    setPortDraft(detail.portBase ? String(detail.portBase) : "");
    setVenvDraft(detail.venvPath ?? "");
  }, [detail]);

  if (!card) return null;

  const writeDefaults = async (patch: {
    stepwise?: boolean | null;
    terminalChoice?: string | null;
    ideChoice?: string | null;
    portBase?: number;
    venvPath?: string | null;
  }) => {
    setSaving(true);
    // The backend reads these as `Option<Option<T>>`: an absent key means "leave
    // that field alone", an explicit `null` means "clear the override and follow the
    // global again". So only the keys being touched go into the payload - sending
    // `null` for everything would silently wipe the other two.
    const value: Record<string, unknown> = {};
    if (patch.stepwise !== undefined) value.stepwise = patch.stepwise;
    if (patch.terminalChoice !== undefined) value.terminalChoice = patch.terminalChoice || null;
    if (patch.ideChoice !== undefined) value.ideChoice = patch.ideChoice || null;
    if (patch.portBase !== undefined) value.portBase = patch.portBase;
    if (patch.venvPath !== undefined) value.venvPath = patch.venvPath;
    try {
      const d = await invoke<Detail>("set_repo_launch_defaults", { slug, value });
      setDetail(d);
      onChanged();
      // A rejected port block arrives as an error string that names the repository
      // it collides with, so the toast is the whole answer - the draft re-seeds from
      // `d` and shows the block the repository still has.
      if (patch.portBase !== undefined) toast.success(t("psd.portSaved", { n: d.portBase }));
    } catch (err) {
      toast.error(t("settings.page.saveFailed", { msg: String(err) }));
    } finally {
      setSaving(false);
    }
  };

  const savePort = async () => {
    const n = Number(portDraft);
    if (!portDraft || !Number.isInteger(n) || n < 1024 || n > 65535) {
      toast.error(t("psd.portInvalid"));
      return;
    }
    if (n === detail?.portBase) return;
    await writeDefaults({ portBase: n });
  };

  const saveVenv = async () => {
    const v = venvDraft.trim();
    // A blur that changed nothing is not an edit, and writing the marker on every
    // blur would fill 记录 with no-change rows.
    if (v === (detail?.venvPath ?? "")) return;
    await writeDefaults({ venvPath: v || null });
  };

  const copy = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t("psd.copied", { label })))
      .catch(() => toast.error(t("psd.clipboardDenied")));
  };

  return (
    <DialogShell
      title={state?.alias ? `${state.alias} · ${card.repo}` : `${card.owner}/${card.repo}`}
      subtitle={detail?.path ?? card.path ?? undefined}
      titleHref={`https://${card.host}/${card.owner}/${card.repo}`}
      onClose={onClose}
      width="md"
      regId="project-settings-dialog"
    >
      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger">
          {error}
        </p>
      )}

      <section className="mb-4">
        <h3 className="skin-label mb-1 text-caption text-muted-foreground">{t("dialog.displaySection")}</h3>
        <div className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card">
          <FieldRow
            icon={<Eye className="h-3.5 w-3.5" />}
            title={t("psd.alias")}
            hint={t("psd.aliasHint")}
          >
            <div className="flex gap-1.5">
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onBlur={() => setRepo(slug, { alias: alias.trim() || undefined })}
                onKeyDown={(e) => {
                  // Blurring commits the alias, so an IME-candidate Enter must not
                  // blur — otherwise a half-typed alias gets saved.
                  if (isCommitEnter(e)) (e.target as HTMLInputElement).blur();
                }}
                placeholder={card.repo}
                aria-label={t("psd.alias")}
                maxLength={48}
                spellCheck={false}
                className="min-w-0 flex-1 skin-ctl border border-input bg-background px-2 py-1 text-caption
                           outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
              />
              {state?.alias && (
                <button
                  type="button"
                  onClick={() => {
                    setAlias("");
                    setRepo(slug, { alias: undefined });
                  }}
                  className="skin-ctl px-2 py-1 text-caption text-muted-foreground hover:text-foreground"
                >
                  {t("psd.clear")}
                </button>
              )}
            </div>
          </FieldRow>

          <FieldRow
            icon={<StickyNote className="h-3.5 w-3.5" />}
            align="stack"
            title={t("psd.note")}
            hint={t("psd.noteHint")}
          >
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => setRepo(slug, { note: note.trim() || undefined })}
              maxLength={2000}
              aria-label={t("psd.note")}
              rows={3}
              spellCheck={false}
              placeholder={t("psd.notePlaceholder")}
              className="w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-caption outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
            />
            {state?.note && (
              <button
                type="button"
                onClick={() => {
                  setNote("");
                  setRepo(slug, { note: undefined });
                }}
                className="mt-1 text-caption text-muted-foreground underline decoration-dotted hover:text-foreground"
              >
                {t("psd.noteClear")}
              </button>
            )}
          </FieldRow>

          {/* 取景三件套：哪一部分落在框内、按什么比例、用哪种处理。默认值全部
              等于旧行为（2:1 + 裁切填满 + 跟随皮肤），所以没有配置过的卡片看起来
              和以前一样。 */}
          <ChoiceRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t("psd.coverFitTitle")}
            hint={t("psd.coverFitHint")}
            value={state?.coverFit ?? "fit"}
            options={[
              { id: "fit", label: t("psd.coverFitCrop") },
              { id: "contain", label: t("psd.coverFitContain") },
              { id: "blur", label: t("psd.coverFitBlur") },
            ]}
            onChange={(id) => setRepo(slug, { coverFit: id === "fit" ? undefined : (id as "contain" | "blur") })}
            regId="project-row-cover-fit"
          />
          <ChoiceRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t("psd.coverRatioTitle")}
            hint={t("psd.coverRatioHint")}
            value={state?.coverRatio ?? "2/1"}
            options={[
              { id: "2/1", label: "2:1" },
              { id: "16/9", label: "16:9" },
              { id: "4/3", label: "4:3" },
              { id: "1/1", label: "1:1" },
            ]}
            onChange={(id) => setRepo(slug, { coverRatio: id === "2/1" ? undefined : (id as "2/1" | "16/9" | "4/3" | "1/1") })}
            regId="project-row-cover-ratio"
          />
          <ChoiceRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t("psd.coverLookTitle")}
            hint={t("psd.coverLookHint")}
            value={state?.coverLook ?? "auto"}
            options={[
              { id: "auto", label: t("psd.lookAuto") },
              { id: "vivid", label: t("psd.lookVivid") },
              { id: "flat", label: t("psd.lookFlat") },
              { id: "mono", label: t("psd.lookMono") },
            ]}
            onChange={(id) => setRepo(slug, { coverLook: id === "auto" ? undefined : (id as "vivid" | "flat" | "mono") })}
            regId="project-row-cover-look"
          />
          <FieldRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t("psd.focusTitle")}
            hint={t("psd.focusHint")}
          >
            <div className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-caption text-muted-foreground">{t("psd.focusX")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={state?.coverFocus?.[0] ?? 50}
                onChange={(e) =>
                  setRepo(slug, {
                    coverFocus: [Number(e.target.value), state?.coverFocus?.[1] ?? 50],
                  })
                }
                className="min-w-0 flex-1 accent-[var(--color-primary)]"
                aria-label={t("psd.focusXAria")}
              />
              <span className="w-6 shrink-0 text-caption text-muted-foreground">{t("psd.focusY")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={state?.coverFocus?.[1] ?? 50}
                onChange={(e) =>
                  setRepo(slug, {
                    coverFocus: [state?.coverFocus?.[0] ?? 50, Number(e.target.value)],
                  })
                }
                className="min-w-0 flex-1 accent-[var(--color-primary)]"
                aria-label={t("psd.focusYAria")}
              />
            </div>
          </FieldRow>
          <FieldRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            title={t("psd.coverTitle")}
            hint={t("psd.coverHint")}
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <PathInput
                  value={cover}
                  name="cover"
                  onChange={setCover}
                  kind="image"
                  pickerTitle={t("psd.coverPickerTitle")}
                  label={t("psd.coverFieldLabel")}
                  placeholder={t("psd.coverPlaceholder")}
                  onCommit={() => {
                    const v = cover.trim();
                    if (v === (state?.cover ?? "")) return;
                    setRepo(slug, { cover: v || undefined });
                    toast.success(v ? t("psd.coverLocal") : t("psd.coverFetched"));
                  }}
                />
              </div>
              {state?.cover && (
                <button
                  type="button"
                  onClick={() => {
                    setCover("");
                    setRepo(slug, { cover: undefined });
                  }}
                  className="skin-ctl mt-0.5 px-2 py-1 text-caption text-muted-foreground hover:text-foreground"
                >
                  {t("psd.clear")}
                </button>
              )}
            </div>
          </FieldRow>

          <SwitchRow
            icon={<Pin className="h-3.5 w-3.5" />}
            title={t("tile.pinned")}
            hint={t("psd.pinHint")}
            checked={!!state?.pinned}
            onChange={() => togglePin(slug)}
          />

          <SwitchRow
            icon={<Eye className="h-3.5 w-3.5" />}
            title={t("menu.hide")}
            hint={t("psd.hideHint")}
            checked={!!state?.hidden}
            onChange={() => toggleHidden(slug)}
          />

          <SettingRow
            title={t("psd.posTitle")}
            hint={
              state?.index === undefined
                ? t("psd.posUnset")
                : t("psd.posN", { n: state.index + 1 })
            }
            control={
              <button
                type="button"
                onClick={() => {
                  resetOrder();
                  toast.success(t("psd.orderReset"));
                }}
                disabled={state?.index === undefined}
                className="skin-ctl px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                {t("psd.posReset")}
              </button>
            }
          />
        </div>
      </section>

      <section>
        <h3 className="skin-label mb-1 text-caption text-muted-foreground">
          {t("dialog.launchSection")}
        </h3>
        <div className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card">
          <ChoiceRow
            icon={<Terminal className="h-3.5 w-3.5" />}
            title={t("launch.stepwise")}
            hint={t("psd.stepwiseHint")}
            value={detail?.stepwise === null || detail?.stepwise === undefined ? "global" : detail.stepwise ? "on" : "off"}
            options={[
              { id: "global", label: t("psd.followGlobal") },
              { id: "on", label: t("psd.on") },
              { id: "off", label: t("psd.off") },
            ]}
            onChange={(id) =>
              void writeDefaults({ stepwise: id === "global" ? null : id === "on" })
            }
          />

          <FieldRow
            icon={<Rocket className="h-3.5 w-3.5" />}
            title={t("launch.commandTitle")}
            hint={t("psd.launchCmdHint")}
          >
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
              {launchSteps.length === 0 && (
                <span className="text-caption text-muted-foreground">
                  {t("psd.noCommands")}
                </span>
              )}
              {launchSteps.map((s, i) => (
                <code
                  key={i}
                  title={s.command}
                  className="w-full truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-foreground"
                >
                  {s.label}
                </code>
              ))}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setOpenSlug(slug);
                }}
                className="skin-ctl px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t("psd.editInPanel")}
              </button>
            </div>
          </FieldRow>

          <FieldRow
            icon={<Terminal className="h-3.5 w-3.5" />}
            title={t("settings.page.terminalTitle")}
            hint={t("psd.termHint")}
          >
            <MenuSelect
              value={detail?.terminalChoice ?? FOLLOW_GLOBAL}
              options={[
                { id: FOLLOW_GLOBAL, label: t("psd.followGlobal") },
                ...terminals.map((tool) => ({ id: tool.id, label: tool.label })),
              ]}
              onChange={(v) => void writeDefaults({ terminalChoice: v })}
              ariaLabel={t("psd.termAria")}
              width="w-[12rem]"
            />
          </FieldRow>

          <FieldRow
            icon={<Terminal className="h-3.5 w-3.5" />}
            title={t("settings.page.ideTitle")}
            hint={t("psd.ideHint")}
          >
            <MenuSelect
              value={detail?.ideChoice ?? FOLLOW_GLOBAL}
              options={[
                { id: FOLLOW_GLOBAL, label: t("psd.followGlobal") },
                ...ides.map((tool) => ({ id: tool.id, label: tool.label })),
              ]}
              onChange={(v) => void writeDefaults({ ideChoice: v })}
              ariaLabel={t("psd.ideAria")}
              width="w-[12rem]"
            />
          </FieldRow>
        </div>

        <p className="app-desc mt-1 px-0.5 text-caption text-muted-foreground">
          {t("psd.launchFootLead")}
          <code>.devhub.json</code>
          {t("psd.launchFootTail")}
        </p>
      </section>

      <section className="mt-4">
        <h3 className="skin-label mb-1 text-caption text-muted-foreground">
          {t("psd.locTitle")}
        </h3>
        <div className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card">
          <SettingRow
            title={t("psd.diskTitle")}
            hint={detail?.path ?? card.path ?? t("psd.pathMissing")}
            control={
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const p = detail?.path ?? card.path;
                    // 这个按钮的*全部*作用就是打开这个目录，所以打开不了就是失败，
                    // 不是可以吞掉的记账（lib/report-error.ts 举的 swallow 例子是
                    // 「已经保存成功之后再补一次 reveal」，不是这一种）。文案与
                    // StatusStrip / FrequentView / 项目墙的 reveal 点击一致。
                    if (p)
                      void invoke("reveal_path", { path: p }).catch((err) =>
                        reportError(err, t("wt.revealFailed")),
                      );
                  }}
                  className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent"
                >
                  <FolderOpen className="h-3 w-3" />
                  {t("wt.open")}
                </button>
                <button
                  type="button"
                  onClick={() => copy(detail?.path ?? card.path ?? "", t("psd.copyPath"))}
                  className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent"
                >
                  <Copy className="h-3 w-3" />
                  {t("psd.copy")}
                </button>
              </div>
            }
          />
          <SettingRow
            icon={<BookOpen className="h-3.5 w-3.5" />}
            title={t("readme.settingsRow")}
            hint={t("readme.settingsHint")}
            control={
              <button
                type="button"
                onClick={onOpenReadme}
                className="skin-ctl px-2 py-1 text-caption transition-colors hover:bg-accent hover:text-foreground"
              >
                {t("readme.open")}
              </button>
            }
          />
          <SettingRow
            title={t("psd.cloneTitle")}
            hint={
              detail?.url ? (
                <button
                  type="button"
                  onClick={() => void openHttpUrl(detail.url)}
                  className="truncate text-left text-primary underline decoration-dotted"
                  title={detail.url}
                >
                  {detail.url}
                </button>
              ) : (
                t("psd.noMarker")
              )
            }
            control={
              detail?.url ? (
                <button
                  type="button"
                  onClick={() => copy(detail.url, t("psd.copyUrl"))}
                  className="skin-ctl flex items-center gap-1 px-2 py-1 text-caption hover:bg-accent"
                >
                  <Copy className="h-3 w-3" />
                  {t("psd.copy")}
                </button>
              ) : undefined
            }
          />
          <SettingRow
            title={t("psd.branchTitle")}
            hint={
              <>
                {detail?.branch ? (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-caption">
                    {detail.branch}
                  </code>
                ) : (
                  t("psd.branchDefault")
                )}
                <span className="ml-1">{t("psd.branchHint")}</span>
              </>
            }
          />
          <FieldRow
            icon={<Hash className="h-3.5 w-3.5" />}
            title={t("psd.portTitle")}
            hint={t("psd.portHint")}
          >
            <div className="flex items-center gap-1.5">
              <input
                value={portDraft}
                name="portBase"
                inputMode="numeric"
                aria-label={t("psd.portTitle")}
                onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (isCommitEnter(e)) void savePort();
                }}
                placeholder={t("psd.unassigned")}
                maxLength={5}
                className="w-24 skin-ctl border border-input bg-background px-2 py-1 text-caption tabular-nums outline-none transition-colors focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void savePort()}
                disabled={saving || !portDraft || Number(portDraft) === detail?.portBase}
                className="skin-ctl px-2 py-1 text-caption transition-colors hover:bg-accent disabled:opacity-40"
              >
                {t("dialog.save")}
              </button>
              <span className="text-caption text-muted-foreground">
                {t("psd.portCurrent", {
                  v: detail?.portBase ? String(detail.portBase) : t("psd.unassigned"),
                })}
              </span>
            </div>
          </FieldRow>

          <FieldRow
            icon={<FolderTree className="h-3.5 w-3.5" />}
            title={t("py.venvTitle")}
            hint={t("psd.venvHint")}
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <PathInput
                  value={venvDraft}
                  name="venv"
                  onChange={setVenvDraft}
                  kind="directory"
                  pickerTitle={t("psd.venvPickerTitle")}
                  label={t("psd.venvFieldLabel")}
                  placeholder={t("psd.venvPlaceholder")}
                  onCommit={() => void saveVenv()}
                />
              </div>
              {detail?.venvPath && (
                <button
                  type="button"
                  onClick={() => void writeDefaults({ venvPath: null })}
                  className="skin-ctl mt-0.5 px-2 py-1 text-caption text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t("psd.clear")}
                </button>
              )}
            </div>
          </FieldRow>
        </div>

        <p className="app-desc mt-1 px-0.5 text-caption text-muted-foreground">
          {t("psd.locFootLead")}
          <code>.devhub.json</code>
          {t("psd.locFootTail")}
        </p>
      </section>

      <section className="mt-4">
        <h3 className="skin-label mb-1 text-caption text-muted-foreground">
          {t("psd.pyTitle")}
        </h3>
        <RepoPythonPanel
          slug={slug}
          venvPath={detail?.venvPath ?? null}
          venvState={detail?.venvState ?? "nothing"}
          venvDir={detail?.venvDir ?? null}
          pythonChoice={detail?.pythonChoice ?? null}
          onChanged={() => {
            // 面板上端口段、venv、启动步骤全部读自 `detail`，所以 Python 面板改完
            // 必须重读一次标记——它不是可选的补记：重读失败的话这一块显示的就是
            // 改动前的旧值，而旧值看起来和刚保存过一样。十行之外的那个 effect 已经
            // 有 alive 旗标与 catch，这里补齐同一套（含存活旗标）。
            if (slug) {
              void invoke<Detail>("repo_detail", { slug })
                .then((d) => {
                  if (aliveRef.current) setDetail(d);
                })
                .catch((err) => {
                  if (aliveRef.current) reportError(err, t("psd.refreshFailed"));
                });
            }
            onChanged();
          }}
        />
        <p className="app-desc mt-1 px-0.5 text-caption leading-snug text-muted-foreground">
          {t("psd.pyNoteLead")}
          <code>python.exe</code>
          {t("psd.pyNoteMid")}
          <strong>{t("psd.pyNoteOutside")}</strong>
          {t("psd.pyNoteJoin")}
          <code>{t("psd.venvsDir")}</code>
          {t("psd.pyNoteTail")}
        </p>
      </section>

      <RepoStoragePanel slug={slug} />

      <section className="mt-4">
        <h3 className="skin-label mb-1 text-caption text-muted-foreground">{t("wt.title")}</h3>
        <RepoWorktreesPanel slug={slug} />
        <p className="app-desc mt-1 px-0.5 text-caption leading-snug text-muted-foreground">
          {t("psd.wtNoteLead")}
          <code>{t("psd.worktreesDir")}</code>
          {t("psd.wtNoteTail")}
        </p>
      </section>

      {/* 整段（含标题与"没有 compose 文件就不出现"）由面板自己决定：这一维对没有
          compose 的仓库无话可说，外面套一个恒在的 <h3> 会留下孤零零的标题。
          没有 compose 文件时 `path` 探针拿不到文件名，面板直接返回 null。 */}
      <RepoComposePanel slug={slug} path={detail?.path ?? card.path ?? null} />

      {saving && (
        <p className="app-desc mt-2 text-caption text-muted-foreground">{t("psd.writing")}</p>
      )}
    </DialogShell>
  );
}
