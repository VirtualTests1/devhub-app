import { t as defaultT, type TFunc } from "../../lib/i18n";
import { RANGES, TAGS } from "./constants";

/**
 * The active 记录 filters, phrased the way the chips phrase them.
 *
 * Lives in a module instead of inline in `RecordsView` for one reason: what it must
 * never do is testable. The panel that uses it names the conditions that filtered the
 * list empty, and the failure mode is the panel falling back to the ids behind the
 * chips — telling the user that `appearance` and `7d` matched nothing, which is the
 * vocabulary of the log file and not of the界面. `tests/records-filter-words.test.ts`
 * pins that the output only ever contains labels from `constants.ts`.
 *
 * r17-n1-1: the sentence now resolves through the dictionary so an English locale
 * renders it in English alongside the translated chips. The chip label itself is
 * supplied by the caller (`labelOf`) because the chip row resolves it through the
 * dictionary too — the two surfaces must name a condition with the same words, which
 * is why the resolver is a parameter rather than a second lookup table here. With no
 * caller-supplied resolver or translator the defaults reproduce today's zh wording
 * from `constants.ts`, so the existing test drives the unwired path exactly as before.
 */

/** Ids that mean "no condition on this axis", and so contribute nothing. */
const ANY = "all";

/** Which chip the label belongs to. */
export type ChipAxis = "tag" | "range";

/** The chip row's own label resolver; `undefined` = the bar no longer lists that id. */
export type ChipLabeler = (axis: ChipAxis, id: string) => string | undefined;

export function filterWordsOf(
  tag: string,
  range: string,
  query: string,
  labelOf?: ChipLabeler,
  // Named `t`, not `translate`: the key-set guard reads call sites by that exact
  // name followed by a quoted key, and an aliased name would make this module's
  // keys look unread.
  t: TFunc = defaultT,
): string {
  const parts: string[] = [];
  if (tag !== ANY) {
    const label = labelOf?.("tag", tag) ?? TAGS.find((x) => x.id === tag)?.label;
    parts.push(t("records.filter.tag", { label: label ?? t("records.filter.anyTag") }));
  }
  if (range !== ANY) {
    const label = labelOf?.("range", range) ?? RANGES.find((x) => x.id === range)?.label;
    parts.push(t("records.filter.range", { label: label ?? t("records.filter.anyRange") }));
  }
  const q = query.trim();
  if (q) parts.push(t("records.filter.query", { query: q }));
  return parts.join(" · ");
}

/** Whether anything at all is filtering the list — the 清除筛选 affordance hinges on it. */
export function hasActiveFilter(tag: string, range: string, query: string): boolean {
  return tag !== ANY || range !== ANY || query.trim().length > 0;
}
