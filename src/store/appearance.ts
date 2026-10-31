import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { scheduleStorageRemove, scheduleStorageWrite } from "../lib/storage";
import { persistJson } from "../lib/persist";
import { SKINS, type SkinId } from "./ui";

/**
 * Appearance preferences.
 *
 * These are pure frontend concerns (typography, theme, which chrome is shown),
 * so they deliberately live in localStorage rather than the Rust config file:
 * nothing here needs the filesystem, and keeping them out of `AppConfig` means
 * the backend schema does not grow every time a display toggle is added.
 *
 * Round 6 (本轮) adds three Word-style typography controls and the template
 * API:
 *
 *   - `fontFamily`  — any installed system family (the picker enumerates them
 *     through the backend when available; empty string = 系统默认 stack).
 *   - `uiFontPx`    — the precise root font size (12–22). The 字号 档位 are
 *     just presets that write this value; the px number is authoritative.
 *   - `fontWeight`  — base text weight applied through `--app-font-weight`.
 *   - `saveTemplate` / `applyMany` — named snapshots of the whole appearance,
 *     stored in their own localStorage key so they can be exported/imported.
 */

export type FontScale = "sm" | "md" | "lg" | "xl";
/** `system` follows Windows' own 深色/浅色 setting and updates live. */
export type ThemeId = "dark" | "light" | "system";
export type ScaleDensity = "compact" | "normal" | "relaxed";
/** 尺度：文字与控件的体量。与 密度（只改留白）是两条轴，见 index.css 的 [data-scale]。 */
export type TypeScale = "compact" | "relaxed";
/** 氛围层：无 / 静态纹理 / 静态+缓慢动效。见 index.css 的「氛围层」段。 */
export type Ambience = "none" | "static" | "dynamic";
export type FontWeightChoice = "normal" | "medium" | "bold";

const STORAGE_KEY = "devhub.appearance.v1";
export const TEMPLATES_KEY = "devhub.appearance.templates.v1";

export const FONT_SCALES: { id: FontScale; label: string; rootPx: number }[] = [
  { id: "sm", label: "小", rootPx: 14 },
  { id: "md", label: "标准", rootPx: 16 },
  { id: "lg", label: "大", rootPx: 18 },
  { id: "xl", label: "特大", rootPx: 20 },
];

/** Fallback list used when the backend font enumeration is unavailable. */
export const FALLBACK_FAMILIES = [
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
  "DengXian",
  "Cascadia Mono",
  "Consolas",
  "Segoe UI",
  "Arial",
  "Times New Roman",
];

export const FAMILY_DISPLAY: Record<string, string> = {
  "Microsoft YaHei": "微软雅黑",
  "Microsoft YaHei UI": "微软雅黑 UI",
  SimSun: "宋体",
  NSimSun: "新宋体",
  SimHei: "黑体",
  KaiTi: "楷体",
  FangSong: "仿宋",
  DengXian: "等线",
  "DengXian Light": "等线 Light",
  STKaiti: "华文楷体",
  STFangsong: "华文仿宋",
  STSong: "华文宋体",
  STZhongsong: "华文中宋",
  STXihei: "华文细黑",
  STLiti: "华文隶书",
  STXingkai: "华文行楷",
  STXinwei: "华文新魏",
  MingLiU: "細明體",
  PMingLiU: "新細明體",
  "Microsoft JhengHei": "微軟正黑體",
};

export function familyDisplay(family: string): string {
  return FAMILY_DISPLAY[family] ?? family;
}

/** The stack everything falls back to when no family is chosen. */
export const DEFAULT_FONT_STACK =
  'Inter, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

export const WEIGHT_CHOICES: { id: FontWeightChoice; label: string; value: number }[] = [
  { id: "normal", label: "标准", value: 400 },
  { id: "medium", label: "适中", value: 500 },
  { id: "bold", label: "加粗", value: 600 },
];

export const AMBIENCES: { id: Ambience; label: string; note: string }[] = [
  { id: "none", label: "关闭", note: "纯色底，无任何纹理" },
  { id: "static", label: "静态", note: "细网格与标题短线，不随时间变化" },
  { id: "dynamic", label: "动态", note: "静态之上加缓慢漂移与卡片入场扫光" },
];

