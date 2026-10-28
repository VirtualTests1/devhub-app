import {
  APPEARANCE_LABEL,
  describeAppearanceValue,
  type Appearance,
} from "../../store/appearance";
import { configTargetLabel } from "../../lib/targetLabel";
import { type TFunc } from "../../lib/i18n";
import { fmtAgo, pad2 } from "../../lib/format";

/** Grouping key for one entry: target → slug → id. */
export function groupKeyOf(e: { target?: string; slug?: string; id: string; tag: string }): string {
  if (e.target) return `${e.tag}:${e.target}`;
  if (e.slug) return `${e.tag}:${e.slug}`;
  return `single:${e.id}`;
}

/** Group heading for one entry. */
export function groupLabelOf(e: { target?: string; action: string }): string {
  if (!e.target) return e.action;
  return `${e.action} · ${displayTarget(e.target)}`;
}

/**
 * Turns a stored target key into the name a person expects. The log keeps
 * `config.projectRoot` / `ui.recordTimeFormat` because that is what makes a
 * record addressable and groupable; rendering the raw key (the old behaviour)
 * leaked storage details into the title line.
 *
 * This is where the two naming halves join, and the only place they do: config
 * keys come from `lib/targetLabel` (one catalog for 记录 and 常用), appearance
 * keys from the store's exhaustive `APPEARANCE_LABEL`. 常用页 calls this same
 * function for its chips — that is what replaced its own `SETTING_LABEL` table,
 * which had already drifted four keys away (`搜索停顿` / `清理计划` / `记录保留` /
 * `并行下载`).
 *
 * An unknown key prints the **whole target**, namespace included: the two surfaces
 * used to degrade differently here too (记录 stripped it to `searchDebounceMs`, 常用
 * kept `ui.font`), and keeping the prefix is the answer that stays interpretable —
 * `font` alone could be an appearance key or a config key. No known key reaches
 * this branch, so no existing row changes wording.
 */
export function displayTarget(target: string): string {
  if (target.startsWith("config.")) {
    return configTargetLabel(target.slice("config.".length)) ?? target;
  }
  if (target.startsWith("ui.")) {
    const key = target.slice("ui.".length);
    return APPEARANCE_LABEL[key as keyof typeof APPEARANCE_LABEL] ?? target;
  }
  if (target.startsWith("launch.steps:")) return target.slice("launch.steps:".length);
  if (target.startsWith("launch.command:")) return target.slice("launch.command:".length);
  if (target.startsWith("process:")) return `PID ${target.slice("process:".length)}`;
  if (target.startsWith("activity.")) return "操作记录";
  return target;
}

/**
 * Maps the stored value of a known target to its readable form. Display only:
 * the log still holds the raw value, and an old record is described by the same
 * rule as a new one because the descriptor is keyed by the value, not by when
 * it was written.
 *
 * Every `ui.*` target is an appearance key, so the store's own descriptor is the
 * single source of truth: it covers the enums (`md` → 标准、`hm` → 时分、
 * `compact` → 紧凑), the booleans (开/关), the font families and the pixel
 * sizes. Naming two of them here is exactly why the rest stayed raw —
 * `fontScale`、`density`、`fontFamily`、`fontWeight`、`gridColumns`、`skin`
 * kept printing their internal ids on every record written before this change.
 */
export function displayValue(target: string | undefined, value: string): string {
  if (!target) return value;
  if (target.startsWith("ui.")) {
    return describeAppearanceValue(target.slice("ui.".length) as keyof Appearance, value);
  }
  return value;
}

/**
 * The 保留时长 chip's phrase: only `0` is the permanent value.
 *
 * r17-n1-1: the wording moved into the dictionary, but the *rule* stays here — this
 * is its single home, and `t` is a required argument rather than a default so there
 * is no second, un-wired copy of the two Chinese strings in this file for the
 * language ratchet to count. `tests/records-format.test.ts` drives it with the real
 * zh-CN translator.
 */
export function retentionPhrase(days: number, t: TFunc): string {
  return days === 0
    ? t("records.retention.forever")
    : t("records.retention.days", { n: days });
}

/** Four renderings of the same instant, chosen by the 显示时间 switch. */
export function formatTime(ts: number, fmt: string): string {
  const d = new Date(ts * 1000);
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const mo = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (fmt === "hm") return `${hh}:${mm}`;
  if (fmt === "full") return `${d.getFullYear()}-${mo}-${dd} ${hh}:${mm}:${ss}`;
  // The ladder's default register: a log row is a list of ages, and a sub-minute
  // row says `45 秒前` because the ordering is the information.
  if (fmt === "relative") return fmtAgo(d.getTime());
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `${hh}:${mm}:${ss}` : `${mo}-${dd} ${hh}:${mm}:${ss}`;
}
