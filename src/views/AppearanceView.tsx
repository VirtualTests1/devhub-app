import { useEffect, useMemo, useRef, useState } from "react";
import { ask as askDialog } from "@tauri-apps/plugin-dialog";
import { confirmDestructive } from "../lib/confirm";
import {
  ArrowDown,
  ChevronDown,
  Clipboard,
  ClipboardPaste,
  FolderOpen,
  Image,
  LayoutGrid,
  List,
  Minus,
  Moon,
  Palette,
  Plus,
  RotateCcw,
  ScrollText,
  Save,
  Settings,
  Type,
  Zap,
  Waves,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useDismiss } from "../lib/useDismiss";
import { numberKeyHandler } from "../lib/number-keys";
import { toast } from "../components/Toast";
import { useI18n } from "../lib/useI18n";
import { useCustomize } from "../store/customize";
import { usePopoverPlacement } from "../components/Controls";
import {
  ActionRow,
  ChoiceRow,
  FieldRow,
  SettingsGroup,
  SettingRow,
  SwitchRow,
} from "../components/SettingsRows";
import { loadSystemFonts, type SystemFontList } from "../lib/fonts";
import {
  SCALE_DENSITIES,
  TYPE_SCALES,
  AMBIENCES,
  DEFAULT_FONT_STACK,
  FONT_SCALES,
  SKINS,
  TEMPLATES_KEY,
  WEIGHT_CHOICES,
  deleteTemplate,
  familyDisplay,
  loadTemplates,
  renameTemplate,
  sanitizeTemplateValues,
  saveTemplate,
  useAppearance,
  type Appearance,
  type FontWeightChoice,
} from "../store/appearance";

/**
 * 外观 — the settings catalog's 外观 page (round 9, 需求 10).
 *
 * The long way round: round 3 merged 外观 into 设置, the report that came back
 * was that a sidebar entry landing on 设置 felt wrong, so round 6 made the page
 * standalone again and left 设置 with a *jump row* — which satisfied "one copy
 * of every control" while quietly meaning the 设置 page never actually
 * contained the appearance controls. Round 9 finishes the merge properly: the
 * groups below ARE the 外观 catalog page, there is no standalone route and no
 * jump row to maintain.
 *
 * Everything here is frontend-only: localStorage plus data attributes on
 * <html>, applied by `applyAppearance`. Nothing touches the Rust config, so
 * switching machines or clearing app data reverts it.
 *
 * r18-o1-3: every literal above was moved into the dictionary; the two
 * neighbours left out are `store/appearance.ts`'s option tables (SKINS /
 * TYPE_SCALES / AMBIENCES / FONT_SCALES / SCALE_DENSITIES / WEIGHT_CHOICES
 * labels — a pure .ts module, outside the ratchet's scope, same batch as
 * LAYER_LABEL) and the persisted fallback template name `导入的模版` (data,
 * annotated at its call site).
 */