export const TYPE_SCALES: { id: TypeScale; label: string; note: string }[] = [
  { id: "relaxed", label: "舒展", note: "正文 14px、页面标题 17px，另有展示级字号" },
  { id: "compact", label: "紧凑", note: "正文 13px、页面标题 15px，接近旧版体量" },
];

export const SCALE_DENSITIES: { id: ScaleDensity; label: string }[] = [
  { id: "compact", label: "紧凑" },
  { id: "normal", label: "标准" },
  { id: "relaxed", label: "宽松" },
];

export type Appearance = {
  fontScale: FontScale;
  /** Precise UI font size in px (12–22). The 档位 are presets for this. */
  uiFontPx: number;
  fontWeight: FontWeightChoice;
  /** 尺度档位。`relaxed` is the default: the brief was 观感小气, not 字太小. */
  scale: TypeScale;
  /** 氛围层档位。`static` by default: pages stop being flat without anyone having to opt in. */
  ambience: Ambience;
  theme: ThemeId;
  skin: SkinId;
  /** CSS family name; empty string = 系统默认. */
  fontFamily: string;
  density: ScaleDensity;
  hideDesc: boolean;
  /** Which chrome blocks are shown. All on by default. */
  showBrand: boolean;
  showRefresh: boolean;
  showVersion: boolean;
  showStatusStrip: boolean;
  showSearchBlock: boolean;
  /**
   * Whether repository cover images are fetched and shown.
   *
   * Off also means off on the network: `RepoTile` skips the `fetch_cover` call
   * entirely, so a wall of twenty repositories stops issuing twenty requests
   * when the app starts.
   */
  covers: boolean;
  /** Zeroes view transitions, cover fades and card hover lift. */
  reduceMotion: boolean;
  /**
   * Columns on the project wall. `0` means "as many as fit", which is the
   * previous behaviour; 2-6 forces a count.
   */
  gridColumns: number;
  /** Keep the launch output panel pinned to its newest line. */
  autoScrollOutput: boolean;
  /** Show each repository's full on-disk path on its card. */
  showRepoPath: boolean;
  /**
   * How 记录 prints a timestamp. Display-only: the stored `ts` is always the
   * same epoch second, so changing this never rewrites history.
   */
  recordTimeFormat: RecordTimeFormat;
  /**
   * Whether a scrollbar is painted at all.
   *
   * Off keeps the gutter (the layout must not shift when a page becomes
   * scrollable — that shift was reported as a bug in its own right) and hides
   * the thumb until hover, which is what "右侧的滚动条默认不需要" asks for while
   * leaving the wheel and keyboard working.
   */
  showScrollbar: boolean;
};

export type RecordTimeFormat = "hms" | "hm" | "relative" | "full";

const DEFAULTS: Appearance = {
  fontScale: "md",
  uiFontPx: 16,
  fontWeight: "normal",
  scale: "relaxed",
  ambience: "static",
  // 白（主）是这一轮的默认基调：浅色优先，深色仍是一档之隔。Stored preferences
  // win over this (load() merges onto DEFAULTS), so only fresh installs and
  // 恢复默认 land on light.
  theme: "light",
  skin: "soft",
  fontFamily: "",
  density: "normal",
  hideDesc: false,
  showBrand: true,
  showRefresh: true,
  showVersion: true,
  showStatusStrip: true,
  showSearchBlock: true,
  covers: true,
  reduceMotion: false,
  gridColumns: 0,
  autoScrollOutput: true,
  showRepoPath: false,
  recordTimeFormat: "hms",
  showScrollbar: false,
};

