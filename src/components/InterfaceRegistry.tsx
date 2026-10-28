import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog, ask as askDialog } from "@tauri-apps/plugin-dialog";
import { confirmDestructive } from "../lib/confirm";
import {
  ChevronDown,
  Download,
  Pin,
  RotateCcw,
  Upload,
} from "lucide-react";
import { cn } from "../lib/utils";
import { reportError } from "../lib/report-error";
import { t } from "../lib/i18n";
import { useI18n } from "../lib/useI18n";
import { toast } from "./Toast";
import { ActionRow, SettingsGroup, SwitchRow } from "./SettingsRows";
import {
  DEFAULT_OPEN_GROUPS,
  ELEMENTS,
  GROUP_ORDER,
  elementsWithChanges,
  exportLayout,
  isOverrideEmpty,
  parseLayout,
  useCustomize,
  type ElementDef,
  type ElementGroup,
} from "../store/customize";
import { useSelection } from "../customize/CustomizeLayer";
import { useAttention } from "../store/attention";

/**
 * 设置 → 界面: the registry, exposed.
 *
 * This is "每个页面中应当都有对应功能的设置选项按钮" made concrete. Rather than
 * one hand-authored switch per block — which is exactly how only five of ~70
 * blocks ever got one — this page is generated from `ELEMENTS`. Every registered
 * block appears under its group with whatever controls it actually declared, and
 * adding a block to the registry simultaneously gives it a switch here, an
 * inspector entry, and a 常用 pin target.
 *
 * Groups are disclosures because a flat list of 70 rows is not navigable. The
 * disclosure is a real rotating chevron over an animated open, not a text button
 * that swaps its own label — the report called the old one out as "清冷、生硬".
 */
export function InterfaceSection() {
  const { t } = useI18n();
  const [open, setOpen] = useState<Set<ElementGroup>>(
    () => new Set(DEFAULT_OPEN_GROUPS),
  );
  // 订阅窄一点（r17-o2-1）：这一页真正用到的只有 `overrides` —— 计数与每个
  // 区块的已调整标记都从它读。此前 `useCustomize((s) => s)` 把整个 store 拉下来，
  // 于是 usage 每点一下、devMode 一开关、侧边栏拖动换宽度都会换掉快照并让整张
  // 70 行的列表重渲染，与这些字段毫无关系。签名收窄后（`elementsWithChanges`
  // 也只读 overrides，见 store/customize.ts），订阅就只剩它。
  const overrides = useCustomize((s) => s.overrides);
  const changedCount = elementsWithChanges({ overrides }).length;

  return (
    <>
      <SettingsGroup
        title={t("appearance.groupChrome")}
        regId="settings-group-interface"
        sectionId="interface"
        footnote={
          changedCount > 0
            ? t("iface.footnoteChanged", { n: changedCount })
            : t("iface.footnoteIdle")
        }
      >
        <GroupDisclosure
          title={t("iface.master")}
          count={1}
          open
          onToggle={() => undefined}
        >
          <DevModeRow />
          <CompletionAttentionRow />
        </GroupDisclosure>
      </SettingsGroup>

      <SettingsGroup regId="settings-group-interface-list" sectionId="interface-list">
        {GROUP_ORDER.map((group) => {
          const items = ELEMENTS.filter((e) => e.group === group);
          if (items.length === 0) return null;
          const isOpen = open.has(group);
          const touched = items.filter((e) => !isOverrideEmpty(overrides[e.id])).length;
          return (
            <GroupDisclosure
              key={group}
              title={group}
              count={items.length}
              touched={touched}
              open={isOpen}
              onToggle={() =>
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })
              }
            >
              {items.map((e) => (
                <ElementRow key={e.id} def={e} />
              ))}
            </GroupDisclosure>
          );
        })}
      </SettingsGroup>

      <SettingsGroup
        regId="settings-group-interface-io"
        footnote={t("iface.ioFootnote")}
      >
        <ActionRow
          icon={<Upload className="h-4 w-4" />}
          title={t("iface.exportTitle")}
          hint={t("iface.exportHint")}
          actionLabel={t("appearance.tplExport")}
          secondary
          onAction={() => void exportLayoutFile()}
        />
        <ActionRow
          icon={<Download className="h-4 w-4" />}
          title={t("iface.importTitle")}
          hint={t("iface.importHint")}
          actionLabel={t("appearance.tplImport")}
          secondary
          onAction={() => void importLayoutFile()}
        />
        <ActionRow
          icon={<RotateCcw className="h-4 w-4" />}
          title={t("iface.resetAllTitle")}
          hint={t("iface.resetAllHint", { n: changedCount })}
          actionLabel={t("appearance.resetAction")}
          danger
          onAction={() => void resetEverything()}
        />
      </SettingsGroup>
    </>
  );
}