export function SizeGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  const currentScale = FONT_SCALES.find((s) => s.rootPx === a.uiFontPx)?.id ?? "";
  const setPx = (px: number) => a.set("uiFontPx", Math.min(22, Math.max(12, Math.round(px))));
  const pxKeys = numberKeyHandler({ min: 12, max: 22, step: 1, apply: setPx });

  return (
    <SettingsGroup title={t("appearance.groupSize")} regId="appearance-group-size">
      <ChoiceRow
        icon={<Type className="h-4 w-4" />}
        title={t("appearance.fontScaleTitle")}
        hint={t("appearance.fontScaleHint")}
        value={currentScale}
        options={FONT_SCALES.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => {
          const s = FONT_SCALES.find((x) => x.id === id);
          if (s) a.set("uiFontPx", s.rootPx);
        }}
        regId="appearance-row-font-scale"
      />
      <FieldRow
        icon={<List className="h-4 w-4" />}
        title={t("appearance.fontPxTitle")}
        hint={t("appearance.fontPxHint")}
        regId="appearance-row-font-px"
      >
        <div className="flex items-center gap-1" data-no-row-click>
          <button
            type="button"
            onClick={() => setPx(a.uiFontPx - 1)}
            disabled={a.uiFontPx <= 12}
            className="skin-ctl flex h-6 w-6 items-center justify-center border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            aria-label={t("appearance.fontPxMinus")}
          >
            <Minus className="h-3 w-3" />
          </button>
          <input
            type="number"
            min={12}
            max={22}
            value={a.uiFontPx}
            aria-label={t("appearance.fontPxAria")}
            onChange={(e) => setPx(Number(e.target.value) || a.uiFontPx)}
            onKeyDown={pxKeys}
            className="w-14 skin-ctl border border-input bg-background px-2 py-1 text-center text-caption tabular-nums outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={() => setPx(a.uiFontPx + 1)}
            disabled={a.uiFontPx >= 22}
            className="skin-ctl flex h-6 w-6 items-center justify-center border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            aria-label={t("appearance.fontPxPlus")}
          >
            <Plus className="h-3 w-3" />
          </button>
          <span className="text-caption text-muted-foreground">px</span>
        </div>
      </FieldRow>
      <ChoiceRow
        icon={<Type className="h-4 w-4" />}
        title={t("appearance.scaleTitle")}
        hint={t("appearance.scaleHint")}
        value={a.scale}
        options={TYPE_SCALES.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => a.set("scale", id as Appearance["scale"])}
        regId="appearance-row-scale"
      />
      <ChoiceRow
        icon={<Waves className="h-4 w-4" />}
        title={t("appearance.ambienceTitle")}
        hint={t("appearance.ambienceHint")}
        value={a.ambience}
        options={AMBIENCES.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => a.set("ambience", id as Appearance["ambience"])}
        regId="appearance-row-ambience"
      />
      <ChoiceRow
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t("appearance.densityTitle")}
        hint={t("appearance.densityHint")}
        value={a.density}
        options={SCALE_DENSITIES.map((d) => ({ id: d.id, label: d.label }))}
        onChange={(id) => a.set("density", id as Appearance["density"])}
        regId="appearance-row-density"
      />
      <ChoiceRow
        icon={<LayoutGrid className="h-4 w-4" />}
        title={t("appearance.columnsTitle")}
        hint={t("appearance.columnsHint")}
        value={String(a.gridColumns)}
        options={[
          { id: "0", label: t("appearance.columnsAuto") },
          { id: "2", label: t("appearance.columnsN", { n: 2 }) },
          { id: "3", label: t("appearance.columnsN", { n: 3 }) },
          { id: "4", label: t("appearance.columnsN", { n: 4 }) },
          { id: "5", label: t("appearance.columnsN", { n: 5 }) },
          { id: "6", label: t("appearance.columnsN", { n: 6 }) },
        ]}
        onChange={(id) => a.set("gridColumns", Number(id))}
        regId="appearance-row-grid-columns"
      />
    </SettingsGroup>
  );
}

export function ThemeGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  return (
    <SettingsGroup title={t("appearance.groupTheme")} regId="appearance-group-theme">
      <ChoiceRow
        icon={<Moon className="h-4 w-4" />}
        title={t("appearance.themeTitle")}
        hint={t("appearance.themeHint")}
        value={a.theme}
        options={[
          { id: "dark", label: t("appearance.themeDark") },
          { id: "light", label: t("appearance.themeLight") },
          { id: "system", label: t("appearance.themeSystem") },
        ]}
        onChange={(id) => a.set("theme", id as Appearance["theme"])}
        regId="appearance-row-theme"
      />
      <ChoiceRow
        icon={<Palette className="h-4 w-4" />}
        title={t("appearance.skinTitle")}
        hint={SKINS.find((s) => s.id === a.skin)?.note}
        value={a.skin}
        options={SKINS.map((s) => ({ id: s.id, label: s.label }))}
        onChange={(id) => a.set("skin", id as Appearance["skin"])}
        regId="appearance-row-skin"
      />
      <FontPickerRow />
      <ChoiceRow
        icon={<Type className="h-4 w-4" />}
        title={t("appearance.fontWeightTitle")}
        hint={t("appearance.fontWeightHint")}
        value={a.fontWeight}
        options={WEIGHT_CHOICES.map((w) => ({ id: w.id, label: w.label }))}
        onChange={(id) => a.set("fontWeight", id as FontWeightChoice)}
        regId="appearance-row-font-weight"
      />
    </SettingsGroup>
  );
}

/**
 * The font picker (需求 5).
 *
 * The old picker had five hard-coded choices and none of the machine's real
 * fonts. This one lists what `list_system_fonts` reports (registry-enumerated
 * families, localized display names for common CJK families), each option
 * rendered in its own family like Word's font box, searchable by either name.
 * When the backend command is not in this build, it degrades to a curated
 * common-families list and says so under the row.
 */
