import { useEffect, useRef } from "react";

/**
 * 快捷键注册表（O4 N4: 全局快捷键框架）。
 *
 * 项目已有 Ctrl+K 打开命令面板，但没有独立的快捷键分发机制。
 * 这个模块提供一个轻量的全局 hook：组件注册自己关心的快捷键组合，
 * 这里统一监听 keydown、匹配并回调。
 *
 * 设计目标：
 *  - 零外部依赖（只用原生 KeyboardEvent）
 *  - 与 Ctrl+K 命令面板共存（命令面板用自己的 document listener）
 *  - 支持动态注册/卸载（返回 cleanup）
 *  - 组合键串用小写（e.g. "ctrl+1", "ctrl+comma", "alt+s"）
 *
 * 默认快捷键（在 App.tsx 调用 registerDefaults 一次性注册）：
 *  Ctrl+1  项目页     Ctrl+2  添加页     Ctrl+3  记录页
 *  Ctrl+4  常用页     Ctrl+5  设置页
 *  Ctrl+,  打开设置   Ctrl+/  聚焦搜索框
 *
 * 为什么不依赖 Mousetrap 或 react-hotkeys-hook：
 *  - 当前快捷键数量 < 10，一个 native listener 足够
 *  - 避免引入维护状态不明的第三方包（2024 年 hotkeys.js 仍活跃但 react-hotkeys-hook 有弃用风险）
 *  - 与现有 Ctrl+K 的 document listener 对齐，降低心智负担
 */

export type ShortcutHandler = (e: KeyboardEvent) => void;

const registry = new Map<string, Set<ShortcutHandler>>();

/** 字符串组合键 → 规范化 key（小写，+ 分隔）。 */
export function normalize(combo: string): string {
  return combo.toLowerCase().trim();
}

/** KeyboardEvent → 规范化组合键字符串（与 normalize 输入同格式）。 */
export function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl"); // 跨平台：Mac 的 Cmd 等价于 Ctrl
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  // 把 "Control"/"Meta"/"Alt"/"Shift" 这种修饰键本身过滤掉
  if (!["control", "meta", "alt", "shift"].includes(key)) {
    parts.push(key === "," ? "comma" : key === "/" ? "slash" : key);
  }
  return parts.join("+");
}

/** 注册一个组合键的处理器，返回 cleanup 函数。 */
export function registerShortcut(combo: string, handler: ShortcutHandler): () => void {
  const key = normalize(combo);
  const handlers = registry.get(key) ?? new Set<ShortcutHandler>();
  registry.set(key, handlers);
  handlers.add(handler);
  return () => {
    const set = registry.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) registry.delete(key);
  };
}

/** 一次性注册一批。 */
export function registerShortcuts(
  pairs: Array<[string, ShortcutHandler]>,
): () => void {
  const cleanups = pairs.map(([c, h]) => registerShortcut(c, h));
  return () => cleanups.forEach((fn) => fn());
}

/** React hook：组件挂载时注册，卸载时自动清理。 */
export function useShortcut(combo: string, handler: ShortcutHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    return registerShortcut(combo, (e) => handlerRef.current(e));
  }, [combo]);
}

/** React hook：组件挂载时批量注册，卸载时清理。 */
export function useShortcuts(
  pairs: Array<[string, ShortcutHandler]>,
): void {
  const refs = useRef(pairs);
  refs.current = pairs;
  useEffect(() => {
    return registerShortcuts(refs.current.map(([c, h]) => [c, (e: KeyboardEvent) => h(e)]));
  }, []);
}

// ---------------------------------------------------------------------------
// 全局 listener（在模块加载时注册一次，应用退出时随浏览器卸载）
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const combo = eventToCombo(e);
    const handlers = registry.get(combo);
    if (handlers && handlers.size > 0) {
      // 有处理器匹配 → 拦截默认行为（比如 Ctrl+/ 在浏览器里是打开快速查找，
      // 拦截掉以免触发浏览器的东西）
      e.preventDefault();
      handlers.forEach((h) => h(e));
    }
  });
}