// ---------------------------------------------------------------------------

function GroupDisclosure({
  title,
  count,
  touched = 0,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  touched?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="[&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-state)]",
            !open && "-rotate-90",
          )}
        />
        <span className="skin-label text-body font-medium">{title}</span>
        <span className="text-caption tabular-nums text-muted-foreground">{count}</span>
        {touched > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-caption tabular-nums text-foreground">
            {t("iface.touched", { n: touched })}
          </span>
        )}
      </button>
      <div
        className={cn(
          "grid disclosure",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/**
 * One registered block.
 *
 * The three controls share a row rather than each getting their own line: a
 * block's 显示 / 尺寸 / 钉选 are one decision ("how much of this do I want"), and
 * splitting them across three rows would turn 70 blocks into 210 rows.
 */
function ElementRow({ def }: { def: ElementDef }) {
  const { t } = useI18n();
  const o = useCustomize((s) => s.overrides[def.id]);
  const devMode = useCustomize((s) => s.devMode);
  const setDevMode = useCustomize((s) => s.setDevMode);
  const toggleHidden = useCustomize((s) => s.toggleHidden);
  const togglePin = useCustomize((s) => s.togglePin);
  const setSize = useCustomize((s) => s.setSize);
  const resetElement = useCustomize((s) => s.resetElement);
  const select = useSelection((s) => s.select);
  const changed = !isOverrideEmpty(o);

  // 审计 G10：devMode 关闭时「调整」按钮曾是静默 no-op；现在一键开启。
  const onAdjust = async () => {
    if (!devMode) {
      const ok = await askDialog(t("iface.adjustLocked", { label: def.label }), {
        title: t("iface.enableDevTitle"),
        kind: "info",
        okLabel: t("iface.enableDevOk"),
        cancelLabel: t("iface.cancel"),
      });
      if (ok) setDevMode(true);
      return;
    }
    select(def.id);
  };

  // 审计 G4：隐藏常驻信息区块前必须确认，防止导航被全部关掉后无法自救。
  const onHide = async () => {
    if (def.critical && !o?.hidden) {
      const ok = await confirmDestructive(t("iface.hideCritical", { label: def.label }), {
        title: t("iface.hideCriticalTitle"),
        okLabel: t("iface.hideOk"),
      });
      if (!ok) return;
    }
    toggleHidden(def.id);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-dashed border-border-weak px-2.5 py-1.5 transition-colors hover:bg-accent/30",
        o?.hidden && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => void onAdjust()}
        title={
          devMode
            ? t("iface.adjustTitle", { label: def.label, id: def.id })
            : t("iface.adjustTitleLocked", { label: def.label, id: def.id })
        }
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-caption font-medium">{def.label}</span>
        {def.hint && (
          <span className="app-desc block truncate text-caption text-muted-foreground">
            {def.hint}
          </span>
        )}
      </button>

      {def.critical && (
        <span
          className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-caption text-warning"
          title={t("iface.criticalTitle")}
        >
          {t("iface.criticalBadge")}
        </span>
      )}

      {def.sizes && (
        <span className="flex shrink-0 gap-1">
          {def.sizes.map((tier) => (
            <button
              key={tier.id}
              type="button"
              onClick={() => setSize(def.id, o?.size === tier.id ? undefined : tier.id)}
              aria-pressed={o?.size === tier.id}
              className={cn(
                "skin-ctl border px-1.5 py-0.5 text-caption t-state",
                o?.size === tier.id
                  ? "border-primary/60 bg-primary/15 font-medium"
                  : "border-border text-muted-foreground hover:bg-accent active:scale-[0.97]",
              )}
            >
              {tier.label}
            </button>
          ))}
        </span>
      )}

      {def.pinnable && (
        <button
          type="button"
          onClick={() => togglePin(def.id)}
          aria-pressed={!!o?.pinned}
          aria-label={o?.pinned ? t("iface.unpin") : t("iface.pin")}
          title={o?.pinned ? t("iface.unpin") : t("iface.pin")}
          className={cn(
            "shrink-0 rounded border p-1 transition-colors",
            o?.pinned
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Pin className="h-3 w-3" />
        </button>
      )}

      {changed && (
        <button
          type="button"
          onClick={() => resetElement(def.id)}
          aria-label={t("iface.resetOne")}
          title={t("iface.resetOne")}
          className="shrink-0 rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}

      <Switch
        checked={!o?.hidden}
        onChange={() => void onHide()}
        label={def.label}
      />
    </div>
  );
}

function DevModeRow() {
  const { t } = useI18n();
  const devMode = useCustomize((s) => s.devMode);
  const setDevMode = useCustomize((s) => s.setDevMode);
  return (
    <SwitchRow
      title={t("iface.devModeTitle")}
      hint={t("iface.devModeHint")}
      checked={devMode}
      onChange={setDevMode}
      regId="settings-row-dev-mode"
    />
  );
}

function CompletionAttentionRow() {
  const { t } = useI18n();
  const enabled = useAttention((s) => s.enabled);
  const setEnabled = useAttention((s) => s.setEnabled);
  return (
    <SwitchRow
      title={t("iface.attentionTitle")}
      hint={t("iface.attentionHint")}
      checked={enabled}
      onChange={setEnabled}
      regId="settings-row-attention"
    />
  );
}

/** Local copy of the switch so this file does not depend on the row wrapper. */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "skin-ctl flex h-5 w-9 shrink-0 items-center border p-0.5 transition-colors duration-[var(--motion-state)]",
        checked ? "border-primary bg-primary" : "border-border bg-transparent",
      )}
    >
      <span
        className={cn(
          "h-3 w-3 rounded-full transition-transform duration-[var(--motion-state)] ease-out",
          checked ? "translate-x-4 bg-primary-foreground" : "translate-x-0 bg-muted-foreground",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout export / import
// ---------------------------------------------------------------------------

async function exportLayoutFile() {
  const c = useCustomize.getState();
  const picked = await saveDialog({
    title: t("iface.exportTitle"),
    defaultPath: "devhub-layout.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!picked) return;
  try {
    await invoke("write_text_file", { path: picked, text: exportLayout(c) });
    toast.success(t("iface.exportedOk"));
  } catch (e) {
    // The webview has no filesystem write access, so this needs a backend
    // command. If it is not present, say so rather than reporting a success.
    reportError(e, t("iface.exportFail"));
  }
}

async function importLayoutFile() {
  const picked = await openDialog({
    title: t("iface.importTitle"),
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof picked !== "string" || !picked) return;
  try {
    const text = await invoke<string>("read_text_file", { path: picked });
    const parsed = parseLayout(text);
    if (!parsed) {
      toast.error(t("iface.importInvalid"));
      return;
    }
    useCustomize.getState().importLayout(parsed);
    toast.success(t("iface.importedOk"));
  } catch (e) {
    reportError(e, t("iface.importFail"));
  }
}

async function resetEverything() {
  const ok = await confirmDestructive(t("iface.resetAllConfirm"), {
    title: t("iface.resetAllConfirmTitle"),
    okLabel: t("iface.resetOk"),
  });
  if (!ok) return;
  useCustomize.getState().resetAll();
  toast.success(t("iface.resetAllOk"));
}
