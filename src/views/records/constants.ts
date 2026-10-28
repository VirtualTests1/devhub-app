/** Filter chips: the tags the activity log can be narrowed by. */
export const TAGS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "download", label: "下载" },
  { id: "delete", label: "删除" },
  { id: "clear", label: "清理" },
  { id: "launch", label: "启动" },
  { id: "terminal", label: "终端" },
  { id: "ide", label: "IDE" },
  { id: "settings", label: "设置" },
  { id: "appearance", label: "外观" },
  { id: "interface", label: "界面" },
];

/** Non-destructive: narrows what is shown, never what is kept. */
export const RANGES: { id: string; label: string; seconds: number }[] = [
  { id: "all", label: "不限时间", seconds: 0 },
  { id: "1d", label: "今天", seconds: 86_400 },
  { id: "7d", label: "7 天", seconds: 7 * 86_400 },
  { id: "30d", label: "30 天", seconds: 30 * 86_400 },
  { id: "90d", label: "90 天", seconds: 90 * 86_400 },
];

export const RETENTIONS = [7, 30, 90, 0];

/** Quiet period before the 记录 filter re-runs. Local, CPU-bound → 150 ms. */
export const RECORDS_SEARCH_DEBOUNCE_MS = 150;

/** How many groups are rendered before an explicit 显示更多 raises the cap. */
export const RECORDS_GROUP_PAGE = 30;

export const CLEANUP_LABEL: Record<string, string> = {
  manual: "手动",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

export const TIME_FORMAT_LABEL: Record<string, string> = {
  hms: "时分秒",
  hm: "时分",
  relative: "相对时间",
  full: "完整日期",
};