// ---------------------------------------------------------------------------
// r20-N1: the chord engine that landed under this same filename.
//
// `master` already had a `src/lib/shortcuts.ts` when this branch merged — a React hook
// registry (`registerShortcut` / `useShortcut`, bound to Ctrl+1..5 and Ctrl+comma in
// `src/App.tsx`). Both halves stayed on purpose: theirs is the imperative subscription
// API components already call, ours is the pure parser / matcher / binding store the
// shell's key map and the 快捷键面板 are built on. Neither imports the other, and the
// shipped chords do not overlap (`Ctrl+…` there, `Alt+…` / `Ctrl+K` / `F1` here), so no
// keystroke is handled twice. Folding the two into one API is a follow-up decision, not
// something to do inside a merge resolution.
// ---------------------------------------------------------------------------

export type Chord = {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};

/** Anything a listener can give us — keeps the matcher usable with a hand-made
 * object in tests and with a real `KeyboardEvent` in the shell. */
export type KeyLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * One bindable action.
 *
 * `labelKey` is an i18n key rather than a string because the 快捷键 panel renders
 * both locales from this one table, and `src/**\/*.tsx` has a ratchet test that
 * fails on a new hardcoded Chinese UI literal.
 */
export type ShortcutAction = {
  id: string;
  labelKey: string;
  group: "nav" | "layer" | "help";
  defaultChord: string;
  /** False means the chord is ignored while the user is typing in a field —
   * the rule `AppShell.tsx` already applies to Alt+Arrow, written down once. */
  allowInField: boolean;
};

const MOD_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

const ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/** `Ctrl+Shift+K` → `Chord`. Returns null for anything unusable rather than throwing:
 * a corrupted binding in `localStorage` must not take the shell's keyboard down. */
export function parseChord(text: string): Chord | null {
  if (typeof text !== "string") return null;
  const parts = text
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const chord: Chord = { key: "", ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const alias = ALIASES[part.toLowerCase()];
    if (alias) {
      chord[alias] = true;
      continue;
    }
    if (chord.key !== "") return null; // two bare keys: `a+b` is not a chord we support
    chord.key = normaliseKey(part);
  }
  if (chord.key === "") return null;
  // An unmodified key is only allowed when it cannot be mistaken for typing: a
  // function key, an arrow, Escape, or the two punctuation chords the help panel
  // uses. `k` alone would fire on every keystroke in the 搜索项目 box.
  const bare = !chord.ctrl && !chord.alt && !chord.meta && !chord.shift;
  if (bare) {
    const allowed =
      /^f\d{1,2}$/.test(chord.key) ||
      ["arrowleft", "arrowright", "arrowup", "arrowdown", "escape", "?", "/"].includes(chord.key);
    if (!allowed) return null;
  }
  return chord;
}

function normaliseKey(raw: string): string {
  const k = raw.toLowerCase();
  if (k === "space") return " ";
  if (k.length === 1) return k;
  if (k === "esc") return "escape";
  if (k === "pgup") return "pageup";
  if (k === "pgdn" || k === "pgdown") return "pagedown";
  return k;
}

/** The canonical string form, modifiers in a fixed order. Two bindings that mean the
 * same thing must print the same thing, or the conflict list reads as noise. */
const MOD_LABEL: Record<(typeof MOD_ORDER)[number], string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  // Windows-only app: `meta` is the Windows key, and a help panel that printed
  // "Meta" would be read as a macOS leftover.
  meta: "Win",
};

/** Multi-character keys print in the form a person reads off a keycap, so a chord
 * stored as `Alt+ArrowLeft` round-trips to itself instead of drifting to
 * `Alt+arrowleft` and looking like a different binding in the conflict table. */
const KEY_LABEL: Record<string, string> = {
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  tab: "Tab",
  enter: "Enter",
  delete: "Delete",
  backspace: "Backspace",
};

