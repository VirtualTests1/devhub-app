import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Download, Eye, LayoutGrid, Search, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { toast } from "../../components/Toast";
import {
  ActionRow,
  ChoiceRow,
  FieldRow,
  SettingsGroup,
  SwitchRow,
} from "../../components/SettingsRows";
import { messageOf } from "../../lib/report-error";
import { WALL_DENSITIES, FILTERS, SORTS, slugOf, useWall } from "../../store/wall";
import { buildWallXfer, parseWallXfer } from "../../store/wall-xfer";
import type { RepoRef } from "../../types";
import { useI18n } from "../../lib/useI18n";
import type { TranslationKey } from "../../lib/i18n";
import { SettingRowLite } from "./rows";

/**
 * 设置 → 项目页.
 *
 * The wall's own behaviour used to live in `useState` inside the view, which meant
 * it had no setting, no default, and no way back to a clean state. This group is
 * the other half of "项目页缺失设置项目对应的功能调整".
 *
 * It writes to the wall store (`localStorage`), not to `settings.json`, so it does
 * not participate in the 保存 button at the top of this page - every row takes
 * effect on click, which is also why each one is a whole-row target rather than a
 * small control. The footnote says so, because a page where one group saves
 * differently from the rest needs to admit it.
 */
export function ProjectsWallSection({ repos }: { repos: RepoRef[] }) {
  const { t } = useI18n();
  const sort = useWall((s) => s.sort);
  const filter = useWall((s) => s.filter);
  const grouped = useWall((s) => s.grouped);
  const density = useWall((s) => s.density);
  const states = useWall((s) => s.repos);
  const setPref = useWall((s) => s.setPref);
  const toggleHidden = useWall((s) => s.toggleHidden);
  const resetOrder = useWall((s) => s.resetOrder);
  const unhideAll = useWall((s) => s.unhideAll);
  const resetAll = useWall((s) => s.resetAll);
  const applyXfer = useWall((s) => s.applyXfer);
  const [xferBusy, setXferBusy] = useState(false);

  const exportWall = useCallback(async () => {
    const picked = await saveDialog({
      title: t("pw.xferTitle"),
      defaultPath: "devhub-wall.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    setXferBusy(true);
    try {
      const payload = buildWallXfer({
        sort,
        filter,
        grouped,
        density,
        repos: states,
      });
      await invoke("write_text_file", {
        path: picked,
        text: JSON.stringify(payload, null, 2),
      });
      toast.success(t("pw.exportOk"));
    } catch (e) {
      toast.error(t("pw.exportFail", { reason: messageOf(e) }));
    } finally {
      setXferBusy(false);
    }
  }, [sort, filter, grouped, density, states, t]);

  const importWall = useCallback(async () => {
    const picked = await openDialog({
      title: t("pw.xferImportTitle"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    setXferBusy(true);
    try {
      const text = await invoke<string>("read_text_file", { path });
      const { prefs, repos: nextRepos } = parseWallXfer(text);
      applyXfer(prefs, nextRepos);
      toast.success(t("pw.importOk"));
    } catch (e) {
      toast.error(t("pw.importFail", { reason: messageOf(e) }));
    } finally {
      setXferBusy(false);
    }
  }, [applyXfer, t]);

  const hidden = repos.filter((r) => states[slugOf(r)]?.hidden);
  const ordered = Object.values(states).some((s) => s.index !== undefined);

  return (
    <SettingsGroup
      title={t("pw.groupTitle")}
      regId="settings-group-projects"
      sectionId="projects"
      footnote={
        <>
          {t("pw.groupNoteA")}
          <code> settings.json</code>
          {t("pw.groupNoteB")} <code>.devhub.json</code> {t("pw.groupNoteC")}
        </>
      }
    >
      <ChoiceRow
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t("pw.sortTitle")}
        hint={t("pw.sortHint")}
        value={sort}
        options={SORTS.map((s) => ({ id: s.id, label: t(`wall.sort.${s.id}` as TranslationKey) }))}
        onChange={(id) => {
          // Same rule as the toolbar (需求 1): a chosen tier is an explicit
          // decision, so the hand-dragged overlay - which would otherwise
          // silently win - is dropped with it.
          resetOrder();
          setPref("sort", id as typeof sort);
        }}
        regId="settings-row-wall-sort"
      />

      <ChoiceRow
        icon={<Search className="h-4 w-4" />}
        title={t("pw.filterTitle")}
        hint={t("pw.filterHint")}
        value={filter}
        options={FILTERS.map((f) => ({ id: f.id, label: t(`wall.filter.${f.id}` as TranslationKey) }))}
        onChange={(id) => setPref("filter", id as typeof filter)}
        regId="settings-row-wall-filter"
      />

      <ChoiceRow
        icon={<SlidersHorizontal className="h-4 w-4" />}
        title={t("pw.densityTitle")}
        hint={t("pw.densityHint")}
        value={density}
        options={WALL_DENSITIES.map((d) => ({
          id: d.id,
          label: t(`wall.density.${d.id}` as TranslationKey),
          hint: t(`wall.density.${d.id}Note` as TranslationKey),
        }))}
        onChange={(id) => setPref("density", id as typeof density)}
        regId="settings-row-wall-density"
      />

      <SwitchRow
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t("pw.groupedTitle")}
        hint={t("pw.groupedHint")}
        checked={grouped}
        onChange={(v) => setPref("grouped", v)}
        regId="settings-row-wall-grouped"
      />

      <ActionRow
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t("pw.orderTitle")}
        hint={ordered ? t("pw.orderHintOrdered") : t("pw.orderHintDefault")}
        actionLabel={t("pw.orderAction")}
        secondary
        disabled={!ordered}
        onAction={() => {
          resetOrder();
          toast.success(t("pw.orderDone"));
        }}
      />

      <ActionRow
        icon={<Download className="h-4 w-4" />}
        title={t("pw.exportTitle")}
        hint={t("pw.exportHint")}
        actionLabel={t("pw.exportAction")}
        secondary
        disabled={xferBusy}
        onAction={() => void exportWall()}
      />
      <ActionRow
        icon={<Upload className="h-4 w-4" />}
        title={t("pw.importTitle")}
        hint={t("pw.importHint")}
        actionLabel={t("pw.importAction")}
        secondary
        disabled={xferBusy}
        onAction={() => void importWall()}
      />

      {hidden.length > 0 && (
        <FieldRow
          icon={<Eye className="h-4 w-4" />}
          align="stack"
          title={t("pw.hiddenTitle", { n: hidden.length })}
          hint={t("pw.hiddenHint")}
        >
          <div className="skin-panel divide-dashed divide-border-weak border border-border-weak">
            {hidden.map((r) => (
              <SettingRowLite key={slugOf(r)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{r.repo}</span>
                  <span className="app-desc block truncate text-caption text-muted-foreground">
                    {r.owner} · {r.path ?? t("pw.hiddenMissing")}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => toggleHidden(slugOf(r))}
                  className="skin-ctl px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t("pw.hiddenRestore")}
                </button>
              </SettingRowLite>
            ))}
            <SettingRowLite>
              <span className="min-w-0 flex-1 text-caption text-muted-foreground">
                {t("pw.hiddenCount", { n: hidden.length })}
              </span>
              <button
                type="button"
                onClick={() => {
                  unhideAll();
                  toast.success(t("pw.hiddenRestored", { n: hidden.length }));
                }}
                className="skin-ctl px-2 py-1 text-caption hover:bg-accent"
              >
                {t("pw.hiddenRestoreAll")}
              </button>
            </SettingRowLite>
          </div>
        </FieldRow>
      )}

      <ActionRow
        icon={<Trash2 className="h-4 w-4" />}
        title={t("pw.resetTitle")}
        hint={t("pw.resetHint")}
        actionLabel={t("pw.resetAction")}
        danger
        onAction={() => {
          resetAll();
          toast.success(t("pw.resetDone"));
        }}
      />
    </SettingsGroup>
  );
}