/** The keys a template snapshots, in a stable order. */
export const TEMPLATE_KEYS = Object.keys(DEFAULTS) as (keyof Appearance)[];

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf =
  <T extends string>(...allow: T[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && (allow as string[]).includes(v);
/** 界面上限与 load() 对 uiFontPx 的复核同口径（12–22）。 */
const intBetween = (min: number, max: number) => (v: unknown): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * One validator per appearance field, keyed exactly like `TEMPLATE_KEYS`.
 *
 * Round 13 (d4-3): this table used to live in `views/records/undo.ts` as
 * `APPEARANCE_UNDO_CHECKS`, which validated the *undo* path only. `load()`
 * meanwhile merged a `JSON.parse`d blob onto DEFAULTS checking just `uiFontPx`,
 * and `copyAppearanceValue` (template import / export restore) checked nothing —
 * so a hand-edited or imported `{"theme":"blue"}` / `{"gridColumns":99}` landed
 * in the store and in `applyAppearance`'s data attributes. Every other persisted
 * store in this repo (`wall.ts`, `customize.ts`, `searches.ts`) validates
 * per-field; appearance was the only one that did not. The table now lives with
 * the type it validates, and `views/records/undo.ts` re-exports it under its old
 * name so the 记录 page keeps one import site.
 *
 * The ranges mirror what the UI offers, not what CSS would tolerate: `gridColumns`
 * 0–6 because `applyAppearance` only consumes that interval (0 = 自动).
 */
export const APPEARANCE_VALUE_CHECKS: { [K in keyof Appearance]-?: (v: unknown) => boolean } = {
  fontScale: oneOf("sm", "md", "lg", "xl"),
  uiFontPx: intBetween(12, 22),
  fontWeight: oneOf("normal", "medium", "bold"),
  scale: oneOf("compact", "relaxed"),
  ambience: oneOf("none", "static", "dynamic"),
  theme: oneOf("dark", "light", "system"),
  skin: oneOf("soft", "crisp", "bold"),
  fontFamily: isStr,
  density: oneOf("compact", "normal", "relaxed"),
  hideDesc: isBool,
  showBrand: isBool,
  showRefresh: isBool,
  showVersion: isBool,
  showStatusStrip: isBool,
  showSearchBlock: isBool,
  covers: isBool,
  reduceMotion: isBool,
  gridColumns: intBetween(0, 6),
  autoScrollOutput: isBool,
  showRepoPath: isBool,
  recordTimeFormat: oneOf("hms", "hm", "relative", "full"),
  showScrollbar: isBool,
};

/**
 * Copies one known appearance key without going through `any`.
 *
 * `TEMPLATE_KEYS` is `Object.keys(DEFAULTS)`, so `key` is a `keyof Appearance`
 * *union*, and TypeScript cannot pair `source[key]`'s type with the target
 * property's for a union index — which is exactly why both call sites used to say
 * `(target as any)[key] = (source as any)[key]`. Those casts silenced the index
 * complaint and, along with it, any checking of what gets stored. The computed-key
 * `Object.assign` below performs the same write and still type-checks.
 *
 * `undefined` is skipped rather than copied: a blob carrying `{"theme": undefined}`
 * used to overwrite a good default with nothing, and then persist that.
 *
 * Round 13 (d4-3): a value that fails its field's validator is skipped too —
 * the target keeps whatever it already had (the default on a fresh load). This
 * one gate covers template import, export restore and the settings-page copy
 * path, all of which funnel through here.
 */
function copyAppearanceValue(
  target: Partial<Appearance>,
  source: Record<string, unknown>,
  key: keyof Appearance,
): void {
  const value = source[key];
  if (value === undefined) return;
  const check = APPEARANCE_VALUE_CHECKS[key];
  if (check && !check(value)) return;
  Object.assign(target, { [key]: value });
}

/**
 * A stored blob → a validated `Appearance`, in one pure function.
 *
 * Extracted from `load()` in round 13 (d4-3) so the merge-and-validate contract
 * can be tested without a `localStorage`: Node has none, and the previous shape
 * (validation inline in a module-init side effect) meant the only way to
 * exercise it was the browser. `raw` is whatever `getItem` returned — `null`,
 * unparseable text, or a JSON value of the wrong shape all degrade to defaults
 * rather than throwing, because a corrupt preference must not cost the user
 * their whole appearance.
 */
export function coerceAppearance(raw: string | null): Appearance {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }
  const merged = { ...DEFAULTS, ...(parsed as Record<string, unknown>) } as Appearance & {
    font?: string;
  };
  // Migration: the old `font` enum becomes the free-form `fontFamily`.
  if (merged.font !== undefined) {
    if (!merged.fontFamily) {
      merged.fontFamily = LEGACY_FONT[merged.font] ?? "";
    }
    delete merged.font;
  }
  // Every field, not just `uiFontPx`: an out-of-range or wrong-typed value falls
  // back to the default for that field, which is also what the pickers show.
  // One field keeps its older, scale-aware fallback: a corrupt px under a valid
  // 档位 reads as that 档位's preset, not as the global default — otherwise
  // fontScale "sm" would silently jump to md's 16 px. `fontScale` is the first
  // key of DEFAULTS, so it is already valid by the time `uiFontPx` is reached.
  for (const k of TEMPLATE_KEYS) {
    const check = APPEARANCE_VALUE_CHECKS[k];
    if (!check || check(merged[k])) continue;
    Object.assign(merged, {
      [k]:
        k === "uiFontPx"
          ? (FONT_SCALES.find((s) => s.id === merged.fontScale)?.rootPx ?? DEFAULTS.uiFontPx)
          : DEFAULTS[k],
    });
  }
  return merged;
}

/** Legacy `font` ids → CSS families (the pre-round-6 picker had 5 presets). */
const LEGACY_FONT: Record<string, string> = {
  default: "",
  yahei: "Microsoft YaHei",
  simhei: "SimHei",
  kaiti: "KaiTi",
  monospace: "Cascadia Mono",
};

function load(): Appearance {
  try {
    // Round 13 (d4-3): the merge-and-validate contract is `coerceAppearance`,
    // a pure function with tests; `load()` is only the storage read around it.
    return coerceAppearance(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Coalesced 外观 records — the same shape as the storage coalescing in
 * `lib/storage.ts`, applied to the activity log.
 *
 * `set` already writes `localStorage` through the scheduler, so dragging 界面字号
 * costs one stringify per gesture. What it did *not* coalesce was the record: every
 * `set` called `recordChange`, and a slider or a held 步进按钮 fires one `set` per
 * pixel — dozens of `log_activity` round trips and dozens of near-identical rows in
 * 记录 for one intention ("make the text bigger"). One gesture, one row.
 *
 * The rules are the storage rules, plus one that only matters for a record:
 *   - trailing flush per burst (`CHANGE_COALESCE_MS`), last value wins for 后值;
 *   - the FIRST `before` of the burst wins, so 回退 restores the pre-gesture value
 *     instead of stepping back one notch of the slider;
 *   - a burst that ends on the value it started on emits nothing — dragging to 22
 *     and back to 16 is not a change 记录 should claim happened.
 *
 * Injectable clock/emit so this is testable without a webview or a backend, the way
 * `lib/poll-loop.ts` is.
 */
export type AppearanceChangeRow = {
  key: keyof Appearance;
  before: unknown;
  after: unknown;
};

export type ChangeRecorder = {
  push: (key: keyof Appearance, before: unknown, after: unknown) => void;
  flush: () => void;
};

const CHANGE_COALESCE_MS = 250;

export function createChangeRecorder(
  emit: (row: AppearanceChangeRow) => void,
  opts: {
    coalesceMs?: number;
    schedule?: (cb: () => void, ms: number) => number;
    unschedule?: (handle: number) => void;
  } = {},
): ChangeRecorder {
  const coalesceMs = opts.coalesceMs ?? CHANGE_COALESCE_MS;
  const schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const unschedule = opts.unschedule ?? ((handle) => clearTimeout(handle));
  const pending = new Map<keyof Appearance, { before: unknown; after: unknown }>();
  // ReturnType 而不是 `number`：测试注入 Node 的 setTimeout（句柄是 Timeout
  // 对象），浏览器里是 number——让句柄类型跟随注入的 schedule 签名。
  type TimerHandle = ReturnType<typeof schedule>;
  let timer: TimerHandle | null = null;

  const flush = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const burst = [...pending.entries()];
    pending.clear();
    for (const [key, c] of burst) {
      if (c.before === c.after) continue;
      emit({ key, before: c.before, after: c.after });
    }
  };

  return {
    push: (key, before, after) => {
      const open = pending.get(key);
      pending.set(key, { before: open ? open.before : before, after });
      if (timer === null) timer = schedule(flush, coalesceMs);    },
    flush,
  };
}

type AppearanceState = Appearance & {
  set: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void;
  reset: () => void;
  /** Applies a template in one step, writing ONE revertible record. */
  applyMany: (values: Partial<Appearance>, label: string) => void;
  /** Restores a whole previous appearance blob (回退 of 恢复默认/应用模版). */
  restoreBlob: (json: string) => void;
};

export const useAppearance = create<AppearanceState>((set) => ({
  ...load(),
  set: (key, value) =>
    set((s) => {
      const next = { ...s, [key]: value };
      // Coalesced in lib/storage: this used to write synchronously on every
      // keystroke of the 界面字号 field and every font search. Same JSON, later.
      scheduleStorageWrite(STORAGE_KEY, JSON.stringify(next));
      // Every appearance change is a record, because the report was that
      // 记录 only covered downloads and settings — an 外观 change left no
      // trace at all. The backend cannot see these writes (they are webview
      // state), so the row is pushed to it, carrying the previous value so
      // the record can be reverted.
      //
      // Pushed, not awaited: the coalescer in `createChangeRecorder` turns a
      // drag of 界面字号 (one `set` per pixel, and one `log_activity` round trip
      // per row) into the single row the gesture actually is.
      if (s[key] !== value) {
        changeRecorder.push(key, s[key], value);
      }
      return next;
    }),
  reset: () =>
    set((s) => {
      // A whole-blob action writes after the single-field rows that came before
      // it, so those have to land first — otherwise 记录 reads the 恢复默认 as
      // happening before the slider move that led up to it.
      changeRecorder.flush();
      const changed = (Object.keys(DEFAULTS) as (keyof Appearance)[]).filter(
        (k) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k]),
      );
      const prevJson = JSON.stringify(stripActions(s));
      // Via the scheduler too: a direct removeItem would be clobbered by a
      // keystroke write still sitting in the coalescing window.
      scheduleStorageRemove(STORAGE_KEY);
      // 恢复默认 used to leave no trace (需求 6). One record, listing what
      // changed, revertible as a whole: the undo carries the previous blob.
      if (changed.length > 0) {
        void recordReset(changed, prevJson);
      }
      return { ...DEFAULTS };
    }),
  applyMany: (values, label) =>
    set((s) => {
      changeRecorder.flush();
      const prevJson = JSON.stringify(stripActions(s));
      const next = { ...s, ...values };
      const changed = (Object.keys(values) as (keyof Appearance)[]).filter(
        (k) => JSON.stringify(s[k]) !== JSON.stringify(values[k]),
      );
      scheduleStorageWrite(STORAGE_KEY, JSON.stringify(next));
      if (changed.length > 0) {
        void recordApply(label, changed, prevJson);
      }
      return next;
    }),
  restoreBlob: (json) =>
    set(() => {
      changeRecorder.flush();
      try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object") return load();
        // JSON 的静态类型只能收到这一层；再往下每个字段都由 `load()` 的那套逐字段
        // 校验兜住，这里只负责「只搬认识的键」。
        const src = parsed as Record<string, unknown>;
        const restored = { ...DEFAULTS };
        for (const k of TEMPLATE_KEYS) {
          if (k in src) copyAppearanceValue(restored, src, k);
        }
        // Scheduler, like every other STORAGE_KEY write — a direct setItem here
        // could be clobbered by a coalesced keystroke write still in flight.
        scheduleStorageWrite(STORAGE_KEY, JSON.stringify(restored));
        return restored;
      } catch {
        return load();
      }
    }),
}));

