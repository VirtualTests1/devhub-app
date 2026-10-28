/**
 * The bindable actions DevHub ships with (r20-N1).
 *
 * Kept in its own file, apart from the matcher in `shortcuts.ts`, because this table
 * is what the 快捷键 panel renders and what `src/shell/AppShell.tsx` dispatches —
 * two consumers that must not be able to drift. A new action added here appears in
 * the help panel and in the conflict check with no other edit; the shell only has to
 * know how to run it.
 *
 * `allowInField: false` is the conservative default. The three exceptions are the
 * chords that cannot be mistaken for typing (function keys and `?`), which is also
 * why `Ctrl+K` keeps working inside the 搜索项目 box — the box's own history wants it.
 */
import type { ShortcutAction } from "./shortcuts";

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: "palette", labelKey: "shortcut.palette", group: "layer", defaultChord: "Ctrl+K", allowInField: true },
  { id: "back", labelKey: "shortcut.back", group: "nav", defaultChord: "Alt+ArrowLeft", allowInField: false },
  { id: "forward", labelKey: "shortcut.forward", group: "nav", defaultChord: "Alt+ArrowRight", allowInField: false },
  { id: "view-projects", labelKey: "shortcut.viewProjects", group: "nav", defaultChord: "Alt+1", allowInField: true },
  { id: "view-add", labelKey: "shortcut.viewAdd", group: "nav", defaultChord: "Alt+2", allowInField: true },
  { id: "view-frequent", labelKey: "shortcut.viewFrequent", group: "nav", defaultChord: "Alt+3", allowInField: true },
  { id: "view-records", labelKey: "shortcut.viewRecords", group: "nav", defaultChord: "Alt+4", allowInField: true },
  { id: "view-settings", labelKey: "shortcut.viewSettings", group: "nav", defaultChord: "Alt+5", allowInField: true },
  { id: "help", labelKey: "shortcut.help", group: "help", defaultChord: "F1", allowInField: true },
];

/** Actions grouped the way the help panel lists them. */
export const SHORTCUT_GROUPS: readonly ("nav" | "layer" | "help")[] = ["nav", "layer", "help"];