function FontPickerRow() {
  const { t } = useI18n();
  const a = useAppearance();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<SystemFontList | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Same placement as every other popover (fixed + clamp + flip). It used to be
  // `absolute top-full` inside a settings group, whose `overflow-hidden` cut the
  // bottom off the list.
  const { anchorRef: fontAnchorRef, popRef: fontPopRef, at: fontAt } = usePopoverPlacement(open, "end");

  useEffect(() => {
    if (open && !list) {
      void loadSystemFonts().then(setList);
    }
  }, [open, list]);

  // Click-outside and Escape close the panel — a dropdown that only closes on
  // re-click reads as broken.（原先这里逐字写过一遍 mousedown+Escape；现在与
  // 其余浮层共用 useDismiss，事件统一为 pointerdown。）
  useDismiss(wrapRef, () => setOpen(false), { enabled: open });

  const filtered = useMemo(() => {
    const all = list?.families ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (f) =>
        f.family.toLowerCase().includes(q) || f.display.toLowerCase().includes(q),
    );
  }, [list, query]);

  const current =
    a.fontFamily === "" ? t("appearance.fontSystemDefault") : familyDisplay(a.fontFamily);

  return (
    <div className="relative" ref={wrapRef}>
      <SettingRow
        icon={<Type className="h-4 w-4" />}
        title={t("appearance.fontTitle")}
        hint={
          list?.source === "fallback"
            ? t("appearance.fontHintFallback")
            : t("appearance.fontHint")
        }
        onRowClick={() => setOpen((o) => !o)}
        control={
          <button
            ref={(el) => {
              fontAnchorRef.current = el;
            }}
            type="button"
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen(true);
              }
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn(
              "skin-ctl flex max-w-[15rem] min-w-[7rem] items-center gap-1.5 border bg-card px-2 py-1 text-caption text-foreground",
              "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              open ? "border-primary/60 bg-accent" : "border-border",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-left">{current}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-state)]",
                open && "rotate-180",
              )}
            />
          </button>
        }
        regId="appearance-row-font"
      />
      {open && (
        <div
          ref={fontPopRef}
          className={cn(
            "skin-pop fixed z-[var(--z-popover)] w-[24rem] max-w-[90%] overflow-hidden border border-border bg-raised",
            !fontAt.ready && "invisible",
          )}
          style={{ top: fontAt.top, left: fontAt.left }}
          role="listbox"
          aria-label={t("appearance.fontListAria")}
        >
          <div className="border-b border-border-weak p-2">
            <input
              autoFocus
              value={query}
              aria-label={t("appearance.fontSearchAria")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the first match: the field is a filter, so the
                // top row is what "the one I meant" almost always is.
                if (e.key === "Enter") {
                  e.preventDefault();
                  const first = filtered[0];
                  if (!first) return;
                  a.set("fontFamily", first.family);
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder={t("appearance.fontSearchPlaceholder")}
              className="w-full skin-ctl border border-input bg-background px-2.5 py-1.5 text-caption outline-none focus:border-primary"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            <FontOption
              family=""
              display={t("appearance.fontSystemDefault")}
              selected={a.fontFamily === ""}
              onPick={() => {
                a.set("fontFamily", "");
                setOpen(false);
              }}
            />
            {filtered.map((f) => (
              <FontOption
                key={f.family}
                family={f.family}
                display={f.display}
                selected={a.fontFamily === f.family}
                onPick={() => {
                  a.set("fontFamily", f.family);
                  setOpen(false);
                }}
              />
            ))}
            {list && filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-caption text-muted-foreground">
                {t("appearance.fontNoMatch", { query })}
              </p>
            )}
            {!list && (
              <p className="px-3 py-4 text-center text-caption text-muted-foreground">
                {t("appearance.fontLoading")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FontOption({
  family,
  display,
  selected,
  onPick,
}: {
  family: string;
  display: string;
  selected: boolean;
  onPick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        "skin-ctl-inner flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent",
        selected && "bg-primary/10",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-body text-foreground">{display}</span>
        {family !== "" && display !== family && (
          <span className="block truncate text-caption text-muted-foreground">{family}</span>
        )}
      </span>
      <span
        className="shrink-0 text-caption text-muted-foreground"
        style={{
          fontFamily:
            family === ""
              ? DEFAULT_FONT_STACK
              : `"${family}", ${DEFAULT_FONT_STACK}`,
        }}
      >
        {t("appearance.fontPreview")}
      </span>
    </button>
  );
}

export function ContentGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  return (
    <SettingsGroup
      title={t("appearance.groupContent")}
      regId="appearance-group-content"
      footnote={t("appearance.contentFootnote")}
    >
      <SwitchRow
        icon={<Image className="h-4 w-4" />}
        title={t("appearance.coversTitle")}
        hint={t("appearance.coversHint")}
        checked={a.covers}
        onChange={(v) => a.set("covers", v)}
        regId="appearance-row-covers"
      />
      <SwitchRow
        icon={<FolderOpen className="h-4 w-4" />}
        title={t("appearance.repoPathTitle")}
        hint={t("appearance.repoPathHint")}
        checked={a.showRepoPath}
        onChange={(v) => a.set("showRepoPath", v)}
        regId="appearance-row-repo-path"
      />
      <SwitchRow
        icon={<Zap className="h-4 w-4" />}
        title={t("appearance.reduceMotionTitle")}
        hint={t("appearance.reduceMotionHint")}
        checked={a.reduceMotion}
        onChange={(v) => a.set("reduceMotion", v)}
        regId="appearance-row-reduce-motion"
      />
      <SwitchRow
        icon={<ArrowDown className="h-4 w-4" />}
        title={t("appearance.autoScrollTitle")}
        hint={t("appearance.autoScrollHint")}
        checked={a.autoScrollOutput}
        onChange={(v) => a.set("autoScrollOutput", v)}
        regId="appearance-row-auto-scroll"
      />
      <SwitchRow
        icon={<Type className="h-4 w-4" />}
        title={t("appearance.showDescTitle")}
        hint={t("appearance.showDescHint")}
        checked={!a.hideDesc}
        onChange={(v) => a.set("hideDesc", !v)}
        regId="appearance-row-hide-desc"
      />
      <SwitchRow
        icon={<ScrollText className="h-4 w-4" />}
        title={t("appearance.scrollbarTitle")}
        hint={t("appearance.scrollbarHint")}
        checked={a.showScrollbar}
        onChange={(v) => a.set("showScrollbar", v)}
        regId="appearance-row-scrollbar"
      />
    </SettingsGroup>
  );
}

export function ChromeGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  const settingsEntry = useCustomize((s) => s.settingsEntry);
  const setSettingsEntry = useCustomize((s) => s.setSettingsEntry);
  return (
    <SettingsGroup
      title={t("appearance.groupChrome")}
      regId="appearance-group-chrome"
      footnote={t("appearance.chromeFootnote")}
    >
      <SwitchRow
        title={t("appearance.brandTitle")}
        checked={a.showBrand}
        onChange={(v) => a.set("showBrand", v)}
        regId="appearance-row-show-brand"
      />
      <SwitchRow
        title={t("appearance.refreshTitle")}
        checked={a.showRefresh}
        onChange={(v) => a.set("showRefresh", v)}
        regId="appearance-row-show-refresh"
      />
      <SwitchRow
        title={t("appearance.statusStripTitle")}
        checked={a.showStatusStrip}
        onChange={(v) => a.set("showStatusStrip", v)}
        regId="appearance-row-show-status-strip"
      />
      <SwitchRow
        title={t("appearance.versionTitle")}
        checked={a.showVersion}
        onChange={(v) => a.set("showVersion", v)}
        regId="appearance-row-show-version"
      />
      <SwitchRow
        title={t("appearance.searchBlockTitle")}
        checked={a.showSearchBlock}
        onChange={(v) => a.set("showSearchBlock", v)}
        regId="appearance-row-show-search-block"
      />
      {/* 需求 10: 设置入口的位置可选。默认侧边栏底部（与内容视图分隔的常规位置），
          也可放标题栏右侧；同一时刻只渲染一个，注册 id 相同。 */}
      <ChoiceRow
        icon={<Settings className="h-4 w-4" />}
        title={t("appearance.settingsEntryTitle")}
        hint={t("appearance.settingsEntryHint")}
        value={settingsEntry}
        options={[
          { id: "footer", label: t("appearance.settingsEntryFooter") },
          { id: "titlebar", label: t("appearance.settingsEntryTitlebar") },
        ]}
        onChange={(id) => setSettingsEntry(id === "titlebar" ? "titlebar" : "footer")}
        regId="appearance-row-settings-entry"
      />
    </SettingsGroup>
  );
}

/**
 * 外观模版 (需求 7): save the whole appearance under a name, apply it back in
 * one click. Stored in their own localStorage key; export copies JSON, import
 * accepts the same shape.
 */
export function TemplateGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  const [templates, setTemplates] = useState(loadTemplates);
  const [naming, setNaming] = useState("");
  const [namingOpen, setNamingOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const applyTemplate = async (id: string) => {
    const tpl = templates.find((item) => item.id === id);
    if (!tpl) return;
    const values = sanitizeTemplateValues(tpl.values);
    const keys = Object.keys(values).length;
    if (keys === 0) {
      toast.error(t("appearance.tplNoItems"));
      return;
    }
    const ok = await askDialog(t("appearance.tplApplyConfirm", { name: tpl.name, n: keys }), {
      title: t("appearance.tplApplyTitle"),
      kind: "info",
      okLabel: t("appearance.tplApplyOk"),
      cancelLabel: t("appearance.cancel"),
    });
    if (!ok) return;
    a.applyMany(values, tpl.name);
    toast.success(t("appearance.tplApplied", { name: tpl.name }));
  };

  const exportTemplate = async (id: string) => {
    const tpl = templates.find((item) => item.id === id);
    if (!tpl) return;
    const json = JSON.stringify({ name: tpl.name, values: tpl.values }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      toast.success(t("appearance.tplExportCopied"));
    } catch {
      setImportOpen(true);
      setImportText(json);
      toast.info(t("appearance.tplExportFallback"));
    }
  };

  const removeTemplate = async (id: string) => {
    const tpl = templates.find((item) => item.id === id);
    const ok = await confirmDestructive(
      t("appearance.tplDeleteConfirm", { name: tpl?.name ?? id }),
      {
        title: t("appearance.tplDeleteTitle"),
        okLabel: t("appearance.tplDeleteOk"),
      },
    );
    if (!ok) return;
    setTemplates(deleteTemplate(id));
    toast.success(t("appearance.tplDeleted"));
  };

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText) as { name?: string; values?: unknown };
      const values = sanitizeTemplateValues(parsed.values ?? parsed);
      if (Object.keys(values).length === 0) {
        toast.error(t("appearance.tplImportNoItems"));
        return;
      }
      const list = saveTemplate(
        // r18-o1-3: 默认模版名是持久化数据（写进本地模版列表），不译。
        parsed.name || "导入的模版",
        {
          ...useAppearance.getState(),
          ...values,
        } as Appearance,
      );
      setTemplates(list);
      setImportText("");
      setImportOpen(false);
      toast.success(t("appearance.tplImported"));
    } catch {
      toast.error(t("appearance.tplImportParseFailed"));
    }
  };

  return (
    <SettingsGroup
      title={t("appearance.groupTemplates")}
      regId="appearance-group-templates"
      footnote={
        <>
          {t("appearance.tplFootnoteLead")}
          <code>{TEMPLATES_KEY}</code>
          {t("appearance.tplFootnoteTail")}
        </>
      }
    >
      {templates.length === 0 && (
        <p className="px-3 py-3 text-caption text-muted-foreground">
          {t("appearance.tplEmpty")}
        </p>
      )}
      {templates.map((tpl) => (
        <SettingRow
          key={tpl.id}
          title={renaming?.id === tpl.id ? t("appearance.tplRenameTitle") : tpl.name}
          hint={new Date(tpl.createdAt).toLocaleString()}
          regId="appearance-row-template"
          control={
            renaming?.id === tpl.id ? (
              <span className="flex items-center gap-1" data-no-row-click>
                <input
                  autoFocus
                  value={renaming.name}
                  aria-label={t("appearance.tplRenameAria")}
                  onChange={(e) => setRenaming({ id: tpl.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTemplates(renameTemplate(tpl.id, renaming.name));
                      setRenaming(null);
                    } else if (e.key === "Escape") {
                      setRenaming(null);
                    }
                  }}
                  className="w-40 skin-ctl border border-input bg-background px-2 py-1 text-caption outline-none focus:border-primary"
                />
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1" data-no-row-click>
                <SmallBtn
                  label={t("appearance.tplApply")}
                  onClick={() => void applyTemplate(tpl.id)}
                  primary
                />
                <SmallBtn
                  label={t("appearance.tplExport")}
                  onClick={() => void exportTemplate(tpl.id)}
                />
                <SmallBtn
                  label={t("appearance.tplRename")}
                  onClick={() => setRenaming({ id: tpl.id, name: tpl.name })}
                />
                <SmallBtn
                  label={t("appearance.tplDelete")}
                  onClick={() => void removeTemplate(tpl.id)}
                  danger
                />
              </span>
            )
          }
        />
      ))}

      {namingOpen ? (
        <FieldRow
          icon={<Save className="h-4 w-4" />}
          align="stack"
          title={t("appearance.tplSaveTitle")}
          hint={t("appearance.tplSaveHint")}
        >
          <div className="flex gap-2" data-no-row-click>
            <input
              autoFocus
              value={naming}
              aria-label={t("appearance.tplNewAria")}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && naming.trim()) {
                  setTemplates(saveTemplate(naming, useAppearance.getState()));
                  setNaming("");
                  setNamingOpen(false);
                  toast.success(t("appearance.tplSaved"));
                } else if (e.key === "Escape") {
                  setNamingOpen(false);
                }
              }}
              placeholder={t("appearance.tplNewPlaceholder")}
              className="min-w-0 flex-1 skin-ctl border border-input bg-background px-3 py-2 text-caption outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={!naming.trim()}
              onClick={() => {
                setTemplates(saveTemplate(naming, useAppearance.getState()));
                setNaming("");
                setNamingOpen(false);
                toast.success(t("appearance.tplSaved"));
              }}
              className="skin-ctl bg-primary px-4 py-2 text-caption font-medium text-primary-foreground transition-colors hover:brightness-95 disabled:opacity-40"
            >
              {t("appearance.tplSave")}
            </button>
          </div>
        </FieldRow>
      ) : (
        <ActionRow
          icon={<Save className="h-4 w-4" />}
          title={t("appearance.tplSaveTitle")}
          hint={t("appearance.tplSaveActionHint")}
          actionLabel={t("appearance.tplNew")}
          secondary
          onAction={() => setNamingOpen(true)}
          regId="appearance-action-save-template"
        />
      )}

      {importOpen ? (
        <FieldRow
          icon={<ClipboardPaste className="h-4 w-4" />}
          align="stack"
          title={t("appearance.tplImportTitle")}
          hint={t("appearance.tplImportHint")}
        >
          <div className="space-y-2" data-no-row-click>
            <textarea
              autoFocus
              value={importText}
              aria-label={t("appearance.tplImportAria")}
              onChange={(e) => setImportText(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full skin-ctl border border-input bg-background px-3 py-2 font-mono text-caption outline-none focus:border-primary"
              placeholder={t("appearance.tplImportPlaceholder")}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={doImport}
                className="skin-ctl bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground transition-colors hover:brightness-95"
              >
                {t("appearance.tplImport")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportOpen(false);
                  setImportText("");
                }}
                className="skin-ctl border border-border px-3 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t("appearance.cancel")}
              </button>
            </div>
          </div>
        </FieldRow>
      ) : (
        <ActionRow
          icon={<Clipboard className="h-4 w-4" />}
          title={t("appearance.tplImportTitle")}
          hint={t("appearance.tplImportActionHint")}
          actionLabel={t("appearance.tplPasteImport")}
          secondary
          onAction={() => setImportOpen(true)}
          regId="appearance-action-import-template"
        />
      )}
    </SettingsGroup>
  );
}

function SmallBtn({
  label,
  onClick,
  primary,
  danger,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "skin-ctl border px-2 py-1 text-caption transition-colors",
        primary
          ? "border-primary bg-primary text-primary-foreground hover:brightness-95"
          : danger
            ? "border-border text-muted-foreground hover:bg-danger/10 hover:text-danger"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function ResetGroup() {
  const { t } = useI18n();
  const a = useAppearance();
  return (
    <SettingsGroup
      regId="appearance-group-footer"
      footnote={t("appearance.resetFootnote")}
    >
      <ActionRow
        icon={<RotateCcw className="h-4 w-4" />}
        title={t("appearance.resetTitle")}
        hint={t("appearance.resetHint")}
        actionLabel={t("appearance.resetAction")}
        secondary
        onAction={() => {
          a.reset();
          toast.success(t("appearance.resetDone"));
        }}
        regId="appearance-action-reset"
      />
    </SettingsGroup>
  );
}