/** The state minus the three store actions, i.e. what gets snapshotted. */
function stripActions(s: AppearanceState): Appearance {
  const { set: _s, reset: _r, applyMany: _a, restoreBlob: _b, ...rest } = s;
  return rest;
}

/** Chinese labels for the appearance keys, so a record reads as a sentence. */
export const APPEARANCE_LABEL: Record<keyof Appearance, string> = {
  fontScale: "字号档位",
  uiFontPx: "界面字号",
  fontWeight: "界面字重",
  scale: "界面尺度",
  ambience: "氛围层",
  theme: "深浅色",
  skin: "外观风格",
  fontFamily: "字体",
  density: "布局密度",
  hideDesc: "描述性文字",
  showBrand: "左上角软件名称",
  showRefresh: "侧边栏刷新按钮",
  showVersion: "版本号",
  showStatusStrip: "底部状态栏",
  showSearchBlock: "添加页搜索区块",
  covers: "项目封面图",
  reduceMotion: "减弱动画",
  gridColumns: "项目墙列数",
  autoScrollOutput: "启动输出自动滚动",
  showRepoPath: "卡片显示完整路径",
  recordTimeFormat: "记录时间格式",
  showScrollbar: "显示滚动条",
};

const VALUE_LABELS: Partial<Record<keyof Appearance, Record<string, string>>> = {
  fontScale: { sm: "小", md: "标准", lg: "大", xl: "特大" },
  theme: { dark: "深色", light: "浅色", system: "跟随系统" },
  density: { compact: "紧凑", normal: "标准", relaxed: "宽松" },
  scale: { compact: "紧凑", relaxed: "舒展" },
  ambience: { none: "关闭", static: "静态", dynamic: "动态" },
  fontWeight: { normal: "标准", medium: "适中", bold: "加粗" },
  gridColumns: {
    "0": "自动",
    "2": "2 列",
    "3": "3 列",
    "4": "4 列",
    "5": "5 列",
    "6": "6 列",
  },
  recordTimeFormat: {
    hms: "时分秒",
    hm: "时分",
    relative: "相对时间",
    full: "完整日期",
  },
  skin: Object.fromEntries(SKINS.map((s) => [s.id, s.label])),
};

