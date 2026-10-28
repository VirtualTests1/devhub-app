import { useMemo, type ReactNode } from "react";

import { entriesByDay, entriesByTag, topRepos } from "../../lib/records-stats";
import type { TFunc } from "../../lib/i18n";
import { reg } from "../../store/customize";
import type { ActivityEntry } from "../../types";

/** 条形展示最近几天。 */
const DAY_WINDOW = 7;
/** 类别展示前几名。 */
const TAG_TOP = 3;
/** 仓库展示前几名。 */
const REPO_TOP = 5;

/**
 * 统计洞察面板（r19-N1-2）——记录页对**全部**历史的汇总，不是对当前筛选的汇总：
 * 筛选是「找一行」，面板是「这段历史说了什么」，两者回答不同的问题。统计本身
 * 全在 `lib/records-stats.ts`（纯函数、有单测），这里只负责渲染。
 *
 * 没有记录时整个面板不渲染（由调用方决定），所以每条分支都面对非空输入。
 */
export function StatsPanel({
  entries,
  t,
  tagLabel,
}: {
  entries: readonly ActivityEntry[];
  t: TFunc;
  /** 类别 id → 界面文案；调用方传 chipLabelOf 的偏应用。 */
  tagLabel: (tag: string) => string;
}) {
  const stats = useMemo(
    () => ({
      days: entriesByDay(entries).slice(-DAY_WINDOW),
      tags: entriesByTag(entries).slice(0, TAG_TOP),
      repos: topRepos(entries, REPO_TOP),
    }),
    [entries],
  );
  // 条高按峰值归一：最高的一天满高，其余按比例，最矮不低于 4px（否则看不见）。
  const peak = stats.days.reduce((m, d) => Math.max(m, d.count), 0);
  return (
    <div
      {...reg("records-stats-panel")}
      className="skin-panel mb-3 border border-border-weak bg-card px-3 py-2"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-caption font-medium text-foreground">{t("stats.title")}</span>
        <span className="text-caption tabular-nums text-muted-foreground">
          {t("stats.total", { n: entries.length })}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Group label={t("stats.byDay")}>
          {stats.days.map((d) => (
            <span
              key={d.day}
              className="flex items-center gap-1"
              title={t("stats.dayTip", { day: d.day, n: d.count })}
            >
              <span
                className="w-1.5 rounded-[1px] bg-primary/60"
                style={{ height: `${4 + (d.count / peak) * 12}px` }}
              />
              <span className="text-caption tabular-nums text-muted-foreground">{d.count}</span>
            </span>
          ))}
        </Group>
        <Group label={t("stats.byTag")}>
          {stats.tags.map((r) => (
            <span key={r.tag} className="text-caption text-muted-foreground">
              {tagLabel(r.tag)}
              <span className="ml-1 tabular-nums text-foreground">{r.count}</span>
            </span>
          ))}
        </Group>
        <Group label={t("stats.topRepos")}>
          {stats.repos.map((r) => (
            <span key={r.slug} className="text-caption text-muted-foreground">
              {r.slug}
              <span className="ml-1 tabular-nums text-foreground">{r.count}</span>
            </span>
          ))}
        </Group>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="app-desc text-caption text-muted-foreground/80">{label}</span>
      {children}
    </div>
  );
}