export function formatChord(c: Chord): string {
  const mods = MOD_ORDER.filter((m) => c[m]).map((m) => MOD_LABEL[m]);
  const label =
    c.key === " "
      ? "Space"
      : KEY_LABEL[c.key] ?? (/^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return [...mods, label].join("+");
}

/** Read a real (or test-made) event as a chord. */
export function chordFromEvent(e: KeyLike): Chord {
  return {
    key: normaliseKey(e.key),
    ctrl: !!e.ctrlKey,
    alt: !!e.altKey,
    shift: !!e.shiftKey,
    meta: !!e.metaKey,
  };
}

/**
 * Does this event hit this chord?
 *
 * Shift is compared only when the chord itself asks for it *or* when the key is a
 * punctuation mark whose glyph depends on shift (`?` is `Shift+/`). A chord written
 * `Ctrl+K` still matches `Ctrl+Shift+K`, because Windows layouts produce both and
 * the user did not ask for the distinction.
 */
export function matchesChord(chordText: string, e: KeyLike): boolean {
  const want = parseChord(chordText);
  if (!want) return false;
  const got = chordFromEvent(e);
  if (want.key !== got.key) return false;
  if (want.ctrl !== got.ctrl) return false;
  if (want.alt !== got.alt) return false;
  if (want.meta !== got.meta) return false;
  // Shift is one-directional: a chord written without it matches with or without
  // (Windows layouts emit both `k` and `K` for one press, and `?` is literally
  // Shift+/), while a chord that *asks* for shift is not satisfied without it. That
  // asymmetry is what lets `Ctrl+Shift+K` and `Ctrl+K` coexist and still be resolved
  // by specificity in `matchAction`.
  return !want.shift || got.shift;
}

/** `actionId → chord`, defaults filled in for anything the user never touched. */
export function resolveBindings(
  actions: readonly ShortcutAction[],
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of actions) {
    const own = overrides[a.id];
    const chosen = own !== undefined && parseChord(own) ? own : a.defaultChord;
    // Canonicalised on the way out: the dispatcher, the conflict table and the help
    // panel all read this map, and they must be looking at the same spelling.
    const parsed = parseChord(chosen);
    out[a.id] = parsed ? formatChord(parsed) : a.defaultChord;
  }
  return out;
}

/**
 * Chords claimed by more than one action, keyed by the canonical chord.
 *
 * Unresolved conflicts are why ad-hoc key handlers rot: the second binding silently
 * wins depending on listener order, and nobody can see it. The 快捷键 panel shows
 * this list so a bad user edit is visible instead of mysterious.
 */
export function findConflicts(bindings: Record<string, string>): Record<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const [actionId, chordText] of Object.entries(bindings)) {
    const parsed = parseChord(chordText);
    if (!parsed) continue;
    const key = formatChord(parsed);
    const list = byChord.get(key) ?? [];
    list.push(actionId);
    byChord.set(key, list);
  }
  const conflicts: Record<string, string[]> = {};
  for (const [chord, ids] of byChord) if (ids.length > 1) conflicts[chord] = ids;
  return conflicts;
}

/**
 * Which action (if any) this event selects.
 *
 * Two bindings can match one event even when their chords print differently —
 * `Ctrl+K` and `Ctrl+Shift+K` both match under the shift rule above — so the winner
 * is the *most specific* chord (the one carrying more modifiers), and a tie is broken
 * by action order. Deterministic, so a rebinding cannot shuffle the app's behaviour.
 */
export function matchAction(
  actions: readonly ShortcutAction[],
  bindings: Record<string, string>,
  e: KeyLike,
  inField: boolean,
): string | null {
  type Hit = { id: string; specificity: number; order: number };
  const hits: Hit[] = [];
  actions.forEach((a, order) => {
    if (inField && !a.allowInField) return;
    const chordText = bindings[a.id];
    if (!chordText) return;
    if (!matchesChord(chordText, e)) return;
    const parsed = parseChord(chordText);
    const specificity = parsed
      ? Number(parsed.ctrl) + Number(parsed.alt) + Number(parsed.meta) + Number(parsed.shift)
      : 0;
    hits.push({ id: a.id, specificity, order });
  });
  hits.sort((x, y) => y.specificity - x.specificity || x.order - y.order);
  // noUncheckedIndexedAccess（r19-o2）：头名一定在（空表上面已返回 null），但索引
  // 类型不说这件事——显式取一次，语义与从前的 length 检查等价。
  const best = hits[0];
  if (!best) return null;
  return best.id;
}

/** True when the event arrived while a text field had focus — the same test the
 * existing shell handler did by hand, in one place.
 *
 * `unknown` rather than `EventTarget`: the properties that decide the answer
 * (`tagName`, `isContentEditable`) are on `Element`, not on `EventTarget`, and a
 * signature typed `EventTarget` would force every caller to cast while the test
 * could not pass a plain object at all. Reading them structurally keeps the function
 * total — anything that is not a tagged element simply returns false.
 */
export function isTextField(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}