/**
 * A record-readable value for one appearance key. 记录 shows this instead of
 * the raw enum ids ("md"/"compact"), which was the 需求 6 complaint.
 */
export function describeAppearanceValue(key: keyof Appearance, v: unknown): string {
  if (typeof v === "boolean") return v ? "开" : "关";
  if (key === "fontFamily") {
    const f = String(v ?? "");
    return f === "" ? "系统默认" : `${familyDisplay(f)}（${f}）`;
  }
  if (key === "uiFontPx") return `${v} px`;
  const m = VALUE_LABELS[key];
  if (m) return m[String(v)] ?? String(v);
  if (v === undefined || v === null) return "（无）";
  return String(v);
}

/**
 * Writes one 外观 record.
 *
 * Fire-and-forget on purpose: losing a history line must never make the switch
 * the user just clicked appear to have failed, which is the same reasoning the
 * activity log itself uses on the Rust side.
 */
async function recordChange(key: keyof Appearance, before: unknown, after: unknown) {
  try {
    await invoke("log_activity", {
      tag: "appearance",
      action: `修改${APPEARANCE_LABEL[key] ?? String(key)}`,
      // Left empty on purpose: 记录 renders 前值 → 后值 from `before`/`after`, and
      // putting the same sentence in `detail` too printed it twice on one row.
      detail: "",
      target: `ui.${key}`,
      before: describeAppearanceValue(key, before),
      after: describeAppearanceValue(key, after),
      slug: "",
      source: "外观",
      undoKey: `ui.appearance.${key}`,
      undoValue: JSON.stringify(before),
    });
  } catch {
    /* the log is unavailable; the setting still changed */
  }
}

