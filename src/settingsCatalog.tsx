import type { ReactNode } from "react";
import {
  FolderTree,
  History,
  Info,
  KeyRound,
  LayoutGrid,
  Network,
  PackageSearch,
  Palette,
  Plus,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  TriangleAlert,
} from "lucide-react";

/**
 * The 设置 catalog (round 9, 需求 10).
 *
 * One list with three consumers, so they cannot drift apart:
 *
 *   - the settings page's left-hand catalog, which is now a page-per-section
 *     layout rather than one long scroll;
 *   - the 常用 page's 功能 picker (需求 7: "所有功能都应当包含在可选项之中"),
 *     which offers every view and every settings page as a pinnable entry;
 *   - the deep-link jumps the status strip and 常用页 chips issue, which name
 *     a section id and used to rely on everyone spelling it the same way.
 *
 * The ids are the ones the existing `data-section` anchors already use, so
 * links written before the catalog existed keep working unchanged.
 */
export type SettingsSectionId =
  | "roots"
  | "projects"
  | "network"
  | "editors"
  | "records"
  | "diagnostics"
  | "deps"
  | "token"
  | "appearance"
  | "interface"
  | "about";

/**
 * The catalog rows' `label` values are the **pre-wiring zh-CN wording**, kept
 * as data rather than rendered text (r16-n2-2).
 *
 * Every surface that shows a section name — 设置's own left rail, the 常用
 * picker, the palette's deep links — renders `sectionTitle(t, s.id)` with `t`
 * from `useI18n()`, so the words on screen follow the language row through
 * `lib/i18n.ts`'s `settings.section.*` entries. These literals are what that
 * dictionary's zh table must equal byte for byte, and `tests/i18n.test.ts`
 * fails the gate on any drift: the copy here is the regression guard for the
 * default locale, not a second source the UI reads from.
 *
 * A `get label()` that resolved through the module-level `t` was tried for the
 * same reason it was removed from `VIEW_LABEL`: a getter is only as live as the
 * render that reads it, and every render here already subscribes via `useI18n`.
 * The ids are untouched — they are `data-section` anchors and jump targets,
 * i.e. machine names, and only the *words* are translatable.
 */
export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; icon: ReactNode }[] = [
  { id: "roots", label: "项目与目录", icon: <FolderTree className="h-3.5 w-3.5" /> },
  { id: "projects", label: "项目页", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
  { id: "network", label: "网络", icon: <Network className="h-3.5 w-3.5" /> },
  { id: "editors", label: "编辑器", icon: <Terminal className="h-3.5 w-3.5" /> },
  { id: "records", label: "记录", icon: <History className="h-3.5 w-3.5" /> },
  { id: "diagnostics", label: "故障与诊断", icon: <TriangleAlert className="h-3.5 w-3.5" /> },
  // r21-N1b-2：跨仓库依赖更新面板。放在诊断之后、Token 之前——它问的是
  // 「这些仓库的依赖现在怎么样」，与失败历史/Docker 同属「机器与仓库的现状」。
  { id: "deps", label: "依赖更新", icon: <PackageSearch className="h-3.5 w-3.5" /> },
  { id: "token", label: "GitHub Token", icon: <KeyRound className="h-3.5 w-3.5" /> },
  { id: "appearance", label: "外观", icon: <Palette className="h-3.5 w-3.5" /> },
  { id: "interface", label: "界面", icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
  { id: "about", label: "关于", icon: <Info className="h-3.5 w-3.5" /> },
];

export function isSettingsSectionId(id: string): id is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === id);
}

/**
 * The 常用 page's entry serialisation moved out of this file and into
 * `views/frequent/entries.ts` (r16-o2-3): this catalog is a `.tsx`, and Node's
 * type-stripping runner cannot parse JSX, so nothing that lived here could ever
 * be asserted by `pnpm test`. The names re-export unchanged so import sites —
 * this file's own consumers included — keep one path to them.
 */
export { entryId, parseEntry } from "./views/frequent/entries";
export type { FrequentEntry } from "./views/frequent/entries";

/**
 * The views the 常用 picker offers.
 *
 * 设置 is included as a view (it lands on the first catalog page) in addition to
 * each of its pages being pinnable on its own: the brief's example list was
 * "设置、外观、添加", and 外观 is reachable twice over - through this entry and as
 * its own catalog page (`settings:appearance`).
 *
 * The labels are the pre-wiring zh-CN wording, byte-identical to the `view.*`
 * entries in `lib/i18n.ts` — same arrangement as `SETTINGS_SECTIONS` above and
 * `VIEW_LABEL` in the store: components render `viewTitle(t, id)`, and the
 * literals here are what `tests/i18n.test.ts` pins the dictionary against.
 * (They were briefly live getters too; a render that does not subscribe to the
 * locale reads a getter no fresher than it reads a literal, so the getters went
 * with the ones in `store/ui.ts`.)
 */
export const PINNABLE_VIEWS: { id: string; label: string; icon: ReactNode }[] = [
  { id: "projects", label: "项目", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
  { id: "add", label: "添加", icon: <Plus className="h-3.5 w-3.5" /> },
  { id: "records", label: "记录", icon: <History className="h-3.5 w-3.5" /> },
  { id: "frequent", label: "常用", icon: <Sparkles className="h-3.5 w-3.5" /> },
  { id: "settings", label: "设置", icon: <Settings className="h-3.5 w-3.5" /> },
];