/**
 * The store's own recorder: one per module, one row per gesture.
 *
 * Created here rather than at the top of the file so the function it defers to is
 * already in scope; `set` only calls `push` after module evaluation, so the order
 * costs nothing.
 */
const changeRecorder = createChangeRecorder((row) => {
  void recordChange(row.key, row.before, row.after);
});

// Quit safety, same shape as `lib/storage.ts`: a burst whose trailing flush has not
// run yet would otherwise lose its row. Guarded because the Node test runner imports
// this module and there is no `window` there.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", changeRecorder.flush);
  window.addEventListener("pagehide", changeRecorder.flush);
}

async function recordReset(changed: (keyof Appearance)[], prevJson: string) {
  try {
    await invoke("log_activity", {
      tag: "appearance",
      action: "恢复默认外观",
      detail: `改动项：${changed.map((k) => APPEARANCE_LABEL[k] ?? k).join("、")}`,
      target: "ui.appearance",
      before: `${changed.length} 项自定义`,
      after: "默认值",
      slug: "",
      source: "外观",
      undoKey: "ui.appearance.blob",
      undoValue: prevJson,
    });
  } catch {
    /* the log is unavailable; the reset still happened */
  }
}

async function recordApply(
  label: string,
  changed: (keyof Appearance)[],
  prevJson: string,
) {
  try {
    await invoke("log_activity", {
      tag: "appearance",
      action: `应用外观模版「${label}」`,
      detail: `改动项：${changed.map((k) => APPEARANCE_LABEL[k] ?? k).join("、")}`,
      target: "ui.appearance",
      before: "当前外观",
      after: `模版「${label}」`,
      slug: "",
      source: "外观",
      undoKey: "ui.appearance.blob",
      undoValue: prevJson,
    });
  } catch {
    /* the log is unavailable; the template still applied */
  }
}

/**
 * Applies every preference to the document.
 *
 * - uiFontPx: root font-size (the precise value; 档位 are presets for it).
 * - 主题: `data-theme` on the root; the light palette in index.css overrides
 *   the dark surfaces.
 * - fontFamily: prepended to `--font-sans`; empty = the default stack.
 * - fontWeight: `--app-font-weight`, consumed by the base text styles.
 * - 密度 / 隐藏描述: `data-density` / `data-hide-desc`, consumed by CSS.
 *
 * Called once on mount and after every change.
 */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.style.fontSize = `${a.uiFontPx}px`;
  root.dataset.theme = resolveTheme(a.theme);
  root.dataset.skin = a.skin;
  root.dataset.density = a.density;
  root.dataset.scale = a.scale;
  root.dataset.ambience = a.ambience;
  root.dataset.hideDesc = a.hideDesc ? "true" : "false";
  root.dataset.covers = a.covers ? "on" : "off";
  root.dataset.motion = a.reduceMotion ? "reduced" : "full";
  root.dataset.gridCols = a.gridColumns >= 2 && a.gridColumns <= 6 ? String(a.gridColumns) : "auto";
  root.dataset.repoPath = a.showRepoPath ? "on" : "off";
  root.dataset.scrollbar = a.showScrollbar ? "on" : "off";
  root.dataset.recordsTime = a.recordTimeFormat;
  // noUncheckedIndexedAccess：`WEIGHT_CHOICES[0]` 理论上可能缺席；`??` 兜底
  // 指向字面默认（400=Regular）而不是 undefined。
  const weight = WEIGHT_CHOICES.find((w) => w.id === a.fontWeight) ?? WEIGHT_CHOICES[0] ?? { value: 400 };
  root.style.setProperty("--app-font-weight", String(weight.value));
  const fontStack = a.fontFamily
    ? `"${a.fontFamily}", ${DEFAULT_FONT_STACK}`
    : DEFAULT_FONT_STACK;
  root.style.setProperty("--font-sans", fontStack);
}

/** `system` → whatever the OS currently asks for. */
export function resolveTheme(theme: ThemeId): "dark" | "light" {
  if (theme !== "system") return theme;
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  return mq?.matches ? "light" : "dark";
}

/**
 * Watches the OS setting and re-applies when it flips.
 *
 * Only `system` needs the listener; a manually chosen theme must not be
 * overridden by the OS, which is why the callback is registered once here and
 * simply re-applies the stored preference (which resolves to whatever it is).
 */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!mq) return () => {};
  const handler = () => {
    if (useAppearance.getState().theme === "system") cb();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

// ---------------------------------------------------------------------------
// Templates (需求 7): named snapshots of the whole appearance.

export type AppearanceTemplate = {
  id: string;
  name: string;
  createdAt: string;
  values: Partial<Appearance>;
};

export function loadTemplates(): AppearanceTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    const list = raw ? (JSON.parse(raw) as AppearanceTemplate[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** What a template mutation actually did to disk. */
export type TemplateMutation = {
  templates: AppearanceTemplate[];
  /** False when the in-memory list is the only copy (quota/private mode). */
  persisted: boolean;
};

function persistTemplates(list: AppearanceTemplate[]): boolean {
  return persistJson(TEMPLATES_KEY, list).ok;
}

function makeId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Picks only the known appearance keys out of an arbitrary object. */
export function sanitizeTemplateValues(input: unknown): Partial<Appearance> {
  const out: Partial<Appearance> = {};
  if (!input || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  for (const k of TEMPLATE_KEYS) {
    if (k in src) copyAppearanceValue(out, src, k);
  }
  return out;
}

export function saveTemplate(name: string, values: Appearance): TemplateMutation {
  const tpl: AppearanceTemplate = {
    id: makeId(),
    name: name.trim() || "未命名模版",
    createdAt: new Date().toISOString(),
    values: sanitizeTemplateValues(values),
  };
  const list = [...loadTemplates(), tpl];
  return { templates: list, persisted: persistTemplates(list) };
}

export function renameTemplate(id: string, name: string): TemplateMutation {
  const list = loadTemplates().map((t) =>
    t.id === id ? { ...t, name: name.trim() || t.name } : t,
  );
  return { templates: list, persisted: persistTemplates(list) };
}

export function deleteTemplate(id: string): TemplateMutation {
  const list = loadTemplates().filter((t) => t.id !== id);
  return { templates: list, persisted: persistTemplates(list) };
}

/**
 * E1/E2 — template import/export roundtrip.
 *
 * Exports a template to a portable JSON blob, then re-imports it through the
 * same sanitiser the live app uses. The roundtrip is byte-identical when the
 * input is already a well-formed template; malformed input (extra keys,
 * wrong types) is sanitised on the way back in, which is the documented
 * behaviour of `sanitizeTemplateValues` and not a defect here.
 *
 * The blob is a plain JSON string, not a Tauri dialog: it can be copy-pasted
 * into the app's import box, saved to a file by the caller, or piped between
 * two machines. The format is `{ template: AppearanceTemplate }` so a
 * future schema change (v2) can carry a `schema` field without breaking v1
 * readers.
 */
export interface TemplateBlob {
  /** v1. A v2 reader must ignore unknown fields. */
  schema: 1;
  template: AppearanceTemplate;
}

/** Serialises a template to a portable JSON blob. */
export function exportTemplateBlob(tpl: AppearanceTemplate): string {
  const blob: TemplateBlob = { schema: 1, template: tpl };
  return JSON.stringify(blob);
}

/**
 * Parses a blob produced by `exportTemplateBlob`.
 *
 * Returns the sanitised template, or `null` when the input is not a valid
 * v1 blob. The sanitiser picks only known appearance keys, so a blob that
 * carries a v2-only field is still readable: the unknown key is dropped,
 * the known keys survive.
 */
export function importTemplateBlob(raw: string): AppearanceTemplate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const blob = parsed as Partial<TemplateBlob>;
  if (blob.schema !== 1) return null;
  if (!blob.template || typeof blob.template !== "object") return null;
  const t = blob.template;
  if (typeof t.id !== "string" || typeof t.name !== "string") return null;
  const values = sanitizeTemplateValues(t.values ?? {});
  return {
    id: t.id,
    name: t.name,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString(),
    values,
  };
}

/**
 * The full roundtrip: export → string → import → values.
 *
 * Returns `true` when the round-tripped values are deep-equal to the
 * original (sanitised) values. This is the property the import/export
 * UI relies on: "what you exported is what you get back".
 */
export function templateRoundtrip(tpl: AppearanceTemplate): boolean {
  const blob = exportTemplateBlob(tpl);
  const back = importTemplateBlob(blob);
  if (!back) return false;
  return JSON.stringify(sanitizeTemplateValues(back.values)) === JSON.stringify(sanitizeTemplateValues(tpl.values));
}

export { SKINS };
